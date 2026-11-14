## 0.13.0 — 2026-11-14

- Added: `refreshAgentToken()` takes `dpop`, the `DpopSession` you passed to `exchangeCode` when the human approved the background-agent grant. A grant approved through a DPoP-bound code exchange is bound to that key: every renewal needs a proof from it, and the SDK attaches one when the server has confirmed the binding (`token_type` is `DPoP`). The renewed access token is bound to the same key. A bearer grant attaches no proof.

## 0.12.0 — 2026-11-11

- Breaking: `RakomiConfig.strictEnvironment` is removed. `verifyToken()`, `verifyRakomiToken()` and `verifyLogoutToken()` now always reject a token without an `rkm_env` claim, with `auth/environment_mismatch`, whichever environment the client is configured for. `TokenPayload.environment` is no longer optional. Tokens issued before the claim was on them no longer verify; sign in again or refresh to get one that does. Remove the option from your config.
- Added: `refreshAgentToken()` (also `RakomiClient.refreshAgentToken()`) renews a background-agent grant: `grant_type=refresh_token` with the agent client's credentials in the request body. The refresh token is single-use; the result carries its successor in `refreshToken`, and you MUST store it before using the new access token. Presenting a consumed token ends the grant and every session of the human. A response without a successor is an error, never a success. `OAuthRefreshOptions.scope` lets a refresh narrow the scope. `buildAuthorizeUrl()` takes `offlineAccess: true`, which adds `offline_access` to the scope and sends `prompt=consent`.

## 0.11.0 — 2026-10-21

- `link.remove()` accepts an optional `stepUpToken`, sent as the `X-Step-Up-Token` header.

# @rakomi/node
