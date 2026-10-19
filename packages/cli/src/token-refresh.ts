// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';
import { type FetchLike, request, requestIdFromError } from './http.js';
import { resolveDpopKey } from './install-key.js';
import type { RefreshLock } from './refresh-lock.js';
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
  /**
   * Called once, before the refresh stops with a {@link RefreshStoreError}, when the session store could not be
   * written or did not read back what was written. An unattended caller uses it to raise an alert; the CLI itself
   * reports the failure through the error message. It must not throw.
   */
  readonly onStoreFailure?: (failure: RefreshStoreFailure) => void;
  /**
   * A cross-process single-flight lock (`refresh-lock.ts`). With it, a refresh re-reads the stored session under the
   * lock and uses a session another process rotated meanwhile, instead of presenting the same refresh token twice.
   */
  readonly lock?: RefreshLock;
}

/** Which write failed: `mark` — before the refresh token was sent; `persist` — after the rotated session arrived. */
export interface RefreshStoreFailure {
  readonly stage: 'mark' | 'persist';
  readonly reason: 'write_failed' | 'read_back_mismatch';
}

/**
 * The session store could not keep the session safely, so the refresh stopped. At `persist` the old refresh token
 * stays marked as sent and is never used again, and the new tokens are dropped; the user signs in again.
 */
export class RefreshStoreError extends CliError {
  readonly failure: RefreshStoreFailure;

  constructor(failure: RefreshStoreFailure, where: string) {
    super(
      failure.stage === 'mark'
        ? `Could not refresh your session: the session store at ${where} could not be written, so the refresh was not attempted. Run \`rakomi login\` again once the store is writable.`
        : `Your session was refreshed, but the session store at ${where} did not keep the new session. The new tokens were dropped and the old refresh token will not be used again. Run \`rakomi login\` again.`,
      EXIT.NOT_LOGGED_IN,
    );
    this.name = 'RefreshStoreError';
    this.failure = failure;
  }
}

/**
 * Writes `session` and reads it back; true only when the store now holds exactly the tokens and marker written. A
 * store that throws, or returns anything else, is a failed write.
 */
function writeAndConfirm(store: SessionStore, session: StoredSession): RefreshStoreFailure['reason'] | null {
  try {
    store.write(session);
  } catch {
    return 'write_failed';
  }
  let back: StoredSession | null;
  try {
    back = store.read();
  } catch {
    return 'read_back_mismatch';
  }
  if (
    back === null ||
    back.access_token !== session.access_token ||
    back.refresh_token !== session.refresh_token ||
    back.refresh_presented_at !== session.refresh_presented_at
  ) {
    return 'read_back_mismatch';
  }
  return null;
}

function stopOnStoreFailure(deps: RefreshDeps, store: SessionStore, failure: RefreshStoreFailure): never {
  try {
    deps.onStoreFailure?.(failure);
  } catch {
  }
  throw new RefreshStoreError(failure, store.describePath());
}

/** The session without the sent-marker — what a completed or abandoned refresh leaves in the store. */
function withoutMarker(session: StoredSession): StoredSession {
  const { refresh_presented_at: _marker, ...rest } = session;
  return rest;
}

/**
 * Attempts a silent `refresh_token` grant for `session`. On success, PERSISTS the rotated session
 * (new `access_token` + rotated `refresh_token` + recomputed `expires_at`) to `sessionStore` and
 * returns the new access token. Returns `undefined` when the session cannot be refreshed: no
 * `refresh_token` on the session (a `--client`/device-grant/`--ci` session may carry one or may
 * not, depending on what the server granted), a 4xx response (`invalid_grant` — the refresh token
 * itself is expired/revoked/reused), or a malformed response body. The caller (`http.ts`'s
 * `request()`, via the `onUnauthorized` hook built once in `index.ts`) treats `undefined` as "no
 * refresh available" and falls through to the pre-existing "session expired" 401 handling.
 *
 * A TRANSIENT failure is different: a 5xx, 429 or 408 from the token endpoint, or a network error or
 * timeout, says nothing about the session — telling the user it expired and to log in again would
 * hide the real cause. Those THROW a `CliError` naming the cause (with the server's `Retry-After`
 * and request id when present); the stored session is left untouched, so the next command works
 * once the API is back.
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
  if (!deps.lock) return refreshUnlocked(deps, session, keys, sessionStore, now);
  return deps.lock.run(async () => {
    let current: StoredSession | null;
    try {
      current = sessionStore.read();
    } catch {
      current = null;
    }
    if (
      current !== null &&
      current.refresh_token !== session.refresh_token &&
      current.access_token !== session.access_token &&
      current.refresh_presented_at === undefined
    ) {
      return { accessToken: current.access_token };
    }
    return refreshUnlocked(deps, current ?? session, keys, sessionStore, now);
  });
}

async function refreshUnlocked(
  deps: RefreshDeps,
  session: StoredSession,
  keys: KeyStore,
  sessionStore: SessionStore,
  now: () => number,
): Promise<{ readonly accessToken: string } | undefined> {
  if (!session.refresh_token) return undefined;
  if (session.refresh_presented_at !== undefined) return undefined;

  const marked: StoredSession = { ...session, refresh_presented_at: now() };
  const markFailure = writeAndConfirm(sessionStore, marked);
  if (markFailure) stopOnStoreFailure(deps, sessionStore, { stage: 'mark', reason: markFailure });
  const unmark = (): void => {
    writeAndConfirm(sessionStore, withoutMarker(marked));
  };

  const dpopKey = resolveDpopKey(keys, session);
  let result: Awaited<ReturnType<typeof request<RefreshTokenResponse>>>;
  try {
    result = await request<RefreshTokenResponse>(
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
  } catch (err) {
    unmark();
    const cause = err instanceof CliError ? err.message : 'The Rakomi API could not be reached.';
    throw new CliError(`Could not refresh your session: ${cause} You are still logged in — try again in a moment.`, EXIT.FAIL);
  }

  if (isTransientStatus(result.status)) {
    unmark();
    const retryAfter = retryAfterSeconds(result.headers.get('retry-after'));
    const wait = retryAfter !== undefined ? `in ${retryAfter}s` : 'in a moment';
    const id = requestIdFromError(result.body);
    throw new CliError(
      `Could not refresh your session: the Rakomi API is temporarily unavailable (HTTP ${result.status}). ` +
        `You are still logged in — try again ${wait}.${id ? `\nRequest ID: ${id}` : ''}`,
      EXIT.FAIL,
    );
  }
  if (result.status !== 200) {
    unmark();
    return undefined;
  }

  const token = result.body;
  if (typeof token.access_token !== 'string' || token.access_token.length === 0) return undefined;
  if (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in)) return undefined;

  const updated: StoredSession = {
    ...withoutMarker(session),
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? session.refresh_token,
    token_type: token.token_type === 'DPoP' ? 'DPoP' : 'Bearer',
    expires_at: now() + token.expires_in * 1000,
  };
  const persistFailure = writeAndConfirm(sessionStore, updated);
  if (persistFailure) stopOnStoreFailure(deps, sessionStore, { stage: 'persist', reason: persistFailure });
  return { accessToken: updated.access_token };
}

/** 5xx, 429 and 408 mean "try again later" — never that the session is over. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** `Retry-After` in delta-seconds (RFC 9110 §10.2.3); the HTTP-date form is not shown. */
function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
}
