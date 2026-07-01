#!/usr/bin/env node
import { CliError, guard, parseArgs, report, run } from './lib/cli-common.mjs'
import { assertPublishOrder, SDK_CORE } from './lib/sdk-provenance-checks.mjs'

const LABEL = 'publish-order'
guard(LABEL, () => {
  const { package: pkg } = parseArgs(process.argv.slice(2))
  if (!pkg) throw new CliError('missing --package <name>')
  let sdkCoreExists
  try {
    const out = run('npm', ['view', SDK_CORE, 'versions', '--json']).trim()
    sdkCoreExists = out.length > 0 && JSON.parse(out).length > 0
  } catch {
    sdkCoreExists = false
  }
  report(LABEL, assertPublishOrder(pkg, sdkCoreExists))
})
