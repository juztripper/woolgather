import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  defaultSidebarPreferences,
  readSidebarPreferences,
  setPin,
  setShortcut,
  movePin,
  pinKey,
  resolvePins,
  saveSidebarPreferences,
  type SidebarPin,
} from "../apps/web/src/library/sidebarPreferences";
import type { ProjectSummary } from "../packages/domain/src";
import type { Library } from "../packages/domain/src/library";
const folder: SidebarPin = { kind: "folder", id: crypto.randomUUID() };
const idea: SidebarPin = { kind: "idea", id: crypto.randomUUID() };
const project: SidebarPin = { kind: "project", id: crypto.randomUUID() };

test("sidebar normalizes untrusted metadata and Workspace cannot be hidden", () => {
  assert.deepEqual(readSidebarPreferences(null), defaultSidebarPreferences());
  assert.deepEqual(
    readSidebarPreferences({
      hidden: ["workspace", "trash", "trash", "unknown"],
      pins: [
        folder,
        folder,
        null,
        { kind: "folder", id: "bad" },
        { kind: "script", id: idea.id },
      ],
    }),
    { hidden: ["trash"], pins: [folder] },
  );
});
test("pins can be added, reordered in both directions and removed without changing shortcuts", () => {
  let prefs = { hidden: ["archive" as const], pins: [folder, idea, project] };
  assert.deepEqual(
    setPin(prefs, idea, true),
    prefs,
    "retrying pin does not reorder it",
  );
  assert.deepEqual(movePin(prefs, pinKey(folder), pinKey(project)).pins, [
    idea,
    project,
    folder,
  ]);
  assert.deepEqual(movePin(prefs, pinKey(project), pinKey(folder)).pins, [
    project,
    folder,
    idea,
  ]);
  assert.deepEqual(movePin(prefs, "missing", pinKey(folder)), prefs);
  assert.deepEqual(setPin(prefs, idea, false), {
    hidden: ["archive"],
    pins: [folder, project],
  });
  assert.deepEqual(setShortcut(prefs, "trash", false).hidden, [
    "archive",
    "trash",
  ]);
  assert.deepEqual(setShortcut(prefs, "archive", true), {
    hidden: [],
    pins: prefs.pins,
  });
});
test("pins resolve only active items in the current authorized library and follow renames", () => {
  const data: Library = {
    folders: [
      {
        id: folder.id,
        name: "Renamed folder",
        revision: 1,
      },
    ],
    ideas: [
      {
        id: idea.id,
        body: "Original idea",
        projectId: project.id,
        folderId: folder.id,
        revision: 1,
        updatedAt: "2026-09-09",
        trashed: false,
      },
    ],
  };
  const p: ProjectSummary = {
    id: project.id,
    name: "Project",
    description: "",
    folderId: folder.id,
    revision: 1,
    updatedAt: "2026-09-09",
    lifecycle: "active",
    itemCount: 0,
  };
  const prefs = {
    hidden: [],
    pins: [folder, idea, project, { ...project, id: crypto.randomUUID() }],
  };
  assert.deepEqual(
    resolvePins(prefs, data, [p]).map((x) => x.name),
    ["Renamed folder", "Original idea", "Project"],
  );
  data.ideas[0].trashed = true;
  p.lifecycle = "archived";
  assert.deepEqual(
    resolvePins(prefs, data, [p]).map((x) => x.id),
    [folder.id],
  );
  assert.deepEqual(resolvePins(prefs, { folders: [], ideas: [] }, []), []);
});
test("saving fetches current account preferences, merges only its metadata key and checks acknowledgement", async () => {
  const owner = crypto.randomUUID();
  let metadata: Record<string, unknown> = {
    display_name: "Tester",
    sidebar_v1: { hidden: ["archive"], pins: [folder] },
  };
  let sent: unknown;
  const auth = {
    auth: {
      getUser: async () => ({
        data: { user: { id: owner, user_metadata: metadata } },
        error: null,
      }),
      updateUser: async ({ data }: any) => {
        sent = data;
        metadata = { ...metadata, ...data };
        return {
          data: { user: { id: owner, user_metadata: metadata } },
          error: null,
        };
      },
    },
  } as unknown as SupabaseClient;
  const saved = await saveSidebarPreferences(auth, owner, (prefs) =>
    setPin(prefs, idea, true),
  );
  assert.deepEqual(saved, { hidden: ["archive"], pins: [folder, idea] });
  assert.deepEqual(sent, { sidebar_v1: saved });
  assert.equal(metadata.display_name, "Tester");
  sent = null;
  await assert.rejects(
    saveSidebarPreferences(auth, "another-account", defaultSidebarPreferences),
    /Account changed/,
  );
  assert.equal(sent, null);
  auth.auth.updateUser = async () =>
    ({ data: { user: null }, error: new Error("Offline") }) as any;
  await assert.rejects(
    saveSidebarPreferences(auth, owner, defaultSidebarPreferences),
    /Offline/,
  );
  assert.deepEqual(metadata.sidebar_v1, saved);
  auth.auth.updateUser = async () =>
    ({
      data: { user: { id: owner, user_metadata: metadata } },
      error: null,
    }) as any;
  await assert.rejects(
    saveSidebarPreferences(auth, owner, defaultSidebarPreferences),
    /could not be saved/,
  );
});
