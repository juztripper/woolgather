# Connect your coding agent to woolgather

Build from your woolgather plan in your own Codex, Claude Code, Cursor or another compatible MCP client. Coding and inference use your existing agent account. woolgather shares the selected project and receives implementation reports; it does not run or pay for building inference.

## Connect with your account

1. Open **Build → Connect agent** and choose your agent.
2. Add the displayed MCP server address. Cursor also offers **Add to Cursor**, which opens its installation review.
3. Choose **Sign in** or **Authenticate** in your agent. In the browser, sign in with your existing woolgather account, select a project and choose **Allow access**. Existing sessions and MFA are respected.
4. Return to your agent and ask it to read the project, connect the repository and build the version or requirement you choose.

There is no connector installation, local woolgather folder or manual token in this flow. Access is limited to one approved project for 30 days, with access tokens refreshed automatically within that period. Reconnect to renew or choose a different project. **Build → Connect agent → Project access** lists and revokes access, including older local connections. Revocation blocks subsequent MCP requests even if the client still has a cached OAuth token.

This source implementation is disabled by default until the instance operator configures it. It does not imply public-service activation, marketplace publication or native-client qualification. The dialog reports when account connections are unavailable.

## Client setup

Use the address shown by your own woolgather instance; `https://your-woolgather.example/mcp` below is an example.

**Codex:** add the remote server in MCP settings, or run:

```sh
codex mcp add woolgather --url https://your-woolgather.example/mcp
codex mcp login woolgather
```

Equivalent configuration:

```toml
[mcp_servers.woolgather]
url = "https://your-woolgather.example/mcp"
```

**Claude Code:** add the HTTP server, then use `/mcp` to authenticate:

```sh
claude mcp add --transport http --scope user woolgather https://your-woolgather.example/mcp
```

**Cursor:** use the dialog's installer or add this server to your MCP configuration, preserving existing entries:

```json
{
  "mcpServers": {
    "woolgather": { "url": "https://your-woolgather.example/mcp" }
  }
}
```

**Other agents:** add a remote Streamable HTTP MCP server with OAuth, S256 PKCE and dynamic client registration support. Client-specific configuration formats differ. Protocol support alone does not establish compatibility with every version or execution surface. This release uses the MCP SDK's 2025-11-25 protocol in stateless HTTP mode; it does not implement the newer stateless protocol.

Official references: [Codex](https://developers.openai.com/codex/mcp), [Claude Code](https://code.claude.com/docs/en/mcp), [Cursor install links](https://cursor.com/docs/mcp/install-links), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## What the agent can do

The local and remote transports use the same tools:

- `get_project_context`: read the approved project, selected versions, requirements, revisions and evidence.
- `connect_repository`: save a portable repository label, credential-free HTTPS remote and branch.
- `report_implementation_outcome`: report work and checks against a frozen requirement.

Agents cannot change the selected scope or mark their own work owner-verified. Saved text is project data, not privileged instructions. Use the exact same command ID and payload when retrying an uncertain result. Progress updates when the agent reports evidence; this is not a background code watcher. Direct browser-to-agent dispatch, imports and attachment-byte retrieval remain separate work.

## Operator configuration

The existing Worker now serves `/mcp`, OAuth discovery, `/oauth/authorize`, `/oauth/register` and `/oauth/token`. It reuses woolgather's account sign-in to approve access and issues separate opaque OAuth credentials. Supabase session credentials never reach the coding agent.

1. Keep the existing database migrations, publishable Supabase configuration and `ACCOUNT_ACTION_SECRET` configured. The `20260918145244_connected_building.sql` migration is required; OAuth itself does not require a separate Supabase OAuth-server feature.
2. Bind a dedicated `OAUTH_KV` namespace and the `MCP_CONSENTS` SQLite Durable Object, with the `mcp-consent-v1` migration in `wrangler.jsonc`. Both `MCP_AUTH_LIMITER` and `MCP_API_LIMITER` bindings are required. Wrangler can provision the KV binding at an authorized deployment; bind an explicit existing namespace ID when managing infrastructure separately.
3. Set `MCP_ORIGIN` to the exact canonical woolgather origin, without a path. Set `MCP_ENABLED=true` only after qualifying that origin. HTTPS is required except for loopback local development.
4. Retain the configured Worker-first routes and authorization-page security headers. Keep the regular Supabase sign-in callback on the same origin; the application resumes the pending approval after sign-in.
5. Qualify account sign-in/MFA, consent, cancel, token refresh, revocation and an actual native-client read/report on the hosted origin before release. The isolated review on port 4300 is a UI fixture, not a running OAuth endpoint.

Pending approvals expire after 15 minutes and require the initiating browser. A Durable Object atomically claims each approval. Access tokens last one hour; OAuth grants and backing project access are bounded to 30 days. OAuth endpoints are limited to 60 requests per minute, and MCP/legacy integration requests to 120 per minute, per connecting IP per Cloudflare location. A limited request returns `429` with `Retry-After: 60`. This is a basic admission limit, not a substitute for deployment-specific abuse monitoring.

Backing project tokens remain hash-only in PostgreSQL; their server-side secret is held in encrypted OAuth grant properties. Project access is checked on every MCP request, including tool discovery. Account deletion, project lifecycle and revocation retain the existing database enforcement. No service-role key or agent-provider credential is required. These requests incur ordinary hosting/auth/storage usage, not model inference.

## Local verification and advanced transport

`npm test` runs real workerd OAuth/PKCE/consent/refresh and MCP requests against disposable PostgreSQL, using synthetic account-auth responses. It checks browser binding, duplicate consent, wrong-project denial, MFA gating, session isolation, shared tools and revocation. No provider call or real account is used. Browser fixture review and native-client/hosted qualification are separate evidence.

The optional [native plugin](../../plugins/woolgather/README.md) adds the building workflow. The retained [advanced local stdio setup](LOCAL_SETUP.md) is for developer installations that intentionally use project tokens. It is no longer the ordinary connection flow.

## Release qualification

See [the release runbook](RELEASE.md) for native-client evidence, deployment checks, rollout and rollback. `npm run check:mcp -- https://your-woolgather.example` checks the actual origin without signing in or changing data.
