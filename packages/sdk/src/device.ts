
import {
  DEVICE_AUTHORIZATION_DENIED,
  DEVICE_AUTHORIZATION_EXPIRED,
  DEVICE_AUTHORIZATION_PENDING,
  DEVICE_AUTHORIZATION_RATE_LIMITED,
  DEVICE_AUTHORIZATION_SLOW_DOWN,
  DEVICE_AUTHORIZATION_TIMEOUT,
  OAUTH_INVALID_CLIENT,
  OAUTH_INVALID_GRANT,
  OAUTH_INVALID_REQUEST,
  OAUTH_MISSING_CLIENT_ID,
  OAUTH_NETWORK_ERROR,
  RakomiError,
} from './errors.js';
import type { OAuthTokenResponse, SdkError, VerifyResult } from './types.js';

const DEFAULT_BASE_URL = 'https://api.rakomi.com';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const AWAIT_MAX_ITERATIONS = 2000;

const MAX_POLL_INTERVAL_MS = 60_000;

export interface StartDeviceAuthorizationOptions {
  clientId: string;
  /** Optional confidential-client secret. Public clients omit. */
  clientSecret?: string;
  /** Space-separated scopes or array. Defaults to client's registered scopes. */
  scope?: string | string[];
  /** OIDC nonce — propagated into id_token at success-poll time. */
  nonce?: string;
  baseUrl?: string;
}

export interface DeviceAuthorizationIssued {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  message?: string;
}

export interface PollForDeviceTokenOptions {
  deviceCode: string;
  clientId: string;
  clientSecret?: string;
  baseUrl?: string;
  /** Honored by the underlying fetch — aborting cancels the in-flight request. */
  signal?: AbortSignal;
}

export interface AwaitDeviceTokensOptions extends PollForDeviceTokenOptions {
  /** Server-suggested initial interval in seconds. */
  intervalSeconds: number;
  /** Hard client-side timeout in milliseconds (defaults to 30 min). */
  timeoutMs?: number;
  /** AbortSignal for caller-driven cancellation. */
  signal?: AbortSignal;
}

export interface RunDeviceFlowOptions {
  clientId: string;
  clientSecret?: string;
  scope?: string | string[];
  nonce?: string;
  baseUrl?: string;
  /** Called once with the issued user_code + verification URLs so the caller can display them. */
  onCode: (issued: DeviceAuthorizationIssued) => void | Promise<void>;
  signal?: AbortSignal;
  /** Override the timeout from issued.expires_in. */
  timeoutMs?: number;
}

/**
 * POST /oauth/device/code — initiate a device authorization request.
 */
