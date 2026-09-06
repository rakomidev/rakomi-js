// SPDX-License-Identifier: MIT

import { RAKOMI_SERVER_NAME } from './client-registry.generated.js';
import { UsageError } from './errors.js';

/** Lowercase letters, digits and hyphens; starts with a letter; 1–40 characters. One character
 * class, one bounded quantifier — no backtracking to speak of. */
export const SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export const SERVER_NAME_MAX_LENGTH = 40;

export function isValidServerName(value: string): boolean {
  return SERVER_NAME_PATTERN.test(value);
}

/**
 * Resolve the server name for this run: the default when the flag is absent, the flag's value when
 * it is well-formed, a `UsageError` (exit 2) otherwise — with the rule spelled out, so the user can
 * fix the name rather than guess at it.
 */
export function resolveServerName(raw: string | undefined): string {
  if (raw === undefined) return RAKOMI_SERVER_NAME;
  if (isValidServerName(raw)) return raw;
  throw new UsageError(
    `Invalid --name "${raw}": use lowercase letters, digits and hyphens only, starting with a letter, ` +
      `at most ${SERVER_NAME_MAX_LENGTH} characters (for example \`${RAKOMI_SERVER_NAME}-acme\`).`,
  );
}
