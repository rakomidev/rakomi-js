## 0.3.1 — 2026-10-04

- **A server outage during token refresh no longer reads as an expired session.** When the token endpoint answers 5xx, 429 or 408, or the request fails on the network or times out, the CLI now reports that cause (with the server's `Retry-After` and request id when present) and keeps the stored login, so the next command works once the API is back. Before, it said the session had expired and asked you to log in again. Only a rejected refresh token (`invalid_grant` and other 4xx) still ends the session.

# rakomi
