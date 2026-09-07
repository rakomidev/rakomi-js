// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ClientRegistryEntry } from './client-registry.generated.js';
import { CliError, EXIT } from './errors.js';
import { backupSuffixFor, clientConfigPath, RAKOMI_SERVER_NAME } from './mcp-config.js';

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function backupPath(configPath: string, serverName: string): string {
  return `${configPath}${backupSuffixFor(serverName)}`;
}

/** A bare TOML basic string — double-quoted, backslash-escaped. Values here are always ASCII URLs
 * or simple identifiers, so JSON's string escaping is a byte-identical superset of what TOML needs. */
function tomlBasicString(value: string): string {
  return JSON.stringify(value);
}

function renderTomlBlockLines(header: string, fields: Readonly<Record<string, string>>): string[] {
  const lines = [`[${header}]`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key} = ${tomlBasicString(value)}`);
  }
  return lines;
}

export interface TomlMergeResult {
  readonly text: string;
  readonly changed: boolean;
  readonly previousBlock: string | undefined;
}

/**
 * Pure merge over a TOML file's TEXT — finds `[<topLevelKey>.<serverName>]` by its header line, replaces
 * only the lines up to (not including) the next `[`-starting line or EOF, and leaves everything else
 * byte-identical. Appends a new table at the end (with a blank-line separator) when absent.
 */
export function mergeTomlServerTable(
  text: string,
  client: ClientRegistryEntry,
  mcpUrl: string,
  serverName: string = RAKOMI_SERVER_NAME,
): TomlMergeResult {
  if (!client.config || client.config.serialization !== 'toml') {
    throw new CliError(`mergeTomlServerTable: '${client.id}' is not a TOML-shaped written client`, EXIT.FAIL);
  }
  const header = `${client.config.topLevelKey}.${serverName}`;
  const fields: Record<string, string> = { ...client.config.extraFields, [client.config.remoteUrlField]: mcpUrl };
  const newBlockLines = renderTomlBlockLines(header, fields);
  const newBlockText = newBlockLines.join('\n');

  const lines = text.length > 0 ? text.split('\n') : [];
  const headerLine = `[${header}]`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === headerLine) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    const needsSeparator = lines.length > 0 && lines[lines.length - 1] !== '';
    const prefix = needsSeparator ? [...lines, ''] : lines;
    const nextLines = [...prefix, ...newBlockLines, ''];
    return { text: nextLines.join('\n'), changed: true, previousBlock: undefined };
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  let blockEnd = end;
  while (blockEnd > start + 1 && lines[blockEnd - 1] === '') blockEnd--;
  const previousBlock = lines.slice(start, blockEnd).join('\n');

  if (previousBlock === newBlockText) {
    return { text, changed: false, previousBlock };
  }
  const nextLines = [...lines.slice(0, start), ...newBlockLines, ...lines.slice(end)];
  return { text: nextLines.join('\n'), changed: true, previousBlock };
}

export interface WriteTomlConfigResult {
  readonly wrote: boolean;
  readonly backedUp: boolean;
  readonly diff: string;
  readonly path: string;
}

/** Same read -> merge -> backup-before-write -> write contract as `mcp-config.ts`'s JSON writer. */
export function writeClientTomlConfigEntry(
  client: ClientRegistryEntry,
  cwd: string,
  homeDir: string,
  mcpUrl: string,
  serverName: string = RAKOMI_SERVER_NAME,
): WriteTomlConfigResult {
  const path = clientConfigPath(client, cwd, homeDir);
  const existing = readIfPresent(path);
  const before = existing ?? '';
  const { text: after, changed, previousBlock } = mergeTomlServerTable(before, client, mcpUrl, serverName);

  if (!changed) {
    return { wrote: false, backedUp: false, diff: `${serverName} already configured with ${mcpUrl} — no change.`, path };
  }

  let backedUp = false;
  if (existing !== null) {
    writeFileSync(backupPath(path, serverName), existing);
    backedUp = true;
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, after.endsWith('\n') ? after : `${after}\n`);

  const header = `${client.config!.topLevelKey}.${serverName}`;
  const diff = previousBlock !== undefined ? `[${header}]: updated` : `[${header}]: (added)`;
  return { wrote: true, backedUp, diff, path };
}

/** `--undo` — restore the backup this-or-a-prior `connect` run made for `serverName`. No-op
 * (returns false) if none exists. */
export function undoClientTomlConfigWrite(
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
