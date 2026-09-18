import test from "node:test";
import assert from "node:assert/strict";
import { planningTestDatabase } from "../scripts/planning-test-database";
import {
  hashProjectVoice,
  signProjectVoiceSettlement,
} from "../apps/api/src/projectVoice";
import type { Project } from "../packages/domain/src";

test("closed voice permits content deletion while preserving holds and late settlement", async () => {
  const db = await planningTestDatabase(55504);
  try {
    for (const action of ["delete_conversation", "delete_source"] as const) {
      let project = await db.createProject("Closed voice deletion fixture.");
      const attachmentId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      await db.sql`insert into account_private.attachments
        (id,owner_id,name,mime_type,byte_size,sha256,state)
        values (${attachmentId},${db.owner},'reference.txt','application/octet-stream',12,${"f".repeat(64)},'ready')`;
      const registered = await db.rpc("project_source_command", {
        command: {
          id: crypto.randomUUID(),
          projectId: project.id,
          revision: project.revision,
          action: "register_source",
          sourceId,
          attachmentId,
          note: "Fixture",
          meaning: "undecided",
        },
      });
      assert.equal(registered.error, null);
      project = registered.data as Project;

      const runId = crypto.randomUUID();
      const providerSessionId = `synthetic-deletion-${runId}`;
      const attemptId = crypto.randomUUID();
      const capability = crypto.randomUUID();
      const capabilityHash = await hashProjectVoice(capability);
      const transcript = [
        {
          speaker: "user",
          text: "Private synthetic voice text",
          startMs: 0,
          endMs: 500,
        },
      ];
      await db.sql`insert into account_private.project_voice_sessions
        (id,owner_id,project_id,conversation_id,revision,fingerprint,status,model,
         max_duration_seconds,reserve_microusd,capability_hash,expires_at,
         attempt_id,provider_session_id,transcript)
        values (${runId},${db.owner},${project.id},'main',${project.revision},${"a".repeat(64)},
         'unknown','gpt-live-1',60,62500,${capabilityHash},clock_timestamp()-interval '1 minute',
         ${attemptId},${providerSessionId},${db.sql.json(transcript)})`;
      await db.sql`update account_private.guidance_wallet set reserved_microusd=reserved_microusd+62500 where id='openai'`;
      await db.sql`update account_private.guidance_allowances set reserved_microusd=reserved_microusd+62500,used_requests=used_requests+1 where owner_id=${db.owner}`;
      const command = {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action,
        ...(action === "delete_conversation"
          ? { conversationId: "main" }
          : { sourceId }),
      };
      const rpcName =
        action === "delete_conversation"
          ? "project_planning_command"
          : "project_source_command";
      const unconfirmed = await db.rpc(rpcName, { command });
      assert.equal(
        unconfirmed.error?.code,
        "PT425",
        "expiry alone does not prove voice closure",
      );
      assert.deepEqual(
        (await db.rpc("project_snapshot", { project_id: project.id })).data,
        project,
      );

      // Stand in for the separate, signed provider-confirmed closure. Cost is
      // still unknown, so the monetary reservation must survive deletion.
      await db.sql`update account_private.project_voice_sessions set closed_at=clock_timestamp() where id=${runId}`;
      const balances =
        () => db.sql`select w.reserved_microusd,w.spent_microusd,a.reserved_microusd as account_reserved,a.spent_microusd as account_spent,a.used_requests
        from account_private.guidance_wallet w cross join account_private.guidance_allowances a where w.id='openai' and a.owner_id=${db.owner}`;
      const before = await balances();
      const deleted = await db.rpc(rpcName, { command });
      assert.equal(deleted.error, null, deleted.error?.message ?? "");
      assert.deepEqual(await balances(), before);
      const [hold] =
        await db.sql`select status,reserve_microusd,actual_microusd,settled_at,conversation_id,transcript,capability_hash from account_private.project_voice_sessions where id=${runId}`;
      assert.equal(hold.status, "unknown");
      assert.equal(Number(hold.reserve_microusd), 62500);
      assert.equal(hold.actual_microusd, null);
      assert.equal(hold.settled_at, null);
      assert.equal(hold.capability_hash, capabilityHash);
      assert.equal(
        hold.conversation_id,
        action === "delete_conversation" ? null : "main",
      );
      assert.deepEqual(
        hold.transcript,
        action === "delete_conversation" ? [] : transcript,
      );
      assert.deepEqual((await db.rpc(rpcName, { command })).data, deleted.data);

      const payload = JSON.stringify({
        runId,
        attemptId,
        capability,
        providerSessionId,
        status: "completed",
        providerClosed: true,
        durationSeconds: 15,
        usage: { seconds: 15 },
        transcript,
      });
      const signature = await signProjectVoiceSettlement(db.secret, payload);
      const settle = () =>
        db.sql.begin(async (tx) => {
          await tx`set local role anon`;
          return (
            await tx`select public.settle_project_voice(${payload},${signature}) d`
          )[0].d;
        });
      const settled = await settle();
      assert.deepEqual(settled, {
        settled: true,
        status: "completed",
        actualMicrousd: 12500,
      });
      const paid = await balances();
      assert.equal(
        Number(paid[0].reserved_microusd),
        Number(before[0].reserved_microusd) - 62500,
      );
      assert.equal(
        Number(paid[0].spent_microusd),
        Number(before[0].spent_microusd) + 12500,
      );
      assert.deepEqual(await settle(), settled);
      assert.deepEqual(
        await balances(),
        paid,
        "settlement replay cannot spend twice",
      );
      const [late] =
        await db.sql`select conversation_id,transcript from account_private.project_voice_sessions where id=${runId}`;
      assert.equal(late.conversation_id, hold.conversation_id);
      assert.deepEqual(
        late.transcript,
        hold.transcript,
        "late settlement cannot restore a deleted transcript",
      );
    }
  } finally {
    await db.close();
  }
});
