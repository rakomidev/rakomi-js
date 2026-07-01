#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractBundledModules } from './lib/sdk-bundle-common.mjs'
import {
  enumeratePublishablePackages,
  GateError,
  matchTarballForPackage,
  packPackage,
  readTarball,
  readTarballFile,
  relGateMessage,
  REPO_ROOT,
} from './lib/sdk-supply-chain-common.mjs'
import { normalizePurl, prodClosureForSeeds } from './pnpm-ls-to-cdx.mjs'

export { normalizePurl }

const N41 = 'REL-GATE-N41'
const N42 = 'REL-GATE-N42'
const N4E = 'REL-GATE-N4E'
const N4P = 'REL-GATE-N4P'
const N4G = 'REL-GATE-N4G'

export function sbomComponentSet(sbom) {
  if (!sbom || typeof sbom !== 'object') throw new GateError('SBOM is not an object')
  if (sbom.bomFormat !== 'CycloneDX') throw new GateError(`SBOM bomFormat is "${sbom.bomFormat}", expected "CycloneDX" (components[] ≠ SPDX packages[])`)
  const comps = Array.isArray(sbom.components) ? sbom.components : []
  const set = new Set()
  for (const c of comps) {
    const key = c.purl ? normalizePurl(c.purl) : c.name && c.version ? `${c.name}@${c.version}` : c.name || null
    if (key) set.add(key)
  }
  return set
}

export function expectedSetFromMetafiles(metafiles) {
  const { bundled } = extractBundledModules(metafiles)
  const set = new Set()
  for (const [name, { version }] of bundled.entries()) set.add(`pkg:npm/${name}@${version}`)
  return set
}

export function prodExternalSeeds({ dependencies = {}, peerDependencies = {}, externals = null } = {}) {
  const peers = new Set(Object.keys(peerDependencies || {}))
  const base = Object.keys(dependencies || {}).filter((d) => !peers.has(d))
  if (externals === null) return base
  const ext = externals instanceof Set ? externals : new Set(externals)
  return base.filter((d) => ext.has(d))
}

