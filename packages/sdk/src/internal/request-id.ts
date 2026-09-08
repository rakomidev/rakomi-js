/**
 * Extract the server's per-request correlation id from an error response body, so a caught SDK
 * error can be handed back to Rakomi support for log correlation. The API emits it in one of two
 * shapes depending on the route family:
 *
 * - `/v1/*` routes: RFC 9457 `application/problem+json` — `request_id` is a TOP-LEVEL field.
 * - Legacy / OAuth-family routes (AuthZEN, `/oauth/*`): `{ error: { code, message, request_id } }`
 *   — `request_id` is nested under `error`. Same field name as the RFC 9457 shape, just nested.
 *
 * Both are the SAME id the server logs and returns via the `X-Request-Id` response header — this
 * function does not read headers, only whichever shape the caller already parsed as JSON, since
 * every call site in this package already needs the JSON body for `code`/`detail`/`message`
 * anyway. Returns `undefined` (never throws, never fabricates) when neither shape is present —
 * e.g. a route that emits no `request_id` at all, or a body that failed to parse.
 *
 * Single source of truth: every typed-error factory across `authz.ts`, `agents.ts`, `link.ts`,
 * `credentials.ts` and `ciba.ts` calls this ONE function rather than re-declaring the shape.
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
