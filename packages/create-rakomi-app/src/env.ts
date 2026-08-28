// SPDX-License-Identifier: MIT

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Keys the scaffolder collects, in written order. Names follow `RAKOMI_[A-Z0-9_]+`. */
export const ENV_KEYS = ['RAKOMI_REGION', 'RAKOMI_TENANT_ID', 'RAKOMI_API_KEY'] as const;
export type EnvKey = (typeof ENV_KEYS)[number];

/** The default EU region — a visible, overridable data-residency stance, not a mandate. */
export const DEFAULT_REGION = 'eu-central';

/** Keys whose value is a credential and must never be echoed to stdout / logs / summaries. */
export const SECRET_KEYS = new Set<EnvKey>(['RAKOMI_API_KEY']);

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Serialise a single `KEY=value` line in canonical dotenv form:
 * - control characters (incl. CR/LF) are stripped from the value first;
 * - no `export ` prefix, no inline comment;
 * - the value is double-quoted only when it contains whitespace, `#` or `"`.
 */
export function dotenvLine(key: string, rawValue: string): string {
  const value = rawValue.replace(CONTROL_CHARS, '');
  const needsQuote = /[\s#"]/.test(value);
  if (!needsQuote) return `${key}=${value}`;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

/**
 * Render a full `.env` body from collected values. Always LF-terminated, one key per line,
 * in `ENV_KEYS` order. A missing value is written as an empty assignment so the file lists
 * every key for the user to complete.
 */
export function renderDotenv(values: Partial<Record<EnvKey, string>>): string {
  const lines = ENV_KEYS.map((key) => dotenvLine(key, values[key] ?? ''));
  return lines.join('\n') + '\n';
}

/** Write the `.env` file into the target project directory. */
export async function writeEnvFile(targetDir: string, values: Partial<Record<EnvKey, string>>): Promise<void> {
  await writeFile(join(targetDir, '.env'), renderDotenv(values), 'utf8');
}
