// SPDX-License-Identifier: MIT

/**
 * Fixed POSIX exit-code map for the CLI. Mirrors `create-rakomi-app`'s contract (this repo's
 * precedent for a publishable CLI package) so the two tools' scripting behaviour is consistent.
 *
 * - `OK` (0): success.
 * - `FAIL` (1): a runtime failure (network / auth / server error).
 * - `USAGE` (2): a usage error (unknown verb, bad flag, missing required argument).
 * - `NOT_LOGGED_IN` (3): a command that needs a session found none — distinct from a generic
 *   auth failure so a script can tell "never logged in" from "token rejected" apart.
 * - `INTERACTIVE_REQUIRED` (4): `--ci`/`--yes` (or a non-TTY) hit a step that can only be
 *   completed by a human in a browser (an owner's write-access approval, a login prompt).
 *
 * The CLI never uses codes >= 126 (reserved by POSIX shells).
 */
export const EXIT = {
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  NOT_LOGGED_IN: 3,
  INTERACTIVE_REQUIRED: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * A user-facing CLI error. `message` is already user-safe (no stack traces, internal paths,
 * tokens, or dependency versions) and is printed to stderr; `exitCode` drives the process exit.
 * A dedicated subclass keeps the codebase free of bare `throw new Error()`.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = EXIT.FAIL) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** A usage error — bad/unknown argument or verb (exit 2). */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.USAGE);
    this.name = 'UsageError';
  }
}

/** No local session found for a command that requires one (exit 3). */
export class NotLoggedInError extends CliError {
  constructor(message = 'Not logged in. Run `rakomi login` first.') {
    super(message, EXIT.NOT_LOGGED_IN);
    this.name = 'NotLoggedInError';
  }
}

/** A step needs an interactive human (browser approval, TTY prompt) but ran under `--ci`/`--yes`/non-TTY (exit 4). */
export class InteractiveRequiredError extends CliError {
  constructor(message: string) {
    super(message, EXIT.INTERACTIVE_REQUIRED);
    this.name = 'InteractiveRequiredError';
  }
}
