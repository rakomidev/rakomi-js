#!/usr/bin/env node
/**
 * check-tag-version-published.mjs — Story 29-4 release gate (AC-6).
 *
 * tag == version == published. Asserts the THREE-WAY equality on the release path:
 *   1. tagVersion     — the git tag's version (sdk/v<X> or react/v<X>, after the `<prefix>v` strip)
 *   2. repoVersion    — packages/<dir>/package.json version (the repo check P6 already does)
 *   3. tarballVersion — the PUBLISHED tarball's package/package.json version (the bytes about to ship)
 *
 * WHY tarballVersion (the 29-4 increment over 29-3's P6 shell check): a compromised `prepack` could
 * mutate package.json version BETWEEN the repo check and `npm publish`, so the published tarball ships
 * a different version than both the tag and the repo manifest claimed. The legacy P6 shell check only
 * compared tag==repo-version; this gate ALSO reads the packed .tgz manifest version — closing the same
 * TOCTOU class AC-11 closes for install scripts. It inspects a tarball produced by the GENUINE prepack
 * chain (a real pnpm pack, or a --tarball <dir> someone else packed), never the pre-pack repo manifest.
 *
 * Prefix→package map: NOT hardcoded to a single prefix. The per-package tag namespaces (`sdk/v*` →
 * @rakomi/node, `react/v*` → @rakomi/react) are published by the SINGLE public-repo workflow
 * (`rakomidev/rakomi-js` `publish.yml` — the monorepo's own `publish-sdk.yml`/`publish-react.yml` were
 * removed by AC-DISABLE-MONOREPO-PUBLISH #16). The map is derived by intersecting those tag TARGETS with
 * enumeratePublishablePackages() so a future fixed-group change or a renamed package surfaces as a
 * stale-map GateError, not a silent miss. (This gate runs in the PRIVATE monorepo CI over packed bytes;
 * it is GH-context/repo-agnostic, so it is unaffected by where the publish workflow physically lives.)
 *
 * No-tag case (workflow_dispatch with no tag, or a local run): the tag-equality LIMB is SKIPPED with a
 * clear note (NOT a failure — there is no tag to compare); the repoVersion == tarballVersion limb STILL
 * runs (the TOCTOU surface this gate adds is independent of the tag).
 *
 * Negative controls (see .test.mjs):
 *   T1 tag version ≠ repo version                     → FAIL (REL-GATE-N61)
 *   T2 repo version ≠ tarball-manifest version (prepack mutation simulated) → FAIL (REL-GATE-N62)
 *   T3 all three equal                                → PASS
 *   T4 .tgz manifest unreadable / no matching tarball → CANNOT-EVALUATE (exit 2, REL-GATE-N6E)
 *
 * Stable CI gate id: "tag-version-published" (RELEASE_GATES registry, rel_gate_code REL-GATE-N6).
 *
 * Usage:
 *   node scripts/check-tag-version-published.mjs --tag sdk/v0.20.0                  # pack once, compare
 *   node scripts/check-tag-version-published.mjs --tag refs/tags/react/v0.6.0       # refs/tags/ stripped
 *   GITHUB_REF=refs/tags/sdk/v0.20.0 node scripts/check-tag-version-published.mjs   # tag via env
 *   node scripts/check-tag-version-published.mjs --tarball <dir> --tag sdk/v0.20.0  # consume pre-packed (AC-11)
 *   node scripts/check-tag-version-published.mjs --tarball <dir>                    # no tag → repo==tarball only
 */

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

// ── REL-GATE-N6xx code catalogue (AC-19) ──────────────────────────────────────────────────────
export const REL_GATE_CODES = Object.freeze({
  TAG_NE_REPO: 'REL-GATE-N61',     // tagVersion ≠ repoVersion
  REPO_NE_TARBALL: 'REL-GATE-N62', // repoVersion ≠ tarballVersion (prepack-mutation TOCTOU)
  CANNOT_EVALUATE: 'REL-GATE-N6E', // tarball unreadable / no matching tarball / bad input
})

/**
 * The per-package tag prefixes → the npm package each one ships, published by the SINGLE public-repo
 * workflow (`rakomidev/rakomi-js` `publish.yml`; the monorepo publish workflows were removed by
 * AC-DISABLE-MONOREPO-PUBLISH #16). NOT a hardcoded single prefix. The package set is RECONCILED against
 * enumeratePublishablePackages() at runtime so a renamed/removed target fails as a stale-map GateError.
 * `publishedBy` is descriptive metadata for the stale-map error message only (not a file read).
 */
