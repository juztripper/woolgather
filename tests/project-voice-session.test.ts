import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The durable class runs unchanged; replace only the Workers host base class.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return { url: "test:cloudflare-workers", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:cloudflare-workers")
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      };
    return next(url, context);
  },
});
const { ProjectVoiceSession } =
  await import("../apps/api/src/projectVoiceSession");
hooks.deregister();

function fixture() {
  const saved = new Map<string, unknown>([
    [
      "session",
      {
        runId: "11111111-1111-4111-8111-111111111111",
        phase: "unknown",
        closed: true,
        attemptId: "22222222-2222-4222-8222-222222222222",
        capability: "test-capability",
        providerSessionId: "live_existing",
        errorCode: "voice_sideband_closed_before_final",
      },
    ],
  ]);
  let alarm: number | null = null;
  let initialized: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage: {
      get: async (key: string) => structuredClone(saved.get(key)),
      put: async (key: string, value: unknown) => {
        saved.set(key, structuredClone(value));
      },
      getAlarm: async () => alarm,
      setAlarm: async (value: number) => {
        alarm = value;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
      initialized = callback();
      return initialized;
    },
  };
  const instance = new ProjectVoiceSession(
    ctx as unknown as DurableObjectState,
    {
      OPENAI_API_KEY: "provider-test-key",
      SUPABASE_URL: "https://fixture.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "database-test-key",
      ACCOUNT_ACTION_SECRET: "test-action-secret",
    },
  );
  return { instance, saved, ready: () => initialized, alarm: () => alarm };
}

test("voice recovery confirms closure without inference, transcript loss, or invented usage", async () => {
  for (const hangupStatus of [200, 404]) {
    const f = fixture();
    await f.ready();
    assert.ok(f.alarm());
    const requests: string[] = [];
    const mock = test.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/hangup"))
          return new Response(null, { status: hangupStatus });
        assert.ok(url.endsWith("/rpc/settle_project_voice"));
        const body = JSON.parse(String(init?.body));
        const payload = JSON.parse(body.payload);
        assert.equal(payload.status, "unknown");
        assert.equal(payload.providerClosed, true);
        assert.equal(payload.providerSessionId, "live_existing");
        assert.equal(payload.usage, undefined);
        assert.equal(payload.transcript, undefined);
        return Response.json({
          settled: false,
          status: "unknown",
          providerClosed: true,
        });
      },
    );
    try {
      await f.instance.alarm();
      assert.equal(
        (f.saved.get("session") as { providerClosed: boolean }).providerClosed,
        true,
      );
      assert.equal(f.alarm(), null);
      assert.equal(requests.length, 2);
      await f.instance.stop("live_existing");
      assert.equal(requests.length, 2);
    } finally {
      mock.mock.restore();
    }
  }
});

test("voice recovery retains the hold and retries when closure or acknowledgement fails", async () => {
  for (const failure of ["provider", "receipt"]) {
    const f = fixture();
    await f.ready();
    const mock = test.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        if (String(input).endsWith("/hangup"))
          return new Response(null, {
            status: failure === "provider" ? 409 : 200,
          });
        return Response.json({ settled: false, status: "unknown" });
      },
    );
    try {
      await f.instance.alarm();
      assert.notEqual(
        (f.saved.get("session") as { providerClosed?: boolean }).providerClosed,
        true,
      );
      assert.ok(f.alarm()! > Date.now() + 20000);
    } finally {
      mock.mock.restore();
    }
  }
});

test("authoritative close saves voice before optional naming and scrubs the durable session", async () => {
  const f = fixture();
  await f.ready();
  f.saved.set("session", {
    runId: "11111111-1111-4111-8111-111111111111",
    phase: "running",
    attemptId: "22222222-2222-4222-8222-222222222222",
    capability: "test-capability",
    providerSessionId: "live_existing",
    finalEventReceived: true,
    finalUsage: { seconds: 12 },
    transcript: [
      { speaker: "user", text: "Garden puzzles", startMs: 0, endMs: 1000 },
    ],
  });
  const requests: string[] = [];
  const mock = test.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/rpc/settle_project_voice")) {
        const payload = JSON.parse(JSON.parse(String(init?.body)).payload);
        assert.equal(payload.transcript[0].text, "Garden puzzles");
        return Response.json({ settled: true });
      }
      assert.ok(url.endsWith("/rpc/project_voice_title"));
      // An optional naming outage cannot undo the already saved call.
      return new Response(null, { status: 503 });
    },
  );
  try {
    await f.instance.alarm();
    assert.deepEqual(
      requests.map((url) => url.split("/").at(-1)),
      ["settle_project_voice", "project_voice_title"],
    );
    assert.deepEqual(f.saved.get("session"), {
      runId: "11111111-1111-4111-8111-111111111111",
      phase: "closed",
      closed: true,
    });
    await f.instance.alarm();
    assert.equal(requests.length, 2);
  } finally {
    mock.mock.restore();
  }
});
