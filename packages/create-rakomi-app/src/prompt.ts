// SPDX-License-Identifier: MIT

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { DEFAULT_REGION, ENV_KEYS, type EnvKey, SECRET_KEYS } from './env.js';

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
];

/**
 * Resolve all env values by precedence: explicit flag > `RAKOMI_*` env var > interactive
 * prompt > documented default. Never prompts in non-interactive mode (so a CI pipe never
 * hangs); there it falls back to env/flag/default, leaving the rest empty for the user.
 * Secret values are never echoed back.
 */
export async function collectEnv(deps: PromptDeps): Promise<Partial<Record<EnvKey, string>>> {
  const out: Partial<Record<EnvKey, string>> = {};
  for (const field of FIELDS) {
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
  const dflt = field.defaultValue !== undefined ? ` [${field.defaultValue}]` : '';
  return `${field.label}${secret}${dflt}: `;
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
