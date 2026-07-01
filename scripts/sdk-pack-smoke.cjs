const PKG = process.env.SMOKE_PKG || '@rakomi/react'
const r = { pkg: PKG }

const main = require(PKG)
r.cjs_import = !!main

const manifest = require(`${PKG}/package.json`)
const subpaths = Object.keys(manifest.exports || {}).filter((s) => s !== '.' && s !== './package.json')
const unresolved = []
for (const sub of subpaths) {
  const entry = manifest.exports[sub]
  const hasRuntime = typeof entry === 'string' || entry?.require?.default || entry?.import?.default || entry?.default
  if (!hasRuntime) continue
  try { require.resolve(sub.replace('./', `${PKG}/`)) } catch (e) { unresolved.push(`${sub}: ${e.message}`) }
}
r.subpaths_unresolved = unresolved
r.all_subpaths_resolve = unresolved.length === 0

if (PKG !== '@rakomi/sdk-core') {
  const core = require('@rakomi/sdk-core')
  if (main.hasPermission) r.single_instance_cjs = main.hasPermission === core.hasPermission
  const mfa = new core.MfaStepUpUnavailableError('x')
  r.mfa_instanceof_cjs = mfa instanceof core.MfaStepUpUnavailableError
  try { r.jose_resolves = !!require.resolve('jose') } catch { r.jose_resolves = false }
}

console.log('SMOKE_CJS ' + JSON.stringify(r))
const REQUIRED = PKG === '@rakomi/sdk-core'
  ? ['cjs_import', 'all_subpaths_resolve']
  : ['cjs_import', 'all_subpaths_resolve', 'mfa_instanceof_cjs', 'single_instance_cjs', 'jose_resolves']
const bad = REQUIRED.filter((k) => r[k] !== true)
if (bad.length) {
  console.error('SMOKE_CJS FAIL', JSON.stringify({ bad, r }))
  process.exit(1)
}
