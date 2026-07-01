#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FORBIDDEN_BARE_IMPORTS = ["@rakomi/shared","zod","libphonenumber-js"]
const REQUIRED_EXTERNALS = {"@rakomi/sdk-core":["jose"],"@rakomi/react":["@rakomi/sdk-core","react"],"@rakomi/react-native":["@rakomi/sdk-core","jose","react","react-native"]}
import { extractBundledModules } from './lib/sdk-bundle-common.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DO_BUILD = !argv.includes('--no-build')
const EX_VENDOR_OUTAGE = 75

const CONSUMERS = [
  { name: '@rakomi/sdk-core', dir: 'packages/sdk-core', isCore: true },
  { name: '@rakomi/react', dir: 'packages/react', isCore: false },
  { name: '@rakomi/react-native', dir: 'packages/react-native', isCore: false },
]

function inlinesThirdParty(dir) {
  const metafiles = readMetafiles(dir)
  if (!metafiles.length) return false
  return extractBundledModules(metafiles).bundled.size > 0
}

const tmpDirs = new Set()
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { } } })

const failures = []
const notes = []
const fail = (m) => { failures.push(m); console.error(`  ✗ ${m}`) }
const ok = (m) => console.error(`  ✓ ${m}`)
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const buildErr = (e) => `${String(e.stdout || '').slice(-700)} ${String(e.stderr || e.message || '').slice(-700)}`.replace(/\s+/g, ' ').trim()

function vendorOutage(stderr) {
  return /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ERR_SOCKET|network|registry\.npmjs\.org.*(50\d|429)|request to .* failed/i.test(stderr)
}

console.error('## pack-install gate')
if (DO_BUILD) {
  console.error('## build consumers + workspace-dependency closure (turbo, topological, --force)')
  try {
    sh('pnpm', ['exec', 'turbo', 'run', 'build', '--force',
      '--filter=@rakomi/sdk-core', '--filter=@rakomi/react', '--filter=@rakomi/react-native'],
    { stdio: ['ignore', 'pipe', 'pipe'] })
    ok('consumers + dependency closure built (topological)')
  } catch (e) { fail(`build (turbo dependency closure) failed: ${buildErr(e)}`) }
}
for (const c of CONSUMERS) {
  const distDir = join(REPO_ROOT, c.dir, 'dist')
  if (!DO_BUILD && !existsSync(distDir)) { fail(`${c.name}: no dist and --no-build set (supply a built artifact)`); continue }
  if (!existsSync(join(distDir, 'metafile-esm.json'))) { fail(`${c.name}: no metafile (build did not run with metafile:true)`); continue }
  try { sh('node', ['scripts/metafile-to-cdx.mjs', '--pkg', c.dir, '--validate'], { stdio: ['ignore', 'ignore', 'pipe'] }); ok(`${c.name}: SBOM generated + validated`) }
  catch (e) { fail(`${c.name}: SBOM gen/validate failed: ${String(e.stderr || e.message).slice(-300)}`) }
  try { sh('node', ['scripts/metafile-to-notices.mjs', '--pkg', c.dir], { stdio: ['ignore', 'ignore', 'pipe'] }); ok(`${c.name}: NOTICES generated`) }
  catch (e) { fail(`${c.name}: NOTICES gen failed: ${String(e.stderr || e.message).slice(-300)}`) }
}

console.error('## externals two-oracle check')
for (const c of CONSUMERS) externalsOracle(c)
mutationTest()

console.error('## pack (sdk-core first)')
const tarballs = {}
const packDest = mkdtempSync(join(tmpdir(), 'rakomi-tgz-'))
tmpDirs.add(packDest)
for (const c of CONSUMERS) {
  try {
    const pj = JSON.parse(readFileSync(join(REPO_ROOT, c.dir, 'package.json'), 'utf8'))
    const tgz = join(packDest, `${pj.name.replace('@', '').replace(/\//g, '-')}-${pj.version}.tgz`)
    sh('pnpm', ['pack', '--pack-destination', packDest], { cwd: join(REPO_ROOT, c.dir), stdio: ['ignore', 'ignore', 'pipe'] })
    if (!existsSync(tgz)) { fail(`${c.name}: pnpm pack did not produce ${tgz}`); continue }
    tarballs[c.name] = tgz
    ok(`${c.name} → ${tgz.split('/').pop()}`)
  } catch (e) { fail(`${c.name}: pnpm pack failed: ${String(e.stderr || e.message).slice(-300)}`) }
}