export async function startDeviceAuthorization(
  options: StartDeviceAuthorizationOptions,
): Promise<VerifyResult<DeviceAuthorizationIssued>> {
  if (!options.clientId) {
    return { ok: false, error: OAUTH_MISSING_CLIENT_ID() };
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const body = new URLSearchParams({ client_id: options.clientId });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);
  if (options.scope) {
    body.set('scope', Array.isArray(options.scope) ? options.scope.join(' ') : options.scope);
  }
  if (options.nonce) body.set('nonce', options.nonce);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/oauth/device/code`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Network error';
    return { ok: false, error: OAUTH_NETWORK_ERROR(detail) };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: OAUTH_NETWORK_ERROR('Invalid JSON from device-code endpoint') };
  }

  if (!response.ok) {
    return { ok: false, error: mapStartError(json) };
  }

  const data = json as Record<string, unknown>;
  if (
    typeof data.device_code !== 'string' ||
    typeof data.user_code !== 'string' ||
    typeof data.verification_uri !== 'string' ||
    typeof data.verification_uri_complete !== 'string' ||
    typeof data.expires_in !== 'number' ||
    typeof data.interval !== 'number'
  ) {
    return { ok: false, error: OAUTH_NETWORK_ERROR('Malformed device authorization response') };
  }

  return { ok: true, data: data as unknown as DeviceAuthorizationIssued };
}

/**
 * POST /oauth/token — single poll for a device authorization grant.
 *
 * Returns:
 *   - ok: true → access_token + refresh_token (+ id_token if openid was requested)
 *   - ok: false, error.code === 'device/authorization_pending' → keep polling
 *   - ok: false, error.code === 'device/slow_down' → increment interval +5s, keep polling
 *   - ok: false, error.code === 'device/access_denied' | 'device/expired_token' → stop
 *   - ok: false, OAuth/network error → stop
 */
export async function pollForDeviceToken(
  options: PollForDeviceTokenOptions,
): Promise<VerifyResult<OAuthTokenResponse>> {
  if (!options.clientId) {
    return { ok: false, error: OAUTH_MISSING_CLIENT_ID() };
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const params: Record<string, string> = {
    grant_type: DEVICE_GRANT_TYPE,
    device_code: options.deviceCode,
    client_id: options.clientId,
  };
  if (options.clientSecret) params.client_secret = options.clientSecret;
  const body = new URLSearchParams(params);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: options.signal,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Network error';
    return { ok: false, error: OAUTH_NETWORK_ERROR(detail) };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: OAUTH_NETWORK_ERROR('Invalid JSON from token endpoint') };
  }

  if (!response.ok) {
    return { ok: false, error: mapPollError(json) };
  }

  const data = json as Record<string, unknown>;
  if (typeof data.access_token !== 'string' || typeof data.token_type !== 'string') {
    return { ok: false, error: OAUTH_NETWORK_ERROR('Invalid token response: missing access_token or token_type') };
  }
  return { ok: true, data: json as OAuthTokenResponse };
}

/**
 * High-level helper: poll the token endpoint at the server-suggested interval
 * until success, terminal error, timeout, or abort. Honors RFC 8628 §3.5
 * `slow_down` by incrementing the interval by 5s before the next poll.
 */
export async function awaitDeviceTokens(
  options: AwaitDeviceTokensOptions,
): Promise<VerifyResult<OAuthTokenResponse>> {
  let intervalMs = Math.max(1, options.intervalSeconds) * 1000;
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60 * 1000);

  for (let i = 0; i < AWAIT_MAX_ITERATIONS; i++) {
    if (options.signal?.aborted) {
      return { ok: false, error: DEVICE_AUTHORIZATION_TIMEOUT('Polling cancelled by AbortSignal') };
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: DEVICE_AUTHORIZATION_TIMEOUT() };
    }

    await sleep(intervalMs, options.signal);

    if (options.signal?.aborted) {
      return { ok: false, error: DEVICE_AUTHORIZATION_TIMEOUT('Polling cancelled by AbortSignal') };
    }

    const result = await pollForDeviceToken({
      deviceCode: options.deviceCode,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      baseUrl: options.baseUrl,
      signal: options.signal,
    });

    if (result.ok) return result;

    if (result.error.code === 'device/authorization_pending') continue;
    if (result.error.code === 'device/slow_down') {
      intervalMs = Math.min(intervalMs + 5000, MAX_POLL_INTERVAL_MS);
      continue;
    }

    return result;
  }

  return { ok: false, error: DEVICE_AUTHORIZATION_TIMEOUT('Exceeded maximum polling iterations') };
}

/**
 * One-shot device flow: initiate, surface the code via `onCode`, poll until
 * tokens are issued. Returns the same VerifyResult as awaitDeviceTokens.
 *
 * Copy-paste recipe for CLIs and AI agents.
 */
export async function run(
  options: RunDeviceFlowOptions,
): Promise<VerifyResult<OAuthTokenResponse>> {
  const issued = await startDeviceAuthorization({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scope: options.scope,
    nonce: options.nonce,
    baseUrl: options.baseUrl,
  });
  if (!issued.ok) return { ok: false, error: issued.error };

  try {
    await options.onCode(issued.data);
  } catch (err) {
    if (err instanceof RakomiError) {
      return {
        ok: false,
        error: { code: err.code, message: err.message, suggestion: err.suggestion, docs_url: err.docs_url },
      };
    }
    const detail = err instanceof Error ? err.message : 'onCode handler threw';
    return { ok: false, error: OAUTH_NETWORK_ERROR(detail) };
  }

  return awaitDeviceTokens({
    deviceCode: issued.data.device_code,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    intervalSeconds: issued.data.interval,
    timeoutMs: options.timeoutMs ?? issued.data.expires_in * 1000,
    baseUrl: options.baseUrl,
    signal: options.signal,
  });
}

function mapStartError(json: unknown): SdkError {
  const errorBody = json as Record<string, unknown>;
  const errorCode = typeof errorBody.error === 'string' ? errorBody.error : 'unknown';
  const errorDescription =
    typeof errorBody.error_description === 'string' ? errorBody.error_description : undefined;
  switch (errorCode) {
    case 'invalid_client':
      return OAUTH_INVALID_CLIENT(errorDescription);
    case 'unauthorized_client':
      return OAUTH_INVALID_CLIENT(errorDescription || 'Client is not authorized for the device_code grant');
    case 'invalid_request':
      return OAUTH_INVALID_REQUEST(errorDescription);
    case 'invalid_scope':
      return OAUTH_INVALID_REQUEST(errorDescription || 'Requested scope is not allowed for this client');
    case 'slow_down':
      return DEVICE_AUTHORIZATION_RATE_LIMITED(errorDescription);
    default:
      return OAUTH_INVALID_REQUEST(errorDescription || `device-code endpoint error: ${errorCode}`);
  }
}

function mapPollError(json: unknown): SdkError {
  const errorBody = json as Record<string, unknown>;
  const errorCode = typeof errorBody.error === 'string' ? errorBody.error : 'unknown';
  const errorDescription =
    typeof errorBody.error_description === 'string' ? errorBody.error_description : undefined;
  switch (errorCode) {
    case 'authorization_pending':
      return DEVICE_AUTHORIZATION_PENDING(errorDescription);
    case 'slow_down':
      return DEVICE_AUTHORIZATION_SLOW_DOWN(errorDescription);
    case 'access_denied':
      return DEVICE_AUTHORIZATION_DENIED(errorDescription);
    case 'expired_token':
      return DEVICE_AUTHORIZATION_EXPIRED(errorDescription);
    case 'invalid_grant':
      return OAUTH_INVALID_GRANT(errorDescription);
    case 'invalid_client':
    case 'unauthorized_client':
      return OAUTH_INVALID_CLIENT(errorDescription);
    default:
      return OAUTH_INVALID_REQUEST(errorDescription || `token endpoint error: ${errorCode}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
