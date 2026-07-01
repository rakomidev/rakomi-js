/**
 * Auth event log — circular buffer of last 50 AuthEvent entries.
 *
 * Platform-neutral:
 * relies on `crypto.randomUUID` if present (web + Hermes 2024+), with a CSPRNG-bytes
 * fallback. Never `Math.random`.
 *
 * Security:
 * - NEVER logs token values — only event types, timestamps, durations, errors, tabId.
 * - severity 'security' enables SIEM filtering for SOC 2 / NIS2.
 */

import type { AuthEvent } from './types/auth.js';

const MAX_EVENTS = 50;

function generateTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    const now = Date.now();
    for (let i = 0; i < 16; i++) bytes[i] = (now >> (i % 8)) & 0xff;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export class EventLog {
  private readonly buffer: AuthEvent[] = [];
  public readonly tabId: string;
  private readonly onAuthEvent?: (event: AuthEvent) => void;

  constructor(onAuthEvent?: (event: AuthEvent) => void) {
    this.tabId = generateTabId();
    this.onAuthEvent = onAuthEvent;
  }

  push(partial: Omit<AuthEvent, 'timestamp' | 'tabId'>): void {
    const event: AuthEvent = { ...partial, timestamp: Date.now(), tabId: this.tabId };
    if (this.buffer.length >= MAX_EVENTS) this.buffer.shift();
    this.buffer.push(event);
    if (this.onAuthEvent) {
      try {
        this.onAuthEvent(event);
      } catch {
      }
    }
  }

  getAll(): AuthEvent[] {
    return [...this.buffer];
  }

  /** GDPR Art. 17 erasure. */
  clear(): void {
    this.buffer.length = 0;
  }
}
