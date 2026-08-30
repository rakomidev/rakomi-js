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
 * Story rakomi-platform-tenant-provisioning — the prod "platform tenant" `rakomi login`'s
 * CIMD-default loopback flow authenticates the developer's account against when
 * `RAKOMI_PLATFORM_TENANT_ID` is unset AND the caller has not overridden `RAKOMI_API_URL`/
 * `RAKOMI_ACCOUNTS_URL` away from their own defaults (see `platformTenantId()` below). Committed
 * here deliberately — it is not a secret (the same reasoning already applied to the reserved
 * canary-tenant ids elsewhere in this codebase), and this package ships with ZERO runtime
 * dependencies (`isCimdClientId`'s doc comment above), so it cannot be imported from the shared
 * types package — kept in sync with the API config's own `PLATFORM_TENANT_ID` by convention, the
 * same discipline `isValidTenantId` below already uses for its server-side counterpart.
 */
export const DEFAULT_PLATFORM_TENANT_ID = '01ef847e-4c40-4960-af05-11112c4764b2';

/**
 * Story rakomi-cli-login-ci-oidc-federation — the CI-only `StoredSession.client_id` sentinel
 * `rakomi login --ci` writes. There is no `oauth_clients` row for this grant (the tenant's trust
 * policy IS the credential — see `oidc-federation-login.ts`'s module doc), so this is a readable
 * marker rather than a real client identity. Exported here (not left local to `login.ts`) because
 * `install-key.ts`'s `resolveDpopKey()` — Story rakomi-cli-ci-session-per-request-dpop-wiring —
 * also needs to recognize it, to resolve the SAME durable key `login --ci` persisted at exchange time.
 */
export const CI_FEDERATION_SESSION_CLIENT_ID = 'oidc-federation';

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
  /**
   * Story rakomi-cli-login-identity-first-platform-tenant (mechanism) + rakomi-platform-tenant-
   * provisioning (the real tenant) — which tenant `rakomi login`'s CIMD-default loopback flow
   * authenticates the developer's account against (passed through as `tenant_id` on the accounts
   * `/authorize`/`/login` URL — the same, already-reviewed mechanism register/reset-password links
   * use, `resolve-entry-tenant.ts`). A CIMD `client_id` cannot be resolved to a tenant server-side
   * on its own (a known, tracked gap) — without this, a genuinely cold login (no prior
   * accounts.rakomi.com session) hits accounts' honest "no resolvable tenant" dead end AFTER a
   * browser already opened (the 2026-08-30 11:40-11:48Z incident this story closes).
   *
   * When unset AND the caller has not overridden `RAKOMI_API_URL`/`RAKOMI_ACCOUNTS_URL` away from
   * their own defaults, `platformTenantId()` now falls back to `DEFAULT_PLATFORM_TENANT_ID` — the
   * real, committed prod platform tenant id — rather than failing fast: the default, no-env
   * experience (`npx rakomi login`, the Claude Desktop MCP connector) IS talking to prod, so it
   * should resolve to prod's real platform tenant, not to an error. A host override WITHOUT a
   * matching `RAKOMI_PLATFORM_TENANT_ID` override still fails fast (dev/staging are not defaulted
   * this way — dev's `.mise.toml [env]` sets this explicitly to its own dedicated seed tenant;
   * staging has no default-fallback wiring yet, matching the pre-provisioning design this story
   * does not change for staging). Overridable per-invocation via `rakomi login --tenant-id <uuid>`.
   */
  readonly RAKOMI_PLATFORM_TENANT_ID?: string;
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

const TENANT_ID_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const MAX_TENANT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/**
 * Story rakomi-cli-login-identity-first-platform-tenant — a deliberate, minimal, standalone copy
 * of accounts' `resolve-entry-tenant.ts` `isIdentifyingTenantId()` predicate (same reasoning as
 * `isCimdClientId` above: zero runtime deps, cannot import server/accounts code). The two MUST
 * agree on what counts as a real, usable tenant id — a 36-char UUID that is neither the nil nor the
 * max UUID (both well-formed but semantically non-identifying, and excluded server-side for exactly
 * that reason). Kept in sync by convention.
 */
export function isValidTenantId(id: string): boolean {
  if (id.length !== 36) return false;
  if (!TENANT_ID_UUID_PATTERN.test(id)) return false;
  const lower = id.toLowerCase();
  return lower !== NIL_TENANT_ID && lower !== MAX_TENANT_ID;
}

/**
 * The "platform tenant" `rakomi login`'s CIMD-default loopback flow authenticates against — see
 * `CliEnv.RAKOMI_PLATFORM_TENANT_ID`'s doc comment. Returns `undefined` when unset-and-not-defaulted
 * OR malformed; callers (`login.ts`) are responsible for turning that into an actionable error
 * rather than silently proceeding without a `tenant_id` — the whole point of the story that
 * introduced this function.
 *
 * story rakomi-platform-tenant-provisioning: unset falls back to `DEFAULT_PLATFORM_TENANT_ID` IFF
 * BOTH host URLs are still their own unoverridden defaults (`apiBaseUrl`/`accountsBaseUrl` both
 * resolve to `DEFAULT_API_BASE_URL`/`DEFAULT_ACCOUNTS_BASE_URL`) — i.e. the caller is talking to
 * prod with no other override either. A malformed explicit value is still `undefined`, never
 * silently replaced by the default — an operator who set something wrong should see that error, not
 * have it papered over.
 */
export function platformTenantId(env: CliEnv): string | undefined {
  const raw = env.RAKOMI_PLATFORM_TENANT_ID;
  if (raw) return isValidTenantId(raw) ? raw : undefined;
  const isUnoverriddenProdHost = apiBaseUrl(env) === DEFAULT_API_BASE_URL && accountsBaseUrl(env) === DEFAULT_ACCOUNTS_BASE_URL;
  return isUnoverriddenProdHost ? DEFAULT_PLATFORM_TENANT_ID : undefined;
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
