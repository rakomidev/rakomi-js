
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const CRYPTO_SENSITIVE_DEPS = Object.freeze(['jose'])

export const STEADY_STATE_PUBLISH_WORKFLOWS = Object.freeze(['.github/workflows/publish.yml'])

export const BANNED_INSTALL_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall', 'prepare'])

export const EXPECTED_REGISTRY_HOSTS = Object.freeze(['registry.npmjs.org'])

export const PACKAGE_NAME_RESTATEMENT_SITES = Object.freeze([
  'scripts/lib/sdk-supply-chain-common.mjs (DERIVED — zero edits)',
  'the CI security-scan workflow (add a packages/<dir> glob)',
  'the upstream release-gate reference (add a binding-table row)',
])

export class GateError extends Error {}

export function enumeratePublishablePackages(repoRoot = REPO_ROOT) {
  let config
  try {
    config = JSON.parse(readFileSync(join(repoRoot, '.changeset/config.json'), 'utf8'))
  } catch (e) {
    throw new GateError(`cannot read .changeset/config.json: ${e.message}`)
  }
  const fixed = Array.isArray(config.fixed) && Array.isArray(config.fixed[0]) ? config.fixed[0] : []
  if (fixed.length === 0) {
    throw new GateError('.changeset/config.json fixed[0] is empty — expected the JS-family lockstep group')
  }
  const names = [...new Set([...fixed, '@rakomi/node'])]

  const byName = new Map()
  const pkgsDir = join(repoRoot, 'packages')
  for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const mf = join(pkgsDir, entry.name, 'package.json')
    if (!existsSync(mf)) continue
    try {
      const pj = JSON.parse(readFileSync(mf, 'utf8'))
      if (pj.name) byName.set(pj.name, `packages/${entry.name}`)
    } catch { }
  }

  const packages = []
  for (const name of names) {
    const dir = byName.get(name)
    if (!dir) throw new GateError(`publishable package "${name}" not found under packages/* — name→dir map is stale`)
    packages.push({ name, dir })
  }
  packages.sort((a, b) => a.name.localeCompare(b.name))
  return { packages, expectedCount: packages.length }
}

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

export function packPackage(repoRoot, pkg, destDir) {
  const pj = JSON.parse(readFileSync(join(repoRoot, pkg.dir, 'package.json'), 'utf8'))
  sh('pnpm', ['pack', '--pack-destination', destDir], { cwd: join(repoRoot, pkg.dir) })
  const tgz = join(destDir, `${pj.name.replace('@', '').replace(/\//g, '-')}-${pj.version}.tgz`)
  if (!existsSync(tgz)) throw new GateError(`pnpm pack did not produce ${tgz} for ${pkg.name}`)
  return tgz
}

export function matchTarballForPackage(present, flatName, version) {
  const exact = `${flatName}-${version}.tgz`
  if (present.includes(exact)) return exact
  const prefix = `${flatName}-`
  return present.find((f) => f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length))) || null
}

const TAR_MAX_ENTRIES = 10000

function tarNameList(tgz) {
  return sh('tar', ['tzf', tgz]).split('\n').filter(Boolean)
}

function tarVerboseList(tgz) {
  return sh('tar', ['tvzf', tgz]).split('\n').filter((l) => l.length > 0)
}

