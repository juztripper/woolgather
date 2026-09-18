import type { User } from "@supabase/supabase-js";
export type SettingsSection =
  "profile" | "preferences" | "security" | "account" | "billing" | "usage";
export type AccountSession = {
  id: string;
  current: boolean;
  createdAt: string;
  lastActiveAt: string;
  userAgent: string;
};
export type AccountOverview = {
  hasPassword: boolean;
  sessions: AccountSession[];
};
export function displayName(user: Pick<User, "user_metadata" | "email">) {
  const name =
    user.user_metadata?.display_name ??
    user.user_metadata?.full_name ??
    user.user_metadata?.name;
  return typeof name === "string" && name.trim()
    ? name.trim().slice(0, 80)
    : user.email?.split("@")[0] || "Your account";
}
export function initials(user: Pick<User, "user_metadata" | "email">) {
  return displayName(user)
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
}
export function deviceName(agent: string) {
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /(?:Chrome|CriOS)\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const os = /iPhone/.test(agent)
    ? "iPhone"
    : /iPad/.test(agent)
      ? "iPad"
      : /Android/.test(agent)
        ? "Android"
        : /Macintosh|Mac OS X/.test(agent)
          ? "Mac"
          : /Windows/.test(agent)
            ? "Windows"
            : /Linux/.test(agent)
              ? "Linux"
              : "";
  return agent ? `${browser}${os ? ` on ${os}` : ""}` : "Unknown device";
}
export function reducedMotion() {
  return (
    document.documentElement.dataset.motion === "reduce" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
export function applyPreferences(user?: User) {
  const root = document.documentElement;
  const motion = user?.user_metadata?.motion === "reduce" ? "reduce" : "system";
  const contrast = user?.user_metadata?.contrast === "more" ? "more" : "system";
  const motionChanged = root.dataset.motion !== motion;
  if (motionChanged && root.dataset.motion) {
    // Re-enabling motion must not replay entrances on already visible surfaces.
    document
      .querySelectorAll<HTMLElement>(".page-enter, dialog.modal[open]")
      .forEach((element) => {
        element.dataset.arrived = "true";
      });
  }
  if (motionChanged) root.dataset.motion = motion;
  if (root.dataset.contrast !== contrast) root.dataset.contrast = contrast;
  if (motionChanged) window.dispatchEvent(new Event("woolgather:preferences"));
}

const returnKey = "woolgather:account-settings-return";
export function rememberSettingsReturn(userId: string) {
  try {
    sessionStorage.setItem(
      returnKey,
      JSON.stringify({ userId, at: Date.now() }),
    );
  } catch {
    /* Optional navigation preference. */
  }
}
export function returningToSettings(userId: string) {
  try {
    const value = JSON.parse(sessionStorage.getItem(returnKey) || "null");
    return value?.userId === userId && Date.now() - value.at < 30 * 60_000;
  } catch {
    return false;
  }
}
export function clearSettingsReturn() {
  try {
    sessionStorage.removeItem(returnKey);
  } catch {
    /* Optional navigation preference. */
  }
}
