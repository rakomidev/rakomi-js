## 0.3.1 — 2026-08-28

- MFA verification and recovery-code endpoints match the API.

## 0.3.0 — 2026-08-28

- Fixed a type mismatch where the `locale` prop on pre-built components (`SignIn`, `SignUp`, `UserButton`, `UserProfile`, `PricingTable`, `SubscriptionManager`) only accepted `'en' | 'pl'`, even though `RakomiProvider` and the exported `Locale` type already accept all five supported locales (`en`/`pl`/`de`/`fr`/`es`). Every component now types `locale` against the same `Locale` union, so passing `locale="de"` (or `"fr"` / `"es"`) type-checks and renders the full localized dictionary for that locale, matching runtime behavior that already worked.
- API errors from every `/v1/*` endpoint are now RFC 9457 Problem Details (`application/problem+json`: `type`, `title`, `status`, `detail`, `instance`, plus the stable `code` you already match on). The SDKs parse the new shape and expose the same `code` on thrown errors; the previous `{ error: { code } }` envelope is no longer emitted, so code that read `body.error.code` directly must move to the SDK's error object or to the top-level `code` field. OAuth endpoints (`/oauth/*`) keep the RFC 6749 §5.2 shape. Every `type` URI resolves to a section of https://docs.rakomi.dev/sdk/errors.
- Fixed browser-navigation sign-in (`signIn({ mode: 'redirect' })` in `@rakomi/react` / `@rakomi/react-native`'s `<SignIn>`, and `buildAuthorizeUrl()` / `RakomiClient` in `@rakomi/node`) using the wrong host for the authorization page. It previously assembled `${baseUrl}/oauth/authorize` on the API host — a JSON API endpoint, not a page a browser can render a login form from. The correct `authorization_endpoint` is published by OIDC discovery (`GET /.well-known/openid-configuration`) on a different host.

# @rakomi/react
