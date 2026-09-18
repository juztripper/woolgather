import StripeClient from "stripe";
import {
  hashGuidance,
  repeatGuidanceRpc,
  type GuidanceRpc,
} from "./ideaGuidance";

export type StripeBillingEnv = {
  STRIPE_BILLING_ENABLED?: string;
  STRIPE_BILLING_MODE?: string;
  STRIPE_TAX_MODE?: string;
  STRIPE_CHECKOUT_OWNER_IDS?: string;
  STRIPE_API_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_ACTION_SECRET?: string;
  STRIPE_ACCOUNT_ID?: string;
  STRIPE_PRICE_ID?: string;
  STRIPE_PRODUCT_ID?: string;
  STRIPE_PORTAL_CONFIGURATION_ID?: string;
  BILLING_RETURN_ORIGIN?: string;
};
export function stripeBillingMode(
  env: StripeBillingEnv,
): "test" | "live" | "unavailable" {
  const mode = env.STRIPE_BILLING_MODE;
  return env.STRIPE_BILLING_ENABLED === "true" &&
    (mode === "test" || mode === "live") &&
    env.STRIPE_API_KEY?.startsWith(mode === "live" ? "rk_live_" : "rk_test_") &&
    env.STRIPE_WEBHOOK_SECRET &&
    env.STRIPE_ACTION_SECRET &&
    env.STRIPE_ACCOUNT_ID &&
    env.STRIPE_PRICE_ID &&
    env.STRIPE_PRODUCT_ID &&
    env.STRIPE_PORTAL_CONFIGURATION_ID &&
    env.BILLING_RETURN_ORIGIN
    ? mode
    : "unavailable";
}
export function stripeCheckoutMode(env: StripeBillingEnv, ownerId: string) {
  const allowed = env.STRIPE_CHECKOUT_OWNER_IDS;
  if (
    allowed !== undefined &&
    !allowed
      .split(",")
      .map((id) => id.trim())
      .includes(ownerId)
  )
    return "unavailable";
  return stripeBillingMode(env);
}
export function stripeClient(env: StripeBillingEnv) {
  if (stripeBillingMode(env) === "unavailable")
    throw new Error("Subscriptions are not open yet.");
  return new StripeClient(env.STRIPE_API_KEY!, {
    apiVersion: "2026-08-26.dahlia",
    httpClient: StripeClient.createFetchHttpClient(),
    maxNetworkRetries: 0,
    timeout: 4000,
  });
}
export async function signStripeBilling(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`woolgather.billing.plan.v1:${payload}`),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function billingCommand(
  rpc: GuidanceRpc,
  env: StripeBillingEnv,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify({
    ...value,
    environment: env.STRIPE_BILLING_MODE,
    accountId: env.STRIPE_ACCOUNT_ID,
  });
  const result = await repeatGuidanceRpc(rpc, "plan_billing_command", {
    payload,
    signature: await signStripeBilling(env.STRIPE_ACTION_SECRET!, payload),
  });
  if (result.error)
    throw new Error(
      "Billing could not be confirmed. Your existing access is kept; try again.",
      { cause: result.error },
    );
  return result.data as Record<string, unknown>;
}
const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;
export function stripeRedirect(value: unknown) {
  if (typeof value !== "string")
    throw new Error("The payment link is unavailable.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["checkout.stripe.com", "billing.stripe.com"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("The payment link could not be verified.");
  return url.href;
}
async function verifyAccount(stripe: StripeClient, env: StripeBillingEnv) {
  const account = await stripe.accounts.retrieveCurrent();
  if (account.id !== env.STRIPE_ACCOUNT_ID)
    throw new Error("The billing account could not be verified.");
}

export async function stripeCheckout(
  rpc: GuidanceRpc,
  env: StripeBillingEnv,
  owner: { id: string; email?: string },
  action: "checkout" | "portal",
  stripe = stripeClient(env),
) {
  if (
    action === "checkout" &&
    stripeCheckoutMode(env, owner.id) === "unavailable"
  )
    throw new Error("Subscriptions are not open yet.");
  const taxMode = env.STRIPE_TAX_MODE ?? "automatic";
  if (!["automatic", "external"].includes(taxMode))
    throw new Error("The subscription tax configuration is unavailable.");
  await verifyAccount(stripe, env);
  const origin = new URL(env.BILLING_RETURN_ORIGIN!);
  if (
    origin.protocol !== "https:" &&
    !(
      env.STRIPE_BILLING_MODE === "test" &&
      ["localhost", "127.0.0.1"].includes(origin.hostname)
    )
  )
    throw new Error("Checkout return address is unavailable.");
  const returnUrl = origin.origin + "/account/plan";
  const command = (value: Record<string, unknown>) =>
    billingCommand(rpc, env, { ...value, ownerId: owner.id });
  const setupId = crypto.randomUUID();
  let account = await command({ action: "account", setupId });
  if (!account.customerId) {
    if (action === "portal" || !account.createCustomer || !owner.email)
      throw new Error(
        "Your billing account is being checked. Try again shortly.",
      );
    const customer = await stripe.customers.create(
      { email: owner.email },
      { idempotencyKey: `woolgather:customer:${account.setupId}` },
    );
    if (customer.livemode !== (env.STRIPE_BILLING_MODE === "live"))
      throw new Error("Billing environment mismatch.");
    account = await command({
      action: "customer_saved",
      setupId: account.setupId,
      customerId: customer.id,
    });
  }
  if (
    account.priceId !== env.STRIPE_PRICE_ID ||
    account.productId !== env.STRIPE_PRODUCT_ID
  )
    throw new Error("The subscription offer is being checked.");
  const customer = String(account.customerId);
  // Query canonical subscriptions as well as our ledger. A lost webhook must
  // not let a second Checkout create a duplicate active subscription.
  const subscriptions = await stripe.subscriptions.list({
    customer,
    status: "all",
    limit: 100,
  });
  if (subscriptions.has_more)
    throw new Error("Your subscriptions need review.");
  if (
    action === "portal" ||
    subscriptions.data.some(
      (s) => !["canceled", "incomplete_expired"].includes(s.status),
    )
  ) {
    const portal = await stripe.billingPortal.sessions.create({
      customer,
      configuration: env.STRIPE_PORTAL_CONFIGURATION_ID,
      return_url: returnUrl,
    });
    return { url: stripeRedirect(portal.url) };
  }
  if (account.checkoutId) {
    const existing = await stripe.checkout.sessions.retrieve(
      String(account.checkoutId),
    );
    if (
      idOf(existing.customer) !== customer ||
      existing.livemode !== (env.STRIPE_BILLING_MODE === "live")
    )
      throw new Error("Checkout identity mismatch.");
    if (existing.status === "open")
      return { url: stripeRedirect(existing.url) };
    if (existing.status !== "expired") {
      const previous = subscriptions.data.find(
        (s) => s.id === idOf(existing.subscription),
      );
      if (
        existing.status !== "complete" ||
        !previous ||
        !["canceled", "incomplete_expired"].includes(previous.status)
      )
        throw new Error(
          "Your payment is being confirmed. Refresh your plan shortly.",
        );
    }
    await command({ action: "checkout_expired", checkoutId: existing.id });
  }
  const price = await stripe.prices.retrieve(env.STRIPE_PRICE_ID!);
  if (
    !price.active ||
    price.livemode !== (env.STRIPE_BILLING_MODE === "live") ||
    price.unit_amount !== 2400 ||
    price.currency !== "eur" ||
    price.tax_behavior !== "inclusive" ||
    idOf(price.product) !== env.STRIPE_PRODUCT_ID ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1
  )
    throw new Error("The subscription price is being checked.");
  // External handling is an explicit operator choice, never inferred from an
  // empty registration list and never represented as a tax exemption.
  if (taxMode === "automatic") {
    const [tax, registrations] = await Promise.all([
      stripe.tax.settings.retrieve(),
      stripe.tax.registrations.list({ status: "active", limit: 1 }),
    ]);
    if (tax.status !== "active" || !registrations.data.length)
      throw new Error(
        "Subscriptions are waiting for tax setup to be completed.",
      );
  }
  const claim = await command({ action: "checkout_claim", setupId });
  if (!claim.claimed)
    throw new Error("Checkout is being checked. Try again shortly.");
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer,
      line_items: [{ price: price.id, quantity: 1 }],
      automatic_tax: { enabled: taxMode === "automatic" },
      customer_update: { address: "auto" },
      billing_address_collection: "required",
      success_url: returnUrl + "?checkout=complete",
      cancel_url: returnUrl,
      integration_identifier: "woolgather_paid_qjfhkmnr",
    },
    { idempotencyKey: `woolgather:checkout:${claim.nonce}` },
  );
  const url = stripeRedirect(session.url);
  await command({ action: "checkout_saved", checkoutId: session.id, url });
  return { url };
}

