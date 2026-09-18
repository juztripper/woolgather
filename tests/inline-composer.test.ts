import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { history, undo, redo } from "@tiptap/pm/history";
import {
  composerSchema,
  inlineDocument,
  inlineText,
  inlineIds,
  positionAtOffset,
  offsetAtPosition,
  plainContent,
} from "../apps/web/src/projects/inlineComposerDocument";

const image = {
  id: "source-image",
  label: "reference image.webp",
  kind: "source",
};
const agent = { id: "agent-design", label: "Designer", kind: "agent" };

test("inline references preserve prose, newlines and emoji without linking email addresses", () => {
  const text =
    "Look 🌊 at @reference image.webp,\nthen ask @Designer. mail@Designer is plain.";
  const doc = inlineDocument(text, [image, agent]);
  assert.equal(inlineText(doc), text);
  assert.deepEqual(inlineIds(doc), [image.id, agent.id]);
  const nodes: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "mention") nodes.push(node.attrs.label);
  });
  assert.deepEqual(nodes, [image.label, agent.label]);
});

test("text offsets map across atomic references and multiline selections", () => {
  const prefix = "Ask 🌊 ";
  const text = prefix + "@Designer\nabout this.";
  const doc = inlineDocument(text, [agent]);
  for (const offset of [
    0,
    prefix.length,
    prefix.length + agent.label.length + 1,
    text.length,
  ]) {
    assert.equal(offsetAtPosition(doc, positionAtOffset(doc, offset)), offset);
  }
  assert.equal(
    positionAtOffset(doc, prefix.length + agent.label.length + 1) -
      positionAtOffset(doc, prefix.length),
    1,
  );
});

test("deleting an inline reference removes its context and undo restores the same ID", () => {
  let state = EditorState.create({
    schema: composerSchema,
    doc: inlineDocument("Ask @Designer", [agent]),
    plugins: [history()],
  });
  const from = positionAtOffset(state.doc, 4);
  state = state.apply(state.tr.delete(from, from + 1));
  assert.equal(inlineText(state.doc), "Ask ");
  assert.deepEqual(inlineIds(state.doc), []);
  assert.equal(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
    true,
  );
  assert.deepEqual(inlineIds(state.doc), [agent.id]);
  assert.equal(inlineText(state.doc), "Ask @Designer");
  assert.equal(
    redo(state, (tr) => {
      state = state.apply(tr);
    }),
    true,
  );
  assert.deepEqual(inlineIds(state.doc), []);
});

test("saved inline drafts retain distinct IDs when labels are identical", () => {
  const a = { id: "source-a", label: "same.pdf", kind: "source" };
  const b = { ...a, id: "source-b" };
  const doc = composerSchema.node("doc", null, [
    composerSchema.node("paragraph", null, [
      composerSchema.nodes.mention.create(b),
      composerSchema.text(" and "),
      composerSchema.nodes.mention.create(a),
    ]),
  ]);
  const restored = composerSchema.nodeFromJSON(
    JSON.parse(JSON.stringify(doc.toJSON())),
  );
  const reconciled = inlineDocument(
    inlineText(restored) + ".",
    [a, b],
    restored,
  );
  assert.deepEqual(inlineIds(reconciled), [b.id, a.id]);
});

test("plain pasted text cannot create references or HTML nodes", () => {
  const text = "<img src=x onerror=alert(1)>\n@Designer";
  const doc = composerSchema.node("doc", null, [
    composerSchema.node("paragraph", null, plainContent(text)),
  ]);
  assert.equal(inlineText(doc), text);
  assert.deepEqual(inlineIds(doc), []);
});
