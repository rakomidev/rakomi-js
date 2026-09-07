// SPDX-License-Identifier: MIT

import type { ClientRegistryEntry, KnownClient } from '../clients.js';
import { AmbiguousClientError, clientRegistryEntry, resolveTargetClients } from '../clients.js';
import { pollCimdMaterialization, requestWriteElevation } from '../connect-client.js';
import { InteractiveRequiredError, NotLoggedInError, UsageError } from '../errors.js';
import type { HttpDeps } from '../http.js';
import { resolveDpopKey } from '../install-key.js';
import {
  backupSuffixFor,
  clientConfigPath,
  RAKOMI_SERVER_NAME,
  undoClientConfigWrite,
  writeClientMcpConfigEntry,
} from '../mcp-config.js';
import { resolveServerName } from '../server-name.js';
import type { KeyStore, SessionStore, StoredSession } from '../session.js';
import { undoClientTomlConfigWrite, writeClientTomlConfigEntry } from '../toml-config.js';

export interface ConnectDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  readonly cwd: string;
  /** Resolves a `scope: 'user'` written client's config path (Codex CLI, Devin Desktop) — `os.homedir()` at the real CLI entrypoint, a tmp dir in tests. */
  readonly homeDir: string;
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
  /** Re-check materialization/elevation status only — skips any config write. */
  readonly status: boolean;
  /** `--name <server-name>` — the config key the entry is written under; validated before any
   * write, defaults to the registry's server name when absent. */
  readonly serverName?: string;
}

/** `{{MCP_URL}}` / `{{SERVER_NAME}}` are the registry's own placeholder tokens (`mcp-clients.json`)
 * — substituted here, never baked into the generated module, so one registry entry serves every
 * environment's `mcpUrl` and every project's chosen server name. */
function renderInstruction(instruction: string, mcpUrl: string, serverName: string): string {
  return instruction.replaceAll('{{MCP_URL}}', mcpUrl).replaceAll('{{SERVER_NAME}}', serverName);
}

function resolveSingleTargetClient(deps: Pick<ConnectDeps, 'explicitClient' | 'detectClaudeCode'>): ClientRegistryEntry {
  let targets: readonly KnownClient[];
  try {
    targets = resolveTargetClients({ explicitClient: deps.explicitClient, claudeCodeDetected: deps.detectClaudeCode() });
  } catch (e) {
    if (e instanceof AmbiguousClientError) throw new UsageError(e.message);
    throw e;
  }
  return clientRegistryEntry(targets[0] as KnownClient);
}

export async function runConnect(deps: ConnectDeps): Promise<void> {
  const serverName = resolveServerName(deps.serverName);

  if (deps.undo) {
    runUndo(deps, serverName);
    return;
  }

  const session = deps.session.read();
  if (!session) throw new NotLoggedInError();

  if (deps.status) {
    await reportStatus(deps, session);
    return;
  }

  let targets: readonly KnownClient[];
  try {
    targets = resolveTargetClients({ explicitClient: deps.explicitClient, claudeCodeDetected: deps.detectClaudeCode() });
  } catch (e) {
    if (e instanceof AmbiguousClientError) throw new UsageError(e.message);
    throw e;
  }

  for (const clientId of targets) {
    const client = clientRegistryEntry(clientId);
    if (client.tier === 'instructed') {
      deps.stdout.write(`${client.displayName}:\n${renderInstruction(client.finishInstruction, deps.mcpUrl, serverName)}\n`);
      continue;
    }
    if (clientId === 'claude-code') {
      await connectClaudeCode(deps, session, client, serverName);
    } else {
      connectGenericWrittenClient(deps, client, serverName);
    }
  }
}

function runUndo(deps: ConnectDeps, serverName: string): void {
  const client = resolveSingleTargetClient(deps);
  if (!client.config) {
    deps.stdout.write(`${client.displayName} writes no config file — nothing to undo.\n`);
    return;
  }
  const path = clientConfigPath(client, deps.cwd, deps.homeDir);
  const restored =
    client.config.serialization === 'toml'
      ? undoClientTomlConfigWrite(client, deps.cwd, deps.homeDir, serverName)
      : undoClientConfigWrite(client, deps.cwd, deps.homeDir, serverName);
  deps.stdout.write(
    restored
      ? `Restored ${path} from the backup \`rakomi connect\` made.\n`
      : `No \`rakomi connect\` backup found at ${path}${backupSuffixFor(serverName)} — nothing to undo.\n`,
  );
}

/** `--cimd-url` + `--status`: checks materialization (and elevation, if `--write`) without
 * rewriting any config file — the resume path the CLI's waiting message points users at. */
async function reportStatus(deps: ConnectDeps, session: StoredSession): Promise<void> {
  if (!deps.cimdUrl) {
    throw new UsageError('`connect --status` needs `--cimd-url <url>` — the CIMD URL `connect` printed when it started waiting.');
  }
  const dpop = resolveDpopKey(deps.keys, session);
  const row = await pollCimdMaterialization(deps, {
    apiBaseUrl: deps.apiBaseUrl,
    accessToken: session.access_token,
    cimdUrl: deps.cimdUrl,
    dpop,
  });
  if (!row) {
    deps.stdout.write('Not connected yet — finish sign-in in your MCP client, then run this command again.\n');
    return;
  }
  deps.stdout.write(`Connected — access: ${row.agent_access.level}${row.agent_access.owner_granted ? ' (owner-granted)' : ''}.\n`);
  if (deps.write && row.agent_access.level !== 'write') {
    await requestWrite(deps, session, row.id);
  }
}

