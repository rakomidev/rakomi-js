import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PKG = process.env.SMOKE_PKG || '@rakomi/react'
const r = { pkg: PKG }
const fail = (k, e) => { r[k] = `threw: ${e.message}` }

const main = await import(PKG)
r.esm_import = !!main
try { require.resolve('@rakomi/shared'); r.shared_installed = true } catch { r.shared_installed = false }
r.gate_a_shared_inlined = r.esm_import && r.shared_installed === false

const manifest = require(`${PKG}/package.json`)
const subpaths = Object.keys(manifest.exports || {}).filter((s) => s !== '.' && s !== './package.json')
const resolved = []
const unresolved = []
for (const sub of subpaths) {
  const spec = sub.replace('./', `${PKG}/`)
  const entry = manifest.exports[sub]
  const hasRuntime = typeof entry === 'string' || entry?.import?.default || entry?.require?.default || entry?.default
  try {
    if (hasRuntime) require.resolve(spec)
    resolved.push(sub)
  } catch (e) {
    unresolved.push(`${sub}: ${e.message}`)
  }
}
r.subpaths_total = subpaths.length
r.subpaths_resolved = resolved.length
r.subpaths_unresolved = unresolved
r.all_subpaths_resolve = unresolved.length === 0

if (PKG !== '@rakomi/sdk-core') {
  const core = await import('@rakomi/sdk-core')
  if (main.hasPermission) r.single_instance_esm = main.hasPermission === core.hasPermission
  try {
    const coreCjs = require('@rakomi/sdk-core')
    const mfaCjs = new coreCjs.MfaStepUpUnavailableError('x')
    r.cjs_consistent_in_esm_process = mfaCjs instanceof coreCjs.MfaStepUpUnavailableError && mfaCjs.code === 'MFA_STEP_UP_UNAVAILABLE'
  } catch (e) { fail('cjs_consistent_in_esm_process', e) }
  try { r.single_jose_path = require.resolve('jose'); r.jose_resolves = true } catch (e) { fail('jose_resolves', e) }
}

try {
  const core = await import('@rakomi/sdk-core')
  const mfa = new core.MfaStepUpUnavailableError('x')
  r.mfa_instanceof_esm = mfa instanceof core.MfaStepUpUnavailableError && mfa.code === 'MFA_STEP_UP_UNAVAILABLE'
} catch (e) { fail('mfa_instanceof_esm', e) }

console.log('SMOKE_ESM ' + JSON.stringify(r))
const REQUIRED = PKG === '@rakomi/sdk-core'
  ? ['esm_import', 'gate_a_shared_inlined', 'all_subpaths_resolve', 'mfa_instanceof_esm']
  : ['esm_import', 'gate_a_shared_inlined', 'all_subpaths_resolve', 'mfa_instanceof_esm', 'single_instance_esm', 'cjs_consistent_in_esm_process', 'jose_resolves']
const bad = REQUIRED.filter((k) => r[k] !== true)
const threw = Object.entries(r).filter(([, v]) => typeof v === 'string' && v.startsWith('threw:'))
if (bad.length || threw.length) {
  console.error('SMOKE_ESM FAIL', JSON.stringify({ bad, threw, r }))
  process.exit(1)
}
