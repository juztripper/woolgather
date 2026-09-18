import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { planningFailure } from "../apps/api/src/planningFailure";
import {
  GuidanceFailure,
  type GuidanceUsage,
} from "../apps/api/src/openaiGuidance";

test("durable planning failures exclude thrown input and provider payloads", () => {
  const secret = "private-provider-and-author-content";
  for (const error of [
    new Error(secret),
    z.object({ value: z.literal("expected") }).safeParse({ value: secret })
      .error,
    new GuidanceFailure(secret),
    new GuidanceFailure(secret, {} as GuidanceUsage),
  ]) {
    const failure = planningFailure(error, "consultation");
    assert.equal(JSON.stringify(failure).includes(secret), false);
    assert.ok(failure.message);
  }
  assert.match(
    planningFailure(new GuidanceFailure("interrupted_stream"), "specialist")
      .message,
    /paused while its outcome is checked/,
  );
  assert.equal(
    planningFailure(
      new Error("The requested specialist is unavailable."),
      "consultation",
    ).code,
    "specialist_unavailable",
  );
});
