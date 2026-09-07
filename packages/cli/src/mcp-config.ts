// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ClientRegistryEntry } from './client-registry.generated.js';
import { RAKOMI_SERVER_NAME } from './client-registry.generated.js';
import { CliError, EXIT } from './errors.js';

export { RAKOMI_SERVER_NAME };

/**
 * The backup a write makes is keyed by the server NAME it wrote, so `--undo --name <x>` restores
 * the file as it was before `<x>` was written even when another name was written since. The
 * default name yields the historical `.rakomi-backup` suffix byte-for-byte.
 */
export function backupSuffixFor(serverName: string): string {
  return `.${serverName}-backup`;
}

export const BACKUP_SUFFIX = backupSuffixFor(RAKOMI_SERVER_NAME);

/** A generic client config file — top-level keys are whatever that client's own doc calls them. */
export interface ClientJsonConfig {
  [key: string]: unknown;
}

/** Read a file's text, or `null` when it does not exist — one syscall, no check-then-act window. */
function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The absolute path this client's config file lives at — `client.config.pathTemplate` resolved
 * against the project directory (scope 'project') or the caller's home directory (scope 'user').
 * Throws for an instructed-tier client (`client.config` is absent by registry construction —
 * `mcp-client-registry.mjs`'s validator refuses the opposite shape) — there is nothing to write.
 */
export function clientConfigPath(client: ClientRegistryEntry, cwd: string, homeDir: string): string {
  if (!client.config) {
    throw new CliError(`clientConfigPath: '${client.id}' is instructed-tier — it has no config file to write`, EXIT.FAIL);
  }
  const base = client.config.scope === 'user' ? homeDir : cwd;
  return join(base, client.config.pathTemplate);
}

function backupPath(configPath: string, serverName: string): string {
  return `${configPath}${backupSuffixFor(serverName)}`;
}

function readJsonConfig(path: string): ClientJsonConfig {
  const text = readIfPresent(path);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as ClientJsonConfig;
    return {};
  } catch {
    return {};
  }
}

function shallowEqualStringRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

export interface MergeResult {
  readonly config: ClientJsonConfig;
  readonly changed: boolean;
  readonly previousEntry: Record<string, unknown> | undefined;
}

/**
 * Pure merge — the server entry (`serverName`, the default `rakomi` unless `--name` chose another)
 * is added/overwritten under THIS client's own top-level key and remote-URL field name; every
 * sibling entry under that key — including a Rakomi entry under a DIFFERENT name — and every other
 * top-level key in the file, is preserved untouched — a user's config we did not create keeps its
 * own content.
 */
export function mergeClientServerEntry(
  config: ClientJsonConfig,
  client: ClientRegistryEntry,
  mcpUrl: string,
  serverName: string = RAKOMI_SERVER_NAME,
): MergeResult {
  if (!client.config || client.config.serialization !== 'json') {
    throw new CliError(`mergeClientServerEntry: '${client.id}' is not a JSON-shaped written client`, EXIT.FAIL);
  }
  const { topLevelKey, remoteUrlField, extraFields } = client.config;
  const bucket = (config[topLevelKey] as Record<string, unknown> | undefined) ?? {};
  const previousEntry = bucket[serverName] as Record<string, unknown> | undefined;
  const nextEntry: Record<string, unknown> = { ...extraFields, [remoteUrlField]: mcpUrl };
  const alreadyIdentical = previousEntry !== undefined && shallowEqualStringRecord(previousEntry, nextEntry);
  if (alreadyIdentical) return { config, changed: false, previousEntry };

  const merged: ClientJsonConfig = {
    ...config,
    [topLevelKey]: { ...bucket, [serverName]: nextEntry },
  };
  return { config: merged, changed: true, previousEntry };
}

export interface WriteMcpConfigResult {
  readonly wrote: boolean;
  readonly backedUp: boolean;
  readonly diff: string;
  readonly path: string;
}

/**
 * Read -> merge -> (if changed) back up the ORIGINAL file, then write the merged config. Returns a
 * human-readable one-line diff for the printed summary. Never writes if nothing changed (idempotent
 * re-run of `connect`). Creates the config file's parent directory if it doesn't exist yet (several
 * written clients use a subdirectory — `.vscode/`, `.cursor/`, `.agents/`, `.gemini/`, `.zed/` —
 * unlike Claude Code's `.mcp.json`, which sits directly in the project root).
 */
export function writeClientMcpConfigEntry(
  client: ClientRegistryEntry,
  cwd: string,
  homeDir: string,
  mcpUrl: string,
  serverName: string = RAKOMI_SERVER_NAME,
): WriteMcpConfigResult {
  const path = clientConfigPath(client, cwd, homeDir);
  const before = readJsonConfig(path);
  const { config: after, changed, previousEntry } = mergeClientServerEntry(before, client, mcpUrl, serverName);

  if (!changed) {
    return { wrote: false, backedUp: false, diff: `${serverName} already configured with ${mcpUrl} — no change.`, path };
  }

  let backedUp = false;
  const existing = readIfPresent(path);
  if (existing !== null) {
    writeFileSync(backupPath(path, serverName), existing);
    backedUp = true;
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, JSON.stringify(after, null, 2) + '\n');

  const topLevelKey = client.config!.topLevelKey;
  const nowEntry = (after[topLevelKey] as Record<string, unknown>)[serverName];
  const diff = previousEntry
    ? `${topLevelKey}.${serverName}: ${JSON.stringify(previousEntry)} -> ${JSON.stringify(nowEntry)}`
    : `${topLevelKey}.${serverName}: (added) ${JSON.stringify(nowEntry)}`;
  return { wrote: true, backedUp, diff, path };
}

/** `--undo` — restore the backup this-or-a-prior `connect` run made for `serverName`. No-op
 * (returns false) if none exists. */
export function undoClientConfigWrite(
  client: ClientRegistryEntry,
  cwd: string,
  homeDir: string,
  serverName: string = RAKOMI_SERVER_NAME,
): boolean {
  const path = clientConfigPath(client, cwd, homeDir);
  const backup = readIfPresent(backupPath(path, serverName));
  if (backup === null) return false;
  writeFileSync(path, backup);
  return true;
}
