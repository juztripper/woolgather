import { transitionView } from "../ui/viewTransition";
import { blankIdeaRequest, createBlankIdea } from "./createIdea";
import { LibraryCard } from "./LibraryCard";
import { ExpandingSearch } from "../ui/ExpandingSearch";
import { SegmentedControl } from "../ui/SegmentedControl";
import { MorphText } from "../ui/MorphText";
import { SurfacePresence } from "@/ui/Modal";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ModalPresence } from "@/ui/Modal";
import { useRef, useState } from "react";
import {
  ChevronRight,
  Archive,
  Folder as FolderIcon,
  PanelsTopLeft,
  Lightbulb,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  Trash2,
  Clock3,
  List,
  ArrowDownWideNarrow,
} from "lucide-react";
import type { ProjectSummary } from "../../../../packages/domain/src";
import {
  ideaTitle,
  type Library,
  type Idea,
  type Folder,
  type LibraryCommand,
  type LibraryEntry,
  type LibraryView,
  libraryEntries,
  entryName,
  entryLifecycle,
} from "../../../../packages/domain/src/library";
import { api, makeCommand, sendCommand } from "../client";
import { Button, IconButton } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Feedback } from "../ui/Toast";
import { ActionMenu, ProjectMenu } from "./ProjectMenu";
import { DeleteTrashDialog, type TrashSelection } from "./DeleteTrashDialog";
import { MoveIdeaDialog } from "./MoveIdeaDialog";
import { PinnedItems } from "./PinnedItems";
import {
  type SidebarPreferences,
  type SidebarPin,
  type ResolvedPin,
  type SidebarShortcut,
} from "./sidebarPreferences";
import "./library.css";
export type { LibraryView } from "../../../../packages/domain/src/library";
export function LibraryNav({
  view,
  onView,
  folders,
  onFolder,
  onFolderAction,
  draggingProject,
  onDropProject,
  showRecent,
  preferences,
  pins,
  preferencesBusy,
  onPin,
  onOpenPin,
  onReorderPins,
  onPersonalize,
  onHideShortcut,
}: {
  view: LibraryView;
  onView: (v: LibraryView) => void;
  folders: Folder[];
  onFolder: () => void;
  onFolderAction: (folder: Folder, action: string) => void;
  draggingProject: boolean;
  onDropProject: (folderId: string | null) => void;
  showRecent: boolean;
  preferences: SidebarPreferences;
  pins: ResolvedPin[];
  preferencesBusy: boolean;
  onPin: (pin: SidebarPin, pinned: boolean) => void;
  onOpenPin: (pin: SidebarPin) => void;
  onReorderPins: (key: string, target: string) => void;
  onPersonalize: () => void;
  onHideShortcut: (key: SidebarShortcut) => void;
}) {
  const [foldersExpanded, setFoldersExpanded] = useState(true);
  const [sidebarMenu, setSidebarMenu] = useState<{
    x: number;
    y: number;
    shortcut?: SidebarShortcut;
  } | null>(null);
  const sidebarTrigger = useRef<HTMLElement | null>(null);
  const visible = (key: SidebarShortcut) => !preferences.hidden.includes(key);
  const pinned = (id: string) =>
    preferences.pins.some((p) => p.kind === "folder" && p.id === id);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{
    folder: Folder;
    x: number;
    y: number;
  } | null>(null);
  const folderTrigger = useRef<HTMLElement | null>(null);
  const showFolderMenu = (
    folder: Folder,
    target: HTMLElement,
    x: number,
    y: number,
  ) => {
    folderTrigger.current = target;
    setFolderMenu({ folder, x, y });
  };
  const closeFolderMenu = () => {
    setFolderMenu(null);
    folderTrigger.current?.focus();
  };
  return (
    <>
      {" "}
      <nav
        className="library-nav"
        aria-label="Library"
        onContextMenu={(e) => {
          if (
            e.defaultPrevented ||
            (e.target as HTMLElement).closest('[role="menu"]')
          )
            return;
          e.preventDefault();
          sidebarTrigger.current =
            (e.target as HTMLElement).closest("button") || e.currentTarget;
          const shortcut = (e.target as HTMLElement).closest<HTMLElement>(
            "[data-shortcut]",
          )?.dataset.shortcut as SidebarShortcut | undefined;
          setSidebarMenu({ x: e.clientX, y: e.clientY, shortcut });
        }}
        onKeyDown={(e) => {
          if (
            e.defaultPrevented ||
            !(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
          )
            return;
          e.preventDefault();
          const target = e.target as HTMLElement;
          sidebarTrigger.current = target;
          const r = target.getBoundingClientRect();
          setSidebarMenu({
            x: r.left,
            y: r.bottom,
            shortcut: target.closest<HTMLElement>("[data-shortcut]")?.dataset
              .shortcut as SidebarShortcut | undefined,
          });
        }}
      >
        <PinnedItems
          pins={pins}
          busy={preferencesBusy}
          onOpen={onOpenPin}
          onUnpin={(pin) => onPin(pin, false)}
          onReorder={onReorderPins}
          onPersonalize={onPersonalize}
        />
        {[
          ...(showRecent && visible("recent")
            ? [["recent", "Recently opened", Clock3]]
            : []),
        ].map(([id, label, Icon]) => {
          const Glyph = Icon as typeof LayoutGrid;
          return (
            <Button
              key={id as string}
              data-shortcut={id as string}
              variant="navigation"
              className={`nav-item ${view === id ? "selected" : ""}`}
              aria-current={view === id ? "page" : undefined}
              onClick={() => onView(id as LibraryView)}
            >
              <Glyph size={18} />
              {label as string}
            </Button>
          );
        })}
        <div
          className={`project-nav-parent ${draggingProject && dropFolder === "workspace" ? "folder-drop-target" : ""}`}
          onDragOver={(e) => {
            if (draggingProject) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropFolder("workspace");
            }
          }}
          onDragLeave={() => setDropFolder(null)}
          onDrop={(e) => {
            if (draggingProject) {
              e.preventDefault();
              setDropFolder(null);
              onDropProject(null);
            }
          }}
        >
          <IconButton
            aria-label={
              foldersExpanded
                ? "Collapse workspace folders"
                : "Expand workspace folders"
            }
            aria-expanded={foldersExpanded}
            onClick={() => setFoldersExpanded(!foldersExpanded)}
          >
            <ChevronRight
              size={15}
              style={{
                transform: foldersExpanded ? "rotate(90deg)" : undefined,
              }}
            />
          </IconButton>
          <Button
            variant="navigation"
            className={`nav-item ${view === "workspace" ? "selected" : ""}`}
            aria-current={view === "workspace" ? "page" : undefined}
            onClick={() => onView("workspace")}
          >
            <LayoutGrid size={18} />
            Workspace
          </Button>
        </div>
        <div className="project-nav-folders" hidden={!foldersExpanded}>
          {folders.map((f) => (
            <div
              key={f.id}
              className={`folder-nav-row ${draggingProject && dropFolder === f.id ? "folder-drop-target" : ""}`}
              onDragOver={(e) => {
                if (draggingProject) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropFolder(f.id);
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node))
                  setDropFolder(null);
              }}
              onDrop={(e) => {
                if (draggingProject) {
                  e.preventDefault();
                  setDropFolder(null);
                  onDropProject(f.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                showFolderMenu(
                  f,
                  e.currentTarget.querySelector("button")!,
                  e.clientX,
                  e.clientY,
                );
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "ContextMenu" ||
                  (e.shiftKey && e.key === "F10")
                ) {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  showFolderMenu(
                    f,
                    e.currentTarget.querySelector("button")!,
                    r.left,
                    r.bottom,
                  );
                }
              }}
            >
              <Button
                variant="navigation"
                className={`nav-item ${view === `folder:${f.id}` ? "selected" : ""}`}
                aria-current={view === `folder:${f.id}` ? "page" : undefined}
                onClick={() => onView(`folder:${f.id}`)}
              >
                <FolderIcon size={17} />
                <span>{f.name}</span>
              </Button>
            </div>
          ))}
        </div>
        <SurfacePresence>
          {folderMenu && (
            <ProjectMenu
              folder
              disabled={preferencesBusy}
              extraOptions={[
                [
                  pinned(folderMenu.folder.id) ? "unpin" : "pin",
                  pinned(folderMenu.folder.id)
                    ? "Unpin from sidebar"
                    : "Pin to sidebar",
                ],
              ]}
              active={false}
              trashed={false}
              x={folderMenu.x}
              y={folderMenu.y}
              onClose={closeFolderMenu}
              onAction={(action) => {
                const f = folderMenu.folder;
                closeFolderMenu();
                if (action === "pin" || action === "unpin")
                  onPin({ kind: "folder", id: f.id }, action === "pin");
                else onFolderAction(f, action);
              }}
            />
          )}
        </SurfacePresence>
        <div
          className="library-filter-nav"
          hidden={!visible("ideas") && !visible("projects")}
        >
          <span className="workspace-label">Views</span>
          <Button
            hidden={!visible("ideas")}
            data-shortcut="ideas"
            variant="navigation"
            className={`nav-item ${view === "ideas" ? "selected" : ""}`}
            aria-current={view === "ideas" ? "page" : undefined}
            onClick={() => onView("ideas")}
          >
            <Lightbulb size={18} />
            Ideas
          </Button>
          <Button
            hidden={!visible("projects")}
            data-shortcut="projects"
            variant="navigation"
            className={`nav-item ${view === "projects" ? "selected" : ""}`}
            aria-current={view === "projects" ? "page" : undefined}
            onClick={() => onView("projects")}
          >
            <PanelsTopLeft size={18} />
            Projects
          </Button>
        </div>
        <div
          className="library-secondary-nav"
          hidden={!visible("archive") && !visible("trash")}
        >
          <Button
            hidden={!visible("archive")}
            data-shortcut="archive"
            variant="navigation"
            className={`nav-item ${view === "archive" ? "selected" : ""}`}
            aria-current={view === "archive" ? "page" : undefined}
            onClick={() => onView("archive")}
          >
            <Archive size={17} />
            Archive
          </Button>
          <Button
            hidden={!visible("trash")}
            data-shortcut="trash"
            variant="navigation"
            className={`nav-item ${view === "trash" ? "selected" : ""}`}
            aria-current={view === "trash" ? "page" : undefined}
            data-trash-navigation
            onClick={() => onView("trash")}
          >
            <Trash2 size={17} />
            Trash
          </Button>
        </div>
        <SurfacePresence>
          {sidebarMenu && (
            <ProjectMenu
              x={sidebarMenu.x}
              y={sidebarMenu.y}
              active={false}
              trashed={false}
              label="Sidebar actions"
              disabled={preferencesBusy}
              options={[
                ...(sidebarMenu.shortcut
                  ? [["hide", "Hide from sidebar"]]
                  : []),
                ["personalize", "Personalize sidebar"],
              ]}
              onClose={() => {
                setSidebarMenu(null);
                sidebarTrigger.current?.focus();
              }}
              onAction={(action) => {
                const key = sidebarMenu.shortcut;
                setSidebarMenu(null);
                sidebarTrigger.current?.focus();
                if (action === "hide" && key) onHideShortcut(key);
                else onPersonalize();
              }}
            />
          )}
        </SurfacePresence>
      </nav>
      <div className="mobile-library-nav">
        <Select
          label="Library"
          value={view}
          onValueChange={(v) => {
            const pin = pins.find((p) => `pin:${p.kind}:${p.id}` === v);
            if (pin) onOpenPin(pin);
            else onView(v as LibraryView);
          }}
          options={[
            ...pins.map((pin) => ({
              value: `pin:${pin.kind}:${pin.id}`,
              label: "Pinned / " + pin.name,
            })),
            ...(showRecent && visible("recent")
              ? [{ value: "recent", label: "Recently opened" }]
              : []),
            { value: "workspace", label: "Workspace" },
            ...folders.map((f) => ({
              value: `folder:${f.id}`,
              label: "Workspace / " + f.name,
            })),
            ...[
              { value: "ideas", label: "All ideas" },
              { value: "projects", label: "All projects" },
              { value: "archive", label: "Archive" },
              { value: "trash", label: "Trash" },
            ].filter(
              (option) =>
                visible(option.value as SidebarShortcut) ||
                view === option.value,
            ),
          ]}
        />
        <IconButton aria-label="New folder" onClick={onFolder}>
          <Plus size={16} />
        </IconButton>
      </div>
    </>
  );
}
export function FolderEditor({
  folder,
  onClose,
  onSaved,
}: {
  folder?: Folder;
  onClose: () => void;
  onSaved: (data: Library) => void;
}) {
  const [name, setName] = useState(folder?.name || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<LibraryCommand | null>(null);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const cmd = pending.current ?? {
        id: crypto.randomUUID(),
        targetId: folder?.id || crypto.randomUUID(),
        expectedRevision: folder?.revision || 0,
        type: "save_folder" as const,
        name,
      };
      pending.current = cmd;
      await api("/library", cmd);
      onSaved(await api<Library>("/library"));
      onClose();
    } catch (e) {
      setError((e as Error).message);
      if ((e as { status?: number }).status === 422) pending.current = null;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={folder ? "Rename folder" : "New folder"}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim()}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : folder ? "Save" : "Create folder"}
          </Button>
        </>
      }
    >
      <label>
        Folder name
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          disabled={busy || !!pending.current}
        />
      </label>
      {error && <Feedback tone="error" message={error} />}
    </Modal>
  );
}
export function LibraryPage({
  onPin,
  isPinned,
  preferencesBusy,
  view,
  data,
  projects,
  owner,
  recent,
  onData,
  onRefresh,
  onOpen,
  onNew,
  onGuide,
  onSettings,
  onRenameFolder,
  onDeleteFolder,
  onDragProject,
  onDragIdea,
  onOpenFolder,
  onNewFolder,
  onOpenIdea,
  draggingItem,
  onDropItem,
}: {
  onPin: (pin: SidebarPin, pinned: boolean) => void;
  isPinned: (pin: SidebarPin) => boolean;
  preferencesBusy: boolean;
  view: LibraryView;
  data: Library;
  projects: ProjectSummary[];
  owner: string;
  recent: string[];
  onData: (data: Library) => void;
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => void;
  onNew: () => void;
  onGuide?: () => void;
  onSettings: (project: ProjectSummary, section?: string) => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onDragProject: (project: ProjectSummary | null) => void;
  onDragIdea: (idea: Idea | null) => void;
  onOpenFolder: (folder: Folder) => void;
  onNewFolder: () => void;
  onOpenIdea: (idea: Idea) => void;
  draggingItem: boolean;
  onDropItem: (folderId: string | null) => void;
}) {
  const [presentation, setPresentation] = useState("cards");
  const [query, setQuery] = useState(""),
    [sort, setSort] = useState("modified");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [errorAction, setErrorAction] = useState<"retry-new-idea" | null>(null);
  const [movingIdea, setMovingIdea] = useState<Idea | null>(null);
  const [menu, setMenu] = useState<{
    entry: LibraryEntry;
    x: number;
    y: number;
  } | null>(null);
  const [folderActions, setFolderActions] = useState<{
    folder: Folder;
    x: number;
    y: number;
  } | null>(null);
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [deletion, setDeletion] = useState<TrashSelection | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const retry = useRef<LibraryCommand | null>(null);
  const selectedFolder = view.startsWith("folder:")
    ? data.folders.find((f) => f.id === view.slice(7))
    : undefined;
  const title =
    selectedFolder?.name ||
    (
      {
        workspace: "Workspace",
        ideas: "Ideas",
        projects: "Projects",
        recent: "Recently opened",
        archive: "Archive",
        trash: "Trash",
      } as Record<string, string>
    )[view] ||
    "Folder not found";
  const entries = libraryEntries(
    view,
    projects,
    data.ideas,
    recent,
    query,
    sort,
  );
  const folders =
    view === "workspace"
      ? data.folders
          .filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
  const shared = view === "workspace" || !!selectedFolder;
  const isFilter = view === "ideas" || view === "projects" || view === "recent";
  function closeMenus() {
    setMenu(null);
    setFolderActions(null);
    setCreateMenu(null);
    trigger.current?.focus();
  }
  function openIdea(i: Idea) {
    onOpenIdea(i);
  }
  function showEntryMenu(
    entry: LibraryEntry,
    target: HTMLElement,
    x: number,
    y: number,
  ) {
    trigger.current = target;
    setFolderActions(null);
    setCreateMenu(null);
    setMenu({ entry, x, y });
  }
  function showFolderMenu(
    folder: Folder,
    target: HTMLElement,
    x: number,
    y: number,
  ) {
    trigger.current = target;
    setMenu(null);
    setCreateMenu(null);
    setFolderActions({ folder, x, y });
  }
  async function action(type: string, selected?: LibraryEntry) {
    const entry = selected ?? menu?.entry;
    if (!entry) return;
    if (!selected) closeMenus();
    if (type === "pin" || type === "unpin") {
      onPin({ kind: entry.kind, id: entry.item.id }, type === "pin");
      return;
    }
    if (type === "delete") {
      setDeletion(
        entry.kind === "project"
          ? { projects: [entry.item], ideas: [] }
          : {
              projects: [],
              ideas: [{ ...entry.item, name: entryName(entry) }],
            },
      );
      return;
    }
    if (
      entry.kind === "project" &&
      ["settings", "rename", "move"].includes(type)
    ) {
      onSettings(entry.item, type === "move" ? "move" : "general");
      return;
    }
    if (entry.kind === "idea" && type === "open") {
      openIdea(entry.item);
      return;
    }
    if (entry.kind === "idea" && type === "move") {
      setMovingIdea(entry.item);
      return;
    }
    setBusy(true);
    setError("");
    setErrorAction(null);
    try {
      if (entry.kind === "project") {
        await sendCommand(
          makeCommand(entry.item.id, entry.item.revision, {
            type: "set_project_lifecycle",
            lifecycle:
              type === "archive"
                ? "archived"
                : type === "trash"
                  ? "trashed"
                  : "active",
          }),
        );
      } else {
        await api("/library", {
          id: crypto.randomUUID(),
          targetId: entry.item.id,
          expectedRevision: entry.item.revision,
          type:
            type === "archive"
              ? "archive_idea"
              : type === "trash"
                ? "trash_idea"
                : "restore_idea",
        });
      }
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function entryOptions(entry: LibraryEntry) {
    if (entry.kind !== "idea") return undefined;
    const lifecycle = entryLifecycle(entry);
    return [
      ["open", "Open idea"],
      ...(lifecycle === "active"
        ? [
            ["move", "Move to folder"],
            ["archive", "Archive"],
            ["trash", "Move to trash"],
          ]
        : [
            ["restore", "Restore"],
            lifecycle === "trashed"
              ? ["delete", "Delete permanently"]
              : ["trash", "Move to trash"],
          ]),
    ];
  }
  function pinOptions(entry: LibraryEntry) {
    if (entryLifecycle(entry) !== "active") return [];
    const pinned = isPinned({ kind: entry.kind, id: entry.item.id });
    return [
      [
        pinned ? "unpin" : "pin",
        pinned ? "Unpin from sidebar" : "Pin to sidebar",
      ],
    ];
  }
  function folderAction(folder: Folder, type: string) {
    if (type === "pin" || type === "unpin")
      onPin({ kind: "folder", id: folder.id }, type === "pin");
    else if (type === "rename") onRenameFolder(folder);
    else onDeleteFolder(folder);
  }
  const creationOptions = [
    ["new_idea", "New idea"],
    ["new_project", "New project"],
    ...(view === "workspace" ? [["new_folder", "New folder"]] : []),
  ];
  function createAction(type: string) {
    if (type === "new_idea") void newIdea();
    else if (type === "new_folder") onNewFolder();
    else onNew();
  }
  async function newIdea() {
    setBusy(true);
    setError("");
    setErrorAction(null);
    try {
      const cmd = retry.current ?? blankIdeaRequest(selectedFolder?.id || null);
      retry.current = cmd;
      const { library: next, idea: created } = await createBlankIdea(cmd);
      retry.current = null;
      onData(next);
      openIdea(created);
    } catch (e) {
      setError((e as Error).message);
      if ((e as { status?: number }).status === 422) retry.current = null;
      else setErrorAction("retry-new-idea");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="library-workspace-surface"
      tabIndex={shared ? 0 : undefined}
      aria-label={title}
      onContextMenu={(e) => {
        if (!shared || busy || e.defaultPrevented) return;
        if (
          (e.target as HTMLElement).closest(
            'button, input, textarea, select, a, [contenteditable], [role="menu"], dialog',
          )
        )
          return;
        e.preventDefault();
        trigger.current = e.currentTarget;
        setMenu(null);
        setFolderActions(null);
        setCreateMenu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (!shared || busy || e.target !== e.currentTarget) return;
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          trigger.current = e.currentTarget;
          setMenu(null);
          setFolderActions(null);
          setCreateMenu({ x: r.left + 24, y: r.top + 80 });
        }
      }}
    >
      <div className="library-workspace">
        <header className="library-title">
          <div className="library-title-copy">
            <h1>
              <MorphText>{title}</MorphText>
            </h1>
            <span className="library-item-count">
              {entries.length} {entries.length === 1 ? "item" : "items"}
            </span>
          </div>
          {view !== "trash" && view !== "archive" && (
            <SegmentedControl
              label="Library layout"
              value={presentation}
              onChange={(value) => transitionView(() => setPresentation(value))}
              options={[
                {
                  value: "cards",
                  label: "Preview view",
                  content: <LayoutGrid size={16} />,
                },
                {
                  value: "list",
                  label: "List view",
                  content: <List size={16} />,
                },
              ]}
            />
          )}
        </header>
        <div className="library-toolbar">
          <div className="library-creation">
            {view === "trash" && (
              <Button
                variant="danger"
                disabled={
                  busy ||
                  (!projects.some((p) => p.lifecycle === "trashed") &&
                    !data.ideas.some((i) => i.trashed))
                }
                onClick={() =>
                  setDeletion({
                    empty: true,
                    projects: projects.filter((p) => p.lifecycle === "trashed"),
                    ideas: data.ideas
                      .filter((i) => i.trashed)
                      .map((i) => ({
                        ...i,
                        name: i.document?.title.trim() || ideaTitle(i.body),
                      })),
                  })
                }
              >
                <Trash2 size={16} />
                Empty trash
              </Button>
            )}
            {selectedFolder && (
              <ActionMenu
                active={false}
                trashed={false}
                folder
                label="Folder actions"
                disabled={preferencesBusy}
                trigger={
                  <IconButton
                    aria-label={"Actions for folder " + selectedFolder.name}
                  >
                    <MoreHorizontal />
                  </IconButton>
                }
                extraOptions={[
                  [
                    isPinned({ kind: "folder", id: selectedFolder.id })
                      ? "unpin"
                      : "pin",
                    isPinned({ kind: "folder", id: selectedFolder.id })
                      ? "Unpin from sidebar"
                      : "Pin to sidebar",
                  ],
                ]}
                onAction={(type) => folderAction(selectedFolder, type)}
              />
            )}
            {shared ? (
              <ActionMenu
                active={false}
                trashed={false}
                label="Create in workspace"
                options={creationOptions}
                onAction={createAction}
                trigger={
                  <Button variant="primary" disabled={busy}>
                    <Plus />
                    New
                  </Button>
                }
              />
            ) : view === "ideas" ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void newIdea()}
              >
                <Plus size={16} />
                New idea
              </Button>
            ) : view === "projects" ? (
              <Button variant="primary" disabled={busy} onClick={onNew}>
                <Plus size={16} />
                New project
              </Button>
            ) : view === "recent" ? (
              <ActionMenu
                active={false}
                trashed={false}
                label="Create in workspace"
                options={creationOptions}
                onAction={createAction}
                trigger={
                  <Button variant="primary" disabled={busy}>
                    <Plus />
                    New
                  </Button>
                }
              />
            ) : null}
          </div>
          <div className="library-tools">
            <ExpandingSearch
              label={"Search " + title.toLowerCase()}
              value={query}
              onChange={setQuery}
            />
            {view !== "recent" && (
              <span
                className="library-sort"
                title={
                  sort === "name" ? "Sort by name" : "Sort by last modified"
                }
              >
                <ArrowDownWideNarrow
                  className="library-sort-icon"
                  aria-hidden="true"
                />
                <Select
                  label="Sort items"
                  className="w-(--library-sort-width) rounded-full px-(--library-sort-padding)"
                  value={sort}
                  onValueChange={setSort}
                  options={[
                    { value: "modified", label: "Last modified" },
                    { value: "name", label: "Name" },
                  ]}
                />
              </span>
            )}
          </div>
        </div>
        {error && (
          <Feedback
            tone="error"
            message={error}
            action={{
              label:
                errorAction === "retry-new-idea"
                  ? "Retry new idea"
                  : "Reload latest",
              onClick: async () => {
                if (errorAction === "retry-new-idea") await newIdea();
                else {
                  await onRefresh();
                  setError("");
                  setErrorAction(null);
                }
              },
            }}
          />
        )}
        {folders.length > 0 && (
          <div className="library-root-folders" aria-label="Workspace folders">
            {folders.map((f) => (
              <Button
                key={f.id}
                variant="secondary"
                className={
                  "library-folder-open h-auto min-h-10 min-w-0 justify-start gap-3 px-3 py-2 " +
                  (draggingItem && dropFolder === f.id
                    ? "folder-drop-target"
                    : "")
                }
                onClick={() => onOpenFolder(f)}
                onDragOver={(e) => {
                  if (draggingItem) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropFolder(f.id);
                  }
                }}
                onDragLeave={() => setDropFolder(null)}
                onDrop={(e) => {
                  if (draggingItem) {
                    e.preventDefault();
                    setDropFolder(null);
                    onDropItem(f.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showFolderMenu(f, e.currentTarget, e.clientX, e.clientY);
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "ContextMenu" ||
                    (e.shiftKey && e.key === "F10")
                  ) {
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    showFolderMenu(f, e.currentTarget, r.left, r.bottom);
                  }
                }}
              >
                <FolderIcon size={21} />
                <span className="truncate">{f.name}</span>
              </Button>
            ))}
          </div>
        )}
        <div className="library-results">
          {presentation === "cards" &&
          view !== "trash" &&
          view !== "archive" ? (
            <ul className="library-cards" aria-label={title + " items"}>
              {entries.map((entry) => (
                <LibraryCard
                  key={entry.kind + entry.item.id}
                  entry={entry}
                  folder={
                    data.folders.find(
                      (folder) => folder.id === entry.item.folderId,
                    )?.name
                  }
                  linked={
                    entry.kind === "idea"
                      ? projects.find(
                          (project) => project.id === entry.item.projectId,
                        )?.name
                      : undefined
                  }
                  busy={busy || preferencesBusy}
                  options={entryOptions(entry)}
                  extraOptions={pinOptions(entry)}
                  onOpen={() =>
                    entry.kind === "project"
                      ? onOpen(entry.item.id)
                      : openIdea(entry.item)
                  }
                  onAction={(type) => void action(type, entry)}
                  draggable={!busy}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", entry.item.id);
                    if (entry.kind === "project") onDragProject(entry.item);
                    else onDragIdea(entry.item);
                  }}
                  onDragEnd={() => {
                    onDragProject(null);
                    onDragIdea(null);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    showEntryMenu(
                      entry,
                      event.currentTarget.querySelector("button")!,
                      event.clientX,
                      event.clientY,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "ContextMenu" ||
                      (event.shiftKey && event.key === "F10")
                    ) {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      showEntryMenu(
                        entry,
                        event.currentTarget.querySelector("button")!,
                        rect.left + 20,
                        rect.top + 40,
                      );
                    }
                  }}
                />
              ))}
            </ul>
          ) : (
            <Table className="table-fixed" aria-label={title + " items"}>
              {entries.length > 0 && (
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-9 text-xs text-muted-foreground">
                      Name
                    </TableHead>
                    <TableHead className="hidden w-36 text-xs text-muted-foreground sm:table-cell">
                      Last modified
                    </TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
              )}
              <TableBody>
                {entries.map((entry) => {
                  const item = entry.item,
                    active = entryLifecycle(entry) === "active";
                  const name = entryName(entry),
                    folder = data.folders.find((f) => f.id === item.folderId);
                  const linked =
                    entry.kind === "idea" && entry.item.projectId
                      ? projects.find((p) => p.id === entry.item.projectId)
                      : null;
                  return (
                    <TableRow
                      key={entry.kind + item.id}
                      draggable={active && !busy}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", item.id);
                        if (entry.kind === "project") onDragProject(entry.item);
                        else onDragIdea(entry.item);
                      }}
                      onDragEnd={() => {
                        onDragProject(null);
                        onDragIdea(null);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        showEntryMenu(
                          entry,
                          e.currentTarget.querySelector("button")!,
                          e.clientX,
                          e.clientY,
                        );
                      }}
                      onKeyDown={(e) => {
                        if (
                          e.key === "ContextMenu" ||
                          (e.shiftKey && e.key === "F10")
                        ) {
                          e.preventDefault();
                          const r = e.currentTarget.getBoundingClientRect();
                          showEntryMenu(
                            entry,
                            e.currentTarget.querySelector("button")!,
                            r.left + 40,
                            r.bottom,
                          );
                        }
                      }}
                    >
                      <TableCell className="p-0">
                        <Button
                          variant="quiet"
                          className="library-project-open h-auto w-full min-w-0 justify-start gap-3 rounded-none border-0 px-2 py-3 text-left hover:bg-transparent"
                          draggable={active && !busy}
                          onClick={() =>
                            entry.kind === "project"
                              ? onOpen(item.id)
                              : openIdea(entry.item)
                          }
                        >
                          {entry.kind === "project" ? (
                            <PanelsTopLeft size={21} aria-hidden="true" />
                          ) : (
                            <Lightbulb size={21} aria-hidden="true" />
                          )}
                          <span className="grid min-w-0 gap-0.5">
                            <strong title={name}>{name}</strong>
                            <small>
                              {entry.kind === "project" ? "Project" : "Idea"}
                              {isFilter && folder ? " · " + folder.name : ""}
                              {linked ? " · Source for " + linked.name : ""}
                            </small>
                          </span>
                        </Button>
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                        <time
                          dateTime={item.updatedAt}
                          title={new Date(item.updatedAt).toLocaleString()}
                        >
                          {new Date(item.updatedAt).toLocaleDateString(
                            undefined,
                            {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            },
                          )}
                        </time>
                      </TableCell>
                      <TableCell className="p-2">
                        <ActionMenu
                          active={entryLifecycle(entry) === "active"}
                          trashed={entryLifecycle(entry) === "trashed"}
                          label={
                            entry.kind === "idea"
                              ? "Idea actions"
                              : "Project actions"
                          }
                          disabled={busy || preferencesBusy}
                          options={entryOptions(entry)}
                          extraOptions={pinOptions(entry)}
                          onAction={(type) => void action(type, entry)}
                          trigger={
                            <IconButton
                              aria-label={
                                "Actions for " + entry.kind + " " + name
                              }
                              disabled={busy}
                            >
                              <MoreHorizontal />
                            </IconButton>
                          }
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
        {entries.length === 0 && folders.length === 0 && (
          <div className="library-empty">
            <p>
              {query
                ? "No matches."
                : view === "trash"
                  ? "Trash is empty."
                  : view === "archive"
                    ? "Archive is empty."
                    : view === "recent"
                      ? "Items you open will appear here."
                      : view === "ideas"
                        ? "No ideas yet."
                        : view === "projects"
                          ? "No projects yet."
                          : selectedFolder
                            ? "This folder is empty."
                            : "Your workspace is empty."}
            </p>
            {!query &&
              (view === "ideas" ||
                view === "projects" ||
                view === "workspace") && (
                <div className="library-empty-guidance">
                  <p>
                    {view === "ideas"
                      ? "Write freely and collect references. An Idea can become a Project whenever you want to develop it."
                      : view === "projects"
                        ? "Start with a rough direction. Discuss it in a chat, or open Plan to add your own thoughts."
                        : "Keep a passing thought in Ideas, or start a Project to develop something you want to make."}
                  </p>
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      view === "projects" ? onNew() : void newIdea()
                    }
                  >
                    {view === "projects" ? "New project" : "New idea"}
                  </Button>
                  {onGuide && (
                    <Button variant="inline" onClick={onGuide}>
                      Ideas or Projects?
                    </Button>
                  )}
                </div>
              )}
          </div>
        )}
        <SurfacePresence>
          {menu && (
            <ProjectMenu
              x={menu.x}
              y={menu.y}
              disabled={busy || preferencesBusy}
              active={entryLifecycle(menu.entry) === "active"}
              trashed={entryLifecycle(menu.entry) === "trashed"}
              label={
                menu.entry.kind === "idea" ? "Idea actions" : "Project actions"
              }
              options={entryOptions(menu.entry)}
              extraOptions={pinOptions(menu.entry)}
              onClose={closeMenus}
              onAction={(type) => void action(type)}
            />
          )}
        </SurfacePresence>
        <SurfacePresence>
          {folderActions && (
            <ProjectMenu
              folder
              disabled={preferencesBusy}
              extraOptions={[
                [
                  isPinned({ kind: "folder", id: folderActions.folder.id })
                    ? "unpin"
                    : "pin",
                  isPinned({ kind: "folder", id: folderActions.folder.id })
                    ? "Unpin from sidebar"
                    : "Pin to sidebar",
                ],
              ]}
              active={false}
              trashed={false}
              x={folderActions.x}
              y={folderActions.y}
              onClose={closeMenus}
              onAction={(type) => {
                const f = folderActions.folder;
                closeMenus();
                if (type === "pin" || type === "unpin")
                  onPin({ kind: "folder", id: f.id }, type === "pin");
                else if (type === "rename") onRenameFolder(f);
                else onDeleteFolder(f);
              }}
            />
          )}
        </SurfacePresence>
        <SurfacePresence>
          {createMenu && (
            <ProjectMenu
              active={false}
              trashed={false}
              label="Create in workspace"
              x={createMenu.x}
              y={createMenu.y}
              options={[
                ["new_idea", "New idea"],
                ["new_project", "New project"],
                ...(view === "workspace" ? [["new_folder", "New folder"]] : []),
              ]}
              onClose={closeMenus}
              onAction={(type) => {
                closeMenus();
                if (type === "new_idea") void newIdea();
                else if (type === "new_folder") onNewFolder();
                else onNew();
              }}
            />
          )}
        </SurfacePresence>
        <ModalPresence>
          {deletion && (
            <DeleteTrashDialog
              selection={deletion}
              owner={owner}
              onClose={() => setDeletion(null)}
              onDeleted={onRefresh}
            />
          )}
        </ModalPresence>
        <ModalPresence>
          {movingIdea && (
            <MoveIdeaDialog
              idea={movingIdea}
              folders={data.folders}
              onClose={() => setMovingIdea(null)}
              onMoved={onRefresh}
            />
          )}
        </ModalPresence>
      </div>
    </section>
  );
}
