## 0.7.0 — 2026-10-04

- **Issuer-bound signing keys.** New exports resolve an issuer's keys from its discovery document: `createIssuerJwksUriResolver`, `issuerDiscoveryUrls`, `extractJwksUri`, `IssuerMismatchError` and `discoveryOriginFor`. Discovery tries OAuth 2.0 Authorization Server Metadata first, then OpenID Connect Discovery, both path-aware, and uses a document only when its `issuer` equals the expected issuer exactly.
- **A server outage during token refresh no longer reads as a revoked session.** `refreshAccessToken()` and `parseTokenEndpointError()` now classify a refresh failure by what it means for the session:

## 0.6.0 — 2026-09-29

- **Security fix: `isSafeUrl()` rejects relative values that leave the current origin.** A value starting with `/` was accepted as a relative path unless it started with `//`, so backslash forms such as `/\evil.example` and a `/` followed by a tab or newline and another `/` were accepted even though browsers resolve them to another origin. Relative values must now resolve back to the current origin; ordinary paths (`/dashboard`, `/a/b?x=1#frag`) and allow-listed absolute URLs and deep links are unaffected. Packages that validate `returnTo` with `isSafeUrl()` pick up the fix through this dependency.
- **The JWKS cache picks up a rotated signing key.** `createJwksCache` now offers `withKeyRotationRetry(verify)`: it runs your verification against the cached key set and, when the only failure is that no cached key matches the token (`ERR_JWKS_NO_MATCHING_KEY`), refreshes the key set once and retries. Such a refresh happens at most once per 30-second window, so tokens carrying never-seen key ids cannot turn the verifier into a stream of JWKS requests. Previously a key rotated in after the last fetch was not found until the cached document expired (24 hours by default).
- **Passkey ceremonies no longer give up before the server does, and a timeout is its own error.**

## 0.5.0 — 2026-09-19

- **BREAKING (trust-model change).** `createAuthorizationEndpointCache()`'s discovery path now validates the fetched document's `issuer` field against the `baseUrl` it was requested for, per RFC 8414 §3.3 ("The 'issuer' value returned MUST be identical to the authorization server's issuer identifier value ... If these values are not identical, the data contained in the response MUST NOT be used") — strict equality (tolerating one trailing slash), never a prefix/substring match.
- **Correction to the issuer-trust model shipped in the immediately-preceding release.** The default expected `iss` (and, for `@rakomi/sdk-core`/`@rakomi/node` discovery, the trust anchor a fetched discovery document's `issuer` field must match) is now resolved from `baseUrl` through a platform-host-aware two-tier rule, not a bare pass-through of `baseUrl` itself:

# @rakomi/sdk-core
