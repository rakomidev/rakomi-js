// SPDX-License-Identifier: MIT

/** Default hosts (frozen domain strategy). */
export const DEFAULT_API_BASE_URL = 'https://api.rakomi.com';
export const DEFAULT_ACCOUNTS_BASE_URL = 'https://accounts.rakomi.com';
export const DEFAULT_MCP_URL = 'https://mcp.rakomi.com/mcp';

/**
 * The CLI's own OAuth `client_id` — an OAuth Client ID Metadata Document (CIMD,
 * `draft-ietf-oauth-client-id-metadata-document`) URL. No pre-existing session or server-side seed is
 * needed: the authorization server fetches this document and materializes a per-tenant OAuth client
 * the first time a caller of that tenant authorizes it — the same mechanism already used for
 * connecting AI agents (Claude Code, `claude mcp login rakomi`), reused rather than reinvented.
 *
 * The URL below is under `api.rakomi.com` — a deliberate design choice. The authorization server's
 * anti-self-reference guard still refuses to FETCH a document hosted on its own domain — but this
 * specific URL is one of a small, code-pinned set of first-party client identities the server
 * resolves in-process, with no network fetch at all. No DNS/infra step is needed: `api.rakomi.com`
 * is already the live API host in every environment.
 *
 * Overridable via `RAKOMI_CLIENT_ID` — a fixture/dev environment, or a tenant that has disabled
 * client-metadata-document login, can point at a different, manually-pre-registered client instead.
 */
export const DEFAULT_CIMD_CLIENT_ID_URL = 'https://api.rakomi.com/.well-known/rakomi-cli/client-metadata.json';

/**
 * True iff `id` is a CIMD `client_id` — an absolute `https://` URL, no userinfo, no fragment. A
 * deliberate, minimal, standalone re-implementation of the server's own recognizer rather than a
 * dependency on it: this package ships with ZERO runtime dependencies by design (a tiny install
 * footprint), so importing server-side code is not an option. The two predicates MUST agree (both
 * accept exactly "absolute https URL, no credentials, no fragment"); a should-FAIL/should-PASS parity
 * check lives in `env.test.ts`. This copy is used ONLY to decide user-facing behaviour (which error to
 * print for `--no-browser` — see `login.ts`) — it never gates anything security-relevant, that stays
 * server-side.
 */
export function isCimdClientId(id: string): boolean {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
}

/** Env vars the CLI reads directly (never `process.env.X` outside this module — see the repo's banned-patterns rule). */
export interface CliEnv {
  readonly RAKOMI_API_URL?: string;
  readonly RAKOMI_ACCOUNTS_URL?: string;
  readonly RAKOMI_CLIENT_ID?: string;
  readonly RAKOMI_CONFIG_DIR?: string;
  readonly CI?: string;
  readonly NO_COLOR?: string;
}

export function apiBaseUrl(env: CliEnv): string {
  return env.RAKOMI_API_URL || DEFAULT_API_BASE_URL;
}

export function accountsBaseUrl(env: CliEnv): string {
  return env.RAKOMI_ACCOUNTS_URL || DEFAULT_ACCOUNTS_BASE_URL;
}

export function clientId(env: CliEnv): string {
  return env.RAKOMI_CLIENT_ID || DEFAULT_CIMD_CLIENT_ID_URL;
}
