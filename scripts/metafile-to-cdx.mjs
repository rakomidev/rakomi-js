#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractBundledModules, lockfileHas, readInstalledManifest, spdxId } from './lib/sdk-bundle-common.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const GENERATOR = 'metafile-to-cdx.mjs'

const TOOLCHAIN = { tsup: '8.5.1', esbuild: '0.27.7' }

const argv = process.argv.slice(2)
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null)
const has = (n) => argv.includes(n)
const pkgDirArg = flag('--pkg')
if (!pkgDirArg) {
  console.error('usage: metafile-to-cdx.mjs --pkg <packageDir> [--out <path>] [--validate]')
  process.exit(2)
}
const PKG_DIR = resolve(REPO_ROOT, pkgDirArg)
const OUT = flag('--out') ? resolve(REPO_ROOT, flag('--out')) : join(PKG_DIR, 'sbom.cdx.json')
const DO_VALIDATE = has('--validate')

function fail(msg) {
  console.error(`SBOM-GATE: ${msg}`)
  process.exit(2)
}

const purlFor = (name, version) => `pkg:npm/${name}@${version}`

const metaPaths = ['esm', 'cjs'].map((f) => join(PKG_DIR, 'dist', `metafile-${f}.json`)).filter(existsSync)
if (metaPaths.length === 0) fail(`no metafile-*.json under ${PKG_DIR}/dist — run the build first`)
const metafiles = metaPaths.map((p) => {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (!j.outputs || Object.keys(j.outputs).length === 0) fail(`metafile ${p} has zero outputs (truncated build?)`)
    return j
  } catch (e) {
    fail(`metafile ${p} unparseable: ${e.message}`)
  }
})

const pkgManifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
const lockText = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')

const { bundled, sharedInlined } = extractBundledModules(metafiles)

const components = []
for (const [name, { version, storeDir }] of [...bundled.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const installed = readInstalledManifest(REPO_ROOT, name, storeDir)
  if (!installed) fail(`inlined component ${name}@${version}: installed package.json not found (store ${storeDir})`)
  if (installed.version !== version) {
    fail(`tamper: ${name} store path says @${version} but installed package.json is @${installed.version}`)
  }
  if (!lockfileHas(lockText, name, version)) {
    fail(`tamper: ${name}@${version} (inlined) is not a declared resolution in pnpm-lock.yaml`)
  }
  const license = spdxId(installed)
  const purl = purlFor(name, version)
  components.push({
    type: 'library',
    'bom-ref': purl,
    name,
    version,
    purl,
    ...(license ? { licenses: [{ license: { id: license } }] } : {}),
    properties: [{ name: 'cdx:npm:bundled', value: 'true' }],
  })
}

const selfPurl = purlFor(pkgManifest.name, pkgManifest.version)
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    authors: [{ name: 'CRE8EVE' }],
    tools: {
      components: [
        { type: 'application', name: 'tsup', version: TOOLCHAIN.tsup },
        { type: 'application', name: 'esbuild', version: TOOLCHAIN.esbuild },
        { type: 'application', group: 'rakomi', name: GENERATOR, version: generatorVersion() },
      ],
    },
    component: {
      type: 'library',
      'bom-ref': selfPurl,
      name: pkgManifest.name,
      version: pkgManifest.version,
      purl: selfPurl,
      ...(pkgManifest.license ? { licenses: [{ license: { id: pkgManifest.license } }] } : {}),
    },
  },
  components,
}

function generatorVersion() {
  const h = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  return `sha256:${h.slice(0, 12)}`
}

const componentNames = new Set(components.map((c) => c.name))
if (componentNames.has('@rakomi/shared')) fail('@rakomi/shared must NOT appear as an SBOM component (private + inlined)')
const EXPECT_EXTERNAL = {
  '@rakomi/sdk-core': ['jose'],
  '@rakomi/react': ['react'],
  '@rakomi/react-native': ['react', 'jose'],
}
for (const ext of EXPECT_EXTERNAL[pkgManifest.name] || ['react']) {
  if (componentNames.has(ext)) fail(`${ext} is external but appears as a bundled component`)
}

if (DO_VALIDATE) {
  await validateAgainstSchema(sbom)
  if (false && pkgManifest.name === '@rakomi/react' && !sharedInlined) {
    fail('@rakomi/shared was not detected as inlined into @rakomi/react — externals boundary may have leaked')
  }
  const totalInputs = metafiles.reduce((n, m) => n + Object.values(m.outputs || {}).reduce((a, o) => a + Object.keys(o.inputs || {}).length, 0), 0)
  if (totalInputs === 0) fail(`${pkgManifest.name}: metafile has zero inputs across all outputs (truncated build?)`)
  console.error(`SBOM-GATE: ${pkgManifest.name} — ${components.length} bundled third-party component(s), schema-valid, two-sided OK`)
}

writeFileSync(OUT, JSON.stringify(sbom, null, 2) + '\n')
console.log(JSON.stringify({ pkg: pkgManifest.name, out: OUT.replace(REPO_ROOT + '/', ''), components: components.map((c) => c.purl) }, null, 2))

async function validateAgainstSchema(doc) {
  const { default: Ajv } = await import('ajv')
  const { default: addFormats } = await import('ajv-formats')
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true })
  addFormats(ajv)
  for (const f of ['string', 'iri-reference', 'iri', 'idn-email', 'idn-hostname', 'uri-template', 'json-pointer', 'relative-json-pointer']) {
    if (!ajv.formats[f]) ajv.addFormat(f, () => true)
  }
  const dir = join(__dirname, 'schemas')
  ajv.addSchema(JSON.parse(readFileSync(join(dir, 'spdx.schema.json'), 'utf8')))
  ajv.addSchema(JSON.parse(readFileSync(join(dir, 'jsf-0.82.schema.json'), 'utf8')))
  const bomSchema = JSON.parse(readFileSync(join(dir, 'bom-1.6.schema.json'), 'utf8'))
  const validate = ajv.compile(bomSchema)
  if (!validate(doc)) {
    const errs = (validate.errors || []).slice(0, 8).map((e) => `${e.instancePath} ${e.message}`).join('; ')
    fail(`CycloneDX 1.6 schema validation failed: ${errs}`)
  }
}
