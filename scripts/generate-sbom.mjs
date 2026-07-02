#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeExpectedComponentSet } from './check-sbom-equals-lockfile.mjs'
import { spdxId } from './lib/sdk-bundle-common.mjs'
import { loadDenylist, scanText } from './lib/sdk-public-denylist.mjs'
import { enumeratePublishablePackages, GateError, REPO_ROOT } from './lib/sdk-supply-chain-common.mjs'
import { normalizePurl } from './pnpm-ls-to-cdx.mjs'

export const CDX_SPEC_VERSION = '1.6'

export const PUBLISHABLE_PACKAGE_COUNT = 4

export function parsePurl(purl) {
  const norm = normalizePurl(purl)
  if (!norm.startsWith('pkg:npm/')) throw new GateError(`generate-sbom: not an npm purl: ${purl}`)
  const [body] = norm.slice('pkg:npm/'.length).split('?')
  const at = body.lastIndexOf('@')
  if (at <= 0) throw new GateError(`generate-sbom: malformed purl (no version): ${purl}`)
  return { name: body.slice(0, at), version: body.slice(at + 1) }
}

function readInstalledDepManifest(name, version, repoRoot) {
  const readJson = (p) => {
    try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null } catch { return null }
  }
  if (name.startsWith('@rakomi/')) {
    const pkgsDir = join(repoRoot, 'packages')
    if (existsSync(pkgsDir)) {
      for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const m = readJson(join(pkgsDir, entry.name, 'package.json'))
        if (m && m.name === name) return m
      }
    }
  }
  const flat = name.replace(/\//g, '+')
  const pnpmDir = join(repoRoot, 'node_modules/.pnpm')
  if (existsSync(pnpmDir)) {
    const prefix = `${flat}@${version}`
    const hit = readdirSync(pnpmDir).find((d) => d === prefix || d.startsWith(`${prefix}_`) || d.startsWith(`${prefix}(`))
    if (hit) {
      const m = readJson(join(pnpmDir, hit, 'node_modules', name, 'package.json'))
      if (m) return m
    }
  }
  return readJson(join(repoRoot, 'node_modules', name, 'package.json'))
}

export function licenseEntryFor(name, version, repoRoot = REPO_ROOT) {
  const manifest = readInstalledDepManifest(name, version, repoRoot)
  const raw = manifest ? spdxId(manifest) : null
  if (!raw) return { license: { name: 'NOASSERTION' } }
  if (/[()]| OR | AND | WITH /.test(raw)) return { expression: raw }
  return { license: { id: raw } }
}

const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function buildSbomDoc(pkg, { repoRoot = REPO_ROOT } = {}) {
  const { expected, manifest } = computeExpectedComponentSet(pkg, { repoRoot })
  const selfPurl = `pkg:npm/${manifest.name.startsWith('@') ? '%40' + manifest.name.slice(1).replace(/\//g, '%2F') : manifest.name}@${manifest.version}`
  const components = [...expected].sort(byCodepoint).map((purl) => {
    const { name, version } = parsePurl(purl)
    return {
      type: 'library',
      'bom-ref': purl,
      name,
      version,
      purl,
      licenses: [licenseEntryFor(name, version, repoRoot)],
    }
  })
  if (components.some((c) => c.name === '@rakomi/shared')) {
    throw new GateError(`${pkg.name}: @rakomi/shared appeared as an SBOM component (private + inlined) — the inline topology assumption changed; re-examine before shipping`)
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: CDX_SPEC_VERSION,
    version: 1,
    metadata: {
      authors: [{ name: 'CRE8EVE' }],
      tools: { components: [{ type: 'application', group: 'rakomi', name: 'generate-sbom', version: generatorVersion() }] },
      component: {
        type: 'library',
        'bom-ref': selfPurl,
        name: manifest.name,
        version: manifest.version,
        purl: selfPurl,
        ...(manifest.license ? { licenses: [licenseEntryFor(manifest.name, manifest.version, repoRoot)] } : {}),
      },
    },
    components,
  }
}

let _genVersion = null
function generatorVersion() {
  if (_genVersion) return _genVersion
  const h = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  _genVersion = `sha256:${h.slice(0, 12)}`
  return _genVersion
}

