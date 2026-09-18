import test from "node:test";
import assert from "node:assert/strict";
import {
  planningTestDatabase,
  syntheticPlanningResponse,
} from "../scripts/planning-test-database";
import { planningWithAllowedScope } from "../scripts/fixtures/planning-scope";
import { accountPlan, planAction } from "../apps/api/src/plans";
import { billingCommand } from "../apps/api/src/stripeBilling";
import { defaultComposer } from "../packages/domain/src/planningComposer";
import { planRoute, actionCreditLimit } from "../packages/domain/src/plans";
import { thinkingOf } from "../packages/domain/src/projectPlanning";
import { signPlanning } from "../apps/api/src/projectPlanning";
import { signProjectVoice } from "../apps/api/src/projectVoice";
import type { Project } from "../packages/domain/src";

test("Free offers every effort on Luna; Paid can explicitly keep Luna", () => {
  assert.deepEqual(
    ["quick", "thoughtful", "deep"].map(
      (l) => planRoute(l as "quick", "free").effort,
    ),
    ["none", "medium", "high"],
  );
  assert.equal(planRoute("deep", "free").model, "gpt-5.6-luna");
  assert.equal(planRoute("deep", "paid").model, "gpt-5.6-sol");
  assert.equal(planRoute("deep", "paid", "luna").model, "gpt-5.6-luna");
  assert.equal(actionCreditLimit("deep", "gpt-5.6-luna", 7, true), 7);
});

test("disabled rollout tolerates an unapplied migration without masking enforced or authentication failures", async () => {
  const missing = async () => ({
    data: null,
    error: { code: "PGRST202", message: "Function is not installed" },
  });
  const beforeRollout = await accountPlan(missing, true);
  assert.equal(beforeRollout.enabled, false);
  assert.equal(beforeRollout.checkout, "unavailable");
  await assert.rejects(accountPlan(missing), /allowance could not be checked/);
  await assert.rejects(
    accountPlan(
      async () => ({ data: null, error: { code: "42501", message: "Denied" } }),
      true,
    ),
    /allowance could not be checked/,
  );
});

