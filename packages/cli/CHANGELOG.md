## 0.2.0 — 2026-08-30

- Fix: the CLI's internal base64url encoding — used when building sign-in requests and local key material — no longer uses a slow-string-prone regular expression to strip padding. Behavior is unchanged; this closes a theoretical slow-input edge case flagged by automated code scanning.
- `rakomi login` can now resolve which tenant to authenticate against from an explicit `RAKOMI_PLATFORM_TENANT_ID` (or `--tenant-id <uuid>`), closing the gap where a completely cold sign-in (no prior `accounts.rakomi.com` session, no invitation link) had no way to tell the authorization server which tenant to use. New `rakomi use <tenant-id>` remembers a tenant id locally; `--tenant <tenant-id>` overrides it for a single command. `whoami` now shows the tenant your session actually signed in against ("Home tenant") alongside the locally-remembered active tenant ("Active tenant").

## 0.1.1 — 2026-08-28

- Ship `sbom.cdx.json` and `SECURITY.md` inside the npm tarball.

# rakomi
