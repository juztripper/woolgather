import {
  createClient,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { guardedSessionStorage } from "./sessionStorage";

export const ACCOUNT_LIMIT = 3;
export type AccountSlot = 0 | 1 | 2;
export type SavedAccount = { slot: AccountSlot; user: User; active: boolean };
const activeKey = "woolgather:active-account";
const addingKey = "woolgather:adding-account";
const leaseDuration = 30 * 60_000;
type Addition = {
  slot: AccountSlot;
  previous: AccountSlot;
  id: string;
  until: number;
};
export const slots: AccountSlot[] = [0, 1, 2];
export function parseSlot(value: unknown): AccountSlot {
  return value === "1" || value === 1
    ? 1
    : value === "2" || value === 2
      ? 2
      : 0;
}
export function accountStorageKey(url: string, slot: AccountSlot) {
  const legacy = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  return slot === 0 ? legacy : `${legacy}-account-${slot + 1}`;
}
function read<T>(storage: Storage, key: string): T | null {
  try {
    return JSON.parse(storage.getItem(key) || "null");
  } catch {
    return null;
  }
}
export function activeAccountSlot(): AccountSlot {
  try {
    return parseSlot(sessionStorage.getItem(activeKey));
  } catch {
    return 0;
  }
}
export function pendingAddition(): Addition | null {
  try {
    const value = read<Addition>(sessionStorage, addingKey);
    return value &&
      slots.includes(value.slot) &&
      slots.includes(value.previous) &&
      typeof value.id === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
let pool: SupabaseClient[] = [];
let poolScope = "";
// Clients never exchange stored credentials. Each SDK instance owns one key,
// its PKCE verifiers, refresh lifecycle and same-account tab broadcasts.
export function initializeAccountPool(url: string, key: string) {
  poolScope = new URL(url).hostname;
  let persistent: Storage | undefined;
  try {
    localStorage.setItem("woolgather:storage-check", "ok");
    localStorage.removeItem("woolgather:storage-check");
    persistent = localStorage;
  } catch {
    /* The SDK retains its single-account memory fallback. */
  }
  pool = slots.map((slot) =>
    createClient(url, key, {
      auth: {
        experimental: { passkey: true },
        flowType: "pkce",
        detectSessionInUrl: false,
        storageKey: accountStorageKey(url, slot),
        ...(persistent
          ? {
              storage: guardedSessionStorage(
                persistent,
                accountStorageKey(url, slot),
                (action) =>
                  navigator.locks
                    ? navigator.locks.request(
                        `woolgather:${poolScope}:session-write:${slot}`,
                        action,
                      )
                    : action(),
              ),
            }
          : {}),
      },
    }),
  );
  return pool[activeAccountSlot()];
}
export function accountClient(slot: AccountSlot) {
  if (!pool[slot])
    throw new Error("Accounts are still loading. Please try again.");
  return pool[slot];
}
export async function savedAccounts(): Promise<SavedAccount[]> {
  const entries = await Promise.all(
    slots.map(async (slot) => {
      const { data, error } = await accountClient(slot).auth.getSession();
      if (error) throw error;
      return data.session
        ? {
            slot,
            user: data.session.user,
            active: slot === activeAccountSlot(),
          }
        : null;
    }),
  );
  return entries.filter((a): a is SavedAccount => !!a);
}
function leaseKey(slot: AccountSlot) {
  return `woolgather:${poolScope}:account-lease:${slot}`;
}
function releaseAddition(addition: Addition) {
  const lease = read<Addition>(localStorage, leaseKey(addition.slot));
  if (lease?.id === addition.id)
    localStorage.removeItem(leaseKey(addition.slot));
  sessionStorage.removeItem(addingKey);
  const redirect = read<AccountRedirect>(
    localStorage,
    redirectKey(addition.slot),
  );
  if (redirect?.addition?.id === addition.id)
    localStorage.removeItem(redirectKey(addition.slot));
}
function activate(slot: AccountSlot) {
  // A full navigation clears outstanding views and request closures. The slot
  // choice is tab-local; another open tab keeps its own selected account.
  sessionStorage.setItem(activeKey, String(slot));
  sessionStorage.removeItem("woolgather:password-recovery");
  window.location.assign("/recent");
}
export async function switchAccount(slot: AccountSlot) {
  const { data, error } = await accountClient(slot).auth.getSession();
  if (error) throw error;
  if (!data.session)
    throw new Error("That account has signed out. Add it again to continue.");
  const addition = pendingAddition();
  if (addition) releaseAddition(addition);
  activate(slot);
}
export async function addAccount() {
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely add another account. Please use a browser with Web Locks support.",
    );
  // Reserve an empty slot across tabs, without persisting any extra tokens.
  await navigator.locks.request(
    `woolgather:${poolScope}:add-account`,
    async () => {
      const accounts = await savedAccounts();
      const slot = slots.find(
        (s) =>
          !accounts.some((a) => a.slot === s) &&
          (read<Addition>(localStorage, leaseKey(s))?.until || 0) < Date.now(),
      );
      if (slot === undefined)
        throw new Error(
          "Up to three accounts can stay signed in. Sign out of one, or finish adding it in your other tab, to make room.",
        );
      const addition: Addition = {
        slot,
        previous: activeAccountSlot(),
        id: crypto.randomUUID(),
        until: Date.now() + leaseDuration,
      };
      // Storage failure stops this operation before any existing account changes.
      sessionStorage.setItem(addingKey, JSON.stringify(addition));
      localStorage.setItem(leaseKey(slot), JSON.stringify(addition));
      activate(slot);
    },
  );
}
export function cancelAddAccount() {
  const addition = pendingAddition();
  if (!addition) return;
  releaseAddition(addition);
  activate(addition.previous);
}
/** Called before starting a new sign-in, including after returning from an old tab. */
export async function prepareAccountSignIn() {
  const addition = pendingAddition();
  if (!addition) return;
  const lease = read<Addition>(localStorage, leaseKey(addition.slot));
  const { data } = await accountClient(addition.slot).auth.getSession();
  if (lease?.id !== addition.id || data.session)
    throw new Error(
      "This sign-in is no longer available. Go back to your account and choose Add account again.",
    );
  addition.until = Date.now() + leaseDuration;
  localStorage.setItem(leaseKey(addition.slot), JSON.stringify(addition));
  sessionStorage.setItem(addingKey, JSON.stringify(addition));
}
/** Reuse an existing login if Add account authenticated the same identity. */
export async function finishAccountSignIn(
  session: Session | null,
): Promise<boolean> {
  const addition = pendingAddition();
  if (!addition || !session) return true;
  const existing = (await savedAccounts()).find(
    (a) => a.slot !== addition.slot && a.user.id === session.user.id,
  );
  if (existing) {
    const { error } = await accountClient(addition.slot).auth.signOut({
      scope: "local",
    });
    if (error) throw error;
    releaseAddition(addition);
    activate(existing.slot);
    return false;
  }
  releaseAddition(addition);
  return true;
}

export type AccountRedirect = {
  id: string;
  slot: AccountSlot;
  at: number;
  label: string;
  purpose: "signin" | "confirmation" | "recovery" | "link" | "email";
  addition: Addition | null;
};
const redirectTabKey = "woolgather:account-redirect";
let callbackChoices: AccountRedirect[] = [];
function redirectKey(slot: AccountSlot) {
  return `woolgather:${poolScope}:auth-return:${slot}`;
}
export function recordAccountRedirect(
  purpose: AccountRedirect["purpose"],
  label = "Account sign-in",
) {
  const slot = activeAccountSlot();
  const entry: AccountRedirect = {
    id: crypto.randomUUID(),
    slot,
    at: Date.now(),
    label,
    purpose,
    addition: pendingAddition(),
  };
  localStorage.setItem(redirectKey(slot), JSON.stringify(entry));
  sessionStorage.setItem(redirectTabKey, entry.id);
  sessionStorage.setItem(activeKey, String(slot));
}
export function clearAccountRedirect() {
  try {
    const slot = activeAccountSlot();
    const entry = read<AccountRedirect>(localStorage, redirectKey(slot));
    if (entry?.id === sessionStorage.getItem(redirectTabKey))
      localStorage.removeItem(redirectKey(slot));
    sessionStorage.removeItem(redirectTabKey);
  } catch {
    /* Optional return hints never block a completed sign-in. */
  }
}
export function getAccountCallbackChoices() {
  return callbackChoices;
}
export function chooseAccountCallback(entry: AccountRedirect) {
  callbackChoices = [];
  sessionStorage.setItem(activeKey, String(entry.slot));
  sessionStorage.setItem(redirectTabKey, entry.id);
  if (entry.addition)
    sessionStorage.setItem(addingKey, JSON.stringify(entry.addition));
  else sessionStorage.removeItem(addingKey);
}
/** Route new-tab email links without adding parameters to approved redirect URLs.
 * The marker only selects a client. PKCE and the server still authenticate it.
 * Ambiguous links require a choice, never a trial exchange against other accounts.
 */
export function routeAccountCallback(url: URL) {
  if (
    url.pathname !== "/auth/callback" &&
    !url.searchParams.has("code") &&
    !url.searchParams.has("error")
  )
    return activeAccountSlot();
  const entries = slots
    .map((slot) => read<AccountRedirect>(localStorage, redirectKey(slot)))
    .filter(
      (entry): entry is AccountRedirect =>
        !!entry &&
        slots.includes(entry.slot) &&
        Date.now() - entry.at < leaseDuration,
    );
  const tabId = sessionStorage.getItem(redirectTabKey);
  const own = entries.find((entry) => entry.id === tabId);
  const selected = own || (entries.length === 1 ? entries[0] : null);
  if (selected) {
    chooseAccountCallback(selected);
    return selected.slot;
  }
  if (entries.length > 1) {
    callbackChoices = entries;
    throw new Error("Choose the account whose sign-in link you opened.");
  }
  return activeAccountSlot();
}

/** Select an existing account before booting a signed email action. */
export async function selectAccountForAction(owner: string) {
  const existing = (await savedAccounts()).find((a) => a.user.id === owner);
  if (existing) sessionStorage.setItem(activeKey, String(existing.slot));
  return accountClient(activeAccountSlot());
}
