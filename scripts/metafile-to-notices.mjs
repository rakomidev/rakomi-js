#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractBundledModules, installedDir, licenseFilesIn, spdxId } from './lib/sdk-bundle-common.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null)
const pkgDirArg = flag('--pkg')
if (!pkgDirArg) {
  console.error('usage: metafile-to-notices.mjs --pkg <packageDir> [--out <path>]')
  process.exit(2)
}
const PKG_DIR = resolve(REPO_ROOT, pkgDirArg)
const OUT = flag('--out') ? resolve(REPO_ROOT, flag('--out')) : join(PKG_DIR, 'THIRD-PARTY-NOTICES')

function fail(msg) {
  console.error(`NOTICES-GATE: ${msg}`)
  process.exit(2)
}

const metaPaths = ['esm', 'cjs'].map((f) => join(PKG_DIR, 'dist', `metafile-${f}.json`)).filter(existsSync)
if (metaPaths.length === 0) fail(`no metafile-*.json under ${PKG_DIR}/dist — run the build first`)
const metafiles = metaPaths.map((p) => JSON.parse(readFileSync(p, 'utf8')))
const pkgManifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))

const { bundled } = extractBundledModules(metafiles)
const entries = [...bundled.entries()].sort((a, b) => a[0].localeCompare(b[0]))

const header = [
  `THIRD-PARTY SOFTWARE NOTICES AND INFORMATION`,
  ``,
  `For the npm package: ${pkgManifest.name}@${pkgManifest.version}`,
  ``,
  `This package's published bundle (\`dist/\`) INLINES the third-party components listed below.`,
  `Their copyright and permission notices are reproduced verbatim, as required by their licenses`,
  `(MIT permission-notice clause; Apache-2.0 §4(d) NOTICE propagation). This file is generated`,
  `from the build metafile by scripts/metafile-to-notices.mjs and ships in the package tarball.`,
  ``,
].join('\n')

if (entries.length === 0) {
  const body =
    header +
    `No third-party code is bundled into this package. All dependencies are external\n` +
    `(declared in "dependencies"/"peerDependencies") and resolved at install time, so their\n` +
    `notices are carried by their own published packages — not reproduced here.\n`
  writeFileSync(OUT, body)
  console.log(JSON.stringify({ pkg: pkgManifest.name, out: OUT.replace(REPO_ROOT + '/', ''), components: 0 }, null, 2))
  process.exit(0)
}

const sections = []
let copyrightSeen = false
for (const [name, { version, storeDir }] of entries) {
  const dir = installedDir(REPO_ROOT, name, storeDir)
  const files = licenseFilesIn(dir)
  if (files.length === 0) {
    const manifest = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {}
    fail(`inlined ${name}@${version} ships no LICENSE/NOTICE file (declared license: ${spdxId(manifest) || 'unknown'}) — cannot fulfil attribution`)
  }
  const parts = [`================================================================================`, `${name}@${version}`, `================================================================================`, ``]
  for (const f of files) {
    const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trimEnd()
    if (/copyright/i.test(text)) copyrightSeen = true
    parts.push(`--- ${basename(f)} ---`, ``, text, ``)
  }
  sections.push(parts.join('\n'))
}

if (!copyrightSeen) fail('no Copyright line found across any inlined dep license — attribution incomplete')

writeFileSync(OUT, header + sections.join('\n') + '\n')
console.log(JSON.stringify({ pkg: pkgManifest.name, out: OUT.replace(REPO_ROOT + '/', ''), components: entries.map(([n, v]) => `${n}@${v.version}`) }, null, 2))