test("commercial credits reserve atomically, charge once per successful action and release failed work", async () => {
  const db = await planningTestDatabase(55460);
  try {
    await db.sql`update account_private.plan_settings set enabled=true,free_accounts_max=20,funding_microusd=100000000`;
    const plan = () => accountPlan(db.rpc);
    assert.equal((await plan()).credits, 300);
    assert.equal((await plan()).credits, 300, "welcome is issued once");
    const env = {
      PROJECT_PLANNING_ENABLED: "true",
      PLAN_ALLOWANCES_ENABLED: "true",
      OPENAI_API_KEY: "synthetic-only",
      ACCOUNT_ACTION_SECRET: db.secret,
    };
    let project = await db.createProject();
    const calls: Array<{ model: string; reasoning: { effort: string } }> = [];
    async function send(fail = false) {
      const response = await planningWithAllowedScope(
        db.rpc,
        db.settleRpc,
        env,
        db.owner,
        {
          action: "send",
          id: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          projectId: project.id,
          revision: project.revision,
          text: "Maybe a space to exchange our ideas.",
          composer: { ...defaultComposer(), reasoning: "deep" },
          maxCredits: 60,
        },
        async (_url, init) => {
          calls.push(JSON.parse(init!.body as string));
          const held = await plan();
          assert.equal(held.reservedCredits, 60);
          if (fail)
            return Response.json(
              { error: { message: "fixture failure" } },
              { status: 400 },
            );
          return syntheticPlanningResponse(init!.body as string);
        },
      );
      const body = (await response.json()) as {
        project: Project;
        notice?: string;
      };
      assert.equal(response.status, 200, JSON.stringify(body));
      project = body.project;
      return body;
    }
    await send();
    assert.equal(thinkingOf(project).turns.at(-1)?.status, "complete");
    assert.equal(calls[0].model, "gpt-5.6-luna");
    assert.equal(calls[0].reasoning.effort, "high");
    let balance = await plan();
    assert.equal(
      balance.credits,
      299,
      "admission and planner round up only once together",
    );
    assert.equal(
      balance.monthlyCredits,
      99,
      "expiring monthly credits are used before welcome credits",
    );
    assert.equal(balance.welcomeCredits, 200);
    assert.equal(balance.reservedCredits, 0);
    const before = (
      await db.sql`select spent_microusd from account_private.guidance_wallet`
    )[0].spent_microusd;
    await send(true);
    balance = await plan();
    assert.equal(
      balance.credits,
      299,
      "provider failure is not charged to customer",
    );
    assert.equal(balance.reservedCredits, 0);
    assert.ok(
      Number(
        (
          await db.sql`select spent_microusd from account_private.guidance_wallet`
        )[0].spent_microusd,
      ) > Number(before),
      "admission still costs the business",
    );
    const turnId = crypto.randomUUID();
    const pending = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        action: "turn",
        projectId: project.id,
        revision: project.revision,
        turnId,
        text: "A concurrent request",
        mode: "assist",
        composer: defaultComposer(),
      },
    });
    assert.equal(
      pending.error,
      null,
      pending.error?.message || "Expected a pending turn",
    );
    const reserve = (id: string) =>
      planAction(db.rpc, db.secret, db.owner, {
        action: "reserve",
        id,
        projectId: project.id,
        turnId,
        fingerprint: id,
        model: "gpt-5.6-luna",
        maxCredits: 200,
      });
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const concurrent = await Promise.all(ids.map(reserve));
    assert.equal(concurrent.filter((r) => !r.error).length, 1);
    const actionId = ids[concurrent.findIndex((r) => !r.error)];
    assert.equal((await plan()).reservedCredits, 200);
    const noSol = await reserve(crypto.randomUUID());
    assert.ok(noSol.error);
    const command = {
      action: "reserve",
      runId: crypto.randomUUID(),
      projectId: project.id,
      turnId,
      creditActionId: actionId,
      model: "gpt-5.6-sol",
      reserveMicrousd: 10,
    };
    const payload = JSON.stringify(command);
    const denied = await db.rpc("project_planning_budget", {
      payload,
      signature: await signPlanning(db.secret, db.owner, payload),
    });
    assert.equal(denied.error?.code, "PT403");
    // Old, never-started actions release customer holds; a delayed claim cannot
    // resurrect them after that release.
    await db.sql`update account_private.plan_actions set created_at=clock_timestamp()-interval '5 minutes' where id=${actionId}`;
    assert.equal((await plan()).reservedCredits, 0);
    const after = await planAction(db.rpc, db.secret, db.owner, {
      action: "allow",
      id: actionId,
    });
    assert.equal(after.error?.code, "PT409");
    await assert.rejects(
      db.sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select * from account_private.plan_grants`;
      }),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});

test("shared Free enrollment preserves credits without minting provider funds or bypassing exhausted money", async () => {
  const db = await planningTestDatabase(55460);
  try {
    await db.sql`update account_private.plan_settings set enabled=true,shared_free_capacity=true,free_accounts_max=null,funding_microusd=0`;
    await db.sql`update account_private.guidance_wallet set budget_microusd=10000,spent_microusd=9000,reserved_microusd=1000`;
    const before = (
      await db.sql`select * from account_private.guidance_wallet`
    )[0];
    for (let i = 0; i < 30; i++) {
      const id = crypto.randomUUID();
      await db.sql`insert into auth.users(id) values(${id})`;
      await db.sql`insert into auth.sessions(id,user_id) values(${id},${id})`;
      assert.equal((await accountPlan(db.rpcFor(id))).credits, 300);
      assert.equal((await accountPlan(db.rpcFor(id))).credits, 300);
    }
    assert.equal((await accountPlan(db.rpc)).credits, 300);
    assert.equal(
      (
        await db.sql`select count(*)::int n from account_private.plan_accounts`
      )[0].n,
      31,
    );
    assert.equal(
      (
        await db.sql`select issued_microusd from account_private.plan_settings`
      )[0].issued_microusd,
      "0",
    );
    assert.deepEqual(
      (await db.sql`select * from account_private.guidance_wallet`)[0],
      before,
    );
    const project = await db.createProject();
    let providerCalls = 0;
    await planningWithAllowedScope(
      db.rpc,
      db.settleRpc,
      {
        PROJECT_PLANNING_ENABLED: "true",
        PLAN_ALLOWANCES_ENABLED: "true",
        OPENAI_API_KEY: "synthetic-only",
        ACCOUNT_ACTION_SECRET: db.secret,
      },
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        text: "Help me plan a game about growing a garden.",
        composer: defaultComposer(),
        maxCredits: 20,
      },
      async () => {
        providerCalls++;
        throw new Error("Provider must not run with exhausted funds");
      },
    );
    assert.equal(providerCalls, 0);
    assert.equal((await accountPlan(db.rpc)).credits, 300);
    assert.deepEqual(
      (await db.sql`select * from account_private.guidance_wallet`)[0],
      before,
    );
    await db.sql`update account_private.plan_settings set free_accounts_max=31`;
    const capped = crypto.randomUUID();
    await db.sql`insert into auth.users(id) values(${capped})`;
    await db.sql`insert into auth.sessions(id,user_id) values(${capped},${capped})`;
    assert.equal((await accountPlan(db.rpcFor(capped))).credits, 0);
  } finally {
    await db.close();
  }
});

test("anniversary months keep their anchor and enrollment respects finite funded capacity", async () => {
  const db = await planningTestDatabase(55460);
  try {
    const rows =
      await db.sql`select (account_private.plan_month('2027-01-31T12:30:00Z','2027-02-28T12:31:00Z') at time zone 'UTC')::text feb,(account_private.plan_month('2027-01-31T12:30:00Z','2027-03-31T12:31:00Z') at time zone 'UTC')::text mar`;
    assert.match(rows[0].feb, /2027-02-28 12:30/);
    assert.match(rows[0].mar, /2027-03-31 12:30/);
    await db.sql`update account_private.plan_settings set enabled=true,free_accounts_max=1,funding_microusd=989999`;
    assert.equal((await accountPlan(db.rpc)).credits, 0);
    assert.equal(
      (
        await db.sql`select count(*)::integer n from account_private.plan_accounts`
      )[0].n,
      0,
    );
    await db.sql`update account_private.plan_settings set funding_microusd=2000000`;
    await accountPlan(db.rpc);
    await db.sql`update account_private.plan_accounts set anchor_at=clock_timestamp()-interval '2 months' where owner_id=${db.owner}`;
    await db.sql`update account_private.plan_grants set starts_at=clock_timestamp()-interval '2 months',ends_at=clock_timestamp()-interval '1 month' where owner_id=${db.owner} and kind='free'`;
    const renewed = await accountPlan(db.rpc);
    assert.equal(
      renewed.credits,
      300,
      "expired monthly credits do not accumulate; skipped months are not minted",
    );
    assert.equal(
      (
        await db.sql`select count(*)::integer n from account_private.plan_grants where kind='free'`
      )[0].n,
      2,
    );
  } finally {
    await db.close();
  }
});

test("Stripe grants are idempotent, test-isolated, renewal-safe and reversible by confirmed refund", async () => {
  const db = await planningTestDatabase(55460);
  try {
    const { sql } = db;
    await sql`update account_private.plan_settings set enabled=true,free_accounts_max=20,funding_microusd=100000000,storage_capacity_bytes=10737418240`;
    await accountPlan(db.rpc);
    await sql`update account_private.plan_billing_config set enabled=true,secret=${db.secret},account_id='acct_fixture',product_id='prod_fixture',price_id='price_fixture'`;
    for (const environment of ["test", "live"])
      await sql`insert into account_private.plan_billing_customers(environment,owner_id,customer_id,setup_id) values(${environment},${db.owner},'cus_fixture',${crypto.randomUUID()})`;
    const apply = async (
      environment: string,
      eventId: string,
      fact: Record<string, unknown>,
    ) => {
      const env = {
        STRIPE_BILLING_MODE: environment,
        STRIPE_ACCOUNT_ID: "acct_fixture",
        STRIPE_ACTION_SECRET: db.secret,
      };
      await billingCommand(db.settleRpc, env, {
        action: "record",
        eventId,
        type: "invoice.paid",
        eventAt: new Date().toISOString(),
        bodyHash: "a".repeat(64),
        resourceIds: { id: fact.paymentId },
      });
      return billingCommand(db.settleRpc, env, {
        action: "finish",
        eventId,
        ...fact,
      });
    };
    const now = Date.now();
    const paid = {
      outcome: "paid",
      paymentId: "in_fixture",
      paymentStatus: "succeeded",
      paidAmountMinor: 2400,
      currency: "eur",
      customerId: "cus_fixture",
      productId: "prod_fixture",
      subscriptionId: "sub_fixture",
      startsAt: new Date(now - 10000).toISOString(),
      endsAt: new Date(now + 30 * 86400000).toISOString(),
      evidenceHash: "b".repeat(64),
    };
    await apply("test", "evt_test", paid);
    assert.equal((await accountPlan(db.rpc)).tier, "free");
    assert.equal((await accountPlan(db.rpc)).credits, 300);
    await sql`update account_private.plan_settings set funding_microusd=0`;
    await assert.rejects(apply("live", "evt_live", paid));
    const walletBeforeShared =
      await sql`select budget_microusd,spent_microusd,reserved_microusd from account_private.guidance_wallet where id='openai'`;
    await sql`update account_private.plan_settings set shared_paid_capacity=true`;
    await apply("live", "evt_live", paid);
    assert.deepEqual(
      [
        ...(await sql`select budget_microusd,spent_microusd,reserved_microusd from account_private.guidance_wallet where id='openai'`),
      ],
      [...walletBeforeShared],
      "shared paid activation must not fund, spend or release provider money",
    );
    await apply("live", "evt_duplicate", paid);
    let plan = await accountPlan(db.rpc);
    assert.equal(plan.tier, "paid");
    assert.equal(plan.credits, 1800);
    assert.equal(plan.voiceSeconds, 1200);
    assert.equal(plan.storageLimitBytes, 1024 ** 3);
    assert.equal(
      (
        await sql`select count(*)::integer n from account_private.plan_grants where kind='paid' and environment='live'`
      )[0].n,
      1,
    );
    await apply("live", "evt_cancel", {
      outcome: "subscription",
      customerId: "cus_fixture",
      subscriptionId: "sub_fixture",
    });
    assert.equal(
      (await accountPlan(db.rpc)).tier,
      "paid",
      "cancellation retains the paid period",
    );
    await apply("live", "evt_partial", {
      outcome: "refund",
      paymentId: paid.paymentId,
      full: false,
    });
    assert.equal((await accountPlan(db.rpc)).tier, "paid");
    assert.equal(
      (
        await sql`select status from account_private.plan_billing_inbox where event_id='evt_partial'`
      )[0].status,
      "needs_review",
    );
    await apply("live", "evt_refund", {
      outcome: "refund",
      paymentId: paid.paymentId,
      full: true,
    });
    plan = await accountPlan(db.rpc);
    assert.equal(plan.tier, "free");
    assert.equal(plan.credits, 300);
    assert.equal(plan.voiceSeconds, 0);
    await apply("live", "evt_replay_after_refund", paid);
    assert.equal((await accountPlan(db.rpc)).tier, "free");
    await apply("live", "evt_refund_first", {
      outcome: "refund",
      paymentId: "in_next",
      full: true,
    });
    await apply("live", "evt_next", {
      ...paid,
      paymentId: "in_next",
      startsAt: new Date(now + 30 * 86400000).toISOString(),
      endsAt: new Date(now + 60 * 86400000).toISOString(),
    });
    assert.equal(
      (
        await sql`select revoked from account_private.plan_grants where payment_id='in_next'`
      )[0].revoked,
      true,
    );
    assert.equal(
      (
        await sql`select paid_voice_until from account_private.guidance_allowances where owner_id=${db.owner}`
      )[0].paid_voice_until,
      null,
    );
  } finally {
    await db.close();
  }
});

test("paid voice reserves remaining seconds and returns unused time without resetting provider holds", async () => {
  const db = await planningTestDatabase(55460);
  try {
    await db.sql`update account_private.plan_settings set enabled=true,free_accounts_max=20,funding_microusd=100000000`;
    await accountPlan(db.rpc);
    await db.sql`insert into account_private.plan_grants(id,owner_id,environment,kind,starts_at,ends_at,credits,voice_seconds,voice_spent) values('voice-period',${db.owner},'live','paid',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 month',1500,1200,1163)`;
    const project = await db.createProject();
    const reserve = async (seconds: number) => {
      const value = {
        action: "reserve",
        runId: crypto.randomUUID(),
        projectId: project.id,
        conversationId: "main",
        revision: project.revision,
        fingerprint: "a".repeat(64),
        capabilityHash: "b".repeat(64),
        model: "gpt-live-1",
        maxDurationSeconds: seconds,
        reserveMicrousd: Math.ceil(((seconds + 15) * 50000) / 60),
      };
      const payload = JSON.stringify(value),
        signature = await signProjectVoice(db.secret, db.owner, payload);
      const result = await db.sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select set_config('request.jwt.claim.sub',${db.owner},true)`;
        await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: db.owner, aal: "aal1" })},true)`;
        return (
          await tx`select public.project_voice_start(${payload},${signature}) d`
        )[0].d;
      });
      return { value, result };
    };
    await assert.rejects(reserve(38), /voice allowance/);
    const first = await reserve(37);
    assert.equal((await accountPlan(db.rpc)).voiceSeconds, 0);
    assert.equal((await accountPlan(db.rpc)).reservedVoiceSeconds, 37);
    await assert.rejects(reserve(1), /voice allowance/);
    await db.sql`update account_private.project_voice_sessions set status='completed',settled_at=clock_timestamp(),usage='{"seconds":12.5}'::jsonb where id=${first.value.runId}`;
    assert.equal((await accountPlan(db.rpc)).voiceSeconds, 24.5);
    assert.equal(
      (await accountPlan(db.rpc)).voiceSeconds,
      24.5,
      "time settles only once",
    );
    assert.equal((await accountPlan(db.rpc)).reservedVoiceSeconds, 0);
  } finally {
    await db.close();
  }
});

