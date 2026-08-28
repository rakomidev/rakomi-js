// SPDX-License-Identifier: MIT

import type { SessionStore } from '../session.js';

export interface LogoutDeps {
  readonly session: SessionStore;
  readonly stdout: { write(s: string): void };
}

/** Idempotent — logging out with no active session is a success, not an error (scripting-friendly). */
export function runLogout(deps: LogoutDeps): void {
  deps.session.clear();
  deps.stdout.write('Logged out.\n');
}
