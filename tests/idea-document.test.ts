import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIdeaBrief,
  buildProjectBrief,
  emptyIdeaDocument,
  ideaDocumentSchema,
  pendingIdeaQuestions,
} from "../packages/domain/src/ideaDocument";
import { libraryCommandSchema } from "../packages/domain/src/library";
import { exportMarkdown } from "../packages/domain/src";

test("automatic project brief carries short content exactly and keeps long source intact", () => {
  const doc = emptyIdeaDocument();
  doc.answers.possibilities = "Maybe offline support, not decided.";
  const before = structuredClone(doc);
  assert.equal(
    buildProjectBrief("A cooking app", doc),
    buildIdeaBrief("A cooking app", doc),
  );
  const long = "A complete paragraph about the cooking experience.\n\n".repeat(
    400,
  );
  const brief = buildProjectBrief(long, doc);
  assert(brief.length <= 12000);
  assert(brief.startsWith("A complete paragraph"));
  assert(
    brief.endsWith(
      "[Continued in Original idea, where the complete document is preserved.]",
    ),
  );
  assert.equal(
    buildIdeaBrief(long, doc),
    long.trim() +
      "\n\nPossibilities — not commitments\nMaybe offline support, not decided.",
  );
  assert.deepEqual(doc, before);
  assert.doesNotThrow(() =>
    encodeURIComponent(buildProjectBrief("🌿".repeat(13000), doc)),
  );
});

test("only explicitly kept questions enter handoff; unfilled legacy fields add no checklist", () => {
  const doc = emptyIdeaDocument();
  assert.deepEqual(pendingIdeaQuestions("A detailed existing idea", doc), []);
  doc.answers.purpose = "Not sure yet";
  doc.later = ["purpose", "audience", "experience"];
  assert.deepEqual(pendingIdeaQuestions("An idea", doc), []);
  doc.questions = [
    {
      id: crypto.randomUUID(),
      text: "Should this include delivery?",
      important: false,
    },
  ];
  assert.deepEqual(
    pendingIdeaQuestions("An idea", doc).map((q) => q.text),
    ["Should this include delivery?"],
  );
  assert.doesNotMatch(
    buildIdeaBrief("An idea", doc),
    /What should someone|Who is this for/,
  );
});
test("brief preserves source wording, tentative meaning, captions, and unresolved questions", () => {
  const doc = emptyIdeaDocument();
  doc.answers.possibilities = "Maybe loyalty rewards, but not decided.";
  doc.questions = [
    {
      id: crypto.randomUUID(),
      text: "Should rewards stay outside the first version?",
      important: false,
    },
  ];
  doc.references = [
    {
      id: crypto.randomUUID(),
      name: "Counter sketch.png",
      caption: "Collection point, not a proposed screen",
    },
  ];
  const body = "A restaurant app.\nDo not introduce delivery.";
  const brief = buildIdeaBrief(body, doc);
  assert(brief.startsWith(body));
  assert(
    brief.includes(
      "Possibilities — not commitments\nMaybe loyalty rewards, but not decided.",
    ),
  );
  assert(brief.includes(doc.references[0].caption));
  assert(brief.includes("Still open"));
  assert.equal(doc.title, "");
  assert(ideaDocumentSchema.safeParse(doc).success);
  assert(
    !ideaDocumentSchema.safeParse({
      ...doc,
      references: [...doc.references, ...doc.references],
    }).success,
  );
  const cmd = {
    id: crypto.randomUUID(),
    targetId: crypto.randomUUID(),
    expectedRevision: 1,
    type: "convert_idea",
    projectId: crypto.randomUUID(),
    name: "",
    folderId: null,
    brief,
    questions: pendingIdeaQuestions(body, doc).map((q) => q.text),
  };
  assert(libraryCommandSchema.safeParse(cmd).success);
  assert(
    !libraryCommandSchema.safeParse({ ...cmd, brief: "a".repeat(12001) })
      .success,
  );
  const markdown = exportMarkdown(
    {
      id: cmd.projectId,
      name: "Untitled Project",
      description: brief,
      revision: 1,
      updatedAt: "",
      items: [],
      originalIdea: body,
      ideaDocument: doc,
      references: doc.references,
    },
    { [doc.references[0].id]: "data:image/png;base64,AAAA" },
  );
  assert(markdown.includes(body));
  assert(markdown.includes("data:image/png;base64,AAAA"));
  assert(markdown.includes("Possibilities (not commitments)"));
});
