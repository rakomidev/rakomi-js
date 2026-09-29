## 0.6.0 — 2026-09-29

- **Offline token verification follows a signing-key rotation.** A token signed with a key published after the last JWKS fetch now triggers one refresh of the cached key set, at most once per 30 seconds, instead of failing until the cached document expires. Tokens signed with a key already in the cache verify as before, with no network call.
- **Passkey ceremonies follow the server's `timeout`, and a timeout is its own error.** The ceremony time budget now follows the `timeout` in the server's WebAuthn options (see `@rakomi/sdk-core`) instead of a fixed 60 seconds. When it elapses, the SDK asks your native module to cancel the request (`cancelPasskeyRequest`, as it already does for an abort) and returns `PASSKEY_CEREMONY_TIMED_OUT` instead of `PASSKEY_CEREMONY_CANCELLED`. Handle the new code wherever you branch on `error.code`; its `nextAction` is `retry`.

## 0.5.0 — 2026-09-19

- **BREAKING (offline verification trust-model change).** `TokenRuntime`'s offline JWT verification (`verifyAccessToken`, wired through `<RakomiProvider>`) now derives its default expected `iss` from the SDK's own configured `baseUrl` instead of a single hardcoded platform constant. A tenant that has bound its own custom domain as its issuer host is issued access tokens whose `iss` is that domain; the SDK now correctly expects and accepts that value by default, offline, without any consumer-side configuration.
- **Correction to the issuer-trust model shipped in the immediately-preceding release.** The default expected `iss` (and, for `@rakomi/sdk-core`/`@rakomi/node` discovery, the trust anchor a fetched discovery document's `issuer` field must match) is now resolved from `baseUrl` through a platform-host-aware two-tier rule, not a bare pass-through of `baseUrl` itself:

# @rakomi/react-native
