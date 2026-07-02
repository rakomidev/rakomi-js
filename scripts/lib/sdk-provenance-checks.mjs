
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

export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1'

export function selectAttestation(attestationsResponse, predicateType) {
  const list = attestationsResponse && Array.isArray(attestationsResponse.attestations) ? attestationsResponse.attestations : null
  if (!list) throw new ProvenanceCheckError('attestations response has no attestations[] array (unexpected bundle shape)')
  const hit = list.find((a) => a && a.predicateType === predicateType)
  if (!hit) throw new ProvenanceCheckError(`no attestation of predicateType "${predicateType}" in the bundle [${list.map((a) => a?.predicateType).join(', ')}]`)
  return hit
}

export function decodeInTotoStatement(attestation) {
  const payload = attestation?.bundle?.dsseEnvelope?.payload
  if (typeof payload !== 'string' || payload.length === 0) throw new ProvenanceCheckError('attestation bundle has no dsseEnvelope.payload — cannot decode the in-toto Statement')
  let json
  try {
    json = Buffer.from(payload, 'base64').toString('utf8')
  } catch {
    throw new ProvenanceCheckError('dsseEnvelope.payload is not valid base64')
  }
  try {
    return JSON.parse(json)
  } catch {
    throw new ProvenanceCheckError('decoded dsseEnvelope.payload is not valid JSON')
  }
}

const OID_ISSUER_V1 = Buffer.from([0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, 0x01])
const OID_ISSUER_V2 = Buffer.from([0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, 0x08])

function readDerLen(der, i) {
  const first = der[i]
  if (first < 0x80) return { len: first, next: i + 1 }
  const n = first & 0x7f
  let len = 0
  for (let k = 0; k < n; k++) len = (len << 8) | der[i + 1 + k]
  return { len, next: i + 1 + n }
}

export function extractOidcIssuerFromCert(rawBytesB64) {
  if (typeof rawBytesB64 !== 'string' || rawBytesB64.length === 0) return null
  let der
  try {
    der = Buffer.from(rawBytesB64, 'base64')
  } catch {
    return null
  }
  for (const [oid, v2] of [[OID_ISSUER_V2, true], [OID_ISSUER_V1, false]]) {
    const at = der.indexOf(oid)
    if (at < 0) continue
    let i = at + oid.length
    if (der[i] === 0x01) {
      const { next } = readDerLen(der, i + 1)
      i = next + 1
    }
    if (der[i] !== 0x04) continue
    const { len, next } = readDerLen(der, i + 1)
    let start = next
    let end = next + len
    if (v2 && der[start] === 0x0c) {
      const inner = readDerLen(der, start + 1)
      start = inner.next
      end = inner.next + inner.len
    }
    const s = der.slice(start, end).toString('utf8')
    if (/^https?:\/\//.test(s)) return s
  }
  return null
}

export function rekorEntryFromBundle(attestation) {
  const vm = attestation?.bundle?.verificationMaterial || {}
  const tlog = Array.isArray(vm.tlogEntries) ? vm.tlogEntries : []
  const entry = tlog[0]
  const inclusionProofVerified = !!(entry && entry.inclusionProof && entry.logIndex != null)
  const statement = decodeInTotoStatement(attestation)
  const sha512 = statement?.subject?.[0]?.digest?.sha512
  const rawCert = vm.certificate?.rawBytes || vm.x509CertificateChain?.certificates?.[0]?.rawBytes
  return {
    inclusionProofVerified,
    subjectDigest: sha512 ? `sha512:${sha512}` : undefined,
    certificateIssuer: extractOidcIssuerFromCert(rawCert),
  }
}

export { SCANNED_PREDICATE_FIELDS }
