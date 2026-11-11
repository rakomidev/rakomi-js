// The source surface of a release commit: the one definition the release producer and the release
// verifier share.
//
// A release commit replaces SURFACE_DIRS wholesale and overwrites SURFACE_ROOT_FILES on top of the
// default branch. Two kinds of path inside that surface are produced at release time and are not
// re-derivable from the source revision alone, so they are left out of the comparison:
//   - the dependency lockfile (pnpm-lock.yaml), resolved against the registry when the release is built;
//   - each package's CHANGELOG.md, whose new entry carries the release date.
// Build output (dist/, node_modules/) is never committed (.gitignore) and is not produced by the
// verifier, so a build output that does appear in a release commit is a mismatch, not an exclusion.
//
// The surface tree of a commit is a git tree object holding exactly the surface entries minus the
// release-time paths. Two commits with equal surface trees carry byte-identical source.
//
// Node built-ins only: this file runs in the public repository's workflows with no install step.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SURFACE_DIRS = Object.freeze(['packages', 'scripts'])

export const SURFACE_ROOT_FILES = Object.freeze([
  'README.md', 'LICENSE', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'turbo.json', 'tsconfig.base.json', 'sdk-public-denylist.json', 'frozen-constants.blessed.json',
  'legal-clearance.json', 'CLEAN-ROOM-MANIFEST.json',
  'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
])

const RELEASE_TIME_ROOT_FILES = Object.freeze(['pnpm-lock.yaml'])
const RELEASE_TIME_PACKAGE_FILE_RE = /^packages\/[^/]+\/CHANGELOG\.md$/

/** The label the source assembler is called with for a release; producer and verifier must agree. */
export const RELEASE_ASSEMBLE_LABEL = 'release'

/** Trailer keys a release commit carries (last paragraph of its message). */
export const TRAILER_SOURCE_TREE = 'Source-Tree'
export const TRAILER_RELEASE_TAGS = 'Release-Tags'

/** Release tag prefix -> package directory; the same six namespaces publish.yml publishes. */
export const RELEASE_TAG_PACKAGE_DIRS = Object.freeze({
  'sdk-core': 'packages/sdk-core',
  sdk: 'packages/sdk',
  react: 'packages/react',
  'react-native': 'packages/react-native',
  'create-rakomi-app': 'packages/create-rakomi-app',
  cli: 'packages/cli',
})

export class ReleaseSurfaceError extends Error {}

const FULL_SHA_RE = /^[0-9a-f]{40}$/

/** @param {string} p repo-relative POSIX path */
export function isSurfacePath(p) {
  return SURFACE_ROOT_FILES.includes(p) || SURFACE_DIRS.some((d) => p.startsWith(`${d}/`))
}

/** @param {string} p repo-relative POSIX path */
export function isReleaseTimePath(p) {
  return RELEASE_TIME_ROOT_FILES.includes(p) || RELEASE_TIME_PACKAGE_FILE_RE.test(p)
}

/** A path that the surface tree compares. */
export function isComparedPath(p) {
  return isSurfacePath(p) && !isReleaseTimePath(p)
}

const defaultGit = (repoDir, args, { env, input } = {}) =>
  execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  })

/**
 * Parse `git ls-tree -r -z` output into entries.
 * @param {string} out
 * @returns {Array<{mode:string,type:string,oid:string,path:string}>}
 */
export function parseLsTree(out) {
  const entries = []
  for (const rec of out.split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    const [mode, type, oid] = rec.slice(0, tab).split(' ')
    entries.push({ mode, type, oid, path: rec.slice(tab + 1) })
  }
  return entries
}

/**
 * The surface tree of `treeish` in `repoDir`: a git tree object holding only the compared paths.
 * Written into the repository's object store through a throwaway index, which is removed afterwards.
 * @param {string} repoDir
 * @param {string} treeish a commit or tree
 * @returns {string} tree oid
 */
