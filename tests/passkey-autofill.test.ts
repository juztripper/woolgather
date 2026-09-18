import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectPasskey,
  requestOptions,
} from "../apps/web/src/account/passkeyAutofill";

type Api = Parameters<typeof collectPasskey>[0];
const options = {
  challenge: "AP_-",
  rpId: "localhost",
  userVerification: "required" as const,
  allowCredentials: [{ id: "_wA", type: "public-key" as const }],
};
const bytes = (...values: number[]) => Uint8Array.from(values).buffer;
const credential = {
  id: "_wA",
  rawId: bytes(255, 0),
  type: "public-key",
  authenticatorAttachment: "platform",
  response: {
    clientDataJSON: bytes(0, 255, 254),
    authenticatorData: bytes(255),
    signature: bytes(0, 1),
    userHandle: null,
  },
  getClientExtensionResults: () => ({}),
} as unknown as PublicKeyCredential;
const api = {
  startAuthentication: async () => ({
    data: { options, challenge_id: "challenge-1", expires_at: 9999999999 },
    error: null,
  }),
} as Api;

test("autofill retains server RP and verification requirements and serializes binary assertions", async () => {
  const signal = new AbortController().signal;
  const result = await collectPasskey(api, signal, true, async (request) => {
    assert.equal(request.mediation, "conditional");
    assert.equal(request.signal, signal);
    assert.equal(request.publicKey?.rpId, "localhost");
    assert.equal(request.publicKey?.userVerification, "required");
    assert.deepEqual(
      new Uint8Array(request.publicKey!.challenge as ArrayBuffer),
      new Uint8Array([0, 255, 254]),
    );
    return credential;
  });
  assert.equal(result.challengeId, "challenge-1");
  assert.deepEqual(result.credential.response, {
    clientDataJSON: "AP_-",
    authenticatorData: "_w",
    signature: "AAE",
    userHandle: undefined,
  });
  assert.equal(result.credential.rawId, "_wA");
  assert.deepEqual(
    new Uint8Array(
      requestOptions(options).allowCredentials![0].id as ArrayBuffer,
    ),
    new Uint8Array([255, 0]),
  );
});

test("switching methods while the challenge loads never opens a late device prompt", async () => {
  const controller = new AbortController();
  const late = {
    startAuthentication: async () => {
      controller.abort();
      return api.startAuthentication();
    },
  } as Api;
  await assert.rejects(
    collectPasskey(late, controller.signal, true, async () => {
      assert.fail("late browser prompt");
    }),
    { name: "AbortError" },
  );
});

test("a credential arriving after cancellation cannot reach server verification", async () => {
  const controller = new AbortController();
  await assert.rejects(
    collectPasskey(api, controller.signal, true, async () => {
      controller.abort();
      return credential;
    }),
    { name: "AbortError" },
  );
});

test("manual fallback opens the regular picker and handles a dismissed picker", async () => {
  await assert.rejects(
    collectPasskey(
      api,
      new AbortController().signal,
      false,
      async (request) => {
        assert.equal(request.mediation, "optional");
        return null;
      },
    ),
    { name: "NotAllowedError" },
  );
});
