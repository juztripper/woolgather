# woolgather native plugin

This development plugin gives coding agents a workflow for building selected woolgather requirements and reporting evidence. It supplies Codex and Claude Code manifests, a shared skill and a launcher for the [agent connector](../../packages/agent-connector/README.md). Building and inference use the user's existing agent and account.

Install the connector dependencies and configure `WOOLGATHER_URL` and `WOOLGATHER_TOKEN` using the connector guide. Also set `WOOLGATHER_CONNECTOR_PATH` in the agent environment to the absolute path of `packages/agent-connector/bin/woolgather-mcp.mjs`. The launcher uses that installed file, so a copied plugin does not depend on its cache directory being next to the repository.

The source contains:

- `.codex-plugin/plugin.json` and `.mcp.json`: Codex manifest and stdio configuration. Its launcher is executable on macOS/Linux; use the direct `node` configuration in the connector guide on other platforms.
- `.claude-plugin/plugin.json`: Claude Code manifest with its own plugin-root-aware stdio configuration.
- `skills/connected-building/SKILL.md`: context, scope selection, evidence and reliable retry workflow.
- `scripts/start.mjs`: credential-safe launcher. No model client or provider keys are involved.

For local Claude Code plugin development, start it with:

```sh
claude --plugin-dir /absolute/path/to/woolgather/plugins/woolgather
```

For Codex, use the direct MCP configuration in the connector guide until installing this source through a configured plugin marketplace. No marketplace or user configuration is changed by this repository. No package or plugin has been published. Native plugin metadata does not mean every vendor's installation flow has been qualified.

Do not enable both the direct MCP entry and plugin entry for the same connection unless you intentionally want duplicate tool namespaces. Restart your client after configuration changes. Agent reports occur when the agent invokes the tool; the plugin does not monitor code or run builds in the background.

License: AGPL-3.0-only; see the repository [LICENSE](../../LICENSE). Connector dependencies and notices live in the connector package.
