/**
 * RFC 8693 Token Exchange helper.
 *
 * Higher-level wrapper around POST /oauth/token with grant_type =
 * `urn:ietf:params:oauth:grant-type:token-exchange`. Authenticates with the
 * SDK client's pre-configured `clientId` + `clientSecret` (HTTP Basic) — the
 * agent client MUST be registered with `clientType: 'agent'` and
 * `grantTypes: ['urn:ietf:params:oauth:grant-type:token-exchange']`.
 *
 * Returns a typed Result (never throws on known API failures); error classes
 * map RFC 8693 / RFC 6749 §5.2 codes for ergonomic catch-handling.
 *
 * **Server-side only** agent client_secret MUST NEVER be embedded in browser
 * or mobile client code. Agents run server-side; if you need a browser-side
 * agent flow, use CIBA.
 */
import {
  TOKEN_EXCHANGE_ACCESS_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from './internal/shared-constants.js';
import type { SdkError, VerifyResult } from './types.js';

export interface TokenExchangeOptions {
  /** A user's currently-valid Rakomi access token (RS256 JWT). */
  subjectToken: string;
  /** Optional space-delimited or array-of-strings narrowed scope set. */
  scope?: string | string[];
  /** Optional target audience for the agent token's `aud` claim. */
  audience?: string;
}

export interface TokenExchangeResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string;
  issuedTokenType: typeof TOKEN_EXCHANGE_ACCESS_TOKEN_TYPE;
}

export class TokenExchangeError extends Error {
  readonly code: string;
  readonly description: string;
  constructor(code: string, description: string) {
    super(`${code}: ${description}`);
    this.code = code;
    this.description = description;
  }
}
export class TokenExchangeInvalidGrantError extends TokenExchangeError {
  constructor(description: string) { super('invalid_grant', description); }
}
export class TokenExchangeUnauthorizedClientError extends TokenExchangeError {
  constructor(description: string) { super('unauthorized_client', description); }
}
export class TokenExchangeInvalidScopeError extends TokenExchangeError {
  constructor(description: string) { super('invalid_scope', description); }
}
export class TokenExchangeRateLimitedError extends TokenExchangeError {
  constructor(description: string) { super('rate_limited', description); }
}
export class TokenExchangeInvalidClientError extends TokenExchangeError {
  constructor(description: string) { super('invalid_client', description); }
}

interface ExchangeContext {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

function makeError(code: string, description: string): SdkError {
  return {
    code: `token_exchange/${code}`,
    message: description,
    suggestion:
      code === 'invalid_grant'
        ? 'The user token is not exchangeable. Confirm it is a freshly-issued user access token (not an M2M, anonymous, or already-delegated token).'
        : code === 'unauthorized_client'
          ? "Confirm the OAuth client was registered with clientType='agent' and grantTypes=['urn:ietf:params:oauth:grant-type:token-exchange']."
          : code === 'invalid_scope'
            ? 'Requested scope is empty after intersection with the user grant and agent allowlist. Reduce requested scopes or extend the agent allowlist.'
            : code === 'rate_limited'
              ? 'Per-agent_client / per-subject-token rate limit exceeded. Slow down or increase the limit on the dashboard.'
              : 'See description; consult Starlight docs for token-exchange grant.',
    docs_url: 'https://docs.rakomi.dev/oauth/token-exchange',
  };
}

function basicAuth(clientId: string, secret: string): string {
  const raw = `${clientId}:${secret}`;
  if (typeof Buffer !== 'undefined') return `Basic ${Buffer.from(raw).toString('base64')}`;
  return `Basic ${btoa(raw)}`;
}

export async function exchangeTokenViaApi(
  ctx: ExchangeContext,
  options: TokenExchangeOptions,
): Promise<VerifyResult<TokenExchangeResponse>> {
  const params = new URLSearchParams();
  params.set('grant_type', TOKEN_EXCHANGE_GRANT_TYPE);
  params.set('subject_token', options.subjectToken);
  params.set('subject_token_type', TOKEN_EXCHANGE_ACCESS_TOKEN_TYPE);
  if (options.scope !== undefined) {
    const scopeStr = Array.isArray(options.scope) ? options.scope.join(' ') : options.scope;
    if (scopeStr.length > 0) params.set('scope', scopeStr);
  }
  if (options.audience !== undefined && options.audience.length > 0) {
    params.set('audience', options.audience);
  }

  let res: Response;
  try {
    res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(ctx.clientId, ctx.clientSecret),
      },
      body: params.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'token_exchange/network_error',
        message: (err as Error)?.message ?? 'Network error',
        suggestion: 'Verify Rakomi base URL is reachable and that DNS / TLS is healthy.',
        docs_url: 'https://docs.rakomi.dev/oauth/token-exchange',
      },
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
  }

  if (res.ok) {
    const accessToken = body.access_token as string | undefined;
    const issuedTokenType = body.issued_token_type as string | undefined;
    const expiresIn = body.expires_in as number | undefined;
    const tokenType = body.token_type as string | undefined;
    const scope = body.scope as string | undefined;
    if (
      typeof accessToken !== 'string' ||
      issuedTokenType !== TOKEN_EXCHANGE_ACCESS_TOKEN_TYPE ||
      tokenType !== 'Bearer' ||
      typeof expiresIn !== 'number' ||
      typeof scope !== 'string'
    ) {
      return {
        ok: false,
        error: {
          code: 'token_exchange/malformed_response',
          message: 'Server returned a 200 response that does not match RFC 8693 §2.2.1 shape',
          suggestion: 'This is a server-side bug — file an issue at https://github.com/rakomidev/rakomi-js.',
          docs_url: 'https://docs.rakomi.dev/oauth/token-exchange',
        },
      };
    }
    return {
      ok: true,
      data: {
        accessToken,
        issuedTokenType: TOKEN_EXCHANGE_ACCESS_TOKEN_TYPE,
        tokenType: 'Bearer',
        expiresIn,
        scope,
      },
    };
  }

  const rawCode = (body.error as string | undefined) ?? `http_${res.status}`;
  const code = res.status === 429 && rawCode === 'invalid_request' ? 'rate_limited' : rawCode;
  const description = (body.error_description as string | undefined) ?? `HTTP ${res.status}`;
  return { ok: false, error: makeError(code, description) };
}

/**
 * Throwing variant — used by `client.tokens.exchange` per (typed errors).
 * Maps the Result to `TokenExchange*Error` instances.
 */
export async function exchangeTokenOrThrow(
  ctx: ExchangeContext,
  options: TokenExchangeOptions,
): Promise<TokenExchangeResponse> {
  const result = await exchangeTokenViaApi(ctx, options);
  if (result.ok) return result.data;
  const code = result.error.code.replace(/^token_exchange\//, '');
  switch (code) {
    case 'invalid_grant': throw new TokenExchangeInvalidGrantError(result.error.message);
    case 'unauthorized_client': throw new TokenExchangeUnauthorizedClientError(result.error.message);
    case 'invalid_scope': throw new TokenExchangeInvalidScopeError(result.error.message);
    case 'rate_limited':
      throw new TokenExchangeRateLimitedError(result.error.message);
    case 'invalid_client':
      throw new TokenExchangeInvalidClientError(result.error.message);
    default:
      throw new TokenExchangeError(code, result.error.message);
  }
}
