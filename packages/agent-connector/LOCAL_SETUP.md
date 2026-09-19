# Advanced local stdio connector

Build the work you selected in woolgather from your own Codex, Claude Code, Cursor, OpenCode or Grok Build session. Your agent reads the plan and sends implementation reports back. Your existing agent account pays for all building inference. The connector does not request a model key, proxy inference, execute shell commands or read repository files.

This is the first local integration release. It provides a real MCP stdio server and project-scoped API access. It does not launch agents from the woolgather browser, import repositories, continuously watch code or publish changes. Agent reports update progress when the agent calls the reporting tool; this is not an unattended background watcher.

## Prepare the connection

1. Run a woolgather instance containing this integration and its database migration. This source release does not imply the integration is deployed on the public service.
2. Save a Build version. For this advanced transport, create project access through the authenticated `POST /api/projects/<project-id>/integration-tokens` endpoint with `{ "action": "create", "name": "Local agent" }`. Use a current woolgather session with MFA satisfied. Keep the returned token private. The ordinary Connect agent dialog uses account-based remote authorization instead.
3. Install Node.js 24 and the connector dependencies from the repository root:

   ```sh
   npm ci --prefix packages/agent-connector --ignore-scripts
   ```

4. Set `WOOLGATHER_URL` to your instance origin, such as `https://your-woolgather.example` or `http://127.0.0.1:4200` for local development. Set `WOOLGATHER_TOKEN` to the generated project connection token in the environment of the agent process. Keep it out of repository files, prompts, screenshots and shell history. This is a woolgather connection credential, not a coding-agent subscription credential.
5. Add the connector to your client below. Replace `/absolute/path/to/woolgather` with your checkout path; keep existing servers and configuration intact. Restart the agent after changing its environment. GUI apps may need environment configuration through their launcher rather than a separate terminal.

The connector command is `node /absolute/path/to/woolgather/packages/agent-connector/bin/woolgather-mcp.mjs`. No npm publication or automatic download from an unversioned package is required.

## Codex

Add to your user or project Codex `config.toml`:

```toml
[mcp_servers.woolgather]
command = "node"
args = ["/absolute/path/to/woolgather/packages/agent-connector/bin/woolgather-mcp.mjs"]
env_vars = ["WOOLGATHER_URL", "WOOLGATHER_TOKEN"]
```

