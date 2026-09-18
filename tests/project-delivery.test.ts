import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../packages/domain/src";
import { emptyThinking } from "../packages/domain/src/projectPlanning";
import {
  applyDeliveryCommand,
  deliveryContext,
  deliveryProgress,
  deliveryCommandSchema,
  emptyDeliveryState,
  requirementStatus,
  type DeliveryAction,
  type DeliveryState,
} from "../packages/domain/src/projectDelivery";

function fixture(configure?: (project: Project) => void) {
  const project: Project = {
    id: crypto.randomUUID(),
    name: "Synthetic build",
    description: "",
    revision: 3,
    updatedAt: new Date().toISOString(),
    lifecycle: "active",
    items: [
      {
        id: crypto.randomUUID(),
        title: "Save a draft",
        body: "Draft survives reopening.",
        category: "feature",
        certainty: "stated",
        status: "open",
        answer: "",
        links: [],
        removed: false,
        source: "author",
        promotedFrom: null,
      },
    ],
  };
  configure?.(project);
  const scopeId = crypto.randomUUID(),
    requirementId = crypto.randomUUID();
  let state = emptyDeliveryState();
  const apply = (
    action: DeliveryAction,
    actor: "owner" | "agent" = "owner",
  ) => {
    state = applyDeliveryCommand(
      state,
      {
        id: crypto.randomUUID(),
        projectId: project.id,
        expectedRevision: state.revision,
        action,
      },
      project,
      actor,
      "2026-09-18T12:00:00.000Z",
    );
    return state;
  };
  apply({
    type: "create_scope",
    scopeId,
    name: "MVP",
    lane: "now",
    requirements: [
      {
        id: requirementId,
        thoughtId: project.items[0].id,
        criterion: "A written draft survives closing and reopening the app.",
      },
    ],
  });
  const report = (overrides = {}) =>
    apply(
      {
        type: "report_outcome",
        scopeId,
        requirementId,
        state: "implemented",
        summary: "Draft persistence implemented.",
        commit: "abcdef1234",
        checks: [{ command: "npm test", result: "passed" }],
        ...overrides,
      },
      "agent",
    );
  const review = (verified = true) =>
    apply({
      type: "review_requirement",
      scopeId,
      requirementId,
      verified,
      note: "Checked the saved draft after reopening.",
    });
  const connect = () =>
    apply(
      {
        type: "connect_repository",
        repository: { label: "Example", remoteUrl: "", branch: "main" },
      },
      "agent",
    );
  const progress = () => deliveryProgress(state.scopes[0], state, project);
  return {
    project,
    scopeId,
    requirementId,
    apply,
    report,
    review,
    connect,
    progress,
    state: () => state,
  };
}

