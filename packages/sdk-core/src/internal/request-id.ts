/**
 * Extract the server's per-request correlation id from an error response body, so a returned
 * `AuthError` can carry it back for support/log correlation. The API emits it in one of two
 * shapes depending on the route family:
 *
 * - `/v1/*` routes: RFC 9457 `application/problem+json` — `request_id` is a TOP-LEVEL field.
 * - `/oauth/*` and other legacy routes: `request_id` is ALSO a top-level field on the RFC 6749
 *   §5.2 `{error, error_description, request_id}` body (an additive extension member), or nested
 *   under `{ error: { code, message, request_id } }` on the pre-RFC-9457 legacy envelope some
 *   non-`/v1/` routes still use.
 *
 * Both are the SAME id the server logs and returns via the `X-Request-Id` response header — this
 * function does not read headers, only whichever shape the caller already parsed as JSON, since
 * every call site here already needs the body for `error`/`error_description`/`detail` anyway.
 * Returns `undefined` (never throws, never fabricates) when neither shape is present.
 *
 * `@rakomi/node` (`packages/sdk`) has an IDENTICAL, independently-declared copy of this function
 * (`internal/request-id.ts`) rather than a dependency on this package — the two SDKs have no
 * dependency edge between them (this package has zero runtime deps beyond what each platform
 * shim adds; `@rakomi/node` depends on nothing but `jose`), so there is nothing to "re-export"
 * without adding a cross-package dependency neither SDK needs otherwise. Keep both copies in
 * sync if the shape this function reads ever changes.
 */
export function extractRequestId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;

  if (typeof obj.request_id === 'string' && obj.request_id.length > 0) {
    return obj.request_id;
  }

  const nested = obj.error;
  if (nested && typeof nested === 'object') {
    const nestedRequestId = (nested as Record<string, unknown>).request_id;
    if (typeof nestedRequestId === 'string' && nestedRequestId.length > 0) {
      return nestedRequestId;
    }
  }

  return undefined;
}
