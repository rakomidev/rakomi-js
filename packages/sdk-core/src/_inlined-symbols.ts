
interface WhatwgURLLike {
  pathname: string;
  protocol: string;
  hash: string;
  host: string;
  toString(): string;
}

declare const URL: {
  new (input: string, base?: string): WhatwgURLLike;
};

export class FrozenEndpointError extends Error {
  constructor(
    readonly code: 'fragment_component' | 'insecure_scheme' | 'double_slash' | 'host_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'FrozenEndpointError';
  }
}

/**
 * Take a FROZEN absolute endpoint, keep its **path**, re-host it onto `deploymentUrl`.
 *
 * This is the one production matcher. It is exported so a conformance test can
 * drive it with a **planted frozen endpoint** (a should-FAIL probe) instead of
 * re-declaring a copy: a probe that plants its violation in the *emitted value*
 * would still pass against a re-hard-coded literal, so the plant has to go in the
 * CONSTANT position — which requires the constant to be an argument somewhere.
 *
 * Rejects, rather than silently mangling, the shapes RFC 6749 §3.1 / RFC 8414 §2
 * forbid at an authorization endpoint. Throwing beats returning a bad URL: a
 * malformed `authorization_endpoint` in a published discovery document is a
 * conformance failure every RP sees.
 */
export function rehostFrozenEndpoint(frozenEndpoint: string, deploymentUrl: string): string {
  const frozen = new URL(frozenEndpoint);
  if (frozen.hash !== '') {
    throw new FrozenEndpointError('fragment_component', 'frozen endpoint must not carry a fragment component');
  }
  if (frozen.protocol !== 'https:') {
    throw new FrozenEndpointError('insecure_scheme', 'frozen endpoint must use https');
  }
  const rehosted = new URL(frozen.pathname, deploymentUrl);
  if (rehosted.protocol !== 'https:') {
    throw new FrozenEndpointError('insecure_scheme', 'deployment url must use https');
  }
  if (rehosted.pathname.startsWith('//')) {
    throw new FrozenEndpointError('double_slash', 'rehosted endpoint produced a double slash');
  }
  if (rehosted.host !== new URL(deploymentUrl).host) {
    throw new FrozenEndpointError(
      'host_mismatch',
      'rehosted endpoint changed host — the frozen path is protocol-relative (`//…`) or otherwise re-hosting',
    );
  }
  return rehosted.toString();
}

export const RAKOMI_PLATFORM_AUTHORIZATION_ENDPOINT =
  'https://accounts.rakomi.com/authorize';

export function buildAuthorizationEndpoint(accountsUrl: string): string {
  return rehostFrozenEndpoint(RAKOMI_PLATFORM_AUTHORIZATION_ENDPOINT, accountsUrl);
}

export const GA_LOCALES = [
  'en',
  'pl',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'et',
  'fi',
  'fr',
  'ga',
  'hr',
  'hu',
  'it',
  'lt',
  'lv',
  'mt',
  'nl',
  'pt',
  'ro',
  'sk',
  'sl',
  'sv',
] as const;

export type GaLocale = (typeof GA_LOCALES)[number];

export function isGaLocale(value: unknown): value is GaLocale {
  return typeof value === 'string' && (GA_LOCALES as readonly string[]).includes(value);
}
