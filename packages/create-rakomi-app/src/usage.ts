// SPDX-License-Identifier: MIT

import { loadTemplates, PORTAL_HOST, portalUrl } from './templates.js';

/** A stream the CLI writes to — injectable so tests capture output without real stdio. */
export interface OutputStream {
  write(text: string): void;
}

/** Supported invoking package managers, detected from `npm_config_user_agent`. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Detect the package manager that invoked the CLI from `npm_config_user_agent`
 * (e.g. "pnpm/9.0.0 npm/? node/v22 …"). Defaults to npm when unknown.
 */
export function detectPackageManager(userAgent: string | undefined): PackageManager {
  const head = (userAgent ?? '').split('/')[0]?.toLowerCase();
  if (head === 'pnpm' || head === 'yarn' || head === 'bun') return head;
  return 'npm';
}

/** The install command for a package manager. */
export function installCommand(pm: PackageManager): string {
  return pm === 'yarn' ? 'yarn' : `${pm} install`;
}

/** The dev/run command for a package manager. */
export function runCommand(pm: PackageManager): string {
  return pm === 'yarn' ? 'yarn dev' : `${pm} run dev`;
}

/** The full usage/help block, listing templates and prompts from the manifest. */
export function helpText(): string {
  const templates = loadTemplates();
  const list = templates.map((t) => `    ${t.slug.padEnd(8)} ${t.label}`).join('\n');
  return [
    'create-rakomi-app — scaffold a Rakomi quickstart app',
    '',
    'Usage:',
    '  npx create-rakomi-app@latest --template <slug> [directory]',
    '  npm create @rakomi/rakomi-app@latest -- --template <slug> [directory]',
    '',
    'Templates:',
    list,
    '',
    'Options:',
    '  --template <slug>        which quickstart to scaffold (required)',
    '  --region <value>         data region (default: eu-central)',
    '  --tenant-id <value>      your tenant id',
    '  --client-id <value>      your OAuth client_id (dashboard -> Integration -> Applications)',
    '  --template-source <url>  override the archive base (mirror / offline)',
    '  --yes                    accept defaults, never prompt (non-interactive)',
    '  --connect                print next steps for connecting an AI agent (the rakomi CLI)',
    "  --no-mcp                 don't scaffold .mcp.json / AGENTS.md (written by default — agent-ready on first run)",
    '  -h, --help               show this help and exit',
    '  -V, --version            print the version and exit',
    '',
    'Environment variables collected into the new project\'s .env:',
    '  RAKOMI_REGION, RAKOMI_TENANT_ID, RAKOMI_API_KEY, RAKOMI_CLIENT_ID',
    '  (RAKOMI_API_KEY is read from the prompt or the environment, never a flag,',
    '   and is written only to your local .env — never transmitted. RAKOMI_CLIENT_ID is',
    "   written under the target template's own convention, e.g. NEXT_PUBLIC_RAKOMI_CLIENT_ID.",
    '   Your tenant signup auto-provisions a default OAuth client for you — find its Client ID in',
    '   your Rakomi dashboard: Settings -> Development credentials.)',
    '',
    `After scaffolding, the next-step walkthrough lives at ${PORTAL_HOST}/quickstart/<slug>.`,
    '',
  ].join('\n');
}

/** Short usage line printed to stderr on a usage error. */
export function usageLine(): string {
  return 'Usage: npx create-rakomi-app@latest --template <slug> [directory] (see --help)';
}

/**
 * The post-install "Next steps" block: the portal walkthrough URL plus a numbered, package-
 * manager-aware command list. The install step is framed as the user's own next step that
 * depends on the public npm registry, not a guarantee. No color is emitted (NO_COLOR-safe by
 * construction) and the copy is stack-neutral so a tutorial can quote it verbatim.
 *
 * `mcpConfigWritten` (default `true`) reports whether `.mcp.json` + `AGENTS.md` were scaffolded
 * into the new project (they are, unless `--no-mcp` was passed) — when they were, one extra line
 * tells the user the project is already agent-ready and what to run to finish sign-in, plus a
 * pointer to AGENTS.md for a fuller briefing.
 */
export function postInstallMessage(slug: string, directory: string, pm: PackageManager, mcpConfigWritten = true): string {
  const lines = [
    '',
    `Done. Your Rakomi ${slug} app is ready in ${directory}`,
    '',
    'Next steps:',
    `  1. cd ${directory}`,
    `  2. ${installCommand(pm)}   (installs the Rakomi SDK from the public npm registry)`,
    `  3. ${runCommand(pm)}`,
    '',
  ];
  if (mcpConfigWritten) {
    lines.push(
      'Agent-ready: .mcp.json points Claude Code at the Rakomi MCP server — run `claude mcp login rakomi` to finish sign-in.',
      'See AGENTS.md for the full briefing any AI agent working in this project can read.',
      '',
    );
  }
  lines.push(`Walkthrough: ${portalUrl(slug)}`, '');
  return lines.join('\n');
}
