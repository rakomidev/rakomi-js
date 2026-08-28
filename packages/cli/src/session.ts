// SPDX-License-Identifier: MIT

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { CliEnv } from './env.js';

export interface StoredSession {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type: 'Bearer';
  /** Epoch milliseconds. */
  readonly expires_at: number;
  readonly api_base_url: string;
  readonly client_id: string;
}

/** Injectable session store — the real implementation is `FileSessionStore` or `KeychainSessionStore`; tests use an in-memory fake. */
export interface SessionStore {
  read(): StoredSession | null;
  write(session: StoredSession): void;
  clear(): void;
  /** A human-readable description of where the session lives — used only for user-facing messages, never logged automatically. */
  describePath(): string;
}

/**
 * A named-secret store, independent of `SessionStore`. Its first (and, today, only) intended
 * consumer is a future per-install signing key (OAuth client-assertion / DPoP token binding) —
 * `name` lets that key live under its own entry, never mixed into the session's own storage.
 */
export interface KeyStore {
  /** Returns `null` when nothing is stored under `name`, or when the stored value is unreadable/corrupted (fail-closed). */
  get(name: string): string | null;
  set(name: string, value: string): void;
  clear(name: string): void;
}

export function configDir(env: CliEnv): string {
  if (env.RAKOMI_CONFIG_DIR) return env.RAKOMI_CONFIG_DIR;
  return join(homedir(), '.config', 'rakomi');
}

function sessionFilePath(env: CliEnv): string {
  return join(configDir(env), 'session.json');
}

/** Real, on-disk session store: a `0600` JSON file, directory created `0700`. */
export class FileSessionStore implements SessionStore {
  private readonly path: string;
  private readonly dir: string;

  constructor(env: CliEnv) {
    this.dir = configDir(env);
    this.path = sessionFilePath(env);
  }

  read(): StoredSession | null {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredSession(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  write(session: StoredSession): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
    }
  }

  clear(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
    }
  }

  describePath(): string {
    return this.path;
  }
}

/** A file-backed `KeyStore` — one file per named key, always distinct from `session.json`. Used by the fallback tier. */
export class FileKeyStore implements KeyStore {
  constructor(private readonly dir: string) {}

  private path(name: string): string {
    return join(this.dir, `key-${name}.json`);
  }

  get(name: string): string | null {
    try {
      return readFileSync(this.path(name), 'utf8');
    } catch {
      return null;
    }
  }

  set(name: string, value: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path(name), value, { mode: 0o600 });
    try {
      chmodSync(this.path(name), 0o600);
    } catch {
    }
  }

  clear(name: string): void {
    try {
      rmSync(this.path(name), { force: true });
    } catch {
    }
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access_token === 'string' &&
    v.access_token.length > 0 &&
    v.token_type === 'Bearer' &&
    typeof v.expires_at === 'number' &&
    typeof v.api_base_url === 'string' &&
    typeof v.client_id === 'string'
  );
}

/** True iff the session is expired (no clock-skew grace — the API's own 401 is the real check). */
export function isExpired(session: StoredSession, now: number): boolean {
  return now >= session.expires_at;
}

/** Matches `node:child_process`'s `execFileSync` closely enough to be a drop-in default, and small enough to fake in a test. */
export type ExecFileSyncLike = (file: string, args: readonly string[], options?: { readonly input?: string }) => string;

function realExecFileSync(file: string, args: readonly string[], options?: { readonly input?: string }): string {
  return execFileSync(file, [...args], { encoding: 'utf8', input: options?.input, maxBuffer: 10 * 1024 * 1024 }).toString();
}

/** Presence-only PATH scan — no process spawned, same technique as `index.ts`'s `detectClaudeCodeCli`. */
function commandExistsOnPath(binaryName: string, pathEnv: string, existsFn: (p: string) => boolean): boolean {
  return pathEnv.split(delimiter).some((dir) => dir.length > 0 && existsFn(join(dir, binaryName)));
}

export interface KeychainBackend {
  /** A short, stable id — reported by `resolveStores()` and shown to the user via `whoami`/`--no-keychain` messaging. */
  readonly name: string;
  /** Cheap, side-effect-free (or read-only) check that this backend can actually be used right now. */
  isAvailable(): boolean;
  /** `null` on "not found" AND on any read failure — callers must treat both as "nothing usable here". */
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): void;
  /** Idempotent — deleting an absent item is not an error. */
  delete(service: string, account: string): void;
}

