
import {
  type AuthenticationResponseJSON,
  type PasskeyCeremonyAdapter,
  PasskeyCeremonyError,
  type PasskeyCeremonyErrorKind,
  type PasskeyCeremonyOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@rakomi/sdk-core';

import {
  CredentialEnvelopeError,
  type CredentialEnvelopeKind,
  sanitizeCredentialEnvelope,
} from './passkey-envelope.js';

/**
 * The raw native-module surface a host exposes for passkey ceremonies.
 *
 * It is a structural duck-type: no brand, no symbol, no base class. **Any module satisfying this
 * spec is a drop-in replacement; the SDK does not know which one you used** — your own Swift/Kotlin
 * module, a community package, or a future first-party Expo module.
 *
 * ## What crosses the bridge
 *
 * Both ceremony methods take the server's options as a **JSON string** and resolve the finished
 * credential as a **JSON string**. See the file header for why this is not an object.
 *
 * ## What the module MUST return (W3C WebAuthn **Level 3** JSON serialization, §5.1.8 / §5.1.9 —
 * Candidate Recommendation; these JSON dictionaries do not exist in Level 2)
 *
 * `createPasskey` (registration):
 *
 * | member | required |
 * |---|---|
 * | `id`, `rawId`, `type: "public-key"` | MUST |
 * | `response.clientDataJSON`, `response.attestationObject` | MUST |
 * | `response.authenticatorData`, `response.publicKeyAlgorithm` | MUST |
 * | `response.transports` | MUST (omitting it silently degrades later autofill) |
 * | `clientExtensionResults` | MUST |
 * | `authenticatorAttachment`, `response.publicKey` | optional |
 *
 * `getPasskey` (assertion):
 *
 * | member | required |
 * |---|---|
 * | `id`, `rawId`, `type: "public-key"` | MUST |
 * | `response.clientDataJSON`, `response.authenticatorData`, `response.signature` | MUST |
 * | `clientExtensionResults` | MUST |
 * | `response.userHandle` | optional |
 *
 * **ENCODING — the single most common integration failure.** Every binary member is
 * **base64url WITHOUT padding** (RFC 4648 **§5**). On iOS, `Data.base64EncodedString()` emits
 * *standard* base64 (RFC 4648 **§4**, with `+`, `/` and `=`) — that is WRONG and the bridge rejects
 * it with a message naming the field.
 *
 * (The bridge ENFORCES a subset of the table above — the fields the SDK's own fixtures carry and the
 * server actually consumes. The rest are a MUST for you, not a MUST for the validator; sending them
 * is what keeps your integration correct as the server tightens.)
 *
 * ## Rejection vocabulary — CLOSED
 *
 * Reject with an object carrying a `code`:
 * - `PASSKEY_CANCELLED` — the user dismissed the sheet, or the OS cancelled.
 * - `PASSKEY_UNSUPPORTED` — no passkey support on this OS version, or no credential provider.
 * - `PASSKEY_NO_CREDENTIAL` — the user has no passkey for this relying party.
 *
 * Any other rejection is a genuine failure and is passed through untouched. **Do NOT set a
 * rejection's `name` to `AbortError` / `NotAllowedError` / `TimeoutError` unless it really is a
 * cancellation** — the SDK matches on those names and will read your intent as "the user cancelled".
 *
 * ## Stability (this is a SemVer surface even though we never compile your module)
 *
 * Your module is Swift or Kotlin: our typecheck will never see it, so a breaking change to this spec
 * breaks every existing module **at runtime**, not at compile time — and the SDK's 24-month support
 * policy means a module written today must still satisfy this spec two years from now. Therefore:
 * - a new **optional** member → MINOR;
 * - a new **optional trailing parameter** on an existing method → MINOR (a lower-arity function
 *   stays assignable — which is exactly why we do not reserve parameters "just in case");
 * - a **required** method, a parameter-type change, or a change to the rejection vocabulary → MAJOR;
 * - the rejection vocabulary is CLOSED: a new code is first a change in `@rakomi/sdk-core`, and only
 *   then a lane here.
 *
 * ## Orphan credentials — a residual you should know about
 *
 * If a registration ceremony is abandoned *after* the platform provider (iCloud Keychain / Google
 * Password Manager) already created the credential, the user holds a passkey for your app that the
 * server never learned about; their next sign-in with it fails. Implementing
 * {@link NativePasskeyModuleSpec.cancelPasskeyRequest} narrows that window. The SDK does not
 * reconcile orphans.
 */
export interface NativePasskeyModuleSpec {
  /**
   * Whether this platform can run a passkey ceremony at all.
   *
   * **Advisory, not a verdict.** Every module in the ecosystem answers this from the OS version, so
   * it says `true` on an Android emulator with no credential provider and on an iOS version where
   * the platform provider does not exist. The SDK treats a throw or a non-`true` value as `false`
   * (fail-closed) but cannot catch an honest `true` with no provider behind it — the authoritative
   * verdict is the ceremony's own outcome.
   */
  isPasskeySupported(): Promise<boolean>;
  /** Run the registration ceremony. `requestJson` is the server's options, verbatim. */
  createPasskey(requestJson: string): Promise<string>;
  /** Run the assertion ceremony. `requestJson` is the server's options, verbatim. */
  getPasskey(requestJson: string): Promise<string>;
  /**
   * Optional: is a *platform* authenticator (Face ID / fingerprint / screen lock) available?
   *
   * A UI hint only — never a gate. A synced passkey on another device is still a passkey, so a
   * `false` here does not mean "no passkeys". Omit it and the SDK reports `null` (unknown) rather
   * than guessing.
   */
  isPlatformAuthenticatorAvailable?(): Promise<boolean>;
  /**
   * Optional: dismiss the in-flight native sheet (iOS `ASAuthorizationController.cancel()`;
   * Android's `CredentialManager` calls are cancellable). Best-effort — a throw is ignored.
   *
   * It takes no request id because the native side has nothing to correlate against: the passkey sheet
   * is an **OS-global modal**, and a cancel dismisses whatever is on screen. The SDK does NOT serialise
   * ceremonies — nothing here can, since the sheet is owned by the OS — so the bridge instead fires the
   * cancel only while the aborting ceremony is still the one in flight, making a stale abort a no-op
   * rather than a teardown of somebody else's sheet. Preventing a second ceremony from being STARTED is
   * a UI concern and belongs to the provider.
   */
  cancelPasskeyRequest?(): void | Promise<void>;
}

export interface CreateNativePasskeyAdapterOptions {
  /**
   * The host's native passkey module. On bare RN this is the linked native module
   * (`NativeModules.RakomiPasskey`); on Expo it is the Expo module's JS surface; it may also be a
   * community package wrapped to satisfy {@link NativePasskeyModuleSpec}.
   */
  module: NativePasskeyModuleSpec;
}

/**
 * The closed native rejection vocabulary → the ceremony-error kinds the core understands.
 *
 * `Object.create(null)`, not `{}`. The lookup key is a fully module-controlled string, so an ordinary
 * object literal would resolve `code: 'constructor'` to `Object` — a value that is not `undefined`,
 * is not a member of the closed `PasskeyCeremonyErrorKind` union, and would be handed to the core as
 * one. A null prototype closes that whole class rather than blacklisting the members of it.
 */
const NATIVE_CODE_TO_KIND: Record<string, PasskeyCeremonyErrorKind> = Object.assign(Object.create(null) as Record<string, PasskeyCeremonyErrorKind>, {
  PASSKEY_CANCELLED: 'cancelled',
  PASSKEY_UNSUPPORTED: 'unsupported',
  PASSKEY_NO_CREDENTIAL: 'cancelled',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The ONE place a native rejection is normalized.
 *
 * It translates exactly the shapes the core cannot recognise (a native error is a plain object with
 * a `code`, not a `DOMException`) and **re-throws everything else unchanged**, so the core's single
 * classifier keeps owning the taxonomy. A second classifier here is precisely the drift this seam
 * exists to prevent.
 *
 * Null-safe by construction: a module may reject with `null`, a bare string or a number, and this
 * must not turn into a `TypeError` thrown out of our own `catch`.
 *
 * **Residual, stated rather than assumed away:** an unrecognised rejection is re-thrown by identity,
 * so the module's OWN message reaches the core verbatim and ends up in `PasskeyError.message` — i.e.
 * in your logs and your crash reporter. The SDK never puts credential material in a message (the
 * envelope validator names the field, never the value), but it cannot scrub a message it did not
 * write. A native module MUST NOT serialise the ceremony request or response into its exception text.
 */
function normalizeNativeRejection(err: unknown): never {
  const code = isRecord(err) ? err['code'] : undefined;
  if (typeof code === 'string') {
    const kind = NATIVE_CODE_TO_KIND[code];
    if (kind !== undefined) {
      throw new PasskeyCeremonyError(kind);
    }
  }
  throw err;
}

/**
 * Exhaustiveness guard on the ceremony-error kinds.
 *
 * It is never called at runtime. Its job is to make the TYPECHECK fail the day `@rakomi/sdk-core`
 * widens `PasskeyCeremonyErrorKind` (e.g. adds `'adapter'`), so this bridge is forced to decide what
 * the new kind means instead of silently ignoring it.
 */
function assertNever(value: never): never {
  throw new PasskeyCeremonyError('failed', `unhandled ceremony-error kind: ${String(value)}`);
}

/** Compile-time proof that every kind the core defines has a considered meaning here. */
function describeKind(kind: PasskeyCeremonyErrorKind): string {
  switch (kind) {
    case 'cancelled':
      return 'the user dismissed the passkey sheet';
    case 'unsupported':
      return 'this platform cannot run a passkey ceremony';
    case 'failed':
      return 'the passkey ceremony failed';
    default:
      return assertNever(kind);
  }
}

/**
 * Adapt a host's native passkey module to the canonical `PasskeyCeremonyAdapter` contract. Wire the
 * result into `NativeAuthAdapter.passkeys`.
 *
 * The module's SHAPE is validated here, at wiring time, and a missing method throws loudly — in the
 * host's adapter-construction code, where the bug is, rather than degrading to "passkeys are not
 * supported on this device", which is a lie that hides the host's bug. An ABSENT adapter and a
 * BROKEN adapter are different diagnoses and must not be collapsed.
 *
 * @public — additive-only.
 */
/**
 * The core's ceremony contract, plus the one native-only capability the hook needs and the contract
 * has no place for: the platform-authenticator hint. It is attached HERE rather than plumbed through
 * the host, because the probe needs the MODULE and the hook only ever sees the adapter.
 *
 * Structurally a `PasskeyCeremonyAdapter`, so it drops into `nativeAdapter.passkeys` unchanged.
 */
export interface NativePasskeyCeremonyAdapter extends PasskeyCeremonyAdapter {
  /** `true` / `false` / `null` — and `null` means UNKNOWN, never "no". */
  hasPlatformAuthenticator(): Promise<boolean | null>;
}

export function createNativePasskeyAdapter(
  options: CreateNativePasskeyAdapterOptions,
): NativePasskeyCeremonyAdapter {
  const mod = options.module;

  let inFlight: symbol | null = null;

  const candidate = mod as unknown as Record<string, unknown> | null | undefined;
  const missing = (['isPasskeySupported', 'createPasskey', 'getPasskey'] as const).filter(
    (method) => typeof candidate?.[method] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(
      `native passkey module is missing: ${missing.join(', ')} — it does not satisfy NativePasskeyModuleSpec`,
    );
  }

  /**
   * The bridge does exactly TWO things with the ceremony signal, and no third.
   *
   * 1. A pre-call short-circuit, so an already-cancelled action never presents the OS sheet. On
   *    native that is not cosmetic: the sheet is a system-global modal.
   * 2. Cooperative cancellation of the module, if it offers it.
   *
   * It does NOT race the module's promise. The core already composes the caller's signal with its
   * 60 s budget, hands the composed signal here, races the invocation and swallows the loser's
   * rejection. A second race would be a second settlement guarantee, a second rejection source (an
   * unhandled rejection is fatal under some React Native configurations) and a listener left on a
   * signal that lives for the whole ceremony.
   *
   * Known coarseness, stated rather than papered over: (a) a module without `cancelPasskeyRequest`
   * cannot dismiss a sheet that is already up — the guarantee is then promise-settlement, not
   * dismissal; (b) the core's 60 s budget is a JS timer, and React Native throttles or suspends JS
   * timers when the app backgrounds — which the passkey sheet is sometimes treated as — so the
   * budget may fire late, or only once the app returns to the foreground.
   */
  async function runCeremony(kind: CredentialEnvelopeKind, requestJson: string, ceremonyOptions?: PasskeyCeremonyOptions): Promise<unknown> {
    const signal = ceremonyOptions?.signal;

    if (signal?.aborted === true) {
      throw new PasskeyCeremonyError('cancelled', describeKind('cancelled'));
    }

    const ticket = Symbol('passkey-ceremony');
    inFlight = ticket;

    const onAbort = (): void => {
      if (inFlight !== ticket) return;
      try {
        void Promise.resolve(mod.cancelPasskeyRequest?.()).catch(() => undefined);
      } catch {
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let raw: unknown;
    try {
      raw = await (kind === 'registration' ? mod.createPasskey(requestJson) : mod.getPasskey(requestJson));
    } catch (err) {
      normalizeNativeRejection(err);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (inFlight === ticket) inFlight = null;
    }

    if (typeof raw !== 'string') {
      throw new CredentialEnvelopeError(
        `the native module returned ${raw === null ? 'null' : `a ${typeof raw}`}; the contract is a JSON string — wrap a module with an object API so it stringifies its argument and its result`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new CredentialEnvelopeError(
        'the native module returned a string that is not valid JSON (a double-encoded response does this)',
      );
    }

    return sanitizeCredentialEnvelope(kind, parsed);
  }

  /**
   * Run a ceremony and turn an envelope violation into a value the core's own shape guard rejects.
   *
   * This indirection is the honest path, not a clever one: `@rakomi/sdk-core` does not export the
   * error class that means "the adapter broke its contract", and its ceremony-error kinds have no
   * member for it — so a binding cannot RAISE an adapter error. It can only REACH one by resolving
   * something that is not a credential, which is exactly what happened. What the bridge must never
   * do is throw a generic error: that lands as a *retryable* ceremony failure, and telling an app to
   * retry a permanently broken native module is worse than useless.
   *
   * KNOWN COST of routing it this way, stated because it is the whole reason the door exists: the
   * core replaces the diagnosis with its own generic "adapter returned a malformed credential", so
   * the message naming the field and the rule — the integrator's one chance to learn that their iOS
   * module is emitting padded base64 — does NOT reach the caller today. It is asserted at this
   * boundary (the validator's own tests) and it is lost above it. Closing the sdk-core door restores
   * it; nothing this package can do restores it alone.
   */
  async function ceremonyOrMalformed<T>(
    kind: CredentialEnvelopeKind,
    requestJson: string,
    ceremonyOptions?: PasskeyCeremonyOptions,
  ): Promise<T> {
    try {
      return (await runCeremony(kind, requestJson, ceremonyOptions)) as T;
    } catch (err) {
      if (err instanceof CredentialEnvelopeError) {
        return { rakomiEnvelopeViolation: err.message } as unknown as T;
      }
      throw err;
    }
  }

  return {
    async isSupported(): Promise<boolean> {
      try {
        return (await mod.isPasskeySupported()) === true;
      } catch {
        return false;
      }
    },
    hasPlatformAuthenticator(): Promise<boolean | null> {
      return probePlatformAuthenticator(mod);
    },

    createCredential(
      creationOptions: PublicKeyCredentialCreationOptionsJSON,
      ceremonyOptions?: PasskeyCeremonyOptions,
    ): Promise<RegistrationResponseJSON> {
      return ceremonyOrMalformed<RegistrationResponseJSON>(
        'registration',
        JSON.stringify(creationOptions),
        ceremonyOptions,
      );
    },

    getCredential(
      requestOptions: PublicKeyCredentialRequestOptionsJSON,
      ceremonyOptions?: PasskeyCeremonyOptions,
    ): Promise<AuthenticationResponseJSON> {
      return ceremonyOrMalformed<AuthenticationResponseJSON>(
        'assertion',
        JSON.stringify(requestOptions),
        ceremonyOptions,
      );
    },
  };
}

/**
 * Ask the host's module whether a *platform* authenticator is available.
 *
 * `null` means **unknown**, and it is `null` in all three shapes of "the module does not really
 * implement this", because in React Native a missing method has three shapes, not one: it is absent
 * (a legacy `NativeModules` object), or it exists but throws synchronously (a TurboModule whose
 * codegen compiled the spec but whose native side did not implement it), or it exists but rejects
 * (an Expo module proxy). None of them may answer `false` — that would be the lie "this device has
 * no platform authenticator" — and none of them may be inferred from `isSupported()`, because a
 * synced passkey is a passkey without a local platform authenticator.
 */
export async function probePlatformAuthenticator(
  mod: NativePasskeyModuleSpec,
): Promise<boolean | null> {
  if (typeof mod.isPlatformAuthenticatorAvailable !== 'function') return null;
  try {
    const available = await mod.isPlatformAuthenticatorAvailable();
    return typeof available === 'boolean' ? available : null;
  } catch {
    return null;
  }
}
