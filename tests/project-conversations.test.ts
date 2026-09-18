import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  agentsOf,
  conversationTurns,
  conversationsOf,
  emptyMainConversation,
  mainConversationId,
} from "../packages/domain/src/projectConversations";
import {
  emptyThinking,
  preparePlanningResult,
  thinkingOf,
  type ThinkingState,
} from "../packages/domain/src/projectPlanning";
import { defaultComposer } from "../packages/domain/src/planningComposer";
import { planningTestDatabase } from "../scripts/planning-test-database";
import type { Project } from "../packages/domain/src";

function projectWithTurns(): Project {
  const thinking = emptyThinking();
  const first = crypto.randomUUID();
  thinking.turns.push({
    id: first,
    text: "The author turn before the branch.",
    reply: "The main reply.",
    status: "complete",
    focusId: null,
    createdAt: new Date().toISOString(),
    changedIds: [],
  });
  thinking.turns.push({
    id: crypto.randomUUID(),
    text: "A later main turn.",
    reply: "Another reply.",
    status: "complete",
    focusId: null,
    createdAt: new Date().toISOString(),
    changedIds: [crypto.randomUUID()],
    work: {
      completedAt: new Date().toISOString(),
      activity: [{ label: "Main work" }],
    },
  });
  const cutoff = thinking.turns[1].id;
  thinking.conversations.push({
    ...emptyMainConversation(),
    id: "world",
    title: "World and environment",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    branch: {
      conversationId: mainConversationId,
      turnId: cutoff,
      message: "user",
      revision: 2,
    },
  });
  thinking.turns.push({
    id: crypto.randomUUID(),
    conversationId: "world",
    text: "Continue the world branch.",
    reply: "The branch reply.",
    status: "complete",
    focusId: null,
    createdAt: new Date().toISOString(),
    changedIds: [],
  });
  return {
    id: crypto.randomUUID(),
    name: "Untitled Project",
    description: "",
    revision: 2,
    updatedAt: new Date().toISOString(),
    items: [],
    thinking,
  };
}

test("conversation helpers retain legacy main turns and resolve branch prefixes by reference", () => {
  const project = projectWithTurns();
  const main = thinkingOf(project).turns;
  const branch = conversationTurns(project, "world");
  assert.deepEqual(
    branch.map((turn) => turn.id),
    [main[0].id, main[1].id, main[2].id],
  );
  assert.equal(branch[0], main[0], "ordinary ancestor turns are references");
  assert.notEqual(branch[1], main[1], "a user cutoff needs a view copy");
  assert.equal(branch[1].reply, "", "the ancestor reply is not exposed yet");
  assert.deepEqual(
    branch[1].changedIds,
    [],
    "response changes are not exposed yet",
  );
  assert.equal(branch[1].work, undefined, "response work is not exposed yet");
  assert.equal(branch[1].text, main[1].text, "authored source remains exact");
  assert.equal(branch[2], main[2], "branch turns retain their actual object");
  assert.equal(
    conversationsOf(project).find((entry) => entry.id === "main")?.title,
    "Main conversation",
  );
  assert.deepEqual(agentsOf(project), []);

  const assistantView = projectWithTurns();
  const assistantState = thinkingOf(assistantView);
  const assistantSource = assistantState.turns[1];
  const assistantConversation = assistantState.conversations.find(
    (entry) => entry.id === "world",
  )!;
  assistantConversation.createdAt = new Date().toISOString();
  assistantConversation.branch = {
    conversationId: mainConversationId,
    turnId: assistantSource.id,
    message: "assistant",
    revision: assistantView.revision,
  };
  assistantSource.work = {
    completedAt: new Date(Date.now() + 1_000).toISOString(),
    activity: [{ label: "A later retry" }],
  };
  const assistantBranch = conversationTurns(assistantView, "world");
  assert.equal(
    assistantBranch[1].reply,
    "",
    "later assistant completion is not exposed in the branch view",
  );
  assert.equal(assistantBranch[1].work, undefined);

  const legacy = {
    ...project,
    thinking: {
      version: 1,
      turns: [main[0]],
      relations: [],
      proposals: [],
      focusId: null,
      view: "map" as const,
      undo: null,
    },
  } as unknown as Project;
  assert.equal(conversationsOf(legacy)[0].id, "main");
  assert.equal(conversationTurns(legacy)[0], main[0]);
});

