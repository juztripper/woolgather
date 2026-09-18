import type { SupabaseClient, UserAttributes } from "@supabase/supabase-js";

type Result = { error: { code?: string } | null };
/** Auth enforces current-password/recent-session policy and sends change alerts.
 * This helper handles extra reauthentication only; never retry a write automatically. */
export async function changePassword(
  update: () => Promise<Result>,
  sendCode: () => Promise<Result>,
  requireCode: () => void,
): Promise<"saved" | "code-sent"> {
  const result = await update();
  if (!result.error) return "saved";
  if (result.error.code !== "reauthentication_needed") throw result.error;
  requireCode();
  const sent = await sendCode();
  if (sent.error) throw sent.error;
  return "code-sent";
}
/** Email copy only, never an authorization claim. Auth sends the notification
 * before applying data in a password update, so stage the label first and clear
 * it in the password write. Every app password path sets its own label. */
export async function updatePassword(
  auth: SupabaseClient,
  attributes: UserAttributes,
  kind: "added" | "changed",
) {
  const staged = await auth.auth.updateUser({
    data: { password_email_kind: kind },
  });
  if (staged.error) return staged;
  const result = await auth.auth.updateUser({
    ...attributes,
    data: { ...attributes.data, password_email_kind: null },
  });
  if (result.error) {
    // Failed writes do not apply the cleanup metadata. Do not replace the
    // original Auth error if this best-effort cosmetic cleanup also fails.
    await auth.auth
      .updateUser({ data: { password_email_kind: null } })
      .catch(() => {});
  }
  return result;
}
