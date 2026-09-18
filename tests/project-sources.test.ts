import test from "node:test";
import assert from "node:assert/strict";
import { defaultComposer } from "../packages/domain/src/planningComposer";
import {
  thinkingOf,
  type ThinkingState,
} from "../packages/domain/src/projectPlanning";
import { projectSourcesOf } from "../packages/domain/src/projectSources";
import { planningRequest } from "../apps/api/src/openaiPlanning";
import { enablePlanningTools } from "../apps/api/src/planningAgents";
import { planningTestDatabase } from "../scripts/planning-test-database";

const sourceCommand = (
  projectId: string,
  revision: number,
  value: Record<string, unknown>,
) => ({
  id: crypto.randomUUID(),
  projectId,
  revision,
  ...value,
});

test("project sources are owned, revision checked, resumable and permanently cleaned", async () => {
  const db = await planningTestDatabase(55481);
  try {
    const project = await db.createProject(
      "A project with private source context.",
    );
    await db.sql`
      update planning.projects
      set thinking=jsonb_set(
        thinking,
        '{undo}',
        jsonb_build_object(
          'revision',revision,
          'turnId',${project.id}::uuid,
          'items','[]'::jsonb,
          'relations','[]'::jsonb,
          'proposals','[]'::jsonb
        ),
        true
      )
      where id=${project.id}
    `;
    const attachmentId = crypto.randomUUID();
    await db.sql`
      insert into account_private.attachments
        (id,owner_id,name,mime_type,byte_size,sha256,state)
      values
        (${attachmentId},${db.owner},'world-notes.md','application/octet-stream',128,
         ${"a".repeat(64)},'ready')
    `;
    const sourceId = crypto.randomUUID();
    const register = sourceCommand(project.id, project.revision, {
      action: "register_source",
      sourceId,
      attachmentId,
      note: "An unresolved ecology reference.",
      meaning: "undecided",
    });
    const registered = await db.rpc("project_source_command", {
      command: register,
    });
    assert.equal(registered.error, null, registered.error?.message ?? "");
    const saved = registered.data as typeof project;
    assert.equal(saved.revision, project.revision + 1);
    assert.equal(saved.thinking?.undo?.revision, saved.revision);
    assert.deepEqual(projectSourcesOf(saved)[0], {
      id: sourceId,
      attachmentId,
      name: "world-notes.md",
      mime: "application/octet-stream",
      size: 128,
      note: "An unresolved ecology reference.",
      meaning: "undecided",
      archived: false,
      createdAt: projectSourcesOf(saved)[0].createdAt,
      updatedAt: projectSourcesOf(saved)[0].updatedAt,
    });
    const retried = await db.rpc("project_source_command", {
      command: register,
    });
    assert.equal(retried.error, null, retried.error?.message ?? "");
    assert.equal((retried.data as typeof project).revision, saved.revision);

    const stale = await db.rpc("project_source_command", {
      command: sourceCommand(project.id, project.revision, {
        action: "update_source",
        sourceId,
        note: "This must be rejected as stale.",
      }),
    });
    assert.equal(stale.error?.code, "PT409");

    const updated = await db.rpc("project_source_command", {
      command: sourceCommand(saved.id, saved.revision, {
        action: "update_source",
        sourceId,
        note: "Author still needs to decide.",
        meaning: "undecided",
      }),
    });
    assert.equal(updated.error, null, updated.error?.message ?? "");
    const next = updated.data as typeof project;

    const other = crypto.randomUUID();
    await db.sql`insert into auth.users(id) values(${other})`;
    await db.sql`insert into auth.sessions(id,user_id) values(${other},${other})`;
    await db.sql`insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(${other},10,1000000)`;
    const foreign = await db.rpcFor(other)("project_source_command", {
      command: sourceCommand(next.id, next.revision, {
        action: "archive_source",
        sourceId,
        archived: true,
      }),
    });
    assert.equal(foreign.error?.code, "P0002");
    const hidden = await db.rpcFor(other)("project_snapshot", {
      project_id: next.id,
    });
    assert.equal(hidden.data, null);

    const archived = await db.rpc("project_source_command", {
      command: sourceCommand(next.id, next.revision, {
        action: "archive_source",
        sourceId,
        archived: true,
      }),
    });
    assert.equal(archived.error, null, archived.error?.message ?? "");
    const archivedProject = archived.data as typeof project;
    const turnId = crypto.randomUUID();
    const composerCheck = await db.rpc("planning_valid_composer", {
      project_id: project.id,
      composer: { ...defaultComposer(), sourceIds: [sourceId] },
    });
    assert.equal(composerCheck.error, null, composerCheck.error?.message ?? "");
    assert.equal(composerCheck.data, false);
    const turn = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: archivedProject.id,
        revision: archivedProject.revision,
        action: "turn",
        turnId,
        text: "Use the saved ecology source.",
        mode: "assist",
        conversationId: "main",
        focusId: null,
        composer: { ...defaultComposer(), sourceIds: [sourceId] },
        routing: { level: "quick", model: "gpt-5.6-luna", effort: "none" },
      },
    });
    assert.equal(turn.error?.code, "22023");

    const trashed = await db.rpc("execute_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: archivedProject.id,
        expectedRevision: archivedProject.revision,
        action: { type: "set_project_lifecycle", lifecycle: "trashed" },
      },
    });
    assert.equal(trashed.error, null, trashed.error?.message ?? "");
    const trashProject = trashed.data as typeof project;
    const deleted = await db.rpc("delete_trash", {
      command: {
        id: crypto.randomUUID(),
        projects: [{ id: trashProject.id, revision: trashProject.revision }],
        ideas: [],
      },
    });
    assert.equal(deleted.error, null, deleted.error?.message ?? "");
    assert.equal(
      (
        await db.sql`select count(*)::int as n from planning.project_sources where id=${sourceId}`
      )[0].n,
      0,
    );
    assert.equal(
      (
        await db.sql`select count(*)::int as n from account_private.attachments where id=${attachmentId}`
      )[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});

