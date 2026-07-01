#!/usr/bin/env node
import { CliError, guard, OIDC, parseArgs, report, run } from './lib/cli-common.mjs'
import { assertRekorIssuer } from './lib/sdk-provenance-checks.mjs'

const LABEL = 'rekor-issuer'
guard(LABEL, () => {
  const args = parseArgs(process.argv.slice(2))
  if (!args.package || !args['expect-digest']) throw new CliError('missing --package <name> --expect-digest sha512:<hex>')
  const raw = run('gh', ['attestation', 'verify', `oci://${args.package}`, '--format', 'json'])
  const att = JSON.parse(raw)
  const node = Array.isArray(att) ? att[0] : att
  const rekor = {
    inclusionProofVerified: node?.verificationResult?.verified === true,
    subjectDigest: node?.verificationResult?.statement?.subject?.[0]?.digest?.sha512
      ? `sha512:${node.verificationResult.statement.subject[0].digest.sha512}`
      : undefined,
    certificateIssuer: node?.verificationResult?.signature?.certificate?.issuer,
  }
  report(LABEL, assertRekorIssuer(rekor, args['expect-digest'], OIDC.keylessIssuers))
})
