#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { type EnvKey, writeEnvFile } from './env.js';
import { CliError, EXIT, type ExitCode, UsageError } from './errors.js';
import { collectEnv, createTtyAsk } from './prompt.js';
import { assertTargetWritable, GithubCodeloadSource, materializeArchive, type TemplateSource } from './source.js';
import { findTemplate, slugList } from './templates.js';
import { detectPackageManager, helpText, type OutputStream, postInstallMessage, usageLine } from './usage.js';

/** Dependencies the orchestrator needs — all injectable so the whole flow runs offline in tests. */
export interface RunDeps {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly version: string;
  readonly isTTY: boolean;
  /** Override the template source (tests inject a fixture source). */
  readonly source?: TemplateSource;
  /** Override the interactive prompt (tests inject canned answers). */
  readonly ask?: (question: string) => Promise<string>;
}

/**
 * Run the CLI with the given argv and dependencies, returning the POSIX exit code. Never throws
 * for a known failure class — usage/runtime errors are turned into a user-safe stderr message
 * and the matching exit code.
 */
export async function run(args: readonly string[], deps: RunDeps): Promise<ExitCode> {
  try {
    return await dispatch(args, deps);
  } catch (e) {
    if (e instanceof UsageError) {
      deps.stderr.write(`${e.message}\n${usageLine()}\n`);
      return e.exitCode;
    }
    if (e instanceof CliError) {
      deps.stderr.write(`${e.message}\n`);
      return e.exitCode;
    }
    deps.stderr.write('An unexpected error occurred.\n');
    return EXIT.FAIL;
  }
}

async function dispatch(args: readonly string[], deps: RunDeps): Promise<ExitCode> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        template: { type: 'string' },
        region: { type: 'string' },
        'tenant-id': { type: 'string' },
        'template-source': { type: 'string' },
        yes: { type: 'boolean' },
        connect: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    throw new UsageError('Unknown or malformed argument.');
  }

  if (values.help === true || args.length === 0) {
    deps.stdout.write(helpText());
    return EXIT.OK;
  }
  if (values.version === true) {
    deps.stdout.write(`${deps.version}\n`);
    return EXIT.OK;
  }

  const slug = typeof values.template === 'string' ? values.template : undefined;
  if (!slug) {
    throw new UsageError(`Missing --template. Valid templates: ${slugList()}.`);
  }
  const template = findTemplate(slug);
  if (!template) {
    throw new UsageError(`Unknown template "${slug}". Valid templates: ${slugList()}.`);
  }

  const rawTarget = positionals[0] ?? template.slug;
  const targetDir = resolveTarget(rawTarget, deps.cwd);
  await assertTargetWritable(targetDir);

  const flags: Partial<Record<EnvKey, string>> = {};
  if (typeof values.region === 'string') flags.RAKOMI_REGION = values.region;
  if (typeof values['tenant-id'] === 'string') flags.RAKOMI_TENANT_ID = values['tenant-id'];
  const interactive = deps.isTTY && values.yes !== true && !deps.env.CI;
  const envValues = await collectEnv({ flags, env: deps.env, interactive, ask: deps.ask });

  const source = deps.source ?? makeDefaultSource(values, deps.env);
  const archive = await source.fetchArchive(template);
  await materializeArchive(archive, targetDir);
  await ensureEnvIgnored(targetDir);
  await writeEnvFile(targetDir, envValues);

  const pm = detectPackageManager(deps.env.npm_config_user_agent);
  deps.stdout.write(postInstallMessage(template.slug, rawTarget, pm));
  if (values.connect === true) {
    deps.stdout.write(connectInstructions());
  }
  return EXIT.OK;
}

/** `--connect` next-step copy: how to connect an AI agent once the scaffolded app is set up. */
export function connectInstructions(): string {
  return [
    '',
    'Connect an AI agent (Claude Code, Claude Desktop) to this tenant:',
    '  npx rakomi login',
    '  npx rakomi connect',
    '',
  ].join('\n');
}

function makeDefaultSource(
  values: Record<string, string | boolean | undefined>,
  env: Record<string, string | undefined>,
): TemplateSource {
  const base =
    (typeof values['template-source'] === 'string' ? values['template-source'] : undefined) ??
    env.CREATE_RAKOMI_TEMPLATE_BASE;
  return new GithubCodeloadSource(base ? { base } : {});
}

/** Resolve and constrain the target directory to within the current working directory. */
function resolveTarget(raw: string, cwd: string): string {
  const resolved = resolve(cwd, raw);
  const rel = relative(cwd, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UsageError('Target directory must be a new path inside the current directory.');
  }
  return resolved;
}

/** Make sure the scaffolded project ignores its `.env` so the user never commits secrets. */
async function ensureEnvIgnored(targetDir: string): Promise<void> {
  const gitignore = join(targetDir, '.gitignore');
  let content = '';
  try {
    content = await readFile(gitignore, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const alreadyIgnored = content.split(/\r?\n/).some((line) => line.trim() === '.env');
  if (alreadyIgnored) return;
  const separator = content && !content.endsWith('\n') ? '\n' : '';
  await appendFile(gitignore, `${separator}.env\n`);
}

async function main(): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < 22) {
    process.stderr.write('create-rakomi-app needs Node.js 22 or newer.\n');
    process.exitCode = EXIT.FAIL;
    return;
  }
  let version = '0.0.0';
  try {
    version = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  } catch {
  }
  process.exitCode = await run(process.argv.slice(2), {
    stdout: { write: (text) => void process.stdout.write(text) },
    stderr: { write: (text) => void process.stderr.write(text) },
    env: process.env,
    cwd: process.cwd(),
    version,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: createTtyAsk(),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
