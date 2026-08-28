# `@rakomi/react-native`

React Native / Expo SDK for [Rakomi](https://rakomi.com) — EU-native auth-as-a-service.

> **Status: PREVIEW.** `@rakomi/react-native` is a pre-1.0 package — no stability or support
> guarantee (SemVer 2.0.0 §4). The exported hook and component **surface** is frozen for parity with
> [`@rakomi/react`](https://www.npmjs.com/package/@rakomi/react), and every name below is exported
> and type-checked, but not every export's **behavior** is wired to the network yet.
>
> **Works today:** social sign-in via the system browser (`<SignIn providers={[...]} />` /
> `startSocialSignIn()`), magic link, email OTP, registration, MFA (TOTP), passkeys
> (sign-in/step-up/register/list/rename/delete), session management (`useAuth`, `useSession`,
> `getToken`), `<UserButton>`, `<SignedIn>`/`<SignedOut>`, `<Protect>`, `useOrganization` /
> `useOrganizationList` (JWT-claim reads), `useAuthConfig`, `useBranding`, `useBaasPlans`,
> `useBaasSubscription`.
>
> **Not yet wired — calls resolve/return an error placeholder, no network request is made:**
> `useAuth().signIn()` (direct email+password) and `useAuth().switchOrganization()`;
> `useLinkedAccounts().link()`/`.unlink()`; `useAnonymousSignin().signInAnonymously()`. `<SignIn />`
> renders social providers and MFA TOTP entry only — there is no password field in the pre-built
> component. `<UserProfile>` and `<Feature>` are marked preview individually below. Each of these is
> also called out at its own symbol in the [full reference docs](https://docs.rakomi.dev/sdk/react-native/authentication/#what-works-today).
>
> Token-manager runtime, JWKS verification, social-provider deep-link auto-handler, a bare-RN adapter
> example, and a demo app land in subsequent 0.x releases.

## Install

```sh
# Expo-managed (recommended)
expo install @rakomi/react-native expo-secure-store expo-web-browser expo-crypto expo-linking expo-local-authentication
npm install @react-native-community/netinfo

# Bare React Native
npm install @rakomi/react-native react-native-keychain react-native-inappbrowser-reborn react-native-quick-crypto
```

## Quickstart

```tsx
import { RakomiProvider, SignedIn, SignedOut, UserButton, SignIn } from '@rakomi/react-native';

export default function App() {
  return (
    <RakomiProvider
      publishableKey={process.env.EXPO_PUBLIC_RAKOMI_KEY!}
      baseUrl="https://api.rakomi.com"
      redirectUri="myapp://callback"
    >
      <SignedIn><UserButton /></SignedIn>
      <SignedOut><SignIn /></SignedOut>
    </RakomiProvider>
  );
}
```

## What's included

- **`<RakomiProvider>`** — context provider. Freezes the native adapter on mount. AppState debounce 300ms. Connectivity transitions wired.
- **Hooks (parity-locked):** `useAuth`, `useUser`, `useSession`, `useFlag`, `useOrganization`, `useOrganizationList`, `useLinkedAccounts` (preview), `useTranslation`, `useAuthConfig`, `useBranding`, `useAnonymousSignin` (preview), `useBaasPlans`, `useBaasSubscription`. Type-level parity with `@rakomi/react` is enforced by CI — see the status banner above for which hooks make real network calls today.
- **Components:** `<SignIn />` (social + MFA TOTP — no password field), `<SignUp />`, `<UserButton />`, `<UserProfile />` (preview), `<SignedIn>`, `<SignedOut>`, `<Protect>`, `<Feature>` (preview — reads the JWT directly, no live evaluation). RN primitives only — no HTML, no WebView.
- **OAuth (RFC 8252):** PKCE S256, 32-byte state with single-use 60s TTL + constant-time comparison, system browser via `expo-web-browser` (`preferEphemeralSession: true` default), confused-deputy guard on callback ingest.
- **Native adapter contract:** `NativeAuthAdapter` interface with forward-compat slots (`verifiers` for EUDI, `dpopProver` for DPoP, `par` for RFC 9126 PAR).
- **`tokenCache` injection sugar** — replace storage without re-implementing the full adapter.
- **HKDF-style storage key derivation** — domain-separated per tenant + per purpose.

## Passkeys (WebAuthn)

`usePasskeys()` is the whole passkey surface: sign-in, step-up, registration, and management
(list / rename / delete). Passkeys give you **passwordless** sign-in. They are **phishing-resistant**
only because the operating system binds the credential to your app's associated domain — on iOS
through your **Associated Domains** entitlement, on Android through your **Digital Asset Links** file.
If either is missing or wrong the OS **refuses** the ceremony; the SDK cannot and does not substitute
for that configuration. (The reassuring half: a misconfiguration does not silently weaken anything —
it stops the ceremony outright.)

The flow is not "biometric sign-in", and calling it that in your UI would be untrue for a share of your
users: user verification is performed by the **device's screen lock — biometrics *or* passcode** — and
the SDK cannot distinguish them, nor does it want to.

The SDK does **not** ship a passkey library and does **not** depend on one. The OS ceremony
(the system passkey sheet) belongs to your app: you supply a native module, the SDK talks to it
through one small contract. That keeps a third-party module off the credential path, keeps Expo Go
working for apps that never use passkeys, and lets you pick whichever community wrapper you already
trust.

### Wiring the ceremony adapter

**With a native module of your own** (or a community wrapper's module):

```tsx
import {
  createDefaultExpoAdapter,
  createNativePasskeyAdapter,
  RakomiProvider,
} from '@rakomi/react-native';
import { NativeModules } from 'react-native';

const passkeys = createNativePasskeyAdapter({ module: NativeModules.MyPasskeyModule });

// `nativeAdapter` is normally optional (it defaults to the Expo adapter). To ADD passkeys you must
// name it explicitly — spread the default and attach the slot. There is no `passkeys` shorthand prop.
<RakomiProvider
  publishableKey={process.env.EXPO_PUBLIC_RAKOMI_KEY!}
  baseUrl="https://api.rakomi.com"
  redirectUri="myapp://callback"
  nativeAdapter={{ ...createDefaultExpoAdapter(), passkeys }}
>
  {/* … */}
</RakomiProvider>
```

**With a community wrapper whose API is not the module shape** — write a four-line shim; the contract
is deliberately tiny:

```ts
import { createNativePasskeyAdapter } from '@rakomi/react-native';
import { Passkey } from 'some-passkey-wrapper'; // whichever wrapper you already trust

const passkeys = createNativePasskeyAdapter({
  module: {
    isPasskeySupported: () => Passkey.isSupported(),
    // The SDK's contract is STRING in, STRING out. Most community wrappers are OBJECT in, OBJECT out —
    // so the shim parses on the way in and serialises on the way out. Getting this backwards
    // double-encodes the request (the wrapper receives a JSON string where it expects an object) and is
    // the single most common wiring bug; check your wrapper's signature, do not copy this blindly.
    createPasskey: (requestJson: string) =>
      Passkey.create(JSON.parse(requestJson)).then((credential) => JSON.stringify(credential)),
    getPasskey: (requestJson: string) =>
      Passkey.get(JSON.parse(requestJson)).then((credential) => JSON.stringify(credential)),
    // Implement this if your wrapper can dismiss an open sheet — it is what narrows the
    // orphaned-credential window described below.
    cancelPasskeyRequest: () => Passkey.cancel?.(),
  },
});
```

### Using the hook

```tsx
const {
  isSupported,            // null until probed; false = this device cannot run a ceremony
  signInWithPasskey,      // no session needed
  stepUpWithPasskey,      // mints a step-up token — needs a session AND an existing passkey
  registerPasskey, listPasskeys, renamePasskey, deletePasskey, // all need a step-up token
  passkeys,               // `undefined` until you call listPasskeys(); `[]` means "none"
  error, isSigningIn, isRegistering, isSteppingUp, isLoading, isMutating,
} = usePasskeys();
```

`passkeys` starts as **`undefined`**, not `[]`. The difference is not pedantry: `[]` says "this user has
no passkeys" and `undefined` says "we have not looked". An empty-state UI keyed on `passkeys?.length === 0`
renders "no passkeys yet" before the first `listPasskeys()` has even run.

### Step-up tokens — read this before building an "Add a passkey" button

Every management action (`registerPasskey`, `listPasskeys`, `renamePasskey`, `deletePasskey`) requires a
**step-up token**: changing which keys can sign you in is itself a sensitive act, so the server demands a
fresh re-authentication for it. The SDK never mints or stores one for you.

**There is a chicken-and-egg here, and it will bite you first.** `stepUpWithPasskey()` re-authenticates
with an **existing passkey** — so it cannot mint the token needed to register the user's **first** one.
For that first registration, obtain a step-up token through another factor (your app's password or MFA
step-up endpoint), then pass it to `registerPasskey({ stepUpToken })`. Once the user has a passkey,
`stepUpWithPasskey()` is the smooth path for every subsequent management action.

Treat a step-up token as **single-use and short-lived**: mint a fresh one per gated action rather than
caching one across a management screen. (`stepUpWithPasskey()` returns its `expiresIn`.) The server's
reuse semantics are not something the SDK guarantees, so the defensive reading is the correct one.

### The bridge contract

| Module member | Required | Shape |
|---|---|---|
| `isPasskeySupported()` | yes | `Promise<boolean>` — the device can run a passkey ceremony at all |
| `createPasskey(requestJson)` | yes | `Promise<string>` — the registration credential, serialised |
| `getPasskey(requestJson)` | yes | `Promise<string>` — the authentication credential, serialised |
| `isPlatformAuthenticatorAvailable()` | no | `Promise<boolean>` — is there a *platform* authenticator, not just any |
| `cancelPasskeyRequest()` | no | `Promise<void> \| void` — dismiss an open sheet when the ceremony is abandoned |

Implement `cancelPasskeyRequest` if your module can: without it, a ceremony abandoned by your app (a
screen unmounts, a timeout fires) can leave the OS sheet standing, and a registration abandoned after
the credential provider already created the credential leaves the user holding a passkey the server
never learned about (see *Orphaned credentials* below).

**Strings, not objects — and this is not a style preference.** The RN bridge serialises through JSON
and **drops `undefined`**, which silently deletes optional members. A request that arrives with
`residentKey` missing is a *different* request from one that arrives with `residentKey: 'required'`,
and the sheet the user sees changes accordingly. Passing the request as a string we build ourselves
is the only way to guarantee the bytes the OS gets are the bytes the server signed off on.

Every binary field is **base64url without padding** (`A–Z a–z 0–9 - _`, no `=`). Standard base64 —
with `+`, `/`, `=` — is rejected, and it is the single most common wiring bug: an authenticator that
returns standard base64 must be re-encoded in your shim, not "fixed" server-side.

### iOS ≠ Android

The two platforms fail differently, and the SDK maps both onto one vocabulary so your UI does not
have to branch:

| What happened | Code your UI handles |
|---|---|
| The user dismissed the sheet | `PASSKEY_CEREMONY_CANCELLED` |
| The device cannot do passkeys, or no adapter is wired | `PASSKEY_NOT_SUPPORTED` |
| The credential is already registered for this user | `PASSKEY_ALREADY_REGISTERED` |
| The action needs a fresh re-authentication first | `PASSKEY_STEP_UP_REQUIRED` |
| Your module broke the contract (returned a non-credential) | `PASSKEY_ADAPTER_ERROR` — an integration bug, never a retry |
| Sign-in succeeded but the tenant demands another factor | `PASSKEY_ADDITIONAL_STEP_REQUIRED` — **no tokens are issued**; route the user into your MFA flow, do not show "failed" |
| The user tried to delete their only sign-in method | `PASSKEY_LAST_METHOD` — "add another method first", not a generic failure |
| The phone was offline | `PASSKEY_NETWORK_ERROR` — retryable; do **not** sign the user out |
| The session is genuinely gone | `PASSKEY_SESSION_EXPIRED` — re-authenticate |
| Too many attempts | `PASSKEY_RATE_LIMITED` (`retryAfterMs` when the server sent one) |
| Anything else the OS reported | `PASSKEY_CEREMONY_FAILED` (retryable) |

Every error carries a `nextAction` (`retry` / `abort` / `none`) — branch on that rather than on the code
when all you need is "should the user try again". `PASSKEY_ADDITIONAL_STEP_REQUIRED` is the one most
likely to be mishandled: it arrives on a **successful** ceremony (HTTP 200) and simply means the tenant
requires a further factor before a session is issued.

Treat `PASSKEY_CEREMONY_CANCELLED` as a non-event — no error banner. It is by far the most frequent
outcome, and it also covers **system-initiated** dismissal (a swipe-down, an incoming call, the app
being backgrounded), not just a deliberate "Cancel". Users who dismissed a sheet on purpose do not
want to be told they failed.

**Mapping platform exceptions in your module.** Your native module reports failures with a `code`;
these are the codes the bridge understands, and everything else is re-thrown unchanged and surfaces
as `PASSKEY_CEREMONY_FAILED`:

| Platform exception | Your module's `code` |
|---|---|
| iOS `ASAuthorizationError.canceled` | `PASSKEY_CANCELLED` |
| iOS `ASAuthorizationError.failed` / `.invalidResponse` | *(re-throw unchanged)* |
| iOS — passkeys unavailable on this OS version | `PASSKEY_UNSUPPORTED` |
| Android `GetCredentialCancellationException` / `CreateCredentialCancellationException` | `PASSKEY_CANCELLED` |
| Android `GetCredentialUnsupportedException` / `CreateCredentialUnsupportedException` | `PASSKEY_UNSUPPORTED` |
| Android `CreateCredentialNoCreateOptionException` (no credential provider) | `PASSKEY_UNSUPPORTED` — fall back immediately, do not retry |
| Android `NoCredentialException` (the user has no passkey here) | `PASSKEY_NO_CREDENTIAL` |
| A community wrapper's own error codes | map them onto the three above, or re-throw |
| **Everything else** | **re-throw unchanged** → the SDK reports `PASSKEY_CEREMONY_FAILED` |

That last row is a known, documented compromise: the SDK's error vocabulary is closed and deliberately
small, so a platform-specific cause that has no code of its own arrives as a generic retryable failure.
Do **not** rewrite an error's `name` in your shim to force a different classification — the SDK reads
the `code`, and a renamed error is a lie the whole taxonomy then propagates.

**Development builds show request headers.** A host's network inspector / debugging interceptor can see
the passkey requests, including the `X-Step-Up-Token` header. That is a property of your development
build, not of the SDK: the token is held in memory for the duration of the call and never written to
device storage. Do not log headers in production builds.

### Deployment prerequisite — RP-ID binding

Passkeys are bound to a **relying-party identifier** (your domain), and the OS refuses to run a
ceremony for an app that cannot prove it belongs to that domain. Before a single passkey works you
must publish the association files and declare the entitlement:

- **iOS** — an `apple-app-site-association` file served over HTTPS at your domain, plus the
  Associated Domains entitlement (`webcredentials:example.com`).
- **Android** — a Digital Asset Links (`assetlinks.json`) file at your domain listing your app's
  signing-certificate fingerprint.

Until both are in place the ceremony fails on the device with no useful message. These two files are
the prerequisite that turns "passwordless" into "phishing-resistant": with the Associated Domains
entitlement and the Digital Asset Links file in place, the OS will only offer a credential to an app
it has verified against the domain that credential was created for — and without them it offers
nothing at all.

### Symptom → cause

| Symptom | Cause |
|---|---|
| The sheet never appears | No association file / entitlement (see above), or `isSupported()` is false |
| Every ceremony returns `PASSKEY_CEREMONY_FAILED` on a real device | The request is being mutated in your shim — pass the JSON string through untouched |
| It works in a debug build, not in a release build | Android: the release signing certificate is not in `assetlinks.json` |
| A field is missing on the OS side | Your wrapper passes objects, not the request string — `undefined` was dropped across the bridge |
| Sign-in succeeds on the device but the app stays signed out | The token submission was rejected — the hook reports this rather than claiming success |

A generic ceremony failure on a first integration is, in practice, almost always a missing or incorrect
associated-domains / `assetlinks.json` configuration. The error vocabulary cannot tell you that (the OS
does not tell *us*), so this line is the diagnostics: check the association files first, before you
suspect the SDK or your module.

**Two components, one sheet.** The passkey sheet is an operating-system modal: there is exactly one, for
the whole device. If a sign-in button in your header and a passkey screen in your settings both call
`usePasskeys()`, the SDK's lock lets only one of them open a ceremony — the second call is refused
locally with `PASSKEY_INVALID_INPUT` ("a ceremony is already in progress") and surfaces in that hook's
`error`. Note the busy flags (`isSigningIn`, `isSteppingUp`, …) are **per hook instance**: they tell you
about *your* component's call, not about the other one's. If you have two entry points on one screen,
drive both from a single `usePasskeys()` instance, or render one of them behind the other's busy state.

**Expo Go and emulators.** Expo Go cannot load a custom native module, so passkeys need a development
build. An Android emulator without Google Play services has no credential provider; an iOS simulator
needs a signed-in Apple account. A device is the only environment that proves the wiring.

**Orphaned credentials.** If registration succeeds on the device but the server never records it, the
authenticator holds a credential the server does not know about. Registering again with the same
authenticator returns `PASSKEY_ALREADY_REGISTERED` — that is the documented way out, not an error to
hide.

**Signing in as a different user — call `signOut()` first, and here is what happens if you don't.** A
passkey sign-in while another user's session is live is **not** an account switch. The token runtime
detects the change of subject and **clears the existing session** — user A is signed out — and the hook
then reports `PASSKEY_REQUEST_FAILED`. Its `nextAction` is `retry`, and a retry *will* succeed (the old
session is already gone), so from the user's seat it looks like "the first tap logged me out and did
nothing; the second tap worked". Gate your UI on the current session instead: sign out, then sign in.

**Bearer, not DPoP, on the passkey legs today.** The tokens a passkey sign-in returns are used exactly
like any other token this SDK issues; sender-constraining them is a separate concern from the ceremony.

**Expo web.** `usePasskeys()` on RN targets the native ceremony. There is no browser fallback here —
without a wired adapter the hook fails closed with `PASSKEY_NOT_SUPPORTED` rather than quietly
switching to a different ceremony. For the web, use `@rakomi/react`.

## Security defaults

- Refresh tokens stored in `expo-secure-store` with `keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (no iCloud Keychain sync).
- Access tokens in-memory only (≤15min lifetime).
- WebView is **banned** in this package (RFC 8252 + ESLint guard).
- `Math.random` is **banned** (`expo-crypto.getRandomBytesAsync` is the only randomness source).
- `redirect: 'error'` on every fetch (SSRF guard — redirects are never auto-followed).

## Compliance

See [`SECURITY.md`](./SECURITY.md) and [`COMPLIANCE.md`](./COMPLIANCE.md) for OWASP MASVS L1 mapping, Mobile Top-10, GDPR Art. 32, CRA (Reg. 2024/2847) Art. 13/14, and threat model.

## Anti-patterns to avoid in consumer apps

- ❌ Don't store refresh tokens in `AsyncStorage` — it's not encrypted at rest.
- ❌ Don't ship without `expo prebuild` only if you're using bare-RN with custom native modules. Default Expo-managed flows do **not** require `expo prebuild`.
- ❌ Don't use generic redirect schemes (`rakomi://`) in production — register reverse-DNS (`com.example.myapp:/oauth/callback`) to defeat custom-scheme hijacking.

## Threat model — what the SDK does NOT defend against

- Jailbroken / rooted devices at runtime (consumer adds `react-native-jail-monkey` if needed).
- Cloned / repackaged apps (use Play Integrity API / DeviceCheck on the consumer side).
- Hostile in-process npm dependencies (no JS-side mitigation; supply-chain hygiene is the consumer's responsibility).

## Publisher webhooks

`verifyPublisherWebhook` verifies Rakomi publisher-app webhook deliveries (Standard Webhooks
HMAC-SHA256, replay defence, key-rotation tolerance). See the canonical
[publisher-webhook receiver contract](https://docs.rakomi.dev/guides/publisher-webhooks/).

## License

See [`LICENSE`](./LICENSE).