export function readTarball(tgz) {
  const raw = tarNameList(tgz)
  if (raw.length === 0) throw new GateError(`READTARBALL-EMPTY — ${tgz} contains no entries`)
  if (raw.length > TAR_MAX_ENTRIES) {
    throw new GateError(`READTARBALL-OVERSIZE — ${raw.length} entries exceeds cap ${TAR_MAX_ENTRIES} (decompression-bomb guard)`)
  }
  const roots = new Set(raw.map((n) => n.split('/')[0]))
  if (roots.size !== 1 || !roots.has('package')) {
    throw new GateError(`READTARBALL-MULTI-ROOT — expected exactly one 'package/' root, found: [${[...roots].join(', ')}]`)
  }
  if (raw.some((n) => n.split('/').includes('..'))) {
    throw new GateError(`READTARBALL-TRAVERSAL — a '..' path segment in a tarball member (zip-slip / CWE-22)`)
  }
  for (const line of tarVerboseList(tgz)) {
    const t = line[0]
    if (t === 'l' || t === 'h') {
      throw new GateError(`READTARBALL-SYMLINK — a ${t === 'l' ? 'symlink' : 'hardlink'} entry in the tarball (CWE-59 link-following)`)
    }
  }
  const files = raw.map((s) => s.replace(/^package\//, '')).filter(Boolean)
  let manifest
  try {
    manifest = JSON.parse(sh('tar', ['xzOf', tgz, 'package/package.json']))
  } catch (e) {
    throw new GateError(`READTARBALL — cannot read package/package.json from ${tgz}: ${e.message}`)
  }
  return { manifest, files }
}

export function readTarballFile(tgz, member) {
  try {
    return sh('tar', ['xzOf', tgz, `package/${member}`])
  } catch {
    return ''
  }
}

export function tarballMembers(tgz) {
  return tarNameList(tgz).map((s) => s.replace(/^package\//, '')).filter(Boolean)
}

export function sha512OfFile(path) {
  return `sha512:${createHash('sha512').update(readFileSync(path)).digest('hex')}`
}

export function relGateMessage(code, verdict, pkg, version, finding, pointer = '') {
  const v = version ? `@${version}` : ''
  const ptr = pointer ? ` [${pointer}]` : ''
  return `${code}: ${verdict} — ${pkg}${v}: ${finding}${ptr}`
}

export const NO_SECRETS_DENYLIST = Object.freeze([
  Object.freeze({ id: 'dotenv', label: '.env / .env.*', match: (b) => b === '.env' || b.startsWith('.env.') }),
  Object.freeze({ id: 'pem', label: '*.pem', match: (b) => b.endsWith('.pem') }),
  Object.freeze({ id: 'key', label: '*.key', match: (b) => b.endsWith('.key') }),
  Object.freeze({ id: 'npmrc', label: '.npmrc', match: (b) => b === '.npmrc' }),
])

export function denyListHit(memberPath) {
  const base = basename(memberPath).toLowerCase().normalize('NFC')
  return NO_SECRETS_DENYLIST.find((r) => r.match(base)) || null
}

export const RELEASE_GATES = Object.freeze([
  Object.freeze({ id: 'no-secrets-in-tarball', script: 'scripts/check-no-secrets-in-tarball.mjs', rel_gate_code: 'REL-GATE-N1', catch_marker: /REL-GATE-N1\d/, consumes_tarball: true, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'keep', cluster: 'A', exclude_class: null, because: 'reads ONLY the published tarball bytes — the secret-material deny-list is orphan-safe by construction', compensating_control: '', ground_truth: 'the tarball itself (orphan-resident)', gdpr: 'N/A — inspects tarball file names, no personal data', version_conditional: false }) }),
  Object.freeze({ id: 'no-source-map-in-tarball', script: 'scripts/check-no-source-map-in-tarball.mjs', rel_gate_code: 'REL-GATE-N8', catch_marker: /REL-GATE-N8\d/, consumes_tarball: true, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'keep', cluster: 'A', exclude_class: null, because: 'reads ONLY the per-package npm pack preview file list + manifest — the no-.map / no-test / no-optionalDependencies invariant is orphan-safe by construction; no upstream source-tree path is read', compensating_control: '', ground_truth: 'the packed file list (npm pack preview, orphan-resident package dirs)', gdpr: 'N/A — inspects packed file names + manifest deps, no personal data', version_conditional: false }) }),
  Object.freeze({ id: 'no-install-scripts', script: 'scripts/check-sdk-no-install-scripts.mjs', rel_gate_code: 'NO-INSTALL-SCRIPTS', catch_marker: /NO-INSTALL-SCRIPTS: FAIL/, consumes_tarball: true, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'keep', cluster: 'A', exclude_class: null, because: 'reads ONLY the published manifest scripts block from the tarball — orphan-safe by construction', compensating_control: '', ground_truth: 'the published manifest in the tarball (orphan-resident)', gdpr: 'N/A — inspects manifest lifecycle scripts, no personal data', version_conditional: false }) }),
  Object.freeze({ id: 'frozen-constants-snapshot', script: 'scripts/check-frozen-constants-snapshot.mjs', rel_gate_code: 'REL-GATE-N3', catch_marker: /REL-GATE-N3\d/, consumes_tarball: true, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'keep', cluster: 'B', exclude_class: null, because: 'DECOUPLED: the ground truth is an independent committed frozen-constants.blessed.json shipped into the orphan, NEVER the tarball dist itself (self-comparison = tautology). No upstream source-tree read on the public path', compensating_control: '', ground_truth: 'frozen-constants.blessed.json (orphan-resident, generated from the platform-identity constants at export time, diff-reviewed) — falls back to the upstream constant sources when present', gdpr: 'N/A — compares frozen platform-identity constants, no personal data', version_conditional: false }) }),
  Object.freeze({ id: 'sbom-equals-lockfile', script: 'scripts/check-sbom-equals-lockfile.mjs', rel_gate_code: 'REL-GATE-N4', catch_marker: /REL-GATE-N4\d/, consumes_tarball: true, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'keep', cluster: 'A', exclude_class: null, because: 'CycloneDX set-equality over the tarball sbom.cdx.json + dist/metafile + pnpm-lock — all orphan-resident build context (NOT an upstream path). CRA Annex-I §2(1) SBOM evidence chain — MUST stay', compensating_control: '', ground_truth: 'tarball sbom.cdx.json + dist/metafile-*.json + pnpm-lock.yaml (all orphan-resident build context)', gdpr: 'N/A — compares dependency component sets, no personal data', version_conditional: false }) }),
  Object.freeze({ id: 'provenance-present', script: 'scripts/check-publish-auth-hardening.mjs', rel_gate_code: 'PUBLISH-AUTH-HARDENING', catch_marker: /PUBLISH-AUTH-HARDENING: FAIL/, consumes_tarball: false, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'exclude', cluster: 'C', exclude_class: 'policy', because: 'scans the upstream .github/workflows for OIDC publish-hardening posture (STEADY_STATE_PUBLISH_WORKFLOWS) — an upstream-publish concern with no orphan meaning; the control MOVES, it does not vanish', compensating_control: 'the public publish.yml static-hardening verification (check-public-publish-workflow.mjs, runs upstream before cutover) + the workflow `permissions: id-token: write` (OIDC-only publish; a misconfigured/absent trusted publisher fail-closes at the publish-time 404, minting nothing) + the post-publish provenance gates (subject-digest / predicate-scrub / Rekor-issuer) — the orphan-fixture drill asserts this replacement is wired AND fail-closed. (The in-CI OIDC read-back preflight, check-oidc-config-match.mjs, was retired — run 28543586419: non-existent npm command + needs auth the tokenless job cannot supply; trusted-publisher config is verified out-of-band by the release authorizer before tagging.)', ground_truth: 'upstream .github/workflows (NOT orphan-resident — that is why it is excluded)', gdpr: 'N/A — inspects workflow YAML, no personal data', version_conditional: false }) }),
  Object.freeze({ id: 'tag-version-published', script: 'scripts/check-tag-version-published.mjs', rel_gate_code: 'REL-GATE-N6', catch_marker: /REL-GATE-N6\d/, consumes_tarball: true, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'keep', cluster: 'A', exclude_class: null, because: 'reads the tarball manifest version against published-registry context — orphan-resident', compensating_control: '', ground_truth: 'the tarball manifest version + registry (orphan-resident)', gdpr: 'N/A — compares version strings, no personal data', version_conditional: false }) }),
  Object.freeze({ id: 'api-snapshot-drift', script: 'scripts/check-sdk-snapshot-drift.mjs', rel_gate_code: 'SNAPSHOT-DRIFT', catch_marker: /SNAPSHOT-DRIFT: FAIL/, consumes_tarball: false, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'exclude', cluster: 'D', exclude_class: 'policy', because: 'compares the SDK API surface against an upstream-resident blessed baseline snapshot that has NO orphan equivalent — a cross-SDK drift detector that runs upstream in CI before export', compensating_control: 'runs upstream in CI (cross-SDK snapshot-drift detector) before the clean-room export — the control moved EARLIER in the pipeline, it was not removed', ground_truth: 'upstream API-surface snapshot baseline (NOT orphan-resident — that is why it is excluded)', gdpr: 'N/A — compares API symbol sets, no personal data', version_conditional: false }) }),
  Object.freeze({ id: 'sdk-support-major-entry', script: 'scripts/check-sdk-support-major-entry.mjs', rel_gate_code: 'REL-GATE-N7', catch_marker: /REL-GATE-N7\d/, consumes_tarball: true, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'exclude', cluster: 'D', exclude_class: 'policy', because: 'reads the upstream support-policy manifest via loadSecuritySupport() (default path) through the unported lib/sdk-support-common.mjs — NO orphan-resident ground truth. The support-window COMMITMENT is an upstream-governed artifact; shipping it into the tarball would be publisher self-attestation (weaker than the upstream check, the self-comparison anti-pattern). SemVer §4 keeps it a no-op at 0.x; the re-arm at 1.0 GA happens in the upstream run', compensating_control: 'runs upstream as part of the FULL release-gate set against the real support-policy manifest BEFORE the clean-room export — the control runs earlier in the pipeline (re-arming at 1.0 GA there), it was not removed', ground_truth: 'the upstream support-policy manifest via lib/sdk-support-common.mjs (NOT orphan-resident — that is why it is excluded)', gdpr: 'N/A — compares support-window dates, no personal data', version_conditional: true }) }),
  Object.freeze({ id: 'sdk-support-no-regression', script: 'scripts/check-sdk-support-no-regression.mjs', rel_gate_code: 'REL-GATE-N9', catch_marker: /REL-GATE-N9/, consumes_tarball: false, drilled_by_sabotage: null, posture: 'hard-block',
    public: Object.freeze({ disposition: 'exclude', cluster: 'D', exclude_class: 'policy', because: 'reads the upstream support-policy manifest (REL_PATH) and diffs it against a git BASE ref — both upstream-only inputs with no orphan equivalent (it can only evaluate against the upstream support matrix + git history): the support-window REGRESSION check has no public-repo ground truth, so it is policy-EXCLUDE/upstream', compensating_control: 'runs upstream on every change to the support-policy manifest (git-base regression diff) as part of the FULL release-gate set BEFORE the clean-room export — the control runs earlier, it was not removed. (Its sibling sdk-support-major-entry is ALSO excluded for the same upstream-coupling reason; BOTH support gates run upstream — the published-window assertion is verified in that same upstream pre-export run, NOT on the orphan/tarball surface.)', ground_truth: 'the upstream support-policy manifest + git base ref (NOT orphan-resident — that is why it is excluded)', gdpr: 'N/A — compares support-window dates, no personal data', version_conditional: true }) }),
])

