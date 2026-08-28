// SPDX-License-Identifier: MIT

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';

import { CliError, EXIT, UsageError } from './errors.js';
import { archiveUrl, DEFAULT_TEMPLATE_BASE, type Template } from './templates.js';

/** Max compressed bytes downloaded before aborting the stream. */
export const COMPRESSED_CAP = 50 * 1024 * 1024;
/** Max total decompressed bytes — aborts mid-inflate to defeat a decompression bomb. */
export const DECOMPRESSED_CAP = 100 * 1024 * 1024;
/** Max bytes for any single archive entry. */
export const MAX_ENTRY_SIZE = 50 * 1024 * 1024;
/** Max number of materialised entries. */
export const MAX_ENTRIES = 20000;
/** Fetch timeout — also the no-hang guarantee. */
export const FETCH_TIMEOUT_MS = 30_000;
/** Bounded retry for transient failures (timeout / 5xx / 429 / reset). */
export const MAX_RETRIES = 2;

/** A `fetch`-compatible function — injectable so tests never touch the network. */
export type FetchLike = (url: string, init: { redirect: 'error'; signal: AbortSignal }) => Promise<Response>;

/** A source of template archives (gzip'd tar bytes), injectable for offline tests. */
export interface TemplateSource {
  /** Return the gzip'd tar archive for a template, or throw a user-safe `CliError`. */
  fetchArchive(template: Template): Promise<Buffer>;
}

/** Internal fetch error carrying whether the failure class is worth a retry. */
class FetchError extends CliError {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message, EXIT.FAIL);
    this.name = 'FetchError';
    this.retryable = retryable;
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The default source: GitHub codeload tarball over `fetch`, no `git` subprocess. HTTPS-only,
 * host-pinned to the base's host, refuses redirects, bounded timeout + retry, and sniffs the
 * body before it ever reaches the extractor.
 */
export class GithubCodeloadSource implements TemplateSource {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(opts: {
    base?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    maxRetries?: number;
    backoffMs?: number;
  } = {}) {
    this.base = opts.base ?? DEFAULT_TEMPLATE_BASE;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? MAX_RETRIES;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  async fetchArchive(template: Template): Promise<Buffer> {
    const url = archiveUrl(template, this.base);
    let pinnedHost: string;
    try {
      const baseUrl = new URL(this.base);
      if (baseUrl.protocol !== 'https:') {
        throw new UsageError('Template source must be an https:// URL.');
      }
      pinnedHost = baseUrl.host;
    } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError('Template source is not a valid URL.');
    }

    let lastError: CliError = new FetchError('Could not download the template.', false);
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.attempt(url, pinnedHost, template);
      } catch (e) {
        if (e instanceof FetchError && e.retryable && attempt < this.maxRetries) {
          lastError = e;
          await delay(this.backoffMs * (attempt + 1));
          continue;
        }
        if (e instanceof CliError) throw e;
        lastError = new FetchError('Network error while downloading the template.', true);
        if (attempt < this.maxRetries) {
          await delay(this.backoffMs * (attempt + 1));
          continue;
        }
      }
    }
    throw lastError;
  }

  private async attempt(url: string, pinnedHost: string, template: Template): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { redirect: 'error', signal: controller.signal });
    } catch {
      throw new FetchError('Timed out or failed while downloading the template.', true);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new FetchError('The template source attempted an unexpected redirect; refusing.', false);
    }
    if (response.status === 404) {
      throw new FetchError(`Template "${template.slug}" is not available yet.`, false);
    }
    if (response.status === 429) {
      throw new FetchError('The template source is rate-limiting requests; please retry shortly.', true);
    }
    if (response.status >= 500) {
      throw new FetchError('The template source is temporarily unavailable.', true);
    }
    if (!response.ok) {
      throw new FetchError('Could not download the template.', false);
    }

    const finalHost = new URL(response.url || url).host;
    if (finalHost !== pinnedHost) {
      throw new FetchError('The template download resolved to an unexpected host; refusing.', false);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (/html|text\/plain/i.test(contentType)) {
      throw new FetchError('The template source returned an unexpected response; refusing.', false);
    }

    const body = await readBodyCapped(response, COMPRESSED_CAP);
    if (!isGzip(body)) {
      throw new FetchError('The template source returned a non-archive response; refusing.', false);
    }
    return body;
  }
}

/** A fixture source for tests — returns pre-built gzip'd tar bytes with no network. */
export class LocalFixtureSource implements TemplateSource {
  constructor(private readonly bySlug: Record<string, Buffer>) {}

  async fetchArchive(template: Template): Promise<Buffer> {
    const bytes = this.bySlug[template.slug];
    if (!bytes) throw new CliError(`No fixture for template "${template.slug}".`, EXIT.FAIL);
    return bytes;
  }
}

/** True if the buffer begins with the gzip magic bytes. */
export function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

async function readBodyCapped(response: Response, cap: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > cap) throw new FetchError('The template download is too large; refusing.', false);
    return Buffer.from(ab);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new FetchError('The template download is too large; refusing.', false);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Gunzip with a hard cap on decompressed bytes, aborting mid-inflate on breach. */
