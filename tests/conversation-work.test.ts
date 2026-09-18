import test from "node:test";
import assert from "node:assert/strict";
import {
  failureActivityLabel,
  failureWorkActivity,
  failureWorkReason,
  visibleWorkActivity,
  workPresentation,
} from "../apps/web/src/projects/conversationWork";

test("conversation work exposes the latest durable failure reason", () => {
  const activity = [
    { label: "Consulted Designer", detail: "Keep the state readable." },
    {
      label: failureActivityLabel,
      detail: "The specialist response was invalid.",
    },
    { label: failureActivityLabel, detail: "The consultation ended safely." },
  ];

  assert.equal(failureWorkActivity(activity)?.label, failureActivityLabel);
  assert.equal(failureWorkReason(activity), "The consultation ended safely.");
  assert.deepEqual(
    visibleWorkActivity([
      ...activity,
      { label: "Saving the reply" },
      { label: "Thinking" },
    ]).map((entry) => entry.label),
    ["Consulted Designer", failureActivityLabel, failureActivityLabel],
  );
});

test("legacy failed turns without a durable reason keep the compatibility fallback", () => {
  assert.equal(failureWorkReason([{ label: "Consulted Designer" }]), undefined);
});

test("work presentation keeps terminal statuses distinct from active and successful work", () => {
  assert.deepEqual(
    workPresentation({
      status: "failed",
      completedAt: "2026-09-17T10:00:00.000Z",
    }),
    {
      cancelled: false,
      complete: false,
      failed: true,
      interrupted: false,
      isPending: false,
      stale: false,
      stopped: true,
      working: false,
    },
  );
  assert.equal(
    workPresentation({
      status: "complete",
      interrupted: true,
    }).complete,
    true,
  );
  assert.equal(
    workPresentation({ status: "complete", interrupted: true }).interrupted,
    false,
  );
  assert.equal(
    workPresentation({ status: "pending", pending: true }).working,
    true,
  );
  assert.deepEqual(
    workPresentation({ status: "pending", replying: true, completedAt: "now" }),
    {
      cancelled: false,
      complete: true,
      failed: false,
      interrupted: false,
      isPending: true,
      stale: false,
      stopped: false,
      working: false,
    },
  );
});

test("suggestion and connection saves remain visible when there are no thought links", () => {
  const saved = {
    label: "Updated the plan",
    detail: "2 suggestions, 1 connection",
  };
  assert.deepEqual(
    visibleWorkActivity([
      { label: "Updating the plan" },
      { label: "Updated the plan", detail: "1 thought" },
      saved,
      { label: "Saved the reply" },
    ]),
    [saved],
  );
});
