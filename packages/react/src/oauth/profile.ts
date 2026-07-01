/**
 * Profile management API clients — all require JWT auth via getToken().
 * Used by <UserProfile /> component.
 */

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { AuthError, SessionInfo } from '../types.js';

type SimpleResult =
  | { ok: true }
  | { ok: false; error: AuthError };

type MfaSetupResult =
  | { ok: true; qrCode: string; secret: string; recoveryCodes: string[] }
  | { ok: false; error: AuthError };

type MfaVerifySetupResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: AuthError };

type RegenerateCodesResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: AuthError };

type FetchSessionsResult =
  | { ok: true; sessions: SessionInfo[] }
  | { ok: false; error: AuthError };

type RevokeAllResult =
  | { ok: true; revokedCount: number; failedCount: number; failedSessionIds: string[] }
  | { ok: false; error: AuthError };

async function authFetch(url: string, token: string, options?: RequestInit): Promise<Response> {
  const { headers: _callerHeaders, credentials: _c, redirect: _r, signal: _s, cache: _cache, ...safeOptions } = options ?? {};
  return sdkFetch(url, {
    ...safeOptions,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });
}

function parseError(json: unknown, fallback: string): AuthError {
  const body = json as { error?: { message?: string } } | undefined;
  return { code: 'PROVIDER_ERROR' as const, message: body?.error?.message ?? fallback };
}

