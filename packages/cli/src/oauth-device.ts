// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';
import { describeError, type HttpDeps, request } from './http.js';

export interface DeviceCodeIssued {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface DeviceTokenResult {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type: string;
  readonly expires_in: number;
}

export async function requestDeviceCode(
  deps: HttpDeps,
  opts: { readonly apiBaseUrl: string; readonly clientId: string; readonly scope?: string },
): Promise<DeviceCodeIssued> {
  const result = await request<DeviceCodeIssued & { error?: string }>(deps, {
    method: 'POST',
    url: `${opts.apiBaseUrl}/oauth/device/code`,
    form: { client_id: opts.clientId, ...(opts.scope ? { scope: opts.scope } : {}) },
  });
  if (result.status !== 200) {
    throw new CliError(`Could not start device sign-in: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}

export type DevicePollOutcome =
  | { readonly kind: 'success'; readonly token: DeviceTokenResult }
  | { readonly kind: 'pending' }
  | { readonly kind: 'slow_down' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'expired' };

/** ONE poll attempt — the caller owns the interval/backoff loop (testable without real sleeps). */
export async function pollDeviceToken(
  deps: HttpDeps,
  opts: { readonly apiBaseUrl: string; readonly clientId: string; readonly deviceCode: string },
): Promise<DevicePollOutcome> {
  const result = await request<DeviceTokenResult & { error?: string }>(deps, {
    method: 'POST',
    url: `${opts.apiBaseUrl}/oauth/token`,
    form: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: opts.deviceCode,
      client_id: opts.clientId,
    },
  });
  if (result.status === 200) return { kind: 'success', token: result.body };
  const error = result.body.error;
  if (error === 'authorization_pending') return { kind: 'pending' };
  if (error === 'slow_down') return { kind: 'slow_down' };
  if (error === 'access_denied') return { kind: 'denied' };
  if (error === 'expired_token') return { kind: 'expired' };
  throw new CliError(`Device sign-in failed: ${describeError(result.body, result.status)}`, EXIT.FAIL);
}

export interface DeviceLoginDeps extends HttpDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly onWaiting?: (issued: DeviceCodeIssued) => void;
}

/**
 * The full device-grant loop: mint, print/callback with the user_code + verification URL, then
 * poll at the server-declared interval (respecting `slow_down` by adding 5s, per RFC 8628 §3.5)
 * until success, denial, or expiry.
 */
export async function loginWithDeviceGrant(
  deps: DeviceLoginDeps,
  opts: { readonly apiBaseUrl: string; readonly clientId: string; readonly scope?: string },
): Promise<DeviceTokenResult> {
  const issued = await requestDeviceCode(deps, opts);
  deps.onWaiting?.(issued);

  let intervalMs = issued.interval * 1000;
  const deadline = Date.now() + issued.expires_in * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new CliError('The device sign-in code expired before it was approved.', EXIT.FAIL);
    }
    await deps.sleep(intervalMs);
    const outcome = await pollDeviceToken(deps, { apiBaseUrl: opts.apiBaseUrl, clientId: opts.clientId, deviceCode: issued.device_code });
    if (outcome.kind === 'success') return outcome.token;
    if (outcome.kind === 'denied') throw new CliError('Sign-in was denied.', EXIT.FAIL);
    if (outcome.kind === 'expired') throw new CliError('The device sign-in code expired before it was approved.', EXIT.FAIL);
    if (outcome.kind === 'slow_down') intervalMs += 5000;
  }
}
