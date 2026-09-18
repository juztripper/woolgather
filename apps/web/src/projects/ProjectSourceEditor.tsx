import { useEffect, useId, useRef, useState } from "react";
import type {
  ProjectSource,
  ProjectSourceMeaning,
} from "../../../../packages/domain/src/projectSources";
import { Textarea } from "../components/ui/textarea";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { useToast } from "../ui/Toast";
import { clearDraft, readDraft, storeDraft } from "./model";

export function ProjectSourceEditor({
  source,
  owner,
  projectId,
  onClose,
  onSave,
}: {
  source: ProjectSource;
  owner: string;
  projectId: string;
  onClose: () => void;
  onSave: (value: {
    note: string;
    meaning: ProjectSourceMeaning;
  }) => Promise<void>;
}) {
  const { notify } = useToast();
  const fieldId = useId();
  const key = `woolgather:source-context:${owner}:${projectId}:${source.id}`;
  const [draft, setDraft] = useState(() => {
    const saved = readDraft(key) as {
      note?: unknown;
      meaning?: unknown;
      base?: unknown;
    } | null;
    return saved &&
      typeof saved.note === "string" &&
      ["use", "avoid", "undecided"].includes(String(saved.meaning)) &&
      typeof saved.base === "string"
      ? {
          note: saved.note,
          meaning: saved.meaning as ProjectSourceMeaning,
          base: saved.base,
        }
      : { note: source.note, meaning: source.meaning, base: source.updatedAt };
  });
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const changedElsewhere = source.updatedAt !== draft.base;
  useEffect(() => {
    if (!storeDraft(key, draft))
      notify(
        "This browser could not preserve the source context. Keep this editor open until it is saved.",
        { tone: "error", id: "source-draft" },
      );
  }, [key, draft, notify]);
  async function save() {
    if (saveLock.current) return;
    if (changedElsewhere) {
      notify(
        "This source changed elsewhere. Review its saved context before saving.",
        { tone: "error" },
      );
      return;
    }
    saveLock.current = true;
    setSaving(true);
    try {
      await onSave({ note: draft.note, meaning: draft.meaning });
      clearDraft(key);
      onClose();
    } catch (cause) {
      notify(
        cause instanceof Error
          ? cause.message
          : "Could not save source context.",
        { tone: "error" },
      );
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  return (
    <Modal
      title="Source context"
      onClose={() => {
        if (!saveLock.current) onClose();
      }}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={saving || changedElsewhere}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save context"}
          </Button>
        </>
      }
    >
      <form
        className="project-source-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="project-source-editor-name">{source.name}</p>
        {changedElsewhere && (
          <div className="project-source-editor-conflict">
            <p>The saved context changed. Your draft is kept below.</p>
            <p>{source.note || "No saved note"}</p>
            <Button
              size="sm"
              onClick={() =>
                setDraft({
                  note: source.note,
                  meaning: source.meaning,
                  base: source.updatedAt,
                })
              }
            >
              Reload saved context
            </Button>
          </div>
        )}
        <label htmlFor={fieldId}>What should we remember?</label>
        <Textarea
          id={fieldId}
          disabled={saving}
          value={draft.note}
          maxLength={4000}
          rows={5}
          placeholder="What this reference is useful for, or what to avoid…"
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        />
        <span>Use in this project</span>
        <Select
          disabled={saving}
          label="Use in this project"
          value={draft.meaning}
          options={[
            { value: "undecided", label: "Undecided" },
            { value: "use", label: "Use as a reference" },
            { value: "avoid", label: "Avoid" },
          ]}
          onValueChange={(value) =>
            setDraft({ ...draft, meaning: value as ProjectSourceMeaning })
          }
        />
      </form>
    </Modal>
  );
}
