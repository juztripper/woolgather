import { useRef, useState } from "react";
import type {
  Folder,
  Idea,
  LibraryCommand,
} from "../../../../packages/domain/src/library";
import { api } from "../client";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { MoveLocationPicker } from "./MoveLocationPicker";
import { ideaTitle } from "../../../../packages/domain/src/library";
import { Feedback } from "../ui/Toast";
export function MoveIdeaDialog({
  idea,
  folders,
  onClose,
  onMoved,
}: {
  idea: Idea;
  folders: Folder[];
  onClose: () => void;
  onMoved: () => Promise<void>;
}) {
  const [folderId, setFolderId] = useState(idea.folderId || "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<LibraryCommand | null>(null);
  async function move() {
    setBusy(true);
    setError("");
    try {
      const cmd = pending.current ?? {
        id: crypto.randomUUID(),
        targetId: idea.id,
        expectedRevision: idea.revision,
        type: "move_idea" as const,
        folderId: folderId || null,
      };
      pending.current = cmd;
      await api("/library", cmd);
      await onMoved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Move “${idea.document?.title.trim() || ideaTitle(idea.body)}”`}
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
            disabled={busy || folderId === (idea.folderId || "")}
            onClick={() => void move()}
          >
            {busy ? "Moving…" : "Move"}
          </Button>
        </>
      }
    >
      <MoveLocationPicker
        currentFolderId={idea.folderId}
        folderId={folderId}
        onChange={setFolderId}
        folders={folders}
        disabled={busy || !!pending.current}
      />
      {error && (
        <Feedback
          tone="error"
          message={error}
          action={{
            label: "Reload latest",
            onClick: async () => {
              await onMoved();
              onClose();
            },
          }}
        />
      )}
    </Modal>
  );
}
