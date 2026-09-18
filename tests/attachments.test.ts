import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleAttachments,
  mediaType,
  readFile,
} from "../supabase/functions/attachments/handler";

test("file bytes determine safe previews and oversized streams are cancelled", async () => {
  assert.equal(
    mediaType(new TextEncoder().encode('<svg onload="alert(1)">')),
    "application/octet-stream",
  );
  assert.equal(
    mediaType(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/png",
  );
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readFile(
      new Request("https://example.test", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    ),
    /20 MB/,
  );
  assert(cancelled);
});

test("attachment gateway denies revoked sessions, missing MFA, anonymous users and unauthorized maintenance before Storage", async () => {
  for (const scenario of ["revoked", "mfa_required", "anonymous", "operator"]) {
    let storageCalls = 0;
    const client = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "a", is_anonymous: scenario === "anonymous" } },
        }),
      },
      rpc: async (name: string) => ({
        data:
          name === "can_manage_attachments"
            ? false
            : scenario === "operator"
              ? "ok"
              : scenario === "mfa_required"
                ? "mfa_required"
                : "session_revoked",
      }),
      get storage() {
        storageCalls++;
        throw new Error("Storage must remain untouched");
      },
    };
    const response = await handleAttachments(
      new Request("https://example.test?action=cleanup", {
        method: "POST",
        headers: { Authorization: "Bearer user" },
      }),
      {
        url: "https://example.test",
        key: "public",
        serviceKey: "service-secret",
        createClient: () => client,
      },
    );
    assert.equal(
      response.status,
      scenario === "mfa_required" || scenario === "operator" ? 403 : 401,
    );
    assert.equal(storageCalls, 0);
  }
  const response = await handleAttachments(
    new Request("https://example.test"),
    {
      url: "",
      key: "",
      serviceKey: "",
      createClient: () => {
        throw new Error("No client without authentication");
      },
    },
  );
  assert.equal(response.status, 401);
});
