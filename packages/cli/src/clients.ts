// SPDX-License-Identifier: MIT

import { CLIENT_REGISTRY, type ClientRegistryEntry, KNOWN_CLIENTS,type KnownClient } from './client-registry.generated.js';
import { CliError, EXIT } from './errors.js';

export type { ClientRegistryEntry, KnownClient };
export { CLIENT_REGISTRY, KNOWN_CLIENTS };

export function isKnownClient(value: string): value is KnownClient {
  return (KNOWN_CLIENTS as readonly string[]).includes(value);
}

/** Throws if `id` is not a known client — callers that already validated via `isKnownClient` never hit this. */
export function clientRegistryEntry(id: KnownClient): ClientRegistryEntry {
  const entry = CLIENT_REGISTRY.find((c) => c.id === id);
  if (!entry) throw new CliError(`clientRegistryEntry: unknown client '${id}' — this should be unreachable, isKnownClient() gates every caller`, EXIT.FAIL);
  return entry;
}

export function clientDisplayName(client: KnownClient): string {
  return clientRegistryEntry(client).displayName;
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
