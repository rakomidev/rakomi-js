// SPDX-License-Identifier: MIT

import type { CiOidcEnv } from '../ci-oidc-token.js';
import { resolveCiOidcToken } from '../ci-oidc-token.js';
import { generateEphemeralDpopKey } from '../dpop.js';
import { apiBaseUrl, CI_FEDERATION_SESSION_CLIENT_ID, type CliEnv, DEFAULT_MCP_URL } from '../env.js';
import type { HttpDeps } from '../http.js';
import { getOrCreateInstallKey, peekInstallKey, persistInstallKey, type StoredInstallKey } from '../install-key.js';
import { listMcpToolsCi, MCP_RESOURCE, type McpToolListEntry } from '../mcp-tools-ci.js';
import { exchangeOidcSubjectToken } from '../oidc-federation-login.js';
import type { KeyStore } from '../session.js';

export interface McpToolsCiDeps extends HttpDeps {
  readonly env: CliEnv;
  readonly ciEnv: CiOidcEnv;
  readonly keys: KeyStore;
  readonly oidcTokenFile?: string;
  readonly readTextFile: (path: string) => string;
  readonly json: boolean;
  readonly stdout: { write(s: string): void };
}

function hintLine(t: McpToolListEntry): string {
  const hints: string[] = [];
  if (t.annotations?.readOnlyHint) hints.push('read-only');
  if (t.annotations?.idempotentHint) hints.push('idempotent');
  return hints.length > 0 ? ` (${hints.join(', ')})` : '';
}

/**
 * `rakomi mcp tools --ci` — resolves the runner's own OIDC identity, exchanges it for an
 * `mcp:tools:read`-scoped, DPoP-bound Rakomi access token bound to the MCP resource, and lists
 * the tools that token may invoke. Shares the durable per-job DPoP key `login --ci` uses
 * (`CI_FEDERATION_SESSION_CLIENT_ID`) so a job running BOTH commands proves possession with the
 * same keypair throughout — but generates its own if this is the first federation call in the job.
 */
export async function runMcpToolsCi(deps: McpToolsCiDeps): Promise<void> {
  const apiUrl = apiBaseUrl(deps.env);
  const mcpUrl = deps.env.RAKOMI_API_URL ? `${apiUrl}/mcp` : DEFAULT_MCP_URL;

  const subjectToken = await resolveCiOidcToken(deps, {
    env: deps.ciEnv,
    oidcTokenFile: deps.oidcTokenFile,
    readTextFile: deps.readTextFile,
    audience: MCP_RESOURCE,
  });

  const existingKey = peekInstallKey(deps.keys, CI_FEDERATION_SESSION_CLIENT_ID);
  const dpopKey: StoredInstallKey =
    existingKey ?? { clientId: CI_FEDERATION_SESSION_CLIENT_ID, ...generateEphemeralDpopKey(), confirmedBound: false };

  const token = await exchangeOidcSubjectToken(deps, {
    apiBaseUrl: apiUrl,
    subjectToken,
    resource: MCP_RESOURCE,
    dpopKey,
  });
  if (!existingKey) persistInstallKey(deps.keys, dpopKey);

  const resolvedKey = getOrCreateInstallKey(deps.keys, CI_FEDERATION_SESSION_CLIENT_ID);

  const tools = await listMcpToolsCi(deps, { mcpUrl, accessToken: token.access_token, dpopKey: resolvedKey });

  if (deps.json) {
    deps.stdout.write(JSON.stringify({ tools }) + '\n');
    return;
  }
  if (tools.length === 0) {
    deps.stdout.write('No MCP tools visible to this CI identity.\n');
    return;
  }
  deps.stdout.write(tools.map((t) => `${t.name}${hintLine(t)} — ${t.description}`).join('\n') + '\n');
}
