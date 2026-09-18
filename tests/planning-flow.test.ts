import assert from "node:assert/strict";
import { test } from "node:test";
import { planningFlow } from "../apps/web/src/projects/planningFlow";

test("flow layout keeps disconnected journeys together and orders actual predecessors first", () => {
  const nodes = [
    "check-in",
    "borrower",
    "available",
    "history",
    "checkout",
    "inspection",
    "drop-box",
    "unconnected",
  ].map((id) => ({ id }));
  const edges = [
    { from: "borrower", to: "checkout" },
    { from: "check-in", to: "history" },
    { from: "checkout", to: "drop-box" },
    { from: "checkout", to: "inspection" },
    { from: "drop-box", to: "inspection" },
    { from: "inspection", to: "available" },
    { from: "missing", to: "available" },
  ];
  const untouched = structuredClone(edges);
  assert.deepEqual(
    planningFlow(nodes, edges).map((group) => group.map((node) => node.id)),
    [
      ["borrower", "checkout", "drop-box", "inspection", "available"],
      ["check-in", "history"],
    ],
  );
  assert.deepEqual(
    edges,
    untouched,
    "Layout must not invent or rewrite the plan's connections.",
  );
});

test("flow layout retains every step of a loop, its branch and isolated sequences", () => {
  const nodes = [
    "available",
    "borrowed",
    "inspect",
    "issue",
    "other",
    "done",
  ].map((id) => ({ id }));
  const edges = [
    { from: "available", to: "borrowed" },
    { from: "borrowed", to: "inspect" },
    { from: "inspect", to: "available" },
    { from: "inspect", to: "issue" },
    { from: "issue", to: "available" },
    { from: "other", to: "done" },
  ];
  assert.deepEqual(
    planningFlow(nodes, edges).map((group) => group.map((node) => node.id)),
    [
      ["available", "borrowed", "inspect", "issue"],
      ["other", "done"],
    ],
  );
  assert.deepEqual(planningFlow(nodes, []), []);
});
