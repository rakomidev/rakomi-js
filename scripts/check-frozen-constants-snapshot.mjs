#!/usr/bin/env node

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  enumeratePublishablePackages,
  GateError,
  matchTarballForPackage,
  packPackage,
  readTarball,
  readTarballFile,
  relGateMessage,
  REPO_ROOT,
  tarballMembers,
} from './lib/sdk-supply-chain-common.mjs'

const PLATFORM_SRC = ['packages', 'shared', 'src', 'constants', 'platform.ts'].join('/')
const JWT_SRC = ['packages', 'api', 'src', 'lib', 'jwt.ts'].join('/')
const BLESSED_SNAPSHOT = 'frozen-constants.blessed.json'

const DIST_BUNDLE_RE = /^dist\/.*\.(c?js|mjs)$/
const DIST_TEST_FILE_RE = /\.(test|spec)\.(c?js|mjs)$/

const OBFUSCATION_TELLS = Object.freeze(['atob(', 'String.fromCharCode', "Buffer.from"])

const REJECTED_ALGS = Object.freeze(['HS256', 'HS384', 'HS512'])

function hostOf(url) {
  const m = /^https:\/\/([^/]+)/.exec(url)
  return m ? m[1] : ''
}

function hasNonAscii(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return true
  return false
}

export function parseBlessed(platformSrc, jwtSrc) {
  const constRe = (name) =>
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`)

  const grab = (name) => {
    const m = constRe(name).exec(platformSrc)
    if (!m) throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', PLATFORM_SRC, '', `cannot parse blessed export ${name} from ground-truth source`))
    return m[1]
  }

  const issuer = grab('RAKOMI_PLATFORM_ISSUER')
  const audience = grab('RAKOMI_PLATFORM_AUDIENCE')
  const endpoints = {
    authorization_endpoint: grab('RAKOMI_PLATFORM_AUTHORIZATION_ENDPOINT'),
    token_endpoint: grab('RAKOMI_PLATFORM_TOKEN_ENDPOINT'),
    jwks_uri: grab('RAKOMI_PLATFORM_JWKS_URI'),
    userinfo_endpoint: grab('RAKOMI_PLATFORM_USERINFO_ENDPOINT'),
  }

  const algM = /const\s+ALG\s*=\s*['"]([^'"]+)['"]/.exec(jwtSrc)
  if (!algM) throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', JWT_SRC, '', 'cannot parse `const ALG` from ground-truth source'))

  return finalizeBlessed({ issuer, audience, endpoints, alg: algM[1] }, PLATFORM_SRC)
}

export function finalizeBlessed({ issuer, audience, endpoints, alg }, srcLabel) {
  const hosts = new Set()
  for (const url of [issuer, audience, ...Object.values(endpoints)]) {
    const h = hostOf(url)
    if (!h) throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', srcLabel, '', `blessed value "${url}" is not a parseable https:// URL`))
    hosts.add(h)
  }
  for (const h of hosts) {
    if (hasNonAscii(h)) {
      throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', srcLabel, '', `blessed host "${h}" contains a non-ASCII byte`))
    }
  }
  if (alg !== 'RS256') throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', srcLabel, '', `blessed ALG is "${alg}", expected RS256 — ground-truth invariant violated`))
  return { issuer, audience, endpoints, hosts, alg }
}

export function parseBlessedJson(jsonText) {
  let raw
  try { raw = JSON.parse(jsonText) } catch (e) {
    throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', BLESSED_SNAPSHOT, '', `committed blessed snapshot is not valid JSON: ${e.message}`))
  }
  const req = (v, name) => {
    if (typeof v !== 'string' || v.length === 0) throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', BLESSED_SNAPSHOT, '', `missing/invalid string field "${name}"`))
    return v
  }
  const ep = raw.endpoints && typeof raw.endpoints === 'object' ? raw.endpoints : {}
  const endpoints = {
    authorization_endpoint: req(ep.authorization_endpoint, 'endpoints.authorization_endpoint'),
    token_endpoint: req(ep.token_endpoint, 'endpoints.token_endpoint'),
    jwks_uri: req(ep.jwks_uri, 'endpoints.jwks_uri'),
    userinfo_endpoint: req(ep.userinfo_endpoint, 'endpoints.userinfo_endpoint'),
  }
  return finalizeBlessed({ issuer: req(raw.issuer, 'issuer'), audience: req(raw.audience, 'audience'), endpoints, alg: req(raw.alg, 'alg') }, BLESSED_SNAPSHOT)
}

