import { useState } from "react";
import type {
  Folder,
  LibraryCommand,
} from "../../../../packages/domain/src/library";
import { api } from "../client";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Feedback } from "../ui/Toast";
export function DeleteFolderDialog({
  folder,
  onClose,
  onDeleted,
}: {
  folder: Folder;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [command] = useState<LibraryCommand>(() => ({
    id: crypto.randomUUID(),
    targetId: folder.id,
    expectedRevision: folder.revision,
    type: "delete_folder",
  }));
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api("/library", command);
      await onDeleted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      confirmation
      title="Delete folder?"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? "Deleting…" : "Delete folder"}
          </Button>
        </>
      }
    >
      <p>Delete “{folder.name}”?</p>
      <p>
        Your ideas and projects will be kept in Workspace. Archived items stay
        in Archive, and trashed items stay in Trash.
      </p>
      {error && <Feedback tone="error" message={error} />}
    </Modal>
  );
}