export function serializeSbom(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`
}

export function sbomScannableText(doc) {
  const lines = []
  const push = (s) => { if (typeof s === 'string' && s.length) lines.push(s) }
  const licenseStr = (ls) => (ls || []).forEach((l) => { push(l.expression); push(l.license?.id); push(l.license?.name) })
  const c = doc.metadata?.component
  if (c) { push(c.name); push(normalizePurl(c.purl || '')); licenseStr(c.licenses) }
  for (const t of doc.metadata?.tools?.components || []) { push(t.name); push(t.group); push(t.version) }
  for (const comp of doc.components || []) {
    push(comp.name); push(normalizePurl(comp.purl || '')); push(normalizePurl(comp['bom-ref'] || '')); licenseStr(comp.licenses)
  }
  return lines.join('\n')
}

export function scanSbomForDenylist(doc, denylist) {
  const hits = scanText(denylist, sbomScannableText(doc))
  hits.push(...scanText(denylist, serializeSbom(doc)))
  return hits
}

async function validateAgainstSchema(doc) {
  const { default: Ajv } = await import('ajv')
  const { default: addFormats } = await import('ajv-formats')
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true })
  addFormats(ajv)
  for (const f of ['string', 'iri-reference', 'iri', 'idn-email', 'idn-hostname', 'uri-template', 'json-pointer', 'relative-json-pointer']) {
    if (!ajv.formats[f]) ajv.addFormat(f, () => true)
  }
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'schemas')
  ajv.addSchema(JSON.parse(readFileSync(join(dir, 'spdx.schema.json'), 'utf8')))
  ajv.addSchema(JSON.parse(readFileSync(join(dir, 'jsf-0.82.schema.json'), 'utf8')))
  const validate = ajv.compile(JSON.parse(readFileSync(join(dir, 'bom-1.6.schema.json'), 'utf8')))
  if (!validate(doc)) {
    const errs = (validate.errors || []).slice(0, 8).map((e) => `${e.instancePath} ${e.message}`).join('; ')
    throw new GateError(`CycloneDX ${CDX_SPEC_VERSION} schema validation failed: ${errs}`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null)
  const has = (n) => argv.includes(n)
  const pkgArg = flag('--pkg')
  const doValidate = has('--validate')
  const toStdout = has('--stdout')

  const { packages, expectedCount } = enumeratePublishablePackages(REPO_ROOT)
  const targets = pkgArg ? packages.filter((p) => p.dir === pkgArg || p.name === pkgArg) : packages
  if (targets.length === 0) throw new GateError(`no publishable package matches --pkg ${pkgArg}`)
  if (!pkgArg && expectedCount !== PUBLISHABLE_PACKAGE_COUNT) {
    throw new GateError(`publishable-package count drift: enumerated ${expectedCount}, pinned ${PUBLISHABLE_PACKAGE_COUNT} — add the package deliberately (update PUBLISHABLE_PACKAGE_COUNT + fixtures)`)
  }

  const denylist = loadDenylist(REPO_ROOT)
  for (const pkg of targets) {
    const doc = buildSbomDoc(pkg)
    if (doValidate) await validateAgainstSchema(doc)
    const hits = scanSbomForDenylist(doc, denylist)
    if (hits.length) {
      throw new GateError(`${pkg.name}: generated SBOM carries deny-list term(s) [${hits.slice(0, 6).map((h) => h.category).join(', ')}] — refusing to ship an internal tell into the permanently-public SBOM`)
    }
    const text = serializeSbom(doc)
    if (toStdout) {
      process.stdout.write(text)
    } else {
      const out = join(REPO_ROOT, pkg.dir, 'sbom.cdx.json')
      writeFileSync(out, text)
      console.error(`  ✓ ${pkg.name}: wrote ${pkg.dir}/sbom.cdx.json (${doc.components.length} component(s)${doValidate ? ', schema-valid' : ''}, deny-scan clean)`)
    }
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    if (e instanceof GateError) { console.error(`\nGENERATE-SBOM: FAIL — ${e.message}`); process.exit(2) }
    console.error(`\nGENERATE-SBOM: FAIL — unexpected: ${e.stack || e.message}`); process.exit(2)
  })
}
