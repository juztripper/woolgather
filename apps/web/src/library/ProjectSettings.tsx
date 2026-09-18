import { Input } from "@/components/ui/input";
import { ModalPresence } from "@/ui/Modal";
import { useContext, useEffect, useRef, useState } from "react";
import type {
  ProjectSummary,
  Project,
  Command,
} from "../../../../packages/domain/src";
import type { Folder } from "../../../../packages/domain/src/library";
import { makeCommand } from "../client";
import { ProjectTransport } from "../projects/ProjectTransport";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { Feedback } from "../ui/Toast";
import { MoveLocationPicker } from "./MoveLocationPicker";
import { DeleteTrashDialog } from "./DeleteTrashDialog";
export function ProjectSettings({
  project: p,
  owner,
  folders,
  onClose,
  onSaved,
  onDeleted,
  initial = "general",
}: {
  project: ProjectSummary | Project;
  owner: string;
  folders: Folder[];
  onClose: () => void;
  onSaved: (p: Project) => Promise<void>;
  onDeleted: () => Promise<void>;
  initial?: string;
}) {
  const { request: api, command: sendCommand } = useContext(ProjectTransport);
  const [name, setName] = useState(p.name),
    [folderId, setFolderId] = useState(p.folderId || "");
  const [section, setSection] = useState(
      initial === "move" ? "general" : initial,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [guard, setGuard] = useState<"close" | "reload" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dirty = name !== p.name || folderId !== (p.folderId || "");
  const pending = useRef<Command | null>(null);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function reloadSaved() {
    setBusy(true);
    try {
      await onSaved(await api<Project>("/projects/" + p.id));
      pending.current = null;
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const active = !p.lifecycle || p.lifecycle === "active";
  const close = () => {
    if (busy) return;
    if (dirty) setGuard("close");
    else onClose();
  };
  async function save(lifecycle?: "active" | "archived" | "trashed") {
    setBusy(true);
    setError("");
    try {
      const cmd =
        pending.current ??
        makeCommand(
          p.id,
          p.revision,
          lifecycle
            ? { type: "set_project_lifecycle", lifecycle }
            : {
                type: "update_project",
                name,
                description: p.description,
                folderId: folderId || null,
              },
        );
      pending.current = cmd;
      const next = await sendCommand(cmd);
      await onSaved(next);
      pending.current = null;
      onClose();
    } catch (e) {
      setError((e as Error).message);
      if ([409, 422].includes((e as { status: number }).status))
        pending.current = null;
    } finally {
      setBusy(false);
    }
  }
  if (initial === "move")
    return (
      <Modal
        title={`Move “${p.name}”`}
        className="move-item-dialog"
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
              disabled={busy || !active || folderId === (p.folderId || "")}
              onClick={() => void save()}
            >
              {busy ? "Moving…" : "Move"}
            </Button>
          </>
        }
      >
        <MoveLocationPicker
          currentFolderId={p.folderId}
          folderId={folderId}
          folders={folders}
          onChange={setFolderId}
          disabled={!active || busy || !!pending.current}
        />
        {error && (
          <Feedback
            tone="error"
            message={error}
            action={{
              label: "Reload latest",
              onClick: () => void reloadSaved(),
            }}
          />
        )}
      </Modal>
    );
  return (
    <Modal
      title="Project settings"
      wide
      className="account-settings project-settings-dialog"
      layout="settings"
      onClose={close}
      footer={
        dirty && active ? (
          <>
            <Button
              onClick={() => {
                pending.current = null;
                setName(p.name);
                setFolderId(p.folderId || "");
              }}
              disabled={busy}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={busy || !name.trim()}
            >
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="settings-layout">
        <nav
          className="settings-navigation"
          aria-label="Project settings sections"
        >
          {[
            ["general", "General"],
            ["manage", "Manage project"],
          ].map(([id, label]) => (
            <Button
              key={id}
              variant="navigation"
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
        <div className="settings-content project-settings-content">
          {error && (
            <Feedback
              tone="error"
              message={error}
              action={
                pending.current
                  ? { label: "Retry", onClick: () => void save() }
                  : {
                      label: "Reload saved version",
                      onClick: () => {
                        if (dirty) setGuard("reload");
                        else void reloadSaved();
                      },
                    }
              }
            />
          )}
          {section === "general" ? (
            <>
              <h3>General</h3>
              <label>
                Project name
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  disabled={!active || busy || !!pending.current}
                />
              </label>
              <div className="project-settings-field">
                <span>Folder</span>
                <Select
                  label="Folder"
                  openOnMount={initial === "move"}
                  value={folderId}
                  onValueChange={setFolderId}
                  disabled={!active || busy || !!pending.current}
                  options={[
                    { value: "", label: "Workspace" },
                    ...folders.map((f) => ({ value: f.id, label: f.name })),
                  ]}
                />
              </div>
              {!active && (
                <p className="muted">
                  Restore this project to edit its settings.
                </p>
              )}
            </>
          ) : (
            <>
              <h3>Manage project</h3>
              <div className="project-management-row">
                <div>
                  <strong>
                    {active ? "Archive project" : "Restore project"}
                  </strong>
                  <p>
                    {active
                      ? "Keep the project out of your active library."
                      : "Return this project to your active library."}
                  </p>
                </div>
                <Button
                  disabled={busy || dirty}
                  onClick={() => void save(active ? "archived" : "active")}
                >
                  {active ? "Archive" : "Restore"}
                </Button>
              </div>
              {p.lifecycle !== "trashed" && (
                <div className="project-management-row">
                  <div>
                    <strong>Move to trash</strong>
                    <p>You can restore it from Trash.</p>
                  </div>
                  <Button
                    variant="danger"
                    disabled={busy || dirty}
                    onClick={() => void save("trashed")}
                  >
                    Move to trash
                  </Button>
                </div>
              )}
              {p.lifecycle === "trashed" && (
                <div className="project-management-row">
                  <div>
                    <strong>Delete permanently</strong>
                    <p>Delete this project and its contents forever.</p>
                  </div>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => setDeleting(true)}
                  >
                    Delete permanently
                  </Button>
                </div>
              )}
              {dirty && <p>Save or discard your changes first.</p>}
            </>
          )}
        </div>
      </div>
      <ModalPresence>
        {deleting && (
          <DeleteTrashDialog
            selection={{ projects: [p], ideas: [] }}
            owner={owner}
            onClose={() => setDeleting(false)}
            onDeleted={async () => {
              await onDeleted();
              onClose();
            }}
          />
        )}
      </ModalPresence>
      <ModalPresence>
        {guard && (
          <Modal
            confirmation
            title="Unsaved project settings"
            onClose={() => setGuard(null)}
            footer={
              <>
                <Button onClick={() => setGuard(null)}>Keep editing</Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    guard === "reload" ? void reloadSaved() : onClose()
                  }
                >
                  {guard === "reload"
                    ? "Discard and reload"
                    : "Discard changes"}
                </Button>
              </>
            }
          >
            <p>Your changes have not been saved.</p>
          </Modal>
        )}
      </ModalPresence>
    </Modal>
  );
}