export function surfaceTree(repoDir, treeish, { git = defaultGit } = {}) {
  const entries = parseLsTree(git(repoDir, ['ls-tree', '-r', '-z', '--full-tree', treeish]))
  const kept = entries.filter((e) => isComparedPath(e.path))
  const tmp = mkdtempSync(join(tmpdir(), 'surface-index-'))
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') }
    git(repoDir, ['read-tree', '--empty'], { env })
    if (kept.length) {
      const input = kept.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join('')
      git(repoDir, ['update-index', '-z', '--index-info'], { env, input })
    }
    return git(repoDir, ['write-tree'], { env }).trim()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Copy an assembled stage into a working copy the way a release does: SURFACE_DIRS replaced wholesale,
 * SURFACE_ROOT_FILES overwritten where the stage has them.
 * @param {string} stageDir
 * @param {string} workDir
 */
export function syncStageIntoWorkTree(stageDir, workDir) {
  for (const d of SURFACE_DIRS) {
    const dst = join(workDir, d)
    rmSync(dst, { recursive: true, force: true })
    if (existsSync(join(stageDir, d))) cpSync(join(stageDir, d), dst, { recursive: true })
  }
  for (const f of SURFACE_ROOT_FILES) {
    const src = join(stageDir, f)
    if (existsSync(src)) cpSync(src, join(workDir, f))
  }
}

/**
 * Replay a release onto `baseRev` in a throwaway worktree of `repoDir` and return the resulting tree
 * (the repository's own .gitignore decides what `git add -A` keeps, exactly as in the release).
 * @param {{repoDir:string, baseRev:string, stageDir:string}} args
 * @returns {string} full tree oid
 */
export function replayStageOntoBase({ repoDir, baseRev, stageDir }, { git = defaultGit } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'surface-replay-'))
  const wt = join(parent, 'wt')
  try {
    git(repoDir, ['worktree', 'add', '-q', '--detach', wt, baseRev])
    syncStageIntoWorkTree(stageDir, wt)
    git(wt, ['add', '-A'])
    return git(wt, ['write-tree']).trim()
  } finally {
    try { git(repoDir, ['worktree', 'remove', '--force', wt]) } catch { /* removed below */ }
    rmSync(parent, { recursive: true, force: true })
    try { git(repoDir, ['worktree', 'prune']) } catch { /* nothing to prune */ }
  }
}

/**
 * Trailers of a commit or tag message: `Key: value` lines of its last paragraph.
 * @param {string} message
 * @returns {Record<string,string>}
 */
export function parseTrailers(message) {
  const paragraphs = String(message).replace(/\r\n/g, '\n').trim().split(/\n{2,}/)
  const last = paragraphs[paragraphs.length - 1] || ''
  const out = {}
  for (const line of last.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*?)[ \t]*$/.exec(line)
    if (m && !(m[1] in out)) out[m[1]] = m[2]
  }
  return out
}

/**
 * The trailer block a release commit ends with. It names no upstream revision: the public repository never
 * carries a sha of the private source (sdk-publish-topology.md §2a provenance map). The verifier finds the
 * revision through the private trigger tag `sdk-release-v<id>` (RELEASE_TRIGGER_TAG_PREFIX + the id of the
 * release branch) with its read-only token.
 * @param {{sourceTree:string, tags:string[]}} args
 */
export function buildReleaseTrailers({ sourceTree, tags }) {
  if (!FULL_SHA_RE.test(sourceTree)) throw new ReleaseSurfaceError('buildReleaseTrailers: sourceTree is not a full 40-hex tree oid')
  if (!Array.isArray(tags) || tags.length === 0) throw new ReleaseSurfaceError('buildReleaseTrailers: no release tags')
  return [
    `${TRAILER_SOURCE_TREE}: ${sourceTree}`,
    `${TRAILER_RELEASE_TAGS}: ${tags.join(' ')}`,
  ].join('\n')
}

/**
 * Read and validate the release trailers of a message.
 * @param {string} message
 * @returns {{ok:true, sourceTree:string, tags:string[]}|{ok:false, reason:string}}
 */
export function readReleaseTrailers(message) {
  const t = parseTrailers(message)
  const sourceTree = (t[TRAILER_SOURCE_TREE] || '').toLowerCase()
  const tags = (t[TRAILER_RELEASE_TAGS] || '').split(/\s+/).filter(Boolean)
  if (!FULL_SHA_RE.test(sourceTree)) return { ok: false, reason: 'missing-source-tree' }
  if (tags.length === 0) return { ok: false, reason: 'missing-release-tags' }
  return { ok: true, sourceTree, tags }
}

/** The private trigger tag prefix; `release/<id>` on the public side pairs with `sdk-release-v<id>`. */
export const RELEASE_TRIGGER_TAG_PREFIX = 'sdk-release-v'
export const RELEASE_BRANCH_PREFIX = 'release/'
const RELEASE_ID_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[a-z][a-z-]*)?$/

/**
 * The release id of a release branch (`release/0.3.1+sdk` -> `0.3.1+sdk`), or null when the branch is not a
 * well-formed release branch. The id names the private trigger tag, so its charset is closed.
 * @param {string} headRef
 */
export function releaseIdFromBranch(headRef) {
  if (typeof headRef !== 'string' || !headRef.startsWith(RELEASE_BRANCH_PREFIX)) return null
  const id = headRef.slice(RELEASE_BRANCH_PREFIX.length)
  return RELEASE_ID_RE.test(id) ? id : null
}

/**
 * Every 40-hex value in `text` that is one of `privateShas` (the object ids of the private repository).
 * The public commit message, the tag annotation and the verification log must return [].
 * @param {string} text
 * @param {Iterable<string>} privateShas
 */
export function privateShaLeaks(text, privateShas) {
  const known = new Set([...privateShas].map((s) => s.toLowerCase()))
  return [...new Set((String(text).toLowerCase().match(/[0-9a-f]{40}/g) || []).filter((s) => known.has(s)))]
}
