'use client';

/**
 * The browser fulfilment of `@rakomi/sdk-core`'s `PasskeyCeremonyAdapter`.
 *
 * `@rakomi/sdk-core` choreographs the passkey REST ceremony and never touches
 * `navigator.credentials`; this module is the seam where that abstract contract meets the browser's
 * WebAuthn API. A native binding fulfils the same contract with the platform's passkey module — one
 * contract, two bindings.
 *
 * `@simplewebauthn/browser` is loaded through a **dynamic import inside the method bodies**, so an
 * application that never calls a passkey function pays zero bytes for it. The trade-off is
 * deliberate: on a cold cache the module is fetched and parsed at the first ceremony click, which
 * inserts a short gap between the click and the native prompt. An application that cares can warm
 * the module itself (an `import('@simplewebauthn/browser')` on button hover, or a
 * `<link rel="modulepreload">`) — no SDK change is needed.
 */

import {
  type AuthenticationResponseJSON,
  type PasskeyCeremonyAdapter,
  PasskeyCeremonyError,
  type PasskeyCeremonyOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@rakomi/sdk-core';

/**
 * The slice of `@simplewebauthn/browser` this binding uses.
 *
 * Declared locally rather than imported as a type so the library's types never surface in this
 * package's generated `.d.ts` — a consumer type-checks against the SDK, not against a vendored
 * WebAuthn helper. The two shapes are the same W3C JSON forms by construction (the library
 * self-marshals base64url ⇄ ArrayBuffer; do NOT additionally call the native
 * `PublicKeyCredential.parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON` — a second
 * pass would double-convert).
 */
interface WebAuthnCeremonies {
  startRegistration(input: {
    optionsJSON: PublicKeyCredentialCreationOptionsJSON;
  }): Promise<RegistrationResponseJSON>;
  startAuthentication(input: {
    optionsJSON: PublicKeyCredentialRequestOptionsJSON;
  }): Promise<AuthenticationResponseJSON>;
}

function loadCeremonies(): Promise<WebAuthnCeremonies> {
  return import('@simplewebauthn/browser') as unknown as Promise<WebAuthnCeremonies>;
}

/** The user did nothing, or the ceremony was abandoned. */
const CANCEL_NAMES = new Set(['NotAllowedError', 'AbortError', 'TimeoutError']);

/**
 * A permanent misconfiguration, not a transient failure.
 *
 * `SecurityError` is an RP-ID / origin mismatch (SimpleWebAuthn diagnoses it as
 * `ERROR_INVALID_RP_ID` / `ERROR_INVALID_DOMAIN`); `NotSupportedError` means no authenticator
 * supports any algorithm the server offered. Both reproduce identically on every retry, so letting
 * them fall into the generic ceremony-failure bucket — whose recovery hint is `retry` — would send
 * the caller into a loop that can never succeed.
 */
const UNSUPPORTED_NAMES = new Set(['SecurityError', 'NotSupportedError']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The names a rejection may be classified by.
 *
 * Both `err.name` and `err.cause?.name` are read. In `@simplewebauthn/browser@13.2.0` a
 * `WebAuthnError` sets `this.name = name ?? cause.name` and no call site passes an explicit `name`,
 * so today the two are always equal — the second read is forward-compatibility insurance against a
 * release that starts passing its own taxonomy name, not a currently-observed divergence. Do not
 * remove either half as dead code.
 */
function rejectionNames(err: unknown): string[] {
  if (!isRecord(err)) return [];
  const names: string[] = [];
  if (typeof err['name'] === 'string') names.push(err['name']);
  const cause = err['cause'];
  if (isRecord(cause) && typeof cause['name'] === 'string') names.push(cause['name']);
  return names;
}

/**
 * Read the diagnostic by duck-typing `message`, never by `instanceof Error`.
 *
 * A `DOMException` — which is what a real browser rejection is — is not `instanceof Error` under
 * jsdom, so an `instanceof` check would drop the diagnostic exactly where it matters most and only
 * in the test environment. The same duck-typing precedent is already documented in `fetch-client.ts`.
 */
function rejectionMessage(err: unknown): string | undefined {
  if (isRecord(err) && typeof err['message'] === 'string' && err['message'] !== '') {
    return err['message'];
  }
  return undefined;
}

/**
 * The one place a browser rejection is classified — three lanes, and only three.
 *
 * A cancel and a permanent misconfiguration are named explicitly; **everything else is re-thrown
 * unchanged** so the core's classifier stays the single owner of the failed-vs-adapter-error
 * boundary. A binding that classified those too would be a second classifier, and two classifiers
 * drift.
 *
 * The library's diagnostic message is preserved on the raised error, which makes it visible at a
 * breakpoint and in this package's own tests. It does NOT reach the application: the core maps an
 * `unsupported` ceremony error to a fixed message, and `PasskeyError` carries no diagnostic
 * passthrough. What the application does get is the terminal `nextAction: 'abort'` — the part it
 * can act on.
 */
function normalizeCeremonyRejection(err: unknown): never {
  const names = rejectionNames(err);
  if (names.some((name) => CANCEL_NAMES.has(name))) {
    throw new PasskeyCeremonyError('cancelled', rejectionMessage(err));
  }
  if (names.some((name) => UNSUPPORTED_NAMES.has(name))) {
    throw new PasskeyCeremonyError('unsupported', rejectionMessage(err));
  }
  throw err;
}

/**
 * The shared fail-closed probe both capability checks run through.
 *
 * Server-side rendering yields `false`, never an optimistic `true`: a `true` from a server render
 * would satisfy the core's support gate and push server-rendered code toward a network call. The
 * whole posture of the passkey core is fail-closed — a throwing probe is already treated as
 * unsupported there — and this binding must not be the one component that fails open.
 */
async function probe(check: () => boolean | Promise<boolean>): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}

/**
 * Whether this browser can run a passkey ceremony **at all** — the base WebAuthn capability.
 *
 * It deliberately does not consult `isUserVerifyingPlatformAuthenticatorAvailable()`. A user whose
 * only authenticator is a roaming security key holding a resident credential has a passkey by the
 * FIDO Alliance's own definition, and a UVPA-gated verdict would tell them passkeys are
 * unsupported. "Can this browser do WebAuthn", "is a platform authenticator present", and "is
 * conditional mediation available" are three different questions; this answers the first.
 */
export function isWebAuthnSupported(): Promise<boolean> {
  return probe(
    () => typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential === 'function',
  );
}

/**
 * Whether a user-verifying **platform** authenticator (Face ID, Touch ID, Windows Hello) is
 * available.
 *
 * A UI hint — it decides whether to say "Sign in with Face ID" rather than "Sign in with a passkey"
 * — and never a gate. Nothing in this SDK branches on it.
 */
export function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  return probe(async () => {
    const credential = (
      window as {
        PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> };
      }
    ).PublicKeyCredential;
    if (typeof credential?.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    return await credential.isUserVerifyingPlatformAuthenticatorAvailable();
  });
}

