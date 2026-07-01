
export type CanonicalUrlVersion = 'rfc9449-2023';

export interface CanonicalizeUrlOptions {
  version?: CanonicalUrlVersion;
}

export class CanonicalizeUrlError extends Error {
  constructor(
    public readonly code: 'invalid_url' | 'unsupported_version',
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalizeUrlError';
  }
}

function collapsePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

function lowercasePercentHex(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => `%${h.toLowerCase()}`);
}

export function canonicalizeUrl(input: string, options: CanonicalizeUrlOptions = {}): string {
  const version = options.version ?? 'rfc9449-2023';
  if (version !== 'rfc9449-2023') {
    throw new CanonicalizeUrlError('unsupported_version', `unsupported canonicalize-url version: ${version}`);
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CanonicalizeUrlError('invalid_url', 'invalid url');
  }

  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }

  url.search = '';
  url.hash = '';

  const normalizedPath = collapsePath(lowercasePercentHex(url.pathname));

  const host = url.host;
  return `${url.protocol}//${host}${normalizedPath}`;
}
