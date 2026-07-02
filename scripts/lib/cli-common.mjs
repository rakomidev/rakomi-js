
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PUBLIC_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export class CliError extends Error {}

export function loadIdentity() {
  return JSON.parse(readFileSync(join(PUBLIC_REPO_ROOT, 'sdk-repo-identity.json'), 'utf8'))
}

export const OIDC = Object.freeze({
  workflow: 'publish.yml',
  environment: 'release',
  builderId: 'https://github.com/actions/runner/github-hosted',
  keylessIssuers: Object.freeze(['https://token.actions.githubusercontent.com']),
  roleMailboxes: Object.freeze(['release-bot@rakomi.com']),
})

export function sha512OfFile(path) {
  return `sha512:${createHash('sha512').update(readFileSync(path)).digest('hex')}`
}

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

export function fetchAttestations(pkg, version = 'latest', { retries = 5, backoffMs = 2000, fetchText } = {}) {
  const getUrl = () => run('npm', ['view', `${pkg}@${version}`, 'dist.attestations.url']).trim()
  const httpGet = fetchText || ((url) => run('curl', ['-sSf', '--max-time', '30', url]))
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const url = getUrl()
      if (!url) throw new CliError(`no dist.attestations.url for ${pkg}@${version} — no provenance attestation attached`)
      const parsed = JSON.parse(httpGet(url))
      if (parsed && Array.isArray(parsed.attestations) && parsed.attestations.length > 0) return parsed
      lastErr = new CliError('attestation bundle resolved but attestations[] is empty (indexing lag?)')
    } catch (e) {
      lastErr = e
    }
    if (attempt < retries) sleepSync(backoffMs * attempt)
  }
  throw new CliError(`could not fetch a non-empty attestation bundle for ${pkg}@${version} after ${retries} attempts: ${lastErr && lastErr.message ? lastErr.message : lastErr}`)
}

export function report(label, result) {
  if (result.ok) {
    console.error(`  ✓ ${label}: ${result.reason || 'PASS'}`)
    console.error(`${label}: PASS`)
    process.exit(0)
  }
  const msgs = result.violations && result.violations.length ? result.violations : [result.reason || 'FAIL']
  for (const m of msgs) console.error(`  ✗ ${label}: ${m}`)
  console.error(`${label}: FAIL`)
  process.exit(1)
}

export function guard(label, fn) {
  try {
    fn()
  } catch (e) {
    console.error(`${label}: CANNOT-EVALUATE — ${e && e.message ? e.message : e}`)
    process.exit(2)
  }
}

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
      out[key] = val
    }
  }
  return out
}
