import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@supabase/supabase-js";
import { guardedSessionStorage } from "../apps/web/src/account/sessionStorage";
import {
  accountStorageKey,
  initializeAccountPool,
  recordAccountRedirect,
  routeAccountCallback,
  chooseAccountCallback,
  getAccountCallbackChoices,
  clearAccountRedirect,
  activeAccountSlot,
  accountClient,
  switchAccount,
  addAccount,
  cancelAddAccount,
  pendingAddition,
  slots,
} from "../apps/web/src/account/sessionPool";
class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
function serial() {
  let pending = Promise.resolve();
  return <T>(action: () => Promise<T>): Promise<T> => {
    const next = pending.then(action);
    pending = next.then(
      () => {},
      () => {},
    );
    return next;
  };
}
test("a simultaneous stale sign-in cannot overwrite an occupied account; refresh and metadata updates still persist", async () => {
  const backing = new MemoryStorage();
  const lock = serial();
  const firstTab = guardedSessionStorage(backing, "slot-1", lock);
  const secondTab = guardedSessionStorage(backing, "slot-1", lock);
  const a = JSON.stringify({
    user: { id: "account-a" },
    access_token: "first",
  });
  const b = JSON.stringify({
    user: { id: "account-b" },
    access_token: "other",
  });
  const results = await Promise.allSettled([
    firstTab.setItem("slot-1", a),
    secondTab.setItem("slot-1", b),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(backing.getItem("slot-1"), a);
  const updated = JSON.stringify({
    user: { id: "account-a", user_metadata: { avatar_id: "cloud" } },
    access_token: "refreshed",
  });
  await secondTab.setItem("slot-1", updated);
  assert.equal(backing.getItem("slot-1"), updated);
  backing.setItem("slot-2", b);
  await firstTab.removeItem("slot-1");
  assert.equal(backing.getItem("slot-2"), b);
  await firstTab.setItem("slot-1", b);
  assert.equal(backing.getItem("slot-1"), b);
});
test("new-tab callbacks route to their originating account; ambiguous callbacks require a choice without changing another tab", async () => {
  const local = new MemoryStorage();
  const tab = new MemoryStorage();
  const originalLocal = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const originalSession = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    value: local,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: tab,
    configurable: true,
  });
  try {
    initializeAccountPool(
      "https://account-test.supabase.co",
      "publishable-test-key",
    );
    assert.equal(
      accountStorageKey("https://account-test.supabase.co", 0),
      "sb-account-test-auth-token",
    );
    tab.setItem("woolgather:active-account", "1");
    recordAccountRedirect("recovery", "Second account");
    tab.clear(); // New tab, same browser's persistent Auth storage.
    assert.equal(
      routeAccountCallback(
        new URL("https://app.test/auth/callback?code=opaque"),
      ),
      1,
    );
    assert.equal(activeAccountSlot(), 1);
    clearAccountRedirect();
    tab.setItem("woolgather:active-account", "0");
    recordAccountRedirect("signin", "First account");
    tab.setItem("woolgather:active-account", "2");
    recordAccountRedirect("confirmation", "Third account");
    const originatingTab = new Map(tab.values);
    tab.clear();
    assert.throws(
      () =>
        routeAccountCallback(
          new URL("https://app.test/auth/callback?code=opaque"),
        ),
      /Choose the account/,
    );
    assert.equal(activeAccountSlot(), 0);
    const third = getAccountCallbackChoices().find((c) => c.slot === 2)!;
    chooseAccountCallback(third);
    assert.equal(
      routeAccountCallback(
        new URL("https://app.test/auth/callback?code=opaque"),
      ),
      2,
    );
    clearAccountRedirect();
    assert.equal(
      routeAccountCallback(new URL("https://app.test/projects/123")),
      2,
    );
    assert.equal(originatingTab.get("woolgather:active-account"), "2");
    assert.equal(getAccountCallbackChoices().length, 0);
  } finally {
    for (const slot of slots) await accountClient(slot).auth.dispose();
    if (originalLocal)
      Object.defineProperty(globalThis, "localStorage", originalLocal);
    else delete (globalThis as any).localStorage;
    if (originalSession)
      Object.defineProperty(globalThis, "sessionStorage", originalSession);
    else delete (globalThis as any).sessionStorage;
  }
});

test("switching, adding and cancelling accounts reopen the app directly while preserving slot ownership", async (t) => {
  const local = new MemoryStorage();
  const tab = new MemoryStorage();
  const destinations: string[] = [];
  const original = new Map(
    ["localStorage", "sessionStorage", "navigator", "window"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "localStorage", {
    value: local,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: tab,
    configurable: true,
  });
  try {
    initializeAccountPool(
      "https://account-navigation-test.supabase.co",
      "publishable-test-key",
    );
    for (const slot of slots)
      t.mock.method(accountClient(slot).auth, "getSession", async () => ({
        data: {
          session:
            slot < 2 ? ({ user: { id: `account-${slot}` } } as Session) : null,
        },
        error: null,
      }));
    Object.defineProperty(globalThis, "navigator", {
      value: {
        locks: {
          request: async (_name: string, action: () => Promise<void>) =>
            action(),
        },
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        location: { assign: (url: string) => destinations.push(url) },
      },
      configurable: true,
    });
    tab.setItem("woolgather:password-recovery", "account-0");
    await switchAccount(1);
    assert.equal(activeAccountSlot(), 1);
    assert.equal(tab.getItem("woolgather:password-recovery"), null);
    assert.deepEqual(destinations, ["/recent"]);

    await assert.rejects(switchAccount(2), /That account has signed out/);
    assert.equal(activeAccountSlot(), 1);
    assert.equal(destinations.length, 1);

    await addAccount();
    assert.equal(activeAccountSlot(), 2);
    assert.equal(pendingAddition()?.slot, 2);
    assert.equal(pendingAddition()?.previous, 1);
    assert.deepEqual(destinations, ["/recent", "/recent"]);

    cancelAddAccount();
    assert.equal(activeAccountSlot(), 1);
    assert.equal(pendingAddition(), null);
    assert.equal(
      local.getItem(
        "woolgather:account-navigation-test.supabase.co:account-lease:2",
      ),
      null,
    );
    assert.deepEqual(destinations, ["/recent", "/recent", "/recent"]);
  } finally {
    for (const slot of slots) await accountClient(slot).auth.dispose();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
