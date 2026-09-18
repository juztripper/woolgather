import { z } from "zod";
import {
  hashGuidance,
  type GuidanceRpc,
  repeatGuidanceRpc,
} from "./ideaGuidance";
export type BillingTestEnv = {
  BILLING_TEST_ENABLED?: string;
  DODO_TEST_WEBHOOK_SECRET?: string;
  DODO_TEST_BUSINESS_ID?: string;
  BILLING_TEST_ACTION_SECRET?: string;
};
const encoder = new TextEncoder();
export async function signBillingTest(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(`woolgather.billing.test.v1:${payload}`),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function verifyDodoWebhook(
  raw: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
) {
  const id = headers.get("webhook-id") || "",
    timestamp = headers.get("webhook-timestamp") || "",
    signatures = headers.get("webhook-signature") || "";
  if (
    !/^[\w-]{1,200}$/.test(id) ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    signatures.length > 2000
  )
    throw new Error("Invalid webhook");
  const bytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) =>
    c.charCodeAt(0),
  );
  if (bytes.length < 16) throw new Error("Invalid webhook secret");
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const message = encoder.encode(`${id}.${timestamp}.${raw}`);
  for (const signature of signatures.trim().split(/\s+/)) {
    const [version, encoded] = signature.split(",");
    if (version !== "v1" || !encoded) continue;
    try {
      if (
        await crypto.subtle.verify(
          "HMAC",
          key,
          Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
          message,
        )
      )
        return id;
    } catch {
      /* Try another signature during key rotation. */
    }
  }
  throw new Error("Invalid webhook signature");
}
const envelope = z.object({
  business_id: z.string(),
  type: z.string().max(100),
  timestamp: z.iso.datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
});
export async function billingTestWebhook(
  request: Request,
  env: BillingTestEnv,
  rpc: GuidanceRpc,
) {
  if (
    env.BILLING_TEST_ENABLED !== "true" ||
    !env.DODO_TEST_WEBHOOK_SECRET ||
    !env.DODO_TEST_BUSINESS_ID ||
    !env.BILLING_TEST_ACTION_SECRET
  )
    return Response.json({ error: "Not found" }, { status: 404 });
  if (request.method !== "POST")
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Empty event" }, { status: 400 });
  let size = 0,
    raw = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64000) {
        await reader.cancel();
        return Response.json({ error: "Event too large" }, { status: 413 });
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const eventId = await verifyDodoWebhook(
      raw,
      request.headers,
      env.DODO_TEST_WEBHOOK_SECRET,
    );
    const event = envelope.parse(JSON.parse(raw));
    if (event.business_id !== env.DODO_TEST_BUSINESS_ID)
      throw new Error("Wrong business");
    const resourceIds = Object.fromEntries(
      ["payment_id", "subscription_id", "refund_id"].flatMap((key) =>
        typeof event.data[key] === "string" &&
        /^[\w-]{1,200}$/.test(event.data[key])
          ? [[key, event.data[key]]]
          : [],
      ),
    );
    const payload = JSON.stringify({
      eventId,
      type: event.type,
      eventAt: event.timestamp,
      bodyHash: await hashGuidance(raw),
      resourceIds,
    });
    const received = await repeatGuidanceRpc(rpc, "record_billing_test_event", {
      payload,
      signature: await signBillingTest(env.BILLING_TEST_ACTION_SECRET, payload),
    });
    if (received.error)
      return Response.json({ error: "Event not retained" }, { status: 503 });
    return Response.json({ received: true });
  } catch {
    return Response.json({ error: "Invalid webhook" }, { status: 401 });
  }
}
// Kept separate from webhook parsing. Callers must reconcile paid payment and
// subscription identities/periods with Dodo's test API before invoking the
// operator-only SQL fact reducer. An active subscription may be an unpaid trial.
export const billingTestApiOrigin = "https://test.dodopayments.com";
export const paidPeriodFactSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.literal("paid_period"),
    customerId: z.string().min(1),
    productId: z.string().min(1),
    subscriptionId: z.string().min(1),
    paymentId: z.string().min(1),
    paymentStatus: z.literal("succeeded"),
    paidAmountMinor: z.number().int().positive(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt));