function writeSummary(
  deps: ConnectDeps,
  result: { readonly wrote: boolean; readonly backedUp: boolean; readonly diff: string; readonly path: string },
): void {
  if (result.wrote) {
    deps.stdout.write(`Wrote ${result.path}${result.backedUp ? ' (previous file backed up)' : ''}.\n${result.diff}\n`);
  } else {
    deps.stdout.write(`${result.diff}\n`);
  }
}

/**
 * Printed once, after a successful write under the DEFAULT name — the moment a second project on
 * the same machine becomes a question. MCP clients keep one sign-in per server name, so a project
 * bound to another workspace needs its own; the client's own login command is named only for the
 * client the registry marks as Claude Code, every other client signs in its own way.
 */
function secondWorkspaceHint(client: ClientRegistryEntry, explicitClient: string | undefined): string {
  const example = `${RAKOMI_SERVER_NAME}-<workspace>`;
  const clientFlag = explicitClient ? ` --client ${explicitClient}` : '';
  const where = client.config?.scope === 'user' ? '' : ' in that project';
  const login = client.id === 'claude-code' ? `, then \`claude mcp login ${example}\`` : ', then sign in under that name';
  return (
    `\nTip: another project on this machine bound to a different workspace? Sign-ins are kept per server ` +
    `name, so give it its own: run \`rakomi connect${clientFlag} --name ${example}\`${where}${login}.\n`
  );
}

async function connectClaudeCode(deps: ConnectDeps, session: StoredSession, client: ClientRegistryEntry, serverName: string): Promise<void> {
  const path = clientConfigPath(client, deps.cwd, deps.homeDir);
  if (deps.dryRun) {
    deps.stdout.write(`Would write ${path} with ${client.config!.topLevelKey}.${serverName} -> ${deps.mcpUrl}. No file written (--dry-run).\n`);
    return;
  }
  const result = writeClientMcpConfigEntry(client, deps.cwd, deps.homeDir, deps.mcpUrl, serverName);
  writeSummary(deps, result);

  deps.stdout.write(
    `${renderInstruction(client.finishInstruction, deps.mcpUrl, serverName)}\n` +
      'Once approved, Claude Code has READ access to your tenant immediately.\n',
  );
  if (result.wrote && serverName === RAKOMI_SERVER_NAME) {
    deps.stdout.write(secondWorkspaceHint(client, deps.explicitClient));
  }

  if (!deps.cimdUrl) {
    deps.stdout.write(
      '\nOnce connected, Rakomi can confirm it and (with --write) request write access for you — pass ' +
        '`--cimd-url <url>` (find it in your MCP client\'s own connection diagnostics) to use it, or ' +
        'check the Agents page in the dashboard.\n',
    );
    return;
  }

  const dpop = resolveDpopKey(deps.keys, session);
  const row = await pollCimdMaterialization(deps, {
    apiBaseUrl: deps.apiBaseUrl,
    accessToken: session.access_token,
    cimdUrl: deps.cimdUrl,
    dpop,
  });
  if (!row) {
    const nameFlag = serverName === RAKOMI_SERVER_NAME ? '' : ` --name ${serverName}`;
    deps.stdout.write(
      `\nNot connected yet. Ctrl+C is safe — resume any time with:\n` +
        `  rakomi connect --status${nameFlag} --cimd-url ${deps.cimdUrl}\n`,
    );
    return;
  }
  deps.stdout.write(`\nConnected — access: ${row.agent_access.level}.\n`);

  if (deps.write) {
    if (deps.ci) {
      throw new InteractiveRequiredError('`connect --write` cannot run under --ci — write-access needs a human owner decision.');
    }
    await requestWrite(deps, session, row.id);
  }
}

/** Every written client but Claude Code: write the config, print the finish instruction. No CIMD
 * confirm/write-elevation dance yet (see this file's header) — a plain, correctly-shaped write. */
function connectGenericWrittenClient(deps: ConnectDeps, client: ClientRegistryEntry, serverName: string): void {
  const path = clientConfigPath(client, deps.cwd, deps.homeDir);
  if (deps.dryRun) {
    deps.stdout.write(`Would write ${path} with ${client.config!.topLevelKey}.${serverName} -> ${deps.mcpUrl}. No file written (--dry-run).\n`);
    return;
  }
  const result =
    client.config!.serialization === 'toml'
      ? writeClientTomlConfigEntry(client, deps.cwd, deps.homeDir, deps.mcpUrl, serverName)
      : writeClientMcpConfigEntry(client, deps.cwd, deps.homeDir, deps.mcpUrl, serverName);
  writeSummary(deps, result);
  deps.stdout.write(`${renderInstruction(client.finishInstruction, deps.mcpUrl, serverName)}\n`);
  if (result.wrote && serverName === RAKOMI_SERVER_NAME) {
    deps.stdout.write(secondWorkspaceHint(client, deps.explicitClient));
  }
}

async function requestWrite(deps: ConnectDeps, session: StoredSession, oauthClientId: string): Promise<void> {
  const dpop = resolveDpopKey(deps.keys, session);
  await requestWriteElevation(deps, { apiBaseUrl: deps.apiBaseUrl, accessToken: session.access_token, oauthClientId, dpop });
  deps.stdout.write(
    "Write-access request sent to your tenant's owner(s) — if that's you, you'll approve it yourself " +
      'from the dashboard Agents page. Destructive actions will still ask a human every time.\n',
  );
}