export async function stripeWebhook(
  request: Request,
  rpc: GuidanceRpc,
  env: StripeBillingEnv,
  stripe = stripeBillingMode(env) === "unavailable"
    ? undefined
    : stripeClient(env),
) {
  if (!stripe) return Response.json({ error: "Not found" }, { status: 404 });
  if (request.method !== "POST")
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Empty event" }, { status: 400 });
  let bytes = 0,
    raw = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let event: StripeClient.Event;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 64000) {
        await reader.cancel();
        return Response.json({ error: "Event too large" }, { status: 413 });
      }
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
    const timestamp = Number(
      request.headers
        .get("Stripe-Signature")
        ?.match(/(?:^|,)t=(\d+)(?:,|$)/)?.[1],
    );
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 300
    )
      throw new Error("Stale webhook");
    event = await stripe.webhooks.constructEventAsync(
      raw,
      request.headers.get("Stripe-Signature") || "",
      env.STRIPE_WEBHOOK_SECRET!,
      300,
      StripeClient.createSubtleCryptoProvider(),
    );
    if (
      event.livemode !== (env.STRIPE_BILLING_MODE === "live") ||
      (event.account && event.account !== env.STRIPE_ACCOUNT_ID)
    )
      throw new Error("Wrong account or mode");
  } catch {
    return Response.json({ error: "Invalid webhook" }, { status: 401 });
  }
  try {
    await billingCommand(rpc, env, {
      action: "record",
      eventId: event.id,
      type: event.type,
      eventAt: new Date(event.created * 1000).toISOString(),
      bodyHash: await hashGuidance(raw),
      resourceIds: {
        id: "id" in event.data.object ? event.data.object.id : null,
      },
    });
    return Response.json({ received: true });
  } catch {
    return Response.json({ error: "Event not retained" }, { status: 503 });
  }
}

