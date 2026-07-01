import type { MiddlewareRequest, MiddlewareResponse, NextFunction } from './middleware.js';
import { resolveVerbose } from './middleware.js';
import { hasPermission, hasRole } from './rbac.js';
import type { SdkEnvironment, TokenPayload } from './types.js';

type AuthenticatedRequest = MiddlewareRequest & { auth?: TokenPayload };

/**
 * Express-compatible middleware guard. For Hono/Fastify, use hasPermission() directly.
 * Checks JWT claims (offline verification) — NOT a live API call.
 */
export function requirePermission(permission: string, environmentOverride?: SdkEnvironment) {
  return (req: AuthenticatedRequest, res: MiddlewareResponse, next: NextFunction) => {
    try {
      const verbose = resolveVerbose(req, environmentOverride);

      if (!req.auth) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="rakomi"');
        res.status(401).json({
          error: {
            code: 'auth/not_authenticated',
            message: 'Authentication required',
            ...(verbose && { suggestion: 'Ensure rakomi.middleware() is applied before requirePermission()' }),
            docs_url: 'https://docs.rakomi.dev/sdk/errors#not-authenticated',
          },
        });
        return;
      }

      const payload = {
        ...req.auth,
        permissions: req.auth.permissions ?? [],
        roles: req.auth.roles ?? [],
      };

      if (!hasPermission(payload, permission)) {
        res.setHeader(
          'WWW-Authenticate',
          verbose
            ? `Bearer realm="rakomi", error="insufficient_scope", scope="${permission}"`
            : 'Bearer realm="rakomi", error="insufficient_scope"',
        );
        res.status(403).json({
          error: {
            code: 'auth/insufficient_permissions',
            message: verbose ? `Missing permission: ${permission}` : 'Insufficient permissions',
            docs_url: 'https://docs.rakomi.dev/sdk/errors#insufficient-permissions',
          },
        });
        return;
      }

      next();
    } catch {
      res.setHeader('WWW-Authenticate', 'Bearer realm="rakomi", error="invalid_token"');
      res.status(401).json({
        error: {
          code: 'auth/guard_error',
          message: 'Authorization check failed',
          docs_url: 'https://docs.rakomi.dev/sdk/errors#guard-error',
        },
      });
    }
  };
}

/**
 * Express-compatible middleware guard. For Hono/Fastify, use hasRole() directly.
 * Checks JWT claims (offline verification) — NOT a live API call.
 */
export function requireRole(roleKey: string, environmentOverride?: SdkEnvironment) {
  return (req: AuthenticatedRequest, res: MiddlewareResponse, next: NextFunction) => {
    try {
      const verbose = resolveVerbose(req, environmentOverride);

      if (!req.auth) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="rakomi"');
        res.status(401).json({
          error: {
            code: 'auth/not_authenticated',
            message: 'Authentication required',
            ...(verbose && { suggestion: 'Ensure rakomi.middleware() is applied before requireRole()' }),
            docs_url: 'https://docs.rakomi.dev/sdk/errors#not-authenticated',
          },
        });
        return;
      }

      const payload = {
        ...req.auth,
        permissions: req.auth.permissions ?? [],
        roles: req.auth.roles ?? [],
      };

      if (!hasRole(payload, roleKey)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="rakomi", error="insufficient_scope"');
        res.status(403).json({
          error: {
            code: 'auth/insufficient_role',
            message: verbose ? `Missing role: ${roleKey}` : 'Insufficient role',
            docs_url: 'https://docs.rakomi.dev/sdk/errors#insufficient-role',
          },
        });
        return;
      }

      next();
    } catch {
      res.setHeader('WWW-Authenticate', 'Bearer realm="rakomi", error="invalid_token"');
      res.status(401).json({
        error: {
          code: 'auth/guard_error',
          message: 'Authorization check failed',
          docs_url: 'https://docs.rakomi.dev/sdk/errors#guard-error',
        },
      });
    }
  };
}
