import { test } from "node:test";
import assert from "node:assert/strict";
import { finishOAuth, loginOptions } from "../apps/web/src/oauth";

test("OAuth callbacks exchange the code once and never follow a supplied destination", async () => {
  const codes: string[] = [];
  const result = await finishOAuth(
    new URL(
      "https://woolgathering.app/auth/callback?code=one-time-code&next=https://untrusted.example",
    ),
    async (code) => {
      codes.push(code);
      return { error: null };
    },
  );
  assert.deepEqual(codes, ["one-time-code"]);
  assert.deepEqual(result, { handled: true, notice: "" });
});
test("Cancelled consent is handled without exchanging a code or reflecting external text", async () => {
  let called = false;
  const result = await finishOAuth(
    new URL(
      "https://woolgathering.app/auth/callback#error=access_denied&error_description=untrusted-content",
    ),
    async () => {
      called = true;
      return { error: null };
    },
  );
  assert.equal(called, false);
  assert.match(result.notice, /cancelled/);
  assert.doesNotMatch(result.notice, /untrusted/);
});
test("Expired PKCE state and connection failure leave a restartable sign-in", async () => {
  for (const exchange of [
    async () => ({ error: new Error("expired") }),
    async () => {
      throw new Error("offline");
    },
  ]) {
    const result = await finishOAuth(
      new URL("http://127.0.0.1:4200/auth/callback?code=expired"),
      exchange,
    );
    assert.match(result.notice, /sign in or request a new password reset link/);
  }
  assert.match(
    (
      await finishOAuth(
        new URL("http://localhost:4200/auth/callback"),
        async () => ({ error: null }),
      )
    ).notice,
    /incomplete/,
  );
});
test("Ordinary project navigation is not consumed as an auth callback", async () => {
  assert.deepEqual(
    await finishOAuth(
      new URL("https://woolgathering.app/projects/example"),
      async () => {
        throw new Error("must not exchange");
      },
    ),
    { handled: false, notice: "" },
  );
});
test("Both providers use identity-only scopes and the current origin's exact callback", () => {
  assert.deepEqual(loginOptions("github", "http://127.0.0.1:4200"), {
    provider: "github",
    options: {
      redirectTo: "http://127.0.0.1:4200/auth/callback",
      scopes: "user:email",
    },
  });
  assert.deepEqual(loginOptions("google", "https://woolgathering.app"), {
    provider: "google",
    options: {
      redirectTo: "https://woolgathering.app/auth/callback",
      scopes: "openid email profile",
    },
  });
});