const TAG_PREFIX_TARGETS = Object.freeze([
  Object.freeze({ prefix: 'sdk/v', packageName: '@rakomi/node', publishedBy: 'rakomidev/rakomi-js publish.yml (sdk/v*)' }),
  Object.freeze({ prefix: 'sdk-core/v', packageName: '@rakomi/sdk-core', publishedBy: 'rakomidev/rakomi-js publish.yml (sdk-core/v*)' }),
  Object.freeze({ prefix: 'react/v', packageName: '@rakomi/react', publishedBy: 'rakomidev/rakomi-js publish.yml (react/v*)' }),
  Object.freeze({ prefix: 'react-native/v', packageName: '@rakomi/react-native', publishedBy: 'rakomidev/rakomi-js publish.yml (react-native/v*)' }),
])

// ── tag normalization ─────────────────────────────────────────────────────────────────────────

/** Strip a leading `refs/tags/` so `--tag` and `GITHUB_REF` are interchangeable. */
export function normalizeTagRef(ref) {
  if (!ref) return null
  return ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref
}

/**
 * Resolve a normalized tag (e.g. `sdk/v0.20.0`) to `{ packageName, prefix, tagVersion }` using the
 * derived prefix map. A tag matching NO known prefix → GateError (exit 2): the gate must never guess.
 * The version is everything after the matched `<prefix>` (which already ends in `v`).
 */
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

// ── PURE three-way comparison (unit-tested directly; T1/T2/T3) ──────────────────────────────────

/**
 * The PURE core of AC-6: given the three versions for one package, return `{ violations }` (string
 * array; empty = three-way equal = PASS). `tagVersion` may be null (no-tag case) → the tag limb is
 * skipped and only repo==tarball is asserted. Each violation line carries a REL-GATE-N6x code via
 * relGateMessage so the drill's grep (/REL-GATE-N6\d/) matches. PURE: no fs, no pack — the test matrix
 * drives it with literals.
 */
export function compareTagRepoTarball({ tagVersion, repoVersion, tarballVersion, pkg }) {
  const violations = []
  // tag limb — only when a tag was supplied.
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
  // repo == tarball limb — ALWAYS runs (the TOCTOU surface this gate adds; independent of the tag).
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

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}

function main() {
  const argv = process.argv.slice(2)
  const tarballDir = argValue(argv, '--tarball')
  const rawTag = argValue(argv, '--tag') || process.env.GITHUB_REF || null
  const tag = normalizeTagRef(rawTag)

  console.error('## tag-version-published gate (AC-6) — tag == repo == published')

  // Enumerate the publishable set and reconcile the prefix→package map against it (stale-map guard).
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
  // Bidirectional reconciliation (root-cause guard): EVERY publishable package MUST have a tag-prefix
  // entry, else a real `<prefix>/v*` tag for the unmapped package resolves to CANNOT-EVALUATE only when
  // it is actually pushed — a latent fail-closed miss that blocks the release at the tag limb (this is
  // exactly how sdk-core/react-native were absent until a live canary tag surfaced it). Fail LOUD here.
  const mappedNames = new Set(TAG_PREFIX_TARGETS.map((t) => t.packageName))
  for (const p of packages) {
    if (!mappedNames.has(p.name)) {
      throw new GateError(
        `${REL_GATE_CODES.CANNOT_EVALUATE}: prefix→package map is INCOMPLETE — publishable package ` +
          `"${p.name}" has no tag-prefix entry in TAG_PREFIX_TARGETS [${TAG_PREFIX_TARGETS.map((t) => t.prefix).join(', ')}] ` +
          `— add its <prefix>/v mapping (a real tag for it would fail-closed at the tag limb)`,
      )
    }
  }
  console.error(`## prefix→package map (derived, reconciled): ${TAG_PREFIX_TARGETS.map((t) => `${t.prefix}* → ${t.packageName}`).join(' | ')}`)

  // Determine which package(s) to check.
  //   - tag supplied  → exactly the one package the tag maps to (the release in flight).
  //   - no tag        → check repo==tarball for EVERY tag-mappable package (the surface still applies).
  let targetsToCheck // [{ pkg, tagVersion|null }]
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

  // Resolve the tarball set: shared --tarball dir (pack-once, AC-11) OR pack the needed packages once.
  let packDest = null
  const tarballs = new Map() // name → tgz
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
        // No matching tarball ⇒ cannot read the bytes about to ship ⇒ CANNOT-EVALUATE (T4 class).
        throw new GateError(
          `${REL_GATE_CODES.CANNOT_EVALUATE}: ${pkg.name}: no matching .tgz to inspect ` +
            `(pack failed or not present in --tarball dir) — cannot verify the published version`,
        )
      }
      // readTarball THROWS GateError (⇒ exit 2) on a malformed/unreadable layout — let it propagate (T4).
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

// Exported for the CLI integration test (run main() in-process under a fixed argv/env).
export function runCli() {
  return main()
}

// Only execute when invoked directly (not when imported by the test).
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
