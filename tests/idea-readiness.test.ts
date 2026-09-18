import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ideaReadinessBasis,
  preservesIdeaReadiness,
} from "../packages/domain/src/ideaReadiness";
import {
  emptyIdeaDocument,
  withIdeaBlocks,
} from "../packages/domain/src/ideaDocument";
import { textBlock, blocksText } from "../packages/domain/src/ideaBlocks";
const doc = withIdeaBlocks(emptyIdeaDocument(), [
  textBlock("concept", "An app for discovering food."),
  textBlock("audience", "People who want new meals.", "ideaAnswer", {
    field: "audience",
    prompt: "Who is it for?",
  }),
  textBlock("blank", ""),
]);
const basis = ideaReadinessBasis(blocksText(doc.blocks), doc);

test("readiness retains writing edits, additions, moves and removal of unreviewed placeholders", () => {
  const changed = withIdeaBlocks(doc, [
    textBlock("audience", "People curious about food.", "ideaAnswer", {
      field: "audience",
      prompt: "Who is it for?",
    }),
    textBlock("new", "A calm experience."),
    textBlock("concept", "An app to discover new food."),
  ]);
  assert.equal(
    preservesIdeaReadiness(basis, blocksText(changed.blocks), changed),
    true,
  );
  const removeAdded = withIdeaBlocks(
    changed,
    changed.blocks.filter((b) => b.id !== "new"),
  );
  assert.equal(
    preservesIdeaReadiness(basis, blocksText(removeAdded.blocks), removeAdded),
    true,
  );
  assert.deepEqual(ideaReadinessBasis(blocksText(doc.blocks), doc), basis);
});

test("removing or clearing a reviewed paragraph or answer clears readiness", () => {
  for (const id of ["concept", "audience"]) {
    const removed = withIdeaBlocks(
      doc,
      doc.blocks.filter((b) => b.id !== id),
    );
    assert.equal(
      preservesIdeaReadiness(basis, blocksText(removed.blocks), removed),
      false,
    );
    const cleared = withIdeaBlocks(
      doc,
      doc.blocks.map((b) => (b.id === id ? { ...b, content: [] } : b)),
    );
    assert.equal(
      preservesIdeaReadiness(basis, blocksText(cleared.blocks), cleared),
      false,
    );
  }
  assert.equal(
    preservesIdeaReadiness(basis, blocksText(doc.blocks), doc),
    true,
    "undo restores reviewed content",
  );
});

test("reviewed attachments are retained through resizing and invalidated by removal or replacement", () => {
  const image = {
    ...textBlock("image", "", "image"),
    props: {
      url: "woolgather:file:00000000-0000-4000-8000-000000000001",
      caption: "Reference",
      previewWidth: 320,
    },
  };
  const withImage = withIdeaBlocks(doc, [...doc.blocks, image]);
  const imageBasis = ideaReadinessBasis(
    blocksText(withImage.blocks),
    withImage,
  );
  const resized = withIdeaBlocks(withImage, [
    ...doc.blocks,
    { ...image, props: { ...image.props, previewWidth: 250 } },
  ]);
  assert.equal(
    preservesIdeaReadiness(imageBasis, blocksText(resized.blocks), resized),
    true,
  );
  assert.equal(
    preservesIdeaReadiness(imageBasis, blocksText(doc.blocks), doc),
    false,
  );
  const replaced = withIdeaBlocks(withImage, [
    ...doc.blocks,
    {
      ...image,
      props: {
        ...image.props,
        url: "woolgather:file:00000000-0000-4000-8000-000000000002",
      },
    },
  ]);
  assert.equal(
    preservesIdeaReadiness(imageBasis, blocksText(replaced.blocks), replaced),
    false,
  );
});
