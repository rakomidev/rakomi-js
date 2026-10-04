import { decodeJwt } from 'jose';

import { TOKEN_INVALID_DPOP_PROOF } from './errors.js';
import type {
  DpopVerifyOptions,
  MiddlewareOptions,
  SdkEnvironment,
  SdkError,
  TokenPayload,
  VerifyResult,
  VerifyTokenOptions,
} from './types.js';
import { DPOP_WWW_AUTHENTICATE } from './verify-dpop-binding.js';

export interface MiddlewareRequest {
  headers: Record<string, string | string[] | undefined>;
  /** HTTP method (Express/Node `req.method`). Needed to verify DPoP proofs. */
  method?: string;
  /** Request path + query as received (Express `req.originalUrl`); preferred over `url`. */
  originalUrl?: string;
  /** Request path + query (Node `req.url`). */
  url?: string;
  /** `http` or `https` (Express `req.protocol`). Used only when no DPoP `origin` is configured. */
  protocol?: string;
}

export interface MiddlewareResponse {
  status(code: number): MiddlewareResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export type NextFunction = (error?: unknown) => void;

type VerifyTokenFn = (token: string, options?: VerifyTokenOptions) => Promise<VerifyResult<TokenPayload>>;

const BEARER_PREFIX = 'bearer ';
const DPOP_PREFIX = 'dpop ';

function headerValue(req: MiddlewareRequest, name: string): string | string[] | undefined {
  const direct = req.headers[name];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/**
 * The absolute URL the client addressed: the configured `origin` (or `Host` + protocol) plus the
 * request path. Returns an empty string when it cannot be built — the DPoP check then fails
 * closed (`request_context_missing`).
 */
function requestUrl(req: MiddlewareRequest, origin: string | undefined): string {
  const path = typeof req.originalUrl === 'string' ? req.originalUrl : req.url;
  if (typeof path !== 'string' || !path.startsWith('/')) return '';
  if (origin !== undefined) {
    return `${origin.endsWith('/') ? origin.slice(0, -1) : origin}${path}`;
  }
  const host = headerValue(req, 'host');
  if (typeof host !== 'string' || host.trim() === '') return '';
  const scheme = req.protocol === 'http' ? 'http' : 'https';
  return `${scheme}://${host.trim()}${path}`;
}

function hasConfirmationClaim(token: string): boolean {
  try {
    const cnf = decodeJwt(token).cnf;
    return cnf !== undefined && cnf !== null;
  } catch {
    return false;
  }
}

function formatWireError(
  sdkError: SdkError,
  verbose: boolean,
): { error: Record<string, string | undefined> } {
  if (verbose) {
    return {
      error: {
        code: sdkError.code,
        message: sdkError.message,
        docs_url: sdkError.docs_url,
        suggestion: sdkError.suggestion,
        fix_command: sdkError.fix_command,
      },
    };
  }
  return {
    error: {
      code: sdkError.code,
      message: sdkError.message,
      docs_url: sdkError.docs_url,
    },
  };
}

/**
 * Resolve whether to include verbose error details (suggestions, fix commands).
 * SECURITY: NEVER trust the Host header — a spoofed
 * `Host: localhost` in production would leak permission/role names.
 * Uses ONLY the `environmentOverride` config parameter set at SDK init time.
 * Safe default: production (non-verbose).
 */
export function resolveVerbose(_req: MiddlewareRequest, environmentOverride?: SdkEnvironment): boolean {
  if (environmentOverride) {
    return environmentOverride === 'development';
  }
  return false;
}

export function createMiddleware(
  verifyTokenFn: VerifyTokenFn,
  options?: MiddlewareOptions,
  environmentOverride?: SdkEnvironment,
): (req: MiddlewareRequest, res: MiddlewareResponse, next: NextFunction) => void {
  return (req, res, next) => {
    const verbose = resolveVerbose(req, environmentOverride);
    void (async () => {
      try {
        const authorization = headerValue(req, 'authorization');
        const authHeader = typeof authorization === 'string' ? authorization : undefined;
        const lowered = authHeader?.toLowerCase() ?? '';
        const isBearer = lowered.startsWith(BEARER_PREFIX);
        const isDpop = lowered.startsWith(DPOP_PREFIX);

        if (!authHeader || (!isBearer && !isDpop)) {
          const error: SdkError = {
            code: 'token/missing',
            message: 'Authorization header with Bearer token is required',
            suggestion: 'Include an Authorization header: Bearer <token>',
            docs_url: 'https://docs.rakomi.dev/sdk/errors#token-missing',
          };

          if (options?.onError) {
            options.onError(error, req, res);
            return;
          }

          res.status(401).json(formatWireError(error, verbose));
          return;
        }

        const token = authHeader.slice(isBearer ? BEARER_PREFIX.length : DPOP_PREFIX.length).trim();

        let dpop: DpopVerifyOptions | undefined;
        if (isDpop) {
          dpop = {
            proof: headerValue(req, 'dpop'),
            method: typeof req.method === 'string' ? req.method : '',
            url: requestUrl(req, options?.dpop?.origin),
            ...(options?.dpop?.onJti ? { onJti: options.dpop.onJti } : {}),
          };
        }

        let result = await verifyTokenFn(token, dpop ? { dpop } : undefined);

        if (!result.ok && isBearer && result.error.code === 'token/invalid_dpop_proof') {
          result = { ok: false, error: TOKEN_INVALID_DPOP_PROOF('scheme_downgrade') };
        }
        if (result.ok && isDpop && !hasConfirmationClaim(token)) {
          result = { ok: false, error: TOKEN_INVALID_DPOP_PROOF('scheme_mismatch') };
        }

        if (!result.ok) {
          if (result.error.code === 'token/invalid_dpop_proof' && typeof res.setHeader === 'function') {
            res.setHeader('WWW-Authenticate', DPOP_WWW_AUTHENTICATE);
          }
          if (options?.onError) {
            options.onError(result.error, req, res);
            return;
          }

          res.status(401).json(formatWireError(result.error, verbose));
          return;
        }

        (req as MiddlewareRequest & { auth: unknown }).auth = result.data;
        next();
      } catch {
        const error: SdkError = {
          code: 'token/internal_error',
          message: 'An internal error occurred during token verification',
          suggestion: 'This is unexpected. Please retry or contact support',
          docs_url: 'https://docs.rakomi.dev/sdk/errors#token-internal_error',
        };

        if (options?.onError) {
          options.onError(error, req, res);
          return;
        }

        res.status(401).json(formatWireError(error, verbose));
      }
    })();
  };
}
