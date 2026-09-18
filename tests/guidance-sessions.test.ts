import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ideaGuidance, type GuidanceRpc } from "../apps/api/src/ideaGuidance";
import { blocksText } from "../packages/domain/src/ideaBlocks";
import {
  buildIdeaBrief,
  pendingIdeaQuestions,
} from "../packages/domain/src/ideaDocument";
import {
  guidanceSourceKey,
  validateGuidance,
} from "../packages/domain/src/ideaGuidance";
import { testDatabaseBootstrap } from "../scripts/test-database-bootstrap.mjs";

const corpusFile = "tests/fixtures/guidance-sessions-results.json";
// Checked-in synthetic observations make this regression replay entirely offline.
test("recorded guidance sessions survive real signed admission, feedback, reopening and project handoff", async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert(
    ["127.0.0.1", "localhost"].includes(url.hostname),
    "Session replays require a disposable local database",
  );
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const database = `guidance_sessions_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database ${database}`);
  url.pathname = "/" + database;
  const sql = postgres(url.toString(), { max: 4, onnotice: () => {} });
  try {
    // Roles belong to the local test cluster and were created by test-local.mjs.
    await sql.unsafe(
      testDatabaseBootstrap.replace(
        /create role (anon|authenticated|service_role) nologin; /g,
        "",
      ),
    );
    for (const file of fs
      .readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await sql.unsafe(fs.readFileSync(`supabase/migrations/${file}`, "utf8"));
    const secret = "offline-session-replay-secret-".repeat(3);
    await sql`insert into account_private.action_secrets values('account_deletion',${secret})`;
    await sql`update account_private.guidance_wallet set enabled=true,budget_microusd=7000000 where id='openai'`;
    const corpus = JSON.parse(fs.readFileSync(corpusFile, "utf8"));
    assert.equal(corpus.sessions.length, 30);
    let reviews = 0,
      replays = 0,
      feedbacks = 0;
    for (const session of corpus.sessions) {
      const owner = crypto.randomUUID(),
        ideaId = crypto.randomUUID(),
        projectId = crypto.randomUUID();
      await sql`insert into auth.users(id) values(${owner})`;
      await sql`insert into auth.sessions(id,user_id) values(${owner},${owner})`;
      await sql`insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(${owner},5,500000)`;
      const asOwner = (fn: (tx: postgres.TransactionSql) => Promise<any>) =>
        sql.begin(async (tx) => {
          await tx`set local role authenticated`;
          await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
          await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: owner, aal: "aal1" })},true)`;
          return fn(tx);
        });
      const rpc: GuidanceRpc = async (name, args) => {
        try {
          const data = await asOwner(async (tx) => {
            if (name === "idea_guidance_snapshot")
              return (
                await tx`select public.idea_guidance_snapshot(${String(args.idea_id)}::uuid) d`
              )[0].d;
            assert.equal(name, "idea_guidance_command");
            return (
              await tx`select public.idea_guidance_command(${String(args.payload)},${String(args.signature)}) d`
            )[0].d;
          });
          return { data, error: null };
        } catch (e) {
          return { data: null, error: { code: (e as any).code } };
        }
      };
      const settle: GuidanceRpc = async (_name, args) => {
        try {
          const data = await sql.begin(async (tx) => {
            await tx`set local role anon`;
            return (
              await tx`select public.settle_idea_guidance(${String(args.payload)},${String(args.signature)}) d`
            )[0].d;
          });
          return { data, error: null };
        } catch (e) {
          return { data: null, error: { code: (e as any).code } };
        }
      };
      const command = (value: object) =>
        asOwner(
          async (tx) =>
            (
              await tx`select public.library_command(${tx.json(value as postgres.JSONValue)}) d`
            )[0].d,
        );
      let providerCalls = 0,
        current: any,
        previousRun: string | undefined;
      for (let stage = 0; stage < session.reviews.length; stage++) {
        const observed = session.reviews[stage];
        const document = observed.idea.document;
        const body = blocksText(document.blocks);
        const save = {
          id: crypto.randomUUID(),
          targetId: ideaId,
          expectedRevision: stage,
          type: "save_idea",
          body,
          document,
        };
        const saved = await command(save);
        assert.deepEqual(
          await command(save),
          saved,
          "The same save is idempotent",
        );
        current = saved.ideas.find((i: any) => i.id === ideaId);
        assert.deepEqual(
          current.document,
          document,
          `${session.id}/${stage}: exact source persisted`,
        );
        assert.equal(current.body, body);
        const usage = observed.usage;
        const send = (async () => {
          providerCalls++;
          return Response.json({
            id: `offline_${session.id}_${stage}`,
            model: session.model,
            status: "completed",
            service_tier: "default",
            usage: {
              input_tokens: usage.inputTokens,
              input_tokens_details: {
                cached_tokens: usage.cachedTokens,
                cache_write_tokens: usage.cacheWriteTokens,
              },
              output_tokens: usage.outputTokens,
              output_tokens_details: {
                reasoning_tokens: usage.reasoningTokens,
              },
            },
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(observed.result),
                  },
                ],
              },
            ],
          });
        }) as typeof fetch;
        const invoke = async (input: object, enabled = true) => {
          const response = await ideaGuidance(
            { rpc } as unknown as SupabaseClient,
            {
              IDEA_GUIDANCE_ENABLED: String(enabled),
              OPENAI_API_KEY: "offline-only",
              ACCOUNT_ACTION_SECRET: secret,
              IDEA_GUIDANCE_MODEL: session.model,
              IDEA_GUIDANCE_EFFORT: session.effort,
            },
            owner,
            { ideaId, revision: current.revision, ...input },
            { send, settle, language: session.language, log: () => {} },
          );
          const data: any = await response.json();
          assert.equal(
            response.status,
            200,
            `${session.id}/${stage}: ${JSON.stringify(data)}`,
          );
          return data;
        };
        const before = await invoke({
          action: "status",
          ...(previousRun ? { runId: previousRun } : {}),
        });
        assert.equal(
          before.result,
          null,
          "An earlier review cannot become current after an edit",
        );
        await sql`update account_private.guidance_allowances set last_requested_at=now()-interval '1 minute' where owner_id=${owner}`;
        const reviewed = await invoke({ action: "review" });
        reviews++;
        assert.equal(reviewed.status, "completed");
        assert.deepEqual(
          reviewed.result,
          validateGuidance(
            observed.result,
            body,
            document,
            observed.dispositions,
          ),
        );
        assert.equal(providerCalls, stage + 1);
        const replayed = await invoke({ action: "review" });
        replays++;
        assert.equal(replayed.runId, reviewed.runId);
        assert.equal(
          providerCalls,
          stage + 1,
          "Reopening / identical explicit review reuses the result",
        );
        assert.deepEqual(
          (await invoke({ action: "status" }, false)).result,
          reviewed.result,
          "Saved result is readable with guidance disabled",
        );
        assert.equal(
          guidanceSourceKey(current.body, current.document),
          guidanceSourceKey(observed.idea.body, document),
        );
        if (stage < 2 && reviewed.result.question) {
          await invoke({
            action: "feedback",
            runId: reviewed.runId,
            disposition: stage === 0 ? session.disposition : "dismissed",
          });
          feedbacks++;
          assert.equal(
            (await invoke({ action: "status", runId: reviewed.runId })).result
              .question,
            null,
          );
        }
        previousRun = reviewed.runId;
      }
      const brief = buildIdeaBrief(current.body, current.document);
      const questions = pendingIdeaQuestions(
        current.body,
        current.document,
      ).map((q) => q.text);
      const convert = {
        id: crypto.randomUUID(),
        type: "convert_idea",
        targetId: ideaId,
        expectedRevision: current.revision,
        projectId,
        name: current.document.title,
        folderId: null,
        brief,
        questions,
      };
      const converted = await command(convert);
      assert.deepEqual(await command(convert), converted);
      const project = await asOwner(
        async (tx) =>
          (await tx`select public.project_snapshot(${projectId}) d`)[0].d,
      );
      assert.equal(project.name, current.document.title || "Untitled Project");
      assert.equal(project.description, brief);
      assert.deepEqual(project.ideaDocument, current.document);
      assert.equal(project.originalIdea, current.body);
      assert.deepEqual(project.ideaQuestions, questions);
      assert(
        project.items.every(
          (i: any) =>
            i.category === "question" &&
            i.certainty === "tentative" &&
            i.status === "open",
        ),
      );
      assert.equal(
        project.items.length,
        questions.length,
        "AI recognitions do not become accepted project requirements",
      );
      const journal =
        await sql`select status,actual_microusd from account_private.guidance_journal where owner_id=${owner}`;
      assert.equal(journal.length, 3);
      assert(journal.every((r) => r.status === "completed"));
      const period = (
        await sql`select used_reviews,reserved_reviews from account_private.guidance_review_periods where owner_id=${owner}`
      )[0];
      assert.equal(Number(period.used_reviews), 3);
      assert.equal(Number(period.reserved_reviews), 0);
      await sql`delete from auth.users where id=${owner}`;
    }
    assert.equal(reviews, 90);
    assert.equal(replays, 90);
    const outstanding =
      await sql`select reserved_microusd,spent_microusd from account_private.guidance_wallet where id='openai'`;
    assert.equal(Number(outstanding[0].reserved_microusd), 0);
    assert.equal(
      Number(outstanding[0].spent_microusd),
      corpus.summary.reduce(
        (sum: number, route: any) => sum + route.totalMicrousd,
        0,
      ),
      "Real usage survives account deletion and replay does not double-charge",
    );
    console.log(
      `PASS: ${corpus.sessions.length} offline database sessions; ${reviews} recorded reviews, ${replays} exact replays, ${feedbacks} persisted dispositions, 30 source-preserving project handoffs. No live provider calls.`,
    );
  } finally {
    await sql.end();
    await admin.unsafe(`drop database ${database} with (force)`);
    await admin.end();
  }
});
