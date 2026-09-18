import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { updatePassword } from "../apps/web/src/account/passwordChange";
import {
  completeAuthCallback,
  isPasswordRecovery,
  setPasswordRecovery,
} from "../apps/web/src/client";

test("PKCE recovery is caught before App subscribes, then permits password update", async () => {
  const storage = new Map<string, string>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const user = {
    id: "recovery-test-user",
    aud: "authenticated",
    role: "authenticated",
    email: "qa@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  const client = createClient("https://auth.example.test", "test-public-key", {
    auth: {
      flowType: "pkce",
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
        removeItem: (key) => {
          storage.delete(key);
        },
      },
    },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body || "{}"));
        calls.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/recover")) return Response.json({});
        if (url.pathname.endsWith("/token"))
          return Response.json({
            access_token: "test-access-token",
            refresh_token: "test-refresh-token",
            token_type: "bearer",
            expires_in: 3600,
            user,
          });
        if (url.pathname.endsWith("/user")) return Response.json(user);
        throw new Error("Unexpected request");
      },
    },
  });
  try {
    assert.equal(
      (
        await client.auth.resetPasswordForEmail(user.email, {
          redirectTo: "http://127.0.0.1:4200/auth/callback",
        })
      ).error,
      null,
    );
    assert.equal(calls[0].body.code_challenge_method, "s256");
    const result = await completeAuthCallback(
      client,
      new URL("http://127.0.0.1:4200/auth/callback?code=one-time-code"),
    );
    assert.equal(result.notice, "");
    assert.equal(isPasswordRecovery(user.id), true);
    assert.equal(isPasswordRecovery("another-user"), false);
    assert.equal(
      (
        await updatePassword(
          client,
          { password: "new-test-password" },
          "changed",
        )
      ).error,
      null,
    );
    assert.equal(
      calls.find((c) => c.body.password)?.body.password,
      "new-test-password",
    );
    assert.deepEqual(
      calls
        .filter((c) => c.path.endsWith("/user") && c.body.data)
        .map((c) => c.body.data),
      [{ password_email_kind: "changed" }, { password_email_kind: null }],
    );
    setPasswordRecovery("");
    assert.equal(isPasswordRecovery(user.id), false);
  } finally {
    setPasswordRecovery("");
    await client.auth.stopAutoRefresh();
  }
});
