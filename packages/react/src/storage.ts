/**
 * Token storage adapters for configurable refresh token persistence.
 *
 * Access tokens are ALWAYS in-memory (never persisted).
 * Refresh token persistence is configurable via the 'persistence' prop:
 *   - 'session' (default): sessionStorage — survives same-tab reload
 *   - 'local': localStorage — survives tab close (OWASP warns; NIST discourages)
 *   - 'memory': in-memory closure — most secure, lost on navigation
 *
 * All adapters are SSR-safe: fall back to memoryStorageAdapter if window is unavailable.
 */

export interface TokenStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

function memoryStore(): TokenStorage {
  const store: Record<string, string> = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
  };
}

export const memoryStorageAdapter: TokenStorage = memoryStore();

export const sessionStorageAdapter: TokenStorage = {
  getItem(key) {
    if (typeof window === 'undefined') return null;
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
    }
  },
  removeItem(key) {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.removeItem(key);
    } catch {
    }
  },
};

export const localStorageAdapter: TokenStorage = {
  getItem(key) {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
    }
  },
  removeItem(key) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(key);
    } catch {
    }
  },
};

/**
 * Resolve a storage adapter from the 'persistence' prop or a custom storage object.
 * Falls back to a fresh in-memory store in SSR (window unavailable).
 *
 * memoryStore() is called per resolveStorage() invocation, so each RakomiProvider
 * gets its own isolated in-memory store with no shared backing state.
 */
export function resolveStorage(
  persistence: 'session' | 'local' | 'memory',
  customStorage?: TokenStorage,
): TokenStorage {
  if (customStorage) return customStorage;

  if (typeof window === 'undefined') return memoryStore();

  switch (persistence) {
    case 'local': return localStorageAdapter;
    case 'memory': return memoryStore();
    case 'session':
    default:
      return sessionStorageAdapter;
  }
}
