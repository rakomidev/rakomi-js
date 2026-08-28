/**
 * The ceremony hub — the single node through which registration, assertion, and step-up all invoke
 * the injected adapter.
 *
 * Everything platform-specific about "the authenticator did not give us a credential" is resolved
 * here: the support short-circuit, the untrusted-adapter guard, the abort/timeout budget, and the
 * classification of a rejection into the closed error taxonomy. Nothing else calls the adapter.
 */

import { passkeyError } from './errors.js';
import type {
  AuthenticationResponseJSON,
  PasskeyCeremonyAdapter,
  PasskeyError,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from './types.js';

/**
 * How long a ceremony may stay open before it is abandoned.
 *
 * The budget lives in the core, not in a binding, so the browser and the native bindings cannot
 * drift to different values. It matches the timeout the first-party web client already uses.
 */
export const PASSKEY_CEREMONY_TIMEOUT_MS = 60_000;

/** What the ceremony hub returns: a credential, or a typed failure — never a throw. */
export type CeremonyOutcome<T> = { ok: true; credential: T } | { ok: false; error: PasskeyError };

interface AdapterMethodCheck {
  ok: boolean;
  missing: string[];
}

function checkAdapterShape(adapter: unknown): AdapterMethodCheck {
  const missing: string[] = [];
  if (adapter === null || typeof adapter !== 'object') {
    return { ok: false, missing: ['adapter'] };
  }
  const candidate = adapter as Record<string, unknown>;
  for (const method of ['isSupported', 'createCredential', 'getCredential']) {
    if (typeof candidate[method] !== 'function') missing.push(method);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Whether the platform can run a passkey ceremony.
 *
 * A throwing `isSupported()` is treated as **unsupported** (fail-closed): failing open would push
 * an unsupported platform into a network call and surface a confusing server error instead of the
 * one thing the caller can act on.
 */
export async function isPasskeySupported(adapter: PasskeyCeremonyAdapter): Promise<boolean> {
  if (!checkAdapterShape(adapter).ok) return false;
  try {
    return (await adapter.isSupported()) === true;
  } catch {
    return false;
  }
}

/**
 * Gate every flow: reject a broken adapter and an unsupported platform **before** the first HTTP
 * call. Returns `null` when the flow may proceed.
 */
export async function guardAdapter(adapter: PasskeyCeremonyAdapter): Promise<PasskeyError | null> {
  const shape = checkAdapterShape(adapter);
  if (!shape.ok) {
    return passkeyError(
      'PASSKEY_ADAPTER_ERROR',
      `passkey ceremony adapter is missing: ${shape.missing.join(', ')}`,
    );
  }
  if (!(await isPasskeySupported(adapter))) {
    return passkeyError('PASSKEY_NOT_SUPPORTED', 'passkeys are not supported on this platform');
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A credential the adapter returned must at least be a WebAuthn-shaped JSON object. */
function isCredentialShaped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value['id'] === 'string' && isRecord(value['response']);
}

/**
 * Was this rejection a cancellation?
 *
 * Three shapes mean the same thing and all three must be recognised:
 *  - a browser `DOMException` named `NotAllowedError` / `AbortError` / `TimeoutError`,
 *  - a {@link PasskeyCeremonyError}-shaped rejection with `kind: 'cancelled'` (a native binding has
 *    no `DOMException` to raise),
 *  - our own abort, when the budget elapsed or the caller aborted.
 *
 * Duck-typing on `name` alone would silently misclassify every native cancellation as an unknown
 * failure — the exact platform leak this SDK exists to prevent.
 */
export function isCeremonyCancellation(err: unknown): boolean {
  if (!isRecord(err)) return false;
  if (err['kind'] === 'cancelled') return true;
  const name = err['name'];
  return name === 'NotAllowedError' || name === 'AbortError' || name === 'TimeoutError';
}

/** Did the binding explicitly report the platform as unsupported mid-ceremony? */
function isUnsupportedSignal(err: unknown): boolean {
  return isRecord(err) && err['kind'] === 'unsupported';
}

function ceremonyErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'passkey ceremony failed';
}

/**
 * Classify a rejection from the adapter.
 *
 * The taxonomy boundary that matters: a cancellation is "the user did nothing"; a ceremony failure
 * is "the authenticator refused" (an `InvalidStateError`, a `kind: 'failed'`); an adapter error is
 * "the integration is broken". Collapsing any pair leaves the caller unable to decide whether to
 * offer a retry or fall back to another sign-in method.
 */
function classifyCeremonyRejection(err: unknown): PasskeyError {
  if (err instanceof AdapterContractError) {
    return passkeyError('PASSKEY_ADAPTER_ERROR', err.message);
  }
  if (isCeremonyCancellation(err)) {
    return passkeyError('PASSKEY_CEREMONY_CANCELLED', 'the passkey ceremony was cancelled');
  }
  if (isUnsupportedSignal(err)) {
    return passkeyError('PASSKEY_NOT_SUPPORTED', 'passkeys are not supported on this platform');
  }
  return passkeyError('PASSKEY_CEREMONY_FAILED', ceremonyErrorMessage(err));
}

interface RunCeremonyInput<TOptions, TCredential> {
  adapter: PasskeyCeremonyAdapter;
  options: TOptions;
  /** The caller's signal, if any. The hub composes it with the timeout budget. */
  signal?: AbortSignal;
  timeoutMs?: number;
  invoke: (
    adapter: PasskeyCeremonyAdapter,
    options: TOptions,
    signal: AbortSignal,
  ) => Promise<TCredential>;
}

async function runCeremony<TOptions, TCredential>(
  input: RunCeremonyInput<TOptions, TCredential>,
): Promise<CeremonyOutcome<TCredential>> {
  const controller = new AbortController();
  const budget = input.timeoutMs ?? PASSKEY_CEREMONY_TIMEOUT_MS;

  const abortNow = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  if (input.signal?.aborted) abortNow();
  input.signal?.addEventListener('abort', abortNow, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<never>((_resolve, reject) => {
    const onAbort = () =>
      reject(new DOMExceptionLike('the passkey ceremony was aborted', 'AbortError'));
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(abortNow, budget);
  });
  abandoned.catch(() => undefined);

  const invocation = (async () => {
    let pending: Promise<TCredential>;
    try {
      pending = input.invoke(input.adapter, input.options, controller.signal);
    } catch (err) {
      throw new AdapterContractError(
        `passkey ceremony adapter threw synchronously: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (pending === null || typeof pending !== 'object' || typeof pending.then !== 'function') {
      throw new AdapterContractError('passkey ceremony adapter did not return a promise');
    }
    return pending;
  })();

  try {
    const credential = await Promise.race([invocation, abandoned]);

    if (!isCredentialShaped(credential)) {
      return {
        ok: false,
        error: passkeyError(
          'PASSKEY_ADAPTER_ERROR',
          'passkey ceremony adapter returned a malformed credential',
        ),
      };
    }
    return { ok: true, credential };
  } catch (err) {
    return { ok: false, error: classifyCeremonyRejection(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener('abort', abortNow);
  }
}

/**
 * A platform-neutral stand-in for `DOMException`, which does not exist on every runtime the core
 * runs on. It carries the `name` the classifier reads.
 */
class DOMExceptionLike extends Error {
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}

/** The injected adapter broke its contract. Distinct from any authenticator outcome. */
class AdapterContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterContractError';
  }
}

/** Run the registration ceremony through the hub. */
export function createCredential(input: {
  adapter: PasskeyCeremonyAdapter;
  options: PublicKeyCredentialCreationOptionsJSON;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CeremonyOutcome<RegistrationResponseJSON>> {
  return runCeremony({
    ...input,
    invoke: (adapter, options, signal) => adapter.createCredential(options, { signal }),
  });
}

/** Run the assertion ceremony through the hub. */
export function getCredential(input: {
  adapter: PasskeyCeremonyAdapter;
  options: PublicKeyCredentialRequestOptionsJSON;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CeremonyOutcome<AuthenticationResponseJSON>> {
  return runCeremony({
    ...input,
    invoke: (adapter, options, signal) => adapter.getCredential(options, { signal }),
  });
}
