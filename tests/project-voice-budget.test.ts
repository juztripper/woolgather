import test from "node:test";
import assert from "node:assert/strict";
import {
  hashProjectVoice,
  signProjectVoice,
  signProjectVoiceSettlement,
} from "../apps/api/src/projectVoice";
import {
  signPlanning,
  signPlanningSettlement,
} from "../apps/api/src/projectPlanning";
import { planningTestDatabase } from "../scripts/planning-test-database";
import type { Project } from "../packages/domain/src";
import { thinkingOf } from "../packages/domain/src/projectPlanning";

type VoiceDatabase = Awaited<ReturnType<typeof planningTestDatabase>>;
type RpcResult = {
  data: unknown;
  error: { code?: string; message: string } | null;
};

async function voiceRpc(
  db: VoiceDatabase,
  who: string | null,
  name: string,
  payload: string,
  signature?: string,
): Promise<RpcResult> {
  try {
    const data = await db.sql.begin(async (tx) => {
      if (who) {
        await tx`set local role authenticated`;
        await tx`select set_config('request.jwt.claim.sub',${who},true)`;
        await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: who, aal: "aal1" })},true)`;
      } else await tx`set local role anon`;
      if (name === "project_voice_history") {
        const value = JSON.parse(payload) as {
          projectId: string;
          conversationId: string;
        };
        return (
          await tx`select public.project_voice_history(${value.projectId},${value.conversationId}) d`
        )[0].d;
      }
      if (!signature) throw new Error(`Missing signature for ${name}`);
      if (name === "project_voice_start")
        return (
          await tx`select public.project_voice_start(${payload},${signature}) d`
        )[0].d;
      if (name === "project_voice_prepare")
        return (
          await tx`select public.project_voice_prepare(${payload},${signature}) d`
        )[0].d;
      if (name === "project_voice_claim")
        return (
          await tx`select public.project_voice_claim(${payload},${signature}) d`
        )[0].d;
      if (name === "project_voice_stop")
        return (
          await tx`select public.project_voice_stop(${payload},${signature}) d`
        )[0].d;
      if (name === "project_voice_status")
        return (
          await tx`select public.project_voice_status(${payload},${signature}) d`
        )[0].d;
      if (name === "settle_project_voice")
        return (
          await tx`select public.settle_project_voice(${payload},${signature}) d`
        )[0].d;
      throw new Error(`Unsupported voice RPC: ${name}`);
    });
    return { data, error: null };
  } catch (error) {
    return {
      data: null,
      error: {
        code: (error as { code?: string }).code,
        message: (error as Error).message,
      },
    };
  }
}

async function ownerVoiceRpc(
  db: VoiceDatabase,
  name: string,
  value: Record<string, unknown>,
) {
  const payload = JSON.stringify(value);
  return voiceRpc(
    db,
    db.owner,
    name,
    payload,
    await signProjectVoice(db.secret, db.owner, payload),
  );
}

async function settlementRpc(
  db: VoiceDatabase,
  value: Record<string, unknown>,
) {
  const payload = JSON.stringify(value);
  return voiceRpc(
    db,
    null,
    "settle_project_voice",
    payload,
    await signProjectVoiceSettlement(db.secret, payload),
  );
}

async function historyRpc(
  db: VoiceDatabase,
  who: string | null,
  projectId: string,
  conversationId = "main",
) {
  return voiceRpc(
    db,
    who,
    "project_voice_history",
    JSON.stringify({ projectId, conversationId }),
  );
}

async function reservePayload(
  project: Project,
  runId: string,
  fingerprint: string,
  capability: string,
) {
  return {
    action: "reserve",
    runId,
    projectId: project.id,
    conversationId: "main",
    revision: project.revision,
    fingerprint,
    model: "gpt-live-1",
    maxDurationSeconds: 60,
    reserveMicrousd: 62500,
    capabilityHash: await hashProjectVoice(capability),
  };
}

async function stopVoice(db: VoiceDatabase, project: Project, runId: string) {
  return ownerVoiceRpc(db, "project_voice_stop", {
    action: "stop",
    runId,
    projectId: project.id,
    revision: project.revision,
  });
}

async function createPendingTurn(db: VoiceDatabase) {
  let project = await db.createProject("A project with a pending turn.");
  const turn = await db.rpc("project_planning_command", {
    command: {
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "turn",
      turnId: crypto.randomUUID(),
      text: "Keep this thought pending while the budget is checked.",
      mode: "assist",
      focusId: null,
    },
  });
  assert.equal(turn.error, null, turn.error?.message ?? "");
  project = turn.data as Project;
  return project;
}

test("voice reserves the shared allowance, replays runId, and permits a new same-context run", async () => {
  const db = await planningTestDatabase(55470);
  try {
    await db.sql`
      update account_private.guidance_allowances
      set budget_microusd=100000, max_requests=0
      where owner_id=${db.owner}
    `;
    const project = await createPendingTurn(db);
    const planningRunId = crypto.randomUUID();
    const planningAttemptId = crypto.randomUUID();
    const planningCapability = crypto.randomUUID() + crypto.randomUUID();
    const planningPayload = JSON.stringify({
      action: "reserve",
      runId: planningRunId,
      projectId: project.id,
      turnId: thinkingOf(project).turns[0].id,
      revision: project.revision,
      fingerprint: "1".repeat(64),
      model: "gpt-5.6-luna",
      maxOutputTokens: 800,
      reserveMicrousd: 75000,
      capabilityHash: await hashProjectVoice(planningCapability),
    });
    const planned = await db.rpc("project_planning_budget", {
      payload: planningPayload,
      signature: await signPlanning(db.secret, db.owner, planningPayload),
    });
    assert.equal(planned.error?.code, "PT429");
    await db.sql`update account_private.guidance_allowances set testing_request_exempt=true where owner_id=${db.owner}`;
    const exemptPlanned = await db.rpc("project_planning_budget", {
      payload: planningPayload,
      signature: await signPlanning(db.secret, db.owner, planningPayload),
    });
    assert.equal(exemptPlanned.error, null, exemptPlanned.error?.message ?? "");

    const fingerprint = "a".repeat(64);
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const runId = crypto.randomUUID();
    const firstPayload = await reservePayload(
      project,
      runId,
      fingerprint,
      capability,
    );
    const blocked = await ownerVoiceRpc(
      db,
      "project_voice_start",
      firstPayload,
    );
    assert.equal(blocked.error?.code, "PT429");
    const blockedRows = await db.sql`
      select count(*)::int as count
      from account_private.project_voice_sessions
      where project_id=${project.id}
    `;
    assert.equal(
      blockedRows[0].count,
      0,
      "failed admission creates no voice row",
    );

    const planningClaimPayload = JSON.stringify({
      action: "claim",
      runId: planningRunId,
      attemptId: planningAttemptId,
    });
    const planningClaim = await db.rpc("project_planning_budget", {
      payload: planningClaimPayload,
      signature: await signPlanning(db.secret, db.owner, planningClaimPayload),
    });
    assert.equal(planningClaim.error, null, planningClaim.error?.message ?? "");
    const planningSettlement = JSON.stringify({
      runId: planningRunId,
      attemptId: planningAttemptId,
      capability: planningCapability,
      status: "failed",
      errorCode: "synthetic_budget_test",
      usage: {
        model: "gpt-5.6-luna",
        serviceTier: "default",
        priceVersion: "2026-09-11",
        inputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costMicrousd: 0,
        latencyMs: 0,
      },
    });
    const settledPlanning = await db.settleRpc("settle_project_planning", {
      payload: planningSettlement,
      signature: await signPlanningSettlement(db.secret, planningSettlement),
    });
    assert.equal(
      settledPlanning.error,
      null,
      settledPlanning.error?.message ?? "",
    );

    const admitted = await ownerVoiceRpc(
      db,
      "project_voice_start",
      firstPayload,
    );
    assert.equal(admitted.error, null, admitted.error?.message ?? "");
    assert.equal((admitted.data as { created: boolean }).created, true);
    const replay = await ownerVoiceRpc(db, "project_voice_start", firstPayload);
    assert.equal(replay.error, null, replay.error?.message ?? "");
    assert.equal((replay.data as { created: boolean }).created, false);
    assert.equal((replay.data as { replayed: boolean }).replayed, true);

    const countersDuring = await db.sql`
      select w.reserved_microusd as wallet_reserved,
             a.reserved_microusd as allowance_reserved
      from account_private.guidance_wallet w
      join account_private.guidance_allowances a on a.owner_id=${db.owner}
      where w.id='openai'
    `;
    assert.equal(Number(countersDuring[0].wallet_reserved), 62500);
    assert.equal(Number(countersDuring[0].allowance_reserved), 62500);
    assert.deepEqual(await stopVoice(db, project, runId), {
      data: { status: "cancelled", runId },
      error: null,
    });

    const secondRun = crypto.randomUUID();
    const secondCapability = crypto.randomUUID() + crypto.randomUUID();
    const second = await ownerVoiceRpc(
      db,
      "project_voice_start",
      await reservePayload(project, secondRun, fingerprint, secondCapability),
    );
    assert.equal(second.error, null, second.error?.message ?? "");
    assert.equal((second.data as { created: boolean }).created, true);
    assert.deepEqual(await stopVoice(db, project, secondRun), {
      data: { status: "cancelled", runId: secondRun },
      error: null,
    });
    const countersAfter = await db.sql`
      select w.reserved_microusd as wallet_reserved,
             a.reserved_microusd as allowance_reserved
      from account_private.guidance_wallet w
      join account_private.guidance_allowances a on a.owner_id=${db.owner}
      where w.id='openai'
    `;
    assert.equal(Number(countersAfter[0].wallet_reserved), 0);
    assert.equal(Number(countersAfter[0].allowance_reserved), 0);
  } finally {
    await db.close();
  }
});

test("voice unknown keeps its hold until signed provider close and authoritative usage", async () => {
  const db = await planningTestDatabase(55471);
  try {
    const project = await db.createProject("Voice reconciliation.");
    const runId = crypto.randomUUID();
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const reserved = await ownerVoiceRpc(
      db,
      "project_voice_start",
      await reservePayload(project, runId, "b".repeat(64), capability),
    );
    assert.equal(reserved.error, null, reserved.error?.message ?? "");
    const attemptId = crypto.randomUUID();
    const claim = await ownerVoiceRpc(db, "project_voice_claim", {
      action: "claim",
      runId,
      projectId: project.id,
      revision: project.revision,
      attemptId,
      capability,
      providerSessionId: "live_test_session_1",
    });
    assert.equal(claim.error, null, claim.error?.message ?? "");
    assert.equal((claim.data as { claimed: boolean }).claimed, true);

    const unknown = await settlementRpc(db, {
      runId,
      attemptId,
      capability,
      status: "unknown",
      durationSeconds: 0,
      errorCode: "synthetic_close_lost",
    });
    assert.deepEqual(unknown, {
      data: { settled: false, status: "unknown", providerClosed: false },
      error: null,
    });
    const held = await db.sql`
      select s.status, s.settled_at, w.reserved_microusd as wallet_reserved,
             w.spent_microusd as wallet_spent, a.reserved_microusd as allowance_reserved
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      join account_private.guidance_allowances a on a.owner_id=${db.owner}
      where s.id=${runId}
    `;
    assert.equal(held[0].status, "unknown");
    assert.equal(held[0].settled_at, null);
    assert.equal(Number(held[0].wallet_reserved), 62500);
    assert.equal(Number(held[0].wallet_spent), 0);
    assert.equal(Number(held[0].allowance_reserved), 62500);

    const finalPayload = {
      runId,
      attemptId,
      capability,
      status: "completed",
      providerClosed: true,
      durationSeconds: 10,
      usage: { seconds: 10 },
      transcript: [
        { speaker: "user", text: "Keep this note.", startMs: 0, endMs: 250 },
        {
          speaker: "assistant",
          text: "I kept the note in context.",
          startMs: 300,
          endMs: 900,
        },
      ],
    };
    const [finalOne, finalTwo] = await Promise.all([
      settlementRpc(db, finalPayload),
      settlementRpc(db, finalPayload),
    ]);
    assert.deepEqual(finalOne, {
      data: { settled: true, status: "completed", actualMicrousd: 12500 },
      error: null,
    });
    assert.deepEqual(finalTwo, finalOne);
    const completed = await db.sql`
      select s.status, s.actual_microusd, s.settled_at,
             w.reserved_microusd as wallet_reserved, w.spent_microusd as wallet_spent,
             a.reserved_microusd as allowance_reserved, a.spent_microusd as allowance_spent
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      join account_private.guidance_allowances a on a.owner_id=${db.owner}
      where s.id=${runId}
    `;
    assert.equal(completed[0].status, "completed");
    assert.equal(Number(completed[0].actual_microusd), 12500);
    assert.ok(completed[0].settled_at);
    assert.equal(Number(completed[0].wallet_reserved), 0);
    assert.equal(Number(completed[0].wallet_spent), 12500);
    assert.equal(Number(completed[0].allowance_reserved), 0);
    assert.equal(Number(completed[0].allowance_spent), 12500);

    const conflict = await settlementRpc(db, {
      ...finalPayload,
      reason: "different final receipt",
    });
    assert.equal(conflict.error?.code, "PT409");

    const lateRunId = crypto.randomUUID();
    const lateCapability = crypto.randomUUID() + crypto.randomUUID();
    const late = await ownerVoiceRpc(
      db,
      "project_voice_start",
      await reservePayload(project, lateRunId, "c".repeat(64), lateCapability),
    );
    assert.equal(late.error, null, late.error?.message ?? "");
    await db.sql`
      update account_private.project_voice_sessions
      set expires_at=clock_timestamp()-interval '1 second'
      where id=${lateRunId}
    `;
    const lateAttempt = crypto.randomUUID();
    const lateClaim = await ownerVoiceRpc(db, "project_voice_claim", {
      action: "claim",
      runId: lateRunId,
      projectId: project.id,
      revision: project.revision,
      attemptId: lateAttempt,
      capability: lateCapability,
      providerSessionId: "live_late_claim",
    });
    assert.equal(lateClaim.error, null, lateClaim.error?.message ?? "");
    assert.equal((lateClaim.data as { claimed: boolean }).claimed, false);
    assert.equal((lateClaim.data as { status: string }).status, "unknown");
    const lateUnknown = await settlementRpc(db, {
      runId: lateRunId,
      attemptId: lateAttempt,
      capability: lateCapability,
      status: "unknown",
      durationSeconds: 0,
      errorCode: "late_claim_test",
    });
    assert.equal(lateUnknown.error, null, lateUnknown.error?.message ?? "");
    const lateFinal = await settlementRpc(db, {
      runId: lateRunId,
      attemptId: lateAttempt,
      capability: lateCapability,
      status: "failed",
      providerClosed: true,
      durationSeconds: 0,
      usage: { seconds: 0 },
      errorCode: "provider_closed_without_audio",
    });
    assert.equal(lateFinal.error, null, lateFinal.error?.message ?? "");
    assert.deepEqual(lateFinal.data, {
      settled: true,
      status: "failed",
      actualMicrousd: 12500,
    });
  } finally {
    await db.close();
  }
});

test("a verified terminal provider receipt settles a reserved run after claim loss", async () => {
  const db = await planningTestDatabase(55473);
  try {
    const project = await db.createProject("Voice claim race.");
    const runId = crypto.randomUUID();
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const providerSessionId = "live_claim_lost";
    const attemptId = crypto.randomUUID();
    const reserved = await ownerVoiceRpc(
      db,
      "project_voice_start",
      await reservePayload(project, runId, "d".repeat(64), capability),
    );
    assert.equal(reserved.error, null, reserved.error?.message ?? "");
    const preparePayload = {
      action: "prepare",
      runId,
      projectId: project.id,
      revision: project.revision,
      attemptId,
      capability,
    };
    const prepared = await ownerVoiceRpc(
      db,
      "project_voice_prepare",
      preparePayload,
    );
    assert.equal(prepared.error, null, prepared.error?.message ?? "");
    assert.deepEqual(prepared.data, {
      prepared: true,
      started: false,
      replayed: false,
      runId,
      status: "reserved",
      expiresAt: (prepared.data as { expiresAt: number }).expiresAt,
    });
    const preparedReplay = await ownerVoiceRpc(
      db,
      "project_voice_prepare",
      preparePayload,
    );
    assert.equal(
      preparedReplay.error,
      null,
      preparedReplay.error?.message ?? "",
    );
    assert.equal(
      (preparedReplay.data as { prepared: boolean }).prepared,
      false,
    );
    assert.equal((preparedReplay.data as { started: boolean }).started, false);
    assert.equal((preparedReplay.data as { replayed: boolean }).replayed, true);
    const wrongPreparation = await ownerVoiceRpc(db, "project_voice_prepare", {
      ...preparePayload,
      attemptId: crypto.randomUUID(),
    });
    assert.equal(wrongPreparation.error?.code, "PT409");

    // A signed receipt without provider-close confirmation cannot turn a
    // still-reserved run into usage, even when it includes an external id.
    const unverified = await settlementRpc(db, {
      runId,
      attemptId,
      capability,
      providerSessionId,
      status: "completed",
      durationSeconds: 10,
      usage: { seconds: 10 },
      providerClosed: false,
    });
    assert.equal(unverified.error?.code, "PT409");
    const held = await db.sql`
      select s.status, s.provider_session_id, s.settled_at,
             w.reserved_microusd as wallet_reserved,
             w.spent_microusd as wallet_spent,
             a.reserved_microusd as allowance_reserved
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      join account_private.guidance_allowances a on a.owner_id=${db.owner}
      where s.id=${runId}
    `;
    assert.equal(held[0].status, "reserved");
    assert.equal(held[0].provider_session_id, null);
    assert.equal(held[0].settled_at, null);
    assert.equal(Number(held[0].wallet_reserved), 62500);
    assert.equal(Number(held[0].wallet_spent), 0);
    assert.equal(Number(held[0].allowance_reserved), 62500);

    // Stop after prepare cannot refund a reservation while the provider POST
    // may still be in flight. It changes the run to unknown and keeps the
    // hold for the later terminal provider receipt.
    const stopped = await stopVoice(db, project, runId);
    assert.deepEqual(stopped, {
      data: { status: "unknown", runId, providerSessionId: null },
      error: null,
    });
    const heldAfterStop = await db.sql`
      select s.status, s.provider_session_id, s.settled_at,
             w.reserved_microusd as wallet_reserved,
             a.reserved_microusd as allowance_reserved
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      join account_private.guidance_allowances a on a.owner_id=${db.owner}
      where s.id=${runId}
    `;
    assert.equal(heldAfterStop[0].status, "unknown");
    assert.equal(heldAfterStop[0].provider_session_id, null);
    assert.equal(heldAfterStop[0].settled_at, null);
    assert.equal(Number(heldAfterStop[0].wallet_reserved), 62500);
    assert.equal(Number(heldAfterStop[0].allowance_reserved), 62500);

    // This is the receipt the DO can send after provider creation succeeded
    // but the authenticated claim request was lost. The two concurrent
    // deliveries must bind the id and debit the reservation once.
    const terminal = {
      runId,
      attemptId,
      capability,
      providerSessionId,
      status: "failed",
      providerClosed: true,
      durationSeconds: 0,
      usage: { seconds: 0 },
      errorCode: "voice_claim_lost",
    };
    const [first, second] = await Promise.all([
      settlementRpc(db, terminal),
      settlementRpc(db, terminal),
    ]);
    assert.deepEqual(first, {
      data: { settled: true, status: "failed", actualMicrousd: 12500 },
      error: null,
    });
    assert.deepEqual(second, first);

    const settled = await db.sql`
      select s.status, s.provider_session_id, s.attempt_id, s.settled_at,
             s.actual_microusd,
             w.reserved_microusd as wallet_reserved,
             w.spent_microusd as wallet_spent,
             a.reserved_microusd as allowance_reserved,
             a.spent_microusd as allowance_spent
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      join account_private.guidance_allowances a on a.owner_id=${db.owner}
      where s.id=${runId}
    `;
    assert.equal(settled[0].status, "failed");
    assert.equal(settled[0].provider_session_id, providerSessionId);
    assert.equal(settled[0].attempt_id, attemptId);
    assert.ok(settled[0].settled_at);
    assert.equal(Number(settled[0].actual_microusd), 12500);
    assert.equal(Number(settled[0].wallet_reserved), 0);
    assert.equal(Number(settled[0].wallet_spent), 12500);
    assert.equal(Number(settled[0].allowance_reserved), 0);
    assert.equal(Number(settled[0].allowance_spent), 12500);

    // Binding the provider id and terminal status closes the claim race. A
    // late authenticated claim cannot resurrect the settled run.
    const lateClaim = await ownerVoiceRpc(db, "project_voice_claim", {
      action: "claim",
      runId,
      projectId: project.id,
      revision: project.revision,
      attemptId,
      capability,
      providerSessionId,
    });
    assert.equal(lateClaim.error?.code, "PT425");
  } finally {
    await db.close();
  }
});

test("prepared expiry retains the reservation for provider reconciliation", async () => {
  const db = await planningTestDatabase(55475);
  try {
    const project = await db.createProject("Voice prepare expiry.");
    const runId = crypto.randomUUID();
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const reserve = await reservePayload(
      project,
      runId,
      "7".repeat(64),
      capability,
    );
    const admitted = await ownerVoiceRpc(db, "project_voice_start", reserve);
    assert.equal(admitted.error, null, admitted.error?.message ?? "");
    const prepared = await ownerVoiceRpc(db, "project_voice_prepare", {
      action: "prepare",
      runId,
      projectId: project.id,
      revision: project.revision,
      attemptId,
      capability,
    });
    assert.equal(prepared.error, null, prepared.error?.message ?? "");
    await db.sql`
      update account_private.project_voice_sessions
      set expires_at=clock_timestamp()-interval '1 second'
      where id=${runId}
    `;
    const reconciled = await ownerVoiceRpc(db, "project_voice_start", reserve);
    assert.equal(reconciled.error, null, reconciled.error?.message ?? "");
    assert.equal((reconciled.data as { status: string }).status, "unknown");
    const held = await db.sql`
      select s.status, s.settled_at,
             w.reserved_microusd as wallet_reserved,
             a.reserved_microusd as allowance_reserved
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      join account_private.guidance_allowances a on a.owner_id=${db.owner}
      where s.id=${runId}
    `;
    assert.equal(held[0].status, "unknown");
    assert.equal(held[0].settled_at, null);
    assert.equal(Number(held[0].wallet_reserved), 62500);
    assert.equal(Number(held[0].allowance_reserved), 62500);

    const finalized = await settlementRpc(db, {
      runId,
      attemptId,
      capability,
      providerSessionId: "live_prepare_expired",
      status: "failed",
      providerClosed: true,
      durationSeconds: 0,
      usage: { seconds: 0 },
      errorCode: "provider_closed_after_prepare_expiry",
    });
    assert.deepEqual(finalized, {
      data: { settled: true, status: "failed", actualMicrousd: 12500 },
      error: null,
    });
  } finally {
    await db.close();
  }
});

test("voice settlement accepts fractional final seconds and status exposes the authoritative charge", async () => {
  const db = await planningTestDatabase(55474);
  try {
    const project = await db.createProject("Voice fractional billing.");
    const runId = crypto.randomUUID();
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const providerSessionId = "live_fractional";
    const reserved = await ownerVoiceRpc(
      db,
      "project_voice_start",
      await reservePayload(project, runId, "e".repeat(64), capability),
    );
    assert.equal(reserved.error, null, reserved.error?.message ?? "");
    const claim = await ownerVoiceRpc(db, "project_voice_claim", {
      action: "claim",
      runId,
      projectId: project.id,
      revision: project.revision,
      attemptId,
      capability,
      providerSessionId,
    });
    assert.equal(claim.error, null, claim.error?.message ?? "");

    const fractional = await settlementRpc(db, {
      runId,
      attemptId,
      capability,
      providerSessionId,
      status: "completed",
      providerClosed: true,
      durationSeconds: 15.5,
      usage: { seconds: 15.5 },
    });
    assert.deepEqual(fractional, {
      data: { settled: true, status: "completed", actualMicrousd: 12917 },
      error: null,
    });
    const status = await ownerVoiceRpc(db, "project_voice_status", {
      action: "status",
      runId,
      projectId: project.id,
      revision: project.revision,
    });
    assert.equal(status.error, null, status.error?.message ?? "");
    assert.equal(
      (status.data as { durationSeconds: number }).durationSeconds,
      15.5,
    );
    assert.equal(
      (status.data as { actualMicrousd: number }).actualMicrousd,
      12917,
    );

    const invalidRunId = crypto.randomUUID();
    const invalidCapability = crypto.randomUUID() + crypto.randomUUID();
    const invalidAttemptId = crypto.randomUUID();
    const invalidProviderSessionId = "live_invalid_fractional";
    const invalidReserved = await ownerVoiceRpc(
      db,
      "project_voice_start",
      await reservePayload(
        project,
        invalidRunId,
        "f".repeat(64),
        invalidCapability,
      ),
    );
    assert.equal(
      invalidReserved.error,
      null,
      invalidReserved.error?.message ?? "",
    );
    const invalidDuration = await settlementRpc(db, {
      runId: invalidRunId,
      attemptId: invalidAttemptId,
      capability: invalidCapability,
      providerSessionId: invalidProviderSessionId,
      status: "completed",
      providerClosed: true,
      durationSeconds: "15.5x",
      usage: { seconds: 15.5 },
    });
    assert.equal(invalidDuration.error?.code, "22023");
    const invalidUsage = await settlementRpc(db, {
      runId: invalidRunId,
      attemptId: invalidAttemptId,
      capability: invalidCapability,
      providerSessionId: invalidProviderSessionId,
      status: "completed",
      providerClosed: true,
      durationSeconds: 15.5,
      usage: { seconds: "15.5x" },
    });
    assert.equal(invalidUsage.error?.code, "22023");
    const stillReserved = await db.sql`
      select status, provider_session_id, settled_at
      from account_private.project_voice_sessions
      where id=${invalidRunId}
    `;
    assert.equal(stillReserved[0].status, "reserved");
    assert.equal(stillReserved[0].provider_session_id, null);
    assert.equal(stillReserved[0].settled_at, null);

    const cleanup = await settlementRpc(db, {
      runId: invalidRunId,
      attemptId: invalidAttemptId,
      capability: invalidCapability,
      providerSessionId: invalidProviderSessionId,
      status: "completed",
      providerClosed: true,
      durationSeconds: 15.5,
      usage: { seconds: 15.5 },
    });
    assert.deepEqual(cleanup, {
      data: { settled: true, status: "completed", actualMicrousd: 12917 },
      error: null,
    });
  } finally {
    await db.close();
  }
});

test("project deletion redacts voice transcript before a late terminal settlement", async () => {
  const db = await planningTestDatabase(55476);
  try {
    const project = await db.createProject("Voice project deletion.");
    const runId = crypto.randomUUID();
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const providerSessionId = "live_project_deleted";
    const admitted = await ownerVoiceRpc(
      db,
      "project_voice_start",
      await reservePayload(project, runId, "8".repeat(64), capability),
    );
    assert.equal(admitted.error, null, admitted.error?.message ?? "");
    const claimed = await ownerVoiceRpc(db, "project_voice_claim", {
      action: "claim",
      runId,
      projectId: project.id,
      revision: project.revision,
      attemptId,
      capability,
      providerSessionId,
    });
    assert.equal(claimed.error, null, claimed.error?.message ?? "");
    await db.sql`
      update account_private.project_voice_sessions
      set transcript=${db.sql.json([
        {
          speaker: "user",
          text: "private before deletion",
          startMs: 0,
          endMs: 100,
        },
      ])}
      where id=${runId}
    `;

    const trashed = await db.rpc("execute_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        expectedRevision: project.revision,
        action: { type: "set_project_lifecycle", lifecycle: "trashed" },
      },
    });
    assert.equal(trashed.error, null, trashed.error?.message ?? "");
    const trashedProject = trashed.data as Project;
    const deleted = await db.rpc("delete_trash", {
      command: {
        id: crypto.randomUUID(),
        projects: [{ id: project.id, revision: trashedProject.revision }],
        ideas: [],
      },
    });
    assert.equal(deleted.error, null, deleted.error?.message ?? "");

    const orphaned = await db.sql`
      select project_id, owner_id, status, transcript,
             settled_at, actual_microusd,
             w.reserved_microusd as wallet_reserved
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      where s.id=${runId}
    `;
    assert.equal(orphaned[0].project_id, null);
    assert.equal(orphaned[0].owner_id, db.owner);
    assert.equal(orphaned[0].status, "running");
    assert.deepEqual(orphaned[0].transcript, []);
    assert.equal(orphaned[0].settled_at, null);
    assert.equal(orphaned[0].actual_microusd, null);
    assert.equal(Number(orphaned[0].wallet_reserved), 62500);

    const settled = await settlementRpc(db, {
      runId,
      attemptId,
      capability,
      providerSessionId,
      status: "completed",
      providerClosed: true,
      durationSeconds: 10,
      usage: { seconds: 10 },
      transcript: [
        {
          speaker: "assistant",
          text: "late private receipt",
          startMs: 100,
          endMs: 200,
        },
      ],
    });
    assert.deepEqual(settled, {
      data: { settled: true, status: "completed", actualMicrousd: 12500 },
      error: null,
    });
    const settledOrphan = await db.sql`
      select project_id, owner_id, status, transcript, actual_microusd,
             w.reserved_microusd as wallet_reserved,
             w.spent_microusd as wallet_spent
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      where s.id=${runId}
    `;
    assert.equal(settledOrphan[0].project_id, null);
    assert.equal(settledOrphan[0].owner_id, db.owner);
    assert.equal(settledOrphan[0].status, "completed");
    assert.deepEqual(settledOrphan[0].transcript, []);
    assert.equal(Number(settledOrphan[0].actual_microusd), 12500);
    assert.equal(Number(settledOrphan[0].wallet_reserved), 0);
    assert.equal(Number(settledOrphan[0].wallet_spent), 12500);
  } finally {
    await db.close();
  }
});

test("account deletion redacts voice transcript while preserving late settlement accounting", async () => {
  const db = await planningTestDatabase(55477);
  try {
    const project = await db.createProject("Voice account deletion.");
    const runId = crypto.randomUUID();
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const providerSessionId = "live_account_deleted";
    const admitted = await ownerVoiceRpc(
      db,
      "project_voice_start",
      await reservePayload(project, runId, "9".repeat(64), capability),
    );
    assert.equal(admitted.error, null, admitted.error?.message ?? "");
    const claimed = await ownerVoiceRpc(db, "project_voice_claim", {
      action: "claim",
      runId,
      projectId: project.id,
      revision: project.revision,
      attemptId,
      capability,
      providerSessionId,
    });
    assert.equal(claimed.error, null, claimed.error?.message ?? "");
    await db.sql`
      update account_private.project_voice_sessions
      set transcript=${db.sql.json([
        {
          speaker: "user",
          text: "private account transcript",
          startMs: 0,
          endMs: 100,
        },
      ])}
      where id=${runId}
    `;
    await db.sql`delete from auth.users where id=${db.owner}`;

    const orphaned = await db.sql`
      select project_id, owner_id, status, transcript, settled_at,
             w.reserved_microusd as wallet_reserved
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      where s.id=${runId}
    `;
    assert.equal(orphaned[0].project_id, null);
    assert.equal(orphaned[0].owner_id, null);
    assert.equal(orphaned[0].status, "running");
    assert.deepEqual(orphaned[0].transcript, []);
    assert.equal(orphaned[0].settled_at, null);
    assert.equal(Number(orphaned[0].wallet_reserved), 62500);

    const settled = await settlementRpc(db, {
      runId,
      attemptId,
      capability,
      providerSessionId,
      status: "completed",
      providerClosed: true,
      durationSeconds: 10,
      usage: { seconds: 10 },
      transcript: [
        {
          speaker: "assistant",
          text: "late account receipt",
          startMs: 100,
          endMs: 200,
        },
      ],
    });
    assert.deepEqual(settled, {
      data: { settled: true, status: "completed", actualMicrousd: 12500 },
      error: null,
    });
    const settledOrphan = await db.sql`
      select project_id, owner_id, status, transcript, actual_microusd,
             w.reserved_microusd as wallet_reserved,
             w.spent_microusd as wallet_spent
      from account_private.project_voice_sessions s
      join account_private.guidance_wallet w on w.id='openai'
      where s.id=${runId}
    `;
    assert.equal(settledOrphan[0].project_id, null);
    assert.equal(settledOrphan[0].owner_id, null);
    assert.equal(settledOrphan[0].status, "completed");
    assert.deepEqual(settledOrphan[0].transcript, []);
    assert.equal(Number(settledOrphan[0].actual_microusd), 12500);
    assert.equal(Number(settledOrphan[0].wallet_reserved), 0);
    assert.equal(Number(settledOrphan[0].wallet_spent), 12500);
  } finally {
    await db.close();
  }
});

test("voice history is owner-scoped, bounded, chronological, and excludes provider secrets", async () => {
  const db = await planningTestDatabase(55472);
  try {
    const project = await db.createProject("Voice history.");
    const invalidTranscript = await db.sql`
      select account_private.valid_project_voice_transcript(
        ${db.sql.json([{ text: "missing speaker", startMs: 0, endMs: 1 }])}
      ) as valid
    `;
    const invalidScalar = await db.sql`
      select account_private.valid_project_voice_transcript('null'::jsonb) as valid
    `;
    assert.equal(invalidTranscript[0].valid, false);
    assert.equal(invalidScalar[0].valid, false);
    const rows = Array.from({ length: 13 }, (_, index) => ({
      id: crypto.randomUUID(),
      createdAt: new Date(Date.now() - index * 1_000),
    }));
    for (const [index, row] of rows.entries()) {
      await db.sql`
        insert into account_private.project_voice_sessions(
          id,owner_id,project_id,conversation_id,revision,fingerprint,status,model,
          max_duration_seconds,reserve_microusd,actual_microusd,capability_hash,
          created_at,expires_at,started_at,closed_at,settled_at,usage,transcript,final_reason,error_code,
          provider_session_id
        ) values(
          ${row.id},${db.owner},${project.id},'main',${project.revision},${String(index).padStart(64, "0")},
          'completed','gpt-live-1',60,62500,12500,${String(index + 1).padStart(64, "0")},
          ${row.createdAt},${row.createdAt},${row.createdAt},${row.createdAt},${row.createdAt},
          ${db.sql.json({ seconds: 10 })},
          ${db.sql.json([{ speaker: "user", text: `Voice ${index}`, startMs: 0, endMs: 100 }])},
          'done',null,${`provider_secret_should_not_return_${index}`}
        )
      `;
    }
    const history = await historyRpc(db, db.owner, project.id);
    assert.equal(history.error, null, history.error?.message ?? "");
    const data = history.data as {
      projectId: string;
      conversationId: string;
      sessions: Array<{
        runId: string;
        transcript: unknown[];
        durationSeconds: number;
      }>;
    };
    assert.equal(data.projectId, project.id);
    assert.equal(data.conversationId, "main");
    assert.equal(data.sessions.length, 12);
    assert.equal(
      data.sessions[0].runId,
      rows[11].id,
      "oldest retained row is first",
    );
    assert.equal(
      data.sessions.at(-1)?.runId,
      rows[0].id,
      "newest retained row is last",
    );
    assert.equal(data.sessions[0].durationSeconds, 10);
    assert.deepEqual(data.sessions[0].transcript, [
      { speaker: "user", text: "Voice 11", startMs: 0, endMs: 100 },
    ]);
    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes("providerSessionId"), false);
    assert.equal(
      serialized.includes("provider_secret_should_not_return"),
      false,
    );
    assert.equal(serialized.includes("capabilityHash"), false);

    const other = crypto.randomUUID();
    await db.sql`insert into auth.users(id) values(${other})`;
    await db.sql`insert into auth.sessions(id,user_id) values(${other},${other})`;
    const forbidden = await historyRpc(db, other, project.id);
    assert.equal(forbidden.error?.code, "P0002");
  } finally {
    await db.close();
  }
});

test("confirmed voice closure permits another call while retaining unknown cost", async () => {
  const db = await planningTestDatabase(55508);
  try {
    const project = await db.createProject("Voice closure recovery");
    const runId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const providerSessionId = "live_closed_without_usage";
    const reserve = await reservePayload(
      project,
      runId,
      "a".repeat(64),
      capability,
    );
    assert.equal(
      (await ownerVoiceRpc(db, "project_voice_start", reserve)).error,
      null,
    );
    const claim = await ownerVoiceRpc(db, "project_voice_claim", {
      action: "claim",
      runId,
      projectId: project.id,
      revision: project.revision,
      attemptId,
      capability,
      providerSessionId,
    });
    assert.equal(claim.error, null);
    const receipt = {
      runId,
      attemptId,
      capability,
      providerSessionId,
      status: "unknown",
      durationSeconds: 0,
    };
    assert.equal((await settlementRpc(db, receipt)).error, null);
    const next = await reservePayload(
      project,
      crypto.randomUUID(),
      "b".repeat(64),
      crypto.randomUUID(),
    );
    assert.equal(
      (await ownerVoiceRpc(db, "project_voice_start", next)).error?.code,
      "PT425",
    );
    for (const invalid of [
      { ...receipt, capability: "wrong", providerClosed: true },
      { ...receipt, providerSessionId: "live_wrong", providerClosed: true },
      { ...receipt, providerClosed: "true" },
    ])
      assert.ok((await settlementRpc(db, invalid)).error);
    assert.equal(
      (await ownerVoiceRpc(db, "project_voice_start", next)).error?.code,
      "PT425",
    );
    const closed = await settlementRpc(db, {
      ...receipt,
      providerClosed: true,
    });
    assert.deepEqual(closed, {
      data: { settled: false, status: "unknown", providerClosed: true },
      error: null,
    });
    // Replays and later incomplete receipts cannot reopen transport or release money.
    assert.equal(
      (await settlementRpc(db, { ...receipt, providerClosed: true })).error,
      null,
    );
    assert.equal((await settlementRpc(db, receipt)).error, null);
    const status = await ownerVoiceRpc(db, "project_voice_status", {
      action: "status",
      runId,
      projectId: project.id,
      revision: project.revision,
    });
    assert.equal(
      (status.data as { providerClosed: boolean }).providerClosed,
      true,
    );
    const held =
      await db.sql`select status,actual_microusd,settled_at,closed_at from account_private.project_voice_sessions where id=${runId}`;
    assert.equal(held[0].status, "unknown");
    assert.equal(held[0].actual_microusd, null);
    assert.equal(held[0].settled_at, null);
    assert.ok(held[0].closed_at);
    await db.sql`update account_private.guidance_allowances set budget_microusd=62500 where owner_id=${db.owner}`;
    assert.equal(
      (await ownerVoiceRpc(db, "project_voice_start", next)).error?.code,
      "PT429",
    );
    await db.sql`update account_private.guidance_allowances set budget_microusd=125000 where owner_id=${db.owner}`;
    assert.equal(
      (await ownerVoiceRpc(db, "project_voice_start", next)).error,
      null,
    );
    const allowance =
      await db.sql`select reserved_microusd,spent_microusd from account_private.guidance_allowances where owner_id=${db.owner}`;
    assert.equal(Number(allowance[0].reserved_microusd), 125000);
    assert.equal(Number(allowance[0].spent_microusd), 0);
    // Authoritative usage can still settle the old hold exactly once.
    assert.equal(
      (
        await settlementRpc(db, {
          ...receipt,
          status: "failed",
          providerClosed: true,
          durationSeconds: 15,
          usage: { seconds: 15 },
        })
      ).error,
      null,
    );
    const settled =
      await db.sql`select reserved_microusd,spent_microusd from account_private.guidance_allowances where owner_id=${db.owner}`;
    assert.equal(Number(settled[0].reserved_microusd), 62500);
    assert.equal(Number(settled[0].spent_microusd), 12500);
  } finally {
    await db.close();
  }
});

test("ten-minute voice requires paid access or testing exemption and preserves dollar guards", async () => {
  const db = await planningTestDatabase(55519);
  try {
    const project = await db.createProject("Long voice call fixture");
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const value = {
      ...(await reservePayload(
        project,
        crypto.randomUUID(),
        await hashProjectVoice("long-call"),
        capability,
      )),
      maxDurationSeconds: 600,
      reserveMicrousd: 512500,
    };
    await db.sql`update account_private.guidance_allowances set paid_voice_until=null where owner_id=${db.owner}`;
    assert.equal(
      (await ownerVoiceRpc(db, "project_voice_start", value)).error?.code,
      "PT403",
    );
    await db.sql`update account_private.guidance_allowances set paid_voice_until=clock_timestamp()-interval '1 second' where owner_id=${db.owner}`;
    assert.equal(
      (await ownerVoiceRpc(db, "project_voice_start", value)).error?.code,
      "PT403",
    );
    await db.sql`update account_private.guidance_allowances set testing_request_exempt=true,max_requests=0,budget_microusd=512499 where owner_id=${db.owner}`;
    assert.equal(
      (await ownerVoiceRpc(db, "project_voice_start", value)).error?.code,
      "PT429",
    );
    await db.sql`update account_private.guidance_allowances set budget_microusd=1000000 where owner_id=${db.owner}`;
    const start = await ownerVoiceRpc(db, "project_voice_start", value);
    assert.equal(start.error, null, start.error?.message ?? "");
    const expiry = (start.data as { expiresAt: number }).expiresAt;
    assert.ok(expiry > Date.now() + 590000 && expiry <= Date.now() + 600000);
    const attemptId = crypto.randomUUID();
    const claim = await ownerVoiceRpc(db, "project_voice_claim", {
      action: "claim",
      runId: value.runId,
      projectId: project.id,
      revision: project.revision,
      attemptId,
      capability,
      providerSessionId: "live_long_fixture",
    });
    assert.equal(claim.error, null, claim.error?.message ?? "");
    const final = {
      runId: value.runId,
      attemptId,
      capability,
      providerSessionId: "live_long_fixture",
      status: "completed",
      providerClosed: true,
      durationSeconds: 601,
      usage: { seconds: 601 },
    };
    assert.equal(
      (
        await settlementRpc(db, {
          ...final,
          durationSeconds: 616,
          usage: { seconds: 616 },
        })
      ).error?.code,
      "22023",
    );
    const settled = await settlementRpc(db, final);
    assert.equal(settled.error, null, settled.error?.message ?? "");
    assert.equal(
      (settled.data as { actualMicrousd: number }).actualMicrousd,
      500834,
    );
    const [allowance] =
      await db.sql`select used_requests,reserved_microusd,spent_microusd from account_private.guidance_allowances where owner_id=${db.owner}`;
    assert.equal(Number(allowance.used_requests), 1);
    assert.equal(Number(allowance.reserved_microusd), 0);
    assert.equal(Number(allowance.spent_microusd), 500834);
  } finally {
    await db.close();
  }
});
