import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Miniflare } from "miniflare";
import { mcpTestRuntime } from "../scripts/mcp-test-runtime";
import { planningTestDatabase } from "../scripts/planning-test-database";
import { remoteAgentSetup } from "../apps/web/src/projects/agentSetup";
import {
  rememberMcpReturn,
  consumeMcpReturn,
  mcpReturnPath,
} from "../apps/web/src/account/mcpReturn";
import { mcpOrigin } from "../apps/api/src/mcpAuthorization";
import { checkMcp } from "../scripts/check-mcp.mjs";

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
    let accountAccess = "ok";
    const runtime = await mcpTestRuntime(
      db,
      origin,
      anotherOwner,
      () => accountAccess,
    );
    t.after(() => runtime.dispose());
    const call = (
      path: string,
      init?: Parameters<Miniflare["dispatchFetch"]>[1],
    ) => runtime.dispatchFetch(`${origin}${path}`, init);
    const deploymentCheck = await checkMcp(origin, async (input) => {
      const response = await runtime.dispatchFetch(String(input), {
        redirect: "manual",
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    });
    assert.equal(deploymentCheck.discovery, "passed");
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
    const recovered = await call(
      ticket.path,
      payload({ decision: "allow", projectId: project.id }, owner),
    );
    assert.equal(recovered.status, 200);
    assert.deepEqual(
      await recovered.json(),
      approved,
      "A lost approval response reuses the same grant",
    );
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
      410,
    );
    assert.equal(
      (await call(ticket.path, payload({ decision: "deny" }, owner))).status,
      410,
    );
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
    await db.sql`update planning.projects set lifecycle='trashed' where id=${project.id}`;
    assert.equal(
      (
        await call(
          "/mcp",
          payload(
            { jsonrpc: "2.0", id: 1, method: "tools/list" },
            agentHeaders,
          ),
        )
      ).status,
      503,
    );
    await db.sql`update planning.projects set lifecycle='active' where id=${project.id}`;
    await rpc("tools/list");
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
    const limitedHeaders = { "CF-Connecting-IP": "203.0.113.25" };
    let limited: Awaited<ReturnType<typeof call>> | undefined;
    for (let i = 0; i < 125; i++) {
      const response = await call("/mcp", { headers: limitedHeaders });
      await response.body?.cancel();
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    assert.ok(
      limited,
      "Unauthenticated requests are bounded before OAuth storage",
    );
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(
      (await call("/api/integrations/context", { headers: limitedHeaders }))
        .status,
      429,
    );
  },
);
