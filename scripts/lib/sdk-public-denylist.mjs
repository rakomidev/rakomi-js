
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex')

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export class DenylistError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DenylistError'
  }
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g
export const escapeLiteral = (s) => {
  if (typeof s !== 'string') {
    throw new TypeError(`escapeLiteral: expected a string, got ${s === null ? 'null' : typeof s} — coercing here would build a matcher for the literal text "${String(s)}" and report a confident wrong verdict`)
  }
  return s.replace(ESCAPE_RE, '\\$&')
}

const WORD_CHAR_RE = /\w/
const CASE_VALUES = new Set(['sensitive', 'insensitive'])

export function assertReDoSSafe(src) {
  const s = String(src ?? '')
  if (s.length > 512) {
    throw new DenylistError(`deny-list regex source is over the 512-char cap — REFUSED UNEXAMINED (fail-closed): /${s.slice(0, 80)}…/`)
  }
  if (/(\\[sSwWdD]|\\[pP]\{[^}]{0,32}\}|\[[^\]]{0,512}\])(?:[*+]\??|\{\d{0,7}(?:,\d{0,7})?\}\??)\1(?:[*+]\??|\{\d{0,7}(?:,\d{0,7})?\}\??)|\.(?:[*+]\??|\{\d{0,7}(?:,\d{0,7})?\}\??)(?:\\[sSwWdD]|\\[pP]\{[^}]{0,32}\}|\[[^\]]{0,512}\]|\.)(?:[*+]\??|\{\d{0,7}(?:,\d{0,7})?\}\??)|(?:\\[sSwWdD]|\\[pP]\{[^}]{0,32}\}|\[[^\]]{0,512}\])(?:[*+]\??|\{\d{0,7}(?:,\d{0,7})?\}\??)\.(?:[*+]\??|\{\d{0,7}(?:,\d{0,7})?\}\??)/.test(s)) {
    throw new DenylistError(`deny-list regex rejected as ReDoS-risky (adjacent overlapping quantified atoms — the polynomial class): /${s}/`)
  }
  const view = s
    .replace(/\\[\s\S]/g, 'xx')
    .replace(/\[[^\]]{0,512}\]/g, (m) => `[${'x'.repeat(Math.max(0, m.length - 2))}]`)
  if (/\)[*+?]|\)\{|[*+]{2,}|[*+]\?[*+]|\([^)]*[*+][^)]*\)[*+?{]/.test(view)) {
    throw new DenylistError(`deny-list regex rejected as ReDoS-risky (nested/adjacent quantifier): /${s}/`)
  }
}

function normalizeLiteral(entry, catCase, catId) {
  let value, termCase, boundary
  if (typeof entry === 'string') {
    value = entry
    termCase = catCase
    boundary = false
  } else if (entry && typeof entry === 'object' && typeof entry.value === 'string') {
    value = entry.value
    termCase = entry.case ?? catCase
    boundary = entry.boundary ?? false
    if (!CASE_VALUES.has(termCase)) {
      throw new DenylistError(`deny-list literal '${value}' (category '${catId}') has invalid case '${termCase}' — expected sensitive|insensitive`)
    }
    if (typeof boundary !== 'boolean') {
      throw new DenylistError(`deny-list literal '${value}' (category '${catId}') has non-boolean boundary`)
    }
  } else {
    throw new DenylistError(`deny-list literal in category '${catId}' must be a string or {value,…}: ${JSON.stringify(entry)}`)
  }
  if (value.length === 0) throw new DenylistError(`deny-list literal in category '${catId}' is empty`)
  if (boundary && (!WORD_CHAR_RE.test(value[0]) || !WORD_CHAR_RE.test(value[value.length - 1]))) {
    throw new DenylistError(`deny-list literal '${value}' (category '${catId}') sets boundary:true but has a non-word edge — \\b cannot anchor it; drop boundary or list it as a regex`)
  }
  return { value, caseInsensitive: termCase === 'insensitive', boundary }
}

function validateRegex(rx) {
  assertReDoSSafe(rx)
  new RegExp(rx)
  if (new RegExp(`${rx}|`).exec('').length - 1 !== 0) {
    throw new DenylistError(`deny-list regex must use non-capturing groups only — a capturing group breaks the scanText category index: /${rx}/`)
  }
}

function normalizeRegex(entry, catCase, catId) {
  if (typeof entry === 'string') return { source: entry, caseInsensitive: catCase === 'insensitive' }
  if (entry && typeof entry === 'object' && typeof entry.value === 'string') {
    const termCase = entry.case ?? catCase
    if (!CASE_VALUES.has(termCase)) {
      throw new DenylistError(`deny-list regex '${entry.value}' (category '${catId}') has invalid case '${termCase}' — expected sensitive|insensitive`)
    }
    if ('boundary' in entry) {
      throw new DenylistError(`deny-list regex '${entry.value}' (category '${catId}') must not set boundary — a regex carries its own anchors`)
    }
    return { source: entry.value, caseInsensitive: termCase === 'insensitive' }
  }
  throw new DenylistError(`deny-list regex in category '${catId}' must be a string or {value, case?}: ${JSON.stringify(entry)}`)
}

