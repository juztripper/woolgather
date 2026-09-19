# woolgather native plugin

The Codex and Claude Code packages now use the remote woolgather MCP server and account authorization. Users sign in with their existing woolgather account, choose a project and approve access. Building and inference run on the user's own agent account.

The manifests target `https://woolgathering.app/mcp`. This source update does not activate that public endpoint or publish a marketplace package. For a self-hosted or development instance, change the URL in `.mcp.json` and `.claude-plugin/plugin.json` to the instance's configured MCP address, or use the [direct connection instructions](../../packages/agent-connector/README.md). There is no local connector path or token environment variable in the default plugin setup.

The source contains:

- `.codex-plugin/plugin.json` and `.mcp.json`: Codex metadata and remote HTTP connection.
- `.claude-plugin/plugin.json`: Claude Code metadata and remote HTTP connection.
- `skills/connected-building/SKILL.md`: scope selection, evidence and reliable retry workflow.
- `scripts/start.mjs`: retained advanced local launcher, unused by the default manifests.

For local Claude Code package testing:

```sh
claude --plugin-dir /absolute/path/to/woolgather/plugins/woolgather
```

Use direct MCP configuration in Codex until installing through a configured marketplace. No marketplace, agent configuration or user account is changed by this repository. Native metadata validation is separate from actual client qualification; see the [qualification matrix](../../packages/agent-connector/RELEASE.md). Avoid enabling both a direct MCP entry and a plugin entry for the same connection unless you intend duplicate namespaces.

Agents report progress when they invoke the tool. The plugin does not monitor code or run builds in the background. Project selection, owner verification, revocation and expiry follow the shared connector contract.

License: AGPL-3.0-only; see the repository [LICENSE](../../LICENSE).