export class ContextError extends GateError {}

export const RELEASE_GATE_CONTEXTS = Object.freeze(['monorepo', 'public'])

export function publicExclusionSet(gates = RELEASE_GATES) {
  return new Set(gates.filter((g) => g.public && g.public.disposition === 'exclude').map((g) => g.id))
}

export function detectContext(repoRoot = REPO_ROOT) {
  const hasApi = existsSync(join(repoRoot, 'packages/api'))
  const hasShared = existsSync(join(repoRoot, 'packages/shared'))
  if (hasApi && hasShared) return 'monorepo'
  if (!hasApi && !hasShared) return 'public'
  throw new ContextError(
    `CONTEXT-AMBIGUOUS — misassembled orphan: api-source-tree present=${hasApi}, shared-source-tree present=${hasShared} ` +
    '(a half-orphan tree). Refusing to narrow the gate-set — fix the assembly or the context is the full source tree.',
  )
}

export function selectReleaseGates(context, { gates = RELEASE_GATES } = {}) {
  if (!RELEASE_GATE_CONTEXTS.includes(context)) {
    throw new ContextError(`unknown release-gate context "${context}" — expected one of ${RELEASE_GATE_CONTEXTS.join('|')}`)
  }
  if (context === 'monorepo') return gates.slice()
  const excluded = publicExclusionSet(gates)
  return gates.filter((g) => !excluded.has(g.id))
}

