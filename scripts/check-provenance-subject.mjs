#!/usr/bin/env node
import { CliError, fetchAttestations, guard, parseArgs, report } from './lib/cli-common.mjs'
import { assertSubjectDigest, decodeInTotoStatement, selectAttestation, SLSA_PROVENANCE_V1 } from './lib/sdk-provenance-checks.mjs'

const LABEL = 'provenance-subject'
guard(LABEL, () => {
  const args = parseArgs(process.argv.slice(2))
  if (!args.package || !args['expect-digest']) throw new CliError('missing --package <name> --expect-digest sha512:<hex>')
  const resp = fetchAttestations(args.package, args.version || 'latest')
  const statement = decodeInTotoStatement(selectAttestation(resp, SLSA_PROVENANCE_V1))
  report(LABEL, assertSubjectDigest(statement, args['expect-digest']))
})