test("storage counts pending uploads and legacy images, with Paid expansion and non-destructive downgrade", async () => {
  const db = await planningTestDatabase(55460);
  try {
    const { sql } = db;
    await sql`update account_private.plan_settings set storage_capacity_bytes=2147483648`;
    for (let n = 0; n < 5; n++)
      await sql`insert into account_private.attachments(id,owner_id,name,mime_type,byte_size,sha256) values(${crypto.randomUUID()},${db.owner},${"file" + n},'application/octet-stream',${20 * 1024 ** 2},${"a".repeat(64)})`;
    const reserve = async (size: number) =>
      sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select set_config('request.jwt.claim.sub',${db.owner},true)`;
        await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: db.owner, aal: "aal1" })},true)`;
        return tx`select public.reserve_attachment(${tx.json({ id: crypto.randomUUID(), name: "additional", mime: "application/octet-stream", size, sha256: "b".repeat(64) })})`;
      });
    await assert.rejects(reserve(1), /storage allowance/);
    await assert.rejects(
      sql`insert into planning.reference_images(id,owner_id,mime_type,content) values(${crypto.randomUUID()},${db.owner},'image/png',decode('89504e470d0a1a0a00000000','hex'))`,
      /storage allowance/,
    );
    await sql`insert into account_private.plan_grants(id,owner_id,environment,kind,starts_at,ends_at,credits) values('storage-paid',${db.owner},'live','paid',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',1500)`;
    await reserve(1);
    assert.equal((await accountPlan(db.rpc)).storageBytes, 100 * 1024 ** 2 + 1);
    await sql`update account_private.plan_grants set revoked=true where id='storage-paid'`;
    await assert.rejects(reserve(1), /storage allowance/);
    assert.equal(
      (
        await sql`select count(*)::integer n from account_private.attachments where owner_id=${db.owner}`
      )[0].n,
      6,
      "downgrade never deletes existing files",
    );
  } finally {
    await db.close();
  }
});
