import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changePassword,
  updatePassword,
} from "../apps/web/src/account/passwordChange";
import type { SupabaseClient, UserAttributes } from "@supabase/supabase-js";

test("password mail uses the staged action and clears it on successful writes", async () => {
  let metadata: Record<string, unknown> = {};
  const notifications: unknown[] = [];
  const auth = {
    auth: {
      updateUser: async (attributes: UserAttributes) => {
        // Auth sends the password notification before applying this request's data.
        if (attributes.password)
          notifications.push(metadata.password_email_kind);
        metadata = { ...metadata, ...attributes.data };
        return { data: { user: {} }, error: null };
      },
    },
  } as unknown as SupabaseClient;
  await updatePassword(auth, { password: "first-test-password" }, "added");
  assert.equal(metadata.password_email_kind, null);
  await updatePassword(
    auth,
    { password: "next-test-password", current_password: "first-test-password" },
    "changed",
  );
  assert.deepEqual(notifications, ["added", "changed"]);
  assert.equal(metadata.password_email_kind, null);
});

test("failed metadata staging prevents password write; failed password write cleans up", async () => {
  for (const failAt of [1, 2]) {
    const calls: UserAttributes[] = [];
    const failure = { code: "test-error" };
    const auth = {
      auth: {
        updateUser: async (attributes: UserAttributes) => {
          calls.push(attributes);
          return {
            data: { user: null },
            error: calls.length === failAt ? failure : null,
          };
        },
      },
    } as unknown as SupabaseClient;
    const result = await updatePassword(
      auth,
      { password: "test-password" },
      "added",
    );
    assert.equal(result.error, failure);
    assert.equal(calls.length, failAt === 1 ? 1 : 3);
    if (failAt === 2)
      assert.deepEqual(calls[2], { data: { password_email_kind: null } });
  }
});
test("recent-session password save does not request an extra reauthentication code", async () => {
  assert.equal(
    await changePassword(
      async () => ({ error: null }),
      async () => {
        throw Error("unexpected email");
      },
      () => {
        throw Error("unexpected challenge");
      },
    ),
    "saved",
  );
});
test("verification requirement sends one code and waits without retrying password write", async () => {
  const calls: string[] = [];
  assert.equal(
    await changePassword(
      async () => {
        calls.push("update");
        return { error: { code: "reauthentication_needed" } };
      },
      async () => {
        calls.push("email");
        return { error: null };
      },
      () => {
        calls.push("show-code");
      },
    ),
    "code-sent",
  );
  assert.deepEqual(calls, ["update", "show-code", "email"]);
});
test("unrelated or invalid-code errors do not send email", async () => {
  for (const code of [
    "weak_password",
    "reauthentication_not_valid",
    "current_password_mismatch",
    "current_password_invalid",
    "current_password_required",
  ]) {
    const error = { code };
    await assert.rejects(
      changePassword(
        async () => ({ error }),
        async () => {
          throw Error("unexpected email");
        },
        () => {
          throw Error("unexpected challenge");
        },
      ),
      (e) => e === error,
    );
  }
});
test("email delivery failure preserves the verification step for resend", async () => {
  let required = false;
  const error = { code: "over_email_send_rate_limit" };
  await assert.rejects(
    changePassword(
      async () => ({ error: { code: "reauthentication_needed" } }),
      async () => ({ error }),
      () => {
        required = true;
      },
    ),
    (e) => e === error,
  );
  assert.equal(required, true);
});
