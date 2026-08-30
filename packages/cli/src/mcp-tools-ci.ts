// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';
import { describeError, type HttpDeps, request } from './http.js';
import type { StoredInstallKey } from './install-key.js';

/** Must stay byte-identical to the platform's own MCP resource identity constant. */
export const MCP_RESOURCE = 'https://mcp.rakomi.com';

/** Must stay byte-identical to the MCP server's own protocol-version constant. */
const MCP_PROTOCOL_VERSION = '2026-07-28';
/** Must stay byte-identical to the MCP server's own protocol-version header name. */
const MCP_PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';
/** Must stay byte-identical to the MCP server's own method-header name. */
const MCP_METHOD_HEADER = 'Mcp-Method';
/** Must stay byte-identical to the MCP server's own `_meta` protocol-version key. */
const MCP_META_PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
/** Must stay byte-identical to the MCP server's own `_meta` client-capabilities key. */
const MCP_META_CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

/** Mirrors the server's own tool-list-entry shape — only the fields this command prints. */
export interface McpToolListEntry {
  readonly name: string;
  readonly description: string;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

interface JsonRpcSuccessBody {
  readonly jsonrpc: '2.0';
  readonly id: unknown;
  readonly result: { readonly tools: McpToolListEntry[] };
}
interface JsonRpcErrorBody {
  readonly jsonrpc: '2.0';
  readonly id: unknown;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

function isJsonRpcError(body: unknown): body is JsonRpcErrorBody {
  return typeof body === 'object' && body !== null && 'error' in body;
}

/**
 * `tools/list` against the live `/mcp` Streamable-HTTP resource server. The server filters the
 * visible tool set by the token's own scope — this call returns exactly the tools an
 * `mcp:tools:read`-scoped caller may see, no client-side filtering needed or possible.
 */
export async function listMcpToolsCi(
  deps: HttpDeps,
  opts: { readonly mcpUrl: string; readonly accessToken: string; readonly dpopKey: StoredInstallKey },
): Promise<McpToolListEntry[]> {
  const message = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/list',
    params: {
      _meta: {
        [MCP_META_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION,
        [MCP_META_CLIENT_CAPABILITIES_KEY]: {},
      },
    },
  };

  const result = await request<JsonRpcSuccessBody | JsonRpcErrorBody>(deps, {
    method: 'POST',
    url: opts.mcpUrl,
    headers: {
      [MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION,
      [MCP_METHOD_HEADER]: 'tools/list',
    },
    body: message,
    dpop: { key: opts.dpopKey, accessToken: opts.accessToken },
  });

  if (result.status === 401) {
    throw new CliError(`Could not list MCP tools: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  if (isJsonRpcError(result.body)) {
    throw new CliError(`Could not list MCP tools: ${result.body.error.message}`, EXIT.FAIL);
  }
  if (result.status !== 200 || typeof result.body !== 'object' || result.body === null || !('result' in result.body)) {
    throw new CliError(`Could not list MCP tools: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body.result.tools;
}
