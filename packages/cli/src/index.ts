#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { systemBrowserOpener } from './browser.js';
import type { CiOidcEnv } from './ci-oidc-token.js';
import { runConnect } from './commands/connect.js';
import { runLogin, runLoginCi } from './commands/login.js';
import { runLogout } from './commands/logout.js';
import { runMcpToolsCi } from './commands/mcp.js';
import { runTenantsCreate, runTenantsList } from './commands/tenants.js';
import { runUse } from './commands/use.js';
import { runWhoami } from './commands/whoami.js';
import { apiBaseUrl, type CliEnv, DEFAULT_MCP_URL } from './env.js';
import { CliError, EXIT, type ExitCode, UsageError } from './errors.js';
import type { FetchLike } from './http.js';
import { startLoopbackListener } from './loopback-server.js';
import { type KeyStore, type ResolvedStores, resolveStores, type SessionStore } from './session.js';
import { FileTenantConfigStore, type TenantConfigStore } from './tenant-config.js';
import { helpText, type OutputStream, usageLine } from './usage.js';

export interface RunDeps {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly env: CliEnv;
  readonly cwd: string;
  readonly version: string;
  readonly isTTY: boolean;
  readonly fetchImpl: FetchLike;
  readonly session: SessionStore;
  readonly keys: KeyStore;
  /** Story rakomi-cli-login-identity-first-platform-tenant — `rakomi use`/`whoami`'s locally-remembered active tenant (never a verified membership, see tenant-config.ts). */
  readonly tenantConfig: TenantConfigStore;
  readonly detectClaudeCode: () => boolean;
  /** Story rakomi-cli-login-ci-oidc-federation — CI-platform env vars for `login --ci`'s OIDC
   * token resolution (see `ci-oidc-token.ts`). Optional so every pre-existing `RunDeps` fixture in
   * the test suite keeps compiling unchanged; `login --ci` degrades to "no OIDC token source
   * found" (a `CliError`, never a crash) when omitted. */
  readonly ciEnv?: CiOidcEnv;
  /** Injectable so `login --ci`'s `--oidc-token-file` path is testable with no real filesystem;
   * defaults to `readFileSync` in `main()`. */
  readonly readTextFile?: (path: string) => string;
}

const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  yes: { type: 'boolean' },
  ci: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  'no-keychain': { type: 'boolean' },
  'oidc-token-file': { type: 'string' },
  client: { type: 'string' },
  undo: { type: 'boolean' },
  write: { type: 'boolean' },
  owner: { type: 'string' },
  slug: { type: 'string' },
  'tenant-id': { type: 'string' },
  tenant: { type: 'string' },
  'cimd-url': { type: 'string' },
  status: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
} as const;

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
    const parsed = parseArgs({ args: [...args], allowPositionals: true, options: GLOBAL_OPTIONS });
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

  const ci = values.ci === true || values.yes === true || Boolean(deps.env.CI);
  const dryRun = values['dry-run'] === true;
  const json = values.json === true;
  const httpDeps = { fetchImpl: deps.fetchImpl };

  const [command, ...rest] = positionals;
  switch (command) {
    case 'login': {
      if (values.ci === true) {
        await runLoginCi({
          ...httpDeps,
          env: deps.env,
          ciEnv: deps.ciEnv ?? {},
          session: deps.session,
          keys: deps.keys,
          oidcTokenFile: typeof values['oidc-token-file'] === 'string' ? values['oidc-token-file'] : undefined,
          readTextFile: deps.readTextFile ?? ((p) => readFileSync(p, 'utf8')),
          stdout: deps.stdout,
          now: () => Date.now(),
        });
        return EXIT.OK;
      }
      await runLogin({
        ...httpDeps,
        env: deps.env,
        session: deps.session,
        keys: deps.keys,
        noBrowser: values['no-browser'] === true || ci,
        openBrowser: systemBrowserOpener(),
        startLoopback: startLoopbackListener,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        stdout: deps.stdout,
        now: () => Date.now(),
        explicitTenantId: typeof values['tenant-id'] === 'string' ? values['tenant-id'] : undefined,
      });
      return EXIT.OK;
    }

    case 'logout':
      runLogout({ session: deps.session, stdout: deps.stdout });
      return EXIT.OK;

    case 'whoami':
      await runWhoami({
        ...httpDeps,
        session: deps.session,
        keys: deps.keys,
        json,
        stdout: deps.stdout,
        tenantConfig: deps.tenantConfig,
        explicitTenant: typeof values.tenant === 'string' ? values.tenant : undefined,
      });
      return EXIT.OK;

    case 'use': {
      const tenantId = rest[0];
      if (!tenantId) throw new UsageError('Usage: rakomi use <tenant-id>');
      runUse({ tenantConfig: deps.tenantConfig, stdout: deps.stdout }, { tenantId });
      return EXIT.OK;
    }

    case 'connect':
      await runConnect({
        ...httpDeps,
        session: deps.session,
        keys: deps.keys,
        cwd: deps.cwd,
        apiBaseUrl: apiBaseUrl(deps.env),
        mcpUrl: deps.env.RAKOMI_API_URL ? `${apiBaseUrl(deps.env)}/mcp` : DEFAULT_MCP_URL,
        detectClaudeCode: deps.detectClaudeCode,
        stdout: deps.stdout,
        write: values.write === true,
        dryRun,
        ci,
        undo: values.undo === true,
        explicitClient: typeof values.client === 'string' ? values.client : undefined,
        cimdUrl: typeof values['cimd-url'] === 'string' ? values['cimd-url'] : undefined,
        status: values.status === true,
      });
      return EXIT.OK;

    case 'mcp': {
      const [sub] = rest;
      if (sub !== 'tools') {
        throw new UsageError('Usage: rakomi mcp tools --ci');
      }
      if (values.ci !== true) {
        throw new UsageError('rakomi mcp tools requires --ci (workload-identity federation; no interactive form exists yet).');
      }
      await runMcpToolsCi({
        ...httpDeps,
        env: deps.env,
        ciEnv: deps.ciEnv ?? {},
        keys: deps.keys,
        oidcTokenFile: typeof values['oidc-token-file'] === 'string' ? values['oidc-token-file'] : undefined,
        readTextFile: deps.readTextFile ?? ((p) => readFileSync(p, 'utf8')),
        json,
        stdout: deps.stdout,
      });
      return EXIT.OK;
    }

    case 'tenants': {
      const [sub, ...tenantArgs] = rest;
      if (sub === 'create') {
        const name = tenantArgs[0];
        if (!name) throw new UsageError('Usage: rakomi tenants create <name> [--owner me|<email>] [--slug <slug>]');
        await runTenantsCreate(
          { ...httpDeps, session: deps.session, keys: deps.keys, json, dryRun, ci, stdout: deps.stdout },
          { name, slug: typeof values.slug === 'string' ? values.slug : undefined, owner: typeof values.owner === 'string' ? values.owner : 'me' },
        );
        return EXIT.OK;
      }
      if (sub === 'list') {
        await runTenantsList({ ...httpDeps, session: deps.session, keys: deps.keys, json, stdout: deps.stdout });
        return EXIT.OK;
      }
      throw new UsageError('Usage: rakomi tenants <create|list> ...');
    }

    default:
      throw new UsageError(`Unknown command "${command ?? ''}".`);
  }
}

