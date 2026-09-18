import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useContext, useEffect, useRef, useState } from "react";
import type { Command, Project } from "../../../../packages/domain/src";
import { makeCommand } from "../client";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Feedback } from "../ui/Toast";
import { ProjectTransport } from "./ProjectTransport";
import { clearDraft, readDraft, storeDraft } from "./model";
import { ProjectText } from "./ProjectText";

export function ProjectBriefEditor({
  project,
  owner,
  field,
  onClose,
  onSaved,
}: {
  project: Project;
  owner: string;
  field: "name" | "description";
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const transport = useContext(ProjectTransport);
  const key = `woolgather:project-text:${owner}:${project.id}:${field}`;
  const [recovery] = useState(() => readDraft(key));
  const [value, setValue] = useState<string>(recovery?.value ?? project[field]);
  const [base, setBase] = useState<Project>(recovery?.base ?? project);
  const pending = useRef<Command | null>(recovery?.pending ?? null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [latest, setLatest] = useState<Project | null>(null);
  const [conflict, setConflict] = useState(false);
  const [safe, setSafe] = useState(true);
  const dirty = value !== project[field];
  useEffect(() => {
    if (!dirty && !pending.current) {
      clearDraft(key);
      return;
    }
    setSafe(storeDraft(key, { value, base, pending: pending.current }));
  }, [key, value, base, dirty]);
  async function review() {
    try {
      setLatest(await transport.request<Project>(`/projects/${project.id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save() {
    if (busy || conflict) return;
    setBusy(true);
    setError("");
    const cmd =
      pending.current ||
      makeCommand(
        project.id,
        base.revision,
        field === "name"
          ? { type: "rename_project", name: value }
          : {
              type: "update_project",
              name: base.name,
              description: value,
              folderId: base.folderId ?? null,
            },
      );
    pending.current = cmd;
    setSafe(storeDraft(key, { value, base, pending: cmd }));
    try {
      const saved = await transport.command(cmd);
      clearDraft(key);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      const status = (e as { status?: number }).status;
      if ([400, 404, 409, 422].includes(status || 0)) {
        pending.current = null;
        storeDraft(key, { value, base, pending: null });
        if (status === 409) {
          setConflict(true);
          await review();
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={field === "name" ? "Rename project" : "Edit working brief"}
      wide={field === "description"}
      className="project-brief-editor"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <span className="draft-state">
            {!dirty && !pending.current
              ? "Saved in this project"
              : safe
                ? "Draft kept on this device"
                : "Keep this window open to save"}
          </span>
          <Button
            disabled={busy || !!pending.current}
            onClick={() => {
              clearDraft(key);
              onClose();
            }}
          >
            {dirty ? "Discard draft" : "Cancel"}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="project-brief-form"
            disabled={busy || conflict || (!dirty && !pending.current)}
          >
            {busy ? "Saving…" : pending.current ? "Retry save" : "Save changes"}
          </Button>
        </>
      }
    >
      <form
        id="project-brief-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          {field === "name" ? "Project name" : "Working brief"}
          {field === "name" ? (
            <Input
              required
              maxLength={120}
              value={value}
              disabled={busy || !!pending.current}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <Textarea
              rows={14}
              maxLength={12000}
              value={value}
              disabled={busy || !!pending.current}
              onChange={(e) => setValue(e.target.value)}
              placeholder="What are you making, who is it for, and what matters?"
            />
          )}
        </label>
        {field === "description" && (
          <p className="muted">
            Use headings and lists to give your brief structure. Your original
            idea remains available in the project menu.
          </p>
        )}
        {error && <Feedback message={error} tone="error" />}
        {conflict && (
          <section className="project-conflict">
            <h3>This project changed</h3>
            {latest ? (
              <>
                <p>Latest saved {field === "name" ? "name" : "brief"}</p>
                <ProjectText text={latest[field]} />
                <Button
                  onClick={() => {
                    setBase(latest);
                    setLatest(null);
                    setConflict(false);
                    setError("");
                  }}
                >
                  I’ve reviewed it — keep my draft
                </Button>
              </>
            ) : (
              <Button onClick={() => void review()}>
                Review latest version
              </Button>
            )}
          </section>
        )}
      </form>
    </Modal>
  );
}
