import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeComposerCommand,
  filterComposerCommands,
  readComposerCommand,
} from "../apps/web/src/projects/composerCommands";

test("slash suggestions search action names and helpful descriptions while narrowing immediately", () => {
  assert.equal(filterComposerCommands("").length, 5);
  assert.deepEqual(
    filterComposerCommands("comp").map((item) => item.id),
    ["compare"],
  );
  assert.deepEqual(
    filterComposerCommands("NEXT STEPS").map((item) => item.id),
    ["next_steps"],
  );
  assert.deepEqual(
    filterComposerCommands("risks").map((item) => item.id),
    ["challenge"],
  );
  assert.deepEqual(filterComposerCommands("not-a-tool"), []);
});

test("slash selection removes only its command line content and preserves surrounding authored text", () => {
  const draft =
    "Compare A/B and https://example.com\n  /compare\nKeep this sentence exactly.";
  const start = draft.indexOf("/compare");
  // Selecting from the middle of a query must consume the full command, not leave a suffix.
  const command = readComposerCommand(draft, start + 4);
  assert.deepEqual(command, { start, end: start + 8, query: "compare" });
  assert.equal(
    consumeComposerCommand(draft, command!),
    "Compare A/B and https://example.com\n  \nKeep this sentence exactly.",
  );
  assert.equal(consumeComposerCommand("/", readComposerCommand("/", 1)!), "");
});

test("slash parsing leaves prose, URLs, file paths, text selections and a caret outside the command alone", () => {
  for (const draft of [
    "A/B",
    "https://example.com",
    "/workspace/project",
    "// comment",
    "/compare?",
  ]) {
    assert.equal(readComposerCommand(draft, draft.length), null, draft);
  }
  assert.equal(readComposerCommand("/compare", 0), null);
  assert.equal(readComposerCommand("/compare", 2, 6), null);
  assert.equal(readComposerCommand("/compare\nWriting", 16), null);
});

test("slash commands after a sentence preserve the draft and its spacing", () => {
  for (const prefix of [
    "Are there better fits? ",
    "First line\nNext sentence. ",
    "Keep this\t",
  ]) {
    for (const query of ["", "comp", "compare"]) {
      const draft = prefix + "/" + query;
      const command = readComposerCommand(draft, draft.length);
      assert.deepEqual(command, {
        start: prefix.length,
        end: draft.length,
        query,
      });
      assert.equal(consumeComposerCommand(draft, command!), prefix);
    }
  }
  assert.equal(readComposerCommand("sentence/compare", 16), null);
  const url = "Read https://example.com/path";
  assert.equal(readComposerCommand(url, url.length), null);
});
