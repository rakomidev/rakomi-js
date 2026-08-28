
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(SELF_DIR, '..', '..');

export class LegalEntityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LegalEntityError';
  }
}

export function readLegalEntity(repoRoot = DEFAULT_REPO_ROOT) {
  const path = join(repoRoot, 'scripts', 'data', 'legal-entity.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new LegalEntityError(
      `cannot read legal-entity source of truth (${path}): ${(err && (err.code || err.message)) || 'error'}`,
    );
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LegalEntityError(`legal-entity source of truth is not valid JSON (${path})`);
  }
  if (typeof data.legalName !== 'string' || data.legalName.trim().length === 0) {
    throw new LegalEntityError(`legal-entity source of truth has a missing/empty legalName (${path})`);
  }
  const url = typeof data.url === 'string' ? data.url : '';
  return { legalName: data.legalName, url };
}

export function legalName(repoRoot) {
  return readLegalEntity(repoRoot).legalName;
}
