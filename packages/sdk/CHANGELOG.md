## 0.2.0 — 2026-08-20

- The SDK's default expected issuer/audience for platform-issued tokens now derive from
- Fix `verifyToken()` / `verifyRakomiToken()` to populate `org_id`, `org_role`, and `org_memberships` on the verified `TokenPayload`. These fields were declared on the `TokenPayload` type in a prior release but never populated by either verify function; they are now populated whenever the underlying token carries the `org` scope claims.
- Add standalone resource-server helpers: `verifyRakomiToken()`, `buildProtectedResourceMetadata()`, and `buildChallenge()`.

# @rakomi/node
