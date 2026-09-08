// SPDX-License-Identifier: MIT

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { DEFAULT_NODE_REDIRECT_URI, DEFAULT_REGION, ENV_KEYS, type EnvKey, keysForTemplate, SECRET_KEYS } from './env.js';
import type { TemplateSlug } from './templates.generated.js';

/** Streams and environment the collector reads — injectable so tests run without a real TTY. */
export interface PromptDeps {
  /** Explicit flag values (highest precedence). */
  readonly flags: Partial<Record<EnvKey, string>>;
  /** The process environment to read `RAKOMI_*` from (second precedence). */
  readonly env: Record<string, string | undefined>;
  /** Whether the run is interactive (a TTY, not CI, not `--yes`). */
  readonly interactive: boolean;
  /** Async prompt used only in interactive mode; returns the typed answer. */
  readonly ask?: (question: string) => Promise<string>;
}

/** A documented prompt for one key: label shown to the user and its default (if any). */
interface FieldSpec {
  readonly key: EnvKey;
  readonly label: string;
  readonly defaultValue?: string;
}

export const FIELDS: readonly FieldSpec[] = [
  { key: 'RAKOMI_REGION', label: 'Data region', defaultValue: DEFAULT_REGION },
  { key: 'RAKOMI_TENANT_ID', label: 'Tenant ID' },
  { key: 'RAKOMI_API_KEY', label: 'API key' },
  { key: 'RAKOMI_CLIENT_ID', label: 'OAuth Client ID' },
  { key: 'RAKOMI_CLIENT_SECRET', label: 'OAuth Client Secret (leave blank for a public/PKCE-only client)' },
  { key: 'RAKOMI_REDIRECT_URI', label: 'Redirect URI', defaultValue: DEFAULT_NODE_REDIRECT_URI },
];

/**
 * Extra guidance appended to a field's prompt line — where to GET a value the wizard cannot
 * derive on its own. Only `RAKOMI_CLIENT_ID` needs this today: every tenant signup auto-provisions
 * a default OAuth client at creation time, so the value already exists — find it rather than
 * create it.
 */
const FIELD_HINTS: Partial<Record<EnvKey, string>> = {
  RAKOMI_CLIENT_ID: 'from your Rakomi dashboard -> Settings -> Development credentials',
};

/**
 * Resolve all env values by precedence: explicit flag > `RAKOMI_*` env var > interactive
 * prompt > documented default. Never prompts in non-interactive mode (so a CI pipe never
 * hangs); there it falls back to env/flag/default, leaving the rest empty for the user.
 * Secret values are never echoed back. `templateSlug` restricts which fields are even asked
 * about — a key the given template never reads (see `keysForTemplate`) is skipped entirely,
 * never prompted for and never present in the returned object; optional so every pre-existing
 * caller/fixture (which meant "every canonical key applies") keeps compiling and behaving
 * unchanged.
 */
export async function collectEnv(deps: PromptDeps, templateSlug?: TemplateSlug): Promise<Partial<Record<EnvKey, string>>> {
  const relevant = new Set(keysForTemplate(templateSlug));
  const out: Partial<Record<EnvKey, string>> = {};
  for (const field of FIELDS) {
    if (!relevant.has(field.key)) continue;
    const fromFlag = deps.flags[field.key];
    if (fromFlag !== undefined && fromFlag !== '') {
      out[field.key] = fromFlag;
      continue;
    }
    const fromEnv = deps.env[field.key];
    if (fromEnv !== undefined && fromEnv !== '') {
      out[field.key] = fromEnv;
      continue;
    }
    if (deps.interactive && deps.ask) {
      const answer = (await deps.ask(promptText(field))).trim();
      out[field.key] = answer !== '' ? answer : (field.defaultValue ?? '');
      continue;
    }
    if (field.defaultValue !== undefined) out[field.key] = field.defaultValue;
  }
  return out;
}

function promptText(field: FieldSpec): string {
  const secret = SECRET_KEYS.has(field.key) ? ' (kept local, never sent anywhere)' : '';
  const hint = FIELD_HINTS[field.key] ? ` (${FIELD_HINTS[field.key]})` : '';
  const dflt = field.defaultValue !== undefined ? ` [${field.defaultValue}]` : '';
  return `${field.label}${secret}${hint}${dflt}: `;
}

/** A real-TTY prompt backed by `node:readline/promises`. */
export function createTtyAsk(): (question: string) => Promise<string> {
  return async (question: string) => {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

/** All keys, in written order — re-exported for the orchestrator. */
export { ENV_KEYS };
