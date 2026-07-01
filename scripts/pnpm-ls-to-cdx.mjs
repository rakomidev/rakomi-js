#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class PnpmLsError extends Error {}

export function makePurl(name, version) {
  const encoded = name.startsWith('@')
    ? '%40' + name.slice(1).replace('/', '%2F')
    : name;
  return `pkg:npm/${encoded}@${version}`;
}

export function normalizePurl(purl) {
  try {
    return decodeURIComponent(purl);
  } catch {
    return purl.split('%40').join('@').split('%2F').join('/');
  }
}

function resolveVersion(info) {
  if (!info.version.startsWith('link:')) return info.version;
  try {
    const pkg = JSON.parse(readFileSync(join(info.path, 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return '0.0.0-workspace';
  }
}

function walkTree(root) {
  const components = [];
  const depRelationships = [];
  const seen = new Set();

  function walk(pkg) {
    const deps = pkg.dependencies ?? {};
    const childRefs = [];
    for (const [name, info] of Object.entries(deps)) {
      const version = resolveVersion(info);
      const purl = makePurl(name, version);
      childRefs.push(purl);
      if (!seen.has(purl)) {
        seen.add(purl);
        components.push({ type: 'library', 'bom-ref': purl, name, version, purl });
        const transitiveDeps = walk(info);
        depRelationships.push({ ref: purl, dependsOn: transitiveDeps });
      }
    }
    return childRefs;
  }

  const rootPurl = makePurl(root.name, root.version);
  const rootDeps = walk(root);
  depRelationships.unshift({ ref: rootPurl, dependsOn: rootDeps });
  return { rootPurl, rootDeps, components, depRelationships };
}

export function componentSetFromPnpmLs(lsArray) {
  if (!Array.isArray(lsArray) || lsArray.length === 0 || typeof lsArray[0] !== 'object') {
    throw new PnpmLsError('pnpm-ls-to-cdx: expected a non-empty `pnpm ls --json` array');
  }
  const { components } = walkTree(lsArray[0]);
  return new Set(components.map((c) => normalizePurl(c.purl)));
}

export function prodClosureForSeeds(lsArray, seedNames) {
  if (!Array.isArray(lsArray) || lsArray.length === 0 || typeof lsArray[0] !== 'object') {
    throw new PnpmLsError('pnpm-ls-to-cdx: expected a non-empty `pnpm ls --json` array');
  }
  const seeds = seedNames instanceof Set ? seedNames : new Set(seedNames);
  const out = new Set();
  const seen = new Set();
  const topDeps = lsArray[0].dependencies ?? {};
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

export function buildCdxFromPnpmLs(lsArray, { serialNumber, timestamp }) {
  const root = lsArray[0];
  const { rootPurl, components, depRelationships } = walkTree(root);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    serialNumber,
    metadata: {
      timestamp,
      tools: [{ vendor: 'Rakomi', name: 'pnpm-ls-to-cdx', version: '1.0.0' }],
      component: {
        type: 'library',
        'bom-ref': rootPurl,
        name: root.name,
        version: root.version,
        purl: rootPurl,
      },
    },
    components,
    dependencies: depRelationships,
  };
}

function main() {
  const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
  const doc = buildCdxFromPnpmLs(input, {
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
  });
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
