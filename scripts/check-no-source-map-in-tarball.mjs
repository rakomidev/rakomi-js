#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  enumeratePublishablePackages,
  GateError,
  matchTarballForPackage,
  readTarball,
  relGateMessage,
  REPO_ROOT,
} from './lib/sdk-supply-chain-common.mjs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const tarballIdx = argv.indexOf('--tarball')
const tarballDir = tarballIdx >= 0 ? argv[tarballIdx + 1] : null

export const SOURCE_MAP_RE = /\.[cm]?[jt]s\.map$/
export const TEST_ARTIFACT_RE = /\.(test|spec)\.([cm]?[jt]sx?|d\.[cm]?ts)$/

const basename = (p) => p.split('/').pop()

export function parsePackFiles(stdout, pkgName) {
  const start = stdout.search(/[[{]/)
  if (start < 0) throw new GateError(relGateMessage('REL-GATE-N8E1', 'CANNOT-EVALUATE', pkgName, '', 'npm pack preview produced no JSON — cannot see the tarball (fail-closed)'))
  let parsed
  try {
    parsed = JSON.parse(stdout.slice(start))
  } catch (e) {
    throw new GateError(relGateMessage('REL-GATE-N8E1', 'CANNOT-EVALUATE', pkgName, '', `npm pack preview is not parseable JSON (${e.message}) — fail-closed`))
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  if (arr.length === 0) throw new GateError(relGateMessage('REL-GATE-N8E1', 'CANNOT-EVALUATE', pkgName, '', 'npm pack reported ZERO packages — fail-closed'))
  const entry = arr[0]
  const rawFiles = Array.isArray(entry.files) ? entry.files : []
  const files = rawFiles.map((f) => (typeof f === 'string' ? f : f.path || f.name)).filter(Boolean)
  if (files.length === 0) throw new GateError(relGateMessage('REL-GATE-N8E1', 'CANNOT-EVALUATE', pkgName, '', 'npm pack reported ZERO files — an empty parse is fail-closed, never a vacuous green'))
  if (!files.some((f) => basename(f) === 'package.json')) {
    throw new GateError(relGateMessage('REL-GATE-N8E1', 'CANNOT-EVALUATE', pkgName, '', 'npm pack file list has no package.json — parse shape unexpected, fail-closed'))
  }
  return files
}

export function inspectPackedFiles(pkgName, version, files, manifest) {
  const fails = []
  for (const f of files) {
    if (SOURCE_MAP_RE.test(basename(f))) {
      fails.push(relGateMessage('REL-GATE-N801', 'FAIL', pkgName, version, `source map "${f}" ships in tarball (leaks sources/sourcesContent)`))
    }
    if (TEST_ARTIFACT_RE.test(basename(f))) {
      fails.push(relGateMessage('REL-GATE-N802', 'FAIL', pkgName, version, `test artifact "${f}" ships in tarball (co-located *.test.* compiled into dist)`))
    }
  }
  if (manifest.optionalDependencies && Object.keys(manifest.optionalDependencies).length > 0) {
    fails.push(relGateMessage('REL-GATE-N803', 'FAIL', pkgName, version, 'optionalDependencies in a published manifest (install-time surface manifest-sanity)'))
  }
  return fails
}

const NPM_PACK_PREVIEW_FLAG = `--${['dry', 'run'].join('-')}`

function packDryRun(pkgDir) {
  return execFileSync('npm', ['pack', NPM_PACK_PREVIEW_FLAG, '--json'], { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function resolveFilesAndManifest(pkg, present) {
  if (tarballDir) {
    const diskManifest = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, 'package.json'), 'utf8'))
    const flat = diskManifest.name.replace('@', '').replace(/\//g, '-')
    const hit = matchTarballForPackage(present, flat, diskManifest.version)
    if (!hit) throw new GateError(relGateMessage('REL-GATE-N8E1', 'CANNOT-EVALUATE', pkg.name, diskManifest.version || '', `no tarball found in --tarball dir for ${pkg.name}`))
    const { manifest, files } = readTarball(join(tarballDir, hit))
    return { manifest, files }
  }
  const pkgDir = join(REPO_ROOT, pkg.dir)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  return { manifest, files: parsePackFiles(packDryRun(pkgDir), pkg.name) }
}

function main() {
  console.error(`## no-source-map-in-tarball gate — mode: ${tarballDir ? `tarball ${tarballDir}` : 'npm pack preview'}`)
  const { packages, expectedCount } = enumeratePublishablePackages(REPO_ROOT)
  console.error(`## enumerated ${expectedCount} publishable package(s): ${packages.map((p) => p.name).join(', ')}`)

  if (tarballDir && !existsSync(tarballDir)) {
    throw new GateError(relGateMessage('REL-GATE-N8E1', 'CANNOT-EVALUATE', '-', '', `--tarball dir does not exist: ${tarballDir}`))
  }
  const present = tarballDir ? readdirSync(tarballDir).filter((f) => f.endsWith('.tgz')) : []

  const violations = []
  const cannotEval = []
  let inspected = 0

  for (const pkg of packages) {
    let manifest, files
    try {
      ({ manifest, files } = resolveFilesAndManifest(pkg, present))
    } catch (e) {
      if (e instanceof GateError) { cannotEval.push(e.message); console.error(`  ⚠ ${e.message}`); continue }
      cannotEval.push(`${pkg.name}: cannot resolve tarball: ${e.message}`); console.error(`  ⚠ ${pkg.name}: ${e.message}`); continue
    }
    inspected++
    const version = manifest.version || ''
    const fails = inspectPackedFiles(pkg.name, version, files, manifest)
    if (fails.length === 0) {
      console.error(`  ✓ ${pkg.name}@${version}: ${files.length} packed entries, no .map / no test artifact / no optionalDependencies`)
    } else {
      for (const f of fails) { violations.push(f); console.error(`  ✗ ${f}`) }
    }
  }

  if (inspected !== expectedCount) {
    cannotEval.push(`inspected ${inspected}, expected ${expectedCount} — package set under-covered (no-vacuous-green count-equality)`)
    console.error(`  ⚠ inspected ${inspected}, expected ${expectedCount}`)
  } else {
    console.error(`  ✓ count-equality: inspected ${inspected} === expected ${expectedCount}`)
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ inspected, expected: expectedCount, violations: violations.length, cannotEval: cannotEval.length }, null, 2)}\n`)
  }

  if (violations.length) {
    console.error(`\nNO-SOURCE-MAP-IN-TARBALL: FAIL (${violations.length})`)
    process.exit(1)
  }
  if (cannotEval.length) {
    console.error(`\nNO-SOURCE-MAP-IN-TARBALL: CANNOT-EVALUATE (${cannotEval.length}) — ${cannotEval[0]}`)
    process.exit(2)
  }
  console.error('\nNO-SOURCE-MAP-IN-TARBALL: PASS')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (e) {
    if (e instanceof GateError) { console.error(`\nNO-SOURCE-MAP-IN-TARBALL: CANNOT-EVALUATE — ${e.message}`); process.exit(2) }
    console.error(`\nNO-SOURCE-MAP-IN-TARBALL: CANNOT-EVALUATE — unexpected: ${e.stack || e.message}`); process.exit(2)
  }
}
