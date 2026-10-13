## 0.7.1 — 2026-10-13

- **A token refresh answered with an unreadable success response now ends the session instead of being retried.** When the token endpoint answers a refresh with a 2xx whose body cannot be read (not JSON, truncated, or missing `access_token` / `expires_in`), the server has already rotated the refresh token. The SDKs used to treat this as a transient failure and retry with the same, already spent refresh token, which the server treats as refresh-token reuse and answers by revoking every session of the user on every device. The SDKs now clear the local session and never send that refresh token again; the error is `REFRESH_FAILED` with `reason: 'revoked'` and the 2xx `status`. A 5xx, 429 or 408 response and a network failure are still transient: the session is kept and the refresh is retried with backoff. A sign-in code exchange answered the same way still fails with `CODE_EXCHANGE_FAILED`. `@rakomi/sdk-core` (re-exported by `@rakomi/react`) adds `unreadableRefreshResponseError(status, message)`, which builds that error. No `AuthError` variant or `reason` value changes.

## 0.7.0 — 2026-10-04

- **Breaking: offline token verification reads the expected issuer's own `jwks_uri`.** When `jwksUri` is not set, keys come from the expected issuer's discovery document instead of a fixed `/.well-known/jwks.json` next to the token endpoint, so a key published by any other issuer is never trusted. RS256, PS256 and ES256 (P-256) tokens verify; the header `alg` must equal the key's own `alg`. Persisted key sets are now stored per issuer, so the first verification after upgrading fetches the key set once.
- **The session survives a server outage during token refresh, including DPoP-bound sessions.**

## 0.6.0 — 2026-09-29

- **Offline token verification follows a signing-key rotation.** A token signed with a key published after the last JWKS fetch now triggers one refresh of the cached key set, at most once per 30 seconds, instead of failing until the cached document expires. Tokens signed with a key already in the cache verify as before, with no network call.
- **Passkey ceremonies follow the server's `timeout`, and a timeout is its own error.** The ceremony time budget now follows the `timeout` in the server's WebAuthn options (see `@rakomi/sdk-core`) instead of a fixed 60 seconds. When it elapses, the SDK asks your native module to cancel the request (`cancelPasskeyRequest`, as it already does for an abort) and returns `PASSKEY_CEREMONY_TIMED_OUT` instead of `PASSKEY_CEREMONY_CANCELLED`. Handle the new code wherever you branch on `error.code`; its `nextAction` is `retry`.

## 0.5.0 — 2026-09-19

- **BREAKING (offline verification trust-model change).** `TokenRuntime`'s offline JWT verification (`verifyAccessToken`, wired through `<RakomiProvider>`) now derives its default expected `iss` from the SDK's own configured `baseUrl` instead of a single hardcoded platform constant. A tenant that has bound its own custom domain as its issuer host is issued access tokens whose `iss` is that domain; the SDK now correctly expects and accepts that value by default, offline, without any consumer-side configuration.
- **Correction to the issuer-trust model shipped in the immediately-preceding release.** The default expected `iss` (and, for `@rakomi/sdk-core`/`@rakomi/node` discovery, the trust anchor a fetched discovery document's `issuer` field must match) is now resolved from `baseUrl` through a platform-host-aware two-tier rule, not a bare pass-through of `baseUrl` itself:

# @rakomi/react-native
