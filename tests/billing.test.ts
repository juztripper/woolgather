import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { createHmac } from "node:crypto";
import {
  verifyDodoWebhook,
  billingTestWebhook,
  signBillingTest,
} from "../apps/api/src/billing";
const secretBytes = Buffer.from("disposable-standard-webhook-test-secret"),
  secret = "whsec_" + secretBytes.toString("base64");
const raw = JSON.stringify({
  business_id: "test-business",
  type: "payment.succeeded",
  timestamp: new Date().toISOString(),
  data: { payment_id: "pay_test", email: "private@example.test" },
});
function headers(payload = raw, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secretBytes)
    .update(`msg_test.${timestamp}.${payload}`)
    .digest("base64");
  return new Headers({
    "webhook-id": "msg_test",
    "webhook-timestamp": String(timestamp),
    "webhook-signature": "v1," + signature,
  });
}
test("Dodo test webhooks verify exact bytes and timestamps, remain disabled, and acknowledge only durable writes", async () => {
  assert.equal(await verifyDodoWebhook(raw, headers(), secret), "msg_test");
  await assert.rejects(verifyDodoWebhook(raw + " ", headers(), secret));
  await assert.rejects(
    verifyDodoWebhook(
      raw,
      headers(raw, Math.floor(Date.now() / 1000) - 301),
      secret,
    ),
  );
  const make = () =>
    new Request("https://example.test/api/billing/test/webhook", {
      method: "POST",
      headers: headers(),
      body: raw,
    });
  const env = {
    BILLING_TEST_ENABLED: "true",
    DODO_TEST_WEBHOOK_SECRET: secret,
    DODO_TEST_BUSINESS_ID: "test-business",
    BILLING_TEST_ACTION_SECRET: "test-only",
  };
  let calls = 0;
  assert.equal(
    (
      await billingTestWebhook(make(), {}, async () => {
        throw new Error("must stay disabled");
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await billingTestWebhook(make(), env, async (_name, args) => {
        calls++;
        assert(!String(args.payload).includes("private@example.test"));
        return { data: {}, error: null };
      })
    ).status,
    200,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await billingTestWebhook(make(), env, async () => ({
        data: null,
        error: { code: "network" },
      }))
    ).status,
    503,
  );
  assert.equal(
    (
      await billingTestWebhook(
        make(),
        { ...env, DODO_TEST_BUSINESS_ID: "foreign" },
        async () => {
          throw new Error("wrong business");
        },
      )
    ).status,
    401,
  );
});
test("billing rehearsal is idempotent, order independent, private, and cannot grant spendable live allowance", async () => {
  const sql = postgres(process.env.TEST_DATABASE_URL!),
    owner = crypto.randomUUID(),
    other = crypto.randomUUID();
  const prefix = crypto.randomUUID(),
    customer = "customer_" + prefix,
    product = "product_" + prefix,
    payment = "payment_" + prefix,
    subscription = "sub_" + prefix;
  const signing = "billing-test-only-secret-".repeat(3);
  const apply = async (value: Record<string, string | number | boolean>) =>
    (
      await sql`select account_private.apply_billing_test_fact(${sql.json(value)}) d`
    )[0].d;
  try {
    await sql`insert into auth.users(id) values(${owner}),(${other})`;
    await sql`insert into account_private.billing_test_secrets(secret) values(${signing})`;
    await sql`insert into account_private.billing_test_customers values(${customer},${owner})`;
    await sql`insert into account_private.billing_test_products values(${product},50)`;
    const event = {
      eventId: "event_" + prefix,
      type: "payment.succeeded",
      eventAt: new Date().toISOString(),
      bodyHash: "a".repeat(64),
      resourceIds: { payment_id: payment },
    };
    const record = async (value: object, key = signing) => {
      const payload = JSON.stringify(value),
        signature = await signBillingTest(key, payload);
      return sql.begin(async (tx) => {
        await tx`set local role anon`;
        return tx`select public.record_billing_test_event(${payload},${signature})`;
      });
    };
    await assert.rejects(record(event, "wrong"), /signature/);
    await record(event);
    await record(event);
    assert.equal(
      (
        await sql`select deliveries from account_private.billing_test_inbox where event_id=${event.eventId}`
      )[0].deliveries,
      2,
    );
    await record({ ...event, bodyHash: "b".repeat(64) });
    assert.equal(
      (
        await sql`select status from account_private.billing_test_inbox where event_id=${event.eventId}`
      )[0].status,
      "needs_review",
    );
    const paid = {
      id: "fact_" + prefix,
      kind: "paid_period",
      customerId: customer,
      productId: product,
      subscriptionId: subscription,
      paymentId: payment,
      paymentStatus: "succeeded",
      paidAmountMinor: 1500,
      startsAt: "2026-09-01T00:00:00Z",
      endsAt: "2026-10-01T00:00:00Z",
    };
    await assert.rejects(
      apply({ ...paid, paidAmountMinor: 0 }),
      /verified paid/,
    );
    await apply(paid);
    assert.equal((await apply(paid)).replayed, true);
    await assert.rejects(apply({ ...paid, paidAmountMinor: 100 }), /conflict/);
    await apply({ ...paid, id: "duplicate-period_" + prefix });
    assert.equal(
      (
        await sql`select count(*) n from account_private.billing_test_grants where subscription_id=${subscription}`
      )[0].n,
      "1",
    );
    for (const reason of [
      "trial_active",
      "renewal_failed",
      "on_hold",
      "cancel_at_period_end",
    ])
      await apply({ id: reason + "_" + prefix, kind: "no_grant", reason });
    let periods =
      await sql`select max_reviews,environment from account_private.guidance_review_periods where owner_id=${owner}`;
    assert.equal(periods[0].max_reviews, 50);
    assert.equal(periods[0].environment, "test");
    assert.equal(
      (
        await sql`select count(*) n from account_private.guidance_review_periods where owner_id=${owner} and environment<>'test'`
      )[0].n,
      "0",
    );
    await apply({
      id: "partial_" + prefix,
      kind: "refund",
      paymentId: payment,
      refundStatus: "succeeded",
      full: false,
    });
    assert.equal(
      (
        await sql`select max_reviews from account_private.guidance_review_periods where owner_id=${owner}`
      )[0].max_reviews,
      50,
      "partial refund policy requires review, not an invented proportional credit rule",
    );
    await apply({
      id: "refund_" + prefix,
      kind: "refund",
      paymentId: payment,
      refundStatus: "succeeded",
      full: true,
    });
    assert.equal(
      (
        await sql`select max_reviews from account_private.guidance_review_periods where owner_id=${owner}`
      )[0].max_reviews,
      0,
    );
    const nextPayment = payment + "_next";
    await apply({
      id: "early-refund_" + prefix,
      kind: "refund",
      paymentId: nextPayment,
      refundStatus: "succeeded",
      full: true,
    });
    await apply({
      ...paid,
      id: "renewal_" + prefix,
      paymentId: nextPayment,
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "2026-11-01T00:00:00Z",
    });
    periods =
      await sql`select max_reviews from account_private.guidance_review_periods where owner_id=${owner}`;
    assert(periods.every((p) => p.max_reviews === 0));
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        return tx`select * from account_private.billing_test_inbox`;
      }),
      /permission denied/,
    );
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        return tx`select account_private.apply_billing_test_fact(${sql.json(paid)})`;
      }),
      /permission denied/,
    );
  } finally {
    await sql`delete from auth.users where id in (${owner},${other})`;
    await sql.end();
  }
});
