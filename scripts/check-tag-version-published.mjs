#!/usr/bin/env node

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  enumeratePublishablePackages,
  GateError,
  matchTarballForPackage,
  packPackage,
  readTarball,
  relGateMessage,
  REPO_ROOT,
} from './lib/sdk-supply-chain-common.mjs'

export const REL_GATE_CODES = Object.freeze({
  TAG_NE_REPO: 'REL-GATE-N61',
  REPO_NE_TARBALL: 'REL-GATE-N62',
  CANNOT_EVALUATE: 'REL-GATE-N6E',
})

const TAG_PREFIX_TARGETS = Object.freeze([
  Object.freeze({ prefix: 'sdk/v', packageName: '@rakomi/node', publishedBy: 'rakomidev/rakomi-js publish.yml (sdk/v*)' }),
  Object.freeze({ prefix: 'react/v', packageName: '@rakomi/react', publishedBy: 'rakomidev/rakomi-js publish.yml (react/v*)' }),
])

export function normalizeTagRef(ref) {
  if (!ref) return null
  return ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref
}

export function resolveTag(tag, targets = TAG_PREFIX_TARGETS) {
  const hit = targets.find((t) => tag.startsWith(t.prefix))
  if (!hit) {
    throw new GateError(
      `${REL_GATE_CODES.CANNOT_EVALUATE}: tag "${tag}" matches no known publish-workflow prefix ` +
        `(${targets.map((t) => t.prefix).join(', ')}) — cannot map tag to a package`,
    )
  }
  const tagVersion = tag.slice(hit.prefix.length)
  if (!tagVersion) {
    throw new GateError(`${REL_GATE_CODES.CANNOT_EVALUATE}: tag "${tag}" has the "${hit.prefix}" prefix but no version after it`)
  }
  return { packageName: hit.packageName, prefix: hit.prefix, tagVersion }
}

export function compareTagRepoTarball({ tagVersion, repoVersion, tarballVersion, pkg }) {
  const violations = []
  if (tagVersion != null) {
    if (tagVersion !== repoVersion) {
      violations.push(
        relGateMessage(
          REL_GATE_CODES.TAG_NE_REPO,
          'FAIL',
          pkg,
          repoVersion,
          `git tag version "${tagVersion}" ≠ repo package.json version "${repoVersion}"`,
          'align the git tag with packages/<dir>/package.json before tagging',
        ),
      )
    }
  }
  if (repoVersion !== tarballVersion) {
    violations.push(
      relGateMessage(
        REL_GATE_CODES.REPO_NE_TARBALL,
        'FAIL',
        pkg,
        repoVersion,
        `repo package.json version "${repoVersion}" ≠ PUBLISHED tarball manifest version "${tarballVersion}" ` +
          `(a prepack step mutated the version between the repo check and the packed bytes — TOCTOU)`,
        'inspect the prepack/prepublishOnly chain; the tarball is the source of truth for what ships',
      ),
    )
  }
  return { violations }
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}