test("conversation migration preserves populated legacy projects and authored turns", async () => {
  const migration = "20260914120000_project_conversations.sql";
  const db = await planningTestDatabase(55473, migration);
  try {
    const original = await db.createProject("Keep the exact original brief.");
    const turnId = crypto.randomUUID();
    const result = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: original.id,
        revision: original.revision,
        action: "turn",
        turnId,
        mode: "note",
        text: "An uncertain thought worth keeping.",
        focusId: null,
      },
    });
    assert.equal(result.error, null);
    const before = result.data as Project;
    await db.sql.unsafe(
      await readFile(`supabase/migrations/${migration}`, "utf8"),
    );
    const read = await db.rpc("project_snapshot", { project_id: original.id });
    assert.equal(read.error, null);
    const after = read.data as Project;
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.items, before.items);
    assert.equal(after.description, before.description);
    assert.deepEqual(
      thinkingOf(after).turns,
      thinkingOf(before).turns.map((turn) => ({
        ...turn,
        conversationId: "main",
      })),
    );
    assert.equal(conversationsOf(after)[0].id, "main");
  } finally {
    await db.close();
  }
});

test("project conversation commands are idempotent and preserve metadata through completion", async () => {
  const db = await planningTestDatabase(55461);
  try {
    let project = await db.createProject("A project with specialist branches.");
    const command = async (value: Record<string, unknown>) => {
      const result = await db.rpc("project_planning_command", {
        command: {
          id: crypto.randomUUID(),
          projectId: project.id,
          revision: project.revision,
          ...value,
        },
      });
      if (result.error) throw new Error(result.error.message);
      project = result.data as Project;
      return project;
    };

    const agentId = crypto.randomUUID();
    const scopedThoughtId = crypto.randomUUID();
    const scopedThoughtResult = await db.rpc("execute_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        expectedRevision: project.revision,
        action: {
          type: "add_item",
          itemId: scopedThoughtId,
          item: {
            title: "Scoped project thought",
            body: "A branch item retained by the specialist.",
            category: "note",
            certainty: "stated",
            status: "open",
            answer: "",
            links: [],
          },
        },
      },
    });
    assert.equal(scopedThoughtResult.error, null);
    project = scopedThoughtResult.data as Project;
    const agentCommand = {
      action: "upsert_agent",
      agentId,
      name: "World and environment",
      avatar: "orbit",
      instructions:
        "Develop places, atmosphere and ecosystems while preserving uncertainty.",
      scopeIds: [scopedThoughtId],
    };
    project = await command(agentCommand);
    assert.equal(agentsOf(project)[0].id, agentId);
    assert.equal(agentsOf(project)[0].archived, false);
    assert.equal(agentsOf(project)[0].avatar, "orbit");
    assert.deepEqual(
      agentsOf(project)[0].scopeIds,
      [scopedThoughtId],
      "a specialist retains its selected branch IDs when first saved",
    );
    const { avatar: _avatar, ...legacyAgentCommand } = agentCommand;
    project = await command(legacyAgentCommand);
    assert.equal(
      agentsOf(project)[0].avatar,
      "orbit",
      "legacy edits retain the selected avatar",
    );
    assert.deepEqual(
      agentsOf(project)[0].scopeIds,
      [scopedThoughtId],
      "legacy metadata edits retain the selected branch IDs",
    );
    await assert.rejects(
      () => command({ ...agentCommand, avatar: "<script>" }),
      /Invalid agent avatar/,
    );
    project = await command({ ...agentCommand, avatar: "sprout" });
    assert.equal(agentsOf(project)[0].avatar, "sprout");
    assert.deepEqual(
      agentsOf(project)[0].scopeIds,
      [scopedThoughtId],
      "avatar edits retain the selected branch IDs",
    );

    const turnId = crypto.randomUUID();
    const note = await command({
      action: "turn",
      turnId,
      text: "A branch begins from this author turn.",
      mode: "note",
      focusId: null,
    });
    const branch = {
      conversationId: crypto.randomUUID(),
      title: "World branch",
      agentIds: [agentId],
      branch: {
        conversationId: "main",
        turnId,
        message: "user",
        revision: note.revision,
      },
      action: "create_conversation",
    };
    project = await command(branch);
    assert.equal(conversationsOf(project).at(-1)?.agentIds[0], agentId);
    const afterCreate = project;

    const invalidAssistant = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "create_conversation",
        conversationId: crypto.randomUUID(),
        title: "Invalid assistant branch",
        agentIds: [],
        branch: {
          conversationId: "main",
          turnId,
          message: "assistant",
          revision: project.revision,
        },
      },
    });
    assert.match(
      invalidAssistant.error?.message || "",
      /invalid conversation branch/i,
    );

    const staleBranch = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "create_conversation",
        conversationId: crypto.randomUUID(),
        title: "Stale branch",
        agentIds: [],
        branch: {
          conversationId: "main",
          turnId,
          message: "user",
          revision: project.revision - 1,
        },
      },
    });
    assert.match(
      staleBranch.error?.message || "",
      /invalid conversation branch/i,
    );

    const retryRequest = {
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "update_conversation",
      conversationId: branch.conversationId,
      title: "World branch, revised",
    };
    const firstRetry = await db.rpc("project_planning_command", {
      command: retryRequest,
    });
    assert.equal(firstRetry.error, null);
    const repeatedRetry = await db.rpc("project_planning_command", {
      command: retryRequest,
    });
    assert.equal(repeatedRetry.error, null);
    assert.equal(
      (repeatedRetry.data as Project).revision,
      (firstRetry.data as Project).revision,
      "repeating a command receipt does not apply it twice",
    );
    project = firstRetry.data as Project;

    const duplicate = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        ...branch,
      },
    });
    assert.match(duplicate.error?.message || "", /already exists/);

    const pendingId = crypto.randomUUID();
    project = await command({
      action: "turn",
      turnId: pendingId,
      text: "Keep the project context intact while replying.",
      mode: "assist",
      focusId: null,
    });

    const reaction = await command({
      action: "react",
      turnId,
      message: "user",
      reaction: "like",
    });
    assert.equal(
      thinkingOf(reaction).turns.find((turn) => turn.id === turnId)?.reaction
        ?.user,
      "like",
    );
    project = await command({
      action: "work",
      turnId: pendingId,
      work: {
        activity: [
          { label: "Consulting world specialist", detail: "Advisory only." },
        ],
      },
    });
    assert.equal(
      thinkingOf(project).turns.find((turn) => turn.id === pendingId)?.work
        ?.activity[0].label,
      "Consulting world specialist",
    );
    const prepared = preparePlanningResult(project, pendingId, {
      reply: "The shared context remains intact.",
      concepts: [
        {
          ref: "new:shared-context",
          title: "Shared context",
          body: "Keep the project context intact while replying.",
          category: "note",
          certainty: "stated",
          status: "open",
          answer: "",
          origin: "author",
          sourceTurn: "t2",
          quote: "Keep the project context intact while replying.",
          reason: "The author wrote this context.",
        },
      ],
      remove: [],
      relations: [],
      removeRelations: [],
      dismissProposals: [],
      focus: null,
      view: "map",
    });
    project = await command({
      action: "complete",
      turnId: pendingId,
      ...prepared,
    });
    assert.equal(
      conversationsOf(project).some(
        (entry) => entry.id === branch.conversationId,
      ),
      true,
    );
    assert.equal(
      agentsOf(project).some((agent) => agent.id === agentId),
      true,
    );
    assert.equal(project.thinking?.undo?.revision, project.revision);

    project = await command({
      action: "react",
      turnId: pendingId,
      message: "assistant",
      reaction: "like",
    });
    assert.equal(
      project.thinking?.undo?.revision,
      project.revision,
      "metadata reactions retain a valid undo marker",
    );

    const archive = await command({
      action: "archive_agent",
      agentId,
      archived: true,
    });
    assert.equal(
      agentsOf(archive).find((agent) => agent.id === agentId)?.archived,
      true,
    );
    assert.deepEqual(afterCreate.thinking?.conversations?.length, 2);
  } finally {
    await db.close();
  }
});

