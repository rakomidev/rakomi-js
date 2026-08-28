import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isCliEntry(importMetaUrl) {
  const argv1 = process.argv[1]
  if (!argv1) return false
  let self
  try {
    self = fileURLToPath(importMetaUrl)
  } catch {
    return false
  }
  const resolve = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  return resolve(argv1) === resolve(self)
}
