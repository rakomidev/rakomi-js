# rakomi

The [Rakomi](https://rakomi.com) CLI. EU-native authentication as a service.

## Getting started

```sh
npx rakomi login
```

Signs you in with your browser (loopback OAuth + PKCE). Add `--no-browser` on a headless/SSH
session to get a short code to enter on another device instead. If you don't already have a
`accounts.rakomi.com` session or an invitation link, pass `--tenant-id <uuid>` (or set
`RAKOMI_PLATFORM_TENANT_ID`) so sign-in knows which tenant to authenticate against — ask your
Rakomi administrator for the right value.

`rakomi whoami` shows the tenant you signed in against ("Home tenant") and the tenant your other
commands should treat as active ("Active tenant"). `rakomi use <tenant-id>` remembers a tenant id
locally for that; `--tenant <tenant-id>` overrides it for one command. Neither is a verified
grant — the tenant `whoami` shows as your Home tenant is the only one the server has confirmed.

## Connect an AI agent

```sh
npx rakomi connect
```

Detects Claude Code and writes the `.mcp.json` entry for you, or prints Claude Desktop's
Custom-Connectors instructions when run with `--client claude-desktop`. Read access works
immediately once the client finishes its own sign-in; write access is a separate step your
tenant owner approves — see the [Connect an AI Agent guide](https://docs.rakomi.dev/guides/connect-an-ai-agent).

Pass `--cimd-url <url>` (find it in your MCP client's own connection diagnostics) and `rakomi`
confirms the connection for you instead of leaving you to check the dashboard; add `--write` to
also request owner-granted write access once it's found. `--status --cimd-url <url>` re-checks
later without rewriting `.mcp.json` — the resume path when you weren't ready to approve yet.

## Provision a tenant

```sh
npx rakomi tenants create "Acme staging"
```

Creates a new tenant with you as the owner by default (`--owner me`) — no invitation round trip, and
the response includes a freshly minted API key (shown once — save it). Pass `--owner <email>` to hand
ownership to someone else instead; that requires a partner API credential (a `client_credentials`
token), sends a real invitation e-mail, and is refused under `--ci` — see
[Provision Tenants](https://docs.rakomi.dev/guides/provision-tenants) for both flows end to end.

## Commands

| Command | Description |
| --- | --- |
| `login` | sign in (browser by default; `--no-browser` for a device code) |
| `logout` | clear the local session |
| `whoami` | show the signed-in account, home tenant, and active tenant |
| `use <tenant-id>` | remember a tenant id locally for `whoami`/future commands |
| `connect` | connect Claude Code / Claude Desktop to your tenant (read access) |
| `tenants create <name>` | create a tenant (`--owner me\|<email>`, `--slug <slug>`) |
| `tenants list` | list tenants you provisioned |

## Global options

| Option | Meaning |
| --- | --- |
| `--json` | machine-readable output |
| `--yes`, `--ci` | never prompt; fail fast on any step needing a human |
| `--dry-run` | print what would happen, make no writes or mutating calls |
| `--no-browser` | use the device-code flow instead of opening a browser |
| `--no-keychain` | store the session in a `0600` file instead of the OS keychain |
| `--tenant-id <uuid>` | (`login`) the tenant to sign in against, if `RAKOMI_PLATFORM_TENANT_ID` isn't set for you |
| `--tenant <tenant-id>` | override the active tenant for a single command (`whoami` today) |
| `--client <name>` | `claude-code` or `claude-desktop` — required when more than one applies |
| `--undo` | restore the `.mcp.json` `connect` last backed up |
| `--cimd-url <url>` | (`connect`) the connecting client's own CIMD document URL — confirms/re-checks the connection |
| `--status` | (`connect`) re-check status only — needs `--cimd-url`, never rewrites `.mcp.json` |
| `-h`, `--help` | show help |
| `-V`, `--version` | print the version |

## Caveats

- **Your session lives in your OS keychain** — macOS Keychain, the Linux Secret Service (via
  `secret-tool`), or a Data-Protection-API-encrypted file on Windows — whichever is available.
  `rakomi whoami` names the exact backend in use. When none is available (or you pass
  `--no-keychain`, or `CI` is set), the CLI falls back to a `0600` file under
  `~/.config/rakomi/session.json` (or `RAKOMI_CONFIG_DIR` if set) and prints a one-line notice the
  first time it does. An existing `0600` file from an older install is imported into the keychain
  automatically, then removed. `rakomi logout` clears whichever backend is in use.
- **The access token is never printed, logged, or included in `--json` output.**
- **No telemetry.** The CLI collects nothing and phones home about nothing beyond the Rakomi API
  calls a command actually needs to make.
- **`--owner <email>` sends a real invitation e-mail** — it always requires interactive
  confirmation and is refused under `--ci`.

## License

[MIT](./LICENSE) © CRE8EVE Sp. z o.o.
