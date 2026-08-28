// SPDX-License-Identifier: MIT

import { type Template, TEMPLATES } from './templates.generated.js';

export type { Template, TemplateSlug } from './templates.generated.js';

/** The public portal host where each quickstart's walkthrough lives (post-install URL). */
export const PORTAL_HOST = 'examples.rakomi.dev';

/**
 * The default base for fetching template archives. Overridable at runtime via
 * `--template-source` / `CREATE_RAKOMI_TEMPLATE_BASE` (mirror, offline, or emergency
 * repoint). The host of this base is the only host the fetch is allowed to reach.
 */
export const DEFAULT_TEMPLATE_BASE = 'https://codeload.github.com';

/**
 * Return every scaffoldable template, in manifest order. The data is baked in at build
 * time (see `templates.generated.ts`) — there is no runtime read of the manifest, so the
 * published bin works for an npm consumer who never has the repo's `examples/` tree.
 */
export function loadTemplates(): readonly Template[] {
  return TEMPLATES;
}

/**
 * Resolve a slug to its template by exact membership check. Returns `undefined` for an
 * unknown slug — the slug is never sanitised or coerced, only matched against the
 * allow-list, and is never concatenated into a URL or path before this check passes.
 */
export function findTemplate(slug: string): Template | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
}

/** The comma-separated list of valid slugs, for usage and error messages. */
export function slugList(): string {
  return loadTemplates()
    .map((t) => t.slug)
    .join(', ');
}

/** The post-install walkthrough URL for a template. */
export function portalUrl(slug: string): string {
  return `https://${PORTAL_HOST}/quickstart/${slug}`;
}

/**
 * The codeload archive URL for a template, derived from its `publicRepo` and the given base.
 * Pinned to the `main` branch ref (a future enhancement could pin a tagged ref per template).
 */
export function archiveUrl(template: Template, base: string = DEFAULT_TEMPLATE_BASE): string {
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 47) end -= 1;
  const trimmed = base.slice(0, end);
  return `${trimmed}/${template.publicRepo}/tar.gz/refs/heads/main`;
}
