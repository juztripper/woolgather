import assert from "node:assert/strict";
import test from "node:test";
import type { Project } from "../packages/domain/src";
import {
  emptyThinking,
  type PlanningTurn,
} from "../packages/domain/src/projectPlanning";
import {
  agentConversationSchemaForAgents,
  appendToolResult,
  consultationSchemaForAgents,
  enablePlanningTools,
  readConversation,
  readConversationSchemaForProject,
} from "../apps/api/src/planningAgents";

const date = new Date().toISOString();

function projectWithReferences(): Project {
  const thinking = emptyThinking();
  const turn = (id: string, conversationId: string): PlanningTurn => ({
    id,
    conversationId,
    text: `Author message ${id}`,
    reply: `Reply ${id}`,
    status: "complete",
    focusId: null,
    createdAt: date,
    changedIds: [],
  });
  thinking.agents.push(
    {
      id: "designer",
      name: "Designer",
      instructions: "Keep the interface clear.",
      scopeIds: [],
      archived: false,
      createdAt: date,
    },
    {
      id: "archived-agent",
      name: "Archived agent",
      instructions: "This role is no longer available.",
      scopeIds: [],
      archived: true,
      createdAt: date,
    },
  );
  thinking.conversations.push(
    {
      id: "design-chat",
      title: "Design chat",
      agentIds: ["designer"],
      createdAt: date,
      updatedAt: date,
      archived: false,
      branch: null,
    },
    {
      id: "archived-chat",
      title: "Archived chat",
      agentIds: [],
      createdAt: date,
      updatedAt: date,
      archived: true,
      branch: null,
    },
  );
  thinking.turns.push(
    turn("main-turn", "main"),
    turn("archived-turn", "archived-chat"),
  );
  return {
    id: crypto.randomUUID(),
    name: "Reference bounds",
    description: "",
    revision: 1,
    updatedAt: date,
    items: [],
    thinking,
  };
}

function tool(request: string, name: string) {
  const found = (
    JSON.parse(request).tools as Array<Record<string, unknown>>
  ).find((candidate) => candidate.name === name);
  assert.ok(found, `${name} should be enabled`);
  return found.parameters as {
    properties: Record<string, any>;
  };
}

test("planning tools expose only project-owned active specialists and retained conversations", () => {
  const project = projectWithReferences();
  const body = enablePlanningTools(
    JSON.stringify({
      model: "gpt-5.6-sol",
      tools: [{ type: "function", name: "develop_project" }],
      input: [],
    }),
    project,
  );

  const consultation = tool(body, "consult_agents");
  assert.deepEqual(
    consultation.properties.tasks.items.properties.agentId.enum,
    ["designer"],
  );
  assert.equal(
    consultation.properties.tasks.items.properties.agentId.enum.includes(
      "archived-agent",
    ),
    false,
  );
  assert.equal(
    consultationSchemaForAgents(["designer"]).safeParse({
      tasks: [{ agentId: "archived-agent", task: "Use the old role." }],
    }).success,
    false,
  );

  const create = tool(body, "create_agent_conversation");
  assert.deepEqual(create.properties.agentIds.items.enum, ["designer"]);
  assert.equal(
    agentConversationSchemaForAgents(["designer"]).safeParse({
      title: "Foreign role",
      agentIds: ["someone-else"],
    }).success,
    false,
  );

  const read = tool(body, "read_conversation");
  assert.deepEqual(read.properties.conversationId.enum, [
    "main",
    "design-chat",
    "archived-chat",
  ]);
  const beforeTurnIds = read.properties.beforeTurnId.anyOf.find(
    (entry: { type?: string }) => entry.type === "string",
  );
  assert.deepEqual(beforeTurnIds.enum, ["main-turn", "archived-turn"]);
  assert.equal(
    readConversationSchemaForProject(
      ["main", "design-chat", "archived-chat"],
      ["main-turn", "archived-turn"],
    ).safeParse({
      conversationId: "foreign-chat",
      beforeTurnId: null,
    }).success,
    false,
  );

  // Archived conversations retain readable history; a deleted/foreign ID does
  // not cross the project boundary, and a turn from another conversation may
  // not be used as its paging cursor.
  assert.equal(
    readConversation(project, {
      conversationId: "archived-chat",
      beforeTurnId: null,
    }).messages.length,
    1,
  );
  assert.throws(
    () =>
      readConversation(project, {
        conversationId: "archived-chat",
        beforeTurnId: "main-turn",
      }),
    /Message unavailable/,
  );
  assert.throws(
    () =>
      readConversation(project, {
        conversationId: "foreign-chat",
        beforeTurnId: null,
      }),
    /Conversation unavailable/,
  );
});

test("source tool IDs are bounded to visible active sources and extend only from bounded search results", () => {
  const project = projectWithReferences();
  const activeSource = crypto.randomUUID();
  const archivedSource = crypto.randomUUID();
  const searchedSource = crypto.randomUUID();
  const source = (id: string, name: string, archived = false) => ({
    id,
    attachmentId: crypto.randomUUID(),
    name,
    mime: "text/plain",
    size: 12,
    note: name,
    meaning: "use" as const,
    archived,
    createdAt: date,
    updatedAt: date,
  });
  project.sources = [
    source(activeSource, "Visible notes.txt"),
    ...Array.from({ length: 23 }, (_, index) =>
      source(crypto.randomUUID(), `Catalog notes ${index}.txt`),
    ),
    source(searchedSource, "Searchable notes.txt"),
    {
      id: archivedSource,
      attachmentId: crypto.randomUUID(),
      name: "Old notes.txt",
      mime: "text/plain",
      size: 12,
      note: "Archived",
      meaning: "avoid",
      archived: true,
      createdAt: date,
      updatedAt: date,
    },
  ];
  const body = enablePlanningTools(
    JSON.stringify({
      model: "gpt-5.6-sol",
      tools: [{ type: "function", name: "develop_project" }],
      input: [],
    }),
    project,
  );
  const visibleIds = tool(body, "read_project_source").properties.sourceId.enum;
  assert.equal(visibleIds.length, 24);
  assert.equal(visibleIds.includes(activeSource), true);
  assert.equal(visibleIds.includes(searchedSource), false);
  assert.equal(visibleIds.includes(archivedSource), false);
  assert.deepEqual(
    tool(body, "reference_project_source").properties.sourceId.enum,
    visibleIds,
  );

  const searchedBody = appendToolResult(
    body,
    "search_project_sources",
    { query: "old" },
    [
      {
        id: searchedSource,
        name: "Search result",
        mime: "text/plain",
        size: 1,
      },
    ],
    false,
    [
      {
        type: "function_call",
        call_id: "search-call",
        name: "search_project_sources",
        arguments: '{"query":"old"}',
      },
    ],
  );
  const expandedIds = tool(searchedBody, "read_project_source").properties
    .sourceId.enum;
  assert.equal(expandedIds.length, 25);
  assert.equal(expandedIds.includes(activeSource), true);
  assert.equal(expandedIds.includes(searchedSource), true);
  assert.equal(
    JSON.parse(searchedBody)
      .tools.find(
        (candidate: { name: string }) =>
          candidate.name === "read_project_source",
      )
      .parameters.properties.sourceId.enum.includes(archivedSource),
    false,
  );
});
