## 0.5.0 — 2026-09-19

- **BREAKING (consumes a trust-model change in `@rakomi/sdk-core`).** This package carries no code-level change of its own — `signIn()`'s OAuth discovery resolution is `@rakomi/sdk-core`'s `createAuthorizationEndpointCache`, used here unchanged. But that dependency now validates a fetched discovery document's `issuer` field against the base URL it was requested for (RFC 8414 §3.3) before trusting anything in it, and fails closed — instead of silently falling back — when that check fails.

# @rakomi/react
