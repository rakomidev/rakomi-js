// SPDX-License-Identifier: MIT

import { type FetchLike, request } from './http.js';
import { resolveDpopKey } from './install-key.js';
import type { KeyStore, SessionStore, StoredSession } from './session.js';

interface RefreshTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly error?: string;
}

export interface RefreshDeps {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Attempts a silent `refresh_token` grant for `session`. On success, PERSISTS the rotated session
 * (new `access_token` + rotated `refresh_token` + recomputed `expires_at`) to `sessionStore` and
 * returns the new access token. Returns `undefined` — NEVER throws — on any failure: no
 * `refresh_token` on the session (a `--client`/device-grant/`--ci` session may carry one or may
 * not, depending on what the server granted), a non-200 response (`invalid_grant` — the refresh
 * token itself is expired/revoked/reused), a malformed response body, or a network/timeout error.
 * The caller (`http.ts`'s `request()`, via the `onUnauthorized` hook built once in `index.ts`)
 * treats `undefined` as "no refresh available" and falls through to the pre-existing "session
 * expired" 401 handling — this function deliberately narrows to that one signal rather than
 * distinguishing failure reasons, because every one of them has the identical correct outcome:
 * the caller's ALREADY-EXISTING 401 handling.
 *
 * Deliberately built on a BARE `RefreshDeps` (no `onUnauthorized` of its own) — passing the full
 * `HttpDeps` this module's own caller was given would let a second refresh attempt recurse into a
 * THIRD refresh attempt on a refresh-endpoint 401, which can never succeed (refreshing a refresh
 * fixes nothing) and would defeat the "exactly once" contract `http.ts`'s `request()` documents.
 */
export async function refreshSession(
  deps: RefreshDeps,
  session: StoredSession,
  keys: KeyStore,
  sessionStore: SessionStore,
  now: () => number,
): Promise<{ readonly accessToken: string } | undefined> {
  if (!session.refresh_token) return undefined;

  const dpopKey = resolveDpopKey(keys, session);
  try {
    const result = await request<RefreshTokenResponse>(
      { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs },
      {
        method: 'POST',
        url: `${session.api_base_url}/oauth/token`,
        form: {
          grant_type: 'refresh_token',
          refresh_token: session.refresh_token,
          client_id: session.client_id,
        },
        dpop: dpopKey ? { key: dpopKey } : undefined,
      },
    );
    if (result.status !== 200) return undefined;

    const token = result.body;
    if (typeof token.access_token !== 'string' || token.access_token.length === 0) return undefined;
    if (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in)) return undefined;

    const updated: StoredSession = {
      ...session,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? session.refresh_token,
      token_type: token.token_type === 'DPoP' ? 'DPoP' : 'Bearer',
      expires_at: now() + token.expires_in * 1000,
    };
    sessionStore.write(updated);
    return { accessToken: updated.access_token };
  } catch {
    return undefined;
  }
}
