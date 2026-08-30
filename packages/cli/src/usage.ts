// SPDX-License-Identifier: MIT

export interface OutputStream {
  write(text: string): void;
}

export function helpText(): string {
  return [
    'rakomi — the Rakomi CLI: sign in, connect an AI agent, and provision tenants',
    '',
    'Usage:',
    '  rakomi <command> [options]',
    '',
    'Commands:',
    '  login                    sign in (browser by default; --no-browser for a device code)',
    '    --ci                   sign in from CI via the runner\'s own OIDC identity (no browser/device code)',
    '    --oidc-token-file <p>  read the OIDC token from a file instead of the CI platform\'s own env',
    '    --tenant-id <uuid>     the tenant to authenticate against (or set RAKOMI_PLATFORM_TENANT_ID)',
    '  logout                   clear the local session',
    '  whoami                   show the signed-in account, home tenant, and active tenant',
    '  use <tenant-id>          remember a tenant id locally for whoami/future commands (a value, not a verified membership)',
    '  connect                  connect Claude Code / Claude Desktop to your tenant (read access)',
    '    --write                also request write access for the connected client',
    '    --client <name>        claude-code | claude-desktop (required if more than one applies)',
    '    --undo                 restore the .mcp.json this command last backed up',
    '    --cimd-url <url>       the connecting client\'s own CIMD document URL — confirms the connection',
    '    --status               re-check status only (needs --cimd-url; never rewrites .mcp.json)',
    '  tenants create <name>    create a tenant (parent-tenant only; depth-1 enforced server-side)',
    '    --owner <me|email>     who becomes the new tenant\'s owner (default: me)',
    '    --slug <slug>          optional; auto-derived + suffixed if omitted',
    '  tenants list             list tenants you provisioned',
    '  mcp tools --ci           list MCP read tools your CI identity can invoke (no login needed first)',
    '',
    'Global options:',
    '  --json                   machine-readable output',
    '  --yes, --ci              never prompt; fail fast on any step needing a human',
    '  --dry-run                print what would happen, make no writes or mutating calls',
    '  --no-browser             use the RFC 8628 device-code flow instead of opening a browser',
    '  --no-keychain            store the session in a 0600 file instead of the OS keychain',
    '  --tenant <id>            override the active tenant for this invocation (whoami only today)',
    '  -h, --help               show this help and exit',
    '  -V, --version            print the version and exit',
    '',
    'Exit codes: 0 ok, 1 failure, 2 usage error, 3 not logged in, 4 needs a human (see --ci).',
    '',
  ].join('\n');
}

export function usageLine(): string {
  return 'Usage: rakomi <command> [options] (see --help)';
}