test("permanent conversation deletion purges recovery copies and provider pointers", async () => {
  const db = await planningTestDatabase(55483);
  try {
    let project = await db.createProject("Keep the independent project plan.");
    const itemId = crypto.randomUUID();
    const itemResult = await db.rpc("execute_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        expectedRevision: project.revision,
        action: {
          type: "add_item",
          itemId,
          item: {
            title: "Retained plan thought",
            body: "This authored plan remains after chat deletion.",
            category: "note",
            certainty: "stated",
            status: "open",
            answer: "",
            links: [],
          },
        },
      },
    });
    assert.equal(itemResult.error, null, itemResult.error?.message ?? "");
    project = itemResult.data as Project;

    const attachmentId = crypto.randomUUID();
    await db.sql`
      insert into account_private.attachments
        (id,owner_id,name,mime_type,byte_size,sha256,state)
      values
        (${attachmentId},${db.owner},'context.txt','application/octet-stream',24,
         ${"c".repeat(64)},'ready')
    `;
    const sourceId = crypto.randomUUID();
    await db.sql`
      insert into planning.project_sources
        (id,project_id,owner_id,attachment_id,name,mime_type,byte_size)
      values
        (${sourceId},${project.id},${db.owner},${attachmentId},'context.txt',
         'application/octet-stream',24)
    `;

    const beforeId = crypto.randomUUID();
    const removedId = crypto.randomUUID();
    const laterId = crypto.randomUUID();
    const finalId = crypto.randomUUID();
    const deletedConversationId = "research";
    const childConversationId = "child";
    const thinking = structuredClone(thinkingOf(project)) as ThinkingState;
    thinking.turns = [
      {
        id: beforeId,
        conversationId: mainConversationId,
        text: "Before the deleted conversation.",
        reply: "A retained answer.",
        status: "saved",
        focusId: null,
        createdAt: new Date().toISOString(),
        changedIds: [],
      },
      {
        id: removedId,
        conversationId: deletedConversationId,
        text: "SECRET CHAT TEXT MUST DISAPPEAR",
        reply: "SECRET CHAT REPLY MUST DISAPPEAR",
        status: "saved",
        focusId: null,
        createdAt: new Date().toISOString(),
        changedIds: [],
      },
      {
        id: laterId,
        conversationId: mainConversationId,
        text: "A later retained turn.",
        reply: "Retained later answer.",
        status: "saved",
        focusId: null,
        createdAt: new Date().toISOString(),
        changedIds: [],
      },
      {
        id: finalId,
        conversationId: mainConversationId,
        text: "A final retained turn.",
        reply: "Final retained answer.",
        status: "saved",
        focusId: null,
        createdAt: new Date().toISOString(),
        changedIds: [],
        composer: {
          ...defaultComposer(),
          sourceIds: [sourceId],
          quotes: [
            { turnId: removedId, text: "SECRET CHAT TEXT MUST DISAPPEAR" },
          ],
        },
        sourceReferences: [{ sourceId, quote: "A retained source reference." }],
        sourceUpdates: [
          {
            sourceId,
            sourceTurn: "t3",
            quote: "A later retained turn.",
            note: "Keep the source decision.",
            origin: "author",
          },
        ],
      },
    ];
    thinking.conversations.push(
      {
        id: deletedConversationId,
        title: "Research",
        agentIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
        branch: null,
      },
      {
        id: childConversationId,
        title: "Child branch",
        agentIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
        branch: {
          conversationId: deletedConversationId,
          turnId: removedId,
          message: "user",
          revision: project.revision,
        },
      },
    );
    const proposalItemId = crypto.randomUUID();
    thinking.proposals = [
      {
        id: crypto.randomUUID(),
        itemId: proposalItemId,
        item: {
          title: "Deleted proposal",
          body: "This proposal belongs to the deleted chat.",
          category: "note",
          certainty: "tentative",
          status: "open",
          answer: "",
          links: [],
        },
        reason: "Deleted chat only.",
        turnId: removedId,
      },
    ];
    thinking.relations = [
      {
        id: crypto.randomUUID(),
        from: proposalItemId,
        to: itemId,
        kind: "affects",
        reason: "Deleted proposal relation.",
      },
    ];
    thinking.undo = {
      revision: project.revision,
      turnId: removedId,
      items: [],
      relations: thinking.relations,
      proposals: thinking.proposals,
    };
    await db.sql`
      update planning.projects
      set thinking=${db.sql.json(thinking)}, revision=revision+1
      where id=${project.id}
    `;
    project = (await db.rpc("project_snapshot", { project_id: project.id }))
      .data as Project;
    await db.sql`
      update planning.items
      set evidence=${db.sql.json({ turnId: removedId, quote: "SECRET CHAT TEXT MUST DISAPPEAR" })}
      where id=${itemId}
    `;
    const oldCommandId = crypto.randomUUID();
    await db.sql`
      insert into planning.commands(owner_id,id,project_id,request,result)
      values(
        ${db.owner},${oldCommandId},${project.id},
        ${db.sql.json({
          id: oldCommandId,
          projectId: project.id,
          revision: project.revision,
          action: "turn",
          conversationId: deletedConversationId,
          turnId: removedId,
          text: "SECRET CHAT TEXT MUST DISAPPEAR",
        })},
        ${db.sql.json({ thinking })}
      )
    `;
    await db.sql`
      insert into planning.history(project_id,revision,action,after_item,context)
      values(
        ${project.id},999,'planning_complete',
        ${db.sql.json({
          title: "Deleted chat",
          body: "SECRET CHAT REPLY MUST DISAPPEAR",
          evidence: {
            turnId: removedId,
            quote: "SECRET CHAT TEXT MUST DISAPPEAR",
          },
        })},
        ${db.sql.json({ conversationId: deletedConversationId, turnId: removedId })}
      )
    `;
    const planningRunId = crypto.randomUUID();
    await db.sql`
      insert into account_private.project_planning_runs
        (id,owner_id,project_id,turn_id,fingerprint,status,model,max_output_tokens,
         reserve_microusd,capability_hash,actual_microusd,settled_at)
      values
        (${planningRunId},${db.owner},${project.id},${removedId},${"d".repeat(64)},
         'completed','gpt-5.6-luna',800,100,${"e".repeat(64)},0,clock_timestamp())
    `;
    const voiceRunId = crypto.randomUUID();
    await db.sql`
      insert into account_private.project_voice_sessions
        (id,owner_id,project_id,conversation_id,revision,fingerprint,status,model,
         max_duration_seconds,reserve_microusd,capability_hash,expires_at,
         transcript,actual_microusd,settled_at)
      values
        (${voiceRunId},${db.owner},${project.id},${deletedConversationId},${project.revision},
         ${"f".repeat(64)},'completed','gpt-live-1',60,62500,${"a".repeat(64)},
         clock_timestamp()+interval '1 hour',
         ${db.sql.json([{ speaker: "user", text: "SECRET VOICE TRANSCRIPT", startMs: 0, endMs: 4 }])},
         0,clock_timestamp())
    `;

    const deleteCommand = {
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "delete_conversation",
      conversationId: deletedConversationId,
    };
    const deleted = await db.rpc("project_planning_command", {
      command: deleteCommand,
    });
    assert.equal(deleted.error, null, deleted.error?.message ?? "");
    const after = deleted.data as Project;
    assert.equal(after.revision, project.revision + 1);
    assert.equal(
      conversationsOf(after).some(
        (entry) => entry.id === deletedConversationId,
      ),
      false,
    );
    assert.equal(
      thinkingOf(after).turns.some((turn) => turn.id === removedId),
      false,
    );
    assert.equal(
      thinkingOf(after).conversations.find(
        (entry) => entry.id === childConversationId,
      )?.branch,
      null,
    );
    assert.equal(thinkingOf(after).proposals.length, 0);
    assert.equal(thinkingOf(after).undo, null);
    assert.equal(
      after.items.find((item) => item.id === itemId)?.body,
      "This authored plan remains after chat deletion.",
    );
    assert.equal(
      after.items.find((item) => item.id === itemId)?.evidence,
      null,
    );
    assert.equal(
      thinkingOf(after).turns.find((turn) => turn.id === finalId)
        ?.sourceUpdates?.[0].sourceTurn,
      "t2",
      "source ordinals are rebased after a deleted turn",
    );
    const receipts = await db.sql`
      select request,result from planning.commands
      where project_id=${project.id} and request->>'action' <> 'delete_conversation'
    `;
    assert.equal(JSON.stringify(receipts).includes("SECRET CHAT"), false);
    assert.equal(
      JSON.stringify(receipts).includes(deletedConversationId),
      false,
    );
    assert.equal(
      (
        await db.sql`select count(*)::int as n from planning.history where project_id=${project.id} and revision=999`
      )[0].n,
      0,
    );
    const run =
      await db.sql`select turn_id from account_private.project_planning_runs where id=${planningRunId}`;
    assert.equal(run[0].turn_id, null);
    const voice =
      await db.sql`select conversation_id,transcript from account_private.project_voice_sessions where id=${voiceRunId}`;
    assert.equal(voice[0].conversation_id, null);
    assert.deepEqual(voice[0].transcript, []);

    const replay = await db.rpc("project_planning_command", {
      command: deleteCommand,
    });
    assert.equal(replay.error, null, replay.error?.message ?? "");
    assert.equal((replay.data as Project).revision, after.revision);
    const reused = await db.rpc("project_planning_command", {
      command: { ...deleteCommand, conversationId: childConversationId },
    });
    assert.equal(reused.error?.code, "22023");
    const stale = await db.rpc("project_planning_command", {
      command: {
        ...deleteCommand,
        id: crypto.randomUUID(),
        revision: project.revision,
        conversationId: childConversationId,
      },
    });
    assert.equal(stale.error?.code, "PT409");

    const other = crypto.randomUUID();
    await db.sql`insert into auth.users(id) values(${other})`;
    await db.sql`insert into auth.sessions(id,user_id) values(${other},${other})`;
    await db.sql`insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(${other},10,1000000)`;
    const foreign = await db.rpcFor(other)("project_planning_command", {
      command: {
        ...deleteCommand,
        id: crypto.randomUUID(),
        revision: after.revision,
      },
    });
    assert.equal(foreign.error?.code, "P0002");
  } finally {
    await db.close();
  }
});

