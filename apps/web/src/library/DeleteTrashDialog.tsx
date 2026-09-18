import { useState } from "react";
import type { DeleteTrash } from "../../../../packages/domain/src/library";
import { api } from "../client";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Feedback } from "../ui/Toast";
export type TrashSelection = {
  projects: { id: string; revision: number; name: string }[];
  ideas: { id: string; revision: number; name: string }[];
  empty?: boolean;
};
export function DeleteTrashDialog({
  selection,
  owner,
  onClose,
  onDeleted,
}: {
  selection: TrashSelection;
  owner: string;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [command] = useState<DeleteTrash>(() => ({
    id: crypto.randomUUID(),
    projects: selection.projects.map(({ id, revision }) => ({ id, revision })),
    ideas: selection.ideas.map(({ id, revision }) => ({ id, revision })),
  }));
  async function remove() {
    setBusy(true);
    setError("");
    try {
      if (!deleted) {
        const removed = await api<{ projects: string[]; ideas: string[] }>(
          "/trash",
          command,
        );
        try {
          const prefixes = removed.projects.map((id) => `wg:${owner}:${id}:`);
          const ideaKeys = new Set(
            removed.ideas.map((id) => `woolgather:idea:${owner}:${id}`),
          );
          for (const key of Object.keys(localStorage)) {
            if (
              ideaKeys.has(key) ||
              prefixes.some((prefix) => key.startsWith(prefix))
            )
              localStorage.removeItem(key);
          }
        } catch {
          /* Browser storage may be unavailable. Canonical deletion succeeded. */
        }
        setDeleted(true);
      }
      await onDeleted();
      onClose();
      // The invoking row may be gone and Empty trash may now be disabled.
      // Wait until dialog cleanup has restored native focus, then choose a
      // surviving control rather than leaving focus on the main landmark.
      requestAnimationFrame(() => {
        const navigation = document.querySelector<HTMLElement>(
          "[data-trash-navigation]",
        );
        const target = navigation?.getClientRects().length
          ? navigation
          : document.querySelector<HTMLElement>(
              ".expanding-search > [data-slot='button']",
            );
        target?.focus({ preventScroll: true });
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      confirmation
      title={selection.empty ? "Empty trash?" : "Delete permanently?"}
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
            {busy
              ? "Deleting…"
              : deleted
                ? "Refresh library"
                : selection.empty
                  ? "Empty trash"
                  : "Delete permanently"}
          </Button>
        </>
      }
    >
      <p>
        {selection.empty
          ? "Permanently delete these items from Trash?"
          : "Permanently delete this item?"}{" "}
        This cannot be undone.
      </p>
      <ul className="trash-selection">
        {[...selection.projects, ...selection.ideas].map((i) => (
          <li key={i.id}>{i.name}</li>
        ))}
      </ul>
      {selection.projects.length > 0 && (
        <p className="muted">
          Project contents and history will also be deleted. Separate ideas are
          kept unless listed here.
        </p>
      )}
      {selection.ideas.length > 0 && (
        <p className="muted">
          Projects created from these ideas keep their source text.
        </p>
      )}
      {error && <Feedback tone="error" message={error} />}
    </Modal>
  );
}
