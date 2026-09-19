## 0.5.0 — 2026-09-19

- **BREAKING (trust-model change).** `createAuthorizationEndpointCache()`'s discovery path now validates the fetched document's `issuer` field against the `baseUrl` it was requested for, per RFC 8414 §3.3 ("The 'issuer' value returned MUST be identical to the authorization server's issuer identifier value ... If these values are not identical, the data contained in the response MUST NOT be used") — strict equality (tolerating one trailing slash), never a prefix/substring match.
- **Correction to the issuer-trust model shipped in the immediately-preceding release.** The default expected `iss` (and, for `@rakomi/sdk-core`/`@rakomi/node` discovery, the trust anchor a fetched discovery document's `issuer` field must match) is now resolved from `baseUrl` through a platform-host-aware two-tier rule, not a bare pass-through of `baseUrl` itself:

# @rakomi/sdk-core
