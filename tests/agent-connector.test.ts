import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/agent-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/agent-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { InMemoryTransport } from "../packages/agent-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import {
  createConnectorServer,
  createWoolgatherApi,
  readConnectorConfig,
} from "../packages/agent-connector/src/server.mjs";

const token = `wgc_${"synthetic".repeat(8)}`;
const origin = "https://woolgather.example";
const config = { origin, token };
const context = {
  project: {
    id: randomUUID(),
    name: "Synthetic project",
    revision: 7,
    items: [],
    relations: [],
    sources: [],
  },
  delivery: {
    version: 1,
    revision: 2,
    repository: null,
    scopes: [],
    reports: [],
    reviews: [],
  },
  execution: { inference: "user_agent" },
};

async function connect(fetchImpl: typeof fetch) {
  const server = createConnectorServer({ ...config, fetchImpl });
  const client = new Client({
    name: "woolgather-test-client",
    version: "1.0.0",
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("connector negotiates with official SDK and preserves stable operation IDs", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const session = await connect(async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return Response.json(context);
  });
  try {
    assert.equal(session.client.getServerVersion()?.name, "woolgather");
    assert.ok(session.client.getServerCapabilities()?.tools);
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), [
      "connect_repository",
      "get_project_context",
      "report_implementation_outcome",
    ]);
    const result = await session.client.callTool({
      name: "get_project_context",
      arguments: {},
    });
    assert.deepEqual(result.structuredContent, context);
    assert.equal(calls[0].url, `${origin}/api/integrations/context`);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(
      new Headers(calls[0].init.headers).get("authorization"),
      `Bearer ${token}`,
    );
    assert.ok(calls[0].init.signal);
    const commandId = randomUUID();
    const args = {
      commandId,
      expectedRevision: 2,
      scopeId: randomUUID(),
      requirementId: randomUUID(),
      state: "implemented",
      summary: "Feature implemented; visual review still required.",
      commit: "1234567",
      checks: [{ command: "npm test", result: "passed" }],
    };
    await session.client.callTool({
      name: "report_implementation_outcome",
      arguments: args,
    });
    await session.client.callTool({
      name: "report_implementation_outcome",
      arguments: args,
    });
    assert.equal(
      calls[1].init.body,
      calls[2].init.body,
      "Retry must preserve exact operation payload",
    );
    assert.deepEqual(JSON.parse(calls[1].init.body as string), {
      id: commandId,
      expectedRevision: 2,
      action: {
        type: "report_outcome",
        scopeId: args.scopeId,
        requirementId: args.requirementId,
        state: args.state,
        summary: args.summary,
        commit: args.commit,
        checks: args.checks,
      },
    });
    const repository = {
      label: "Synthetic repository",
      remoteUrl: "https://example.com/user/repo.git",
      branch: "development",
    };
    await session.client.callTool({
      name: "connect_repository",
      arguments: {
        commandId: randomUUID(),
        expectedRevision: 2,
        ...repository,
      },
    });
    assert.deepEqual(JSON.parse(calls[3].init.body as string).action, {
      type: "connect_repository",
      repository,
    });
  } finally {
    await session.close();
  }
});

test("connector rejects excess authority and malformed evidence before API access", async () => {
  let requests = 0;
  const session = await connect(async () => {
    requests++;
    return Response.json(context);
  });
  try {
    for (const args of [
      {
        commandId: randomUUID(),
        expectedRevision: 0,
        scopeId: randomUUID(),
        requirementId: randomUUID(),
        state: "verified",
        summary: "done",
      },
      {
        expectedRevision: 0,
        scopeId: randomUUID(),
        requirementId: randomUUID(),
        state: "implemented",
        summary: "done",
      },
      {
        commandId: randomUUID(),
        expectedRevision: 0,
        scopeId: randomUUID(),
        requirementId: randomUUID(),
        state: "implemented",
        summary: "done",
        projectId: randomUUID(),
      },
    ]) {
      const result = await session.client.callTool({
        name: "report_implementation_outcome",
        arguments: args,
      });
      assert.equal(result.isError, true);
    }
    for (const remoteUrl of [
      "http://example.com/repo",
      "https://user:secret@example.com/repo",
      "https://example.com/repo?token=secret",
      "/Users/example/private-repo",
    ]) {
      const result = await session.client.callTool({
        name: "connect_repository",
        arguments: {
          commandId: randomUUID(),
          expectedRevision: 0,
          label: "repo",
          remoteUrl,
        },
      });
      assert.equal(result.isError, true);
    }
    assert.equal(requests, 0);
  } finally {
    await session.close();
  }
});

