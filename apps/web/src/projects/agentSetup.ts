export const codingAgents = [
  { value: "claude", label: "Claude Code", logo: "/brand/claude.svg" },
  { value: "codex", label: "Codex", logo: "/brand/openai.png" },
  { value: "cursor", label: "Cursor", logo: "/brand/cursor.svg" },
  { value: "other", label: "Other", logo: null },
] as const;
export type CodingAgent = (typeof codingAgents)[number]["value"];
export type SetupFormat = CodingAgent | "opencode" | "grok";

export function validConnectorFolder(folder: string) {
  return (
    /^(\/|[a-z]:[\\/])/i.test(folder.trim()) &&
    !/[\u0000-\u001f\u007f]/.test(folder)
  );
}

/** Configuration contains environment references only, never a project credential. */
export function agentSetup(
  agent: SetupFormat,
  folder = "",
  name = "woolgather",
) {
  const root = validConnectorFolder(folder)
    ? folder.trim().replace(/[\\/]+$/, "")
    : "/absolute/path/to/woolgather";
  const connector = `${root}/packages/agent-connector/bin/woolgather-mcp.mjs`;
  const variable = (key: string) =>
    agent === "cursor" ? `\${env:${key}}` : `\${${key}}`;
  const server = {
    command: "node",
    args: [connector],
    env: {
      WOOLGATHER_URL: variable("WOOLGATHER_URL"),
      WOOLGATHER_TOKEN: variable("WOOLGATHER_TOKEN"),
    },
  };
  const configuration =
    agent === "codex"
      ? `[mcp_servers.${JSON.stringify(name)}]\ncommand = "node"\nargs = ${JSON.stringify([connector])}\nenv_vars = ["WOOLGATHER_URL", "WOOLGATHER_TOKEN"]`
      : agent === "grok"
        ? `[mcp_servers.${JSON.stringify(name)}]\ncommand = "node"\nargs = ${JSON.stringify([connector])}\nenv = { WOOLGATHER_URL = "\${WOOLGATHER_URL}", WOOLGATHER_TOKEN = "\${WOOLGATHER_TOKEN}" }`
        : JSON.stringify(
            agent === "opencode"
              ? {
                  $schema: "https://opencode.ai/config.json",
                  mcp: {
                    [name]: {
                      type: "local",
                      command: ["node", connector],
                      enabled: true,
                      environment: {
                        WOOLGATHER_URL: "{env:WOOLGATHER_URL}",
                        WOOLGATHER_TOKEN: "{env:WOOLGATHER_TOKEN}",
                      },
                    },
                  },
                }
              : { mcpServers: { [name]: server } },
            null,
            2,
          );
  return {
    file:
      agent === "codex"
        ? "~/.codex/config.toml"
        : agent === "grok"
          ? "~/.grok/config.toml"
          : agent === "opencode"
            ? "opencode.json"
            : agent === "cursor"
              ? "~/.cursor/mcp.json"
              : agent === "claude"
                ? ".mcp.json"
                : "your agent’s MCP settings",
    configuration,
    server,
  };
}

/** Cursor's official installer accepts one server definition, not the config file. */
export function cursorInstallUrl(folder: string, name: string) {
  if (!validConnectorFolder(folder)) return null;
  const payload = JSON.stringify(agentSetup("cursor", folder, name).server);
  const encoded = btoa(
    Array.from(new TextEncoder().encode(payload), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(encoded)}`;
}

export function claudeSetupCommand(folder: string, name: string) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `claude mcp add-json --scope user ${quote(name)} ${quote(JSON.stringify(agentSetup("claude", folder, name).server))}`;
}
