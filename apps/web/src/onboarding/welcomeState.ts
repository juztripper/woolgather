import type { SupabaseClient, User } from "@supabase/supabase-js";
export type WelcomeAction = "orientation" | "complete" | "dismissed";
export function needsWelcome(
  user: Pick<User, "user_metadata">,
  projectCount: number,
  ideaCount = 0,
) {
  const state = user.user_metadata.welcome_v1;
  return (
    projectCount === 0 &&
    ideaCount === 0 &&
    state !== "complete" &&
    state !== "dismissed"
  );
}
export function welcomeName(user: Pick<User, "user_metadata">) {
  const name =
    user.user_metadata.display_name ??
    user.user_metadata.full_name ??
    user.user_metadata.name;
  return typeof name === "string" ? name.slice(0, 80) : "";
}
/** User-editable presentation preference only; never used for authorization. */
export async function saveWelcome(
  auth: SupabaseClient,
  owner: string,
  action: WelcomeAction,
  name: string,
) {
  const { data: current, error: readError } = await auth.auth.getUser();
  if (readError) throw readError;
  if (current.user?.id !== owner) throw new Error("Account changed");
  const data: Record<string, string> = { welcome_v1: action };
  // Dismissal does not silently save edits; blank optional input preserves provider names.
  if (action !== "dismissed" && name.trim())
    data.display_name = name.trim().slice(0, 80);
  const result = await auth.auth.updateUser({ data });
  if (result.error) throw result.error;
  if (
    result.data.user?.id !== owner ||
    result.data.user.user_metadata.welcome_v1 !== action
  )
    throw new Error("Welcome was not saved");
  return result.data.user;
}
