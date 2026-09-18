import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { makeCommand } from "../apps/web/src/client";
import type { Action, Project } from "../packages/domain/src";
const sql = postgres(
  process.env.TEST_DATABASE_URL || "postgres://ripper@127.0.0.1:55432/postgres",
  { max: 5 },
);
const a = crypto.randomUUID(),
  b = crypto.randomUUID(),
  pid = crypto.randomUUID();
const item = (title: string, extra = {}) => ({
  title,
  body: "An explicit idea",
  category: "feature",
  certainty: "stated",
  status: "open",
  answer: "",
  links: [],
  ...extra,
});
async function as<T>(
  owner: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
) {
  return sql.begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: owner, aal: "aal1" })},true)`;
    return fn(tx);
  });
}
async function run(owner: string, command: unknown): Promise<Project> {
  return as(
    owner,
    async (tx) =>
      (
        await tx`select public.execute_command(${tx.json(command as postgres.JSONValue)}) as p`
      )[0].p,
  ) as Promise<Project>;
}
let revision = 0;
async function act(action: Action) {
  const p = await run(a, makeCommand(pid, revision, action));
  revision = p.revision;
  return p;
}
before(async () => {
  await sql`insert into auth.users(id) values(${a}),(${b})`;
  await sql`insert into auth.sessions(id,user_id) values(${a},${a}),(${b},${b})`;
});
after(async () => {
  await sql`delete from auth.users where id in (${a},${b})`;
  await sql.end();
});
test("durable manual planning boundary", async (t) => {
  await t.test(
    "creates unnamed project and retries without duplication",
    async () => {
      const cmd = makeCommand(pid, 0, {
        type: "create_project",
        name: "",
        description: "Keep uncertainty intact.",
      });
      const [first, second] = await Promise.all([run(a, cmd), run(a, cmd)]);
      assert.deepEqual(first, second);
      assert.equal(first.name, "Untitled Project");
      assert.equal(first.revision, 1);
      revision = 1;
      await assert.rejects(
        run(a, { ...cmd, action: { ...cmd.action, name: "Changed" } }),
        /Retry key reused/,
      );
    },
  );
  await t.test(
    "a second account cannot read, write, export snapshot, or see history",
    async () => {
      assert.equal(
        await as(
          b,
          async (tx) =>
            (await tx`select public.project_snapshot(${pid}) p`)[0].p,
        ),
        null,
      );
      assert.deepEqual(
        await as(
          b,
          async (tx) => (await tx`select public.list_projects() p`)[0].p,
        ),
        [],
      );
      assert.deepEqual(
        await as(
          b,
          async (tx) =>
            (await tx`select public.project_history(${pid}) p`)[0].p,
        ),
        [],
      );
      await assert.rejects(
        run(
          b,
          makeCommand(pid, revision, {
            type: "rename_project",
            name: "Stolen",
          }),
        ),
        /Project not found/,
      );
    },
  );
  const id = crypto.randomUUID(),
    question = crypto.randomUUID(),
    gap = crypto.randomUUID(),
    decision = crypto.randomUUID();
  await t.test(
    "preserves tentative intent through save and reopen",
    async () => {
      await act({
        type: "add_item",
        itemId: id,
        item: item("Optional reminder", { certainty: "tentative" }),
      } as Action);
      const p = (await as(
        a,
        async (tx) => (await tx`select public.project_snapshot(${pid}) p`)[0].p,
      )) as Project;
      assert.equal(p.items[0].certainty, "tentative");
      assert.equal(p.items[0].source, "Written by you");
    },
  );
  await t.test(
    "rejects stale writes and rolls back invalid linked items",
    async () => {
      await assert.rejects(
        run(a, makeCommand(pid, 1, { type: "rename_project", name: "Stale" })),
        /Revision conflict/,
      );
      await assert.rejects(
        act({
          type: "add_item",
          itemId: crypto.randomUUID(),
          item: item("Bad link", { links: [crypto.randomUUID()] }),
        } as Action),
        /Linked item not found/,
      );
    },
  );
  await t.test(
    "question promotion remains idempotent after edits and removal",
    async () => {
      await act({
        type: "add_item",
        itemId: question,
        item: item("One loan per book?", {
          category: "question",
          status: "answered",
          answer: "Only one active loan per book.",
        }),
      } as Action);
      await act({
        type: "promote_answer",
        itemId: question,
        decisionId: decision,
      });
      await act({
        type: "edit_item",
        itemId: decision,
        item: item("One active loan", {
          category: "decision",
          certainty: "confirmed",
          body: "Confirmed after review.",
        }),
      } as Action);
      await act({ type: "remove_item", itemId: decision });
      const p = await act({
        type: "promote_answer",
        itemId: question,
        decisionId: crypto.randomUUID(),
      });
      assert.equal(
        p.items.filter((i) => i.promotedFrom === question).length,
        1,
      );
      assert.equal(
        p.items.find((i) => i.id === decision)?.body,
        "Confirmed after review.",
      );
      assert.equal(p.items.find((i) => i.id === decision)?.removed, true);
      await act({ type: "restore_item", itemId: decision });
    },
  );
  await t.test(
    "resolved linked gaps require recheck after related meaning changes",
    async () => {
      await act({
        type: "add_item",
        itemId: gap,
        item: item("Reminder privacy", {
          category: "gap",
          links: [id],
          status: "resolved",
          answer: "Reminders stay on device.",
        }),
      } as Action);
      const p = await act({
        type: "edit_item",
        itemId: id,
        item: item("Optional reminder", {
          certainty: "tentative",
          body: "Consider email reminders later.",
        }),
      } as Action);
      assert.equal(p.items.find((i) => i.id === gap)?.status, "recheck");
      assert.equal(
        p.items.find((i) => i.id === gap)?.answer,
        "Reminders stay on device.",
      );
    },
  );
  await t.test("concurrent different commands have one winner", async () => {
    const outcomes = await Promise.allSettled(
      ["First", "Second"].map((name) =>
        run(a, makeCommand(pid, revision, { type: "rename_project", name })),
      ),
    );
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((x) => x.status === "rejected").length, 1);
  });
  await t.test("anonymous role cannot execute the command API", async () => {
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`set local role anon`;
        await tx`select public.list_projects()`;
      }),
      /permission denied/,
    );
  });
});