export function normalizeBundle(text) {
  return text.replace(/[ \t\r\n\f\v]+/g, ' ').replace(/['"`]/g, '"')
}

const SIGNOFF = 'named-individual sign-off in platform.ts required to re-bless'

function referencesIdentity(norm, blessed) {
  if (/RAKOMI_PLATFORM/i.test(norm)) return true
  for (const h of blessed.hosts) if (norm.includes(`https://${h}`)) return true
  return false
}

const REGION_WINDOW = 48
const IDENTITY_TOKEN_RE = /(?:\biss\b|issuer|\baud\b|audience|authorization_endpoint|token_endpoint|jwks|userinfo|\.well-known)/i

function inIdentityRegion(norm, idx, host, blessed) {
  if (blessed.hosts.has(host)) return true
  const lo = Math.max(0, idx - REGION_WINDOW)
  return IDENTITY_TOKEN_RE.test(norm.slice(lo, idx))
}

export function inspectBundle({ blessed, bundleText, pkgName, version = '', isOwnDist = true }) {
  const violations = []
  const norm = normalizeBundle(bundleText)
  const normLower = norm
  const fail = (code, finding, pointer) =>
    violations.push(relGateMessage(code, 'FROZEN-DRIFT', pkgName, version, finding, pointer))

  const denyRe = /https:\/\/([^\s"`/\\)<>]+)/g
  const reportedForeign = new Set()
  const reportedNonAscii = new Set()
  for (let m; (m = denyRe.exec(normLower)); ) {
    const host = m[1]
    if (!host) continue
    const idx = m.index
    if (hasNonAscii(host)) {
      if (inIdentityRegion(normLower, idx, host, blessed) && !reportedNonAscii.has(host)) {
        reportedNonAscii.add(host)
        fail('REL-GATE-N31', `FROZEN-NONASCII-HOST: non-ASCII byte in an https:// host in the issuer/endpoint region ("${host}") — Unicode-homoglyph spoof`, SIGNOFF)
      }
      continue
    }
    if (!blessed.hosts.has(host) && inIdentityRegion(normLower, idx, host, blessed) && !reportedForeign.has(host)) {
      reportedForeign.add(host)
      fail('REL-GATE-N34', `FROZEN-FOREIGN-HOST: https://${host} appears in the issuer/endpoint region but is outside the blessed allow-set {${[...blessed.hosts].join(', ')}} (substitutive/additive tamper)`, SIGNOFF)
    }
  }

  for (const bad of REJECTED_ALGS) {
    const re = new RegExp(`\\b${bad}\\b`, 'g')
    for (let m; (m = re.exec(norm)); ) {
      const lo = Math.max(0, m.index - REGION_WINDOW)
      const win = norm.slice(lo, m.index)
      if (/(?:algorithms?|\balg\b|accept)/i.test(win) && !/(?:reject|disallow|forbid|invalid|not |!=)/i.test(win)) {
        fail('REL-GATE-N35', `FROZEN-CRYPTO-DRIFT: rejected algorithm "${bad}" appears in an algorithm-acceptance region in shipped dist (HS-family acceptance path added)`, SIGNOFF)
        break
      }
    }
  }

  if (isOwnDist) {
    const normNoSpace = norm.replace(/ /g, '')
    for (const tell of OBFUSCATION_TELLS) {
      const needle = tell.replace(/\s+/g, '')
      let from = 0
      for (;;) {
        const idx = normNoSpace.indexOf(needle, from)
        if (idx < 0) break
        from = idx + needle.length
        if (nearIdentityToken(normNoSpace, idx)) {
          fail('REL-GATE-N36', `FROZEN-OBFUSCATION-SUSPECT: obfuscation/runtime-assembly call "${tell}" near an identity/issuer region in own-dist (a base64-assembled issuer would evade the literal scan)`, SIGNOFF)
          break
        }
      }
    }
  }

  const issuerLit = normalizeBundle(blessed.issuer)
  const escLit = issuerLit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sawIssuerLit = norm.includes(issuerLit)
  let sawIssuerAssigned = false
  if (sawIssuerLit) {
    sawIssuerAssigned = new RegExp(`(?:\\biss\\b|issuer|\\baud\\b|audience)[^=:]{0,40}[=:]\\s*"?${escLit}`, 'i').test(norm)
  }
  const presentEndpointUrls = Object.values(blessed.endpoints).filter((u) => norm.includes(normalizeBundle(u)))
  const NON_KEY_ENDPOINTS = [blessed.endpoints.authorization_endpoint, blessed.endpoints.token_endpoint, blessed.endpoints.userinfo_endpoint]
  const shipsEndpointMetadata = NON_KEY_ENDPOINTS.some((u) => norm.includes(normalizeBundle(u)))
  return {
    violations,
    norm,
    sawIdentity: referencesIdentity(norm, blessed),
    sawIssuerLit,
    sawIssuerAssigned,
    sawAlg: norm.includes(blessed.alg),
    sawWellKnownPath: norm.includes('.well-known/jwks.json'),
    presentEndpointUrls,
    shipsEndpointMetadata,
  }
}

const OBF_WINDOW = 80
function nearIdentityToken(normNoSpace, idx) {
  const lo = Math.max(0, idx - OBF_WINDOW)
  const win = normNoSpace.slice(lo, idx + OBF_WINDOW)
  return /https:\/\/|iss|issuer|alg/i.test(win)
}

export function aggregatePackageRequireBlessed({ blessed, fileReports, pkgName, version = '' }) {
  const violations = []
  const fail = (code, finding) =>
    violations.push(relGateMessage(code, 'FROZEN-DRIFT', pkgName, version, finding, SIGNOFF))

  const issuerLitSomewhere = fileReports.some((r) => r.sawIssuerLit)
  if (!issuerLitSomewhere) return { violations, requireBlessedApplied: false }

  const issuerAssignedSomewhere = fileReports.some((r) => r.sawIssuerAssigned)
  if (!issuerAssignedSomewhere) {
    fail('REL-GATE-N33', `FROZEN-ISSUER-NOT-ASSIGNED: blessed issuer "${blessed.issuer}" present but never in an assigned (issuer/aud = ...) position — possible dead-path-only retention`)
  }
  if (!fileReports.some((r) => r.sawAlg)) {
    fail('REL-GATE-N35', `FROZEN-CRYPTO-DRIFT: blessed ALG "${blessed.alg}" absent from a package that ships platform identity (RS256-only guard dropped)`)
  }
  const shipsMetadata = fileReports.some((r) => r.shipsEndpointMetadata)
  if (shipsMetadata) {
    const presentUrls = new Set(fileReports.flatMap((r) => r.presentEndpointUrls))
    for (const [name, url] of Object.entries(blessed.endpoints)) {
      if (!presentUrls.has(url)) {
        fail('REL-GATE-N32', `FROZEN-MISSING-BLESSED: blessed ${name} "${url}" absent from a metadata-bearing dist (host/endpoint swapped or dropped)`)
      }
    }
    if (!fileReports.some((r) => r.sawWellKnownPath)) {
      fail('REL-GATE-N32', 'FROZEN-MISSING-BLESSED: ".well-known/jwks.json" path absent from a metadata-bearing dist')
    }
  }
  return { violations, requireBlessedApplied: true }
}

const violationsAll = []
const fail = (m) => { violationsAll.push(m); console.error(`  ✗ ${m}`) }
const ok = (m) => console.error(`  ✓ ${m}`)

export function blessedCoreEquals(a, b) {
  if (a.issuer !== b.issuer || a.audience !== b.audience || a.alg !== b.alg) return false
  const ea = a.endpoints || {}
  const eb = b.endpoints || {}
  const keys = ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint']
  return keys.every((k) => ea[k] === eb[k])
}

function readGroundTruth() {
  const blessedPath = join(REPO_ROOT, BLESSED_SNAPSHOT)
  const platformAbs = join(REPO_ROOT, PLATFORM_SRC)
  const jwtAbs = join(REPO_ROOT, JWT_SRC)
  const hasBlessed = existsSync(blessedPath)
  const hasSource = existsSync(platformAbs) && existsSync(jwtAbs)

  if (!hasSource) {
    if (!hasBlessed) {
      throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', BLESSED_SNAPSHOT, '',
        `no ground truth: neither a committed ${BLESSED_SNAPSHOT} nor the upstream ground-truth constant sources are present — refusing to self-compare against the tarball dist (fail-loud)`))
    }
    let jsonText
    try { jsonText = readFileSync(blessedPath, 'utf8') }
    catch (e) { throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', BLESSED_SNAPSHOT, '', `committed blessed snapshot unreadable: ${e.message}`)) }
    console.error(`## ground truth: committed ${BLESSED_SNAPSHOT} (public/orphan context — decoupled, independent of the inspected tarball)`)
    return parseBlessedJson(jsonText)
  }

  let platformSrc, jwtSrc
  try { platformSrc = readFileSync(platformAbs, 'utf8') }
  catch (e) { throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', PLATFORM_SRC, '', `ground-truth source unreadable: ${e.message}`)) }
  try { jwtSrc = readFileSync(jwtAbs, 'utf8') }
  catch (e) { throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', JWT_SRC, '', `ground-truth source unreadable: ${e.message}`)) }
  const fromSource = parseBlessed(platformSrc, jwtSrc)

  if (hasBlessed) {
    let committed
    try { committed = parseBlessedJson(readFileSync(blessedPath, 'utf8')) }
    catch (e) { throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', BLESSED_SNAPSHOT, '', `committed blessed snapshot present alongside the source but unparseable: ${e.message}`)) }
    if (!blessedCoreEquals(committed, fromSource)) {
      throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', BLESSED_SNAPSHOT, '',
        `committed ${BLESSED_SNAPSHOT} is STALE — it does not match a fresh re-derivation from ${PLATFORM_SRC} / ${JWT_SRC} (regenerate via scripts/gen-frozen-constants-blessed.mjs; a stale snapshot silently disarms the RS256/issuer tamper-detector in the orphan)`))
    }
    console.error(`## ground truth: upstream source ${PLATFORM_SRC} + ${JWT_SRC} (committed ${BLESSED_SNAPSHOT} verified FRESH against source)`)
    return fromSource
  }
  console.error(`## ground truth: upstream source ${PLATFORM_SRC} + ${JWT_SRC}`)
  return fromSource
}

function main() {
  console.error('## frozen-constants-snapshot gate')
  const argv = process.argv.slice(2)
  const tarballIdx = argv.indexOf('--tarball')
  const tarballDir = tarballIdx >= 0 ? argv[tarballIdx + 1] : null

  const blessed = readGroundTruth()
  console.error(`## blessed snapshot: iss=${blessed.issuer}, allow-set={${[...blessed.hosts].join(', ')}}, ALG=${blessed.alg}`)

  const { packages, expectedCount } = enumeratePublishablePackages(REPO_ROOT)
  console.error(`## enumerated ${expectedCount} publishable package(s): ${packages.map((p) => p.name).join(', ')}`)

  let packDest = null
  const tarballs = new Map()
  const versions = new Map()
  if (tarballDir) {
    if (!existsSync(tarballDir)) throw new GateError(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', '-', '', `--tarball dir does not exist: ${tarballDir}`))
    const present = readdirSync(tarballDir).filter((f) => f.endsWith('.tgz'))
    for (const pkg of packages) {
      const pj = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, 'package.json'), 'utf8'))
      const flatName = `${pj.name.replace('@', '').replace(/\//g, '-')}`
      const hit = matchTarballForPackage(present, flatName, pj.version)
      if (hit) { tarballs.set(pkg.name, join(tarballDir, hit)); versions.set(pkg.name, pj.version) }
    }
  } else {
    packDest = mkdtempSync(join(tmpdir(), 'rakomi-frozen-tgz-'))
    for (const pkg of packages) {
      try {
        tarballs.set(pkg.name, packPackage(REPO_ROOT, pkg, packDest))
        const pj = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, 'package.json'), 'utf8'))
        versions.set(pkg.name, pj.version)
      } catch (e) { fail(`${pkg.name}: pack failed: ${e.message}`) }
    }
  }

  let inspected = 0
  try {
    for (const pkg of packages) {
      const tgz = tarballs.get(pkg.name)
      if (!tgz) { fail(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', pkg.name, '', 'no tarball available to inspect (pack failed or absent in --tarball dir)')); continue }
      const version = versions.get(pkg.name) || ''
      readTarball(tgz)
      const members = tarballMembers(tgz).filter((f) => DIST_BUNDLE_RE.test(f) && !DIST_TEST_FILE_RE.test(f))
      if (members.length === 0) {
        fail(relGateMessage('REL-GATE-N32', 'FROZEN-DRIFT', pkg.name, version, 'no dist/*.{js,cjs,mjs} bundle in tarball — the inlined frozen constants cannot be verified'))
        inspected++
        continue
      }
      inspected++
      let pkgViolations = 0
      const fileReports = []
      for (const member of members) {
        const text = readTarballFile(tgz, member)
        const report = inspectBundle({ blessed, bundleText: text, pkgName: `${pkg.name}:${member}`, version, isOwnDist: true })
        report.violations.forEach(fail)
        pkgViolations += report.violations.length
        fileReports.push(report)
      }
      const agg = aggregatePackageRequireBlessed({ blessed, fileReports, pkgName: pkg.name, version })
      agg.violations.forEach(fail)
      pkgViolations += agg.violations.length
      if (pkgViolations === 0) {
        const scope = agg.requireBlessedApplied ? 'require-blessed + deny-foreign + RS256-only' : 'no platform-identity in dist — deny-foreign/non-ASCII/obfuscation only'
        ok(`${pkg.name}: ${members.length} dist bundle(s) clean (${scope})`)
      }
    }
  } finally {
    if (packDest) rmSync(packDest, { recursive: true, force: true })
  }

  if (inspected !== expectedCount) {
    fail(relGateMessage('REL-GATE-N3E', 'CANNOT-EVALUATE', '-', '', `inspected ${inspected}, expected ${expectedCount} — package set under-covered (no-vacuous-green count-equality)`))
  } else {
    ok(`count-equality: inspected ${inspected} === expected ${expectedCount}`)
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (e) {
    if (e instanceof GateError) { console.error(`\nFROZEN-CONSTANTS-SNAPSHOT: CANNOT-EVALUATE — ${e.message}`); process.exit(2) }
    console.error(`\nFROZEN-CONSTANTS-SNAPSHOT: CANNOT-EVALUATE — unexpected: ${e.stack || e.message}`); process.exit(2)
  }
  console.error('\n## frozen-constants-snapshot summary')
  if (violationsAll.length) {
    console.error(`\nFROZEN-CONSTANTS-SNAPSHOT: FAIL (${violationsAll.length})`)
    process.exit(1)
  }
  console.error('\nFROZEN-CONSTANTS-SNAPSHOT: PASS')
}
