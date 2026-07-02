#!/usr/bin/env node
import { CliError, fetchAttestations, guard, loadIdentity, OIDC, parseArgs, report } from './lib/cli-common.mjs'
import { decodeInTotoStatement, scrubPredicate, selectAttestation, SLSA_PROVENANCE_V1 } from './lib/sdk-provenance-checks.mjs'
import { loadDenylist, scanText } from './lib/sdk-public-denylist.mjs'

const LABEL = 'provenance-predicate'
guard(LABEL, () => {
  const { package: pkg, version } = parseArgs(process.argv.slice(2))
  if (!pkg) throw new CliError('missing --package <name>')
  const resp = fetchAttestations(pkg, version || 'latest')
  const statement = decodeInTotoStatement(selectAttestation(resp, SLSA_PROVENANCE_V1))
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
