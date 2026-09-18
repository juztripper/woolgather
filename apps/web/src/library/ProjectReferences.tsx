import { ModalPresence } from "@/ui/Modal";
import { useContext, useEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import type { Command, Project } from "../../../../packages/domain/src";
import {
  referencesSchema,
  type ImageReference,
} from "../../../../packages/domain/src/ideaDocument";
import { makeCommand } from "../client";
import { ProjectTransport } from "../projects/ProjectTransport";
import { commandSchema } from "../../../../packages/domain/src/commands";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Disclosure } from "../ui/Disclosure";
import { Feedback } from "../ui/Toast";
import { ReferenceImages } from "./ReferenceImages";

function ReferenceEditor({
  project,
  owner,
  onClose,
  onSaved,
}: {
  project: Project;
  owner: string;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const { request: api, command: sendCommand } = useContext(ProjectTransport);
  const key = `woolgather:project-references:${owner}:${project.id}`;
  const [recovery] = useState(() => {
    try {
      const data = JSON.parse(localStorage.getItem(key) || "null");
      return data && Number.isInteger(data.revision)
        ? {
            references: referencesSchema.parse(data.references),
            revision: data.revision,
          }
        : null;
    } catch {
      return null;
    }
  });
  const [references, setReferences] = useState<ImageReference[]>(
    recovery?.references || referencesSchema.parse(project.references || []),
  );
  const [base, setBase] = useState(project),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [guard, setGuard] = useState(false),
    [error, setError] = useState("");
  const [latest, setLatest] = useState<Project | null>(null);
  const [retry] = useState(() => {
    try {
      const parsed = commandSchema.safeParse(
        JSON.parse(localStorage.getItem(key + ":pending") || "null"),
      );
      return parsed.success &&
        parsed.data.projectId === project.id &&
        parsed.data.action.type === "update_references"
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  });
  const baseRevision = useRef(recovery?.revision || project.revision),
    pending = useRef<Command | null>(retry);
  const dirty =
    JSON.stringify(references) !==
    JSON.stringify(referencesSchema.parse(base.references || []));
  const locked = busy || uploading;
  function edit(next: ImageReference[]) {
    setReferences(next);
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ references: next, revision: baseRevision.current }),
      );
    } catch {
      setError(
        "Keep this editor open until saving succeeds; this browser could not keep a recovery copy.",
      );
    }
  }
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty || uploading) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, uploading]);
  async function save() {
    if (locked) return;
    if (!pending.current && baseRevision.current !== base.revision) {
      setLatest(base);
      setError(
        "The project changed since your draft. Review the current references before saving.",
      );
      setGuard(false);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const cmd =
        pending.current ||
        makeCommand(project.id, base.revision, {
          type: "update_references",
          references,
        });
      pending.current = cmd;
      try {
        localStorage.setItem(key + ":pending", JSON.stringify(cmd));
      } catch {}
      await sendCommand(cmd);
      const saved = await api<Project>(`/projects/${project.id}`);
      pending.current = null;
      try {
        localStorage.removeItem(key);
        localStorage.removeItem(key + ":pending");
      } catch {}
      onSaved(saved);
      onClose();
    } catch (e) {
      setGuard(false);
      setError((e as Error).message);
      if ([409, 422].includes((e as { status?: number }).status || 0)) {
        pending.current = null;
        try {
          localStorage.removeItem(key + ":pending");
        } catch {}
        if ((e as { status?: number }).status === 409) {
          try {
            setLatest(await api<Project>(`/projects/${project.id}`));
          } catch {}
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Images & references"
      wide
      className="project-references-dialog"
      onClose={() => {
        if (!locked) dirty && !pending.current ? setGuard(true) : onClose();
      }}
      footer={
        <>
          <Button
            disabled={locked}
            onClick={() =>
              dirty && !pending.current ? setGuard(true) : onClose()
            }
          >
            Close
          </Button>
          {(dirty || pending.current) && (
            <Button
              variant="primary"
              disabled={locked || !!latest}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save references"}
            </Button>
          )}
        </>
      }
    >
      <p className="idea-field-hint">
        Keep logos, sketches, and other visual context with the project.
      </p>
      {error && <Feedback tone="error" message={error} />}
      <ReferenceImages
        references={references}
        onChange={edit}
        disabled={busy || !!pending.current}
        onBusy={setUploading}
      />
      {latest && (
        <section>
          <h3>Current project references</h3>
          <ReferenceImages references={latest.references || []} readOnly />
          <div className="idea-inline-actions">
            <Button
              onClick={() => {
                baseRevision.current = latest.revision;
                setBase(latest);
                edit(referencesSchema.parse(latest.references || []));
                setLatest(null);
                setError("");
              }}
            >
              Use current references
            </Button>
            <Button
              onClick={() => {
                baseRevision.current = latest.revision;
                setBase(latest);
                edit(references);
                setLatest(null);
                setError("");
              }}
            >
              Keep my references
            </Button>
          </div>
        </section>
      )}
      <ModalPresence>
        {guard && (
          <Modal
            title="Keep your changes?"
            onClose={() => setGuard(false)}
            footer={
              <>
                <Button
                  disabled={busy}
                  onClick={() => {
                    try {
                      localStorage.removeItem(key);
                    } catch {}
                    onClose();
                  }}
                >
                  Discard changes
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  Save changes
                </Button>
              </>
            }
          >
            <p>Your reference changes have not been saved yet.</p>
          </Modal>
        )}
      </ModalPresence>
    </Modal>
  );
}
export function ProjectReferences({
  project,
  owner,
  onSaved,
  embedded = false,
}: {
  project: Project;
  owner: string;
  onSaved: (project: Project) => void;
  embedded?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const readOnly = !!project.lifecycle && project.lifecycle !== "active";
  const content = (
    <>
      <div className="project-reference-heading">
        <p>
          {project.references?.length
            ? "Visual context for this project."
            : "Add a logo, a sketch, or an example of what you have in mind."}
        </p>
        {!readOnly && (
          <Button onClick={() => setEditing(true)}>
            <ImagePlus size={14} />{" "}
            {project.references?.length ? "Edit references" : "Add images"}
          </Button>
        )}
      </div>
      <ReferenceImages references={project.references || []} readOnly />
    </>
  );
  return (
    <>
      {embedded ? (
        content
      ) : (
        <Disclosure
          title={`Images & references${project.references?.length ? ` · ${project.references.length}` : ""}`}
        >
          {content}
        </Disclosure>
      )}
      <ModalPresence>
        {editing && (
          <ReferenceEditor
            project={project}
            owner={owner}
            onSaved={onSaved}
            onClose={() => setEditing(false)}
          />
        )}
      </ModalPresence>
    </>
  );
}