export function lockfileClosureForSeeds(pkgName, seedNames) {
  const seeds = [...(seedNames instanceof Set ? seedNames : new Set(seedNames))]
  if (seeds.length === 0) return new Set()
  let out
  try {
    out = execFileSync('pnpm', ['ls', '--filter', pkgName, '--prod', '--json', '--depth', 'Infinity'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, NPM_PACKAGES_TOKEN: process.env.NPM_PACKAGES_TOKEN ?? '' },
    })
  } catch (e) {
    throw new GateError(`pnpm ls failed for ${pkgName}: ${String(e.stderr || e.message).slice(-200)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new GateError(`pnpm ls output for ${pkgName} is not valid JSON`)
  }
  try {
    return prodClosureForSeeds(parsed, seeds)
  } catch (e) {
    throw new GateError(`cannot derive lockfile prod closure for ${pkgName}: ${e.message}`)
  }
}

export function structuralVacuousGreen({ expectedSize, declaredProdCount }) {
  return expectedSize === 0 && declaredProdCount > 0
}

export function diffSboms(expected, actual) {
  const missing = [...expected].filter((k) => !actual.has(k)).sort()
  const added = [...actual].filter((k) => !expected.has(k)).sort()
  return { missing, added }
}

function readMetafiles(pkgDir) {
  const paths = ['esm', 'cjs'].map((f) => join(REPO_ROOT, pkgDir, 'dist', `metafile-${f}.json`)).filter(existsSync)
  return paths.map((p) => JSON.parse(readFileSync(p, 'utf8')))
}

function metafileHasInputs(metafiles) {
  return metafiles.some((m) => Object.values(m.outputs || {}).some((o) => Object.keys(o.inputs || {}).length > 0))
}

const argv = process.argv.slice(2)
const tarballIdx = argv.indexOf('--tarball')
const tarballDir = tarballIdx >= 0 ? argv[tarballIdx + 1] : null

const violations = []
const preconditions = []
const cannotEval = []
const warnings = []
const fail = (m) => { violations.push(m); console.error(`  ✗ ${m}`) }
const failPrecondition = (m) => { preconditions.push(m); console.error(`  ⛔ ${m}`) }
const failStructural = (m) => { cannotEval.push(m); console.error(`  ✗✗ ${m}`) }
const warn = (m) => { warnings.push(m); console.error(`  ⚠ ${m}`) }
const ok = (m) => console.error(`  ✓ ${m}`)

function main() {
  console.error('## sbom-equals-lockfile gate')
  const { packages, expectedCount } = enumeratePublishablePackages(REPO_ROOT)
  console.error(`## enumerated ${expectedCount} publishable package(s): ${packages.map((p) => p.name).join(', ')}`)

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
    packDest = mkdtempSync(join(tmpdir(), 'rakomi-sbom-tgz-'))
    for (const pkg of packages) {
      try { tarballs.set(pkg.name, packPackage(REPO_ROOT, pkg, packDest)) }
      catch (e) { fail(relGateMessage(N4E, 'CANNOT-EVALUATE', pkg.name, '', `pack failed: ${e.message}`)) }
    }
  }

  let inspected = 0
  try {
    for (const pkg of packages) {
      const tgz = tarballs.get(pkg.name)
      if (!tgz) { fail(relGateMessage(N4E, 'CANNOT-EVALUATE', pkg.name, '', 'no tarball available to inspect')); continue }

      const metafiles = readMetafiles(pkg.dir)
      const pj = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, 'package.json'), 'utf8'))
      const declaredProd = Object.keys(pj.dependencies || {})
      readTarball(tgz)
      const sbomText = readTarballFile(tgz, 'sbom.cdx.json')
      const metafileExists = metafiles.length > 0
      const groundTruth = metafileExists ? 'bundle+externals' : 'lockfile'

      let bundled = new Set()
      if (metafileExists) {
        if (!metafileHasInputs(metafiles)) {
          fail(relGateMessage(N4E, 'CANNOT-EVALUATE', pkg.name, '', 'metafile present but zero-input (truncated/broken build) — cannot derive the expected closed set (run the build)'))
          inspected++
          continue
        }
        bundled = expectedSetFromMetafiles(metafiles)
      }
      const externals = metafileExists ? extractBundledModules(metafiles).externals : null
      const seeds = prodExternalSeeds({ dependencies: pj.dependencies, peerDependencies: pj.peerDependencies, externals })
      let closure
      try { closure = lockfileClosureForSeeds(pkg.name, seeds) }
      catch (e) {
        if (e instanceof GateError) { fail(relGateMessage(N4E, 'CANNOT-EVALUATE', pkg.name, '', e.message)); inspected++; continue }
        throw e
      }
      const expected = new Set([...bundled, ...closure])

      if (structuralVacuousGreen({ expectedSize: expected.size, declaredProdCount: declaredProd.length })) {
        failStructural(relGateMessage(N4G, 'CANNOT-EVALUATE', pkg.name, '', `declares ${declaredProd.length} prod dependenc(ies) [${declaredProd.join(', ')}] but the derived expected component set is EMPTY (neither inlined nor externalised-and-resolved) — refusing a vacuous-green pass`, 'move a build/type-only dep to devDependencies, or fix the SBOM derivation model'))
        inspected++
        continue
      }

      let actual
      if (sbomText) {
        try { actual = sbomComponentSet(JSON.parse(sbomText)) }
        catch (e) { fail(relGateMessage(N4E, 'CANNOT-EVALUATE', pkg.name, '', `SBOM unparseable/not-CycloneDX: ${e.message}`)); inspected++; continue }
      } else {
        actual = new Set()
      }

      if (actual.size === 0) {
        if (expected.size === 0) {
          warn(`${pkg.name}: ${groundTruth} closed set is empty — nothing to verify`)
        } else if (bundled.size > 0) {
          fail(relGateMessage(N41, 'FAIL', pkg.name, '', `ships no/empty sbom.cdx.json but bundles ${bundled.size} inlined third-party component(s): ${[...bundled].join(', ')}`, 'generate + ship the SBOM'))
        } else {
          failPrecondition(relGateMessage(N4P, 'FAIL-PRECONDITION', pkg.name, '', `ships no/empty sbom.cdx.json but resolves ${expected.size} externalised runtime dep(s) [${[...expected].join(', ')}] — must ship a lockfile-equal SBOM before publish`, 'externalised-runtime-dep SBOM generation is wired upstream'))
        }
        inspected++
        continue
      }

      const { missing, added } = diffSboms(expected, actual)
      if (missing.length) fail(relGateMessage(N41, 'FAIL', pkg.name, '', `SBOM is MISSING ${missing.length} resolved component(s): ${missing.join(', ')}`, `CWE-1357 incomplete SBOM — regenerate from the ${groundTruth} ground truth`))
      if (added.length) fail(relGateMessage(N42, 'FAIL', pkg.name, '', `SBOM has ${added.length} fabricated/extra component(s) not in the closed set: ${added.join(', ')}`, `CWE-1357 falsified SBOM — regenerate from the ${groundTruth} ground truth`))
      if (!missing.length && !added.length) ok(`${pkg.name}: SBOM component set EQUALS the ${groundTruth}-derived closed set (${expected.size} component(s))`)
      inspected++
    }
  } finally {
    if (packDest) rmSync(packDest, { recursive: true, force: true })
  }

  if (inspected !== expectedCount) {
    fail(relGateMessage(N4E, 'CANNOT-EVALUATE', 'sbom-gate', '', `inspected ${inspected}, expected ${expectedCount} — package set under-covered (no-vacuous-green count-equality)`))
  } else {
    ok(`count-equality: inspected ${inspected} === expected ${expectedCount}`)
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (e) {
    if (e instanceof GateError) { console.error(`\nSBOM-EQUALS-LOCKFILE: CANNOT-EVALUATE — ${N4E}: ${e.message}`); process.exit(2) }
    console.error(`\nSBOM-EQUALS-LOCKFILE: CANNOT-EVALUATE — ${N4E}: unexpected: ${e.stack || e.message}`); process.exit(2)
  }

  console.error('\n## sbom-equals-lockfile summary')
  for (const w of warnings) console.error(`  • warning: ${w}`)
  if (cannotEval.length) {
    console.error(`\nSBOM-EQUALS-LOCKFILE: CANNOT-EVALUATE — ${N4G}: ${cannotEval.length} structural/underivable case(s)`)
    process.exit(2)
  }
  if (violations.length || preconditions.length) {
    if (violations.length === 0) {
      console.error(`\nSBOM-EQUALS-LOCKFILE: FAIL — PRECONDITIONS-ONLY (${preconditions.length} ${N4P}; documented coverage precondition, not a sabotage slip)`)
      process.exit(1)
    }
    console.error(`\nSBOM-EQUALS-LOCKFILE: FAIL (${violations.length + preconditions.length})`)
    process.exit(1)
  }
  console.error('\nSBOM-EQUALS-LOCKFILE: PASS')
}
