#!/usr/bin/env node
import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export class GuardInputError extends Error {}

export const REQUIRED_AUTHOR = 'rakomi-mirror-sync[bot]'

export const HEAD_REF_RE = /^chore\/sync-github-[0-9a-f]{7}$/

export const SUFFICIENT_REVIEWER_PERMISSIONS = Object.freeze(['admin', 'maintain'])

export const REQUIRED_MERGEABLE_STATE = 'clean'

export function evaluateMergeGuards(facts = {}) {
  const { author, headRef, baseRef, defaultBranch, reviewState, reviewerPermission, mergeable, mergeableState } = facts
  const violations = []

  if (author !== REQUIRED_AUTHOR) {
    violations.push(`pull request author "${author}" is not the sync bot ("${REQUIRED_AUTHOR}")`)
  }
  if (typeof headRef !== 'string' || !HEAD_REF_RE.test(headRef)) {
    violations.push(`head ref "${headRef}" does not match the sync-branch shape (expected ${HEAD_REF_RE})`)
  }
  if (typeof defaultBranch !== 'string' || defaultBranch === '' || baseRef !== defaultBranch) {
    violations.push(`base ref "${baseRef}" is not the repository default branch ("${defaultBranch}")`)
  }
  if (reviewState !== 'approved') {
    violations.push(`review state "${reviewState}" is not "approved"`)
  }
  if (!SUFFICIENT_REVIEWER_PERMISSIONS.includes(reviewerPermission)) {
    violations.push(`reviewer permission "${reviewerPermission}" is not one of ${JSON.stringify(SUFFICIENT_REVIEWER_PERMISSIONS)}`)
  }
  if (mergeable !== true) {
    violations.push(`pull request mergeable=${mergeable} (expected true)`)
  }
  if (mergeableState !== REQUIRED_MERGEABLE_STATE) {
    violations.push(`pull request mergeable_state="${mergeableState}" (expected "${REQUIRED_MERGEABLE_STATE}" — every required check green, no conflict)`)
  }

  return { ok: violations.length === 0, violations }
}

const REQUIRED_ENV_KEYS = Object.freeze([
  'AUTHOR',
  'HEAD_REF',
  'BASE_REF',
  'DEFAULT_BRANCH',
  'REVIEW_STATE',
  'REVIEWER_PERMISSION',
  'MERGEABLE',
  'MERGEABLE_STATE',
])

export function readFactsFromEnv(env) {
  const missing = REQUIRED_ENV_KEYS.filter((k) => env[k] === undefined || env[k] === '')
  if (missing.length > 0) {
    throw new GuardInputError(`missing required environment variable(s): ${missing.join(', ')}`)
  }
  return {
    author: env.AUTHOR,
    headRef: env.HEAD_REF,
    baseRef: env.BASE_REF,
    defaultBranch: env.DEFAULT_BRANCH,
    reviewState: env.REVIEW_STATE,
    reviewerPermission: env.REVIEWER_PERMISSION,
    mergeable: env.MERGEABLE === 'true',
    mergeableState: env.MERGEABLE_STATE,
  }
}

export function writeEligibleOutput(outputFile, ok, appendFileSyncFn) {
  if (!outputFile) return
  appendFileSyncFn(outputFile, `eligible=${ok ? 'true' : 'false'}\n`)
}

function main({ env, appendFileSyncFn, log }) {
  let facts
  try {
    facts = readFactsFromEnv(env)
  } catch (e) {
    log(`mirror-sync-auto-merge-guards: CANNOT-EVALUATE — ${e.message}`)
    process.exit(2)
  }
  const { ok, violations } = evaluateMergeGuards(facts)
  writeEligibleOutput(env.GITHUB_OUTPUT, ok, appendFileSyncFn)
  if (ok) {
    log('mirror-sync-auto-merge-guards: ELIGIBLE — every guard is satisfied')
  } else {
    log('mirror-sync-auto-merge-guards: NOT ELIGIBLE — this review will not trigger a merge:')
    violations.forEach((v) => log(`  - ${v}`))
  }
  process.exit(0)
}

const isCliEntry = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  const real = (p) => { try { return realpathSync(p) } catch { return p } }
  try { return real(argv1) === real(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isCliEntry) {
  main({ env: process.env, appendFileSyncFn: appendFileSync, log: (msg) => console.error(msg) })
}
