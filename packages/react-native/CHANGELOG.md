## 0.3.1 — 2026-08-28

- MFA verification and recovery-code endpoints match the API.

## 0.3.0 — 2026-08-28

- API errors from every `/v1/*` endpoint are now RFC 9457 Problem Details (`application/problem+json`: `type`, `title`, `status`, `detail`, `instance`, plus the stable `code` you already match on). The SDKs parse the new shape and expose the same `code` on thrown errors; the previous `{ error: { code } }` envelope is no longer emitted, so code that read `body.error.code` directly must move to the SDK's error object or to the top-level `code` field. OAuth endpoints (`/oauth/*`) keep the RFC 6749 §5.2 shape. Every `type` URI resolves to a section of https://docs.rakomi.dev/sdk/errors.
- `@rakomi/sdk-core`'s `Locale` type widened from the original 5-locale union (`'en' | 'pl' | 'de' | 'fr' | 'es'`) to the full 24-code EU locale set, matching `@rakomi/react`'s `Locale` type and the platform's structural locale-eligibility set. `@rakomi/react-native` re-exports `Locale` from `@rakomi/sdk-core`, so its public `Locale` type widens the same way.
- Fixed browser-navigation sign-in (`signIn({ mode: 'redirect' })` in `@rakomi/react` / `@rakomi/react-native`'s `<SignIn>`, and `buildAuthorizeUrl()` / `RakomiClient` in `@rakomi/node`) using the wrong host for the authorization page. It previously assembled `${baseUrl}/oauth/authorize` on the API host — a JSON API endpoint, not a page a browser can render a login form from. The correct `authorization_endpoint` is published by OIDC discovery (`GET /.well-known/openid-configuration`) on a different host.

# @rakomi/react-native
