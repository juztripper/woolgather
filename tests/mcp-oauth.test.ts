import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { planningTestDatabase } from "../scripts/planning-test-database";
import { remoteAgentSetup } from "../apps/web/src/projects/agentSetup";
import {
  rememberMcpReturn,
  consumeMcpReturn,
  mcpReturnPath,
} from "../apps/web/src/account/mcpReturn";
import { mcpOrigin } from "../apps/api/src/mcpAuthorization";

const origin = "https://woolgather.example";
test("remote configuration contains only a canonical address and OAuth return paths stay local", () => {
  const cursor = remoteAgentSetup("cursor", `${origin}/mcp`);
  const config = JSON.parse(
    Buffer.from(
      new URL(cursor.installUrl!).searchParams.get("config")!,
      "base64",
    ).toString(),
  );
  assert.deepEqual(config, { url: `${origin}/mcp` });
  assert.equal(
    JSON.parse(remoteAgentSetup("claude", `${origin}/mcp`).configuration)
      .mcpServers.woolgather.type,
    "http",
  );
  assert.match(
    remoteAgentSetup("codex", `${origin}/mcp`).command!,
    /codex mcp login woolgather/,
  );
  for (const url of [
    "https://user:secret@example.com/mcp",
    "http://public.example/mcp",
    `${origin}/mcp?token=secret`,
    `${origin}/bad`,
  ])
    assert.throws(() => remoteAgentSetup("other", url));
  assert.equal(
    mcpOrigin({ MCP_ENABLED: "true", MCP_ORIGIN: "http://public.example" }),
    null,
  );
  assert.equal(mcpOrigin({ MCP_ENABLED: "false", MCP_ORIGIN: origin }), null);
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
    removeItem: (key: string) => {
      saved.delete(key);
    },
  };
  const id = crypto.randomUUID();
  rememberMcpReturn(
    new URL(`${origin}/connect/authorize?request=${id}`),
    storage,
  );
  assert.equal(consumeMcpReturn(storage), `/connect/authorize?request=${id}`);
  assert.equal(consumeMcpReturn(storage), null);
  assert.equal(mcpReturnPath("https://attacker.example"), null);
  storage.setItem(
    "woolgather:mcp-return",
    JSON.stringify({ id, expiresAt: Date.now() - 1 }),
  );
  assert.equal(consumeMcpReturn(storage), null);
});

