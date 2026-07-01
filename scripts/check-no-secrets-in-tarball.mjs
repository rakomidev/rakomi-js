#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  denyListHit,
  enumeratePublishablePackages,
  GateError,
  matchTarballForPackage,
  packPackage,
  readTarball,
  relGateMessage,
  REPO_ROOT,
} from './lib/sdk-supply-chain-common.mjs'

const argv = process.argv.slice(2)
const tarballIdx = argv.indexOf('--tarball')
const tarballDir = tarballIdx >= 0 ? argv[tarballIdx + 1] : null

const GITLEAKS_CONFIG = join(REPO_ROOT, 'gitleaks.toml')

const violations = []
const cannotEval = []
const fail = (m) => { violations.push(m); console.error(`  ✗ ${m}`) }
const cantEval = (m) => { cannotEval.push(m); console.error(`  ⚠ ${m}`) }
const ok = (m) => console.error(`  ✓ ${m}`)

function runGitleaks(name, version, tgz) {
  const extractDir = mkdtempSync(join(tmpdir(), 'rakomi-gl-extract-'))
  const reportDir = mkdtempSync(join(tmpdir(), 'rakomi-gl-report-'))
  const reportPath = join(reportDir, 'gitleaks.json')
  try {
    execFileSync('tar', ['xzf', tgz, '-C', extractDir])

    let glExit = 0
    try {
      execFileSync('gitleaks', [
        'detect', '--no-git', '--redact', '--no-banner',
        '--source', extractDir,
        '--config', GITLEAKS_CONFIG,
        '--report-format', 'json',
        '--report-path', reportPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new GateError(relGateMessage('REL-GATE-N1E1', 'CANNOT-EVALUATE', name, version,
          'gitleaks binary not found on PATH — an unrun secret scanner is a RED state, not a clean one'))
      }
      glExit = typeof e.status === 'number' ? e.status : NaN
    }

    if (glExit !== 0 && glExit !== 1) {
      throw new GateError(relGateMessage('REL-GATE-N1E2', 'CANNOT-EVALUATE', name, version,
        `gitleaks (vendor) exited ${Number.isNaN(glExit) ? 'with a non-numeric/signal status' : glExit} — infra error, not a catch and not a pass`))
    }

    let report
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'))
    } catch (e) {
      throw new GateError(relGateMessage('REL-GATE-N1E2', 'CANNOT-EVALUATE', name, version,
        `gitleaks (vendor) produced no parseable JSON report (${e.message}) — infra error, not a catch and not a pass`))
    }
    if (!Array.isArray(report)) {
      throw new GateError(relGateMessage('REL-GATE-N1E2', 'CANNOT-EVALUATE', name, version,
        'gitleaks (vendor) report was not a JSON array — infra error, not a catch and not a pass'))
    }

    const stripExtract = (p) => {
      const rel = p.startsWith(extractDir) ? p.slice(extractDir.length).replace(/^[/\\]+/, '') : p
      return rel || p
    }
    return report.map((f) => relGateMessage('REL-GATE-N103', 'FAIL', name, version,
      `gitleaks detected a secret in tarball file "${stripExtract(f.File)}" (rule "${f.RuleID}")`))
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
    rmSync(reportDir, { recursive: true, force: true })
  }
}

function main() {
  console.error('## no-secrets-in-tarball gate')
  const { packages, expectedCount } = enumeratePublishablePackages(REPO_ROOT)
  console.error(`## enumerated ${expectedCount} publishable package(s): ${packages.map((p) => p.name).join(', ')}`)

  let packDest = null
  const tarballs = new Map()
  if (tarballDir) {
    if (!existsSync(tarballDir)) throw new GateError(relGateMessage('REL-GATE-N1E2', 'CANNOT-EVALUATE', '-', '', `--tarball dir does not exist: ${tarballDir}`))
    const present = readdirSync(tarballDir).filter((f) => f.endsWith('.tgz'))
    for (const pkg of packages) {
      const pj = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, 'package.json'), 'utf8'))
      const flatName = `${pj.name.replace('@', '').replace(/\//g, '-')}`
      const hit = matchTarballForPackage(present, flatName, pj.version)
      if (hit) tarballs.set(pkg.name, join(tarballDir, hit))
    }
  } else {
    packDest = mkdtempSync(join(tmpdir(), 'rakomi-sc-tgz-'))
    for (const pkg of packages) {
      try { tarballs.set(pkg.name, packPackage(REPO_ROOT, pkg, packDest)) }
      catch (e) { fail(`${pkg.name}: pack failed: ${e.message}`) }
    }
  }

  let inspected = 0
  try {
    for (const pkg of packages) {
      const tgz = tarballs.get(pkg.name)
      if (!tgz) { fail(`${pkg.name}: no tarball available to inspect (pack failed or not present in --tarball dir)`); continue }

      let manifest, files
      try { ({ manifest, files } = readTarball(tgz)) }
      catch (e) {
        if (e instanceof GateError) { cantEval(e.message); continue }
        fail(`${pkg.name}: cannot read tarball ${tgz}: ${e.message}`); continue
      }
      inspected++
      const version = (manifest && manifest.version) || ''

      let pkgClean = true
      for (const member of files) {
        const rule = denyListHit(member)
        if (!rule) continue
        pkgClean = false
        const code = rule.id === 'dotenv' ? 'REL-GATE-N101'
          : rule.id === 'npmrc' ? 'REL-GATE-N104'
            : 'REL-GATE-N102'
        fail(relGateMessage(code, 'FAIL', pkg.name, version,
          `deny-listed secret-bearing file "${member}" ships in tarball (rule "${rule.label}")`))
      }

      try {
        const glFindings = runGitleaks(pkg.name, version, tgz)
        if (glFindings.length) { pkgClean = false; glFindings.forEach(fail) }
        if (pkgClean) ok(`${pkg.name}@${version}: no deny-listed file ships; gitleaks found no secrets`)
      } catch (e) {
        if (e instanceof GateError) { pkgClean = false; cantEval(e.message) }
        else throw e
      }
    }
  } finally {
    if (packDest) rmSync(packDest, { recursive: true, force: true })
  }

  if (inspected !== expectedCount) {
    cantEval(`inspected ${inspected}, expected ${expectedCount} — package set under-covered (no-vacuous-green count-equality)`)
  } else {
    ok(`count-equality: inspected ${inspected} === expected ${expectedCount}`)
  }
}

try {
  main()
} catch (e) {
  if (e instanceof GateError) { console.error(`\nNO-SECRETS-IN-TARBALL: CANNOT-EVALUATE — ${e.message}`); process.exit(2) }
  console.error(`\nNO-SECRETS-IN-TARBALL: CANNOT-EVALUATE — unexpected: ${e.stack || e.message}`); process.exit(2)
}

console.error('\n## no-secrets-in-tarball summary')
if (violations.length) {
  console.error(`\nNO-SECRETS-IN-TARBALL: FAIL (${violations.length})`)
  process.exit(1)
}
if (cannotEval.length) {
  console.error(`\nNO-SECRETS-IN-TARBALL: CANNOT-EVALUATE (${cannotEval.length}) — ${cannotEval[0]}`)
  process.exit(2)
}
console.error('\nNO-SECRETS-IN-TARBALL: PASS')
