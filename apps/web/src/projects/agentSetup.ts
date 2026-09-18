export const codingAgents = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
  { value: "cursor", label: "Cursor" },
  { value: "opencode", label: "OpenCode" },
  { value: "grok", label: "Grok Build" },
] as const;
export type CodingAgent = (typeof codingAgents)[number]["value"];

const connector =
  "/absolute/path/to/woolgather/packages/agent-connector/bin/woolgather-mcp.mjs";

/** Mirrors the public connector guide. Never embeds a project credential. */
export function agentSetup(agent: CodingAgent) {
  if (agent === "codex")
    return {
      file: "~/.codex/config.toml",
      configuration: `[mcp_servers.woolgather]\ncommand = "node"\nargs = ["${connector}"]\nenv_vars = ["WOOLGATHER_URL", "WOOLGATHER_TOKEN"]`,
    };
  if (agent === "grok")
    return {
      file: "~/.grok/config.toml",
      configuration: `[mcp_servers.woolgather]\ncommand = "node"\nargs = ["${connector}"]\nenv = { WOOLGATHER_URL = "\${WOOLGATHER_URL}", WOOLGATHER_TOKEN = "\${WOOLGATHER_TOKEN}" }`,
    };
  if (agent === "opencode")
    return {
      file: "opencode.json",
      configuration: JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            woolgather: {
              type: "local",
              command: ["node", connector],
              enabled: true,
              environment: {
                WOOLGATHER_URL: "{env:WOOLGATHER_URL}",
                WOOLGATHER_TOKEN: "{env:WOOLGATHER_TOKEN}",
              },
            },
          },
        },
        null,
        2,
      ),
    };
  const variable = (name: string) =>
    agent === "cursor" ? `\${env:${name}}` : `\${${name}}`;
  return {
    file: agent === "cursor" ? "~/.cursor/mcp.json" : ".mcp.json",
    configuration: JSON.stringify(
      {
        mcpServers: {
          woolgather: {
            type: "stdio",
            command: "node",
            args: [connector],
            env: {
              WOOLGATHER_URL: variable("WOOLGATHER_URL"),
              WOOLGATHER_TOKEN: variable("WOOLGATHER_TOKEN"),
            },
          },
        },
      },
      null,
      2,
    ),
  };
}
