import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderPage } from "../apps/web/src/PageEntry";

test("a failed page download replaces its loading status with accessible recovery", async () => {
  const frames: string[] = [];
  await renderPage(
    { render: (page: ReactNode) => frames.push(renderToStaticMarkup(page)) },
    () => Promise.reject(new Error("Chunk unavailable")),
  );
  assert.match(frames[0], /role="status"/);
  assert.match(frames[1], /role="alert"/);
  assert.match(frames[1], /Reload page/);
  assert.match(frames[1], /href="\/support"/);
  assert.doesNotMatch(frames[1], /Chunk unavailable/);
});

test("a successfully loaded page replaces the entry status", async () => {
  const frames: string[] = [];
  await renderPage(
    { render: (page: ReactNode) => frames.push(renderToStaticMarkup(page)) },
    () => Promise.resolve(createElement("main", null, "Loaded page")),
  );
  assert.equal(frames.at(-1), "<main>Loaded page</main>");
});
