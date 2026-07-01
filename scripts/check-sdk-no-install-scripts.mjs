#!/usr/bin/env node

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  enumeratePublishablePackages,
  GateError,
  inspectFilesAllowList,
  inspectPublishedTarball,
  matchTarballForPackage,
  packPackage,
  readTarball,
  REPO_ROOT,
} from './lib/sdk-supply-chain-common.mjs'

const argv = process.argv.slice(2)
const tarballIdx = argv.indexOf('--tarball')
const tarballDir = tarballIdx >= 0 ? argv[tarballIdx + 1] : null

const violations = []
const warnings = []
const fail = (m) => { violations.push(m); console.error(`  ✗ ${m}`) }
const warn = (m) => { warnings.push(m); console.error(`  ⚠ ${m}`) }
const ok = (m) => console.error(`  ✓ ${m}`)

function main() {
  console.error('## no-install-scripts gate')
  const { packages, expectedCount } = enumeratePublishablePackages(REPO_ROOT)
  console.error(`## enumerated ${expectedCount} publishable package(s) from .changeset/config.json fixed[0] ∪ {@rakomi/node}: ${packages.map((p) => p.name).join(', ')}`)

  let packDest = null
  const tarballs = new Map()
  if (tarballDir) {
    if (!existsSync(tarballDir)) throw new GateError(`--tarball dir does not exist: ${tarballDir}`)
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
      catch (e) { fail(`${pkg.name}: cannot read tarball ${tgz}: ${e.message}`); continue }
      inspected++

      const r = inspectPublishedTarball({ name: pkg.name, manifest, files })
      r.violations.forEach(fail)
      r.warnings.forEach(warn)

      const hasNpmignore = existsSync(join(REPO_ROOT, pkg.dir, '.npmignore'))
      const fv = inspectFilesAllowList({ name: pkg.name, manifest, hasNpmignore })
      fv.forEach(fail)

      if (!r.violations.length && !fv.length) ok(`${pkg.name}: no install-time scripts; files: allow-list present, no .npmignore; no native-build/.npmrc surface`)
    }
  } finally {
    if (packDest) rmSync(packDest, { recursive: true, force: true })
  }

  if (inspected !== expectedCount) {
    fail(`inspected ${inspected}, expected ${expectedCount} — package set under-covered (no-vacuous-green count-equality)`)
  } else {
    ok(`count-equality: inspected ${inspected} === expected ${expectedCount}`)
  }
}

try {
  main()
} catch (e) {
  if (e instanceof GateError) { console.error(`\nNO-INSTALL-SCRIPTS: CANNOT-EVALUATE — ${e.message}`); process.exit(2) }
  console.error(`\nNO-INSTALL-SCRIPTS: CANNOT-EVALUATE — unexpected: ${e.stack || e.message}`); process.exit(2)
}

console.error('\n## no-install-scripts summary')
for (const w of warnings) console.error(`  • warning: ${w}`)
if (violations.length) {
  console.error(`\nNO-INSTALL-SCRIPTS: FAIL (${violations.length})`)
  process.exit(1)
}
console.error('\nNO-INSTALL-SCRIPTS: PASS')
