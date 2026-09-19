// Optional native-client qualification. Uses disposable data and an isolated Codex
// profile. No turn/start or model request is sent, and no account is needed.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { planningTestDatabase } from "./planning-test-database";
import { mcpTestRuntime } from "./mcp-test-runtime";
import { checkClaude } from "./check-mcp-claude";

const profile = await mkdtemp(join(tmpdir(), "woolgather-codex-check-"));
const db = await planningTestDatabase(55543);
const port = 4261;
const origin = `http://127.0.0.1:${port}`;
const runtime = await mcpTestRuntime(
  db,
  origin,
  crypto.randomUUID(),
  undefined,
  port,
);
let child: ReturnType<typeof spawn> | undefined;
try {
  await runtime.ready;
  const project = await db.createProject(
    "Native client qualification",
    "Disposable data only",
  );
  const thoughtId = crypto.randomUUID(),
    scopeId = crypto.randomUUID(),
    requirementId = crypto.randomUUID();
  const added = await db.rpc("execute_command", {
    command: {
      id: crypto.randomUUID(),
      projectId: project.id,
      expectedRevision: project.revision,
      action: {
        type: "add_item",
        itemId: thoughtId,
        item: {
          title: "Save a draft",
          body: "Reopen the saved draft",
          category: "feature",
          certainty: "confirmed",
          status: "open",
          answer: "",
          links: [],
        },
      },
    },
  });
  assert.equal(added.error, null);
  const ownerHeaders = {
    Authorization: "Bearer owner-session",
    Origin: origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown, headers = ownerHeaders) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  assert.equal(
    (
      await post("/api/project-delivery", {
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
              criterion: "A draft survives reopening",
            },
          ],
        },
      })
    ).status,
    200,
  );
  await mkdir(join(profile, "workspace"));
  if (process.argv.includes("--claude")) {
    await checkClaude(profile, origin, project.id);
  } else {
    await writeFile(
      join(profile, "config.toml"),
      `mcp_oauth_credentials_store = "file"\n[mcp_servers.woolgather]\nurl = "${origin}/mcp"\n`,
    );
    const version = execFileSync("codex", ["--version"], {
      encoding: "utf8",
    }).trim();
    child = spawn("codex", ["app-server", "--strict-config"], {
      cwd: join(profile, "workspace"),
      env: { ...process.env, CODEX_HOME: profile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Never print RPC payloads: OAuth URLs and responses can contain credentials.
    child.stderr!.resume();
    let serial = 0;
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    const notices: { method: string; params: any }[] = [];
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error)
          waiter.reject(new Error(`Codex RPC failed (${message.error.code})`));
        else waiter.resolve(message.result);
      } else if (message.method) notices.push(message);
    });
    const rpc = (method: string, params: unknown = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = ++serial;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 25000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        child!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
      });
    await rpc("initialize", {
      clientInfo: { name: "woolgather_qualification", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
    const login = await rpc("mcpServer/oauth/login", {
      name: "woolgather",
      timeoutSecs: 60,
    });
    const start = await fetch(login.authorizationUrl, { redirect: "manual" });
    assert.equal(start.status, 302);
    const request = new URL(start.headers.get("location")!).searchParams.get(
      "request",
    );
    const approved = await post(
      `/api/mcp/authorization?request=${request}`,
      { decision: "allow", projectId: project.id },
      {
        ...ownerHeaders,
        Cookie: start.headers.get("set-cookie")!.split(";")[0],
      },
    );
    assert.equal(approved.status, 200);
    const callback = (await approved.json()) as { redirectTo: string };
    assert.equal(
      (await fetch(callback.redirectTo, { signal: AbortSignal.timeout(15000) }))
        .ok,
      true,
    );
    const thread = await rpc("thread/start", {
      cwd: join(profile, "workspace"),
      ephemeral: true,
    });
    const threadId = thread.thread.id;
    const inventory = await rpc("mcpServerStatus/list", { threadId });
    const server = inventory.data.find(
      (value: any) => value.name === "woolgather",
    );
    assert.ok(
      server && Object.keys(server.tools).length === 3,
      "Codex must discover the three tools",
    );
    const tool = async (name: string, args: unknown) => {
      const result = await rpc("mcpServer/tool/call", {
        threadId,
        server: "woolgather",
        tool: name,
        arguments: args,
      });
      assert.ok(!result.isError, `${name} failed`);
      return result.structuredContent;
    };
    assert.equal(
      (await tool("get_project_context", {})).project.id,
      project.id,
    );
    await tool("connect_repository", {
      commandId: crypto.randomUUID(),
      expectedRevision: 1,
      label: "Disposable repository",
      remoteUrl: "",
      branch: "main",
    });
    const report = {
      commandId: crypto.randomUUID(),
      expectedRevision: 2,
      scopeId,
      requirementId,
      state: "implemented",
      summary: "Protocol qualification only; no code was built",
      commit: "",
      checks: [{ command: "native MCP round trip", result: "passed" }],
    };
    await tool("report_implementation_outcome", report);
    await tool("report_implementation_outcome", report);
    const context = await tool("get_project_context", {});
    assert.equal(context.delivery.revision, 3);
    assert.equal(
      (
        await db.sql`select state->'reports' as reports from delivery_private.states where project_id=${project.id}`
      )[0].reports.length,
      1,
    );
    const token = (
      await db.sql`select id from delivery_private.tokens where project_id=${project.id}`
    )[0];
    assert.equal(
      (
        await post(`/api/projects/${project.id}/integration-tokens`, {
          action: "revoke",
          tokenId: token.id,
        })
      ).status,
      200,
    );
    await assert.rejects(tool("get_project_context", {}));
    console.log(
      `PASS ${version}: native OAuth, tool discovery, project read, repository binding, evidence report, duplicate retry and revocation. No inference requested.`,
    );
  }
} finally {
  child?.kill();
  await runtime.dispose();
  await db.close();
  await rm(profile, { recursive: true, force: true });
}
