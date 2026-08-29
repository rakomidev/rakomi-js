// SPDX-License-Identifier: MIT

import type { HttpDeps } from './http.js';
import { request } from './http.js';

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

/**
 * Story rakomi-cli-cimd-disabled-fallback-error — the RFC 8414 / MCP Authorization discovery field the
 * API's `GET /.well-known/oauth-authorization-server` advertises IFF the platform-wide CIMD kill-switch
 * is on (advertise-IFF-honored: a disabled environment advertises it to NOBODY, and every environment
 * that advertises it serves it). MUST match the equivalent server-side constant name — this package
 * ships with ZERO runtime deps (see `isCimdClientId`'s own comment above), so importing the server's
 * constant is not an option; kept in sync by convention, the same discipline `login.ts`'s `LOGIN_SCOPE`
 * already uses for the CIMD document's `scope` field.
 */
const CLIENT_ID_METADATA_DOCUMENT_SUPPORTED_FIELD = 'client_id_metadata_document_supported';

/**
 * Preflight: does THIS API host honor CIMD sign-in right now? Returns `true`/`false` on a clean
 * signal, `undefined` when the signal could not be read (network error, non-200, malformed body) —
 * callers MUST treat `undefined` as "proceed as before", never as `false`. WHY a preflight rather than
 * reading the eventual authorize/token error: the platform CIMD kill-switch rejects a CIMD `client_id`
 * at the API's `/oauth/authorize` PRE-REDIRECT JSON boundary (RFC 6749 §4.1.2.1 — a step BEFORE
 * `redirect_uri` is validated, so it MUST NOT redirect). The browser-rendered accounts app therefore
 * cannot bounce back to this CLI's loopback listener on that rejection, and `rakomi login` would
 * otherwise just sit at the loopback listener for the full 5-minute timeout with no actionable signal
 * at all — this preflight turns that into an immediate, actionable message.
 *
 * This is deliberately TENANT-BLIND: `.well-known/oauth-authorization-server` is public,
 * unauthenticated, platform-wide metadata (`noAuth()` on the server route) — it carries no
 * tenant-existence signal, so reading it before login cannot become the cross-tenant oracle the
 * server's uniform "Unknown client" reply is designed to avoid (`authorize-route.ts` R3-4).
 *
 * DISCLOSED RESIDUAL: a SEPARATE per-tenant opt-in column (`tenants.cimd_enabled`, distinct from this
 * platform-wide flag) is not observable here — a caller whose own tenant has not opted in still sees
 * `true` from this check (the platform honors CIMD generally) and still hits the same un-diagnosable
 * loopback timeout. Detecting that would need either an authenticated probe (circular — the caller is
 * trying to log in) or a distinguishable server-side error code, which the uniform-reject design
 * deliberately withholds; a tracked follow-up widens it deliberately, never by default.
 */
export async function isCimdPlatformSupported(deps: HttpDeps, apiUrl: string): Promise<boolean | undefined> {
  try {
    const result = await request<Record<string, unknown>>(deps, {
      method: 'GET',
      url: `${apiUrl}/.well-known/oauth-authorization-server`,
    });
    if (result.status !== 200) return undefined;
    return result.body[CLIENT_ID_METADATA_DOCUMENT_SUPPORTED_FIELD] === true;
  } catch {
    return undefined;
  }
}
