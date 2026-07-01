#!/usr/bin/env node
import { CliError, guard, parseArgs, report, run } from './lib/cli-common.mjs'
import { assertSubjectDigest } from './lib/sdk-provenance-checks.mjs'

const LABEL = 'provenance-subject'
guard(LABEL, () => {
  const args = parseArgs(process.argv.slice(2))
  if (!args.package || !args['expect-digest']) throw new CliError('missing --package <name> --expect-digest sha512:<hex>')
  const bundle = JSON.parse(run('npm', ['view', `${args.package}@latest`, 'dist.attestations.provenance', '--json']))
  const statement = bundle && bundle.statement ? bundle.statement : bundle
  report(LABEL, assertSubjectDigest(statement, args['expect-digest']))
})
