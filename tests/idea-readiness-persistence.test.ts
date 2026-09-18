import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ideaGuidance, type GuidanceRpc } from "../apps/api/src/ideaGuidance";
import { testDatabaseBootstrap } from "../scripts/test-database-bootstrap.mjs";
import {
  emptyIdeaDocument,
  withIdeaBlocks,
} from "../packages/domain/src/ideaDocument";
import { blocksText, textBlock } from "../packages/domain/src/ideaBlocks";

test("signed ready reviews recover their saved source and survive reopening until reviewed content is removed", async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const database = `readiness_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database ${database}`);
  url.pathname = "/" + database;
  const sql = postgres(url.toString(), { max: 3, onnotice: () => {} });
  try {
    await sql.unsafe(
      testDatabaseBootstrap.replace(
        /create role (anon|authenticated|service_role) nologin; /g,
        "",
      ),
    );
    const migrations = fs
      .readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const readinessMigration = migrations.find((f) =>
      f.endsWith("_idea_review_readiness.sql"),
    )!;
    for (const file of migrations.filter((f) => f !== readinessMigration))
      await sql.unsafe(fs.readFileSync(`supabase/migrations/${file}`, "utf8"));
    const owner = crypto.randomUUID(),
      other = crypto.randomUUID(),
      ideaId = crypto.randomUUID();
    const secret = "isolated-readiness-secret-".repeat(3);
    await sql`insert into auth.users(id) values(${owner}),(${other})`;
    await sql`insert into auth.sessions(id,user_id) values(${owner},${owner}),(${other},${other})`;
    await sql`insert into account_private.action_secrets values('account_deletion',${secret})`;
    await sql`insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(${owner},5,500000)`;
    await sql`update account_private.guidance_wallet set enabled=true,budget_microusd=7000000 where id='openai'`;
    let actor = owner;
    const asOwner = (fn: (tx: postgres.TransactionSql) => Promise<any>) =>
      sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
        await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: actor, aal: "aal1" })},true)`;
        return fn(tx);
      });
    const rpc: GuidanceRpc = async (name, args) => {
      try {
        const data = await asOwner(async (tx) =>
          name === "idea_guidance_snapshot"
            ? (
                await tx`select public.idea_guidance_snapshot(${String(args.idea_id)}::uuid) d`
              )[0].d
            : (
                await tx`select public.idea_guidance_command(${String(args.payload)},${String(args.signature)}) d`
              )[0].d,
        );
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { code: (e as any).code } };
      }
    };
    const settle: GuidanceRpc = async (_name, args) => {
      const data = await sql.begin(async (tx) => {
        await tx`set local role anon`;
        return (
          await tx`select public.settle_idea_guidance(${String(args.payload)},${String(args.signature)}) d`
        )[0].d;
      });
      return { data, error: null };
    };
    let revision = 0;
    const original = withIdeaBlocks(emptyIdeaDocument(), [
      textBlock("concept", "A cooking app."),
      textBlock("audience", "For curious home cooks."),
    ]);
    const save = async (document: typeof original) => {
      const command = {
        id: crypto.randomUUID(),
        type: "save_idea",
        targetId: ideaId,
        expectedRevision: revision,
        body: blocksText(document.blocks),
        document,
      };
      const library = await asOwner(
        async (tx) =>
          (
            await tx`select public.library_command(${sql.json(JSON.parse(JSON.stringify(command)))}) d`
          )[0].d,
      );
      revision = library.ideas.find((i: any) => i.id === ideaId).revision;
    };
    let calls = 0;
    const send = (async () => {
      calls++;
      return Response.json({
        id: `offline_ready_${calls}`,
        model: "gpt-5.6-sol",
        service_tier: "default",
        status: "completed",
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 30,
        },
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  outcome: "ready",
                  finding: null,
                  recognition: [],
                  question: null,
                }),
              },
            ],
          },
        ],
      });
    }) as typeof fetch;
    const invoke = async (action: "status" | "review") => {
      const response = await ideaGuidance(
        { rpc } as unknown as SupabaseClient,
        {
          ACCOUNT_ACTION_SECRET: secret,
          IDEA_GUIDANCE_ENABLED: "true",
          OPENAI_API_KEY: "offline-only",
        },
        actor,
        { action, ideaId, revision },
        { send, settle },
      );
      const data: any = await response.json();
      assert.equal(
        response.status,
        actor === owner ? 200 : 404,
        JSON.stringify(data),
      );
      return data;
    };
    await save(original);
    const first = await invoke("review");
    assert.equal(first.ready, true);
    const edited = withIdeaBlocks(original, [
      textBlock("concept", "A recipe discovery app."),
      original.blocks[1],
      textBlock("new", "A calm atmosphere."),
    ]);
    await save(edited);
    await sql.unsafe(
      fs.readFileSync(`supabase/migrations/${readinessMigration}`, "utf8"),
    );
    const source = (
      await sql`select source_snapshot from account_private.guidance_runs where id=${first.runId}`
    )[0].source_snapshot;
    assert.deepEqual(
      source.document,
      original,
      "backfill uses the reviewed receipt, not the later edit",
    );
    const reopened = await invoke("status");
    assert.equal(reopened.ready, true);
    assert.equal(reopened.current, false);
    assert.equal(reopened.runId, first.runId);
    await invoke("review");
    assert.equal(
      calls,
      1,
      "even a stale client cannot spend another review while ready",
    );
    const removed = withIdeaBlocks(
      edited,
      edited.blocks.filter((b) => b.id !== "audience"),
    );
    await save(removed);
    const cleared = await invoke("status");
    assert.equal(cleared.ready, false);
    assert.equal(cleared.result, null);
    await sql`update account_private.guidance_allowances set last_requested_at=now()-interval '1 minute' where owner_id=${owner}`;
    const second = await invoke("review");
    assert.equal(calls, 2);
    assert.notEqual(second.runId, first.runId);
    assert.deepEqual(
      (
        await sql`select source_snapshot from account_private.guidance_runs where id=${second.runId}`
      )[0].source_snapshot.document,
      removed,
      "new admissions capture their exact saved source",
    );
    await save(original);
    assert.equal(
      (await invoke("status")).runId,
      second.runId,
      "latest state wins over an older exact-source match",
    );
    actor = other;
    assert.equal(
      (await invoke("status")).ready,
      undefined,
      "another account cannot read readiness or its source",
    );
    const access = (
      await sql`select has_table_privilege('authenticated','account_private.guidance_runs','select') direct_read, has_function_privilege('authenticated','account_private.capture_guidance_source()','execute') trigger_call`
    )[0];
    assert.equal(access.direct_read, false);
    assert.equal(access.trigger_call, false);
  } finally {
    await sql.end();
    await admin.unsafe(`drop database ${database} with (force)`);
    await admin.end();
  }
});
