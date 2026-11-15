## 0.6.1 — 2026-11-15

- Version 0.6.0 was never published to npm; 0.6.1 is the first published release with the changes listed under 0.6.0.

## 0.6.0 — 2026-11-15

- `rakomi whoami` after `rakomi login --ci` now describes the CI session: it asks the API (`GET /v1/oidc-federation/session`, with the session's DPoP proof) and prints the server's answer — the tenant, the environment and the trust policy the token was issued under, the CI identity that signed in (the OIDC token's `sub` claim) and the granted scopes — plus where the session is stored and when it expires (`--json` gives the same as fields). Before, it asked the account endpoint, which has no account for a CI token, and failed. Breaking: `RAKOMI_API_URL` must be an `https://` URL (plain `http://` only on localhost); any other value is refused before a request is made. In a GitHub Actions job without the `id-token: write` permission, `rakomi login --ci` now says that this permission is missing and how to add it.

# rakomi
