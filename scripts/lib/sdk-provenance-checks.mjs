
export class ProvenanceCheckError extends Error {}

export const PUBLISH_TOPOLOGY = Object.freeze({
  '@rakomi/node': Object.freeze({ tagPrefix: 'sdk/v', dir: 'packages/sdk', dependsOnSdkCore: false }),
  '@rakomi/sdk-core': Object.freeze({ tagPrefix: 'sdk-core/v', dir: 'packages/sdk-core', dependsOnSdkCore: false }),
  '@rakomi/react': Object.freeze({ tagPrefix: 'react/v', dir: 'packages/react', dependsOnSdkCore: true }),
  '@rakomi/react-native': Object.freeze({ tagPrefix: 'react-native/v', dir: 'packages/react-native', dependsOnSdkCore: true }),
})

export const SDK_CORE = '@rakomi/sdk-core'

export function assertRepoMatch(repositoryUrl, expectedSlug) {
  if (typeof repositoryUrl !== 'string' || repositoryUrl.length === 0) {
    return { ok: false, reason: 'package.json has no repository.url — npm rejects provenance publish without it (HTTP 422)' }
  }
  const m = /^(?:git\+)?(?:(?:https?|ssh):\/\/)?(?:git@)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/.exec(repositoryUrl)
  if (!m) return { ok: false, reason: `repository.url "${repositoryUrl}" is not a github.com URL` }
  const slug = `${m[1]}/${m[2]}`
  return slug === expectedSlug
    ? { ok: true, reason: `repository.url resolves to ${slug}` }
    : { ok: false, reason: `repository.url resolves to "${slug}" but provenance requires EXACTLY "${expectedSlug}" (byte-string match / HTTP 422)` }
}

export function resolvePackageFromTag(ref) {
  for (const [name, t] of Object.entries(PUBLISH_TOPOLOGY)) {
    if (typeof ref === 'string' && ref.startsWith(`refs/tags/${t.tagPrefix}`)) {
      return { name, version: ref.slice(`refs/tags/${t.tagPrefix}`.length), ...t }
    }
  }
  throw new ProvenanceCheckError(`tag ref "${ref}" is not a recognized per-package release namespace`)
}

export function assertPublishOrder(pkgName, sdkCoreExists) {
  const t = PUBLISH_TOPOLOGY[pkgName]
  if (!t) return { ok: false, reason: `unknown package "${pkgName}" — not in PUBLISH_TOPOLOGY` }
  if (!t.dependsOnSdkCore) return { ok: true, reason: `${pkgName} does not depend on ${SDK_CORE} — order-free` }
  return sdkCoreExists
    ? { ok: true, reason: `${SDK_CORE} is published; ${pkgName} may publish its ^0.x range` }
    : { ok: false, reason: `${pkgName} depends on ${SDK_CORE} but ${SDK_CORE} is not yet on the registry — publish ${SDK_CORE} first (dependency-confusion window)` }
}

export function assertOidcConfigMatch(configured, expected) {
  if (!configured || typeof configured !== 'object') {
    return { ok: false, reason: 'no trusted-publisher configured on npm for this package (OIDC publish would 404) — configure org/repo/workflow/environment first' }
  }
  for (const field of ['org', 'repo', 'workflow', 'environment']) {
    if (!configured[field] || !expected[field]) {
      return { ok: false, reason: `trusted-publisher ${field} is unset (npm="${configured[field]}" workflow="${expected[field]}") — the OIDC identity must pin org/repo/workflow/environment` }
    }
    if (configured[field] !== expected[field]) {
      return { ok: false, reason: `trusted-publisher ${field} mismatch: npm="${configured[field]}" workflow="${expected[field]}" — OIDC token exchange will 404` }
    }
  }
  if (configured.twoFactorBlocks === true) {
    return { ok: false, reason: 'org 2FA-required-to-publish is configured to block the automation/OIDC path — green-CI/403-publish' }
  }
  return { ok: true, reason: `trusted-publisher matches repo:${expected.org}/${expected.repo} workflow:${expected.workflow} environment:${expected.environment}` }
}

export function assertSubjectDigest(statement, expectedDigest) {
  const subjects = statement && Array.isArray(statement.subject) ? statement.subject : null
  if (!subjects || subjects.length === 0) return { ok: false, reason: 'provenance statement has no subject[] — cannot bind published bytes to the gate digest' }
  const want = String(expectedDigest).replace(/^sha512:/, '')
  const got = subjects.map((s) => s?.digest?.sha512).filter(Boolean)
  if (got.length === 0) return { ok: false, reason: 'provenance subject[] carries no sha512 digest (expects subject[0].digest.sha512)' }
  return got.includes(want)
    ? { ok: true, reason: `provenance subject digest matches the gate-verified bytes (sha512:${want.slice(0, 16)}…)` }
    : { ok: false, reason: `provenance subject digest ${got.map((g) => g.slice(0, 16)).join(',')}… != gate digest ${want.slice(0, 16)}… — published bytes are NOT the gate-verified bytes` }
}

