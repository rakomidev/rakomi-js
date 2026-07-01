
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function extractBundledModules(metafiles) {
  const bundled = new Map()
  const externals = new Set()
  let sharedInlined = false
  const STORE_RE = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//
  for (const m of metafiles) {
    for (const out of Object.values(m.outputs || {})) {
      for (const inputPath of Object.keys(out.inputs || {})) {
        const store = STORE_RE.exec(inputPath)
        if (store) {
          const { name, version } = parsePnpmStoreDir(store[1])
          if (name && version && !bundled.has(name)) bundled.set(name, { version, storeDir: store[1] })
          continue
        }
        if (/(^|\/)shared\/dist\//.test(inputPath) || inputPath.includes('packages/shared/')) sharedInlined = true
      }
      for (const imp of out.imports || []) {
        if (imp.external && imp.path && !imp.path.startsWith('.') && !imp.path.startsWith('node:')) {
          externals.add(packageRoot(imp.path))
        }
      }
    }
  }
  return { bundled, externals, sharedInlined }
}

export function parsePnpmStoreDir(dir) {
  const noPeer = dir.split('_')[0].split('(')[0]
  const at = noPeer.lastIndexOf('@')
  if (at <= 0) return { name: null, version: null }
  const namePart = noPeer.slice(0, at)
  return { name: namePart.startsWith('@') ? namePart.replace('+', '/') : namePart, version: noPeer.slice(at + 1) }
}

export const packageRoot = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0])

export function installedDir(repoRoot, name, storeDir) {
  return join(repoRoot, 'node_modules/.pnpm', storeDir, 'node_modules', name)
}

export function licenseFilesIn(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^(licen[sc]e|notice|copying)(\..+)?$/i.test(f))
    .sort()
    .map((f) => join(dir, f))
}

export function readInstalledManifest(repoRoot, name, storeDir) {
  const p = join(installedDir(repoRoot, name, storeDir), 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function spdxId(manifest) {
  if (typeof manifest.license === 'string') return manifest.license
  if (manifest.license && typeof manifest.license === 'object' && manifest.license.type) return manifest.license.type
  if (Array.isArray(manifest.licenses) && manifest.licenses[0]?.type) return manifest.licenses[0].type
  return null
}

export function lockfileHas(lockText, name, version) {
  const esc = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s'"/(])${esc}(?![\\w.+-])`, 'm').test(lockText)
}
