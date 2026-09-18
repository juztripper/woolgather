import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankIdeaRequest,
  createBlankIdea,
  restoreBlankIdeaRequest,
} from "../apps/web/src/library/createIdea";
import type { api } from "../apps/web/src/client";

test("a lost Idea creation acknowledgement recovers the same saved page", async () => {
  const command = blankIdeaRequest();
  const created = new Map();
  let loseAcknowledgement = true;
  const request = (async (_path: string, body?: typeof command) => {
    if (body) {
      if (!created.has(body.targetId))
        created.set(body.targetId, { id: body.targetId, body: "" });
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("Lost acknowledgement");
      }
      return {};
    }
    return { folders: [], ideas: [...created.values()] };
  }) as typeof api;
  await assert.rejects(
    createBlankIdea(command, request),
    /Lost acknowledgement/,
  );
  const recovered = await createBlankIdea(command, request);
  assert.equal(recovered.idea.id, command.targetId);
  assert.equal(created.size, 1);
});

test("an acknowledged write without a visible saved Idea cannot finish creation", async () => {
  const command = blankIdeaRequest();
  const missing = (async () => ({ folders: [], ideas: [] })) as typeof api;
  await assert.rejects(
    createBlankIdea(command, missing),
    /could not be confirmed/,
  );
});

test("recovered first-Idea requests cannot contain editing or destructive commands", () => {
  const blank = blankIdeaRequest();
  assert.deepEqual(restoreBlankIdeaRequest(blank), blank);
  for (const invalid of [
    null,
    {},
    { ...blank, type: "trash_idea" },
    { ...blank, expectedRevision: 1 },
    { ...blank, body: "Existing writing" },
  ])
    assert.equal(restoreBlankIdeaRequest(invalid), null);
});
