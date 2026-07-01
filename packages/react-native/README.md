# `@rakomi/react-native`

React Native / Expo SDK for [Rakomi](https://rakomi.com) — EU-native auth-as-a-service.

> **Status:** `0.1.0` — initial. API surface frozen for parity with `@rakomi/react`.
> Token-manager runtime, JWKS verification, social-provider deep-link auto-handler,
> bare-RN adapter example, and the demo app land in subsequent 0.x patches.

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

## What's included in 0.1.0

- **`<RakomiProvider>`** — context provider. Freezes the native adapter on mount. AppState debounce 300ms. Connectivity transitions wired.
- **Hooks (parity-locked):** `useAuth`, `useUser`, `useSession`, `useFlag`, `useOrganization`, `useOrganizationList`, `useLinkedAccounts`, `useTranslation`, `useAuthConfig`, `useBranding`, `useAnonymousSignin`, `useBaasPlans`, `useBaasSubscription`. Type-level parity with `@rakomi/react` is enforced by CI.
- **Components:** `<SignIn />` (password + social + MFA TOTP), `<SignUp />`, `<UserButton />`, `<UserProfile />` (preview), `<SignedIn>`, `<SignedOut>`, `<Protect>`, `<Feature>`. RN primitives only — no HTML, no WebView.
- **OAuth (RFC 8252):** PKCE S256, 32-byte state with single-use 60s TTL + constant-time comparison, system browser via `expo-web-browser` (`preferEphemeralSession: true` default), confused-deputy guard on callback ingest.
- **Native adapter contract:** `NativeAuthAdapter` interface with forward-compat slots (`verifiers` for EUDI, `dpopProver` for DPoP, `par` for RFC 9126 PAR).
- **`tokenCache` injection sugar** — replace storage without re-implementing the full adapter.
- **HKDF-style storage key derivation** — domain-separated per tenant + per purpose.

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
