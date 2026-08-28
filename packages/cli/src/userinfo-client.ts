// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';
import { describeError, type HttpDeps, request } from './http.js';

export interface UserInfo {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly org_id?: string;
  readonly org_role?: string;
}

export async function fetchUserInfo(
  deps: HttpDeps,
  opts: { readonly apiBaseUrl: string; readonly accessToken: string },
): Promise<UserInfo> {
  const result = await request<UserInfo & { error?: string }>(deps, {
    method: 'GET',
    url: `${opts.apiBaseUrl}/oauth/userinfo`,
    headers: { authorization: `Bearer ${opts.accessToken}` },
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status !== 200) {
    throw new CliError(`Could not fetch your account info: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}
