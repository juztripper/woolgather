import test from "node:test";
import assert from "node:assert/strict";
import {
  readComposerMention,
  insertComposerMention,
} from "../apps/web/src/projects/composerMentions";

test("mentions work within a sentence without consuming the task that follows", () => {
  const text = "Please ask @Ux to review this layout.";
  const mention = readComposerMention(text, text.indexOf(" to"));
  assert.deepEqual(mention, { start: 11, end: 14, query: "Ux" });
  const inserted = insertComposerMention(text, mention!, "Experience");
  assert.equal(inserted.text, "Please ask @Experience to review this layout.");
  assert.equal(inserted.text.slice(inserted.caret), " to review this layout.");
});

test("mention parsing preserves email addresses, URLs, selected text and earlier lines", () => {
  for (const text of [
    "mail@example.com",
    "https://example.com/@owner",
    "name@agent",
    "@Design\nWrite here",
  ])
    assert.equal(readComposerMention(text, text.length), null, text);
  assert.equal(readComposerMention("@Design", 2, 5), null);
  assert.equal(readComposerMention("Ask (@Design", 12)?.query, "Design");
  assert.equal(
    readComposerMention("Ask @Árvore azul", 16)?.query,
    "Árvore azul",
  );
});

test("click insertion and upload selection preserve authored text and caret", () => {
  const inserted = insertComposerMention(
    "Please review this.",
    { start: 7, end: 7 },
    "board.png",
  );
  assert.equal(inserted.text, "Please @board.png review this.");
  assert.equal(inserted.caret, 18);
  assert.deepEqual(
    insertComposerMention("Add @files here", { start: 4, end: 10 }, undefined),
    { text: "Add  here", caret: 4 },
  );
});
