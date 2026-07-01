#!/usr/bin/env node
import { CliError, guard, loadIdentity, OIDC, parseArgs, report, run } from './lib/cli-common.mjs'
import { scrubPredicate } from './lib/sdk-provenance-checks.mjs'
import { loadDenylist, scanText } from './lib/sdk-public-denylist.mjs'

const LABEL = 'provenance-predicate'
guard(LABEL, () => {
  const { package: pkg } = parseArgs(process.argv.slice(2))
  if (!pkg) throw new CliError('missing --package <name>')
  const bundle = JSON.parse(run('npm', ['view', `${pkg}@latest`, 'dist.attestations.provenance', '--json']))
  const statement = bundle && bundle.statement ? bundle.statement : bundle
  const predicate = statement && statement.predicate ? statement.predicate : statement
  const compiled = loadDenylist()
  const denylistMatch = (text) => {
    const hits = scanText(compiled, text)
    return hits && hits.length ? `${hits[0].category}:${hits[0].match}` : null
  }
  report(LABEL, scrubPredicate(predicate, {
    denylistMatch,
    expectedBuilderId: OIDC.builderId,
    expectedRepositorySlug: loadIdentity().slug,
  }))
})
