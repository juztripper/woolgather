import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  RotateCcw,
  Search,
} from "lucide-react";
import type { Item } from "../../../../packages/domain/src";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { Input } from "../components/ui/input";
import { Modal, ModalPresence } from "../ui/Modal";
import { ProjectText } from "./ProjectText";
import { labels } from "./model";
import "./removed-thoughts.css";

/** Removed content is read, then restored; it is never presented as a disabled editor. */
export function RemovedThoughts({
  items,
  navigation,
  readOnly,
  busy,
  pending,
  error,
  onBack,
  onRestore,
  onRetry,
}: {
  items: Item[];
  navigation?: ReactNode;
  readOnly: boolean;
  busy: boolean;
  pending: boolean;
  error: string;
  onBack: () => void;
  onRestore: (id: string) => Promise<void>;
  onRetry: () => void;
}) {
  const { notify } = useToast();
  useEffect(() => {
    if (error) notify(error, { tone: "error" });
  }, [error, notify]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const removed = items.filter((item) => item.removed);
  const selected = removed.find((item) => item.id === selectedId);
  const matches = removed.filter((item) =>
    `${item.title} ${item.body} ${item.answer}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const restore = (id: string) => void onRestore(id);
  return (
    <section
      className="project-workspace removed-thoughts"
      aria-label="Removed thoughts"
    >
      <div className="removed-thoughts-navigation">
        {navigation}
        <Button variant="quiet" size="sm" onClick={onBack}>
          <ArrowLeft /> Back to project
        </Button>
      </div>
      <div className="removed-thoughts-scroll">
        <div className="removed-thoughts-content">
          <header>
            <h1>Removed thoughts</h1>
            <p>Restore a thought to bring it back to your plan.</p>
          </header>
          {removed.length > 0 && (
            <div className="removed-thoughts-search">
              <Search aria-hidden="true" />
              <Input
                className="pl-9"
                aria-label="Search removed thoughts"
                placeholder="Search removed thoughts…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          )}
          {pending && (
            <Button size="sm" disabled={busy || readOnly} onClick={onRetry}>
              {busy ? "Restoring…" : "Retry restore"}
            </Button>
          )}
          <div className="removed-thoughts-list">
            {matches.map((item) => (
              <article key={item.id} className="removed-thought-row">
                <Button
                  variant="surface"
                  className="removed-thought-open flex p-3 rounded-[14px]"
                  aria-label={`Read ${item.title}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <FileText aria-hidden="true" />
                  <span className="removed-thought-copy">
                    <strong>{item.title}</strong>
                    {item.body && item.body !== item.title && (
                      <span>{item.body}</span>
                    )}
                  </span>
                  <ChevronRight aria-hidden="true" />
                </Button>
                {!readOnly && (
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label={`Restore ${item.title}`}
                    disabled={busy || pending}
                    onClick={() => restore(item.id)}
                  >
                    <RotateCcw /> Restore
                  </Button>
                )}
              </article>
            ))}
            {!matches.length && (
              <p className="removed-thoughts-empty">
                {query.trim()
                  ? "No matching thoughts."
                  : "No removed thoughts."}
              </p>
            )}
          </div>
        </div>
      </div>
      <ModalPresence>
        {selected && (
          <Modal
            title={selected.title}
            onClose={() => setSelectedId(undefined)}
            footer={
              <>
                <Button
                  variant="quiet"
                  onClick={() => setSelectedId(undefined)}
                >
                  Close
                </Button>
                {!readOnly && (
                  <Button
                    size="sm"
                    disabled={busy || pending}
                    onClick={() => restore(selected.id)}
                  >
                    <RotateCcw /> Restore thought
                  </Button>
                )}
              </>
            }
          >
            <div className="removed-thought-details">
              <p className="text-sm text-muted-foreground">
                {labels[selected.category]} · {labels[selected.certainty]}
              </p>
              {pending && (
                <Button size="sm" disabled={busy || readOnly} onClick={onRetry}>
                  {busy ? "Restoring…" : "Retry restore"}
                </Button>
              )}
              {selected.body ? (
                <ProjectText text={selected.body} />
              ) : (
                <p>No additional details.</p>
              )}
              {selected.answer && (
                <section>
                  <h3>Answer</h3>
                  <ProjectText text={selected.answer} />
                </section>
              )}
            </div>
          </Modal>
        )}
      </ModalPresence>
    </section>
  );
}
