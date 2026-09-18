import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { briefSections } from "../apps/web/src/projects/model";
import { ProjectText } from "../apps/web/src/projects/ProjectText";
import { conversationReferenceMatches } from "../apps/web/src/projects/conversationReferenceText";

test("the working brief retains fenced headings and complete author wording", () => {
  const sections = briefSections(
    "An idea 🥣\n\n## Boundaries\n\nMaybe later — not a commitment.\n\n```md\n## This is code\nunchanged\n```\n\n## Audience\n\nPeople who cook.",
  );
  assert.equal(sections.length, 3);
  assert.equal(sections[0].body, "An idea 🥣");
  assert.equal(
    sections[1].body,
    "Maybe later — not a commitment.\n\n```md\n## This is code\nunchanged\n```",
  );
  assert.equal(sections[2].body, "People who cook.");
});

test("planning text renders links and code while keeping supplied HTML and unsafe URLs inert", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectText, {
      text: "Read [the reference](https://example.com/guide). Keep **maybe** and `menu_id`.\n\n<script>alert(1)</script> [unsafe](javascript:alert(1))\n\n```html\n<button>example only</button>\n```",
    }),
  );
  assert.match(html, /href="https:\/\/example.com\/guide"/);
  assert.match(html, /<strong>maybe<\/strong>/);
  assert.match(html, /<code>menu_id<\/code>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;button&gt;example only&lt;\/button&gt;/);
  assert.doesNotMatch(html, /<script|<button|href="javascript:/);
});

test("saved mention matching prefers complete labels and stable unique IDs", () => {
  const references = [
    { id: "long-source", label: "Garden notes" },
    { id: "long-thought", label: "Garden notes" },
    { id: "short-thought", label: "Garden" },
    { id: "regex-agent", label: "C++ (fast)?" },
  ];
  const text = "Keep @Garden notes, then @Garden. Review @C++ (fast)?.";
  const matches = conversationReferenceMatches(text, references);
  assert.deepEqual(
    matches.map(({ reference, start, end }) => ({
      id: reference.id,
      text: text.slice(start, end),
    })),
    [
      { id: "short-thought", text: "@Garden" },
      { id: "regex-agent", text: "@C++ (fast)?" },
    ],
    "an ambiguous full label stays authored text while unique labels keep their IDs",
  );
});