export function gunzipCapped(input: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        gunzip.destroy();
        reject(new CliError('The template archive is too large to extract safely.', EXIT.FAIL));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('end', () => resolvePromise(Buffer.concat(chunks)));
    gunzip.on('error', () => reject(new CliError('The template archive is corrupt or truncated.', EXIT.FAIL)));
    gunzip.end(input);
  });
}

interface TarEntry {
  readonly type: 'file' | 'dir';
  readonly path: string;
  readonly data?: Buffer;
}

function readCString(block: Buffer, start: number, len: number): string {
  const slice = block.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.toString('utf8', 0, nul === -1 ? len : nul);
}

function parseOctal(block: Buffer, start: number, len: number): number {
  const raw = readCString(block, start, len).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new CliError('The template archive has a malformed header.', EXIT.FAIL);
  }
  return parseInt(raw, 8);
}

/** Parse a (decompressed) tar buffer, rejecting link and special-file entries outright. */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let count = 0;
  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const name = readCString(block, 0, 100);
    const size = parseOctal(block, 124, 12);
    const typeflag = String.fromCharCode(block[156] ?? 0);
    const prefix = readCString(block, 345, 155);
    offset += 512;
    const dataBlocks = Math.ceil(size / 512);

    if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
      offset += dataBlocks * 512;
      continue;
    }
    if (typeflag === '1' || typeflag === '2') {
      throw new CliError('The template archive contains a link entry; refusing for safety.', EXIT.FAIL);
    }
    if (typeflag === '3' || typeflag === '4' || typeflag === '6') {
      throw new CliError('The template archive contains a special-file entry; refusing for safety.', EXIT.FAIL);
    }
    if (size > MAX_ENTRY_SIZE) {
      throw new CliError('The template archive contains an oversized entry; refusing.', EXIT.FAIL);
    }
    if (++count > MAX_ENTRIES) {
      throw new CliError('The template archive contains too many entries; refusing.', EXIT.FAIL);
    }

    const fullName = prefix ? `${prefix}/${name}` : name;
    if (typeflag === '5') {
      entries.push({ type: 'dir', path: fullName });
    } else {
      entries.push({ type: 'file', path: fullName, data: Buffer.from(buf.subarray(offset, offset + size)) });
    }
    offset += dataBlocks * 512;
  }
  return entries;
}

/** Normalise an archive path: forward slashes, leading slashes stripped, `..` preserved. */
function normalizeEntryPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Materialise a gzip'd tar archive into `targetDir`: gunzip (capped), parse (link/special
 * rejected), strip the leading codeload wrapper dir, reject any entry that escapes the target,
 * extract into a temp sibling, then atomically rename into place. Any failure cleans up the
 * partial temp output (one `rm`, not a walk).
 */
export async function materializeArchive(gzipBytes: Buffer, targetDir: string): Promise<void> {
  if (!isGzip(gzipBytes)) {
    throw new CliError('The template archive is not a gzip archive; refusing.', EXIT.FAIL);
  }
  const tar = await gunzipCapped(gzipBytes, DECOMPRESSED_CAP);
  const entries = parseTar(tar);
  if (entries.length === 0) {
    throw new CliError('The template archive is empty; refusing.', EXIT.FAIL);
  }

  const wrapper = normalizeEntryPath(entries[0]!.path).split('/')[0] ?? '';
  const target = resolve(targetDir);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const tmpDir = await mkdtemp(join(parent, '.create-rakomi-app-'));

  try {
    for (const entry of entries) {
      const norm = normalizeEntryPath(entry.path);
      if (norm !== wrapper && !norm.startsWith(`${wrapper}/`)) {
        throw new CliError('A template archive entry escapes the template root; refusing.', EXIT.FAIL);
      }
      const stripped = norm === wrapper ? '' : norm.slice(wrapper.length + 1);
      if (stripped === '') continue;

      const dest = resolve(tmpDir, stripped);
      const rel = relative(tmpDir, dest);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new CliError('A template archive entry escapes the template root; refusing.', EXIT.FAIL);
      }

      if (entry.type === 'dir') {
        await mkdir(dest, { recursive: true });
      } else {
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, entry.data ?? Buffer.alloc(0));
      }
    }
    await moveIntoPlace(tmpDir, target);
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

async function moveIntoPlace(tmpDir: string, target: string): Promise<void> {
  if (existsSync(target)) {
    await rmdir(target);
  }
  await rename(tmpDir, target);
}

/**
 * Refuse to scaffold into a non-empty target (no clobber, no partial write). The chosen policy
 * is strict-refuse: any existing entry makes the directory ineligible. This keeps the atomic
 * extract-to-temp-then-rename safe (the target is always empty or absent at materialise time)
 * and is the most fail-closed reading of the safety requirement. Throws a `UsageError` (exit 2).
 */
export async function assertTargetWritable(targetDir: string): Promise<void> {
  const target = resolve(targetDir);
  if (!existsSync(target)) return;
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    throw new UsageError(`Cannot read the target directory "${targetDir}".`);
  }
  if (entries.length > 0) {
    throw new UsageError(`Target directory "${targetDir}" is not empty; refusing to overwrite.`);
  }
}
