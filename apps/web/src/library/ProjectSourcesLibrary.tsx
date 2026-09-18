import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Lightbulb,
  Link2,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Input } from "../components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Button, IconButton } from "../ui/Button";
import { Modal, ModalPresence } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import "./project-sources-library.css";

export type ProjectSourceView = {
  id: string;
  title: string;
  kind: "file" | "image" | "link" | "thought" | "conversation" | "other";
  detail?: string;
  status?: "ready" | "uploading" | "failed";
  preview?: string;
  /** Optional authenticated thumbnail supplied by the owning project surface. */
  thumbnail?: ReactNode;
  error?: string;
  removable?: boolean;
  archived?: boolean;
};

export type ProjectSourcesLibraryProps = {
  sources: ProjectSourceView[];
  onUpload?: (files: File[]) => void | Promise<void>;
  onUse?: (source: ProjectSourceView) => void | Promise<void>;
  onOpen?: (source: ProjectSourceView) => void | Promise<void>;
  onEdit?: (source: ProjectSourceView) => void | Promise<void>;
  onRemove?: (source: ProjectSourceView) => void | Promise<void>;
  onRetry?: (source: ProjectSourceView) => void | Promise<void>;
  disabled?: boolean;
  searchQuery?: string;
};

const sourceIcons: Record<ProjectSourceView["kind"], LucideIcon> = {
  file: FileText,
  image: ImageIcon,
  link: Link2,
  thought: Lightbulb,
  conversation: MessageCircle,
  other: Paperclip,
};

function sourceStatus(source: ProjectSourceView) {
  if (source.status === "uploading") return "Uploading";
  if (source.status === "failed") return "Needs attention";
  return source.detail || "Project source";
}

