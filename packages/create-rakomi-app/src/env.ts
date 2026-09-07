// SPDX-License-Identifier: MIT

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TemplateSlug } from './templates.generated.js';

/**
 * Keys the scaffolder collects, in written order. Names follow `RAKOMI_[A-Z0-9_]+`.
 * `RAKOMI_CLIENT_SECRET`/`RAKOMI_REDIRECT_URI` are collected ONLY for the `node` template — see
 * `NODE_ONLY_KEYS` below; every other template's dev server never reads either.
 */
export const ENV_KEYS = [
  'RAKOMI_REGION',
  'RAKOMI_TENANT_ID',
  'RAKOMI_API_KEY',
  'RAKOMI_CLIENT_ID',
  'RAKOMI_CLIENT_SECRET',
  'RAKOMI_REDIRECT_URI',
] as const;
export type EnvKey = (typeof ENV_KEYS)[number];

/** The default EU region — a visible, overridable data-residency stance, not a mandate. */
export const DEFAULT_REGION = 'eu-central';

/** The node quickstart's own `.env.example` default — an OAuth client registered for local dev
 * typically has this exact redirect URI, so it doubles as a working starting point. */
export const DEFAULT_NODE_REDIRECT_URI = 'http://localhost:3000/callback';

/**
 * Keys whose value is a credential and must never be echoed to stdout / logs / summaries.
 * `RAKOMI_CLIENT_ID` is deliberately absent — an OAuth client_id is a PUBLIC, publishable
 * identifier (PKCE public clients ship it in bundled JS), not a secret.
 */
export const SECRET_KEYS = new Set<EnvKey>(['RAKOMI_API_KEY', 'RAKOMI_CLIENT_SECRET']);

/**
 * The `node` quickstart is the only template whose OWN server performs a confidential-client
 * OAuth code exchange (`examples/quickstarts/node/src/config.ts`) — `RAKOMI_REDIRECT_URI` is
 * REQUIRED there (`loadConfig()` throws a `ConfigError` at boot without it: the scaffolder used
 * to omit it entirely, so a freshly-scaffolded node app never started) and `RAKOMI_CLIENT_SECRET`
 * is read for the confidential-client case node's own README instructs the user to set up
 * (optional — an unset value degrades to a public/PKCE-only client, per that file's own comment).
 * Every browser-based template (nextjs/react/expo) drives its OAuth flow through `@rakomi/react`
 * client-side and never reads either var — collecting/writing them there would be a meaningless
 * prompt and a dead `.env` line for those templates.
 */
const NODE_ONLY_KEYS = new Set<EnvKey>(['RAKOMI_CLIENT_SECRET', 'RAKOMI_REDIRECT_URI']);

/** The keys actually relevant to a given template — `ENV_KEYS` minus the `node`-only keys for
 * every other template (or an absent/unknown slug — the conservative default), unchanged (full
 * set) for `node` itself. Drives both what the wizard prompts for (`prompt.ts`'s `collectEnv`)
 * and what `renderDotenv` writes. */
export function keysForTemplate(templateSlug: TemplateSlug | undefined): readonly EnvKey[] {
  if (templateSlug === 'node') return ENV_KEYS;
  return ENV_KEYS.filter((key) => !NODE_ONLY_KEYS.has(key));
}

/**
 * Every scaffolded template reads `RAKOMI_REGION` / `RAKOMI_TENANT_ID` / `RAKOMI_API_KEY` under
 * their canonical `RAKOMI_*` name — but each template's OWN `.env.example` names its OAuth
 * `client_id` differently, following that framework's inline-at-build-time convention:
 * Next.js `NEXT_PUBLIC_*`, Vite `VITE_*`, Expo `EXPO_PUBLIC_*`; a server-only Node app keeps the
 * plain `RAKOMI_*` form. Writing the collected value under the WRONG name means the app never
 * reads it and fails with a first-run "missing client" error despite a fully-filled `.env`
 * (the incident this mapping exists to close). See `examples/quickstarts/{slug}/.env.example`
 * for the source of truth this table mirrors.
 */
const CLIENT_ID_KEY_BY_TEMPLATE: Record<TemplateSlug, string> = {
  nextjs: 'NEXT_PUBLIC_RAKOMI_CLIENT_ID',
  react: 'VITE_RAKOMI_CLIENT_ID',
  expo: 'EXPO_PUBLIC_RAKOMI_CLIENT_ID',
  node: 'RAKOMI_CLIENT_ID',
};

/**
 * Resolve the `.env` key NAME a given canonical `EnvKey` must be written under for a specific
 * template. Only `RAKOMI_CLIENT_ID` varies by template today; every other key keeps its
 * canonical `RAKOMI_*` name across every template.
 */
export function envKeyNameForTemplate(templateSlug: TemplateSlug, key: EnvKey): string {
  if (key !== 'RAKOMI_CLIENT_ID') return key;
  return CLIENT_ID_KEY_BY_TEMPLATE[templateSlug] ?? key;
}

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
 * Render a full `.env` body from collected values. Always LF-terminated, one key per line, in
 * `ENV_KEYS` order restricted to `keysForTemplate(templateSlug)` — a key the given template never
 * reads is never written at all, rather than left as a dead empty assignment. A missing value for
 * a key the template DOES read is still written as an empty assignment so the file lists it for
 * the user to complete. Each key is written under the NAME the given template actually reads
 * (`envKeyNameForTemplate`) — not necessarily its canonical `RAKOMI_*` form.
 */
export function renderDotenv(values: Partial<Record<EnvKey, string>>, templateSlug: TemplateSlug): string {
  const lines = keysForTemplate(templateSlug).map((key) => dotenvLine(envKeyNameForTemplate(templateSlug, key), values[key] ?? ''));
  return lines.join('\n') + '\n';
}

/** Write the `.env` file into the target project directory. */
export async function writeEnvFile(
  targetDir: string,
  values: Partial<Record<EnvKey, string>>,
  templateSlug: TemplateSlug,
): Promise<void> {
  await writeFile(join(targetDir, '.env'), renderDotenv(values, templateSlug), 'utf8');
}
