import { requestEvidence } from "../apps/api/src/planningEvidence";
// Disposable local PostgreSQL only. This helper never reads app credentials.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { testDatabaseBootstrap } from "./test-database-bootstrap.mjs";
import type { Project } from "../packages/domain/src";
import type { GuidanceRpc } from "../apps/api/src/ideaGuidance";

export async function planningTestDatabase(
  port: number,
  beforeMigration?: string,
) {
  let bin = process.env.PG_BIN;
  if (!bin) {
    try {
      bin = execFileSync("pg_config", ["--bindir"], {
        encoding: "utf8",
      }).trim();
    } catch {
      bin = join(
        execFileSync("brew", ["--prefix", "postgresql@18"], {
          encoding: "utf8",
        }).trim(),
        "bin",
      );
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "woolgather-planning-"));
  const pg = (name: string, args: string[]) =>
    execFileSync(join(bin!, name), args, { stdio: ["ignore", "pipe", "pipe"] });
  let started = false;
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const sql = postgres(url, { max: 8, onnotice: () => {} });
  const close = async () => {
    await sql.end();
    if (started) {
      pg("pg_ctl", ["-D", join(dir, "data"), "-m", "fast", "stop"]);
      started = false;
    }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    pg("initdb", [
      "-D",
      join(dir, "data"),
      "-A",
      "trust",
      "-U",
      "postgres",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    pg("pg_ctl", [
      "-D",
      join(dir, "data"),
      "-l",
      join(dir, "postgres.log"),
      "-o",
      `-p ${port} -h 127.0.0.1 -k ${dir}`,
      "start",
    ]);
    started = true;
    await sql.unsafe(testDatabaseBootstrap);
    for (const name of (await readdir("supabase/migrations"))
      .filter(
        (f) => f.endsWith(".sql") && (!beforeMigration || f < beforeMigration),
      )
      .sort())
      await sql.unsafe(
        await readFile(join("supabase/migrations", name), "utf8"),
      );
    const owner = crypto.randomUUID(),
      secret = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
    await sql`insert into auth.users(id) values(${owner})`;
    await sql`insert into auth.sessions(id,user_id) values(${owner},${owner})`;
    await sql`insert into account_private.action_secrets(purpose,secret) values('account_deletion',${secret})`;
    await sql`update account_private.guidance_wallet set enabled=true,budget_microusd=20000000 where id='openai'`;
    await sql`insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(${owner},100,20000000)`;
    if (
      !beforeMigration ||
      beforeMigration > "20260917100239_project_voice_longer_calls.sql"
    )
      await sql`update account_private.guidance_allowances set paid_voice_until=clock_timestamp()+interval '1 day' where owner_id=${owner}`;
    const rpcFor =
      (who: string | null): GuidanceRpc =>
      async (name, args) => {
        try {
          const data = await sql.begin(async (tx) => {
            if (who) {
              await tx`set local role authenticated`;
              await tx`select set_config('request.jwt.claim.sub',${who},true)`;
              await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: who, aal: "aal1" })},true)`;
            } else await tx`set local role anon`;
            if (name === "attachment_metadata")
              return (
                await tx`select public.attachment_metadata(${args.attachment_id as string}) d`
              )[0].d;
            if (name === "project_snapshot")
              return (
                await tx`select public.project_snapshot(${args.project_id as string}) d`
              )[0].d;
            if (name === "plan_billing_command")
              return (
                await tx`select public.plan_billing_command(${args.payload as string},${args.signature as string}) d`
              )[0].d;
            if (name === "account_plan")
              return (await tx`select public.account_plan() d`)[0].d;
            if (name === "account_plan_action")
              return (
                await tx`select public.account_plan_action(${args.payload as string},${args.signature as string}) d`
              )[0].d;
            if (name === "project_voice_history")
              return (
                await tx`select public.project_voice_history(${args.project_id as string},${args.conversation_id as string}) d`
              )[0].d;
            if (name === "project_planning_command")
              return (
                await tx`select public.project_planning_command(${tx.json(args.command as postgres.JSONValue)}) d`
              )[0].d;
            if (name === "project_source_command")
              return (
                await tx`select public.project_source_command(${tx.json(args.command as postgres.JSONValue)}) d`
              )[0].d;
            if (name === "project_source_catalog")
              return (
                await tx`select public.project_source_catalog(${args.project_id as string}) d`
              )[0].d;
            if (name === "planning_valid_composer")
              return (
                await tx`select planning.valid_composer(${tx.json(args.composer as postgres.JSONValue)},${args.project_id as string}) d`
              )[0].d;
            if (name === "execute_command")
              return (
                await tx`select public.execute_command(${tx.json(args.command as postgres.JSONValue)}) d`
              )[0].d;
            if (name === "library_snapshot")
              return (await tx`select public.library_snapshot() d`)[0].d;
            if (name === "delete_trash")
              return (
                await tx`select public.delete_trash(${tx.json(args.command as postgres.JSONValue)}) d`
              )[0].d;
            if (name === "library_command")
              return (
                await tx`select public.library_command(${tx.json(args.command as postgres.JSONValue)}) d`
              )[0].d;
            if (name === "project_history")
              return (
                await tx`select public.project_history(${args.project_id as string}) d`
              )[0].d;
            if (name === "project_planning_budget")
              return (
                await tx`select public.project_planning_budget(${args.payload as string},${args.signature as string}) d`
              )[0].d;
            if (name === "settle_project_planning")
              return (
                await tx`select public.settle_project_planning(${args.payload as string},${args.signature as string}) d`
              )[0].d;
            throw new Error(`Unsupported fixture RPC: ${name}`);
          });
          return { data, error: null };
        } catch (e) {
          return {
            data: null,
            error: {
              message: (e as Error).message,
              code: (e as { code?: string }).code || "fixture_error",
            },
          };
        }
      };
    const rpc = rpcFor(owner),
      settleRpc = rpcFor(null);
    const createProject = async (description = "", name = "") => {
      const p = await rpc("execute_command", {
        command: {
          id: crypto.randomUUID(),
          projectId: crypto.randomUUID(),
          expectedRevision: 0,
          action: { type: "create_project", name, description },
        },
      });
      if (p.error) throw new Error(p.error.message);
      return p.data as Project;
    };
    return {
      sql,
      url,
      owner,
      secret,
      rpc,
      rpcFor,
      settleRpc,
      createProject,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

export function syntheticPlanningResponse(body: string, invalidSource = false) {
  const config = JSON.parse(body);
  const last = config.input
    .filter(
      (i: { role: string; content: unknown }) =>
        i.role === "user" &&
        typeof i.content === "string" &&
        i.content.includes("[sourceTurn:"),
    )
    .at(-1).content as string;
  const sourceTurn = last.match(/sourceTurn: (t\d+)/)?.[1] || "t1";
  const passage = requestEvidence(config).find(
    (entry) => entry.sourceTurn === sourceTurn,
  );
  const text =
    passage?.quote ||
    last
      .slice(last.indexOf("\n") + 1)
      .split("\nAttached files:")[0]
      .trimEnd();
  const context = JSON.parse(
    config.input[1].content.split("\n").slice(1).join("\n"),
  );
  return Response.json({
    id: "resp_synthetic_planning",
    model: config.model,
    status: "completed",
    service_tier: "default",
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 0 },
    },
    output: [
      {
        type: "function_call",
        name: "develop_project",
        arguments: JSON.stringify({
          reply:
            "I’ve kept that thought in the project. Its connection is visible beside our conversation.",
          concepts: [
            {
              ref: "new:thought",
              title: text.slice(0, 65),
              body: text,
              category: "note",
              certainty: /maybe|possibly/i.test(text) ? "tentative" : "stated",
              status: "open",
              answer: "",
              origin: "author",
              ...(passage
                ? { evidenceRef: invalidSource ? "unavailable" : passage.ref }
                : {
                    sourceTurn,
                    quote: invalidSource
                      ? "Invented source that the author did not write."
                      : text.slice(0, 1000),
                  }),
              reason: "A synthetic transport fixture.",
            },
          ],
          remove: [],
          relations: context.concepts.length
            ? [
                {
                  from: "new:thought",
                  to: context.concepts[0].ref,
                  kind: "affects",
                  reason: "Synthetic connection for interaction testing.",
                },
              ]
            : [],
          removeRelations: [],
          dismissProposals: [],
          focus: "new:thought",
          view: "map",
        }),
      },
    ],
  });
}
