#!/usr/bin/env node
// Plan the release tags for a verified release pull request head.
//
// The tags come from the head's Release-Tags trailer and each one must hold up against the head itself:
//   - `<prefix>/v<semver>` with a prefix among the six publish namespaces;
//   - the version equals the `version` of that package's package.json at the head;
//   - the tag does not exist yet;
//   - the version is above every existing version of that prefix (no downgrade, no re-release).
// Output order puts sdk-core first: dependent packages resolve it during their own publish.
import { execFileSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseTrailers, readReleaseTrailers, RELEASE_TAG_PACKAGE_DIRS, TRAILER_SOURCE_TREE } from './lib/release-source-surface.mjs'

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const TAG_RE = /^([a-z-]+)\/v(.+)$/

/** semver precedence: <0, 0, >0. Returns null when either side is not a semver. */
export function compareSemver(a, b) {
  const x = SEMVER_RE.exec(a)
  const y = SEMVER_RE.exec(b)
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return d
  }
  if (!x[4] && !y[4]) return 0
  if (!x[4]) return 1
  if (!y[4]) return -1
  const pa = x[4].split('.')
  const pb = y[4].split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1
    if (pb[i] === undefined) return 1
    const na = /^\d+$/.test(pa[i])
    const nb = /^\d+$/.test(pb[i])
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i])
    if (na !== nb) return na ? -1 : 1
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

/**
 * @param {{tags:string[], versionsAtHead:Record<string,string|null>, existingTags:string[]}} f
 * @returns {{ok:boolean, tags:string[], violations:string[]}}
 */
export function planReleaseTags({ tags, versionsAtHead, existingTags }) {
  const v = []
  const existing = new Set(existingTags)
  const seen = new Set()
  for (const t of tags) {
    const m = TAG_RE.exec(t)
    if (!m || !(m[1] in RELEASE_TAG_PACKAGE_DIRS) || !SEMVER_RE.test(m[2])) { v.push(`${t} is not a release tag of a published package`); continue }
    const [, prefix, version] = m
    if (seen.has(prefix)) { v.push(`${prefix} is listed more than once`); continue }
    seen.add(prefix)
    if (versionsAtHead[prefix] !== version) v.push(`${t} does not match ${RELEASE_TAG_PACKAGE_DIRS[prefix]}/package.json at the head (${versionsAtHead[prefix] ?? 'absent'})`)
    if (existing.has(t)) v.push(`${t} already exists`)
    for (const e of existing) {
      const em = TAG_RE.exec(e)
      if (!em || em[1] !== prefix) continue
      const c = compareSemver(version, em[2])
      if (c !== null && c <= 0) v.push(`${t} is not above the existing ${e}`)
    }
  }
  if (tags.length === 0) v.push('no release tags listed')
  const ordered = [...tags].sort((a, b) => (a.startsWith('sdk-core/') ? -1 : b.startsWith('sdk-core/') ? 1 : a.localeCompare(b)))
  return { ok: v.length === 0, tags: v.length ? [] : ordered, violations: v }
}

function main() {
  const { HEAD_SHA, SOURCE_TREE, GITHUB_OUTPUT } = process.env
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (!/^[0-9a-f]{40}$/.test(HEAD_SHA || '') || !/^[0-9a-f]{40}$/.test(SOURCE_TREE || '')) {
    console.error('release-tag-plan: CANNOT-EVALUATE — HEAD_SHA and SOURCE_TREE must be full 40-hex values')
    process.exit(2)
  }
  const messages = git(['log', '--first-parent', '-n', '20', '--format=%B%x00', HEAD_SHA]).split('\0')
  const message = messages.find((m) => parseTrailers(m)[TRAILER_SOURCE_TREE]) || ''
  const trailers = readReleaseTrailers(message)
  if (!trailers.ok) {
    console.error(`release-tag-plan: REFUSED — ${trailers.reason}`)
    process.exit(1)
  }
  if (trailers.sourceTree !== SOURCE_TREE) {
    console.error('release-tag-plan: REFUSED — the Source-Tree trailer differs from the verified tree')
    process.exit(1)
  }
  const versionsAtHead = {}
  for (const [prefix, dir] of Object.entries(RELEASE_TAG_PACKAGE_DIRS)) {
    try { versionsAtHead[prefix] = JSON.parse(git(['show', `${HEAD_SHA}:${dir}/package.json`])).version ?? null } catch { versionsAtHead[prefix] = null }
  }
  const existingTags = git(['tag', '--list']).split('\n').filter(Boolean)
  const plan = planReleaseTags({ tags: trailers.tags, versionsAtHead, existingTags })
  if (!plan.ok) {
    console.error('release-tag-plan: REFUSED')
    for (const line of plan.violations) console.error(`  - ${line}`)
    process.exit(1)
  }
  if (GITHUB_OUTPUT) {
    appendFileSync(GITHUB_OUTPUT, `tags=${plan.tags.join(' ')}\nall_tags=${trailers.tags.join(' ')}\n`)
  }
  console.error(`release-tag-plan: ${plan.tags.join(' ')}`)
}

const isCliEntry = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  const real = (p) => { try { return realpathSync(p) } catch { return p } }
  try { return real(argv1) === real(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isCliEntry) main()