function main() {
  const argv = process.argv.slice(2)
  const tarballDir = argValue(argv, '--tarball')
  const rawTag = argValue(argv, '--tag') || process.env.GITHUB_REF || null
  const tag = normalizeTagRef(rawTag)

  console.error('## tag-version-published gate — tag == repo == published')

  const { packages } = enumeratePublishablePackages(REPO_ROOT)
  const byName = new Map(packages.map((p) => [p.name, p]))
  for (const t of TAG_PREFIX_TARGETS) {
    if (!byName.has(t.packageName)) {
      throw new GateError(
        `${REL_GATE_CODES.CANNOT_EVALUATE}: prefix→package map is stale — ${t.publishedBy} target ` +
          `"${t.packageName}" is not in the enumerated publishable set [${packages.map((p) => p.name).join(', ')}]`,
      )
    }
  }
  console.error(`## prefix→package map (derived, reconciled): ${TAG_PREFIX_TARGETS.map((t) => `${t.prefix}* → ${t.packageName}`).join(' | ')}`)

  let targetsToCheck
  if (tag) {
    const { packageName, prefix, tagVersion } = resolveTag(tag)
    const pkg = byName.get(packageName)
    if (!pkg) {
      throw new GateError(`${REL_GATE_CODES.CANNOT_EVALUATE}: tag "${tag}" maps to "${packageName}" but it is not publishable`)
    }
    console.error(`## tag "${tag}" → prefix "${prefix}" → ${packageName} (tagVersion=${tagVersion})`)
    targetsToCheck = [{ pkg, tagVersion }]
  } else {
    console.error('## no --tag / GITHUB_REF tag supplied — tag-equality limb SKIPPED (note, not a failure); repo==tarball limb still runs for every tag-mappable package')
    targetsToCheck = TAG_PREFIX_TARGETS.map((t) => ({ pkg: byName.get(t.packageName), tagVersion: null }))
  }

  let packDest = null
  const tarballs = new Map()
  try {
    if (tarballDir) {
      if (!existsSync(tarballDir)) {
        throw new GateError(`${REL_GATE_CODES.CANNOT_EVALUATE}: --tarball dir does not exist: ${tarballDir}`)
      }
      const present = readdirSync(tarballDir).filter((f) => f.endsWith('.tgz'))
      for (const { pkg } of targetsToCheck) {
        const pj = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, 'package.json'), 'utf8'))
        const flatName = `${pj.name.replace('@', '').replace(/\//g, '-')}`
        const hit = matchTarballForPackage(present, flatName, pj.version)
        if (hit) tarballs.set(pkg.name, join(tarballDir, hit))
      }
    } else {
      packDest = mkdtempSync(join(tmpdir(), 'rakomi-tagver-tgz-'))
      for (const { pkg } of targetsToCheck) {
        tarballs.set(pkg.name, packPackage(REPO_ROOT, pkg, packDest))
      }
    }

    const violations = []
    for (const { pkg, tagVersion } of targetsToCheck) {
      const repoVersion = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, 'package.json'), 'utf8')).version
      const tgz = tarballs.get(pkg.name)
      if (!tgz) {
        throw new GateError(
          `${REL_GATE_CODES.CANNOT_EVALUATE}: ${pkg.name}: no matching .tgz to inspect ` +
            `(pack failed or not present in --tarball dir) — cannot verify the published version`,
        )
      }
      const { manifest } = readTarball(tgz)
      const tarballVersion = manifest && manifest.version
      if (!tarballVersion) {
        throw new GateError(`${REL_GATE_CODES.CANNOT_EVALUATE}: ${pkg.name}: tarball manifest has no "version" field — cannot evaluate`)
      }

      const { violations: vs } = compareTagRepoTarball({ tagVersion, repoVersion, tarballVersion, pkg: pkg.name })
      if (vs.length) {
        vs.forEach((m) => { violations.push(m); console.error(`  ✗ ${m}`) })
      } else {
        const limbs = tagVersion != null ? `tag=${tagVersion} == repo=${repoVersion} == tarball=${tarballVersion}` : `repo=${repoVersion} == tarball=${tarballVersion} (no tag → tag limb skipped)`
        console.error(`  ✓ ${pkg.name}: ${limbs}`)
      }
    }
    return violations
  } finally {
    if (packDest) rmSync(packDest, { recursive: true, force: true })
  }
}

export function runCli() {
  return main()
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-tag-version-published.mjs')
if (invokedDirectly) {
  let violations
  try {
    violations = main()
  } catch (e) {
    if (e instanceof GateError) { console.error(`\nTAG-VERSION-PUBLISHED: CANNOT-EVALUATE — ${e.message}`); process.exit(2) }
    console.error(`\nTAG-VERSION-PUBLISHED: CANNOT-EVALUATE — unexpected: ${e.stack || e.message}`); process.exit(2)
  }
  console.error('\n## tag-version-published summary')
  if (violations.length) {
    console.error(`\nTAG-VERSION-PUBLISHED: FAIL (${violations.length})`)
    process.exit(1)
  }
  console.error('\nTAG-VERSION-PUBLISHED: PASS')
}