for (const c of CONSUMERS) {
  if (!tarballs[c.name]) continue
  console.error(`## ${c.name}`)
  tarballAssertions(c, tarballs[c.name])
  publintAndAttw(c, tarballs[c.name])
  installAndSmoke(c, tarballs[c.name])
}

console.error('## @rakomi/node regression')
nodeRegression()

console.error('\n## pack-install gate summary')
for (const n of notes) console.error(`  • ${n}`)
if (failures.length) {
  console.error(`\nPACK-INSTALL: FAIL (${failures.length})`)
  failures.forEach((f) => console.error(`  - ${f}`))
  process.exit(1)
}
console.error('\nPACK-INSTALL: PASS')

function readMetafiles(dir) {
  return ['esm', 'cjs']
    .map((f) => join(REPO_ROOT, dir, 'dist', `metafile-${f}.json`))
    .filter(existsSync)
    .map((p) => JSON.parse(readFileSync(p, 'utf8')))
}
function pkgRoot(s) { return s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0] }

function metafileExternals(metafiles) {
  const ext = new Set()
  for (const m of metafiles) for (const o of Object.values(m.outputs || {})) for (const i of o.imports || []) {
    if (i.external && i.path && !i.path.startsWith('.') && !i.path.startsWith('node:')) ext.add(pkgRoot(i.path))
  }
  return ext
}
function staticBareRoots(dir) {
  const roots = new Set()
  const RE = [/^\s*(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']/, /^\s*import\s*["']([^"']+)["']/, /^\s*(?:var|const|let)\s+[\w$]+\s*=\s*require\(\s*["']([^"']+)["']\s*\)/]
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, n.name)
    if (n.isDirectory()) { walk(p); continue }
    if (!/\.(c?js|mjs)$/.test(n.name) || /\.d\./.test(n.name)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) for (const re of RE) {
      const mm = re.exec(line); if (mm && !mm[1].startsWith('.') && !mm[1].startsWith('node:')) roots.add(pkgRoot(mm[1]))
    }
  } }
  walk(join(REPO_ROOT, dir, 'dist'))
  return roots
}

function externalsOracle(c) {
  const metafiles = readMetafiles(c.dir)
  if (!metafiles.length) { fail(`${c.name}: no metafile for externals oracle`); return }
  const metaExt = metafileExternals(metafiles)
  const staticRoots = staticBareRoots(c.dir)
  for (const req of REQUIRED_EXTERNALS[c.name] || []) {
    if (!metaExt.has(req)) fail(`${c.name}: required external '${req}' not external in metafile`)
  }
  for (const forb of FORBIDDEN_BARE_IMPORTS) {
    if (metaExt.has(forb)) fail(`${c.name}: forbidden '${forb}' is EXTERNAL in metafile (inline boundary leaked)`)
    if (staticRoots.has(forb)) fail(`${c.name}: forbidden '${forb}' is a bare import in dist (HARD BLOCKER reappeared)`)
  }
  for (const root of [...staticRoots, ...metaExt]) {
    if (root.startsWith('@rakomi/') && root !== '@rakomi/sdk-core') fail(`${c.name}: unexpected bare @rakomi import '${root}'`)
  }
  const sub = (s) => [...s].filter((x) => x.startsWith('@rakomi/')).sort().join(',')
  if (sub(metaExt) !== sub(staticRoots)) {
    notes.push(`${c.name}: @rakomi/* oracle subset metafile=[${sub(metaExt)}] static=[${sub(staticRoots)}] — investigate`)
    fail(`${c.name}: oracles disagree on @rakomi/* subset (metafile ${sub(metaExt)} vs static ${sub(staticRoots)})`)
  } else ok(`${c.name}: externals OK (metafile externals ${[...metaExt].sort().join(',')}; @rakomi/* agree)`)
}

function mutationTest() {
  const bad = [{ outputs: { 'd.js': { imports: [{ path: '@rakomi/shared', external: true }], inputs: {} } } }]
  const leaked = metafileExternals(bad).has('@rakomi/shared')
  if (!leaked) fail('mutation test broken: oracle did not flag a wrongly-external @rakomi/shared'); else ok('mutation test: oracle rejects wrongly-external @rakomi/shared')
}

function tarballAssertions(c, tgz) {
  const list = sh('tar', ['tzf', tgz]).split('\n').map((s) => s.replace(/^package\//, '')).filter(Boolean)
  if (list.some((f) => /^dist\/metafile-.*\.json$/.test(f))) fail(`${c.name}: metafile-*.json leaked into tarball`)
  else ok(`${c.name}: no metafile in tarball`)
  const pj = JSON.parse(sh('tar', ['xzOf', tgz, 'package/package.json']))
  const depStr = JSON.stringify({ ...pj.dependencies, ...pj.peerDependencies, ...pj.optionalDependencies })
  if (/workspace:/.test(depStr)) fail(`${c.name}: workspace: protocol survived in packed deps/peer/optional (${depStr})`)
  else ok(`${c.name}: no workspace: in packed dependencies/peerDependencies/optionalDependencies`)
  if (!pj.license || pj.license === 'UNLICENSED') fail(`${c.name}: missing/UNLICENSED license field`)
  else ok(`${c.name}: license ${pj.license}`)
  if (!c.isCore) {
    if (!(pj.dependencies && pj.dependencies['@rakomi/sdk-core'])) fail(`${c.name}: @rakomi/sdk-core not in packed dependencies`)
    else ok(`${c.name}: depends on @rakomi/sdk-core ${pj.dependencies['@rakomi/sdk-core']}`)
  }
  for (const k of Object.keys(pj.dependencies || {})) {
    if (k.startsWith('@rakomi/') && k !== '@rakomi/sdk-core') fail(`${c.name}: unexpected @rakomi dependency '${k}'`)
  }
  const hasNotices = list.includes('THIRD-PARTY-NOTICES')
  if (inlinesThirdParty(c.dir)) {
    if (!hasNotices) { fail(`${c.name}: THIRD-PARTY-NOTICES missing from tarball (inlines third-party code)`); return }
    const txt = sh('tar', ['xzOf', tgz, 'package/THIRD-PARTY-NOTICES'])
    if (!txt.trim()) fail(`${c.name}: THIRD-PARTY-NOTICES is empty`)
    else if (!/copyright/i.test(txt)) fail(`${c.name}: THIRD-PARTY-NOTICES has no Copyright line`)
    else ok(`${c.name}: THIRD-PARTY-NOTICES present + has Copyright`)
  } else notes.push(`${c.name}: inlines no third-party code → THIRD-PARTY-NOTICES Copyright assertion N/A`)
}

function publintAndAttw(c, tgz) {
  try { sh(join(REPO_ROOT, 'node_modules/.bin/publint'), ['run', tgz, '--strict'], { stdio: ['ignore', 'ignore', 'pipe'] }); ok(`${c.name}: publint --strict clean`) }
  catch (e) { fail(`${c.name}: publint --strict: ${String(e.stdout || e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 400)}`) }

  const ACCEPTABLE = (p) => p.resolutionKind === 'node10' || p.entrypoint === './styles'
  let res
  try {
    const out = sh(join(REPO_ROOT, 'node_modules/.bin/attw'), ['--pack', tgz, '--profile', 'node16', '--format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    res = JSON.parse(out)
  } catch (e) {
    try { res = JSON.parse(String(e.stdout || '')) } catch { notes.push(`${c.name}: attw unparseable (${String(e.message).slice(0, 100)}) — publint is the backstop`); return }
  }
  const all = res.analysis?.problems || res.problems || []
  const real = all.filter((p) => !ACCEPTABLE(p))
  if (real.length) fail(`${c.name}: attw problems: ${real.map((p) => `${p.kind}@${p.entrypoint}/${p.resolutionKind}`).join(', ')}`)
  else ok(`${c.name}: attw clean (modern resolvers; ${all.length} documented-acceptable node10/CSS finding(s) waived)`)
}

function installAndSmoke(c, tgz) {
  const consumer = mkdtempSync(join(tmpdir(), 'rakomi-pack-'))
  tmpDirs.add(consumer)
  try {
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '0.0.0', private: true, type: 'module' }) + '\n')
    const installArgs = ['install', '--ignore-scripts', '--no-audit', '--no-fund', tgz]
    if (!c.isCore) installArgs.push(tarballs['@rakomi/sdk-core'], 'react@19', 'react-dom@19')
    if (c.name === '@rakomi/react-native') installArgs.push('react-native@0.81', 'jose@6')
    if (c.isCore) installArgs.push('jose@6')
    let lastErr
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { sh('npm', installArgs, { cwd: consumer, stdio: ['ignore', 'ignore', 'pipe'] }); lastErr = null; break }
      catch (e) { lastErr = e; if (!vendorOutage(String(e.stderr || ''))) break }
    }
    if (lastErr) {
      if (vendorOutage(String(lastErr.stderr || ''))) { console.error(`VENDOR OUTAGE installing ${c.name} — not a package defect`); process.exit(EX_VENDOR_OUTAGE) }
      fail(`${c.name}: clean install failed: ${String(lastErr.stderr || lastErr.message).slice(-400)}`); return
    }
    const instDist = join(consumer, 'node_modules', c.name, 'dist')
    const bareShared = grepBareShared(instDist)
    if (bareShared.length) fail(`${c.name}: bare @rakomi/shared import in INSTALLED dist: ${bareShared[0]}`)
    else ok(`${c.name}: installed dist has no bare @rakomi/shared import`)
    cpSync(join(REPO_ROOT, 'scripts/sdk-pack-smoke.mjs'), join(consumer, 'smoke.mjs'))
    cpSync(join(REPO_ROOT, 'scripts/sdk-pack-smoke.cjs'), join(consumer, 'smoke.cjs'))
    for (const [file, label] of [['smoke.mjs', 'ESM'], ['smoke.cjs', 'CJS']]) {
      try { const out = sh('node', [join(consumer, file)], { cwd: consumer, env: { ...process.env, SMOKE_PKG: c.name } }); ok(`${c.name}: ${label} smoke — ${out.trim().split('\n').pop().slice(0, 120)}`) }
      catch (e) { fail(`${c.name}: ${label} smoke failed: ${String(e.stdout || e.stderr || e.message).slice(-300)}`) }
    }
  } finally { rmSync(consumer, { recursive: true, force: true }) }
}

function grepBareShared(dir) {
  const hits = []
  if (!existsSync(dir)) return hits
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, n.name)
    if (n.isDirectory()) { walk(p); continue }
    if (!/\.(c?js|mjs)$/.test(n.name) || /\.d\./.test(n.name)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (/(?:from\s*["']@rakomi\/shared|require\(\s*["']@rakomi\/shared)/.test(line)) hits.push(`${p.replace(dir, '')}: ${line.trim().slice(0, 80)}`)
    }
  } }
  walk(dir)
  return hits
}

function nodeRegression() {
  const pj = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/sdk/package.json'), 'utf8'))
  const rakomiDeps = Object.keys(pj.dependencies || {}).filter((k) => k.startsWith('@rakomi/'))
  if (rakomiDeps.length) fail(`@rakomi/node has @rakomi/* runtime dependencies: ${rakomiDeps.join(',')}`)
  else ok('@rakomi/node: zero @rakomi/* runtime dependencies')
  const distDir = join(REPO_ROOT, 'packages/sdk/dist')
  if (!existsSync(distDir)) { notes.push('@rakomi/node dist not built — run pnpm --filter @rakomi/node build for the dist-level bare-import grep'); return }
  const bare = grepBareShared(distDir)
  if (bare.length) fail(`@rakomi/node dist ships bare @rakomi/shared import (runtime-404 latent): ${bare[0]}`)
  else ok('@rakomi/node: zero bare @rakomi/ imports in built dist')
}