test("deleting Main preserves detached notes until an explicit main turn", async () => {
  const db = await planningTestDatabase(55484);
  try {
    let project = await db.createProject("Main chat can be removed.");
    const first = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "turn",
        turnId: crypto.randomUUID(),
        mode: "note",
        text: "A separately saved plan thought.",
        focusId: null,
      },
    });
    assert.equal(first.error, null, first.error?.message ?? "");
    project = first.data as Project;
    assert.equal(
      conversationsOf(project).some(
        (conversation) => conversation.id === mainConversationId,
      ),
      true,
      "a note while Main exists keeps the ordinary Main-backed path",
    );
    const savedItemCount = project.items.length;
    const other = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "create_conversation",
        conversationId: "other",
        title: "Other chat",
        agentIds: [],
        branch: null,
      },
    });
    assert.equal(other.error, null, other.error?.message ?? "");
    project = other.data as Project;
    const command = {
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "delete_conversation",
      conversationId: mainConversationId,
    };
    const deleted = await db.rpc("project_planning_command", { command });
    assert.equal(deleted.error, null, deleted.error?.message ?? "");
    project = deleted.data as Project;
    assert.deepEqual(
      project.thinking?.conversations?.map((conversation) => conversation.id),
      ["other"],
    );
    assert.deepEqual(project.thinking?.turns, []);
    assert.equal(project.items.length, savedItemCount);

    const detachedNote = {
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "turn",
      turnId: crypto.randomUUID(),
      conversationId: mainConversationId,
      mode: "note",
      text: "A manual plan thought remains outside deleted chat history.",
      focusId: null,
    };
    const savedNote = await db.rpc("project_planning_command", {
      command: detachedNote,
    });
    assert.equal(savedNote.error, null, savedNote.error?.message ?? "");
    project = savedNote.data as Project;
    assert.deepEqual(
      conversationsOf(project).map((conversation) => conversation.id),
      ["other"],
    );
    assert.equal(thinkingOf(project).turns.length, 1);
    assert.equal(project.items.length, savedItemCount + 1);
    assert.equal(project.items.at(-1)?.body, detachedNote.text);

    const independentEdit = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "update_conversation",
        conversationId: "other",
        title: "Other chat, renamed",
      },
    });
    assert.equal(
      independentEdit.error,
      null,
      independentEdit.error?.message ?? "",
    );
    project = independentEdit.data as Project;

    const replayedNote = await db.rpc("project_planning_command", {
      command: detachedNote,
    });
    assert.equal(replayedNote.error, null, replayedNote.error?.message ?? "");
    assert.deepEqual(
      replayedNote.data,
      project,
      "replaying the note receipt after its revision advanced returns current state",
    );

    const foreignOwner = crypto.randomUUID();
    await db.sql`insert into auth.users(id) values(${foreignOwner})`;
    await db.sql`insert into auth.sessions(id,user_id) values(${foreignOwner},${foreignOwner})`;
    await db.sql`insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(${foreignOwner},10,1000000)`;
    const foreignReplay = await db.rpcFor(foreignOwner)(
      "project_planning_command",
      {
        command: {
          ...detachedNote,
          id: crypto.randomUUID(),
          revision: project.revision,
        },
      },
    );
    assert.equal(foreignReplay.error?.code, "P0002");
    assert.deepEqual(
      (await db.rpc("project_snapshot", { project_id: project.id })).data,
      project,
      "a different owner cannot use the detached note route",
    );

    const newMain = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "turn",
        turnId: crypto.randomUUID(),
        mode: "assist",
        text: "The user explicitly starts a new main chat.",
        focusId: null,
      },
    });
    assert.equal(newMain.error, null, newMain.error?.message ?? "");
    assert.equal(
      conversationsOf(newMain.data as Project).some(
        (conversation) => conversation.id === mainConversationId,
      ),
      true,
    );
    assert.equal(thinkingOf(newMain.data as Project).turns.length, 2);
    assert.equal(thinkingOf(newMain.data as Project).turns[0].status, "saved");
    assert.equal(
      thinkingOf(newMain.data as Project).turns[1].status,
      "pending",
    );
  } finally {
    await db.close();
  }
});
