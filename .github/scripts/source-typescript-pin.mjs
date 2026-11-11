#!/usr/bin/env node
// The TypeScript compiler the source assembler parses with must be the version the source revision locks,
// or the re-derived tree can differ for reasons unrelated to the source. Two modes:
//   read   — print `<version> <integrity>` on stdout from the source lockfile's root importer;
//   check  — compare an installed npm package-lock.json entry with the expected integrity.
// Prints only the version (a public package version), never a path from the source checkout.
// Exit: 0 = OK, 1 = mismatch, 2 = cannot evaluate.
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Root-importer typescript version and its integrity from a pnpm v9 lockfile text.
 * @param {string} text
 * @returns {{version:string, integrity:string}|null}
 */
export function readTypescriptPin(text) {
  const lines = String(text).split('\n')
  const imp = lines.indexOf('importers:')
  if (imp < 0) return null
  let i = lines.indexOf('  .:', imp)
  if (i < 0) return null
  let version = null
  for (i += 1; i < lines.length && !/^ {2}\S/.test(lines[i]) && !/^\S/.test(lines[i]); i++) {
    if (lines[i] === '      typescript:') {
      const m = /^ {8}version: ([0-9][^\s(]*)/.exec(lines[i + 2] || '') || /^ {8}version: ([0-9][^\s(]*)/.exec(lines[i + 1] || '')
      if (m) version = m[1]
      break
    }
  }
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null
  const key = `  typescript@${version}:`
  const at = lines.indexOf(key)
  if (at < 0) return null
  const m = /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(lines[at + 1] || '')
  if (!m) return null
  return { version, integrity: m[1] }
}

function main() {
  const [mode, file, expected] = process.argv.slice(2)
  try {
    if (mode === 'read') {
      const pin = readTypescriptPin(readFileSync(file, 'utf8'))
      if (!pin) { console.error('source-typescript-pin: CANNOT-EVALUATE — no typescript pin in the source lockfile'); process.exit(2) }
      process.stdout.write(`${pin.version} ${pin.integrity}\n`)
      console.error(`source-typescript-pin: typescript ${pin.version}`)
      return
    }
    if (mode === 'check') {
      const lock = JSON.parse(readFileSync(file, 'utf8'))
      const got = lock?.packages?.['node_modules/typescript']?.integrity
      if (got !== expected) { console.error('source-typescript-pin: FAIL — the installed typescript integrity differs from the source lockfile'); process.exit(1) }
      console.error('source-typescript-pin: OK')
      return
    }
  } catch {
    console.error('source-typescript-pin: CANNOT-EVALUATE')
    process.exit(2)
  }
  console.error('usage: source-typescript-pin.mjs read <pnpm-lock.yaml> | check <package-lock.json> <integrity>')
  process.exit(2)
}

const isCliEntry = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  const real = (p) => { try { return realpathSync(p) } catch { return p } }
  try { return real(argv1) === real(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isCliEntry) main()
