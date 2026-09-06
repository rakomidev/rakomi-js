// SPDX-License-Identifier: MIT

export type ClientTier = 'written' | 'instructed';
export type ClientStatus = 'verified' | 'documented-shape-only';
export type ClientConfigScope = 'project' | 'user';
export type ClientConfigSerialization = 'json' | 'toml';

export interface WrittenClientConfig {
  readonly scope: ClientConfigScope;
  /** Relative to the project directory (scope 'project') or the user's home directory (scope 'user'). */
  readonly pathTemplate: string;
  readonly serialization: ClientConfigSerialization;
  readonly topLevelKey: string;
  readonly remoteUrlField: string;
  readonly extraFields: Readonly<Record<string, string>>;
}

export interface ClientRegistryEntry {
  readonly id: KnownClient;
  readonly displayName: string;
  readonly tier: ClientTier;
  readonly status: ClientStatus;
  /** May carry the placeholders `{{MCP_URL}}` (the MCP endpoint) and `{{SERVER_NAME}}` (the config
   * entry's key — `RAKOMI_SERVER_NAME` unless the user chose another); render both before printing. */
  readonly finishInstruction: string;
  readonly config?: WrittenClientConfig;
  readonly evidenceUrl: string;
}

export const RAKOMI_SERVER_NAME = "rakomi";

export type KnownClient = "claude-code" | "vscode" | "cursor" | "antigravity" | "gemini-cli" | "zed" | "codex-cli" | "devin-desktop" | "claude-desktop" | "chatgpt" | "jetbrains";

