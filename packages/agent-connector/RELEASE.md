# Connected-building release runbook

## Qualification boundary

The release covers selected versions, frozen acceptance criteria, repository binding, account-based MCP access, agent-reported evidence and owner verification. Coding runs in the user's agent account. Imports, automatic code watching and browser-to-agent dispatch are outside this release.

Local qualification on 2026-09-19:

| Client / surface               | Evidence                                                                                                                                                    | Remaining release check                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Codex CLI 0.154.0 / app-server | Native OAuth, three-tool discovery, project read, repository binding, outcome report, exact retry and revocation pass against disposable workerd/PostgreSQL | Repeat against the configured HTTPS release origin with a dedicated QA account |
| Claude Code 2.1.251            | Native OAuth and authenticated MCP connection pass against disposable workerd/PostgreSQL                                                                    | Native tool execution and hosted-origin account flow                           |
| Cursor 3.19.13 desktop         | Configuration and installation-link generation covered; native qualification pending                                                                        | OAuth, tool discovery, read/report and revocation on the release origin        |
| Other MCP clients              | SDK protocol tests pass for Streamable HTTP 2025-11-25, OAuth authorization code, S256 PKCE and dynamic registration                                        | Qualify each named client and execution surface before claiming support        |

Native tests use synthetic consent/account authentication and request no model inference. They do not qualify Supabase password/social sign-in, MFA or public-origin redirects. Metadata validation is not native plugin installation evidence. The same tools serve the local and remote transports.

## Reproducible checks

Run the normal source checks from the repository root:

```sh
npm ci
npm ci --prefix packages/agent-connector --ignore-scripts
npm test
npm run build
npm run check:format
npm run deploy:check
npm audit --omit=dev
```

Optional installed-client checks (PostgreSQL tools required):

```sh
npm run check:mcp:codex
npm run check:mcp:claude
```

Run those sequentially; both reserve ports 4261 and 55543. The Codex check uses an isolated temporary `CODEX_HOME`; Claude uses a temporary `CLAUDE_CONFIG_DIR` and Python 3 for its interactive OAuth terminal. Neither reads application secrets or submits a model turn. Temporary PostgreSQL data and profiles are removed afterward. Claude authentication is cleared through its own CLI.

The OAuth regression suite covers PKCE, audience/redirect validation, browser binding, MFA and ownership, concurrent approvals, recovery of a lost approval response, shared tools, retries, project lifecycle, refresh, revocation, origin/body limits and traffic admission. A recovered approval returns the original callback only to the same authenticated owner, browser and decision; it never creates another grant.

## Prepare the deployment

1. Verify the intended source revision includes the current production changes. Build from that revision and retain its commit and bundle checksum.
2. Confirm `public.project_delivery_exchange(text,text)` exists and the three `delivery_private` tables have RLS enabled with no direct table grants to `anon`/`authenticated`. Apply the connected-building migration through the operator's normal migration process if absent. Do not replay it over an existing schema or erase migration history.
3. Prepare a private release configuration using the built Worker. Preserve live non-MCP variables, routes, secrets, scheduled triggers and existing Durable Object migrations. The generic checked-in configuration deliberately disables commercial/planning features and must not overwrite a live installation's settings accidentally.
4. Add a dedicated `OAUTH_KV`, the `MCP_CONSENTS` SQLite Durable Object and `mcp-consent-v1` migration, plus both MCP rate limit bindings from `wrangler.jsonc`. Preserve Worker-first `/api/*`, `/mcp`, `/mcp/*`, `/oauth/*`, `/connect/authorize` and `/.well-known/oauth-*` routing.
5. Set `MCP_ORIGIN` to the exact HTTPS origin and enable MCP in that release configuration. Keep the ordinary Supabase account callback on that origin. Confirm `ACCOUNT_ACTION_SECRET` agrees with the database without printing either value. Keep query-string redaction enabled in Worker observability; never log cookies, OAuth URLs, codes, tokens, request bodies or project content.
6. Perform a deployment dry run using the prepared configuration. Record the current deployed version and the intended rollback procedure before authorizing rollout.

## Verify the released origin

```sh
npm run check:mcp -- https://your-woolgather.example
```

This read-only check verifies canonical discovery, the unauthenticated challenge and consent security headers. It fails for a disabled or UI-only preview installation. It does not prove authenticated tools or database access.

Using a dedicated QA account/project, complete password/social sign-in as enabled, MFA when required, project selection, cancel, approval and return to the actual native client. Exercise a small selected version: read context, connect the test repository, report implementation, retry the exact report, reload Build and verify only one report exists. Agent evidence must remain unverified until the owner reviews it. Confirm changed plan meaning requires rechecking. Reopen the client, refresh credentials, revoke the connection in Project access and verify further calls fail. Reconnect and confirm an unrelated project remains inaccessible. Never run synthetic changes against a customer's project.

Do not advertise a client as fully qualified before its row above has the required evidence. Public activation, merge/push and marketplace publication are separate actions.

## Operate and recover

- OAuth admission is 60 requests/minute/IP; MCP and legacy integration admission is 120/minute/IP, per Cloudflare location. `429` responses carry `Retry-After: 60`; clients preserve mutation IDs/payloads when retrying. Monitor unexpected growth in 429/5xx responses and hosting usage without collecting credentials or plan contents.
- Backing project access is checked on every resource request. Access tokens last one hour and grants/backing access are bounded to 30 days. Revocation prevents further MCP operations, including after OAuth refresh. A refresh can still issue an unusable token after backing access is revoked; the next resource call rejects it.
- Pending consent and its recoverable callback expire after 15 minutes. If completion was interrupted before a callback was stored, start again and inspect Project access for an unused connection. Revocation remains available.
- For an incident, disable MCP and redeploy the same compatible Worker with its bindings/migrations preserved. This stops remote OAuth/MCP access; revoke affected project connections as needed. Legacy manually issued integration tokens remain a separate access path.
- Do not delete OAuth KV, Durable Objects or delivery tables to roll back. Keep the additive storage and saved plans/evidence intact. Rolling all the way back to a version predating a Durable Object migration needs a Cloudflare-compatible rollback plan; disabling the feature in the current version is the first recovery action.
- Do not increase inference budgets or enable unrelated billing/voice/planning flags as part of MCP release or recovery.
