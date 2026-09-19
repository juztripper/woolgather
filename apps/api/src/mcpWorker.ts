import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import app from "./index";
import { createConnectorServer } from "../../../packages/agent-connector/src/server.mjs";
import {
  beginMcpAuthorization,
  mcpJson,
  mcpOrigin,
  mcpSetup,
  MCP_SCOPE,
  type McpEnv,
} from "./mcpAuthorization";

const grant = z.object({
  token: z.string().regex(/^wg_[0-9a-f]{64}$/),
  projectId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  canBuild: z.boolean(),
});
const protectedPath = (path: string) =>
  path.startsWith("/mcp") ||
  path.startsWith("/oauth/") ||
  path.startsWith("/.well-known/oauth-");

async function boundedRequest(request: Request) {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128000) {
        await reader.cancel();
        throw new Error("Too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body: bytes });
}

export async function fetchMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const url = new URL(request.url);
  if (url.pathname === "/connect/authorize") {
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    response.headers.set(
      "Content-Security-Policy",
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }
  const relevant =
    protectedPath(url.pathname) || url.pathname === "/api/mcp/authorization";
  if (!relevant) return app.fetch(request, env, ctx);
  const origin = mcpOrigin(env);
  if (!origin || !mcpSetup(env).enabled)
    return mcpJson(
      { error: "Account connections are unavailable on this installation." },
      503,
    );
  if (url.origin !== origin)
    return mcpJson({ error: "Use the configured woolgather address." }, 400);
  if (
    url.pathname.startsWith("/oauth/") &&
    !(
      await env.MCP_AUTH_LIMITER.limit({
        key: request.headers.get("CF-Connecting-IP") || "local",
      })
    ).success
  ) {
    const response = mcpJson(
      {
        error: "too_many_requests",
        error_description: "Wait a minute before connecting again.",
      },
      429,
    );
    response.headers.set("Retry-After", "60");
    return response;
  }
  // Browser-based MCP clients must go through their own server/native client.
  // Reject cross-origin resource calls; discovery/token endpoints retain OAuth CORS.
  if (
    url.pathname.startsWith("/mcp") &&
    request.headers.has("Origin") &&
    request.headers.get("Origin") !== origin
  )
    return mcpJson({ error: "Origin not allowed." }, 403);
  try {
    request = await boundedRequest(request);
  } catch {
    return mcpJson({ error: "Request too large." }, 413);
  }
  const provider = new OAuthProvider<McpEnv>({
    apiRoute: "/mcp",
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86400,
    clientRegistrationTTL: 30 * 86400,
    scopesSupported: [MCP_SCOPE],
    tokenExchangeCallback: ({ props, requestedScope }) => ({
      accessTokenProps: {
        ...props,
        canBuild: requestedScope.includes(MCP_SCOPE),
      },
    }),
    resourceMetadata: {
      resource: `${origin}/mcp`,
      scopes_supported: [MCP_SCOPE],
      resource_name: "woolgather",
    },
    defaultHandler: {
      fetch(req, bindings, context) {
        if (new URL(req.url).pathname === "/oauth/authorize")
          return req.method === "GET"
            ? beginMcpAuthorization(req, bindings)
            : Promise.resolve(mcpJson({ error: "Method not allowed." }, 405));
        return app.fetch(req, bindings, context);
      },
    },
    apiHandler: {
      async fetch(req, bindings, context) {
        if (new URL(req.url).pathname !== "/mcp")
          return mcpJson({ error: "Not found." }, 404);
        const access = grant.safeParse(context.props);
        const reconnect = () =>
          new Response(
            JSON.stringify({ error: "Reconnect woolgather in your agent." }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
              },
            },
          );
        if (!access.success || Date.parse(access.data.expiresAt) <= Date.now())
          return reconnect();
        if (!access.data.canBuild)
          return new Response(null, {
            status: 403,
            headers: {
              "Cache-Control": "no-store",
              "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${MCP_SCOPE}"`,
            },
          });
        // Same existing project-scoped API and MCP tools as the local connector.
        // The backing credential is encrypted in OAuth props and never leaves the server.
        const internalFetch = (
          input: string | URL | Request,
          init?: RequestInit,
        ) =>
          app.fetch(
            new Request(input, { ...init, redirect: "manual" }),
            bindings,
            context,
          );
        const check = await internalFetch(
          `${origin}/api/integrations/context`,
          { headers: { Authorization: `Bearer ${access.data.token}` } },
        );
        if (!check.ok) {
          await check.body?.cancel();
          return [401, 403, 404].includes(check.status)
            ? reconnect()
            : mcpJson(
                { error: "Project access could not be checked. Try again." },
                503,
              );
        }
        await check.body?.cancel();
        const server = createConnectorServer({
          origin,
          token: access.data.token,
          fetchImpl: internalFetch,
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await server.connect(transport);
          const response = await transport.handleRequest(req);
          response.headers.set("Cache-Control", "no-store");
          response.headers.set("X-Content-Type-Options", "nosniff");
          return response;
        } finally {
          await server.close();
        }
      },
    },
  });
  try {
    return await provider.fetch(request, env, ctx);
  } catch {
    return mcpJson(
      {
        error: "Connection could not be completed. Try again from your agent.",
      },
      503,
    );
  }
}
