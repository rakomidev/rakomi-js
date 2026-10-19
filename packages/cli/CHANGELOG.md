## 0.5.0 — 2026-10-19

- `rakomi login --tenant-admin` signs a tenant owner in for tenant administration from the command line, such as managing the tenant's OAuth clients. It opens the browser to sign in and asks for the `tenants:manage` scope, which is granted to a tenant owner only. The tokens are short-lived and bound to a key kept on this machine; they are not accepted without a proof made with that key. The flag does not combine with `--no-browser`. When such a session is refreshed, the new session is stored and read back before the new access token is used, and two `rakomi` processes refreshing the same session at once take turns instead of presenting the same refresh token twice. Without the flag, `rakomi login` works exactly as before.

# rakomi