export function ProjectSourcesLibrary({
  sources,
  onUpload,
  onUse,
  onOpen,
  onEdit,
  onRemove,
  onRetry,
  disabled = false,
  searchQuery,
}: ProjectSourcesLibraryProps) {
  const { notify } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [localQuery, setQuery] = useState("");
  const query = searchQuery ?? localQuery;
  const [showArchived, setShowArchived] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSourceView | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const availableSources = sources.filter(
    (source) => !!source.archived === showArchived,
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSources = normalizedQuery
    ? availableSources.filter((source) =>
        [source.title, source.detail, source.kind]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : availableSources;

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length || !onUpload || disabled) return;
    void Promise.resolve(onUpload(files)).catch((cause) => {
      notify(
        cause instanceof Error ? cause.message : "Could not add sources.",
        {
          tone: "error",
        },
      );
    });
  };

  const run = async (action: () => void | Promise<void>, fallback: string) => {
    try {
      await action();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : fallback, {
        tone: "error",
      });
    }
  };

  const deleteSource = async () => {
    if (!deleteTarget || !onRemove || deleting) return;
    setDeleting(true);
    try {
      await onRemove(deleteTarget);
      setDeleteTarget(null);
    } catch (cause) {
      notify(
        cause instanceof Error
          ? cause.message
          : "Could not delete this source.",
        { tone: "error" },
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="project-sources-library" aria-label="Project sources">
      <div className="project-sources-toolbar">
        <span className="project-sources-count" aria-live="polite">
          {availableSources.length} {showArchived ? "archived" : ""}{" "}
          {availableSources.length === 1 ? "source" : "sources"}
        </span>
        <div className="project-sources-actions">
          {sources.some((source) => source.archived) && (
            <Button
              size="sm"
              variant="quiet"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((value) => !value)}
            >
              {showArchived ? "Back to sources" : "Show archived"}
            </Button>
          )}
          {onUpload && (
            <>
              <input
                ref={inputRef}
                className="project-sources-file-input"
                type="file"
                multiple
                onChange={chooseFiles}
                aria-label="Upload project sources"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => inputRef.current?.click()}
              >
                <Plus aria-hidden="true" />
                Add source
              </Button>
            </>
          )}
        </div>
      </div>
      {searchQuery === undefined && (
        <div className="project-sources-search">
          <Search aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sources"
            aria-label="Search project sources"
            className="pl-8"
          />
        </div>
      )}
      {visibleSources.length ? (
        <ul className="project-sources-list">
          {visibleSources.map((source) => {
            const Icon = sourceIcons[source.kind];
            const working = source.status === "uploading";
            const locked = disabled || working;
            return (
              <li
                key={source.id}
                className="project-source-row"
                data-status={source.status || "ready"}
              >
                {source.thumbnail !== undefined ? (
                  <span className="project-source-thumbnail">
                    {source.thumbnail}
                  </span>
                ) : source.preview && source.kind === "image" ? (
                  <img
                    className="project-source-preview"
                    src={source.preview}
                    alt=""
                  />
                ) : (
                  <span className="project-source-icon" aria-hidden="true">
                    <Icon />
                  </span>
                )}
                <span className="project-source-copy">
                  {onOpen && source.status !== "failed" ? (
                    <Button
                      type="button"
                      className="project-source-library-name h-auto min-h-0 justify-start whitespace-normal rounded-sm p-0 text-left"
                      variant="inline"
                      size="sm"
                      disabled={locked}
                      onClick={() =>
                        void run(
                          () => onOpen(source),
                          `Could not open ${source.title}.`,
                        )
                      }
                    >
                      {source.title}
                    </Button>
                  ) : (
                    <strong className="project-source-library-name">
                      {source.title}
                    </strong>
                  )}
                  <span className="project-source-detail">
                    {sourceStatus(source)}
                  </span>
                  {source.error && source.status === "failed" && (
                    <span className="project-source-error" role="alert">
                      {source.error}
                    </span>
                  )}
                </span>
                <span className="project-source-actions">
                  {source.status === "failed" && onRetry && (
                    <IconButton
                      size="icon-sm"
                      aria-label={`Retry ${source.title}`}
                      title={`Retry ${source.title}`}
                      disabled={locked}
                      onClick={() =>
                        void run(
                          () => onRetry(source),
                          `Could not retry ${source.title}.`,
                        )
                      }
                    >
                      <RefreshCw aria-hidden="true" />
                    </IconButton>
                  )}
                  {onUse && !source.archived && source.status !== "failed" && (
                    <Button
                      size="xs"
                      variant="quiet"
                      disabled={locked}
                      onClick={() =>
                        void run(
                          () => onUse(source),
                          `Could not use ${source.title}.`,
                        )
                      }
                    >
                      Use
                    </Button>
                  )}
                  {onOpen && source.status !== "failed" && (
                    <IconButton
                      size="icon-sm"
                      aria-label={`Open ${source.title}`}
                      title={`Open ${source.title}`}
                      disabled={locked}
                      onClick={() =>
                        void run(
                          () => onOpen(source),
                          `Could not open ${source.title}.`,
                        )
                      }
                    >
                      {working ? (
                        <LoaderCircle
                          className="project-sources-spinner"
                          aria-hidden="true"
                        />
                      ) : (
                        <ExternalLink aria-hidden="true" />
                      )}
                    </IconButton>
                  )}
                  {(onEdit || (source.removable && onRemove)) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <IconButton
                            size="icon-sm"
                            aria-label={`More actions for ${source.title}`}
                            title={`More actions for ${source.title}`}
                            disabled={locked}
                          />
                        }
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {onEdit &&
                          !source.archived &&
                          source.status !== "failed" && (
                            <DropdownMenuItem
                              onClick={() =>
                                void run(
                                  () => onEdit(source),
                                  `Could not edit ${source.title}.`,
                                )
                              }
                            >
                              <Pencil aria-hidden="true" />
                              Edit context
                            </DropdownMenuItem>
                          )}
                        {source.removable && onRemove && (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDeleteTarget(source)}
                          >
                            <Trash2 aria-hidden="true" />
                            {source.status === "failed"
                              ? "Remove upload"
                              : "Delete source permanently"}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="project-sources-empty">
          <FileText aria-hidden="true" />
          <p>
            {normalizedQuery
              ? "No sources match this search."
              : showArchived
                ? "No archived sources."
                : "Keep files and images here for every conversation in this project."}
          </p>
        </div>
      )}
      <ModalPresence>
        {deleteTarget && (
          <Modal
            confirmation
            title={
              deleteTarget.status === "failed"
                ? "Remove upload?"
                : "Delete source permanently?"
            }
            onClose={() => {
              if (!deleting) setDeleteTarget(null);
            }}
            footer={
              <>
                <Button
                  variant="quiet"
                  disabled={deleting}
                  onClick={() => setDeleteTarget(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger-primary"
                  disabled={deleting}
                  onClick={() => void deleteSource()}
                >
                  {deleting
                    ? "Removing…"
                    : deleteTarget.status === "failed"
                      ? "Remove upload"
                      : "Delete permanently"}
                </Button>
              </>
            }
          >
            <p>
              {deleteTarget.status === "failed" ? (
                <>
                  Remove “{deleteTarget.title}” from pending uploads? It will no
                  longer be retried.
                </>
              ) : (
                <>
                  Delete “{deleteTarget.title}” forever? This removes the source
                  and its references from this project. Existing messages keep
                  their text, but this source can no longer be opened or
                  retrieved. Copies saved separately in other projects or Ideas
                  are kept.
                </>
              )}
            </p>
          </Modal>
        )}
      </ModalPresence>
    </section>
  );
}
