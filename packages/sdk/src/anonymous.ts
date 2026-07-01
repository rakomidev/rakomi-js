/**
 * Node SDK surface for anonymous sign-ins.
 *
 * Pure server-side: no browser globals (window/document/navigator/localStorage).
 * Browser apps should use the React hook `useAnonymousSignin` from `@rakomi/react`
 * which calls this under the hood via the user's backend, OR hit `/v1/auth/anonymous`
 * directly from the browser with the tenant's public API key.
 *
 * Returns a Result shape consistent with the rest of the SDK: NEVER throws on
 * expected API errors (403/429/402/401), throws ONLY on programmer errors.
 */

import { RakomiError } from './errors.js';
import {
  ANONYMOUS_DISABLED,
  ANONYMOUS_MAU_EXHAUSTED,
  ANONYMOUS_NETWORK_ERROR,
  ANONYMOUS_RATE_LIMITED,
  AnonymousSessionExpiredError,
} from './errors.js';
import type { SdkError, VerifyResult } from './types.js';

export interface AnonymousSigninOptions {
  /** Optional tenant-supplied public metadata (≤1 KB JSON, same rules as). */
  publicMetadata?: Record<string, unknown>;
}

export interface AnonymousSigninResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    isAnonymous: true;
    createdAt: string;
  };
}

export interface AnonymousSigninCallContext {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * POST /v1/auth/anonymous. Returns Result — never throws on 4xx.
 */
export async function anonymousSignin(
  ctx: AnonymousSigninCallContext,
  options: AnonymousSigninOptions = {},
): Promise<VerifyResult<AnonymousSigninResult>> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const url = `${ctx.baseUrl}/v1/auth/anonymous`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': ctx.apiKey,
      },
      body: JSON.stringify(options.publicMetadata ? { public_metadata: options.publicMetadata } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: ANONYMOUS_NETWORK_ERROR(err instanceof Error ? err.message : undefined),
    };
  }

  if (res.status === 201) {
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      user: { id: string; is_anonymous: boolean; created_at: string };
    };
    return {
      ok: true,
      data: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresIn: body.expires_in,
        user: {
          id: body.user.id,
          isAnonymous: true,
          createdAt: body.user.created_at,
        },
      },
    };
  }

  let retryAfterSeconds: number | undefined;
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n) && n > 0) retryAfterSeconds = Math.round(n);
  }
  let sdkError: SdkError;
  switch (res.status) {
    case 403:
      sdkError = ANONYMOUS_DISABLED();
      break;
    case 402:
      sdkError = ANONYMOUS_MAU_EXHAUSTED();
      break;
    case 429:
      sdkError = ANONYMOUS_RATE_LIMITED(retryAfterSeconds);
      break;
    default: {
      const body = await res.text().catch(() => '');
      sdkError = ANONYMOUS_NETWORK_ERROR(body.slice(0, 200));
    }
  }
  return { ok: false, error: sdkError };
}

/**
 * Decode an access token's `is_anonymous` claim WITHOUT verifying the signature.
 * Used only to gate the `AnonymousSessionExpiredError` path — callers should still
 * verify any trust-sensitive claim via `client.verifyToken()`.
 */
export function isAnonymousTokenHeuristic(accessToken: string): boolean {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as {
      is_anonymous?: boolean;
    };
    return payload.is_anonymous === true;
  } catch {
    return false;
  }
}

/**
 * Classify a refresh failure: if the prior token was anonymous and the refresh
 * returned 401, throw `AnonymousSessionExpiredError`. Otherwise the caller
 * decides its own UX routing.
 */
export function maybeThrowAnonymousExpired(priorAccessToken: string | null, refreshStatus: number): void {
  if (refreshStatus === 401 && priorAccessToken && isAnonymousTokenHeuristic(priorAccessToken)) {
    throw new AnonymousSessionExpiredError();
  }
}

export { AnonymousSessionExpiredError, RakomiError };
