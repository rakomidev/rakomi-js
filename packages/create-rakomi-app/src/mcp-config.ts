// SPDX-License-Identifier: MIT

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CLIENT_REGISTRY, type ClientRegistryEntry } from './client-registry.generated.js';
import { CliError, EXIT } from './errors.js';

/**
 * The Rakomi MCP resource server's canonical URL. Byte-frozen: `https` scheme, lowercase host,
 * no port, the `/mcp` Streamable-HTTP mount path. Never hand-type this literal a second time —
 * import this constant.
 */
export const MCP_URL = 'https://mcp.rakomi.com/mcp';

function mustFindClient(id: string): ClientRegistryEntry {
  const entry = CLIENT_REGISTRY.find((c) => c.id === id);
  if (!entry) {
    throw new CliError(
      `client-registry.generated.ts is missing the "${id}" entry — run \`node scripts/gen-mcp-clients.mjs\` and commit the result.`,
      EXIT.FAIL,
    );
  }
  return entry;
}

/**
 * Claude Code's registry entry — the single source `mcpConfigJson()` and `agent-context.ts` derive
 * the `.mcp.json` shape and the connect `finishInstruction` from. Never hand-duplicate either;
 * import from here.
 */
export const CLAUDE_CODE_CLIENT: ClientRegistryEntry = mustFindClient('claude-code');

/** The `.mcp.json` top-level shape this module writes. */
export interface McpConfigJson {
  readonly mcpServers: {
    readonly rakomi: {
      readonly type: 'http';
      readonly url: string;
    };
  };
}

/**
 * The exact content written to `.mcp.json` — matches the shape `claude mcp add --transport http`
 * produces (topLevelKey `mcpServers`, remoteUrlField `url`, extraFields `{ type: "http" }`),
 * DERIVED from `CLAUDE_CODE_CLIENT.config` rather than a second hand-typed literal. No
 * `client_id` — CIMD discovery needs none.
 */
export function mcpConfigJson(): McpConfigJson {
  const config = CLAUDE_CODE_CLIENT.config;
  if (!config) {
    throw new CliError('The claude-code registry entry carries no config block.', EXIT.FAIL);
  }
  const rakomiEntry: Record<string, unknown> = { ...config.extraFields, [config.remoteUrlField]: MCP_URL };
  return { [config.topLevelKey]: { rakomi: rakomiEntry } } as unknown as McpConfigJson;
}

/**
 * Write `.mcp.json` into the freshly scaffolded project root. Always writes unconditionally — a
 * fresh quickstart template never ships its own `.mcp.json` (verified by
 * `test/mcp-config.test.ts`'s manifest scan), so there is nothing to merge and nothing to clobber.
 * Pretty-printed, LF-terminated, the same convention every other writer in this package uses
 * (`env.ts`'s `writeEnvFile`).
 */
export async function writeMcpConfig(targetDir: string): Promise<void> {
  await writeFile(join(targetDir, '.mcp.json'), JSON.stringify(mcpConfigJson(), null, 2) + '\n', 'utf8');
}
