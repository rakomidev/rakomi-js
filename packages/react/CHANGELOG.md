## 0.13.1 — 2026-11-25

- `@rakomi/sdk-core` 0.9.0, `@rakomi/react` 0.13.0, `@rakomi/react-native` 0.9.0 and `create-rakomi-app` 0.2.1 were tagged but never published to npm. This release (`@rakomi/sdk-core` 0.9.1, `@rakomi/react` 0.13.1, `@rakomi/react-native` 0.9.1, `create-rakomi-app` 0.2.2) is the first published one after `@rakomi/sdk-core` 0.8.0, `@rakomi/react` 0.12.0, `@rakomi/react-native` 0.8.0 and `create-rakomi-app` 0.2.0, and contains everything listed under the unpublished versions. If you upgrade from those versions, note the breaking changes made there:

## 0.13.0 — 2026-11-25

- The sign-up binding is a list: a resend's answer is added, never put in place of what was kept.
- Sign-up keeps the password chosen at registration when the verification link is opened where the user signed up.

## 0.12.0 — 2026-11-23

- Changed: `useLinkedAccounts()` completes a link by itself. When the page `link()` started from loads with `?link_code=...&provider=...`, the hook removes both from the URL, calls `POST /v1/users/me/link/complete` with the signed-in session's token and refreshes `methods`; a refusal is in `error` (`account_linking/link_completion_invalid` for a used, expired or foreign code). Mount the hook on the page you link from.

## 0.11.0 — 2026-11-11

- Internal dependency updates.

## 0.10.0 — 2026-10-21

- `useLinkedAccounts().unlink()` accepts an optional second argument, `{ stepUpToken }`, sent as the `X-Step-Up-Token` header.

# @rakomi/react
