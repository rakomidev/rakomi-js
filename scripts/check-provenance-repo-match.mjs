#!/usr/bin/env node
import { CliError, guard, loadIdentity, parseArgs, report, run } from './lib/cli-common.mjs'
import { assertRepoMatch } from './lib/sdk-provenance-checks.mjs'

const LABEL = 'provenance-repo-match'
guard(LABEL, () => {
  const { tarball } = parseArgs(process.argv.slice(2))
  if (!tarball) throw new CliError('missing --tarball <path.tgz>')
  const manifest = JSON.parse(run('tar', ['xzOf', tarball, 'package/package.json']))
  const url = manifest.repository && (typeof manifest.repository === 'string' ? manifest.repository : manifest.repository.url)
  report(LABEL, assertRepoMatch(url || '', loadIdentity().slug))
})
