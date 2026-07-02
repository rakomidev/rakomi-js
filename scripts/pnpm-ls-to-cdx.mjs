
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class PnpmLsError extends Error {}

export function makePurl(name, version) {
  const encoded = name.startsWith('@')
    ? '%40' + name.slice(1).replace(/\//g, '%2F')
    : name;
  return `pkg:npm/${encoded}@${version}`;
}

export function normalizePurl(purl) {
  try {
    return decodeURIComponent(purl);
  } catch {
    return purl.replace(/%2F/gi, '/').replace(/%40/gi, '@');
  }
}

function resolveVersion(info) {
  if (info == null || typeof info.version !== 'string') {
    throw new PnpmLsError(`pnpm ls node has no string version (unresolved/optional entry): ${JSON.stringify(info?.version)}`);
  }
  if (!info.version.startsWith('link:')) return info.version;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(info.path, 'package.json'), 'utf8'));
  } catch (e) {
    throw new PnpmLsError(`cannot resolve workspace link version from ${info.path}/package.json: ${e.message}`);
  }
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new PnpmLsError(`workspace package.json at ${info.path} has no usable version`);
  }
  return pkg.version;
}

export function prodClosureForSeeds(lsArray, seedNames) {
  if (!Array.isArray(lsArray) || lsArray.length === 0 || typeof lsArray[0] !== 'object') {
    throw new PnpmLsError('pnpm-ls-to-cdx: expected a non-empty `pnpm ls --json` array');
  }
  const seeds = seedNames instanceof Set ? seedNames : new Set(seedNames);
  const out = new Set();
  const seen = new Set();
  const topDeps = lsArray[0].dependencies ?? {};
  const unresolved = [...seeds].filter((n) => !Object.prototype.hasOwnProperty.call(topDeps, n));
  if (unresolved.length) {
    throw new PnpmLsError(`seed(s) declared in the manifest but ABSENT from the pnpm ls --prod tree (pruned/unresolved — refusing a silently-narrowed closure): ${unresolved.join(', ')}`);
  }
  const walk = (name, info) => {
    const purl = normalizePurl(makePurl(name, resolveVersion(info)));
    if (seen.has(purl)) return;
    seen.add(purl);
    out.add(purl);
    for (const [childName, childInfo] of Object.entries(info.dependencies ?? {})) walk(childName, childInfo);
  };
  for (const [name, info] of Object.entries(topDeps)) {
    if (seeds.has(name)) walk(name, info);
  }
  return out;
}