test(
  "remote OAuth uses PKCE, browser-bound consent, real project permissions, revocation and the shared MCP contract",
  { timeout: 120000 },
  async (t) => {
    const db = await planningTestDatabase(55542);
    t.after(() => db.close());
    const project = await db.createProject(
      "Synthetic OAuth plan",
      "OAuth review",
    );
    const thoughtId = crypto.randomUUID(),
      scopeId = crypto.randomUUID(),
      requirementId = crypto.randomUUID();
    const thought = await db.rpc("execute_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        expectedRevision: project.revision,
        action: {
          type: "add_item",
          itemId: thoughtId,
          item: {
            title: "Save a draft",
            body: "A draft survives reopening",
            category: "feature",
            certainty: "confirmed",
            status: "open",
            answer: "",
            links: [],
          },
        },
      },
    });
    assert.equal(thought.error, null);
    const anotherOwner = crypto.randomUUID();
    await db.sql`insert into auth.users(id) values(${anotherOwner})`;
    await db.sql`insert into auth.sessions(id,user_id) values(${anotherOwner},${anotherOwner})`;
    const bundled = await build({
      entryPoints: ["apps/api/src/worker.ts"],
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "browser"],
      external: ["cloudflare:*", "node:*"],
      write: false,
    });
    let accountAccess = "ok";
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundled.outputFiles[0].text,
        compatibilityDate: "2026-09-06",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["OAUTH_KV"],
        durableObjects: {
          MCP_CONSENTS: { className: "McpConsentState", useSQLite: true },
          PROJECT_VOICE_SESSIONS: {
            className: "ProjectVoiceSession",
            useSQLite: true,
          },
        },
        ratelimits: {
          MCP_AUTH_LIMITER: {
            namespace_id: "1001",
            simple: { limit: 60, period: 60 },
          },
        },
        bindings: {
          MCP_ENABLED: "true",
          MCP_ORIGIN: origin,
          SUPABASE_URL: "https://auth.fixture.invalid",
          SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
          ACCOUNT_ACTION_SECRET: db.secret,
        },
        serviceBindings: {
          ASSETS: () =>
            new Response("<html>fixture</html>", {
              headers: { "Content-Type": "text/html" },
            }),
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          assert.equal(
            url.origin,
            "https://auth.fixture.invalid",
            "Unexpected outbound request (no inference permitted)",
          );
          const auth = request.headers.get("Authorization");
          const who =
            auth === "Bearer owner-session"
              ? db.owner
              : auth === "Bearer other-session"
                ? anotherOwner
                : null;
          if (url.pathname === "/auth/v1/user")
            return who
              ? Response.json({
                  id: who,
                  email: "synthetic@example.com",
                  is_anonymous: false,
                  aud: "authenticated",
                })
              : Response.json({ error: "invalid JWT" }, { status: 401 });
          if (url.pathname === "/rest/v1/rpc/account_access")
            return Response.json(accountAccess);
          assert.equal(url.pathname, "/rest/v1/rpc/project_delivery_exchange");
          const args = (await request.json()) as {
            payload: string;
            signature: string;
          };
          try {
            const data = await db.sql.begin(async (tx) => {
              if (who) {
                await tx`set local role authenticated`;
                await tx`select set_config('request.jwt.claim.sub',${who},true)`;
                await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: who, aal: "aal1" })},true)`;
              } else await tx`set local role anon`;
              return (
                await tx`select public.project_delivery_exchange(${args.payload},${args.signature}) d`
              )[0].d;
            });
            return Response.json(data);
          } catch (error) {
            return Response.json(
              {
                code: (error as { code: string }).code,
                message: (error as Error).message,
              },
              { status: 400 },
            );
          }
        },
      }),
    );
    t.after(() => runtime.dispose());
    const call = (
      path: string,
      init?: Parameters<Miniflare["dispatchFetch"]>[1],
    ) => runtime.dispatchFetch(`${origin}${path}`, init);
    const payload = (body: unknown, extra: Record<string, string> = {}) => ({
      method: "POST",
      headers: { "Content-Type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
    const challenge = await call("/mcp");
    assert.equal(challenge.status, 401);
    assert.match(
      challenge.headers.get("www-authenticate")!,
      /oauth-protected-resource/,
    );
    const metadata = (await (
      await call("/.well-known/oauth-protected-resource/mcp")
    ).json()) as { resource: string };
    assert.equal(metadata.resource, `${origin}/mcp`);
    const page = await call("/connect/authorize");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    const registration = await call(
      "/oauth/register",
      payload({
        client_name: "Synthetic Codex",
        redirect_uris: ["http://127.0.0.1:34567/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    );
    assert.equal(registration.status, 201, await registration.clone().text());
    const { client_id } = (await registration.json()) as { client_id: string };
    const verifier = "a".repeat(64);
    const params = new URLSearchParams({
      client_id,
      redirect_uri: "http://127.0.0.1:34567/callback",
      response_type: "code",
      scope: "project:build",
      state: "synthetic-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
    });
    const start = async () => {
      const response = await call(`/oauth/authorize?${params}`, {
        redirect: "manual",
      });
      assert.equal(response.status, 302, await response.clone().text());
      const cookie = response.headers.get("set-cookie")!.split(";")[0];
      const id = new URL(response.headers.get("location")!).searchParams.get(
        "request",
      )!;
      return { path: `/api/mcp/authorization?request=${id}`, cookie, id };
    };
    const bad = new URLSearchParams(params);
    bad.set("redirect_uri", "https://attacker.example/callback");
    assert.equal(
      (await call(`/oauth/authorize?${bad}`, { redirect: "manual" })).status,
      400,
    );
    bad.set("redirect_uri", params.get("redirect_uri")!);
    bad.set("code_challenge_method", "plain");
    assert.equal(
      (await call(`/oauth/authorize?${bad}`, { redirect: "manual" })).status,
      400,
    );
    bad.set("code_challenge_method", "S256");
    bad.set("resource", "https://attacker.example/mcp");
    assert.equal(
      (await call(`/oauth/authorize?${bad}`, { redirect: "manual" })).status,
      400,
    );
    const ticket = await start();
    const owner = {
      Authorization: "Bearer owner-session",
      Cookie: ticket.cookie,
      Origin: origin,
    };
    assert.equal((await call(ticket.path)).status, 401);
    assert.equal(
      (
        await call(ticket.path, {
          headers: { Authorization: owner.Authorization },
        })
      ).status,
      403,
    );
    assert.equal((await call(ticket.path, { headers: owner })).status, 200);
    assert.equal(
      (
        await call(
          ticket.path,
          payload(
            { decision: "allow", projectId: project.id },
            { ...owner, Origin: "https://attacker.example" },
          ),
        )
      ).status,
      403,
    );
    accountAccess = "mfa_required";
    assert.equal(
      (
        await call(
          ticket.path,
          payload({ decision: "allow", projectId: project.id }, owner),
        )
      ).status,
      403,
    );
    accountAccess = "ok";
    const scope = await call(
      "/api/project-delivery",
      payload(
        {
          id: crypto.randomUUID(),
          projectId: project.id,
          expectedRevision: 0,
          action: {
            type: "create_scope",
            scopeId,
            name: "First version",
            lane: "now",
            requirements: [
              {
                id: requirementId,
                thoughtId,
                criterion: "A saved draft survives reopening",
              },
            ],
          },
        },
        owner,
      ),
    );
    assert.equal(scope.status, 200, await scope.clone().text());
    assert.equal(
      (
        await call(
          ticket.path,
          payload(
            { decision: "allow", projectId: project.id },
            { ...owner, Authorization: "Bearer other-session" },
          ),
        )
      ).status,
      404,
    );
    const approvals = await Promise.all([
      call(
        ticket.path,
        payload({ decision: "allow", projectId: project.id }, owner),
      ),
      call(
        ticket.path,
        payload({ decision: "allow", projectId: project.id }, owner),
      ),
    ]);
    assert.deepEqual(approvals.map((value) => value.status).sort(), [200, 410]);
    const approved = (await approvals
      .find((value) => value.status === 200)!
      .json()) as { redirectTo: string };
    assert.equal(JSON.stringify(approved).includes("wg_"), false);
    const callback = new URL(approved.redirectTo);
    assert.equal(callback.searchParams.get("state"), "synthetic-state");
    const exchange = new URLSearchParams({
      grant_type: "authorization_code",
      client_id,
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: params.get("redirect_uri")!,
      resource: `${origin}/mcp`,
    });
    const tokenCall = (body: URLSearchParams) =>
      call("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    const wrong = new URLSearchParams(exchange);
    wrong.set("code_verifier", "b".repeat(64));
    assert.equal((await tokenCall(wrong)).status, 400);
    const exchanged = await tokenCall(exchange);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const tokens = (await exchanged.json()) as {
      access_token: string;
      refresh_token: string;
    };
    assert.ok(tokens.refresh_token);
    assert.equal(
      (
        await call("/api/projects", {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
      401,
      "MCP token must not act as the account session",
    );
    const agentHeaders = {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    };
    const rpc = async (method: string, args: unknown = {}) => {
      const response = await call(
        "/mcp",
        payload({ jsonrpc: "2.0", id: 1, method, params: args }, agentHeaders),
      );
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as {
        result: {
          tools: { name: string }[];
          structuredContent: {
            project: { id: string };
            delivery: { revision: number };
          };
          isError?: boolean;
        };
        error?: unknown;
      };
    };
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "synthetic", version: "1" },
    });
    const tools = await rpc("tools/list");
    assert.deepEqual(tools.result.tools.map((tool) => tool.name).sort(), [
      "connect_repository",
      "get_project_context",
      "report_implementation_outcome",
    ]);
    const context = await rpc("tools/call", {
      name: "get_project_context",
      arguments: {},
    });
    assert.equal(context.result.isError, undefined, JSON.stringify(context));
    assert.equal(context.result.structuredContent.project.id, project.id);
    assert.equal(JSON.stringify(context).includes("wg_"), false);
    const connected = await rpc("tools/call", {
      name: "connect_repository",
      arguments: {
        commandId: crypto.randomUUID(),
        expectedRevision: 1,
        label: "Synthetic repo",
        remoteUrl: "",
        branch: "main",
      },
    });
    assert.equal(connected.result.isError, undefined);
    const reportArgs = {
      commandId: crypto.randomUUID(),
      expectedRevision: 2,
      scopeId,
      requirementId,
      state: "implemented",
      summary: "Synthetic implementation evidence",
      commit: "abcdef1",
      checks: [{ command: "npm test", result: "passed" }],
    };
    const report = await rpc("tools/call", {
      name: "report_implementation_outcome",
      arguments: reportArgs,
    });
    assert.equal(report.result.isError, undefined, JSON.stringify(report));
    const replay = await rpc("tools/call", {
      name: "report_implementation_outcome",
      arguments: reportArgs,
    });
    assert.deepEqual(
      replay.result,
      report.result,
      "Network retry must preserve one report",
    );
    const ownerDelivery = (await (
      await call(`/api/projects/${project.id}/delivery`, { headers: owner })
    ).json()) as { revision: number; reports: unknown[]; reviews: unknown[] };
    assert.equal(ownerDelivery.revision, 3);
    assert.equal(ownerDelivery.reports.length, 1);
    assert.equal(
      ownerDelivery.reviews.length,
      0,
      "An agent report never verifies itself",
    );
    assert.equal(
      (
        await call(
          "/mcp",
          payload(
            { jsonrpc: "2.0", id: 1, method: "tools/list" },
            { ...agentHeaders, Origin: "https://attacker.example" },
          ),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/mcp", {
          method: "POST",
          headers: agentHeaders,
          body: "x".repeat(128001),
        })
      ).status,
      413,
    );
    const refreshed = await tokenCall(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id,
        refresh_token: tokens.refresh_token,
        resource: `${origin}/mcp`,
      }),
    );
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const fresh = (await refreshed.json()) as { access_token: string };
    const listed = (await (
      await call(`/api/projects/${project.id}/integration-tokens`, {
        headers: owner,
      })
    ).json()) as { id: string }[];
    assert.equal(listed.length, 1);
    assert.equal(
      (
        await call(
          `/api/projects/${project.id}/integration-tokens`,
          payload({ action: "revoke", tokenId: listed[0].id }, owner),
        )
      ).status,
      200,
    );
    for (const token of [tokens.access_token, fresh.access_token])
      assert.equal(
        (await call("/mcp", { headers: { Authorization: `Bearer ${token}` } }))
          .status,
        401,
      );
    assert.equal((await tokenCall(exchange)).status, 400);
    const denied = await start();
    const denial = await call(
      denied.path,
      payload({ decision: "deny" }, { ...owner, Cookie: denied.cookie }),
    );
    assert.equal(denial.status, 200);
    assert.equal(
      new URL(
        ((await denial.json()) as { redirectTo: string }).redirectTo,
      ).searchParams.get("error"),
      "access_denied",
    );
    assert.equal(
      (
        await db.sql`select count(*)::int n from delivery_private.tokens where owner_id=${db.owner}`
      )[0].n,
      1,
      "Cancel must not create access",
    );
  },
);
