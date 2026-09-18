import { test } from "node:test";
import assert from "node:assert/strict";
import { passkeyMessage } from "../apps/web/src/account/passkeys";

test("passkey errors explain cancellation and unavailable credentials without exposing provider details", () => {
  assert.match(
    passkeyMessage({ cause: { name: "NotAllowedError" } }),
    /cancelled or timed out/,
  );
  assert.match(passkeyMessage({ code: "ERROR_CEREMONY_ABORTED" }), /cancelled/);
  assert.match(
    passkeyMessage({ code: "passkey_disabled" }),
    /other sign-in methods still work/,
  );
  assert.match(passkeyMessage({ code: "ERROR_INVALID_RP_ID" }), /web address/);
  assert.match(
    passkeyMessage({ code: "webauthn_challenge_expired" }),
    /expired/,
  );
  assert.match(
    passkeyMessage({ code: "webauthn_credential_exists" }),
    /already connected/,
  );
  assert.doesNotMatch(
    passkeyMessage(new Error("secret provider payload")),
    /secret provider/,
  );
});
