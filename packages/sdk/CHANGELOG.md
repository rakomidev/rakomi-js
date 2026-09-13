## 0.6.0 — 2026-09-13

- Adds `verifyLogoutToken()` — a standalone helper (no `apiKey`, no `RakomiClient`) that verifies an OIDC Back-Channel Logout 1.0 `logout_token` your `backchannel_logout_uri` endpoint receives. It performs every §2.6 validation step this SDK can decide on its own — signature and algorithm (RS256 only, `alg: none` rejected), `iss`/`aud`/`iat`/`exp`, presence of a `sub` or `sid` claim, the `events` claim's fixed member, and rejection of a `nonce` claim (explicitly forbidden for Logout Tokens) — and returns the same never-throws `{ ok, data | error }` shape as `verifyRakomiToken()`. Optional `expectedSid`/`expectedSub` let you bind the verification to the local session you intend to end. See the "Back-Channel Logout" section of the OIDC Provider guide for the receiver-side flow.

# @rakomi/node