/**
 * Prints `resolved.fallbackDisclosure`, if any, exactly once — the caller (`main()`) calls this ONCE at
 * store-construction time, never from inside a session read/write, so a command doing several session
 * reads never repeats it. Extracted from `main()` so this behaviour is independently unit-testable
 * (`main()` itself reads real `process.env`/`process.argv` and is exercised only via `isCliEntry()`).
 */
export function printFallbackDisclosureOnce(resolved: ResolvedStores, stderr: { write(s: string): void }): void {
  if (resolved.fallbackDisclosure) {
    stderr.write(resolved.fallbackDisclosure + '\n');
  }
}

async function main(): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < 22) {
    process.stderr.write('rakomi needs Node.js 22 or newer.\n');
    process.exitCode = EXIT.FAIL;
    return;
  }
  let version = '0.0.0';
  try {
    version = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  } catch {
  }
  const env: CliEnv = {
    RAKOMI_API_URL: process.env.RAKOMI_API_URL,
    RAKOMI_ACCOUNTS_URL: process.env.RAKOMI_ACCOUNTS_URL,
    RAKOMI_CLIENT_ID: process.env.RAKOMI_CLIENT_ID,
    RAKOMI_CONFIG_DIR: process.env.RAKOMI_CONFIG_DIR,
    RAKOMI_PLATFORM_TENANT_ID: process.env.RAKOMI_PLATFORM_TENANT_ID,
    CI: process.env.CI,
    NO_COLOR: process.env.NO_COLOR,
  };
  const noKeychainEnv = process.env.RAKOMI_NO_KEYCHAIN;
  const ciEnv: CiOidcEnv = {
    ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    CI_JOB_JWT_V2: process.env.CI_JOB_JWT_V2,
    CI_JOB_JWT: process.env.CI_JOB_JWT,
    RAKOMI_OIDC_TOKEN: process.env.RAKOMI_OIDC_TOKEN,
  };
  const noKeychainFlag = process.argv.slice(2).includes('--no-keychain');
  const resolved = resolveStores(env, { noKeychain: noKeychainFlag || Boolean(env.CI) || Boolean(noKeychainEnv) });
  printFallbackDisclosureOnce(resolved, { write: (text) => void process.stderr.write(text) });
  process.exitCode = await run(process.argv.slice(2), {
    stdout: { write: (text) => void process.stdout.write(text) },
    stderr: { write: (text) => void process.stderr.write(text) },
    env,
    cwd: process.cwd(),
    version,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    fetchImpl: fetch,
    session: resolved.session,
    keys: resolved.keys,
    tenantConfig: new FileTenantConfigStore(env),
    detectClaudeCode: () => detectClaudeCodeCli(),
    ciEnv,
  });
}

/** Presence-only, no version/behaviour probing — a `claude` binary error still counts as "detected". */
function detectClaudeCodeCli(): boolean {
  const pathEnv = process.env.PATH ?? '';
  const binaryName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  return pathEnv.split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, binaryName)));
}

/**
 * True when this module is the process entry point. Compares REALPATHS, not path strings: `process.argv[1]`
 * is the path as typed, `import.meta.url` is already realpath-resolved by Node, so a string compare is
 * silently false behind any symlink (macOS `/tmp` → `/private/tmp`, a symlinked `node_modules/.bin`) and the
 * CLI would exit 0 having done nothing.
 */
function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  try {
    return real(argv1) === real(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  void main();
}