export const CLIENT_REGISTRY: readonly ClientRegistryEntry[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    tier: "written",
    status: "verified",
    finishInstruction: "1. Run `claude` in this directory and approve the \"{{SERVER_NAME}}\" project server when prompted.\n2. Then run `claude mcp login {{SERVER_NAME}}` to finish sign-in in your browser (or use `/mcp` inside that session).",
    config: {
      scope: "project",
      pathTemplate: ".mcp.json",
      serialization: "json",
      topLevelKey: "mcpServers",
      remoteUrlField: "url",
      extraFields: { "type": "http" },
    },
    evidenceUrl: "https://code.claude.com/docs/en/mcp",
  },
  {
    id: "vscode",
    displayName: "VS Code",
    tier: "written",
    status: "documented-shape-only",
    finishInstruction: "Open the Command Palette and run \"MCP: List Servers\", or the Extensions view — VS Code starts the OAuth flow automatically the first time it connects.",
    config: {
      scope: "project",
      pathTemplate: ".vscode/mcp.json",
      serialization: "json",
      topLevelKey: "servers",
      remoteUrlField: "url",
      extraFields: { "type": "http" },
    },
    evidenceUrl: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    tier: "written",
    status: "documented-shape-only",
    finishInstruction: "Open Cursor's MCP settings and connect — for a server that supports OAuth, Cursor completes the flow for you (or accepts static client credentials in mcp.json instead of dynamic client registration).",
    config: {
      scope: "project",
      pathTemplate: ".cursor/mcp.json",
      serialization: "json",
      topLevelKey: "mcpServers",
      remoteUrlField: "url",
      extraFields: {},
    },
    evidenceUrl: "https://cursor.com/docs/mcp",
  },
  {
    id: "antigravity",
    displayName: "Google Antigravity",
    tier: "written",
    status: "documented-shape-only",
    finishInstruction: "Open the MCP Store or your MCP settings in Antigravity — it handles OAuth automatically for servers that support dynamic client registration (DCR).",
    config: {
      scope: "project",
      pathTemplate: ".agents/mcp_config.json",
      serialization: "json",
      topLevelKey: "mcpServers",
      remoteUrlField: "serverUrl",
      extraFields: {},
    },
    evidenceUrl: "https://antigravity.google/docs/ide/mcp/",
  },
  {
    id: "gemini-cli",
    displayName: "Gemini CLI",
    tier: "written",
    status: "documented-shape-only",
    finishInstruction: "Run `gemini mcp list`, or just start a session — the Gemini CLI supports OAuth 2.0 for remote MCP servers and negotiates it automatically.",
    config: {
      scope: "project",
      pathTemplate: ".gemini/settings.json",
      serialization: "json",
      topLevelKey: "mcpServers",
      remoteUrlField: "httpUrl",
      extraFields: {},
    },
    evidenceUrl: "https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html",
  },
  {
    id: "zed",
    displayName: "Zed",
    tier: "written",
    status: "documented-shape-only",
    finishInstruction: "Open Settings -> AI -> MCP Servers in Zed — when a remote server has no Authorization header configured, Zed prompts you to authenticate with the standard MCP OAuth flow.",
    config: {
      scope: "project",
      pathTemplate: ".zed/settings.json",
      serialization: "json",
      topLevelKey: "context_servers",
      remoteUrlField: "url",
      extraFields: {},
    },
    evidenceUrl: "https://zed.dev/docs/ai/mcp",
  },
  {
    id: "codex-cli",
    displayName: "OpenAI Codex CLI",
    tier: "written",
    status: "documented-shape-only",
    finishInstruction: "Run `codex mcp login {{SERVER_NAME}}` to finish sign-in in your browser.",
    config: {
      scope: "user",
      pathTemplate: ".codex/config.toml",
      serialization: "toml",
      topLevelKey: "mcp_servers",
      remoteUrlField: "url",
      extraFields: {},
    },
    evidenceUrl: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  },
  {
    id: "devin-desktop",
    displayName: "Devin Desktop",
    tier: "written",
    status: "documented-shape-only",
    finishInstruction: "Open Devin Desktop — it supports OAuth for each transport type and prompts you to connect the first time.",
    config: {
      scope: "user",
      pathTemplate: ".codeium/windsurf/mcp_config.json",
      serialization: "json",
      topLevelKey: "mcpServers",
      remoteUrlField: "serverUrl",
      extraFields: {},
    },
    evidenceUrl: "https://docs.devin.ai/desktop/cascade/mcp",
  },
  {
    id: "claude-desktop",
    displayName: "Claude Desktop",
    tier: "instructed",
    status: "verified",
    finishInstruction: "Claude Desktop connects to remote MCP servers through Connectors, configured from your Claude account rather than a local file — there is nothing for `rakomi connect` to write.\n\n1. Open Settings -> Connectors in Claude Desktop and add a custom connector.\n2. Enter Rakomi's MCP server URL: {{MCP_URL}}\n3. Click Connect. Claude Desktop opens your browser at accounts.rakomi.com — sign in and\n   approve the read-only consent screen.",
    evidenceUrl: "https://support.claude.com/en/articles/11175166-about-custom-connectors-remote-mcp",
  },
  {
    id: "chatgpt",
    displayName: "ChatGPT",
    tier: "instructed",
    status: "documented-shape-only",
    finishInstruction: "In ChatGPT, go to Workspace Settings -> Permissions & Roles -> Developer mode, then add {{MCP_URL}} as a remote server. ChatGPT starts an OAuth flow to your workspace's identity provider once it's added.",
    evidenceUrl: "https://developers.openai.com/api/docs/mcp",
  },
  {
    id: "jetbrains",
    displayName: "JetBrains AI Assistant",
    tier: "instructed",
    status: "documented-shape-only",
    finishInstruction: "In your JetBrains IDE, go to Settings -> Tools -> AI Assistant -> Model Context Protocol (MCP), click Add, and paste: {\"mcpServers\":{\"{{SERVER_NAME}}\":{\"url\":\"{{MCP_URL}}\"}}}\nJetBrains' own documentation does not state whether it drives OAuth for you — be ready to complete sign-in in whatever browser tab it opens.",
    evidenceUrl: "https://www.jetbrains.com/help/ai-assistant/mcp.html",
  },
];

export const KNOWN_CLIENTS: readonly KnownClient[] = CLIENT_REGISTRY.map((c) => c.id);
