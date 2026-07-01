#!/usr/bin/env node
import { CliError, guard, loadIdentity, OIDC, parseArgs, report, run } from './lib/cli-common.mjs'
import { assertOidcConfigMatch } from './lib/sdk-provenance-checks.mjs'

const LABEL = 'oidc-config-match'
guard(LABEL, () => {
  const { package: pkg } = parseArgs(process.argv.slice(2))
  if (!pkg) throw new CliError('missing --package <name>')
  const id = loadIdentity()
  const raw = run('npm', ['access', 'get', 'trusted-publisher', pkg, '--json'])
  const configured = JSON.parse(raw)
  const expected = { org: id.org, repo: id.repo, workflow: OIDC.workflow, environment: OIDC.environment }
  report(LABEL, assertOidcConfigMatch(configured, expected))
})
