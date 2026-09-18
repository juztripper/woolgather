import type { SupabaseClient } from "@supabase/supabase-js";
export type DeletionLink = {
  owner: string;
  requestId: string;
  signature: string;
};
const linkKey = "woolgather:account-deletion-link";
let link: DeletionLink | null = null;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function captureDeletionLink(url: URL) {
  if (url.pathname === "/account/delete" && url.hash) {
    const params = new URLSearchParams(url.hash.slice(1));
    const owner = params.get("owner") || "",
      requestId = params.get("request") || "",
      signature = params.get("signature") || "";
    link =
      uuid.test(owner) &&
      uuid.test(requestId) &&
      /^[0-9a-f]{64}$/.test(signature)
        ? { owner, requestId, signature }
        : null;
    try {
      if (link) sessionStorage.setItem(linkKey, JSON.stringify(link));
      else sessionStorage.removeItem(linkKey);
    } catch {
      /* Memory fallback. */
    }
    // Keep the capability out of address bars, history and outgoing navigation.
    window.history.replaceState(null, "", "/account/delete");
  }
  return pendingDeletionLink();
}
export function pendingDeletionLink(): DeletionLink | null {
  if (link) return link;
  try {
    const saved = JSON.parse(sessionStorage.getItem(linkKey) || "null");
    if (
      saved &&
      uuid.test(saved.owner) &&
      uuid.test(saved.requestId) &&
      /^[0-9a-f]{64}$/.test(saved.signature)
    )
      link = saved;
  } catch {
    /* Invalid hints confer no authority. */
  }
  return link;
}
export function clearDeletionLink() {
  link = null;
  try {
    sessionStorage.removeItem(linkKey);
  } catch {
    /* Memory fallback. */
  }
}
export async function deletionApi<
  T = { ready: boolean; requiresMfa: boolean; deleted?: boolean },
>(auth: SupabaseClient, action: string, body: unknown): Promise<T> {
  const {
    data: { session },
  } = await auth.auth.getSession();
  if (!session) throw new Error("Sign in to confirm account deletion.");
  let response: Response;
  try {
    response = await fetch(`/api/account/deletion/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Connection interrupted. Deletion has not been confirmed. Please retry.",
    );
  }
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(
      value.error || "Unable to complete this step. Please retry.",
    );
  return value;
}
export function clearDeletedAccountDrafts(userId: string) {
  for (const name of Object.keys(localStorage))
    if (name.startsWith(`wg:${userId}:`)) localStorage.removeItem(name);
  localStorage.removeItem(`woolgather:delete-account:${userId}`);
}