class ReviewRequired extends Error {}
const review = (reason: string): never => {
  throw new ReviewRequired(reason);
};
function sameMode(value: { livemode: boolean }, env: StripeBillingEnv) {
  if (value.livemode !== (env.STRIPE_BILLING_MODE === "live"))
    review("environment_mismatch");
}
export async function stripeInvoiceFact(
  stripe: StripeClient,
  env: StripeBillingEnv,
  invoiceId: string,
) {
  const invoice = await stripe.invoices.retrieve(invoiceId);
  sameMode(invoice, env);
  if (invoice.status !== "paid")
    return { outcome: "ignored", reason: "invoice_not_paid" };
  if (
    invoice.currency !== "eur" ||
    invoice.amount_paid !== 2400 ||
    invoice.total !== 2400 ||
    invoice.amount_remaining !== 0 ||
    !["subscription_create", "subscription_cycle"].includes(
      invoice.billing_reason || "",
    )
  )
    review("nonstandard_invoice");
  const lines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
  if (lines.has_more || lines.data.length !== 1)
    review("nonstandard_invoice_lines");
  const line = lines.data[0],
    parent = line.parent?.subscription_item_details;
  if (
    !parent?.subscription ||
    parent.proration ||
    line.quantity !== 1 ||
    line.pricing?.price_details?.price !== env.STRIPE_PRICE_ID ||
    idOf(line.pricing?.price_details?.product) !== env.STRIPE_PRODUCT_ID ||
    line.period.end <= line.period.start
  )
    review("unverified_invoice_period");
  const subscriptionId = parent!.subscription!;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  sameMode(subscription, env);
  if (idOf(subscription.customer) !== idOf(invoice.customer))
    review("invoice_customer_mismatch");
  // A canceled subscription can still have a valid historical paid invoice.
  // Its mutable current dates never determine this grant's start/end.
  const payments = await stripe.invoicePayments.list({
    invoice: invoice.id,
    status: "paid",
    limit: 100,
  });
  if (payments.has_more || payments.data.length !== 1)
    review("nonstandard_invoice_payments");
  const payment = payments.data[0];
  sameMode(payment, env);
  const intentId = idOf(payment.payment.payment_intent);
  if (payment.amount_paid !== 2400 || payment.currency !== "eur" || !intentId)
    review("unverified_invoice_payment");
  const intent = await stripe.paymentIntents.retrieve(intentId!);
  sameMode(intent, env);
  if (
    intent.status !== "succeeded" ||
    intent.amount_received !== 2400 ||
    intent.currency !== "eur" ||
    idOf(intent.customer) !== idOf(invoice.customer) ||
    !intent.latest_charge
  )
    review("unverified_payment");
  const charge = await stripe.charges.retrieve(idOf(intent.latest_charge)!);
  sameMode(charge, env);
  if (charge.disputed) review("payment_disputed");
  if (charge.amount_refunded > 0)
    return {
      outcome: "refund",
      paymentId: invoice.id,
      full: charge.amount_refunded >= charge.amount,
      reason: "confirmed_refund",
    };
  return {
    outcome: "paid",
    paymentId: invoice.id,
    paymentStatus: "succeeded",
    paidAmountMinor: invoice.amount_paid,
    currency: invoice.currency,
    customerId: idOf(invoice.customer),
    productId: env.STRIPE_PRODUCT_ID,
    subscriptionId,
    startsAt: new Date(line.period.start * 1000).toISOString(),
    endsAt: new Date(line.period.end * 1000).toISOString(),
    evidenceHash: await hashGuidance(
      JSON.stringify({
        invoice: invoice.id,
        line: line.id,
        period: line.period,
        payment: payment.id,
        intent: intent.id,
      }),
    ),
  };
}