/** The one cancellation this binding raises itself: the caller (or the core's budget) gave up. */
function abandoned(): PasskeyCeremonyError {
  return new PasskeyCeremonyError('cancelled', 'the passkey ceremony was aborted');
}

/**
 * An already-abandoned caller must not get a native prompt.
 *
 * Checked BEFORE the library is called, not merely raced against it: the core invokes the adapter
 * even when its own budget/caller signal has already aborted, and a race started after
 * `startAuthentication()` would still have popped the OS sheet — a passkey prompt appearing for a
 * component the user already navigated away from.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abandoned();
}

/**
 * Honour the caller's abort signal by **racing** it against the ceremony.
 *
 * `@simplewebauthn/browser@13.2.0` accepts no `signal` argument — both ceremony functions
 * unconditionally install the signal of a page-global `WebAuthnAbortService` singleton — so racing is
 * the only way to settle the promise on abort. Do not go looking for a `signal` option; there isn't
 * one.
 *
 * When the race is won by the abort, the ceremony promise is abandoned but still live — it will
 * reject later (the user dismisses the orphaned sheet, or the library's own abort service kills it).
 * That rejection has no other handler, so it is swallowed explicitly; without this, an abandoned
 * ceremony surfaces as an `unhandledrejection` in the host app's error tracker.
 *
 * Known platform coarseness: an already-visible native sheet cannot be dismissed programmatically.
 * The guarantee is that the promise settles, not that the browser chrome disappears.
 */
function raceAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    pending.catch(() => undefined);
    return Promise.reject(abandoned());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      pending.catch(() => undefined);
      reject(abandoned());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Build the browser ceremony adapter.
 *
 * Injected into `@rakomi/sdk-core`'s passkey functions; the `usePasskeys` hook does it for you.
 */
export function createBrowserPasskeyAdapter(): PasskeyCeremonyAdapter {
  return {
    isSupported(): Promise<boolean> {
      return isWebAuthnSupported();
    },

    async createCredential(
      options: PublicKeyCredentialCreationOptionsJSON,
      ceremonyOptions?: PasskeyCeremonyOptions,
    ): Promise<RegistrationResponseJSON> {
      throwIfAborted(ceremonyOptions?.signal);
      const { startRegistration } = await loadCeremonies();
      try {
        throwIfAborted(ceremonyOptions?.signal);
        return await raceAbort(
          startRegistration({ optionsJSON: options }),
          ceremonyOptions?.signal,
        );
      } catch (err) {
        return normalizeCeremonyRejection(err);
      }
    },

    async getCredential(
      options: PublicKeyCredentialRequestOptionsJSON,
      ceremonyOptions?: PasskeyCeremonyOptions,
    ): Promise<AuthenticationResponseJSON> {
      throwIfAborted(ceremonyOptions?.signal);
      const { startAuthentication } = await loadCeremonies();
      try {
        throwIfAborted(ceremonyOptions?.signal);
        return await raceAbort(
          startAuthentication({ optionsJSON: options }),
          ceremonyOptions?.signal,
        );
      } catch (err) {
        return normalizeCeremonyRejection(err);
      }
    },
  };
}
