import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import type { GuidanceRpc } from "./ideaGuidance";
import {
  integrationTokens,
  readDelivery,
  hashIntegrationToken,
} from "./projectDelivery";

export const MCP_SCOPE = "project:build";
export const CONSENT_TTL = 15 * 60 * 1000;
export type ConsentTicket = {
  request: AuthRequest;
  browserHash: string;
  expiresAt: number;
};
export type McpEnv = Env & { OAUTH_PROVIDER?: OAuthHelpers };
export const mcpJson = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });

export function mcpOrigin(env: Pick<Env, "MCP_ENABLED" | "MCP_ORIGIN">) {
  if (env.MCP_ENABLED !== "true") return null;
  try {
    const url = new URL(env.MCP_ORIGIN);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export function mcpSetup(env: McpEnv) {
  const origin = mcpOrigin(env);
  const enabled = !!(
    origin &&
    env.OAUTH_KV &&
    env.MCP_AUTH_LIMITER &&
    env.MCP_CONSENTS &&
    env.SUPABASE_URL &&
    env.SUPABASE_PUBLISHABLE_KEY &&
    env.ACCOUNT_ACTION_SECRET
  );
  return { enabled, url: enabled ? `${origin}/mcp` : null };
}
function cookieName(origin: string) {
  return origin.startsWith("https:")
    ? "__Host-woolgather-mcp"
    : "woolgather-mcp";
}
function browserSecret(request: Request, origin: string) {
  const prefix = `${cookieName(origin)}=`;
  return (
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(prefix))
      ?.slice(prefix.length) ?? ""
  );
}
export function validAuthRequest(request: AuthRequest, origin: string) {
  return (
    request.responseType === "code" &&
    request.codeChallengeMethod === "S256" &&
    /^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge ?? "") &&
    request.scope.every((scope) =>
      [MCP_SCOPE, "offline_access"].includes(scope),
    ) &&
    (!request.resource ||
      (Array.isArray(request.resource)
        ? request.resource
        : [request.resource]
      ).every((resource) => resource === `${origin}/mcp`))
  );
}
export async function beginMcpAuthorization(request: Request, env: McpEnv) {
  const origin = mcpOrigin(env);
  if (!origin || !env.OAUTH_PROVIDER || !mcpSetup(env).enabled)
    return mcpJson(
      { error: "Account connections are unavailable on this installation." },
      503,
    );
  try {
    const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!validAuthRequest(parsed, origin))
      return mcpJson(
        { error: "Use an MCP client with OAuth and S256 PKCE support." },
        400,
      );
    let browser = browserSecret(request, origin);
    if (!/^[a-f0-9]{64}$/.test(browser))
      browser = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    const ticketId = crypto.randomUUID();
    await env.MCP_CONSENTS.getByName(ticketId).create({
      request: parsed,
      browserHash: await hashIntegrationToken(browser),
      expiresAt: Date.now() + CONSENT_TTL,
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${origin}/connect/authorize?request=${ticketId}`,
        "Set-Cookie": `${cookieName(origin)}=${browser}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${origin.startsWith("https:") ? "; Secure" : ""}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return mcpJson(
      {
        error:
          "This connection request is invalid. Start again from your agent.",
      },
      400,
    );
  }
}

const approval = z
  .object({
    decision: z.enum(["allow", "deny"]),
    projectId: z.uuid().optional(),
  })
  .strict();
/** Called only after the ordinary API has verified the user and account_access (including MFA). */
export async function mcpConsent(
  request: Request,
  env: McpEnv,
  rpc: GuidanceRpc,
  ownerId: string,
  body?: unknown,
) {
  const origin = mcpOrigin(env);
  if (!origin || !env.OAUTH_PROVIDER || !mcpSetup(env).enabled)
    return mcpJson(
      { error: "Account connections are unavailable on this installation." },
      503,
    );
  const url = new URL(request.url);
  if (
    url.origin !== origin ||
    (request.method === "POST" && request.headers.get("Origin") !== origin)
  )
    return mcpJson({ error: "Open this request in woolgather." }, 403);
  const id = z.uuid().safeParse(url.searchParams.get("request"));
  if (!id.success)
    return mcpJson({ error: "Invalid connection request." }, 400);
  const browser = browserSecret(request, origin);
  if (!/^[a-f0-9]{64}$/.test(browser))
    return mcpJson(
      { error: "Start again from your agent in this browser." },
      403,
    );
  const browserHash = await hashIntegrationToken(browser);
  const ticket = env.MCP_CONSENTS.getByName(id.data);
  const pending = await ticket.read(browserHash);
  if (!pending)
    return mcpJson(
      {
        error:
          "This request expired or was already used. Start again from your agent.",
      },
      410,
    );
  const client = await env.OAUTH_PROVIDER.lookupClient(
    pending.request.clientId,
  );
  if (!client)
    return mcpJson(
      { error: "The requesting app is no longer available." },
      410,
    );
  const clientName = (client.clientName || "Your coding agent")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 80);
  if (request.method === "GET")
    return mcpJson({
      clientName,
      redirectHost: new URL(pending.request.redirectUri).host,
      expiresAt: pending.expiresAt,
    });
  const choice = approval.safeParse(body);
  if (
    !choice.success ||
    (choice.data.decision === "allow" && !choice.data.projectId)
  )
    return mcpJson({ error: "Choose a project to continue." }, 422);
  const actor = {
    actor: "owner" as const,
    ownerId,
    projectId: choice.data.projectId ?? "",
  };
  if (choice.data.decision === "allow") {
    const access = await readDelivery(rpc, env, actor);
    if (!access.ok) return access;
    await access.body?.cancel();
  }
  // Atomic durable claim: two tabs/retries cannot mint multiple credentials.
  if (!(await ticket.claim(browserHash)))
    return mcpJson(
      { error: "This request was already used. Start again from your agent." },
      410,
    );
  if (choice.data.decision === "deny") {
    const redirect = new URL(pending.request.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("state", pending.request.state);
    if (pending.request.issuer)
      redirect.searchParams.set("iss", pending.request.issuer);
    return mcpJson({ redirectTo: redirect.href });
  }
  const result = await integrationTokens(rpc, env, actor, {
    action: "create",
    name: clientName,
    expiresInDays: 30,
  });
  if (!result.ok) return result;
  const token = (await result.json()) as {
    id: string;
    token: string;
    expiresAt: string;
  };
  try {
    const complete = await env.OAUTH_PROVIDER.completeAuthorization({
      request: pending.request,
      userId: ownerId,
      metadata: {
        projectId: actor.projectId,
        tokenId: token.id,
        name: clientName,
      },
      scope: [MCP_SCOPE],
      revokeExistingGrants: false,
      props: {
        token: token.token,
        projectId: actor.projectId,
        expiresAt: token.expiresAt,
      },
    });
    return mcpJson(complete);
  } catch {
    // Any issued backing access remains visible/revocable if cleanup cannot be confirmed.
    await integrationTokens(rpc, env, actor, {
      action: "revoke",
      tokenId: token.id,
    });
    return mcpJson(
      {
        error:
          "Connection could not be completed. Check Project access, then start again from your agent.",
      },
      503,
    );
  }
}
