import type { SupabaseClient } from "@supabase/supabase-js";
import { deletionEmail } from "../../../packages/emails/src";
export type DeletionRequest = {
  id: string;
  userId: string;
  email: string;
  expiresAt: number;
};
export async function signDeletion(value: DeletionRequest, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `woolgather.delete.v1:${value.id}:${value.userId}:${value.expiresAt}:${value.email}`;
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function accountDeletion(
  request: Request,
  client: SupabaseClient,
  env: { ACCOUNT_ACTION_SECRET?: string; RESEND_API_KEY?: string },
  body: unknown,
) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  const action = url.pathname.slice("/api/account/deletion/".length);
  if (!["request", "status", "complete", "cancel"].includes(action))
    return json({ error: "Not found" }, 404);
  if (!body || typeof body !== "object")
    return json({ error: "Invalid request" }, 400);
  const input = body as { requestId?: unknown; signature?: unknown };
  if (typeof input.requestId !== "string" || !uuid.test(input.requestId))
    return json({ error: "Invalid request" }, 400);
  if (
    action === "request" &&
    (!env.ACCOUNT_ACTION_SECRET || !env.RESEND_API_KEY)
  )
    return json(
      { error: "Account email is unavailable. Please try again shortly." },
      503,
    );
  // Origin is deployment-owned; request body cannot choose a recipient or redirect.
  if (
    ![
      "https://woolgathering.app",
      "http://127.0.0.1:4200",
      "http://localhost:4200",
    ].includes(url.origin)
  )
    return json(
      { error: "Account confirmation is unavailable at this address." },
      400,
    );
  const result = await client.rpc("account_deletion", {
    action: action === "request" ? "begin" : action,
    request_id: input.requestId,
    signature: typeof input.signature === "string" ? input.signature : null,
  });
  if (result.error) {
    const status =
      result.error.code === "PT429"
        ? 429
        : result.error.code === "42501"
          ? 403
          : result.error.code === "22023"
            ? 400
            : 503;
    return json(
      {
        error:
          status === 503
            ? "Unable to complete this step. Please retry."
            : result.error.message,
      },
      status,
    );
  }
  if (action !== "request") return json(result.data);
  const value = result.data as DeletionRequest;
  const signature = await signDeletion(value, env.ACCOUNT_ACTION_SECRET!);
  const link = new URL("/account/delete", url.origin);
  link.hash = new URLSearchParams({
    owner: value.userId,
    request: value.id,
    signature,
  }).toString();
  const mail = deletionEmail(value.email, link.href);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `account-deletion/${value.id}`,
    },
    body: JSON.stringify({
      from: "woolgather <accounts@woolgathering.app>",
      to: [value.email],
      ...mail,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    return json(
      { error: "The confirmation email could not be sent. Please retry." },
      503,
    );
  return json({ sent: true, requestId: value.id, expiresAt: value.expiresAt });
}