/** macOS Keychain, via the `security` CLI that ships with every macOS install — no native module. */
export class MacKeychainBackend implements KeychainBackend {
  readonly name = 'macos-keychain';

  constructor(
    private readonly execFileSyncFn: ExecFileSyncLike = realExecFileSync,
    private readonly platform: string = process.platform,
  ) {}

  isAvailable(): boolean {
    if (this.platform !== 'darwin') return false;
    try {
      this.execFileSyncFn('security', ['list-keychains']);
      return true;
    } catch {
      return false;
    }
  }

  get(service: string, account: string): string | null {
    try {
      const out = this.execFileSyncFn('security', ['find-generic-password', '-a', account, '-s', service, '-w']);
      const value = out.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  set(service: string, account: string, value: string): void {
    this.execFileSyncFn('security', ['add-generic-password', '-a', account, '-s', service, '-w', value, '-U']);
  }

  delete(service: string, account: string): void {
    try {
      this.execFileSyncFn('security', ['delete-generic-password', '-a', account, '-s', service]);
    } catch {
    }
  }
}

/** Linux Secret Service (GNOME Keyring, KWallet's compatible shim, …), via `secret-tool` (part of `libsecret-tools`). */
export class LinuxSecretToolBackend implements KeychainBackend {
  readonly name = 'linux-secret-service';

  constructor(
    private readonly execFileSyncFn: ExecFileSyncLike = realExecFileSync,
    private readonly platform: string = process.platform,
    private readonly pathEnv: string = process.env.PATH ?? '',
    private readonly existsFn: (p: string) => boolean = existsSync,
  ) {}

  isAvailable(): boolean {
    if (this.platform !== 'linux') return false;
    return commandExistsOnPath('secret-tool', this.pathEnv, this.existsFn);
  }

  get(service: string, account: string): string | null {
    try {
      const out = this.execFileSyncFn('secret-tool', ['lookup', 'service', service, 'account', account]);
      const value = out.replace(/\n$/, '');
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  set(service: string, account: string, value: string): void {
    this.execFileSyncFn('secret-tool', ['store', '--label', `Rakomi CLI (${account})`, 'service', service, 'account', account], { input: value });
  }

  delete(service: string, account: string): void {
    try {
      this.execFileSyncFn('secret-tool', ['clear', 'service', service, 'account', account]);
    } catch {
    }
  }
}

/**
 * Windows: the value is encrypted at rest with the Data Protection API (tied to the signed-in
 * Windows user), and the ciphertext is stored in its own file under the config directory.
 * Named plainly rather than as "Credential Manager" — there is no CLI-reachable way to READ a
 * generic credential's password back from `cmdkey`, so DPAPI-encrypted-at-rest is the honest,
 * accurate description of what this backend actually does.
 */
export class WindowsDpapiBackend implements KeychainBackend {
  readonly name = 'windows-dpapi';

  constructor(
    private readonly dir: string,
    private readonly execFileSyncFn: ExecFileSyncLike = realExecFileSync,
    private readonly platform: string = process.platform,
    private readonly pathEnv: string = process.env.PATH ?? '',
    private readonly existsFn: (p: string) => boolean = existsSync,
  ) {}

  isAvailable(): boolean {
    if (this.platform !== 'win32') return false;
    return commandExistsOnPath('powershell.exe', this.pathEnv, this.existsFn) || commandExistsOnPath('pwsh.exe', this.pathEnv, this.existsFn);
  }

  private filePath(service: string, account: string): string {
    return join(this.dir, `${service}.${account}.dpapi`);
  }

  get(service: string, account: string): string | null {
    let cipherB64: string;
    try {
      cipherB64 = readFileSync(this.filePath(service, account), 'utf8').trim();
    } catch {
      return null;
    }
    if (cipherB64.length === 0) return null;
    try {
      const script = `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${cipherB64}'), $null, 'CurrentUser'))`;
      const out = this.execFileSyncFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      const value = out.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  set(service: string, account: string, value: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const valueB64 = Buffer.from(value, 'utf8').toString('base64');
    const script = `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${valueB64}'), $null, 'CurrentUser'))`;
    const cipherB64 = this.execFileSyncFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).trim();
    writeFileSync(this.filePath(service, account), cipherB64 + '\n', { mode: 0o600 });
  }

  delete(service: string, account: string): void {
    try {
      rmSync(this.filePath(service, account), { force: true });
    } catch {
    }
  }
}

const SESSION_SERVICE = 'rakomi-cli';
const SESSION_ACCOUNT = 'session';
/** Deliberately a DIFFERENT service than the session's — see the module doc comment. */
const KEY_SERVICE = 'rakomi-cli-keys';

/** OS-keychain-backed session store, with one-time, one-directional migration from a pre-existing `0600` file. */
export class KeychainSessionStore implements SessionStore {
  constructor(
    private readonly backend: KeychainBackend,
    private readonly legacyFile: FileSessionStore,
  ) {}

  read(): StoredSession | null {
    const raw = this.backend.get(SESSION_SERVICE, SESSION_ACCOUNT);
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        return isStoredSession(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    const legacy = this.legacyFile.read();
    if (!legacy) return null;
    try {
      this.backend.set(SESSION_SERVICE, SESSION_ACCOUNT, JSON.stringify(legacy));
      this.legacyFile.clear();
    } catch {
    }
    return legacy;
  }

  write(session: StoredSession): void {
    this.backend.set(SESSION_SERVICE, SESSION_ACCOUNT, JSON.stringify(session));
  }

  clear(): void {
    this.backend.delete(SESSION_SERVICE, SESSION_ACCOUNT);
    this.legacyFile.clear();
  }

  describePath(): string {
    return `${this.backend.name} (service "${SESSION_SERVICE}")`;
  }
}

/** OS-keychain-backed `KeyStore` — every named key lives under `KEY_SERVICE`, never `SESSION_SERVICE`. */
export class KeychainKeyStore implements KeyStore {
  constructor(private readonly backend: KeychainBackend) {}

  get(name: string): string | null {
    return this.backend.get(KEY_SERVICE, name);
  }

  set(name: string, value: string): void {
    this.backend.set(KEY_SERVICE, name, value);
  }

  clear(name: string): void {
    this.backend.delete(KEY_SERVICE, name);
  }
}

export interface ResolvedStores {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  /** `'file'`, or a `KeychainBackend.name` — informational only, shown by `whoami`/`--no-keychain` messaging. */
  readonly backend: string;
  /** Non-null exactly when the fallback tier was used — the CLI prints this once and only once. */
  readonly fallbackDisclosure: string | null;
}

export interface ResolveStoresOptions {
  /** Skip every keychain backend and use the `0600` file — set by `--no-keychain`, `CI`, or `RAKOMI_NO_KEYCHAIN`. */
  readonly noKeychain?: boolean;
  /** Override the platform-selected backend list — test-only; production always passes nothing. */
  readonly backends?: readonly KeychainBackend[];
}

const FALLBACK_DISCLOSURE =
  'rakomi: no OS keychain available (or --no-keychain set) — using a local session file instead ' +
  '(~/.config/rakomi/session.json or $RAKOMI_CONFIG_DIR, readable only by your account). ' +
  'Run without --no-keychain on a supported OS to store it in your platform keychain instead.';

/** The single place that decides which backend `login`/`logout`/`whoami`/`connect` actually use. */
export function resolveStores(env: CliEnv, opts: ResolveStoresOptions = {}): ResolvedStores {
  const dir = configDir(env);
  const fileSession = new FileSessionStore(env);
  const fileKeys = new FileKeyStore(dir);

  if (opts.noKeychain) {
    return { session: fileSession, keys: fileKeys, backend: 'file', fallbackDisclosure: FALLBACK_DISCLOSURE };
  }

  const candidates = opts.backends ?? [new MacKeychainBackend(), new LinuxSecretToolBackend(), new WindowsDpapiBackend(dir)];

  for (const backend of candidates) {
    if (backend.isAvailable()) {
      return {
        session: new KeychainSessionStore(backend, fileSession),
        keys: new KeychainKeyStore(backend),
        backend: backend.name,
        fallbackDisclosure: null,
      };
    }
  }

  return { session: fileSession, keys: fileKeys, backend: 'file', fallbackDisclosure: FALLBACK_DISCLOSURE };
}
