import type { SupportedStorage } from "@supabase/supabase-js";

/** The SDK still owns session persistence. This guard prevents a stale login
 * in another tab from replacing a different account in an occupied slot.
 */
export function guardedSessionStorage(
  storage: SupportedStorage,
  sessionKey: string,
  exclusive: <T>(action: () => Promise<T>) => Promise<T>,
): SupportedStorage {
  return {
    getItem: (key) => storage.getItem(key),
    removeItem: (key) =>
      exclusive(async () => {
        await storage.removeItem(key);
      }),
    setItem: (key, value) =>
      exclusive(async () => {
        if (key === sessionKey) {
          const oldValue = await storage.getItem(key);
          let before, after;
          try {
            before = oldValue ? JSON.parse(oldValue) : null;
            after = JSON.parse(value);
          } catch {
            /* SDK owns malformed-session recovery. */
          }
          if (
            before?.user?.id &&
            after?.user?.id &&
            before.user.id !== after.user.id
          )
            throw new Error(
              "Another account is already using this sign-in slot. Return to your account and choose Add account again.",
            );
        }
        await storage.setItem(key, value);
      }),
  };
}
