## 0.3.1 — 2026-08-30

- Fix: `JwksCache`'s internal base-URL normalization no longer uses a slow-string-prone regular expression to strip a trailing slash. Behavior is unchanged; this closes a theoretical slow-input edge case flagged by code review, matching an earlier fix already applied to `RakomiClient`'s own base-URL handling.

# @rakomi/node
