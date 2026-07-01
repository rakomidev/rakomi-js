#!/usr/bin/env node

import { cpSync, existsSync, rmSync } from 'node:fs'

const [src, dest] = process.argv.slice(2)
if (!src || !dest) {
  console.error('usage: copy-dir.mjs <src> <dest>')
  process.exit(2)
}
if (!existsSync(src)) {
  console.error(`copy-dir: source does not exist: ${src}`)
  process.exit(1)
}
rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true })