test("creating a build scope snapshots meaning without editing the plan or its statuses", () => {
  const f = fixture();
  assert.equal(f.project.revision, 3);
  assert.equal(f.project.items[0].status, "open");
  assert.equal(
    f.state().scopes[0].requirements[0].body,
    f.project.items[0].body,
  );
  assert.deepEqual(f.progress(), {
    scopeId: f.scopeId,
    total: 1,
    implemented: 0,
    verified: 0,
    blocked: 0,
    inProgress: 0,
    needsRecheck: 0,
    percent: 0,
  });
});
test("agent claims and passing claimed checks never self-verify a requirement", () => {
  const f = fixture();
  f.connect();
  f.report();
  assert.equal(f.progress().implemented, 1);
  assert.equal(f.progress().verified, 0);
  assert.equal(f.progress().percent, 0);
  assert.throws(
    () =>
      f.apply(
        {
          type: "review_requirement",
          scopeId: f.scopeId,
          requirementId: f.requirementId,
          verified: true,
          note: "",
        },
        "agent",
      ),
    /only link/,
  );
  f.review();
  assert.equal(f.progress().percent, 100);
});
test("a later report invalidates review even with identical event timestamps", () => {
  const f = fixture();
  f.connect();
  f.report();
  f.review();
  f.report({ state: "blocked" });
  assert.equal(f.progress().verified, 0);
  assert.equal(f.progress().blocked, 1);
  assert.throws(() => f.review(), /implemented result/);
});
test("failed checks cannot be verified; reopening preserves evidence and denominator", () => {
  const f = fixture();
  f.connect();
  f.report({ checks: [{ command: "npm test", result: "failed" }] });
  assert.throws(() => f.review(), /failed checks/);
  f.report();
  f.review();
  f.review(false);
  assert.equal(f.progress().percent, 0);
  assert.equal(f.progress().total, 1);
  assert.equal(f.state().reports.length, 2);
});
test("changed and removed requirements need recheck, while chat revision and names do not", () => {
  const f = fixture();
  f.connect();
  f.report();
  f.review();
  f.project.revision += 10;
  f.project.name = "Renamed";
  assert.equal(f.progress().percent, 100);
  f.project.items[0].body = "Draft is shared across devices.";
  assert.equal(f.progress().needsRecheck, 1);
  assert.equal(f.progress().percent, 0);
  assert.throws(() => f.review(), /plan changed/);
  assert.equal(
    f.state().scopes[0].requirements[0].body,
    "Draft survives reopening.",
  );
  f.project.items[0].removed = true;
  assert.equal(f.progress().needsRecheck, 1);
});
test("new governing constraints and source meaning invalidate old completion evidence", () => {
  const f = fixture();
  f.connect();
  f.report();
  f.review();
  f.project.items.push({
    ...f.project.items[0],
    id: crypto.randomUUID(),
    category: "constraint",
    title: "Offline",
    body: "Work offline.",
  });
  assert.equal(f.progress().needsRecheck, 1);
  f.project.items.pop();
  f.project.sources = [
    {
      id: crypto.randomUUID(),
      attachmentId: crypto.randomUUID(),
      name: "Reference",
      mime: "text/plain",
      size: 5,
      note: "",
      meaning: "avoid",
      archived: false,
      createdAt: "",
      updatedAt: "",
    },
  ];
  assert.equal(f.progress().needsRecheck, 1);
});
test("direct linked and dependency target edits or removal invalidate verified evidence", () => {
  for (const connection of [
    "outgoing_link",
    "incoming_link",
    "requires",
    "incoming_relation",
  ] as const) {
    const targetId = crypto.randomUUID();
    const f = fixture((project) => {
      const selected = project.items[0];
      const target = {
        ...selected,
        id: targetId,
        title: "Storage",
        body: "Store drafts locally.",
        links: [] as string[],
      };
      project.items.push(target);
      if (connection === "outgoing_link") selected.links = [targetId];
      else if (connection === "incoming_link") target.links = [selected.id];
      else
        project.thinking = {
          ...emptyThinking(),
          relations: [
            {
              id: crypto.randomUUID(),
              from: connection === "requires" ? selected.id : targetId,
              to: connection === "requires" ? targetId : selected.id,
              kind: "requires",
              reason: "Draft persistence uses this storage.",
            },
          ],
        };
    });
    f.connect();
    f.report();
    f.review();
    assert.equal(f.progress().percent, 100, connection);
    const target = f.project.items.find((item) => item.id === targetId)!;
    target.body = "Store encrypted drafts remotely.";
    assert.equal(f.progress().needsRecheck, 1, connection);
    assert.equal(f.progress().verified, 0, connection);
    assert.throws(() => f.review(), /plan changed/, connection);
    target.body = "Store drafts locally.";
    assert.equal(f.progress().percent, 100, connection);
    target.removed = true;
    assert.equal(f.progress().needsRecheck, 1, connection);
    assert.equal(f.progress().percent, 0, connection);
  }
});
test("dependency snapshots are canonical and limited to directly connected thoughts", () => {
  const targetId = crypto.randomUUID(),
    distantId = crypto.randomUUID(),
    unrelatedId = crypto.randomUUID();
  const f = fixture((project) => {
    const selected = project.items[0];
    selected.links = [targetId];
    project.items.push(
      {
        ...selected,
        id: targetId,
        title: "Direct dependency",
        links: [distantId],
      },
      { ...selected, id: distantId, title: "Second degree", links: [] },
      { ...selected, id: unrelatedId, title: "Unrelated", links: [] },
    );
  });
  f.connect();
  f.report();
  f.review();
  assert.deepEqual(
    f.state().scopes[0].context.relatedThoughts.map((thought) => thought.id),
    [targetId],
  );
  f.project.items.reverse();
  f.project.items.find((item) => item.id === distantId)!.body =
    "Changed outside direct scope.";
  f.project.items.find((item) => item.id === unrelatedId)!.body =
    "Unrelated edit.";
  assert.equal(f.progress().percent, 100);
  f.project.items.find((item) => item.id === targetId)!.answer =
    "Use a transactional storage boundary.";
  assert.equal(f.progress().percent, 0);
});
test("scope mutations, foreign criteria, invalid project and stale writes fail without changing saved state", () => {
  const f = fixture();
  const before = structuredClone(f.state());
  assert.throws(
    () =>
      f.apply(
        { type: "move_scope", scopeId: f.scopeId, lane: "later" },
        "agent",
      ),
    /only link/,
  );
  assert.throws(
    () =>
      f.apply({
        type: "review_requirement",
        scopeId: f.scopeId,
        requirementId: crypto.randomUUID(),
        verified: false,
        note: "",
      }),
    /does not belong/,
  );
  for (const patch of [
    { expectedRevision: 99 },
    { projectId: crypto.randomUUID() },
  ])
    assert.throws(() =>
      applyDeliveryCommand(
        f.state(),
        {
          id: crypto.randomUUID(),
          projectId: f.project.id,
          expectedRevision: f.state().revision,
          action: { type: "move_scope", scopeId: f.scopeId, lane: "later" },
          ...patch,
        },
        f.project,
        "owner",
      ),
    );
  assert.deepEqual(f.state(), before);
});
test("repository identity and branch cannot silently move established evidence", () => {
  const f = fixture();
  assert.throws(() => f.report(), /Connect the repository/);
  f.connect();
  f.report();
  const action: DeliveryAction = {
    type: "connect_repository",
    repository: {
      label: "Other",
      remoteUrl: "https://example.com/repo",
      branch: "other",
    },
  };
  assert.throws(() => f.apply(action, "agent"), /project owner/);
  assert.throws(() => f.apply(action, "owner"), /evidence already exists/);
  assert.equal(f.state().repository?.branch, "main");
});
test("archived projects reject writes and connection credentials cannot enter repository URLs", () => {
  const f = fixture();
  f.project.lifecycle = "archived";
  assert.throws(() => f.connect(), /Restore/);
  for (const remoteUrl of [
    "http://example.com/repo",
    "https://user:token@example.com/repo",
    "https://example.com/repo?token=secret",
  ])
    assert.equal(
      deliveryCommandSchema.safeParse({
        id: crypto.randomUUID(),
        projectId: f.project.id,
        expectedRevision: 0,
        action: {
          type: "connect_repository",
          repository: { label: "Repo", remoteUrl, branch: "main" },
        },
      }).success,
      false,
    );
});
test("context excludes conversation content and exposes user-owned inference explicitly", () => {
  const f = fixture();
  const context = deliveryContext(f.project, f.state());
  assert.equal(context.execution.inference, "user_agent");
  assert.equal("thinking" in context.project, false);
  assert.equal("description" in context.project, false);
  assert.equal(context.delivery.scopes[0].id, f.scopeId);
});
test("manual lanes remain independent from the frozen implementation scope", () => {
  const f = fixture();
  const original = structuredClone(f.state().scopes[0]);
  f.apply({ type: "move_scope", scopeId: f.scopeId, lane: "later" });
  assert.deepEqual(f.state().scopes[0], { ...original, lane: "later" });
});
test("tentative authored ideas can be deliberately selected, but removed or question records cannot", () => {
  const f = fixture();
  f.project.items[0].certainty = "tentative";
  const action: DeliveryAction = {
    type: "create_scope",
    scopeId: crypto.randomUUID(),
    name: "Visual experiment",
    lane: "next",
    requirements: [
      {
        id: crypto.randomUUID(),
        thoughtId: f.project.items[0].id,
        criterion: "Review the prototype.",
      },
    ],
  };
  f.apply(action);
  assert.equal(f.state().scopes[1].requirements[0].certainty, "tentative");
  f.project.items[0].category = "question";
  assert.throws(
    () => f.apply({ ...action, scopeId: crypto.randomUUID() }),
    /ID is already in use/,
  );
  assert.throws(
    () =>
      f.apply({
        ...action,
        scopeId: crypto.randomUUID(),
        requirements: [{ ...action.requirements[0], id: crypto.randomUUID() }],
      }),
    /existing feature/,
  );
});
