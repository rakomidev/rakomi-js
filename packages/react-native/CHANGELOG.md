## 0.2.0 — 2026-08-20

- **Breaking:** `AuthConfig.socialProviders` changed from `string[]` to `Record<string, { signIn:
- The SDK's default expected issuer/audience for platform-issued tokens now derive from
- Passkeys on React Native: a native ceremony bridge for the `@rakomi/sdk-core` passkey contract.
- Passkeys on React Native: `usePasskeys()` — sign-in, step-up, registration and management
- `@rakomi/sdk-core` now exports `parseAuthConfigResponse(raw, baseUrl): AuthConfig`, the wire-format parser for `GET /v1/auth/config` (snake_case→camelCase mapping, prototype-pollution guard on provider keys, hex-color and same-origin logo URL validation, boolean flag coercion — never throws on malformed input). `@rakomi/react` and `@rakomi/react-native` now both consume this shared implementation internally instead of each maintaining their own copy; there is no change to either package's public API or runtime behaviour.

# @rakomi/react-native
