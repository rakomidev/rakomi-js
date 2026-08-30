## 0.4.0 — 2026-08-30

- New `client.authz` — a thin, transport-only client for Rakomi's **experimental** AuthZEN Authorization API 1.0 subset PDP endpoints: `evaluate()`, `evaluateBatch()`, `searchActions()`, and `discover()`. Every call requires an end-user or M2M/agent bearer token carrying `authz:evaluate` (passed per call as `accessToken`, not the client's own API key) and returns the standard `VerifyResult` shape with typed `authz/*` errors (`unauthorized`, `forbidden`, `disabled`, `invalid_request`, `payload_too_large`, `rate_limited`, `network_error`). See docs.rakomi.dev/guides/authzen-pdp for the endpoint contract, current availability, and scope — this implements a subset of the specification and is subject to change before GA.

# @rakomi/node
