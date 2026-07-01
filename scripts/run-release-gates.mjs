#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectContext,
  enumeratePublishablePackages,
  GateError,
  packPackage,
  publicExclusionSet,
  RELEASE_GATES,
  REPO_ROOT,
  resolveContext,
  selectReleaseGates,
  sha512OfFile,
} from './lib/sdk-supply-chain-common.mjs'

const argv = process.argv.slice(2)
const tarballIdx = argv.indexOf('--tarball')
let tarballDir = tarballIdx >= 0 ? argv[tarballIdx + 1] : null
const asJson = argv.includes('--json')
const contextIdx = argv.indexOf('--context')
const contextFlag = contextIdx >= 0 ? argv[contextIdx + 1] : null

function runGate(gate, dir) {
  const script = join(REPO_ROOT, gate.script)
  const args = [script]
  if (gate.consumes_tarball) args.push('--tarball', dir)
  try {
    const out = execFileSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { id: gate.id, exit: 0, output: out }
  } catch (e) {
    return { id: gate.id, exit: typeof e.status === 'number' ? e.status : 2, output: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

function main() {
  console.error('## run-release-gates orchestrator')

  const derivedContext = detectContext(REPO_ROOT)
  const context = resolveContext(derivedContext, contextFlag)
  const gates = selectReleaseGates(context)
  const excludedIds = [...publicExclusionSet()]
  const activeExcluded = RELEASE_GATES.filter((g) => !gates.includes(g)).map((g) => g.id)
  console.error(`## context: ${context} (derived: ${derivedContext}${contextFlag ? `, flag: ${contextFlag}` : ''}) — gate-set: ${gates.length} of ${RELEASE_GATES.length} active`)
  if (activeExcluded.length) {
    console.error(`## ${activeExcluded.length} excluded in this context: ${activeExcluded.join(', ')}`)
    for (const g of RELEASE_GATES.filter((x) => activeExcluded.includes(x.id))) {
      console.error(`     - ${g.id}: ${g.public.because.slice(0, 96)}${g.public.because.length > 96 ? '…' : ''} [compensating: ${g.public.compensating_control.slice(0, 72)}${g.public.compensating_control.length > 72 ? '…' : ''}]`)
    }
  } else if (context === 'public') {
    console.error(`## (no gates excluded — the named public exclusion set is [${excludedIds.join(', ') || 'empty'}])`)
  }

  let packDest = null
  if (!tarballDir) {
    const { packages } = enumeratePublishablePackages(REPO_ROOT)
    if (!argv.includes('--no-build')) {
      console.error('## building publishable packages (turbo) …')
      try {
        execFileSync('pnpm', ['exec', 'turbo', 'run', 'build', '--force', ...packages.map((p) => `--filter=${p.name}`)], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        throw new GateError(`build failed — cannot pack a clean baseline: ${String(e.stderr || e.message).slice(-300)}`)
      }
    }
    packDest = mkdtempSync(join(tmpdir(), 'rakomi-release-tgz-'))
    for (const pkg of packages) packPackage(REPO_ROOT, pkg, packDest)
    tarballDir = packDest
  }
  if (!existsSync(tarballDir)) throw new GateError(`--tarball dir does not exist: ${tarballDir}`)

  const digests = readdirSync(tarballDir).filter((f) => f.endsWith('.tgz')).sort()
    .map((f) => ({ tarball: f, sha512: sha512OfFile(join(tarballDir, f)) }))
  console.error('## packed-tarball digests (the bytes the gates inspect; publish must ship these):')
  for (const d of digests) console.error(`  ${d.tarball}  ${d.sha512}`)

  const results = []
  try {
    for (const gate of gates) results.push(runGate(gate, tarballDir))
  } finally {
    if (packDest) rmSync(packDest, { recursive: true, force: true })
  }

  const aggregate = results.reduce((max, r) => (r.exit === 2 ? 2 : r.exit === 1 && max !== 2 ? 1 : max), 0)
  console.error('\n## release-gate results (run-all-aggregate):')
  for (const r of results) console.error(`  ${r.exit === 0 ? '✓ PASS' : r.exit === 1 ? '✗ FAIL' : '⚠ CANNOT-EVALUATE'}  ${r.id} (exit ${r.exit})`)
  console.error(`\n## aggregate exit ${aggregate} (${aggregate === 0 ? 'all gates clean — release may proceed' : aggregate === 1 ? 'a gate FAILED — release BLOCKED' : 'a gate CANNOT-EVALUATE — release BLOCKED (no-vacuous-green)'})`)

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ aggregate, digests, results: results.map((r) => ({ id: r.id, exit: r.exit })) }, null, 2)}\n`)
  }
  process.exit(aggregate)
}

try {
  main()
} catch (e) {
  if (e instanceof GateError) { console.error(`\nRUN-RELEASE-GATES: CANNOT-EVALUATE — ${e.message}`); process.exit(2) }
  console.error(`\nRUN-RELEASE-GATES: CANNOT-EVALUATE — unexpected: ${e.stack || e.message}`); process.exit(2)
}
