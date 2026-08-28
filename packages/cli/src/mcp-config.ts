// SPDX-License-Identifier: MIT

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RAKOMI_SERVER_NAME = 'rakomi';
const BACKUP_SUFFIX = '.rakomi-backup';

export interface McpServerEntry {
  readonly type: 'http';
  readonly url: string;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry | Record<string, unknown>>;
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

export function mcpConfigPath(projectDir: string): string {
  return join(projectDir, '.mcp.json');
}

function backupPath(configPath: string): string {
  return `${configPath}${BACKUP_SUFFIX}`;
}

function readConfig(path: string): McpConfig {
  const text = readIfPresent(path);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as McpConfig;
    return {};
  } catch {
    return {};
  }
}

export interface MergeResult {
  readonly config: McpConfig;
  readonly changed: boolean;
  readonly previousEntry: McpServerEntry | Record<string, unknown> | undefined;
}

/** Pure merge — `rakomi` server entry added/overwritten, every other key preserved untouched. */
export function mergeRakomiServerEntry(config: McpConfig, mcpUrl: string): MergeResult {
  const previousEntry = config.mcpServers?.[RAKOMI_SERVER_NAME];
  const nextEntry: McpServerEntry = { type: 'http', url: mcpUrl };
  const alreadyIdentical =
    previousEntry !== undefined &&
    typeof previousEntry === 'object' &&
    (previousEntry as McpServerEntry).type === 'http' &&
    (previousEntry as McpServerEntry).url === mcpUrl;
  if (alreadyIdentical) return { config, changed: false, previousEntry };

  const merged: McpConfig = {
    ...config,
    mcpServers: { ...(config.mcpServers ?? {}), [RAKOMI_SERVER_NAME]: nextEntry },
  };
  return { config: merged, changed: true, previousEntry };
}

export interface WriteMcpConfigResult {
  readonly wrote: boolean;
  readonly backedUp: boolean;
  readonly diff: string;
}

/**
 * Read → merge → (if changed) back up the ORIGINAL file, then write the merged config. Returns a
 * human-readable one-line diff for the printed summary. Never writes if nothing changed
 * (idempotent re-run of `connect`).
 */
export function writeRakomiMcpServerEntry(projectDir: string, mcpUrl: string): WriteMcpConfigResult {
  const path = mcpConfigPath(projectDir);
  const before = readConfig(path);
  const { config: after, changed, previousEntry } = mergeRakomiServerEntry(before, mcpUrl);

  if (!changed) {
    return { wrote: false, backedUp: false, diff: `${RAKOMI_SERVER_NAME} already configured with ${mcpUrl} — no change.` };
  }

  let backedUp = false;
  const existing = readIfPresent(path);
  if (existing !== null) {
    writeFileSync(backupPath(path), existing);
    backedUp = true;
  }
  writeFileSync(path, JSON.stringify(after, null, 2) + '\n');

  const diff = previousEntry
    ? `mcpServers.${RAKOMI_SERVER_NAME}: ${JSON.stringify(previousEntry)} -> ${JSON.stringify(after.mcpServers?.[RAKOMI_SERVER_NAME])}`
    : `mcpServers.${RAKOMI_SERVER_NAME}: (added) ${JSON.stringify(after.mcpServers?.[RAKOMI_SERVER_NAME])}`;
  return { wrote: true, backedUp, diff };
}

/** `--undo` — restore the backup this-or-a-prior `connect` run made. No-op (returns false) if none exists. */
export function undoMcpConfigWrite(projectDir: string): boolean {
  const path = mcpConfigPath(projectDir);
  const backup = readIfPresent(backupPath(path));
  if (backup === null) return false;
  writeFileSync(path, backup);
  return true;
}
