## 0.2.0 — 2026-10-04

- **The wizard collects `RAKOMI_ISSUER` for the `node` and `nextjs` templates.** Both templates verify access tokens on their own server, and every Rakomi environment is its own issuer with its own signing keys, so the app must be told which issuer to accept — for example `https://api.rakomi.com/t/tn_…` for your default environment or `https://api.rakomi.com/t/tn_…/test` for Test. The value is written to `.env` like the other collected keys and can be passed through the `RAKOMI_ISSUER` environment variable. The `react` and `expo` templates never verify a token themselves and do not get the line.

# create-rakomi-app
