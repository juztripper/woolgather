import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectSummary } from "../../../../packages/domain/src";
import {
  ideaTitle,
  type Library,
} from "../../../../packages/domain/src/library";

export const sidebarShortcuts = [
  ["recent", "Recently opened"],
  ["ideas", "Ideas"],
  ["projects", "Projects"],
  ["archive", "Archive"],
  ["trash", "Trash"],
] as const;
export type SidebarShortcut = (typeof sidebarShortcuts)[number][0];
export type SidebarPin = { kind: "folder" | "idea" | "project"; id: string };
export type ResolvedPin = SidebarPin & { name: string };
export type SidebarPreferences = {
  hidden: SidebarShortcut[];
  pins: SidebarPin[];
};
export const pinKey = (pin: SidebarPin) => `${pin.kind}:${pin.id}`;
export const defaultSidebarPreferences = (): SidebarPreferences => ({
  hidden: [],
  pins: [],
});

/** Presentation metadata only. Item access still comes from the authorized library. */
export function readSidebarPreferences(value: unknown): SidebarPreferences {
  if (!value || typeof value !== "object") return defaultSidebarPreferences();
  const input = value as Record<string, unknown>;
  const hidden = sidebarShortcuts
    .map(([key]) => key)
    .filter((key) => Array.isArray(input.hidden) && input.hidden.includes(key));
  const pins: SidebarPin[] = [];
  const seen = new Set<string>();
  if (Array.isArray(input.pins))
    for (const pin of input.pins) {
      if (
        !pin ||
        !["folder", "idea", "project"].includes(pin.kind) ||
        typeof pin.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          pin.id,
        )
      )
        continue;
      const key = pinKey(pin);
      if (!seen.has(key)) {
        pins.push({ kind: pin.kind, id: pin.id });
        seen.add(key);
      }
    }
  return { hidden, pins };
}
export function setPin(
  prefs: SidebarPreferences,
  pin: SidebarPin,
  pinned: boolean,
): SidebarPreferences {
  if (pinned && prefs.pins.some((p) => pinKey(p) === pinKey(pin))) return prefs;
  const pins = prefs.pins.filter((p) => pinKey(p) !== pinKey(pin));
  return {
    ...prefs,
    pins: pinned ? [...pins, pin] : pins,
  };
}
export function movePin(
  prefs: SidebarPreferences,
  key: string,
  target: string,
): SidebarPreferences {
  const from = prefs.pins.findIndex((p) => pinKey(p) === key);
  const to = prefs.pins.findIndex((p) => pinKey(p) === target);
  if (from < 0 || to < 0 || from === to) return prefs;
  const pins = [...prefs.pins];
  pins.splice(to, 0, ...pins.splice(from, 1));
  return { ...prefs, pins };
}
export function setShortcut(
  prefs: SidebarPreferences,
  key: SidebarShortcut,
  visible: boolean,
): SidebarPreferences {
  return {
    ...prefs,
    hidden: sidebarShortcuts
      .map(([id]) => id)
      .filter((id) => (id === key ? !visible : prefs.hidden.includes(id))),
  };
}
export function resolvePins(
  prefs: SidebarPreferences,
  library: Library,
  projects: ProjectSummary[],
): ResolvedPin[] {
  return prefs.pins.flatMap((pin) => {
    if (pin.kind === "folder") {
      const folder = library.folders.find((f) => f.id === pin.id);
      return folder ? [{ ...pin, name: folder.name }] : [];
    }
    if (pin.kind === "project") {
      const project = projects.find(
        (p) => p.id === pin.id && (!p.lifecycle || p.lifecycle === "active"),
      );
      return project ? [{ ...pin, name: project.name }] : [];
    }
    const idea = library.ideas.find(
      (i) => i.id === pin.id && !i.archived && !i.trashed,
    );
    return idea
      ? [{ ...pin, name: idea.document?.title.trim() || ideaTitle(idea.body) }]
      : [];
  });
}
export async function saveSidebarPreferences(
  auth: SupabaseClient,
  owner: string,
  change: (current: SidebarPreferences) => SidebarPreferences,
) {
  const { data, error } = await auth.auth.getUser();
  if (error) throw error;
  if (data.user?.id !== owner)
    throw new Error("Account changed. Reopen your workspace.");
  // Read before editing to preserve unrelated sidebar changes from another client.
  const next = readSidebarPreferences(
    change(readSidebarPreferences(data.user.user_metadata.sidebar_v1)),
  );
  const result = await auth.auth.updateUser({ data: { sidebar_v1: next } });
  if (result.error) throw result.error;
  if (
    result.data.user?.id !== owner ||
    JSON.stringify(
      readSidebarPreferences(result.data.user.user_metadata.sidebar_v1),
    ) !== JSON.stringify(next)
  )
    throw new Error(
      "Sidebar preferences could not be saved. Please try again.",
    );
  return next;
}
