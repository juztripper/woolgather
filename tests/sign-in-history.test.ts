import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lastSignIn,
  rememberSignIn,
  pendingSignIn,
  finishSignInHistory,
} from "../apps/web/src/signInHistory";
test("Only successful recent sign-ins update the browser hint, and storage failure is harmless", () => {
  const makeStorage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: makeStorage(),
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: makeStorage(),
  });
  assert.equal(lastSignIn(), null);
  rememberSignIn("email");
  pendingSignIn("github");
  assert.equal(lastSignIn(), "email");
  finishSignInHistory(false);
  assert.equal(lastSignIn(), "email");
  pendingSignIn("google");
  finishSignInHistory(true);
  assert.equal(lastSignIn(), "google");
  sessionStorage.setItem(
    "woolgather:pending-sign-in",
    JSON.stringify({ provider: "github", at: Date.now() - 31 * 60_000 }),
  );
  finishSignInHistory(true);
  assert.equal(lastSignIn(), "google");
  localStorage.setItem("woolgather:last-sign-in", "invalid");
  assert.equal(lastSignIn(), null);
  rememberSignIn("passkey");
  assert.equal(lastSignIn(), "passkey");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  assert.equal(lastSignIn(), null);
  assert.doesNotThrow(() => rememberSignIn("email"));
});