export function resolveContext(derived, flag) {
  if (!flag) return derived
  if (!RELEASE_GATE_CONTEXTS.includes(flag)) {
    throw new ContextError(`--context "${flag}" is not one of ${RELEASE_GATE_CONTEXTS.join('|')}`)
  }
  if (flag === derived) return derived
  if (derived === 'public' && flag === 'monorepo') {
    throw new ContextError(
      'refusing --context monorepo in a structurally-detected PUBLIC (orphan) tree — a flag may only NARROW, ' +
      'never re-introduce the excluded upstream-coupled gates (fail-loud).',
    )
  }
  return flag
}

export function buildSyntheticTarball(destTgz, { manifest, files = {} }) {
  const stage = mkdtempSync(join(tmpdir(), 'rakomi-fixture-'))
  try {
    const pkgDir = join(stage, 'package')
    mkdirSync(pkgDir, { recursive: true })
    if (manifest !== undefined) writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(pkgDir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    sh('tar', ['czf', destTgz, '-C', stage, 'package'])
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  return destTgz
}

export function inspectPublishedTarball({ name, manifest, files }) {
  const violations = []
  const warnings = []
  const scripts = (manifest && manifest.scripts) || {}
  for (const s of BANNED_INSTALL_SCRIPTS) {
    if (Object.prototype.hasOwnProperty.call(scripts, s)) {
      violations.push(`${name}: published manifest declares install-time script "${s}" (banned — runs on a consumer's npm install)`)
    }
  }
  if (manifest && manifest.gypfile === true) {
    violations.push(`${name}: gypfile:true in published manifest (implicit node-gyp rebuild at consumer install — native-build RCE surface)`)
  }
  if (files.some((f) => f === 'binding.gyp' || f.endsWith('/binding.gyp'))) {
    violations.push(`${name}: binding.gyp ships in tarball (implicit node-gyp rebuild at consumer install — native-build RCE surface)`)
  }
  if (files.some((f) => f === '.npmrc' || f.endsWith('/.npmrc'))) {
    violations.push(`${name}: .npmrc ships in tarball (can set ignore-scripts=false or redirect to a foreign registry)`)
  }
  if (manifest && manifest.publishConfig && manifest.publishConfig.registry) {
    warnings.push(`${name}: publishConfig.registry="${manifest.publishConfig.registry}" in a published SDK manifest (unexpected — confirm it is the public registry)`)
  }
  if (manifest && manifest.overrides) warnings.push(`${name}: "overrides" block in a published SDK manifest (alters consumer dependency resolution)`)
  if (manifest && manifest.resolutions) warnings.push(`${name}: "resolutions" block in a published SDK manifest (alters consumer dependency resolution)`)
  return { violations, warnings }
}

export function inspectFilesAllowList({ name, manifest, hasNpmignore }) {
  const violations = []
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    violations.push(`${name}: package.json declares no "files:" allow-list (fail-open deny-list model — a new source/secret file would ship by default)`)
  }
  if (hasNpmignore) {
    violations.push(`${name}: a .npmignore (deny-list) exists alongside this publishable package — it can silently override files: and inverts the fail-safe model`)
  }
  return violations
}
