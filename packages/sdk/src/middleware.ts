import type { MiddlewareOptions, SdkEnvironment, SdkError, TokenPayload, VerifyResult } from './types.js';

export interface MiddlewareRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface MiddlewareResponse {
  status(code: number): MiddlewareResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export type NextFunction = (error?: unknown) => void;

type VerifyTokenFn = (token: string) => Promise<VerifyResult<TokenPayload>>;

const BEARER_PREFIX = 'bearer ';

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
        const authorization = req.headers['authorization'] ?? req.headers['Authorization'];
        const authHeader = typeof authorization === 'string' ? authorization : undefined;

        if (!authHeader || !authHeader.toLowerCase().startsWith(BEARER_PREFIX)) {
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

        const token = authHeader.slice(BEARER_PREFIX.length);

        const result = await verifyTokenFn(token);

        if (!result.ok) {
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
