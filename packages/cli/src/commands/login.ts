// SPDX-License-Identifier: MIT

import type { BrowserOpener } from '../browser.js';
import { accountsBaseUrl, apiBaseUrl, clientId as resolveClientId, type CliEnv, isCimdClientId } from '../env.js';
import { CliError, EXIT } from '../errors.js';
import type { HttpDeps } from '../http.js';
import type { LoopbackListener } from '../loopback-server.js';
import { buildAuthorizeUrl, exchangeAuthorizationCode } from '../oauth-authcode.js';
import { loginWithDeviceGrant } from '../oauth-device.js';
import { generatePkcePair } from '../pkce.js';
import type { SessionStore, StoredSession } from '../session.js';

/** The scope `login` requests — profile identity + the scopes later commands need (device-grant AND
 * loopback share it). `clients:read`/`elevation:request` (cli-bearer-client-read-and-owner-token-
 * path) let `rakomi connect` check CIMD-materialization status and request write-access elevation
 * from a Bearer token, without a second, incremental authorization round trip.
 *
 * ⚠ Deliberately does NOT include `tenants:create`. Since the default `client_id` (`env.ts`) is a
 * CIMD document URL, the server materializes a per-tenant OAuth client that is never allowed to
 * self-assert the tenant-provisioning capability — that scope stays gated behind a separate,
 * verified path regardless of the client identity used to sign in. Requesting a scope the freshly-
 * materialized client can never hold does not merely fail to grant it — the server rejects the
 * WHOLE authorize request as invalid, so `rakomi login` would break on its very first run against
 * every tenant. This constant MUST stay in sync with the CIMD document's own `scope` field for
 * exactly this reason. `tenants create --owner me` from a `login` session goes through a separate,
 * owner-verified provisioning path and does not require this scope. */
export const LOGIN_SCOPE = 'openid profile email clients:read elevation:request';

const LOOPBACK_TIMEOUT_MS = 5 * 60_000;

export interface LoginDeps extends HttpDeps {
  readonly env: CliEnv;
  readonly session: SessionStore;
  readonly noBrowser: boolean;
  readonly openBrowser: BrowserOpener;
  readonly startLoopback: () => Promise<LoopbackListener>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stdout: { write(s: string): void };
  readonly now: () => number;
}

export async function runLogin(deps: LoginDeps): Promise<void> {
  const apiUrl = apiBaseUrl(deps.env);
  const cid = resolveClientId(deps.env);

  if (deps.noBrowser && isCimdClientId(cid)) {
    throw new CliError(
      'rakomi login --no-browser needs a client registered for the device-code grant; the ' +
        "default CIMD client_id does not support it. Pass --client <your-client-id> (create one " +
        'in the dashboard) for headless/SSH sign-in, or omit --no-browser to sign in via loopback.',
      EXIT.FAIL,
    );
  }

  const token = deps.noBrowser
    ? await runDeviceGrantLogin(deps, apiUrl, cid)
    : await runLoopbackLogin(deps, apiUrl, cid);

  const session: StoredSession = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: 'Bearer',
    expires_at: deps.now() + token.expires_in * 1000,
    api_base_url: apiUrl,
    client_id: cid,
  };
  deps.session.write(session);
  deps.stdout.write('Logged in to Rakomi.\n');
}

async function runLoopbackLogin(
  deps: LoginDeps,
  apiUrl: string,
  cid: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const listener = await deps.startLoopback();
  try {
    const pkce = generatePkcePair();
    const authorizeUrl = buildAuthorizeUrl({
      accountsBaseUrl: accountsBaseUrl(deps.env),
      clientId: cid,
      redirectUri: listener.redirectUri,
      pkce,
      scope: LOGIN_SCOPE,
    });
    deps.stdout.write(`Opening your browser to sign in:\n  ${authorizeUrl}\n`);
    await deps.openBrowser(authorizeUrl);

    const callback = await listener.waitForCallback(LOOPBACK_TIMEOUT_MS);
    if (callback.error) {
      throw new CliError(`Sign-in failed: ${callback.errorDescription ?? callback.error}`, EXIT.FAIL);
    }
    if (!callback.code || callback.state !== pkce.state) {
      throw new CliError('Sign-in callback was missing the authorization code or had a mismatched state.', EXIT.FAIL);
    }
    return exchangeAuthorizationCode(deps, {
      apiBaseUrl: apiUrl,
      clientId: cid,
      redirectUri: listener.redirectUri,
      code: callback.code,
      codeVerifier: pkce.codeVerifier,
    });
  } finally {
    listener.close();
  }
}

async function runDeviceGrantLogin(
  deps: LoginDeps,
  apiUrl: string,
  cid: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  return loginWithDeviceGrant(
    {
      ...deps,
      onWaiting: (issued) => {
        deps.stdout.write(
          `To sign in, open ${issued.verification_uri} and enter the code ${issued.user_code}\n` +
            `(or open ${issued.verification_uri_complete} directly).\n`,
        );
      },
    },
    { apiBaseUrl: apiUrl, clientId: cid, scope: LOGIN_SCOPE },
  );
}