export function loadDenylist(repoRoot = REPO_ROOT) {
  const data = JSON.parse(readFileSync(join(repoRoot, 'sdk-public-denylist.json'), 'utf8'))
  if (!Array.isArray(data.categories) || data.categories.length === 0) {
    throw new DenylistError('sdk-public-denylist.json: categories[] missing/empty')
  }
  const insensitive = { parts: [], source: [], caseInsensitive: true }
  const sensitive = { parts: [], source: [], caseInsensitive: false }
  const flat = []
  const hashed = []

  for (const cat of data.categories) {
    if (typeof cat.id !== 'string' || typeof cat.why !== 'string' || cat.why.length === 0) {
      throw new DenylistError(`deny-list category missing id/why: ${JSON.stringify(cat)}`)
    }
    const catCase = cat.case ?? 'insensitive'
    if (!CASE_VALUES.has(catCase)) {
      throw new DenylistError(`deny-list category '${cat.id}' has invalid case '${catCase}' — expected sensitive|insensitive`)
    }
    for (const lit of cat.literals || []) {
      const { value, caseInsensitive, boundary } = normalizeLiteral(lit, catCase, cat.id)
      const wrapped = boundary ? `\\b${escapeLiteral(value)}\\b` : escapeLiteral(value)
      const bucket = caseInsensitive ? insensitive : sensitive
      bucket.source.push({ category: cat.id, raw: value })
      bucket.parts.push(`(${wrapped})`)
      flat.push({ category: cat.id, raw: value })
    }
    for (const rx of cat.regexes || []) {
      const { source, caseInsensitive } = normalizeRegex(rx, catCase, cat.id)
      validateRegex(source)
      const bucket = caseInsensitive ? insensitive : sensitive
      bucket.source.push({ category: cat.id, raw: source })
      bucket.parts.push(`(${source})`)
      flat.push({ category: cat.id, raw: source })
    }
    for (const entry of cat.hashedLiterals || []) {
      if (!entry || typeof entry.len !== 'number' || !Number.isInteger(entry.len) || entry.len <= 0 || !/^[0-9a-f]{64}$/.test(entry.h || '')) {
        throw new DenylistError(`deny-list category '${cat.id}' has a malformed hashedLiterals entry (need {len:int>0, h:64-hex}): ${JSON.stringify(entry)}`)
      }
      let m = hashed.find((x) => x.category === cat.id && x.caseInsensitive === (catCase === 'insensitive'))
      if (!m) { m = { category: cat.id, caseInsensitive: catCase === 'insensitive', byLen: new Map() }; hashed.push(m) }
      if (!m.byLen.has(entry.len)) m.byLen.set(entry.len, new Set())
      m.byLen.get(entry.len).add(entry.h)
    }
  }

  const buckets = []
  for (const b of [insensitive, sensitive]) {
    if (b.parts.length === 0) continue
    buckets.push({
      re: new RegExp(b.parts.join('|'), b.caseInsensitive ? 'gi' : 'g'),
      source: b.source,
      caseInsensitive: b.caseInsensitive,
    })
  }
  if (buckets.length === 0 && hashed.length === 0) throw new DenylistError('sdk-public-denylist.json: no patterns')
  return { id: data.version, buckets, source: flat, hashed }
}

export function scanText(compiled, text) {
  const hits = []
  for (const bucket of compiled.buckets) {
    bucket.re.lastIndex = 0
    let m
    while ((m = bucket.re.exec(text)) !== null) {
      let gi = 1
      for (; gi < m.length; gi++) {
        if (m[gi] !== undefined) break
      }
      const meta = bucket.source[gi - 1]
      hits.push({ category: meta ? meta.category : 'unknown', match: m[0], index: m.index })
      if (m[0] === '') bucket.re.lastIndex++
    }
  }
  for (const h of compiled.hashed || []) {
    const hay = h.caseInsensitive ? text.toLowerCase() : text
    for (const [len, set] of h.byLen) {
      if (len > hay.length) continue
      for (let i = 0; i + len <= hay.length; i++) {
        if (set.has(sha256Hex(hay.slice(i, i + len)))) {
          hits.push({ category: h.category, match: '<redacted:hashed-term>', index: i })
        }
      }
    }
  }
  hits.sort((a, b) => a.index - b.index || a.category.localeCompare(b.category) || a.match.localeCompare(b.match))
  return hits
}
