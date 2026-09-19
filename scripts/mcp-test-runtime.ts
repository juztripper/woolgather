// Real Worker and disposable PostgreSQL; no app credentials or model calls.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import assert from "node:assert/strict";
import type { planningTestDatabase } from "./planning-test-database";

export async function mcpTestRuntime(
  db: Awaited<ReturnType<typeof planningTestDatabase>>,
  origin: string,
  anotherOwner: string,
  accountAccess: () => string = () => "ok",
  port?: number,
) {
  const bundled = await build({
    entryPoints: ["apps/api/src/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "browser"],
    external: ["cloudflare:*", "node:*"],
    write: false,
  });
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      ...(port ? { host: "127.0.0.1", port } : {}),
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
        MCP_API_LIMITER: {
          namespace_id: "1002",
          simple: { limit: 120, period: 60 },
        },
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
          return Response.json(accountAccess());
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

  return runtime;
}
