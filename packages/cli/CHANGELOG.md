## 0.3.0 — 2026-08-30

- New `rakomi tenants claim --ci` / `rakomi tenants release --ci` commands claim and release a throwaway, self-expiring tenant under your own tenant from a CI job — no API key or credential is minted. Both reuse the same `--ci` session `rakomi login --ci` already established (run that first); requires a trust policy whose scope ceiling includes `tenants:lease`. `--tenant <id>` names which of your tenants to claim/release under (or run `rakomi use <tenant-id>` once and omit it after); `--ttl-seconds`/`--label` only apply to `tenants claim`. Add `--json` for machine-readable output on either command.

## 0.1.1 — 2026-08-28

- Ship `sbom.cdx.json` and `SECURITY.md` inside the npm tarball.

# rakomi
