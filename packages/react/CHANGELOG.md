## 0.7.0 — 2026-10-04

- **The session survives a server outage during token refresh.** A 5xx, 429, 408 or network failure while refreshing no longer signs the user out after three retries. The SDK retries with jittered backoff (about 2 s, 8 s, 30 s), waits longer when the server sends `Retry-After` (capped at two minutes), and when those retries are spent it keeps the refresh token and the signed-in state. The failure is surfaced as `auth.error` and from `getToken()` as `REFRESH_FAILED` with `reason: 'network'`, including the HTTP `status`. The next `getToken()` call, reconnect, tab focus or page restore from the back/forward cache tries again.

## 0.6.0 — 2026-09-29

- **Security fix: MFA-enrolment helpers can now carry a fresh step-up token.** `setupMfa()` and `verifyMfaSetup()` now accept an optional `stepUpToken`, sent as the `X-Step-Up-Token` header. The API now requires a fresh step-up token for `POST /v1/auth/mfa/setup` and `/v1/auth/mfa/verify-setup` whenever the account already has a verified factor, or the session is outside the tenant's forced first-enrolment window — the same fresh-re-auth mechanism already used for passkey registration.
- **An abandoned passkey ceremony now closes the browser's passkey prompt.** When a `usePasskeys()` ceremony is aborted — by your `signal` or by the SDK's time budget — the browser adapter now asks the browser to cancel the WebAuthn request instead of only settling the promise. Before, the prompt could stay open after the SDK had stopped waiting, and a user who completed it created a passkey the server never received. Cancellation is best-effort: an authenticator that finishes at the same instant may still create its credential.
- **Security fix: `returnTo` and component redirect props only accept same-origin paths.** A value only had to start with `/` to count as a relative path, so protocol-relative and backslash forms such as `//evil.example`, `/\evil.example` or `/` + tab + `/evil.example` were accepted even though browsers send the user to another origin. When an app passed a user-supplied value to `signIn({ mode: 'redirect', returnTo })` and then navigated to it after sign-in, that became an open redirect.
- **Fix: the embedded `<SignIn />` component's social sign-in buttons now work.** Clicking a social provider button previously redirected to a URL carrying the OAuth client id as `tenant_id` — an identifier no tenant ever has — so every embedded social sign-in click failed. The button now sends only the OAuth client id; the API resolves the tenant from it directly.

## 0.5.0 — 2026-09-19

- **BREAKING (consumes a trust-model change in `@rakomi/sdk-core`).** This package carries no code-level change of its own — `signIn()`'s OAuth discovery resolution is `@rakomi/sdk-core`'s `createAuthorizationEndpointCache`, used here unchanged. But that dependency now validates a fetched discovery document's `issuer` field against the base URL it was requested for (RFC 8414 §3.3) before trusting anything in it, and fails closed — instead of silently falling back — when that check fails.

# @rakomi/react
