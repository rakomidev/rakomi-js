// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';
import { type HttpDeps, request } from './http.js';

/**
 * CI-platform env vars this module reads — kept OUT of `CliEnv` (env.ts) deliberately: these are
 * platform-issued, not Rakomi-specific, the same reasoning `index.ts`'s `main()` already applies to
 * `RAKOMI_NO_KEYCHAIN`. Injected (never read from `process.env` outside `index.ts`'s `main()`) so
 * every source is independently testable with no real environment.
 */
export interface CiOidcEnv {
  /** GitHub Actions — the runner's own ID-token minting endpoint + its own short-lived bearer,
   * both provided automatically when the job declares `permissions: id-token: write`. */
  readonly ACTIONS_ID_TOKEN_REQUEST_URL?: string;
  readonly ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string;
  /** GitLab CI — the job's own OIDC ID token, pre-minted by the runner directly into an env var
   * (no network call needed). `CI_JOB_JWT_V2` is GitLab's current name; `CI_JOB_JWT` is its own
   * deprecated predecessor, still honored here as a fallback for an older runner image. */
  readonly CI_JOB_JWT_V2?: string;
  readonly CI_JOB_JWT?: string;
  /** Generic escape hatch for any OTHER CI platform (CircleCI, Buildkite, a runner you operate
   * yourself): the pipeline mints its own OIDC token by whatever means it has and hands it to the
   * CLI directly. Checked LAST among env sources — `--oidc-token-file` (a same-purpose, file-based
   * escape hatch) is checked first, ahead of every env var. */
  readonly RAKOMI_OIDC_TOKEN?: string;
}

export interface ResolveCiOidcTokenOpts {
  readonly env: CiOidcEnv;
  /** `--oidc-token-file <path>` — checked FIRST: an explicit flag always outranks ambient env. */
  readonly oidcTokenFile?: string;
  readonly readTextFile: (path: string) => string;
  /** The `resource` this token will be exchanged for. GitHub Actions' minting endpoint accepts an
   * `&audience=` query param naming the intended recipient — passed straight through into the
   * minted token's own `aud` claim. */
  readonly audience: string;
}

/** Named, actionable error — every source this function knows about, so a misconfigured CI job
 * gets a fixable message instead of a bare "not logged in". */
export const NO_OIDC_SOURCE_MESSAGE =
  'rakomi login --ci found no OIDC identity token. Set RAKOMI_OIDC_TOKEN, pass ' +
  '--oidc-token-file <path>, or run on a CI platform this command recognizes automatically ' +
  '(GitHub Actions with `permissions: id-token: write`, or GitLab CI with CI_JOB_JWT_V2).';

/**
 * Resolves the runner's own OIDC identity token — never a browser, never a loopback listener.
 * Priority, most-explicit first: `--oidc-token-file` > `RAKOMI_OIDC_TOKEN` > GitHub Actions (one
 * network call to the runner's OWN minting endpoint, authenticated with the runner's OWN
 * short-lived bearer) > GitLab CI (`CI_JOB_JWT_V2`/`CI_JOB_JWT`, no network call — the runner
 * already minted it straight into the environment). Missing every source throws a `CliError`
 * naming all four, never a generic failure.
 */
export async function resolveCiOidcToken(deps: HttpDeps, opts: ResolveCiOidcTokenOpts): Promise<string> {
  if (opts.oidcTokenFile) {
    let raw: string;
    try {
      raw = opts.readTextFile(opts.oidcTokenFile);
    } catch {
      throw new CliError(`Could not read --oidc-token-file ${JSON.stringify(opts.oidcTokenFile)}.`, EXIT.FAIL);
    }
    const token = raw.trim();
    if (token.length === 0) {
      throw new CliError(`--oidc-token-file ${JSON.stringify(opts.oidcTokenFile)} was empty.`, EXIT.FAIL);
    }
    return token;
  }

  if (opts.env.RAKOMI_OIDC_TOKEN) {
    return opts.env.RAKOMI_OIDC_TOKEN;
  }

  if (opts.env.ACTIONS_ID_TOKEN_REQUEST_URL && opts.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return requestGitHubActionsIdToken(deps, opts.env.ACTIONS_ID_TOKEN_REQUEST_URL, opts.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, opts.audience);
  }

  const gitlabToken = opts.env.CI_JOB_JWT_V2 || opts.env.CI_JOB_JWT;
  if (gitlabToken) {
    return gitlabToken;
  }

  throw new CliError(NO_OIDC_SOURCE_MESSAGE, EXIT.FAIL);
}

async function requestGitHubActionsIdToken(deps: HttpDeps, requestUrl: string, requestToken: string, audience: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    throw new CliError('ACTIONS_ID_TOKEN_REQUEST_URL is not a valid URL.', EXIT.FAIL);
  }
  url.searchParams.set('audience', audience);
  const result = await request<{ value?: string }>(deps, {
    method: 'GET',
    url: url.toString(),
    headers: { authorization: `Bearer ${requestToken}` },
  });
  if (result.status !== 200 || typeof result.body.value !== 'string' || result.body.value.length === 0) {
    throw new CliError('Could not obtain a GitHub Actions OIDC token (check `permissions: id-token: write` on this job).', EXIT.FAIL);
  }
  return result.body.value;
}
