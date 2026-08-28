// SPDX-License-Identifier: MIT

export type KnownClient = 'claude-code' | 'claude-desktop';

export const KNOWN_CLIENTS: readonly KnownClient[] = ['claude-code', 'claude-desktop'];

export function isKnownClient(value: string): value is KnownClient {
  return (KNOWN_CLIENTS as readonly string[]).includes(value);
}

export function clientDisplayName(client: KnownClient): string {
  return client === 'claude-code' ? 'Claude Code' : 'Claude Desktop';
}

/** Whether the `claude` CLI is on PATH — injectable so detection never actually spawns a process in tests. */
export type ClaudeCodeDetector = () => boolean;

/**
 * Resolve which client(s) to connect. Never silently picks between more than one detected client —
 * throws `AmbiguousClientError` so the caller can print "pass --client".
 */
export function resolveTargetClients(opts: {
  readonly explicitClient?: string;
  readonly claudeCodeDetected: boolean;
}): readonly KnownClient[] {
  if (opts.explicitClient) {
    if (!isKnownClient(opts.explicitClient)) {
      throw new AmbiguousClientError(
        `Unknown --client "${opts.explicitClient}". Known clients: ${KNOWN_CLIENTS.join(', ')}.`,
      );
    }
    return [opts.explicitClient];
  }
  if (opts.claudeCodeDetected) return ['claude-code'];
  throw new AmbiguousClientError(
    `Could not detect an installed MCP client automatically. Pass --client <${KNOWN_CLIENTS.join('|')}>.`,
  );
}

export class AmbiguousClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousClientError';
  }
}
