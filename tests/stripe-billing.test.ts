import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import StripeClient from "stripe";
import {
  stripeWebhook,
  stripeInvoiceFact,
  processStripeEvent,
  stripeCheckout,
  stripeCheckoutMode,
  stripeRedirect,
  type StripeBillingEnv,
} from "../apps/api/src/stripeBilling";
const env: StripeBillingEnv = {
  STRIPE_BILLING_ENABLED: "true",
  STRIPE_BILLING_MODE: "test",
  STRIPE_API_KEY: "rk_" + "test_synthetic_only",
  STRIPE_WEBHOOK_SECRET: "disposable-webhook-secret",
  STRIPE_ACTION_SECRET: "disposable-billing-action-secret".repeat(2),
  STRIPE_ACCOUNT_ID: "acct_fixture",
  STRIPE_PRICE_ID: "price_fixture",
  STRIPE_PRODUCT_ID: "prod_fixture",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_fixture",
  BILLING_RETURN_ORIGIN: "https://workspace.example.test",
};
function fixture() {
  const invoice = {
    id: "in_fixture",
    livemode: false,
    status: "paid",
    currency: "eur",
    amount_paid: 2400,
    amount_remaining: 0,
    total: 2400,
    billing_reason: "subscription_cycle",
    customer: "cus_fixture",
  };
  const line = {
    id: "il_fixture",
    quantity: 1,
    parent: {
      subscription_item_details: {
        subscription: "sub_fixture",
        proration: false,
      },
    },
    pricing: {
      price_details: { price: "price_fixture", product: "prod_fixture" },
    },
    period: { start: 1790000000, end: 1792592000 },
  };
  const charge = {
    id: "ch_fixture",
    livemode: false,
    amount: 2400,
    amount_refunded: 0,
    disputed: false,
    payment_intent: "pi_fixture",
  };
  const payment = {
    id: "inpay_fixture",
    livemode: false,
    amount_paid: 2400,
    currency: "eur",
    invoice: "in_fixture",
    payment: { payment_intent: "pi_fixture" },
  };
  const api = {
    accounts: { retrieveCurrent: async () => ({ id: "acct_fixture" }) },
    invoices: {
      retrieve: async () => invoice,
      listLineItems: async () => ({ has_more: false, data: [line] }),
    },
    subscriptions: {
      retrieve: async () => ({
        id: "sub_fixture",
        livemode: false,
        customer: "cus_fixture",
        status: "canceled",
        current_period_start: 1890000000,
        current_period_end: 1892592000,
      }),
      list: async () => ({ has_more: false, data: [] as object[] }),
    },
    invoicePayments: {
      list: async () => ({ has_more: false, data: [payment] }),
    },
    paymentIntents: {
      retrieve: async () => ({
        id: "pi_fixture",
        livemode: false,
        status: "succeeded",
        currency: "eur",
        amount_received: 2400,
        customer: "cus_fixture",
        latest_charge: "ch_fixture",
      }),
    },
    charges: { retrieve: async () => charge },
    events: {
      retrieve: async () => ({
        id: "evt_fixture",
        type: "invoice.paid",
        livemode: false,
        data: { object: { id: "in_fixture" } },
      }),
    },
  };
  return {
    invoice,
    line,
    charge,
    payment,
    api,
    client: api as unknown as StripeClient,
  };
}
test("Stripe verifies raw signatures and environment, bounds payloads, and acknowledges durable writes only", async () => {
  const client = new StripeClient("synthetic-only");
  const event = {
    id: "evt_fixture",
    object: "event",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: "invoice.paid",
    data: {
      object: { id: "in_fixture", customer_email: "private@example.test" },
    },
  };
  const raw = JSON.stringify(event);
  const make = (body = raw, timestamp = event.created, mode = false) =>
    new Request("https://workspace.example.test/api/billing/stripe/webhook", {
      method: "POST",
      headers: {
        "Stripe-Signature": `t=${timestamp},v1=${createHmac(
          "sha256",
          env.STRIPE_WEBHOOK_SECRET!,
        )
          .update(`${timestamp}.${mode ? body : raw}`)
          .digest("hex")}`,
      },
      body,
    });
  let writes = 0;
  const rpc = async (_name: string, args: Record<string, unknown>) => {
    writes++;
    assert.ok(!String(args.payload).includes("private@example"));
    return { data: {}, error: null };
  };
  assert.equal((await stripeWebhook(make(), rpc, {})).status, 404);
  assert.equal(
    (await stripeWebhook(make(raw + " "), rpc, env, client)).status,
    401,
  );
  assert.equal(
    (await stripeWebhook(make(raw, event.created - 301), rpc, env, client))
      .status,
    401,
  );
  assert.equal(
    (
      await stripeWebhook(
        make(JSON.stringify({ ...event, livemode: true }), event.created, true),
        rpc,
        env,
        client,
      )
    ).status,
    401,
  );
  assert.equal(
    (await stripeWebhook(make("x".repeat(64001)), rpc, env, client)).status,
    413,
  );
  assert.equal(writes, 0);
  assert.equal((await stripeWebhook(make(), rpc, env, client)).status, 200);
  assert.equal(writes, 1);
  assert.equal(
    (
      await stripeWebhook(
        make(),
        async () => ({ data: null, error: { code: "network" } }),
        env,
        client,
      )
    ).status,
    503,
  );
});
test("canonical invoice facts use immutable line periods and reject trials, prorations, foreign prices and unpaid money", async () => {
  const f = fixture();
  const fact = await stripeInvoiceFact(f.client, env, "in_fixture");
  assert.equal(fact.outcome, "paid");
  assert.equal(
    fact.startsAt,
    new Date(f.line.period.start * 1000).toISOString(),
  );
  f.line.parent.subscription_item_details.proration = true;
  await assert.rejects(
    stripeInvoiceFact(f.client, env, "in_fixture"),
    /unverified_invoice_period/,
  );
  f.line.parent.subscription_item_details.proration = false;
  f.line.pricing.price_details.price = "price_foreign";
  await assert.rejects(
    stripeInvoiceFact(f.client, env, "in_fixture"),
    /unverified_invoice_period/,
  );
  f.line.pricing.price_details.price = "price_fixture";
  f.invoice.amount_paid = 0;
  await assert.rejects(
    stripeInvoiceFact(f.client, env, "in_fixture"),
    /nonstandard_invoice/,
  );
  f.invoice.amount_paid = 2400;
  f.invoice.status = "open";
  assert.equal(
    (await stripeInvoiceFact(f.client, env, "in_fixture")).outcome,
    "ignored",
  );
  f.invoice.status = "paid";
  f.charge.amount_refunded = 2400;
  assert.deepEqual(await stripeInvoiceFact(f.client, env, "in_fixture"), {
    outcome: "refund",
    paymentId: "in_fixture",
    full: true,
    reason: "confirmed_refund",
  });
  f.charge.amount_refunded = 1200;
  assert.equal(
    (await stripeInvoiceFact(f.client, env, "in_fixture")).full,
    false,
  );
  f.invoice.livemode = true;
  await assert.rejects(
    stripeInvoiceFact(f.client, env, "in_fixture"),
    /environment_mismatch/,
  );
});
test("reconciliation distinguishes retryable transport failure from reviewable invoice mismatches", async () => {
  const f = fixture(),
    commands: Array<Record<string, unknown>> = [];
  const rpc = async (_name: string, args: Record<string, unknown>) => {
    const value = JSON.parse(String(args.payload));
    commands.push(value);
    return {
      data:
        value.action === "claim"
          ? { eventId: "evt_fixture", type: "invoice.paid" }
          : {},
      error: null,
    };
  };
  await processStripeEvent(rpc, env, f.client);
  assert.equal(commands.at(-1)?.outcome, "paid");
  f.invoice.amount_paid = 0;
  await processStripeEvent(rpc, env, f.client);
  assert.equal(commands.at(-1)?.outcome, "review");
  f.api.invoices.retrieve = async () => {
    throw new Error("transport failed");
  };
  await processStripeEvent(rpc, env, f.client);
  assert.equal(commands.at(-1)?.outcome, "retry");
  for (const code of ["PT409", "23505", "PT429"]) {
    const conflictRpc = async (name: string, args: Record<string, unknown>) => {
      const value = JSON.parse(String(args.payload));
      return value.outcome === "paid"
        ? { data: null, error: { code, message: "synthetic conflict" } }
        : rpc(name, args);
    };
    await processStripeEvent(conflictRpc, env, fixture().client);
    assert.equal(
      commands.at(-1)?.outcome,
      code === "PT429" ? "retry" : "review",
      "funding waits can recover; conflicting immutable facts require review",
    );
  }
});
test("Checkout uses server identities, inclusive monthly pricing, verified tax setup and one durable idempotency key", async () => {
  const f = fixture(),
    created: Array<Record<string, unknown>> = [],
    options: Array<Record<string, unknown>> = [];
  let taxReady = false;
  const extended = {
    ...f.api,
    prices: {
      retrieve: async () => ({
        id: "price_fixture",
        active: true,
        livemode: false,
        unit_amount: 2400,
        currency: "eur",
        tax_behavior: "inclusive",
        product: "prod_fixture",
        recurring: { interval: "month", interval_count: 1 },
      }),
    },
    tax: {
      settings: { retrieve: async () => ({ status: "active" }) },
      registrations: { list: async () => ({ data: taxReady ? [{}] : [] }) },
    },
    checkout: {
      sessions: {
        create: async (
          body: Record<string, unknown>,
          opts: Record<string, unknown>,
        ) => {
          created.push(body);
          options.push(opts);
          return {
            id: "cs_fixture",
            url: "https://checkout.stripe.com/c/pay/cs_fixture",
          };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async () => ({
          url: "https://billing.stripe.com/p/session/fixture",
        }),
      },
    },
  };
  const rpc = async (_name: string, args: Record<string, unknown>) => {
    const v = JSON.parse(String(args.payload));
    assert.equal(v.ownerId, "owner");
    return {
      data:
        v.action === "account"
          ? {
              customerId: "cus_fixture",
              priceId: "price_fixture",
              productId: "prod_fixture",
            }
          : v.action === "checkout_claim"
            ? { claimed: true, nonce: "durable-fixture" }
            : {},
      error: null,
    };
  };
  await assert.rejects(
    stripeCheckout(
      rpc,
      env,
      { id: "owner" },
      "checkout",
      extended as unknown as StripeClient,
    ),
    /tax setup/,
  );
  assert.equal(created.length, 0);
  taxReady = true;
  await stripeCheckout(
    rpc,
    env,
    { id: "owner" },
    "checkout",
    extended as unknown as StripeClient,
  );
  assert.equal(created[0].mode, "subscription");
  assert.deepEqual(created[0].line_items, [
    { price: "price_fixture", quantity: 1 },
  ]);
  assert.equal(created[0].customer, "cus_fixture");
  assert.equal(created[0].payment_method_types, undefined);
  assert.deepEqual(created[0].automatic_tax, { enabled: true });
  assert.equal(
    options[0].idempotencyKey,
    "woolgather:checkout:durable-fixture",
  );
  taxReady = false;
  extended.tax.settings.retrieve = async () => {
    throw new Error("External mode must not call Tax");
  };
  await stripeCheckout(
    rpc,
    { ...env, STRIPE_TAX_MODE: "external" },
    { id: "owner" },
    "checkout",
    extended as unknown as StripeClient,
  );
  assert.deepEqual(created[1].automatic_tax, { enabled: false });
  assert.equal(created[1].tax_rates, undefined);
  assert.equal(created[1].tax_exempt, undefined);
  await assert.rejects(
    stripeCheckout(
      rpc,
      { ...env, STRIPE_TAX_MODE: "typo" },
      { id: "owner" },
      "checkout",
      extended as unknown as StripeClient,
    ),
    /tax configuration/,
  );
  await assert.rejects(
    stripeCheckout(
      rpc,
      { ...env, STRIPE_CHECKOUT_OWNER_IDS: "someone-else" },
      { id: "owner" },
      "checkout",
      extended as unknown as StripeClient,
    ),
    /not open/,
  );
  assert.equal(
    stripeCheckoutMode({ ...env, STRIPE_CHECKOUT_OWNER_IDS: "owner" }, "owner"),
    "test",
  );
  assert.equal(
    stripeCheckoutMode({ ...env, STRIPE_CHECKOUT_OWNER_IDS: "" }, "owner"),
    "unavailable",
  );
  extended.subscriptions.list = async () => ({
    has_more: false,
    data: [{ status: "past_due" }],
  });
  const managed = await stripeCheckout(
    rpc,
    env,
    { id: "owner" },
    "checkout",
    extended as unknown as StripeClient,
  );
  assert.match(managed.url, /^https:\/\/billing\.stripe\.com\//);
  assert.equal(
    created.length,
    2,
    "an existing subscription opens management instead of creating a duplicate",
  );
  assert.throws(() => stripeRedirect("https://stripe.com.attacker.test/pay"));
  assert.throws(() => stripeRedirect("javascript:alert(1)"));
});
