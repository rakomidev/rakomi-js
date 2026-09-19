## 0.5.0 — 2026-09-19

- **BREAKING (offline verification trust-model change).** `TokenRuntime`'s offline JWT verification (`verifyAccessToken`, wired through `<RakomiProvider>`) now derives its default expected `iss` from the SDK's own configured `baseUrl` instead of a single hardcoded platform constant. A tenant that has bound its own custom domain as its issuer host is issued access tokens whose `iss` is that domain; the SDK now correctly expects and accepts that value by default, offline, without any consumer-side configuration.
- **Correction to the issuer-trust model shipped in the immediately-preceding release.** The default expected `iss` (and, for `@rakomi/sdk-core`/`@rakomi/node` discovery, the trust anchor a fetched discovery document's `issuer` field must match) is now resolved from `baseUrl` through a platform-host-aware two-tier rule, not a bare pass-through of `baseUrl` itself:

# @rakomi/react-native