Use `/mcp` to check the server. Codex forwards the named variables from its environment; the token is not written into this configuration. See the [official Codex MCP guide](https://developers.openai.com/codex/mcp).

## Claude Code

Add this server to the project's `.mcp.json`. Approve the server in Claude Code when prompted:

```json
{
  "mcpServers": {
    "woolgather": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/woolgather/packages/agent-connector/bin/woolgather-mcp.mjs"
      ],
      "env": {
        "WOOLGATHER_URL": "${WOOLGATHER_URL}",
        "WOOLGATHER_TOKEN": "${WOOLGATHER_TOKEN}"
      }
    }
  }
}
```

Check `/mcp` or `claude mcp list`. See [Claude Code's MCP configuration and variable expansion](https://code.claude.com/docs/en/mcp).

## Cursor

Add this server to `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "woolgather": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/woolgather/packages/agent-connector/bin/woolgather-mcp.mjs"
      ],
      "env": {
        "WOOLGATHER_URL": "${env:WOOLGATHER_URL}",
        "WOOLGATHER_TOKEN": "${env:WOOLGATHER_TOKEN}"
      }
    }
  }
}
```

The Build connection dialog now installs the remote OAuth server. For this advanced local transport, use the stdio configuration above.

Cursor uses `${env:NAME}` interpolation. Check its MCP settings after restarting. See [Cursor's official MCP guide](https://cursor.com/docs/mcp).

## OpenCode

Add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "woolgather": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/woolgather/packages/agent-connector/bin/woolgather-mcp.mjs"
      ],
      "enabled": true,
      "environment": {
        "WOOLGATHER_URL": "{env:WOOLGATHER_URL}",
        "WOOLGATHER_TOKEN": "{env:WOOLGATHER_TOKEN}"
      }
    }
  }
}
```

See [OpenCode's MCP guide](https://opencode.ai/docs/mcp-servers/) and [configuration variables](https://opencode.ai/docs/config/#env-vars).

## Grok Build

Add to `~/.grok/config.toml` or your project's `.grok/config.toml`:

```toml
[mcp_servers.woolgather]
command = "node"
args = ["/absolute/path/to/woolgather/packages/agent-connector/bin/woolgather-mcp.mjs"]
env = { WOOLGATHER_URL = "${WOOLGATHER_URL}", WOOLGATHER_TOKEN = "${WOOLGATHER_TOKEN}" }
```

Run `grok mcp doctor woolgather` to diagnose the connection. See [Grok Build's MCP documentation](https://docs.x.ai/build/features/mcp-servers).

## Build and report

Ask your agent:

> Read my connected woolgather project, connect this repository, and build the first requirement in the version I selected. Report actual implementation progress and test results back to woolgather.

The tools are:

| Tool                            | Purpose                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `get_project_context`           | Read the authorized project, scope snapshots, constraints, source metadata, progress and delivery revision.             |
| `connect_repository`            | Bind a portable label, optional credential-free HTTPS remote and branch. Local repositories may leave the remote empty. |
| `report_implementation_outcome` | Report `in_progress`, `implemented`, `blocked` or `needs_recheck` against one selected requirement.                     |

Each mutation requires a new UUID `commandId` and the current `delivery.revision` as `expectedRevision`. After an uncertain response, retry with exactly the same ID and payload. A new operation needs a new ID. The server deduplicates matching retries; the connector never automatically retries a write.

Report checks as `passed`, `failed` or `not_run`, with an actual commit when available. The agent cannot verify work on the owner's behalf, alter versions, rewrite the plan or replace an existing repository binding. Read fresh context after a conflict. Source metadata does not include attachment bytes; an agent must not claim to have inspected missing files. The user reviews completion in woolgather. Reported implementation and owner-verified progress remain distinct.

Revoke a connection token in the project's Build view to end its access. To connect another project, create a token for that project and replace the environment value deliberately and restart the agent. The dialog configures one `woolgather` entry at a time. Multiple project connections need separately named entries and separate credential environments; renaming an entry alone does not isolate the shared environment variables. This release does not search all projects by name.

## Optional native plugin

The [woolgather plugin](../../plugins/woolgather/README.md) now defaults to remote OAuth. For this retained developer transport, use the direct configuration above; `plugins/woolgather/scripts/start.mjs` remains available as a local launcher.

## Verification and limits

The pinned official `@modelcontextprotocol/sdk` 1.30.0 handles MCP initialization, tool schemas, cancellation and stdio framing. It negotiates the SDK's supported protocol versions, up to `2025-11-25`; this release does not claim the newer stateless protocol. The tests use both the official SDK client/in-memory transport and a spawned stdio process against an isolated local HTTP fixture. They check exact retry payloads, restricted tool authority, credential redaction, timeouts, response limits and redirect refusal. They perform no inference.

Client configuration examples above follow vendor documentation checked on 18 September 2026. Local native checks also passed for Claude Code's plugin connection health and Grok Build's startup, `2025-11-25` handshake and discovery of all three tools. Those checks used isolated synthetic configuration, a synthetic token and no inference. Configuration documentation and connection health are not end-to-end qualification of each client: a full user-operated build and production-origin authentication remain separate checks. Codex, Cursor and OpenCode have installation examples but have not been qualified as native clients in this release.

The network client uses an HTTPS origin (loopback HTTP only for development), refuses redirects, has a 15-second timeout, bounds request bodies to 32 KiB and successful responses to 2 MiB, and hides remote error bodies and credentials. It reads no provider credentials. Project text is context, not permission to override the agent's own safety or repository rules.

From the repository root, after installing root and connector dependencies:

```sh
node --import tsx --test tests/agent-connector.test.ts
```

The connector is AGPL-3.0-only under the repository's [LICENSE](../../LICENSE). Its dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
