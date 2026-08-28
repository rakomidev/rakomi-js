// SPDX-License-Identifier: MIT

import { AmbiguousClientError, clientDisplayName, type KnownClient, resolveTargetClients } from '../clients.js';
import { pollCimdMaterialization, requestWriteElevation } from '../connect-client.js';
import { DEFAULT_MCP_URL } from '../env.js';
import { InteractiveRequiredError, NotLoggedInError, UsageError } from '../errors.js';
import type { HttpDeps } from '../http.js';
import { mcpConfigPath, undoMcpConfigWrite, writeRakomiMcpServerEntry } from '../mcp-config.js';
import type { SessionStore } from '../session.js';

export interface ConnectDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly cwd: string;
  readonly apiBaseUrl: string;
  readonly mcpUrl: string;
  readonly detectClaudeCode: () => boolean;
  readonly stdout: { write(s: string): void };
  readonly write: boolean;
  readonly dryRun: boolean;
  readonly ci: boolean;
  readonly undo: boolean;
  readonly explicitClient?: string;
  /** The connecting client's own CIMD client-metadata-document URL — user-supplied, never guessed. */
  readonly cimdUrl?: string;
  /** Re-check materialization/elevation status only — skips the `.mcp.json` write. */
  readonly status: boolean;
}

const CLAUDE_DESKTOP_INSTRUCTIONS = [
  'Claude Desktop connects to remote MCP servers through Connectors, configured from your Claude',
  'account rather than a local file — there is nothing for `rakomi connect` to write.',
  '',
  '1. Open Settings -> Connectors in Claude Desktop and add a custom connector.',
  `2. Enter Rakomi's MCP server URL: ${DEFAULT_MCP_URL}`,
  '3. Click Connect. Claude Desktop opens your browser at accounts.rakomi.com — sign in and',
  '   approve the read-only consent screen.',
].join('\n');

export async function runConnect(deps: ConnectDeps): Promise<void> {
  if (deps.undo) {
    const restored = undoMcpConfigWrite(deps.cwd);
    deps.stdout.write(
      restored
        ? `Restored ${mcpConfigPath(deps.cwd)} from the backup \`rakomi connect\` made.\n`
        : `No \`rakomi connect\` backup found at ${mcpConfigPath(deps.cwd)}.rakomi-backup — nothing to undo.\n`,
    );
    return;
  }

  const session = deps.session.read();
  if (!session) throw new NotLoggedInError();

  if (deps.status) {
    await reportStatus(deps, session.access_token);
    return;
  }

  let targets: readonly KnownClient[];
  try {
    targets = resolveTargetClients({ explicitClient: deps.explicitClient, claudeCodeDetected: deps.detectClaudeCode() });
  } catch (e) {
    if (e instanceof AmbiguousClientError) throw new UsageError(e.message);
    throw e;
  }

  for (const client of targets) {
    if (client === 'claude-desktop') {
      deps.stdout.write(`${clientDisplayName(client)}:\n${CLAUDE_DESKTOP_INSTRUCTIONS}\n`);
      continue;
    }
    await connectClaudeCode(deps, session.access_token);
  }
}

/** `--cimd-url` + `--status`: checks materialization (and elevation, if `--write`) without
 * rewriting `.mcp.json` — the resume path the CLI's waiting message points users at. */
async function reportStatus(deps: ConnectDeps, accessToken: string): Promise<void> {
  if (!deps.cimdUrl) {
    throw new UsageError('`connect --status` needs `--cimd-url <url>` — the CIMD URL `connect` printed when it started waiting.');
  }
  const row = await pollCimdMaterialization(deps, { apiBaseUrl: deps.apiBaseUrl, accessToken, cimdUrl: deps.cimdUrl });
  if (!row) {
    deps.stdout.write('Not connected yet — finish sign-in in your MCP client, then run this command again.\n');
    return;
  }
  deps.stdout.write(`Connected — access: ${row.agent_access.level}${row.agent_access.owner_granted ? ' (owner-granted)' : ''}.\n`);
  if (deps.write && row.agent_access.level !== 'write') {
    await requestWrite(deps, accessToken, row.id);
  }
}

async function connectClaudeCode(deps: ConnectDeps, accessToken: string): Promise<void> {
  if (deps.dryRun) {
    deps.stdout.write(`Would write ${mcpConfigPath(deps.cwd)} with mcpServers.rakomi -> ${deps.mcpUrl}. No file written (--dry-run).\n`);
    return;
  }
  const result = writeRakomiMcpServerEntry(deps.cwd, deps.mcpUrl);
  if (result.wrote) {
    deps.stdout.write(`Wrote ${mcpConfigPath(deps.cwd)}${result.backedUp ? ' (previous file backed up)' : ''}.\n${result.diff}\n`);
  } else {
    deps.stdout.write(`${result.diff}\n`);
  }

  deps.stdout.write(
    'Now open Claude Code and run `claude mcp login rakomi` to finish sign-in in your browser.\n' +
      'Once approved, Claude Code has READ access to your tenant immediately.\n',
  );

  if (!deps.cimdUrl) {
    deps.stdout.write(
      '\nOnce connected, Rakomi can confirm it and (with --write) request write access for you — pass ' +
        '`--cimd-url <url>` (find it in your MCP client\'s own connection diagnostics) to use it, or ' +
        'check the Agents page in the dashboard.\n',
    );
    return;
  }

  const row = await pollCimdMaterialization(deps, { apiBaseUrl: deps.apiBaseUrl, accessToken, cimdUrl: deps.cimdUrl });
  if (!row) {
    deps.stdout.write(
      `\nNot connected yet. Ctrl+C is safe — resume any time with:\n` +
        `  rakomi connect --status --cimd-url ${deps.cimdUrl}\n`,
    );
    return;
  }
  deps.stdout.write(`\nConnected — access: ${row.agent_access.level}.\n`);

  if (deps.write) {
    if (deps.ci) {
      throw new InteractiveRequiredError('`connect --write` cannot run under --ci — write-access needs a human owner decision.');
    }
    await requestWrite(deps, accessToken, row.id);
  }
}

async function requestWrite(deps: ConnectDeps, accessToken: string, oauthClientId: string): Promise<void> {
  await requestWriteElevation(deps, { apiBaseUrl: deps.apiBaseUrl, accessToken, oauthClientId });
  deps.stdout.write(
    "Write-access request sent to your tenant's owner(s) — if that's you, you'll approve it yourself " +
      'from the dashboard Agents page. Destructive actions will still ask a human every time.\n',
  );
}