export async function changePassword(options: {
  baseUrl: string;
  token: string;
  currentPassword: string;
  newPassword: string;
}): Promise<SimpleResult> {
  const { baseUrl, token, currentPassword, newPassword } = options;

  try {
    const response = await authFetch(`${baseUrl}/v1/auth/change-password`, token, {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });

    if (!response.ok) {
      const json = await response.json().catch(() => undefined);
      return { ok: false, error: parseError(json, 'Password change failed') };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }
}

export async function setupMfa(options: {
  baseUrl: string;
  token: string;
}): Promise<MfaSetupResult> {
  const { baseUrl, token } = options;

  try {
    const response = await authFetch(`${baseUrl}/v1/auth/mfa/setup`, token, { method: 'POST' });

    if (!response.ok) {
      const json = await response.json().catch(() => undefined);
      return { ok: false, error: parseError(json, 'MFA setup failed') };
    }

    const json = await response.json();
    const r = json as Record<string, unknown>;

    return {
      ok: true,
      qrCode: typeof r['qr_code'] === 'string' ? r['qr_code'] : '',
      secret: typeof r['secret'] === 'string' ? r['secret'] : '',
      recoveryCodes: Array.isArray(r['recovery_codes'])
        ? (r['recovery_codes'] as unknown[]).filter((c): c is string => typeof c === 'string')
        : [],
    };
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }
}

export async function verifyMfaSetup(options: {
  baseUrl: string;
  token: string;
  code: string;
}): Promise<MfaVerifySetupResult> {
  const { baseUrl, token, code } = options;

  try {
    const response = await authFetch(`${baseUrl}/v1/auth/mfa/verify-setup`, token, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      const json = await response.json().catch(() => undefined);
      return { ok: false, error: parseError(json, 'MFA verification failed') };
    }

    const json = await response.json();
    const r = json as Record<string, unknown>;

    return {
      ok: true,
      recoveryCodes: Array.isArray(r['recovery_codes'])
        ? (r['recovery_codes'] as unknown[]).filter((c): c is string => typeof c === 'string')
        : [],
    };
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }
}

export async function disableMfa(options: {
  baseUrl: string;
  token: string;
  password: string;
}): Promise<SimpleResult> {
  const { baseUrl, token, password } = options;

  try {
    const response = await authFetch(`${baseUrl}/v1/auth/mfa/disable`, token, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      const json = await response.json().catch(() => undefined);
      return { ok: false, error: parseError(json, 'MFA disable failed') };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }
}

export async function regenerateRecoveryCodes(options: {
  baseUrl: string;
  token: string;
  password: string;
}): Promise<RegenerateCodesResult> {
  const { baseUrl, token, password } = options;

  try {
    const response = await authFetch(`${baseUrl}/v1/auth/mfa/regenerate-codes`, token, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      const json = await response.json().catch(() => undefined);
      return { ok: false, error: parseError(json, 'Regenerate codes failed') };
    }

    const json = await response.json();
    const r = json as Record<string, unknown>;

    return {
      ok: true,
      recoveryCodes: Array.isArray(r['recovery_codes'])
        ? (r['recovery_codes'] as unknown[]).filter((c): c is string => typeof c === 'string')
        : [],
    };
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }
}

export async function fetchSessions(options: {
  baseUrl: string;
  token: string;
}): Promise<FetchSessionsResult> {
  const { baseUrl, token } = options;

  try {
    const response = await authFetch(`${baseUrl}/v1/auth/me`, token, { method: 'GET' });

    if (!response.ok) {
      const json = await response.json().catch(() => undefined);
      return { ok: false, error: parseError(json, 'Fetch sessions failed') };
    }

    const json = await response.json();
    const r = json as Record<string, unknown>;
    const data = Array.isArray(r['data']) ? r['data'] : (Array.isArray(json) ? json : []);

    const sessions: SessionInfo[] = (data as Record<string, unknown>[])
      .filter(s => typeof s['id'] === 'string')
      .map(s => ({
        id: s['id'] as string,
        userAgent: typeof s['user_agent'] === 'string' ? s['user_agent'] : '',
        ipHash: typeof s['ip_hash'] === 'string' ? s['ip_hash'] : '',
        createdAt: typeof s['created_at'] === 'string' ? s['created_at'] : '',
        lastUsedAt: typeof s['last_used_at'] === 'string' ? s['last_used_at'] : '',
        isCurrent: typeof s['is_current'] === 'boolean' ? s['is_current'] : false,
      }));

    return { ok: true, sessions };
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }
}

export async function revokeSession(options: {
  baseUrl: string;
  token: string;
  sessionId: string;
}): Promise<SimpleResult> {
  const { baseUrl, token, sessionId } = options;

  try {
    const response = await authFetch(`${baseUrl}/v1/auth/logout`, token, {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    });

    if (!response.ok) {
      const json = await response.json().catch(() => undefined);
      return { ok: false, error: parseError(json, 'Session revoke failed') };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }
}

export async function revokeAllOtherSessions(options: {
  baseUrl: string;
  token: string;
  sessionIds: string[];
}): Promise<RevokeAllResult> {
  const { baseUrl, token, sessionIds } = options;

  if (sessionIds.length === 0) {
    return { ok: true, revokedCount: 0, failedCount: 0, failedSessionIds: [] };
  }

  try {
    const results = await Promise.allSettled(
      sessionIds.map(sessionId => revokeSession({ baseUrl, token, sessionId }))
    );

    const revokedCount = results.filter(
      r => r.status === 'fulfilled' && r.value.ok
    ).length;

    const failedSessionIds = sessionIds.filter((_, i) => {
      const r = results[i];
      return r === undefined || r.status === 'rejected' || !r.value.ok;
    });
    const failedCount = failedSessionIds.length;

    if (revokedCount === 0 && sessionIds.length > 0) {
      return { ok: false, error: { code: 'PROVIDER_ERROR' as const, message: 'Failed to revoke sessions' } };
    }

    return { ok: true, revokedCount, failedCount, failedSessionIds };
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }
}

export async function resendVerification(options: {
  baseUrl: string;
  email: string;
  apiKey: string;
}): Promise<SimpleResult> {
  const { baseUrl, email, apiKey } = options;

  try {
    const response = await sdkFetch(`${baseUrl}/v1/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ email }),
    });

    if (!response.ok) {
      return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Resend verification failed' } };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }
}
