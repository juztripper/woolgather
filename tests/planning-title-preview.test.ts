import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyStartsWithTitleAtWordBoundary,
  planRowTitle,
} from "../apps/web/src/projects/PlanningMap";

test("plan title prefixes stop at a word boundary", () => {
  assert.equal(bodyStartsWithTitleAtWordBoundary("Art", "Art"), true);
  assert.equal(bodyStartsWithTitleAtWordBoundary("Art", "Art: details"), true);
  assert.equal(bodyStartsWithTitleAtWordBoundary("Art", "Art — details"), true);
  assert.equal(bodyStartsWithTitleAtWordBoundary("Art", "Articles"), false);
  assert.equal(
    bodyStartsWithTitleAtWordBoundary("Art", "Articles should stay separate"),
    false,
  );
});

test("plan title prefixes respect Unicode letters and combining marks", () => {
  assert.equal(
    bodyStartsWithTitleAtWordBoundary("Árvore", "Árvore antiga"),
    true,
  );
  assert.equal(
    bodyStartsWithTitleAtWordBoundary("Árvore", "Árvores antigas"),
    false,
  );
  assert.equal(
    bodyStartsWithTitleAtWordBoundary("日本語", "日本語を読む"),
    false,
  );
  assert.equal(
    bodyStartsWithTitleAtWordBoundary("Cafe", "Cafe\u0301 notes"),
    false,
  );
});

test("plan row titles keep exact copies and punctuation readable", () => {
  assert.equal(planRowTitle("Plan", "Plan"), "Plan");
  assert.equal(planRowTitle("Plan", "Plan: details"), "Plan…");
  assert.equal(planRowTitle("Plan", "Planify the next step"), "Plan");
  assert.equal(
    planRowTitle("Write a plan", "Write a plan for later"),
    "Write a…",
  );
});

test("single word titles never collapse to an ellipsis", () => {
  assert.equal(planRowTitle("Art", "Art grows over time"), "Art…");
  assert.equal(planRowTitle("Art", "Articles grow over time"), "Art");
});