test("authored source updates are validated and committed with a completed turn", async () => {
  const db = await planningTestDatabase(55482);
  try {
    let project = await db.createProject("Keep one source decision durable.");
    const attachmentId = crypto.randomUUID();
    await db.sql`
      insert into account_private.attachments
        (id,owner_id,name,mime_type,byte_size,sha256,state)
      values
        (${attachmentId},${db.owner},'brief.txt','application/octet-stream',24,
         ${"b".repeat(64)},'ready')
    `;
    const sourceId = crypto.randomUUID();
    const registered = await db.rpc("project_source_command", {
      command: sourceCommand(project.id, project.revision, {
        action: "register_source",
        sourceId,
        attachmentId,
        note: "",
        meaning: "undecided",
      }),
    });
    assert.equal(registered.error, null, registered.error?.message ?? "");
    project = registered.data as typeof project;
    const turnId = crypto.randomUUID();
    const activeComposerCheck = await db.rpc("planning_valid_composer", {
      project_id: project.id,
      composer: { ...defaultComposer(), sourceIds: [sourceId] },
    });
    assert.equal(
      activeComposerCheck.error,
      null,
      activeComposerCheck.error?.message ?? "",
    );
    assert.equal(activeComposerCheck.data, true);
    const started = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "turn",
        turnId,
        text: "Use this source for the world ecology.",
        mode: "assist",
        conversationId: "main",
        focusId: null,
        composer: { ...defaultComposer(), sourceIds: [sourceId] },
        routing: { level: "quick", model: "gpt-5.6-luna", effort: "none" },
      },
    });
    assert.equal(started.error, null, started.error?.message ?? "");
    project = started.data as typeof project;
    const foreignTurnId = crypto.randomUUID();
    const withForeignConversation = structuredClone(thinkingOf(project));
    withForeignConversation.conversations.push({
      id: "other",
      title: "Other conversation",
      agentIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: false,
      branch: null,
    });
    withForeignConversation.turns.push({
      id: foreignTurnId,
      conversationId: "other",
      text: "Use this source for a different private conversation.",
      reply: "",
      status: "complete",
      focusId: null,
      createdAt: new Date().toISOString(),
      changedIds: [],
    });
    await db.sql`
      update planning.projects
      set thinking=${db.sql.json(withForeignConversation)}, revision=revision+1
      where id=${project.id}
    `;
    project = (await db.rpc("project_snapshot", { project_id: project.id }))
      .data as typeof project;
    const thinking = structuredClone(thinkingOf(project)) as ThinkingState;
    const pending = thinking.turns.find((entry) => entry.id === turnId)!;
    pending.status = "complete";
    pending.reply = "I will keep this source as a usable reference.";
    pending.sourceUpdates = [
      {
        sourceId,
        meaning: "use",
        note: "Use this source when checking ecology details.",
        sourceTurn: "t1",
        quote: "Use this source for the world ecology.",
        origin: "author",
      },
    ];
    const forgedBrief = structuredClone(thinking);
    forgedBrief.turns.find((entry) => entry.id === turnId)!.sourceUpdates = [
      {
        sourceId,
        meaning: "use",
        note: "This must not be accepted from a forged brief quote.",
        sourceTurn: "brief",
        quote: "This sentence is absent from the brief.",
        origin: "author",
      },
    ];
    const briefRejected = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "complete",
        turnId,
        items: project.items,
        thinking: forgedBrief,
        reply: pending.reply,
      },
    });
    assert.equal(briefRejected.error?.code, "22023");
    const foreignRejected = structuredClone(thinking);
    foreignRejected.turns.find((entry) => entry.id === turnId)!.sourceUpdates =
      [
        {
          sourceId,
          meaning: "use",
          note: "This must not cite another conversation.",
          sourceTurn: "t2",
          quote: "Use this source for a different private conversation.",
          origin: "author",
        },
      ];
    const foreignResult = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "complete",
        turnId,
        items: project.items,
        thinking: foreignRejected,
        reply: pending.reply,
      },
    });
    assert.equal(foreignResult.error?.code, "22023");
    const whitespaceQuote = structuredClone(thinking);
    whitespaceQuote.turns.find((entry) => entry.id === turnId)!.sourceUpdates =
      [
        {
          sourceId,
          meaning: "use",
          note: "Whitespace cannot establish a durable source decision.",
          sourceTurn: "t1",
          quote: "   ",
          origin: "author",
        },
      ];
    const whitespaceResult = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "complete",
        turnId,
        items: project.items,
        thinking: whitespaceQuote,
        reply: pending.reply,
      },
    });
    assert.equal(whitespaceResult.error?.code, "22023");
    const shortNormalizedQuote = structuredClone(thinking);
    shortNormalizedQuote.turns.find(
      (entry) => entry.id === turnId,
    )!.sourceUpdates = [
      {
        sourceId,
        meaning: "use",
        note: "A normalized two-character quote cannot establish a decision.",
        sourceTurn: "t1",
        quote: " is ",
        origin: "author",
      },
    ];
    const shortQuoteResult = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "complete",
        turnId,
        items: project.items,
        thinking: shortNormalizedQuote,
        reply: pending.reply,
      },
    });
    assert.equal(shortQuoteResult.error?.code, "22023");
    const completed = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "complete",
        turnId,
        items: project.items,
        thinking,
        reply: pending.reply,
      },
    });
    assert.equal(completed.error, null, completed.error?.message ?? "");
    const finalProject = completed.data as typeof project;
    assert.equal(projectSourcesOf(finalProject)[0].meaning, "use");
    assert.equal(
      projectSourcesOf(finalProject)[0].note,
      "Use this source when checking ecology details.",
    );

    const request = JSON.parse(
      enablePlanningTools(
        planningRequest(finalProject, "gpt-5.6-luna", "none", 1000),
        finalProject,
      ),
    );
    assert.deepEqual(
      request.input[1].content.includes(sourceId),
      true,
      "the source catalog is available to the planner by stable ID",
    );
    assert.equal(
      request.tools.some(
        (tool: { name: string }) => tool.name === "read_project_source",
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

test("permanent source deletion removes project retrieval paths and retains independent Idea bytes", async () => {
  const db = await planningTestDatabase(55485);
  try {
    let project = await db.createProject(
      "Delete a private source permanently.",
    );
    const attachmentId = crypto.randomUUID();
    await db.sql`
      insert into account_private.attachments
        (id,owner_id,name,mime_type,byte_size,sha256,state)
      values
        (${attachmentId},${db.owner},'shared-source.txt','application/octet-stream',32,
         ${"1".repeat(64)},'ready')
    `;
    const ideaId = crypto.randomUUID();
    await db.sql`
      insert into planning.ideas(id,owner_id,body,document)
      values
        (${ideaId},${db.owner},'Independent Idea content',
         ${db.sql.json({ attachments: [attachmentId] })})
    `;
    const sourceId = crypto.randomUUID();
    const registered = await db.rpc("project_source_command", {
      command: sourceCommand(project.id, project.revision, {
        action: "register_source",
        sourceId,
        attachmentId,
        note: "Private source note to remove.",
        meaning: "use",
      }),
    });
    assert.equal(registered.error, null, registered.error?.message ?? "");
    project = registered.data as typeof project;
    const thinking = structuredClone(thinkingOf(project)) as ThinkingState;
    const turnId = crypto.randomUUID();
    thinking.turns.push({
      id: turnId,
      conversationId: "main",
      text: "A chat that selected the source.",
      reply: "The source reply.",
      status: "saved",
      focusId: null,
      createdAt: new Date().toISOString(),
      changedIds: [],
      composer: {
        ...defaultComposer(),
        sourceIds: [sourceId],
        attachments: [
          {
            id: attachmentId,
            name: "shared-source.txt",
            mime: "application/octet-stream",
            size: 32,
          },
        ],
      },
      sourceReferences: [{ sourceId, quote: "A private source quote." }],
      sourceUpdates: [
        {
          sourceId,
          sourceTurn: "t1",
          quote: "A chat that selected the source.",
          note: "A source decision to remove.",
          origin: "author",
        },
      ],
    });
    thinking.undo = {
      revision: project.revision,
      turnId,
      items: [],
      relations: [],
      proposals: [],
    };
    await db.sql`
      update planning.projects
      set thinking=${db.sql.json(thinking)}, revision=revision+1
      where id=${project.id}
    `;
    project = (await db.rpc("project_snapshot", { project_id: project.id }))
      .data as typeof project;
    const receiptRequest = {
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "turn",
      turnId,
      text: "A receipt containing source context.",
      composer: thinking.turns.at(-1)?.composer,
    };
    await db.sql`
      insert into planning.commands(owner_id,id,project_id,request,result)
      values(
        ${db.owner},${receiptRequest.id},${project.id},
        ${db.sql.json(receiptRequest)},${db.sql.json({ thinking })}
      )
    `;
    await db.sql`
      insert into planning.history(project_id,revision,action,context)
      values(${project.id},999,'project_register_source',${db.sql.json({ sourceId })})
    `;

    const deletion = sourceCommand(project.id, project.revision, {
      action: "delete_source",
      sourceId,
    });
    const deleted = await db.rpc("project_source_command", {
      command: deletion,
    });
    assert.equal(deleted.error, null, deleted.error?.message ?? "");
    const after = deleted.data as typeof project;
    assert.equal(
      projectSourcesOf(after).some((source) => source.id === sourceId),
      false,
    );
    const deletedThinking = thinkingOf(after);
    assert.equal(JSON.stringify(deletedThinking).includes(sourceId), false);
    assert.equal(JSON.stringify(deletedThinking).includes(attachmentId), false);
    assert.equal(deletedThinking.undo, null);
    const sourceCount =
      await db.sql`select count(*)::int as n from planning.project_sources where id=${sourceId}`;
    assert.equal(sourceCount[0].n, 0);
    const attachmentCount =
      await db.sql`select count(*)::int as n from account_private.attachments where id=${attachmentId}`;
    assert.equal(
      attachmentCount[0].n,
      1,
      "an independent Idea keeps shared bytes",
    );
    const metadata = await db.rpc("attachment_metadata", {
      attachment_id: attachmentId,
    });
    assert.equal(metadata.error, null, metadata.error?.message ?? "");
    assert.equal((metadata.data as { id?: string } | null)?.id, attachmentId);
    const receipts = await db.sql`
      select request,result from planning.commands
      where project_id=${project.id} and request->>'action' <> 'delete_source'
    `;
    assert.equal(JSON.stringify(receipts).includes(sourceId), false);
    assert.equal(
      JSON.stringify(receipts).includes("Private source note to remove."),
      false,
    );
    assert.equal(
      (
        await db.sql`select count(*)::int as n from planning.history where project_id=${project.id} and revision=999`
      )[0].n,
      0,
    );

    const replay = await db.rpc("project_source_command", {
      command: deletion,
    });
    assert.equal(replay.error, null, replay.error?.message ?? "");
    assert.equal((replay.data as typeof project).revision, after.revision);
    const reused = await db.rpc("project_source_command", {
      command: { ...deletion, sourceId: crypto.randomUUID() },
    });
    assert.equal(reused.error?.code, "22023");
    const stale = await db.rpc("project_source_command", {
      command: {
        ...deletion,
        id: crypto.randomUUID(),
        revision: project.revision,
      },
    });
    assert.equal(stale.error?.code, "PT409");
  } finally {
    await db.close();
  }
});

test("source deletion rejects active work before mutating the catalog", async () => {
  const db = await planningTestDatabase(55486);
  try {
    let project = await db.createProject("Do not delete during paid work.");
    const attachmentId = crypto.randomUUID();
    await db.sql`
      insert into account_private.attachments
        (id,owner_id,name,mime_type,byte_size,sha256,state)
      values
        (${attachmentId},${db.owner},'active.txt','application/octet-stream',16,
         ${"2".repeat(64)},'ready')
    `;
    const sourceId = crypto.randomUUID();
    const registered = await db.rpc("project_source_command", {
      command: sourceCommand(project.id, project.revision, {
        action: "register_source",
        sourceId,
        attachmentId,
      }),
    });
    assert.equal(registered.error, null, registered.error?.message ?? "");
    project = registered.data as typeof project;
    const turnId = crypto.randomUUID();
    const started = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "turn",
        turnId,
        mode: "assist",
        text: "A pending reply.",
        focusId: null,
      },
    });
    assert.equal(started.error, null, started.error?.message ?? "");
    project = started.data as typeof project;
    const deletion = sourceCommand(project.id, project.revision, {
      action: "delete_source",
      sourceId,
    });
    const blocked = await db.rpc("project_source_command", {
      command: deletion,
    });
    assert.equal(blocked.error?.code, "PT425");
    assert.equal(
      (
        await db.sql`select count(*)::int as n from planning.project_sources where id=${sourceId}`
      )[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});
