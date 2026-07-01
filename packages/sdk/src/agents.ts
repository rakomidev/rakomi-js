/**
 * Node SDK surface for end-user agent management.
 *
 * Wraps the two `/v1/users/me/agents*` endpoints:
 * - `GET /v1/users/me/agents` → `list({ userToken })`
 * - `DELETE /v1/users/me/agents/{agentClientId}` → `revoke({ userToken, agentClientId })`
 *
 * These endpoints require an end-user JWT (NOT an API key), so each helper
 * takes a `{ userToken }` option. The SDK client (constructed with an API key)
 * only carries the `baseUrl`; the user token flows per-call.
 *
 * Tenant-admin agent management is intentionally out of scope: the SDK is
 * consumed BY agents and end users, not by tenant admins managing agents.
 */

import type { SdkError, VerifyResult } from './types.js';

/**
 * End-user-side agent row returned by `GET /v1/users/me/agents`.
 */
export type UserAgentResponse = {
  agent_client_id: string;
  agent_name: string;
  agent_logo_url?: string;
  agent_class?: string;
  last_action_at?: string;
  action_count: number;
  revoked_at?: string;
  agent_revoked_at?: string;
};

export interface AgentsClientContext {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface AgentsCallOptions {
  /** End-user JWT (Bearer). REQUIRED — these endpoints do NOT accept API keys. */
  userToken: string;
}

export interface ListUserAgentsResponse {
  data: UserAgentResponse[];
}

export interface RevokeUserAgentOptions extends AgentsCallOptions {
  /** The agent's public `client_id` (matches `oauth_clients.client_id`). */
  agentClientId: string;
}

export interface RevokeUserAgentResponse {
  agent_client_id: string;
  revoked_at: string;
  reason: string;
}

export class AgentsNetworkError extends Error {
  readonly code = 'agents/network_error';
  constructor(message: string) {
    super(message);
    this.name = 'AgentsNetworkError';
  }
}

export class AgentNotFoundError extends Error {
  readonly code = 'agents/not_found';
  constructor(message = 'Agent not found in this tenant') {
    super(message);
    this.name = 'AgentNotFoundError';
  }
}

export class AgentsUnauthorizedError extends Error {
  readonly code = 'agents/unauthorized';
  constructor(message = 'Missing or invalid user token') {
    super(message);
    this.name = 'AgentsUnauthorizedError';
  }
}

export class AgentsRateLimitedError extends Error {
  readonly code = 'agents/rate_limited';
  readonly retryAfterSeconds?: number;
  constructor(retryAfterSeconds?: number) {
    super('Rate limit exceeded for /v1/users/me/agents');
    this.name = 'AgentsRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface ApiErrorBody {
  code?: string;
  message?: string;
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function parseRetryAfter(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return undefined;
}

function networkError(message: string): SdkError {
  return {
    code: 'agents/network_error',
    message,
    suggestion: 'Verify Rakomi base URL is reachable and that DNS / TLS is healthy.',
    docs_url: 'https://docs.rakomi.dev/guides/ai-agents',
  };
}

function notFoundError(): SdkError {
  return {
    code: 'agents/not_found',
    message: 'Agent not found in this tenant',
    suggestion: 'Verify the agentClientId matches an agent that has acted on this user before.',
    docs_url: 'https://docs.rakomi.dev/guides/ai-agents',
  };
}

function unauthorizedError(): SdkError {
  return {
    code: 'agents/unauthorized',
    message: 'Missing or invalid user token',
    suggestion: 'Pass a valid end-user JWT in `userToken`. API keys are NOT accepted on /v1/users/me routes.',
    docs_url: 'https://docs.rakomi.dev/guides/ai-agents',
  };
}

function rateLimitedError(retryAfter?: number): SdkError {
  return {
    code: 'agents/rate_limited',
    message: 'Rate limit exceeded for /v1/users/me/agents',
    suggestion: retryAfter !== undefined
      ? `Wait ${retryAfter}s and retry.`
      : 'Slow down and retry after a short back-off.',
    docs_url: 'https://docs.rakomi.dev/guides/ai-agents',
  };
}

function genericError(status: number, body: ApiErrorBody | null): SdkError {
  return {
    code: body?.code ?? `agents/http_${status}`,
    message: body?.message ?? `HTTP ${status}`,
    suggestion: 'Inspect the response body and retry if appropriate.',
    docs_url: 'https://docs.rakomi.dev/guides/ai-agents',
  };
}

/**
 * User-scoped agents resource. Attached to `RakomiClient#users.me.agents`.
 *
 * All methods require an end-user JWT passed via `{ userToken }`. The underlying
 * `RakomiClient` API key is NOT sent on these calls — the API rejects API-key
 * auth on user-scoped routes.
 *
 * SSRF hardening: every `fetch` uses `redirect: 'error'`.
 */
export class AgentsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(ctx: AgentsClientContext) {
    this.baseUrl = ctx.baseUrl;
    this.fetchImpl = ctx.fetchImpl ?? fetch;
  }

  /**
   * GET /v1/users/me/agents — list every agent that has ever acted on the
   * authenticated user's behalf, with per-user + per-tenant revocation status.
   */
  async list(options: AgentsCallOptions): Promise<VerifyResult<ListUserAgentsResponse>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/users/me/agents`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${options.userToken}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      return { ok: false, error: networkError((err as Error)?.message ?? 'Network error') };
    }

    if (res.status === 200) {
      const body = await safeJson<ListUserAgentsResponse>(res);
      if (!body || !Array.isArray(body.data)) {
        return { ok: false, error: networkError('Malformed response body — expected { data: UserAgentResponse[] }') };
      }
      return { ok: true, data: body };
    }

    if (res.status === 401) return { ok: false, error: unauthorizedError() };
    if (res.status === 429) return { ok: false, error: rateLimitedError(parseRetryAfter(res)) };

    const body = await safeJson<ApiErrorBody>(res);
    return { ok: false, error: genericError(res.status, body) };
  }

  /**
   * DELETE /v1/users/me/agents/{agentClientId} — revoke an agent from acting
   * on this user's behalf (GDPR Art. 7(3)). Idempotent — re-revoking returns
   * 200 with the existing row and fires no second audit/webhook.
   */
  async revoke(
    options: RevokeUserAgentOptions,
  ): Promise<VerifyResult<RevokeUserAgentResponse>> {
    if (!options.agentClientId) {
      return {
        ok: false,
        error: {
          code: 'agents/invalid_request',
          message: 'agentClientId is required',
          suggestion: 'Pass the agent\'s public client_id (matches oauth_clients.client_id).',
          docs_url: 'https://docs.rakomi.dev/guides/ai-agents',
        },
      };
    }

    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/v1/users/me/agents/${encodeURIComponent(options.agentClientId)}`,
        {
          method: 'DELETE',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${options.userToken}`,
            Accept: 'application/json',
          },
        },
      );
    } catch (err) {
      return { ok: false, error: networkError((err as Error)?.message ?? 'Network error') };
    }

    if (res.status === 200) {
      const body = await safeJson<RevokeUserAgentResponse>(res);
      if (
        !body ||
        typeof body.agent_client_id !== 'string' ||
        typeof body.revoked_at !== 'string' ||
        typeof body.reason !== 'string'
      ) {
        return { ok: false, error: networkError('Malformed response body — expected { agent_client_id, revoked_at, reason }') };
      }
      return { ok: true, data: body };
    }

    if (res.status === 401) return { ok: false, error: unauthorizedError() };
    if (res.status === 404) return { ok: false, error: notFoundError() };
    if (res.status === 429) return { ok: false, error: rateLimitedError(parseRetryAfter(res)) };

    const body = await safeJson<ApiErrorBody>(res);
    return { ok: false, error: genericError(res.status, body) };
  }
}
