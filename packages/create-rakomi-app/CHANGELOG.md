## 0.2.2 — 2026-11-25

- `@rakomi/sdk-core` 0.9.0, `@rakomi/react` 0.13.0, `@rakomi/react-native` 0.9.0 and `create-rakomi-app` 0.2.1 were tagged but never published to npm. This release (`@rakomi/sdk-core` 0.9.1, `@rakomi/react` 0.13.1, `@rakomi/react-native` 0.9.1, `create-rakomi-app` 0.2.2) is the first published one after `@rakomi/sdk-core` 0.8.0, `@rakomi/react` 0.12.0, `@rakomi/react-native` 0.8.0 and `create-rakomi-app` 0.2.0, and contains everything listed under the unpublished versions. If you upgrade from those versions, note the breaking changes made there:

## 0.2.1 — 2026-11-25

- Templates are downloaded at the commit pinned in this release, and the archive is refused before unpacking when its sha512 differs from the pinned checksum. A `--template-source` mirror must serve the same archive at `/<owner>/<repo>/tar.gz/<commit>`.

## 0.2.0 — 2026-10-04

- **The wizard collects `RAKOMI_ISSUER` for the `node` and `nextjs` templates.** Both templates verify access tokens on their own server, and every Rakomi environment is its own issuer with its own signing keys, so the app must be told which issuer to accept — for example `https://api.rakomi.com/t/tn_…` for your default environment or `https://api.rakomi.com/t/tn_…/test` for Test. The value is written to `.env` like the other collected keys and can be passed through the `RAKOMI_ISSUER` environment variable. The `react` and `expo` templates never verify a token themselves and do not get the line.

# create-rakomi-app
