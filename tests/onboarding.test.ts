import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  needsWelcome,
  saveWelcome,
  welcomeName,
} from "../apps/web/src/onboarding/welcomeState";
const user = (metadata: Record<string, unknown> = {}) =>
  ({ id: "owner", user_metadata: metadata }) as User;
test("welcome eligibility respects completion, dismissal and existing projects", () => {
  assert.equal(needsWelcome(user(), 0), true);
  assert.equal(needsWelcome(user({ welcome_v1: "orientation" }), 0), true);
  for (const state of ["complete", "dismissed"])
    assert.equal(needsWelcome(user({ welcome_v1: state }), 0), false);
  assert.equal(needsWelcome(user(), 1), false);
  assert.equal(
    needsWelcome(user(), 0, 1),
    false,
    "Existing Ideas also identify a returning author",
  );
  assert.equal(
    welcomeName(user({ full_name: "Existing name" })),
    "Existing name",
  );
  assert.equal(welcomeName(user()), "");
});
function fixture({ fail = false, owner = "owner" } = {}) {
  let metadata: Record<string, unknown> = {
    avatar_id: "fern",
    full_name: "Provider name",
  };
  let calls = 0;
  const auth = {
    auth: {
      getUser: async () => ({
        data: { user: { ...user(metadata), id: owner } },
        error: null,
      }),
      updateUser: async ({ data }: { data: Record<string, unknown> }) => {
        calls++;
        if (fail) return { data: {}, error: new Error("Offline") };
        metadata = { ...metadata, ...data };
        return { data: { user: user(metadata) }, error: null };
      },
    },
  } as unknown as SupabaseClient;
  return { auth, metadata: () => metadata, calls: () => calls };
}
test("name and progress persist without replacing unrelated profile fields", async () => {
  const f = fixture();
  await saveWelcome(f.auth, "owner", "orientation", "  River  ");
  assert.equal(f.metadata().display_name, "River");
  assert.equal(f.metadata().avatar_id, "fern");
  await saveWelcome(f.auth, "owner", "complete", "");
  assert.equal(f.metadata().display_name, "River");
  assert.equal(needsWelcome(user(f.metadata()), 0), false);
});
test("dismissal is durable but does not silently save an unsubmitted name", async () => {
  const f = fixture();
  await saveWelcome(f.auth, "owner", "dismissed", "Unsaved edit");
  assert.equal(f.metadata().display_name, undefined);
  assert.equal(f.metadata().welcome_v1, "dismissed");
});
test("failed writes do not advance progress and account changes prevent writes", async () => {
  const offline = fixture({ fail: true });
  await assert.rejects(saveWelcome(offline.auth, "owner", "complete", "Name"));
  assert.equal(offline.metadata().welcome_v1, undefined);
  const switched = fixture({ owner: "someone-else" });
  await assert.rejects(saveWelcome(switched.auth, "owner", "complete", "Name"));
  assert.equal(switched.calls(), 0);
});
