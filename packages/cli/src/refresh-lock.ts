// SPDX-License-Identifier: MIT
/**
 * A cross-process single-flight lock for the session refresh. A rotated refresh token is valid exactly once: two
 * processes that both present the same one look, to the server, like a stolen token being replayed, and every
 * session of the user is revoked. Holding this lock around "read the session → present the refresh token → store
 * the rotated session" means only one process refreshes; the next one, once it holds the lock, reads the session
 * the first one stored and uses it instead of refreshing again.
 *
 * How it holds:
 *   - Acquire is an exclusive create (`wx`), atomic across processes. The file holds `<pid>:<nonce>`, a nonce fresh
 *     per acquisition, so a holder only ever removes ITS OWN lock: release reads the file and unlinks it only when the
 *     content is still its token.
 *   - Heartbeat, not a large stale window: while the holder runs, it touches the file every `staleMs / 4`. A live
 *     holder therefore never looks stale, however long its request takes (the HTTP timeout is 15 s by default and a
 *     caller may raise it), and a crashed holder's lock goes stale `staleMs` after its last beat. A bare "staleMs much
 *     larger than the fetch timeout" would tie this module to every caller's timeout; the heartbeat does not.
 *   - Stale takeover renames the file to a unique name first (rename is atomic: exactly one contender wins) and
 *     checks that the renamed file is the very lock it judged stale (same `<pid>:<nonce>`). If a fresh lock slipped in
 *     between, it is put back (hard link, which fails if yet another lock exists) and this contender waits.
 *   - Waiting is bounded by `timeoutMs`; a timeout is an error, never a refresh without the lock.
 *
 * Not covered: a session store on a network file system without atomic exclusive create and rename, and two machines
 * sharing one session store.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { CliError, EXIT } from './errors.js';

/** Runs `fn` while no other process runs a function under the same lock. */
export interface RefreshLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface FileRefreshLockOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** A lock file not touched for this long belongs to a crashed process. Default 30 s; the holder beats every staleMs/4. */
  readonly staleMs?: number;
  /** The longest wait for the lock. Default 60 s. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
}

export function createFileRefreshLock(path: string, opts: FileRefreshLockOptions = {}): RefreshLock {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 50;

  function tryCreate(token: string): boolean {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if (isErrno(err, 'EEXIST')) return false;
      throw err;
    }
  }

  /** Removes the lock at `path` when it is stale, through a rename that only one contender can win. */
  function takeOverIfStale(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return;
      throw err;
    }
    if (now() - mtimeMs <= staleMs) return;
    const observed = readOrNull(path);
    if (observed === null) return;
    const aside = `${path}.stale-${randomBytes(8).toString('hex')}`;
    try {
      renameSync(path, aside);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return;
      throw err;
    }
    if (readOrNull(aside) === observed) {
      unlinkSync(aside);
      return;
    }
    try {
      linkSync(aside, path);
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err;
    }
    unlinkSync(aside);
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const token = `${process.pid}:${randomBytes(16).toString('hex')}`;
      const deadline = now() + timeoutMs;
      while (!tryCreate(token)) {
        takeOverIfStale();
        if (tryCreate(token)) break;
        if (now() >= deadline) {
          throw new CliError(
            `Another rakomi process is refreshing this session (lock ${path}). Try again in a moment; if no other rakomi process is running, remove that file.`,
            EXIT.FAIL,
          );
        }
        await sleep(pollMs);
      }
      const beat = setInterval(() => {
        try {
          if (readOrNull(path) === token) {
            const t = new Date();
            utimesSync(path, t, t);
          }
        } catch {
        }
      }, Math.max(1, Math.floor(staleMs / 4)));
      beat.unref();
      try {
        return await fn();
      } finally {
        clearInterval(beat);
        try {
          if (readOrNull(path) === token) unlinkSync(path);
        } catch {
        }
      }
    },
  };
}
