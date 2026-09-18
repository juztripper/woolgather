import test from "node:test";
import assert from "node:assert/strict";
import { planningTestDatabase } from "../scripts/planning-test-database";
import { hashProjectVoice } from "../apps/api/src/projectVoice";
import {
  nameVoiceConversation,
  voiceTitleRequest,
  VOICE_TITLE_RESERVE,
} from "../apps/api/src/voiceConversationTitle";
import { reservationMicrousd } from "../apps/api/src/openaiGuidance";

test("voice naming stays within its bounded Luna reservation", () => {
  for (const text of ["hello", "界".repeat(24000), "\u0001".repeat(24000)]) {
    const body = voiceTitleRequest(text);
    assert.ok(reservationMicrousd(body) <= VOICE_TITLE_RESERVE);
    const request = JSON.parse(body);
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.max_output_tokens, 128);
    assert.equal(request.store, false);
  }
});

test("voice titles persist once, meter actual usage, and preserve calls, custom names and concurrent edits", async () => {
  const db = await planningTestDatabase(55507);
  try {
    await assert.rejects(
      db.sql.begin(async (tx) => {
        await tx`set local role anon`;
        await tx`select public.project_voice_title('{}',${"0".repeat(64)})`;
      }),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    const env = {
      OPENAI_API_KEY: "synthetic",
      ACCOUNT_ACTION_SECRET: db.secret,
      SUPABASE_URL: "https://fixture.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "synthetic",
    };
    for (const scenario of [
      "success",
      "custom",
      "empty",
      "invalid",
      "unknown",
      "conflict",
      "deleted",
      "budget",
      "rejection",
    ] as const) {
      const project = await db.createProject();
      const identity = {
        runId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        capability: crypto.randomUUID() + crypto.randomUUID(),
      };
      const transcript =
        scenario === "empty"
          ? []
          : [
              {
                speaker: "user",
                text: "Let's plan the garden puzzle mechanics",
                startMs: 0,
                endMs: 1000,
              },
              {
                speaker: "assistant",
                text: "Assistant text must not name the chat",
                startMs: 1000,
                endMs: 2000,
              },
            ];
      await db.sql`insert into account_private.project_voice_sessions(id,owner_id,project_id,conversation_id,revision,fingerprint,status,model,max_duration_seconds,reserve_microusd,actual_microusd,capability_hash,attempt_id,expires_at,settled_at,transcript)
        values(${identity.runId},${db.owner},${project.id},'main',${project.revision},${"a".repeat(64)},'completed','gpt-live-1',60,62500,1000,${await hashProjectVoice(identity.capability)},${identity.attemptId},clock_timestamp(),clock_timestamp(),${db.sql.json(transcript)})`;
      if (scenario === "custom")
        await db.sql`update planning.projects set thinking=jsonb_set(thinking,'{conversations,0,title}','"My chosen name"') where id=${project.id}`;
      if (scenario === "budget")
        await db.sql`update account_private.guidance_allowances set budget_microusd=spent_microusd+reserved_microusd where owner_id=${db.owner}`;
      const before = (
        await db.sql`select * from account_private.guidance_wallet where id='openai'`
      )[0];
      let calls = 0;
      let finishes = 0;
      const send: typeof fetch = async (input, init) => {
        if (String(input).includes("/rpc/")) {
          const body = JSON.parse(String(init?.body));
          const parsed = JSON.parse(body.payload);
          try {
            const result = await db.sql.begin(async (tx) => {
              await tx`set local role anon`;
              return (
                await tx`select public.project_voice_title(${body.payload},${body.signature}) d`
              )[0].d;
            });
            // Simulate a lost acknowledgement after committed settlement.
            if (
              parsed.action === "finish" &&
              scenario === "success" &&
              finishes++ === 0
            )
              throw new Error("lost ack");
            return Response.json(result);
          } catch (error) {
            if ((error as Error).message === "lost ack") throw error;
            assert.fail((error as Error).message);
          }
        }
        calls++;
        const request = JSON.parse(String(init?.body));
        assert.ok(!request.input[1].content.includes("Assistant text"));
        if (scenario === "conflict")
          await db.sql`update planning.projects set revision=revision+1,thinking=jsonb_set(thinking,'{conversations,0,title}','"Chosen during naming"') where id=${project.id}`;
        if (scenario === "deleted")
          await db.sql`delete from planning.projects where id=${project.id}`;
        if (scenario === "unknown") throw new Error("transport interrupted");
        if (scenario === "rejection")
          return Response.json(
            { error: { code: "rate_limit_exceeded" } },
            { status: 429 },
          );
        return Response.json({
          id: "resp_synthetic",
          model: "gpt-5.6-luna",
          status: "completed",
          service_tier: "default",
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 10,
            output_tokens_details: { reasoning_tokens: 0 },
          },
          output: [
            {
              type: "function_call",
              name: "name_conversation",
              arguments: JSON.stringify({
                title: scenario === "invalid" ? "" : "Garden puzzle mechanics",
              }),
            },
          ],
        });
      };
      await Promise.all([
        nameVoiceConversation(env, identity, send),
        nameVoiceConversation(env, identity, send),
      ]);
      await nameVoiceConversation(env, identity, send);
      const skip = ["custom", "empty", "budget"].includes(scenario);
      assert.equal(calls, skip ? 0 : 1, scenario);
      const run = (
        await db.sql`select * from account_private.project_planning_runs where id=${identity.runId}`
      )[0];
      const voice = (
        await db.sql`select * from account_private.project_voice_sessions where id=${identity.runId}`
      )[0];
      assert.equal(voice.status, "completed");
      assert.equal(voice.title_finished, true);
      if (scenario !== "deleted")
        assert.deepEqual(voice.transcript, transcript);
      const saved = (
        await db.sql`select * from planning.projects where id=${project.id}`
      )[0];
      if (scenario === "success") {
        assert.equal(
          saved.thinking.conversations[0].title,
          "Garden puzzle mechanics",
        );
        assert.equal(saved.revision, project.revision + 1);
        assert.equal(Number(run.actual_microusd), 32);
        const after = (
          await db.sql`select * from account_private.guidance_wallet where id='openai'`
        )[0];
        assert.equal(
          Number(after.spent_microusd) - Number(before.spent_microusd),
          32,
        );
        assert.equal(after.reserved_microusd, before.reserved_microusd);
      } else if (scenario === "custom")
        assert.equal(saved.thinking.conversations[0].title, "My chosen name");
      else if (scenario === "conflict")
        assert.equal(
          saved.thinking.conversations[0].title,
          "Chosen during naming",
        );
      else if (scenario !== "deleted")
        assert.equal(
          saved.thinking.conversations[0].title,
          "Main conversation",
        );
      if (scenario === "unknown") {
        assert.equal(run.status, "unknown");
        assert.equal(run.actual_microusd, null);
      }
      if (scenario === "invalid") assert.equal(run.status, "failed");
      if (scenario === "budget")
        await db.sql`update account_private.guidance_allowances set budget_microusd=5000000 where owner_id=${db.owner}`;
    }
  } finally {
    await db.close();
  }
});
