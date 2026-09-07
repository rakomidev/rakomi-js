// SPDX-License-Identifier: MIT

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RAKOMI_SERVER_NAME } from './client-registry.generated.js';
import { ENV_KEYS } from './env.js';
import { CLAUDE_CODE_CLIENT, MCP_URL } from './mcp-config.js';

/** The agent-context filename this module writes, at the project root. */
export const AGENT_CONTEXT_FILENAME = 'AGENTS.md';

/**
 * `{{MCP_URL}}` and `{{SERVER_NAME}}` are the registry's own placeholder tokens (`mcp-clients.json`)
 * — substituted here, never baked into the generated module, so one registry entry serves every
 * environment's MCP URL. The scaffolder always writes the default server name, so that is what the
 * rendered instruction names. Mirrors `packages/cli/src/commands/connect.ts`'s helper and contract.
 */
function withMcpUrl(instruction: string, mcpUrl: string): string {
  return instruction.replaceAll('{{MCP_URL}}', mcpUrl).replaceAll('{{SERVER_NAME}}', RAKOMI_SERVER_NAME);
}

/**
 * Render `AGENTS.md`'s full body for a freshly scaffolded project. Pure and deterministic (no
 * timestamps, no random ids, no directory/template name) so the golden-content test can assert
 * byte-for-byte output regardless of which template or target directory the scaffold used.
 */
export function agentContextMarkdown(): string {
  const envKeyList = ENV_KEYS.map((k) => `\`${k}\``).join(', ');
  return (
    [
      '# Rakomi integration',
      '',
      'This project is wired to a Rakomi MCP server, so an AI coding agent working in this repository',
      'can read and manage this tenant on your behalf, once you connect it.',
      '',
      '## MCP server',
      '',
      `- URL: \`${MCP_URL}\``,
      '- Config: `.mcp.json` (already scaffolded in this project root)',
      '',
      '## Connect',
      '',
      withMcpUrl(CLAUDE_CODE_CLIENT.finishInstruction, MCP_URL),
      '',
      '## Credentials',
      '',
      `Tenant credentials live in \`.env\` (${envKeyList}) — never in this file, never in chat, and`,
      'never committed (`.env` is not tracked by version control). An agent reading this project',
      'should read values from `.env`, not ask you to paste them.',
      '',
      '## Ask your agent',
      '',
      '> "Connect to my Rakomi tenant using .mcp.json and show me my current users."',
      '',
    ].join('\n') + '\n'
  );
}

/**
 * Write `AGENTS.md` into the freshly scaffolded project root. Always writes unconditionally when
 * called (gated by the same `--no-mcp` opt-out as `.mcp.json` at the call site, `index.ts`) — a
 * fresh quickstart template never ships its own `AGENTS.md` (verified by
 * `test/agent-context.test.ts`'s manifest scan), so there is nothing to merge and nothing to
 * clobber. LF-terminated, the same convention every other writer in this package uses.
 */
export async function writeAgentContext(targetDir: string): Promise<void> {
  await writeFile(join(targetDir, AGENT_CONTEXT_FILENAME), agentContextMarkdown(), 'utf8');
}
