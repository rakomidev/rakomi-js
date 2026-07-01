/**
 * Multi-tab synchronization via BroadcastChannel + Web Locks API.
 *
 * Security: broadcasts SIGNALS ONLY — NEVER token values.
 * Other tabs read updated tokens from their own storage adapter.
 * This prevents passive XSS exfiltration via BroadcastChannel listener.
 *
 * Message validation uses Object.hasOwn() (prototype pollution defense).
 * Unknown message types are silently ignored.
 *
 * StorageEvent fallback: when BroadcastChannel is unavailable AND persistence='local',
 * storage events provide cross-tab sync for localStorage.
 */

import type { TabSyncMessage } from './types.js';

const VALID_MESSAGE_TYPES = ['TOKEN_REFRESHED', 'SIGNED_OUT'] as const;

function isValidMessage(data: unknown): data is TabSyncMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    Object.hasOwn(data, 'type') &&
    VALID_MESSAGE_TYPES.includes((data as TabSyncMessage).type)
  );
}

export type TabSyncCallback = (message: TabSyncMessage) => void;

export class TabSync {
  private channel: BroadcastChannel | null = null;
  private callbacks: Set<TabSyncCallback> = new Set();
  private readonly channelName: string;
  private readonly lockName: string;
  private readonly useStorageEvent: boolean;
  private readonly refreshTokenKey: string;
  private storageEventHandler: ((e: StorageEvent) => void) | null = null;

  constructor(clientId: string, persistence: 'session' | 'local' | 'memory') {
    this.channelName = `rakomi-auth-${clientId}`;
    this.lockName = `rakomi-refresh-${clientId}`;
    this.refreshTokenKey = `rakomi:${clientId}:refresh_token`;

    if (typeof window === 'undefined') {
      this.useStorageEvent = false;
      return;
    }

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(this.channelName);
        this.channel.onmessage = (event: MessageEvent) => {
          if (!isValidMessage(event.data)) return;
          for (const cb of this.callbacks) {
            cb(event.data);
          }
        };
        this.useStorageEvent = false;
      } catch {
        this.channel = null;
        this.useStorageEvent = persistence === 'local';
      }
    } else {
      if (typeof window !== 'undefined') {
        console.warn('[Rakomi] BroadcastChannel unavailable — operating in single-tab mode.');
      }
      this.useStorageEvent = persistence === 'local';
    }

    if (this.useStorageEvent && persistence === 'local') {
      this.storageEventHandler = (event: StorageEvent) => {
        if (event.key !== this.refreshTokenKey) return;
        if (event.newValue === null) {
          for (const cb of this.callbacks) cb({ type: 'SIGNED_OUT' });
        } else {
          for (const cb of this.callbacks) cb({ type: 'TOKEN_REFRESHED' });
        }
      };
      window.addEventListener('storage', this.storageEventHandler);
    }
  }

  onMessage(callback: TabSyncCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /**
   * Broadcast a signal to other tabs.
   * SECURITY: never include token values in messages.
   * Received messages are NOT re-broadcast (prevent echo loops).
   */
  broadcast(message: TabSyncMessage): void {
    if (this.channel) {
      try {
        this.channel.postMessage(message);
      } catch {
      }
    }
  }

  /**
   * Acquire Web Lock for exclusive token refresh.
   * Only one tab refreshes at a time — prevents nuclear revocation from concurrent refreshes.
   *
   * Uses AbortController + setTimeout for 5s timeout (Web Locks has no built-in timeout).
   * On lock timeout: returns acquired=false, caller waits for TOKEN_REFRESHED signal.
   */
  async acquireRefreshLock(): Promise<{ acquired: boolean; release: () => void }> {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      return { acquired: true, release: () => {} };
    }

    return new Promise((resolve) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      let releaseCallback: () => void = () => {};

      navigator.locks.request(
        this.lockName,
        { signal: controller.signal },
        () => new Promise<void>((resolveLock) => {
          clearTimeout(timeoutId);
          releaseCallback = resolveLock;
          resolve({ acquired: true, release: resolveLock });
        }),
      ).catch((err: unknown) => {
        clearTimeout(timeoutId);
        const isAbort = err instanceof Error && err.name === 'AbortError';
        if (isAbort) {
          resolve({ acquired: false, release: () => {} });
        } else {
          resolve({ acquired: true, release: () => {} });
        }
      });

      void releaseCallback;
    });
  }

  destroy(): void {
    this.callbacks.clear();
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
      }
      this.channel = null;
    }
    if (this.storageEventHandler && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageEventHandler);
      this.storageEventHandler = null;
    }
  }
}
