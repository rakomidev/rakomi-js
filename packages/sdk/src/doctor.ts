#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIssuerJwksUri } from './internal/issuer-jwks.js';
import { isAcceptableSigningJwk } from './internal/signing-algorithms.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export function getSdkVersion(): string {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const pkgPath = resolve(dir, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

export async function checkApiReachability(baseUrl: string): Promise<CheckResult> {
  const url = `${baseUrl}/v1/health`;
  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const latency = Date.now() - start;
    if (res.ok) {
      return { name: 'API reachable', passed: true, detail: `${url} (${latency}ms)` };
    }
    return { name: 'API reachable', passed: false, detail: `HTTP ${String(res.status)} from ${url}` };
  } catch (err) {
    return {
      name: 'API reachable',
      passed: false,
      detail: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Resolve the issuer's `jwks_uri` from its discovery document and check it serves at least one
 * key usable for signature verification.
 */
export async function checkJwks(issuer: string): Promise<CheckResult> {
  let url: string;
  try {
    url = await resolveIssuerJwksUri(issuer);
  } catch (err) {
    return {
      name: 'JWKS available',
      passed: false,
      detail: `discovery for ${issuer} failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      return { name: 'JWKS available', passed: false, detail: `HTTP ${String(res.status)} from ${url}` };
    }
    const data = (await res.json()) as { keys?: unknown[] };
    if (!Array.isArray(data.keys)) {
      return { name: 'JWKS available', passed: false, detail: 'Response missing keys array' };
    }
    const usable = data.keys.filter(
      (k) => typeof k === 'object' && k !== null && isAcceptableSigningJwk(k as Record<string, unknown>),
    ).length;
    if (usable === 0) {
      return { name: 'JWKS available', passed: false, detail: `no usable signing key at ${url}` };
    }
    return {
      name: 'JWKS available',
      passed: true,
      detail: `${String(usable)} key(s) found`,
    };
  } catch (err) {
    return {
      name: 'JWKS available',
      passed: false,
      detail: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

const TOKEN_ERROR_PREFIX = 'token/';

export async function checkTokenVerification(
  baseUrl: string,
  apiKey: string,
): Promise<CheckResult> {
  try {
    const { RakomiClient } = await import('./client.js');
    const ca = new RakomiClient({ apiKey, baseUrl });
    const result = await Promise.race([
      ca.verifyToken('test'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Token verification timed out after 10s')), 10_000),
      ),
    ]);
    if (!result.ok) {
      if (result.error.code.startsWith(TOKEN_ERROR_PREFIX)) {
        return {
          name: 'Token verification',
          passed: true,
          detail: `${result.error.code} (expected — no real token provided)`,
        };
      }
      return {
        name: 'Token verification',
        passed: false,
        detail: `${result.error.code}: ${result.error.message}`,
      };
    }
    return { name: 'Token verification', passed: true, detail: 'SDK initialized correctly' };
  } catch (err) {
    return {
      name: 'Token verification',
      passed: false,
      detail: err instanceof Error ? err.message : 'SDK initialization failed',
    };
  }
}

export function computeExitCode(results: CheckResult[]): number {
  return results.every((r) => r.passed) ? 0 : 1;
}

function formatResult(result: CheckResult): string {
  const icon = result.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  return `  ${icon} ${result.name}: ${result.detail}`;
}

function parseArgs(args: string[]): { baseUrl: string; apiKey: string; issuer: string } {
  let baseUrl = 'https://api.rakomi.com';
  let apiKey = 'ca_test_doctor_check';
  let issuer: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base-url' && args[i + 1]) {
      baseUrl = args[i + 1]!;
      i++;
    } else if (args[i] === '--api-key' && args[i + 1]) {
      apiKey = args[i + 1]!;
      i++;
    } else if (args[i] === '--issuer' && args[i + 1]) {
      issuer = args[i + 1]!;
      i++;
    }
  }

  return { baseUrl, apiKey, issuer: issuer ?? baseUrl };
}

async function main(): Promise<void> {
  const { baseUrl, apiKey, issuer } = parseArgs(process.argv.slice(2));
  const version = getSdkVersion();

  process.stdout.write(`\n${BOLD}@rakomi/node Doctor v${version}${RESET}\n`);
  process.stdout.write('================================\n\n');

  const results: CheckResult[] = [];

  results.push({ name: 'SDK version', passed: true, detail: version });
  process.stdout.write(formatResult(results[results.length - 1]!) + '\n');

  results.push(await checkApiReachability(baseUrl));
  process.stdout.write(formatResult(results[results.length - 1]!) + '\n');

  results.push(await checkJwks(issuer));
  process.stdout.write(formatResult(results[results.length - 1]!) + '\n');

  results.push(await checkTokenVerification(baseUrl, apiKey));
  process.stdout.write(formatResult(results[results.length - 1]!) + '\n');

  const passedCount = results.filter((r) => r.passed).length;
  process.stdout.write(`\n${String(passedCount)}/${String(results.length)} checks passed\n\n`);

  process.exitCode = computeExitCode(results);
}

main().catch((err: unknown) => {
  process.stderr.write(`Doctor failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
