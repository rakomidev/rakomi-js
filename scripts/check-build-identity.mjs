#!/usr/bin/env node
import { CliError, guard, OIDC, parseArgs, report, run } from './lib/cli-common.mjs'
import { assertNoPersonalEmail } from './lib/sdk-provenance-checks.mjs'

const LABEL = 'build-identity'

export function collectCommitIdentities(idLines, body) {
  const identities = []
  for (const ident of String(idLines).split(/\r?\n/)) {
    if (ident.trim()) identities.push(ident.trim())
  }
  for (const line of String(body).split(/\r?\n/)) {
    const m = /^\s*(?:co-authored-by|signed-off-by)\s*:\s*(.+)$/i.exec(line)
    if (m) identities.push(m[1].trim())
  }
  return identities
}

if (import.meta.url === `file://${process.argv[1]}`) {
  guard(LABEL, () => {
    const args = parseArgs(process.argv.slice(2))
    const ref = typeof args.ref === 'string' ? args.ref : 'HEAD'
    if (/^-/.test(ref)) throw new CliError(`--ref must not start with '-' (got ${ref})`)

    const author = run('git', ['show', '-s', '--format=%an <%ae>', ref]).replace(/\n$/, '')
    const committer = run('git', ['show', '-s', '--format=%cn <%ce>', ref]).replace(/\n$/, '')
    const body = run('git', ['show', '-s', '--format=%B', ref])

    report(LABEL, assertNoPersonalEmail(collectCommitIdentities(`${author}\n${committer}`, body), OIDC.roleMailboxes))
  })
}