test("connector permits secure origins and loopback only; configuration errors hide secrets", () => {
  for (const url of [
    origin,
    "http://127.0.0.1:4200",
    "http://localhost:4300",
    "http://[::1]:4200",
  ]) {
    assert.equal(
      readConnectorConfig({ WOOLGATHER_URL: url, WOOLGATHER_TOKEN: token })
        .origin,
      url,
    );
  }
  for (const url of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?token=secret",
    "file:///private/file",
    "http://127.0.0.1.example.com",
    "https://example.com/#fragment",
  ]) {
    assert.throws(
      () =>
        readConnectorConfig({ WOOLGATHER_URL: url, WOOLGATHER_TOKEN: token }),
      (error: Error) =>
        !error.message.includes(token) && !error.message.includes("secret"),
    );
  }
  assert.throws(() =>
    readConnectorConfig({
      WOOLGATHER_URL: origin,
      WOOLGATHER_TOKEN: "bad\ntoken",
    }),
  );
});

test("connector never exposes remote error bodies, credentials or network exception details", async () => {
  for (const fetchImpl of [
    async () => new Response(`private failure ${token}`, { status: 401 }),
    async () => new Response(`private failure ${token}`, { status: 500 }),
    async () => {
      throw new Error(`private failure ${token}`);
    },
  ]) {
    const session = await connect(fetchImpl);
    try {
      const result = await session.client.callTool({
        name: "get_project_context",
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes(token));
      assert.ok(!JSON.stringify(result).includes("private failure"));
    } finally {
      await session.close();
    }
  }
  const api = createWoolgatherApi({
    ...config,
    fetchImpl: async () => Response.json({ echo: token }),
  });
  assert.deepEqual(await api("/api/integrations/context"), {
    echo: "[redacted]",
  });
  const encoded = createWoolgatherApi({
    ...config,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ echo: token }).replace("wgc_", "\\u0077gc_"),
      ),
  });
  assert.deepEqual(await encoded("/api/integrations/context"), {
    echo: "[redacted]",
  });
});

test("semantic rejection directs reconciliation without reflecting server detail", async () => {
  const session = await connect(
    async () => new Response(`private ${token}`, { status: 422 }),
  );
  try {
    const result = await session.client.callTool({
      name: "connect_repository",
      arguments: {
        commandId: randomUUID(),
        expectedRevision: 0,
        label: "repository",
      },
    });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result);
    assert.match(text, /invalid_change/);
    assert.match(text, /Read fresh context/);
    assert.doesNotMatch(text, /unavailable/);
    assert.ok(!text.includes(token));
  } finally {
    await session.close();
  }
});

test("connector bounds streamed responses, rejects redirects and handles timeout without retries", async () => {
  const oversized = createWoolgatherApi({
    ...config,
    maxResponseBytes: 16,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(17)));
            controller.close();
          },
        }),
      ),
  });
  await assert.rejects(
    oversized("/api/integrations/context"),
    /response limit/,
  );
  let attempts = 0;
  const timeout = createWoolgatherApi({
    ...config,
    timeoutMs: 10,
    fetchImpl: async (_input: unknown, init?: RequestInit) => {
      attempts++;
      return new Promise<Response>((_resolve, reject) => {
        // Keep the event loop alive while AbortSignal.timeout's unref timer expires.
        const timer = setTimeout(() => reject(new Error("test deadline")), 100);
        init!.signal!.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(init!.signal!.reason);
          },
          { once: true },
        );
      });
    },
  });
  await assert.rejects(timeout("/api/integrations/context"), /same command ID/);
  assert.equal(attempts, 1);
  const conflict = createWoolgatherApi({
    ...config,
    fetchImpl: async () => new Response("private", { status: 409 }),
  });
  await assert.rejects(
    conflict("/api/integrations/delivery", { id: randomUUID() }),
    /Read fresh context/,
  );
});

test("real stdio executable completes SDK handshake, reads API and prevents credential-bearing redirects", async () => {
  const seen: string[] = [];
  let redirect = false;
  const apiServer = createServer((request, response) => {
    seen.push(request.url!);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (redirect) {
      response.writeHead(302, { location: "/credential-target" });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(context));
    }
  });
  apiServer.listen(0, "127.0.0.1");
  await once(apiServer, "listening");
  const address = apiServer.address();
  assert.ok(address && typeof address !== "string");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL(
          "../packages/agent-connector/bin/woolgather-mcp.mjs",
          import.meta.url,
        ),
      ),
    ],
    env: {
      WOOLGATHER_URL: `http://127.0.0.1:${address.port}`,
      WOOLGATHER_TOKEN: token,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "stdio-qualification", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    assert.deepEqual(
      (await client.callTool({ name: "get_project_context", arguments: {} }))
        .structuredContent,
      context,
    );
    redirect = true;
    assert.equal(
      (await client.callTool({ name: "get_project_context", arguments: {} }))
        .isError,
      true,
    );
    assert.deepEqual(seen, [
      "/api/integrations/context",
      "/api/integrations/context",
    ]);
    assert.equal(stderr, "");
  } finally {
    await client.close();
    apiServer.close();
    apiServer.closeAllConnections();
    await once(apiServer, "close");
  }
});
