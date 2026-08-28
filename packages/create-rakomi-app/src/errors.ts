// SPDX-License-Identifier: MIT

/**
 * Fixed POSIX exit-code map for the CLI.
 *
 * - `OK` (0): success.
 * - `FAIL` (1): a runtime failure (fetch / extract / write).
 * - `USAGE` (2): a usage error (unknown slug, bad arg, non-empty target dir).
 *
 * `--help` / `--version` always exit 0. The CLI never uses codes >= 126.
 */
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * A user-facing CLI error. The `message` is already user-safe (no stack traces, internal
 * paths, or dependency versions) and is printed to stderr; `exitCode` drives the process
 * exit. A dedicated subclass keeps the codebase free of bare `throw new Error()`.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = EXIT.FAIL) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** A usage error — bad/unknown argument, unknown slug, or non-empty target (exit 2). */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.USAGE);
    this.name = 'UsageError';
  }
}
