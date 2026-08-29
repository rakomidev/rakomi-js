// SPDX-License-Identifier: MIT

import type { BrowserOpener } from '../browser.js';
import { type CiOidcEnv, resolveCiOidcToken } from '../ci-oidc-token.js';
import {
  accountsBaseUrl,
  apiBaseUrl,
  clientId as resolveClientId,
  type CliEnv,
  isCimdClientId,
  isCimdPlatformSupported,
} from '../env.js';
import { CliError, EXIT } from '../errors.js';
import type { HttpDeps } from '../http.js';
import { bindInstallKey, getOrCreateInstallKey, signClientAssertion, type StoredInstallKey } from '../install-key.js';
import type { LoopbackListener } from '../loopback-server.js';
import { buildAuthorizeUrl, exchangeAuthorizationCode } from '../oauth-authcode.js';
import { loginWithDeviceGrant } from '../oauth-device.js';
import { exchangeOidcSubjectToken } from '../oidc-federation-login.js';
import { generatePkcePair } from '../pkce.js';
import type { KeyStore, SessionStore, StoredSession } from '../session.js';

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

/**
 * Story rakomi-cli-cimd-disabled-fallback-error — the Option E fallback message (director memo
 * `rakomi-cli-oauth-client-topology-deep-dive-2026-08-27.md` §7/§9 item 5): when this API host does
 * not honor CIMD sign-in, name the manual pre-registration escape hatch instead of leaving the
 * operator to chase a bare "Unknown client" / a silent loopback timeout.
 */
function cimdUnsupportedMessage(cid: string): string {
  return (
    'This Rakomi server does not have CIMD-based sign-in enabled, so the default client_id ' +
    `(${cid}) cannot be used to sign in right now. Ask your tenant admin to register a client in ` +
    'the dashboard, then run `rakomi login --client <your-client-id>` (or set RAKOMI_CLIENT_ID) ' +
    'instead.'
  );
}

export interface LoginDeps extends HttpDeps {
  readonly env: CliEnv;
  readonly session: SessionStore;
  readonly keys: KeyStore;
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

  if (!deps.noBrowser && isCimdClientId(cid)) {
    const supported = await isCimdPlatformSupported(deps, apiUrl);
    if (supported === false) {
      throw new CliError(cimdUnsupportedMessage(cid), EXIT.FAIL);
    }
  }

  const installKey = isCimdClientId(cid) ? getOrCreateInstallKey(deps.keys, cid) : undefined;

  const token = deps.noBrowser
    ? await runDeviceGrantLogin(deps, apiUrl, cid)
    : await runLoopbackLogin(deps, apiUrl, cid, installKey);

  const session: StoredSession = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type === 'DPoP' ? 'DPoP' : 'Bearer',
    expires_at: deps.now() + token.expires_in * 1000,
    api_base_url: apiUrl,
    client_id: cid,
  };
  if (token.token_type !== 'Bearer' && token.token_type !== 'DPoP') {
    deps.stdout.write(`(debug) unexpected token_type "${token.token_type}" from the server — treating this session as Bearer.\n`);
  }
  deps.session.write(session);
  deps.stdout.write('Logged in to Rakomi.\n');

  if (installKey) {
    await bindInstallKey(
      deps,
      deps.keys,
      { apiBaseUrl: apiUrl, clientId: cid, accessToken: token.access_token, dpopBound: session.token_type === 'DPoP' },
      installKey,
    );
  }
}

async function runLoopbackLogin(
  deps: LoginDeps,
  apiUrl: string,
  cid: string,
  installKey: StoredInstallKey | undefined,
): Promise<{ access_token: string; refresh_token?: string; token_type: string; expires_in: number }> {
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
      clientAssertion: installKey?.confirmedBound
        ? signClientAssertion(installKey, { clientId: cid, audience: `${apiUrl}/oauth/token` })
        : undefined,
      dpopKey: installKey,
    });
  } finally {
    listener.close();
  }
}

async function runDeviceGrantLogin(
  deps: LoginDeps,
  apiUrl: string,
  cid: string,
): Promise<{ access_token: string; refresh_token?: string; token_type: string; expires_in: number }> {
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

/**
 * Story rakomi-cli-login-ci-oidc-federation — the CI-only `client_id` StoredSession carries when
 * signed in via `rakomi login --ci`. There is no `oauth_clients` row for this grant (the tenant's
 * trust policy IS the credential — see `oidc-federation-login.ts`'s module doc), so this is a
 * readable sentinel rather than a real client identity; nothing in the CLI reads
 * `StoredSession.client_id` today (`whoami`/`connect` use only `access_token`/`api_base_url`), so
 * this never has to round-trip through anything that expects a real client_id.
 */
const CI_FEDERATION_SESSION_CLIENT_ID = 'oidc-federation';

export interface LoginCiDeps extends HttpDeps {
  readonly env: CliEnv;
  readonly ciEnv: CiOidcEnv;
  readonly session: SessionStore;
  /** `--oidc-token-file <path>` — see `ci-oidc-token.ts`'s `resolveCiOidcToken`. */
  readonly oidcTokenFile?: string;
  readonly readTextFile: (path: string) => string;
  readonly stdout: { write(s: string): void };
  readonly now: () => number;
}

/**
 * `rakomi login --ci` — signs in via the runner's OWN OIDC identity token (RFC 8693 token
 * exchange), never a browser, never a loopback listener, never a device-code poll. Structurally
 * cannot open either: this function's dependency surface carries no `openBrowser`/`startLoopback`
 * at all (contrast `LoginDeps` above), so there is nothing here capable of doing so, by
 * construction rather than by a runtime guard. On any failure — no OIDC token source, or the
 * server's uniform `invalid_grant` reject — throws a `CliError` before anything is written to
 * disk; a short-lived, DPoP-bound access token is written to `deps.session` ONLY on success (never
 * a long-lived secret, and never the subject token itself).
 */
export async function runLoginCi(deps: LoginCiDeps): Promise<void> {
  const apiUrl = apiBaseUrl(deps.env);

  const subjectToken = await resolveCiOidcToken(deps, {
    env: deps.ciEnv,
    oidcTokenFile: deps.oidcTokenFile,
    readTextFile: deps.readTextFile,
    audience: apiUrl,
  });

  const token = await exchangeOidcSubjectToken(deps, { apiBaseUrl: apiUrl, subjectToken, resource: apiUrl });

  const session: StoredSession = {
    access_token: token.access_token,
    token_type: token.token_type,
    expires_at: deps.now() + token.expires_in * 1000,
    api_base_url: apiUrl,
    client_id: CI_FEDERATION_SESSION_CLIENT_ID,
  };
  deps.session.write(session);
  deps.stdout.write('Logged in to Rakomi (CI workload identity).\n');
}