export async function processStripeEvent(
  rpc: GuidanceRpc,
  env: StripeBillingEnv,
  stripe = stripeClient(env),
) {
  await verifyAccount(stripe, env);
  const event = await billingCommand(rpc, env, { action: "claim" });
  if (!event.eventId) return false;
  const finish = (fact: Record<string, unknown>) =>
    billingCommand(rpc, env, {
      action: "finish",
      eventId: event.eventId,
      ...fact,
    });
  try {
    const canonical = await stripe.events.retrieve(String(event.eventId));
    sameMode(canonical, env);
    if (
      canonical.type !== event.type ||
      (canonical.account && canonical.account !== env.STRIPE_ACCOUNT_ID)
    )
      review("event_identity_mismatch");
    const id = "id" in canonical.data.object ? canonical.data.object.id : "";
    if (String(event.type).startsWith("invoice.")) {
      await finish(await stripeInvoiceFact(stripe, env, id));
    } else if (String(event.type).startsWith("customer.subscription.")) {
      const subscription = await stripe.subscriptions.retrieve(id);
      sameMode(subscription, env);
      await finish({
        outcome: "subscription",
        customerId: idOf(subscription.customer),
        subscriptionId: subscription.id,
      });
    } else if (
      [
        "charge.refunded",
        "refund.updated",
        "refund.created",
        "charge.dispute.created",
        "charge.dispute.closed",
      ].includes(String(event.type))
    ) {
      let intentId: string | undefined;
      if (String(event.type).startsWith("refund.")) {
        const refund = await stripe.refunds.retrieve(id);
        if (refund.status !== "succeeded") {
          await finish({ outcome: "ignored" });
          return true;
        }
        intentId = idOf(refund.payment_intent);
      } else if (String(event.type).startsWith("charge.dispute.")) {
        const dispute = await stripe.disputes.retrieve(id);
        intentId = idOf(dispute.payment_intent);
      } else {
        const charge = await stripe.charges.retrieve(id);
        sameMode(charge, env);
        intentId = idOf(charge.payment_intent);
      }
      if (!intentId) review("refund_payment_missing");
      const payments = await stripe.invoicePayments.list({
        payment: { type: "payment_intent", payment_intent: intentId },
        limit: 100,
      });
      if (payments.has_more || payments.data.length !== 1)
        review("refund_invoice_ambiguous");
      await finish(
        await stripeInvoiceFact(stripe, env, idOf(payments.data[0].invoice)!),
      );
    } else await finish({ outcome: "ignored", reason: "no_allowance_effect" });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const factConflict =
      !!cause &&
      typeof cause === "object" &&
      "code" in cause &&
      ["PT409", "23505", "23514", "22023"].includes(String(cause.code));
    await finish({
      outcome:
        error instanceof ReviewRequired || factConflict ? "review" : "retry",
      reason:
        error instanceof ReviewRequired
          ? error.message
          : factConflict
            ? "conflicting_billing_fact"
            : "provider_or_storage_unavailable",
    });
  }
  return true;
}