const SCANNED_PREDICATE_FIELDS = Object.freeze([
  'runDetails.builder.id',
  'buildDefinition.externalParameters.workflow.repository',
  'buildDefinition.externalParameters.workflow.ref',
  'buildDefinition.internalParameters',
  'buildDefinition.resolvedDependencies',
  'runDetails.metadata.invocationId',
])

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function forEachStringLeaf(value, fn, path = '') {
  if (typeof value === 'string') return fn(value, path || '(root)')
  if (Array.isArray(value)) return value.forEach((x, i) => forEachStringLeaf(x, fn, `${path}[${i}]`))
  if (value && typeof value === 'object') for (const k of Object.keys(value)) forEachStringLeaf(value[k], fn, path ? `${path}.${k}` : k)
}

export function scrubPredicate(predicate, { denylistMatch, expectedBuilderId, expectedRepositorySlug }) {
  const violations = []
  if (!predicate || typeof predicate !== 'object') {
    return { ok: false, violations: ['predicate is not an object — cannot field-scan'] }
  }
  const builderId = getPath(predicate, 'runDetails.builder.id')
  if (expectedBuilderId && builderId !== expectedBuilderId) {
    violations.push(`runDetails.builder.id="${builderId}" != expected GitHub OIDC builder "${expectedBuilderId}"`)
  }
  const repo = getPath(predicate, 'buildDefinition.externalParameters.workflow.repository')
  const repoSlug = typeof repo === 'string' ? repo.replace(/^(?:git\+)?https?:\/\/github\.com\//, '').replace(/\.git$/, '') : repo
  if (expectedRepositorySlug && repoSlug !== expectedRepositorySlug) {
    violations.push(`predicate workflow.repository="${repo}" != "${expectedRepositorySlug}" (byte-string match in predicate)`)
  }
  if (typeof denylistMatch !== 'function') {
    violations.push('denylist matcher unavailable — cannot run the forbidden-token scan over the predicate (fail-closed)')
    return { ok: false, violations }
  }
  forEachStringLeaf(predicate, (text, leafPath) => {
    const hit = denylistMatch(text)
    if (hit) violations.push(`predicate field ${leafPath} contains a forbidden token (${hit}) — internal ref leaked into the public Rekor-anchored predicate`)
  })
  return { ok: violations.length === 0, violations }
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[^\s<>,;"']+/g

export function assertNoPersonalEmail(texts, allowedRoleMailboxes) {
  const allow = new Set(allowedRoleMailboxes || [])
  const violations = []
  for (const t of texts || []) {
    if (typeof t !== 'string') continue
    for (const email of t.match(EMAIL_RE) || []) {
      if (!allow.has(email.toLowerCase())) {
        violations.push(`identity "${t}" carries a non-role email "${email}" — only role mailboxes [${[...allow].join(', ')}] may appear in a public Rekor-anchored record`)
      }
    }
  }
  return { ok: violations.length === 0, violations }
}

export function assertRekorIssuer(rekor, expectedDigest, allowedIssuers) {
  if (!rekor || typeof rekor !== 'object') return { ok: false, reason: 'no Rekor inclusion entry resolved for the published artifact' }
  if (rekor.inclusionProofVerified !== true) return { ok: false, reason: 'Rekor inclusion proof did not verify' }
  const want = String(expectedDigest).replace(/^sha512:/, '')
  if (!rekor.subjectDigest || rekor.subjectDigest.replace(/^sha512:/, '') !== want) {
    return { ok: false, reason: `Rekor entry subject digest absent or != gate digest (twin)` }
  }
  const issuer = rekor.certificateIssuer
  const allow = new Set(allowedIssuers || [])
  if (!issuer || !allow.has(issuer)) {
    return { ok: false, reason: `Rekor certificate issuer "${issuer}" is not an allowed keyless OIDC issuer [${[...allow].join(', ')}] — a personal/laptop identity must never anchor a public artifact` }
  }
  return { ok: true, reason: `Rekor inclusion proof verified; keyless issuer ${issuer}; subject matches gate digest` }
}

export { SCANNED_PREDICATE_FIELDS }
