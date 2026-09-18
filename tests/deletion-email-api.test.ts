import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import worker from "../apps/api/src/index";
import { accountDeletion } from "../apps/api/src/accountDeletion";
import { brandedEmail, deletionEmail } from "../packages/emails/src";
test("Deletion email only uses the server account, an allowed origin and a stable delivery key", async () => {
  const req = {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: "owner@example.test",
    expiresAt: 1234567890,
  };
  let calls = 0;
  let sent: Record<string, unknown> = {};
  let key = "";
  let unavailable = false;
  const client = {
    rpc: async () => ({ data: req, error: null }),
  } as unknown as SupabaseClient;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    calls++;
    sent = JSON.parse(String(init?.body));
    key = new Headers(init?.headers).get("Idempotency-Key")!;
    return Response.json({}, { status: unavailable ? 503 : 200 });
  };
  const env = {
    ACCOUNT_ACTION_SECRET: "secret-".repeat(8),
    RESEND_API_KEY: "test-only",
  };
  const request = new Request(
    "http://127.0.0.1:4200/api/account/deletion/request",
    { method: "POST" },
  );
  try {
    const response = await accountDeletion(request, client, env, {
      requestId: req.id,
      email: "attacker@example.test",
      redirect: "https://attacker.example",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(sent.to, [req.email]);
    assert.equal(key, `account-deletion/${req.id}`);
    assert.match(
      String(sent.html),
      /http:\/\/127.0.0.1:4200\/account\/delete#owner=/,
    );
    assert.doesNotMatch(String(sent.html), /attacker/);
    assert.doesNotMatch(
      await response.text(),
      /signature/,
      "the initiating browser cannot acquire the email capability",
    );
    assert.equal(
      (
        await accountDeletion(
          new Request("https://attacker.example/api/account/deletion/request", {
            method: "POST",
          }),
          client,
          env,
          { requestId: req.id },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await accountDeletion(new Request(request.url), client, env, {
          requestId: req.id,
        })
      ).status,
      405,
    );
    assert.equal(calls, 1, "rejected requests send no mail");
    unavailable = true;
    assert.equal(
      (await accountDeletion(request, client, env, { requestId: req.id }))
        .status,
      503,
      "a delivery failure cannot claim email sent",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("Anonymous scanners cannot consume a deletion link or trigger sending", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "public",
  } as Env;
  const response = await worker.fetch(
    new Request("https://woolgathering.app/api/account/deletion/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }) as Parameters<typeof worker.fetch>[0],
    env,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
  assert.equal(response.status, 401);
});
test("Branded email escapes values and keeps confirmation consequences clear", () => {
  assert.doesNotMatch(
    brandedEmail({
      title: "<script>",
      body: "a & b",
      footer: "safe",
      url: 'https://example.test/" onclick="bad',
      button: "Go",
    }),
    /<script>|href="[^"]*" onclick=/,
  );
  const mail = deletionEmail(
    "owner@example.test",
    "https://woolgathering.app/account/delete#test",
  );
  assert.match(mail.html, /woolgather/);
  assert.match(mail.html, /15 minutes/);
  assert.match(mail.text, /permanently delete/);
});
