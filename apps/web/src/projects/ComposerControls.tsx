import { useToast } from "../ui/Toast";
import { ReasoningControl } from "./ReasoningControl";
import { uploadQueue } from "./composerUploads";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MutableRefObject,
} from "react";
import {
  Plus,
  X,
  MessageCircle,
  GitBranch,
  Scale,
  ScanSearch,
  ListChecks,
} from "lucide-react";
import { composerToolDetails } from "./composerCommands";
import { Button, IconButton } from "../ui/Button";
import { attachmentRequest } from "../library/attachments";
import { AttachmentCard } from "../components/ui/attachment-card";

import {
  attachmentReading,
  planningTools,
  type ComposerOptions,
} from "../../../../packages/domain/src/planningComposer";
import type { Item } from "../../../../packages/domain/src";

type Attachment = ComposerOptions["attachments"][number];
export const composerToolIcons = {
  discuss: MessageCircle,
  alternatives: GitBranch,
  compare: Scale,
  challenge: ScanSearch,
  next_steps: ListChecks,
};
export function ConversationFile({
  file,
  localFile,
  downloadable = true,
  uploading = false,
  uploadError,
  onRetry,
  onRemove,
  onPreview,
}: {
  file: Attachment;
  localFile?: File;
  downloadable?: boolean;
  uploading?: boolean;
  uploadError?: string;
  onRetry?: () => void;
  onRemove?: () => void;
  onPreview?: () => void;
}) {
  const [preview, setPreview] = useState<string>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const reading = attachmentReading(file.name, file.mime);
  const isImage = reading === "image";
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    let url: string | undefined;
    setPreviewFailed(false);
    const source = localFile
      ? Promise.resolve(localFile)
      : attachmentRequest(file.id).then((response) => response.blob());
    void source
      .then((blob) => {
        if (alive) {
          url = URL.createObjectURL(blob);
          setPreview(url);
        }
      })
      .catch(() => {
        if (alive) setPreviewFailed(true);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, isImage, localFile]);
  const format = file.name.split(".").pop()?.toUpperCase() || "File";
  const size =
    file.size >= 1024 * 1024
      ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(file.size / 1024))} KB`;
  return (
    <AttachmentCard
      name={file.name}
      image={isImage}
      preview={preview}
      onPreviewError={() => {
        setPreview(undefined);
        setPreviewFailed(true);
      }}
      detail={
        previewFailed
          ? "Preview unavailable"
          : `${reading === "reference" ? "Stored reference" : format} · ${size}`
      }
      description={
        reading === "reference"
          ? "Stored reference · not read by assistance"
          : "Included in this message"
      }
      busy={uploading || opening}
      status={uploading ? "Uploading…" : "Opening…"}
      error={uploadError || error}
      onRetry={onRetry}
      onRemove={onRemove}
      openLabel={onPreview ? `Preview ${file.name}` : undefined}
      onOpen={
        !downloadable || uploading || uploadError
          ? undefined
          : onPreview ||
            (async () => {
              setOpening(true);
              setError("");
              try {
                const { downloadBlob } = await import("../library/exportIdea");
                downloadBlob(
                  localFile ||
                    (await (await attachmentRequest(file.id)).blob()),
                  file.name,
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setOpening(false);
              }
            })
      }
    />
  );
}
export function ComposerControls({
  value,
  queueKey,
  children,
  onChange,
  items,
  disabled,
  manual,
  addFiles,
  onUploading,
  composerRef,
  onAdd,
  addOpen,
  openFilePicker,
  onAttachmentSaved,
}: {
  value: ComposerOptions;
  queueKey: string;
  children?: ReactNode;
  onChange: (value: ComposerOptions) => boolean;
  items: Item[];
  disabled: boolean;
  manual: boolean;
  addFiles: MutableRefObject<((files: File[]) => void) | null>;
  onUploading: (busy: boolean) => void;
  composerRef: MutableRefObject<HTMLElement | null>;
  onAdd: () => void;
  addOpen: boolean;
  openFilePicker: MutableRefObject<(() => void) | null>;
  onAttachmentSaved?: (file: Attachment) => Promise<void>;
  agents?: { id: string; name: string }[];
  sources?: { id: string; name: string }[];
}) {
  const ToolIcon = composerToolIcons[value.tool];
  const picker = useRef<HTMLInputElement>(null);
  openFilePicker.current = () => picker.current?.click();
  const localFiles = useRef(new Map<string, File>());
  const fileOrder = useRef<string[]>([]);
  const current = useRef(value);
  current.current = value;
  const [uploads, setUploads] = useState<
    { id: string; file: File; error?: string }[]
  >([]);
  const files = [
    ...value.attachments,
    ...uploads
      .filter(
        (entry) => !value.attachments.some((file) => file.id === entry.id),
      )
      .map((entry) => ({
        id: entry.id,
        name: entry.file.name,
        mime: entry.file.type,
        size: entry.file.size,
      })),
  ];
  // A retry replaces its tile in place, even when other uploads are unfinished.
  fileOrder.current = [
    ...fileOrder.current.filter((id) => files.some((file) => file.id === id)),
    ...files
      .map((file) => file.id)
      .filter((id) => !fileOrder.current.includes(id)),
  ];
  files.sort(
    (a, b) => fileOrder.current.indexOf(a.id) - fileOrder.current.indexOf(b.id),
  );
  useEffect(() => {
    const retained = new Set([
      ...value.attachments.map((file) => file.id),
      ...uploads.map((entry) => entry.id),
    ]);
    for (const id of localFiles.current.keys())
      if (!retained.has(id)) localFiles.current.delete(id);
  }, [value.attachments, uploads]);
  const inflight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { notify } = useToast();
  const [recovering, setRecovering] = useState(true);
  useEffect(() => {
    onUploading(recovering || uploads.length > 0);
  }, [recovering, uploads.length, onUploading]);
  useEffect(() => {
    let active = true;
    void uploadQueue(queueKey)
      .then((entries) => {
        if (active) {
          for (const entry of entries)
            localFiles.current.set(entry.id, entry.file);
          setUploads(
            entries
              .filter(
                (e) => !current.current.attachments.some((a) => a.id === e.id),
              )
              .map((e) => ({
                ...e,
                error:
                  "Upload interrupted. Retry to finish attaching this file.",
              })),
          );
        }
      })
      .catch((e) => {
        if (active)
          notify(e.message, {
            tone: "error",
            id: `upload-recovery:${queueKey}`,
          });
      })
      .finally(() => {
        if (active) setRecovering(false);
      });
    return () => {
      active = false;
    };
  }, [queueKey, notify]);
  async function upload(entry: { id: string; file: File }) {
    if (inflight.current.has(entry.id)) return;
    inflight.current.add(entry.id);
    setUploads((old) => old.map((u) => (u.id === entry.id ? entry : u)));
    try {
      await uploadQueue(queueKey, { put: entry });
      const saved = (await (
        await attachmentRequest(entry.id, entry.file)
      ).json()) as Attachment;
      if (!mounted.current) return;
      if (onAttachmentSaved) await onAttachmentSaved(saved);
      const next = {
        ...current.current,
        attachments: [
          ...current.current.attachments.filter((a) => a.id !== saved.id),
          {
            id: saved.id,
            name: saved.name || entry.file.name,
            mime: saved.mime,
            size: saved.size || entry.file.size,
          },
        ].sort(
          (a, b) =>
            fileOrder.current.indexOf(a.id) - fileOrder.current.indexOf(b.id),
        ),
      };
      if (!onChange(next))
        throw new Error(
          "The file uploaded, but its draft could not be saved. Retry after freeing browser storage.",
        );
      current.current = next;
      await uploadQueue(queueKey, { remove: entry.id });
      setUploads((old) => old.filter((u) => u.id !== entry.id));
    } catch (e) {
      if (mounted.current)
        setUploads((old) =>
          old.map((u) =>
            u.id === entry.id ? { ...entry, error: (e as Error).message } : u,
          ),
        );
    } finally {
      inflight.current.delete(entry.id);
    }
  }
  addFiles.current = (files) => {
    if (disabled) return;
    if (
      files.length +
        current.current.attachments.length +
        current.current.sourceIds.length +
        uploads.length >
      6
    ) {
      notify("Attach up to 6 files per message.", {
        tone: "error",
        id: "attachment-validation",
      });
      return;
    }
    if (files.some((f) => f.size === 0 || f.size > 20 * 1024 * 1024)) {
      notify("Choose non-empty files no larger than 20 MB each.", {
        tone: "error",
        id: "attachment-validation",
      });
      return;
    }
    const entries = files.map((file) => ({ id: crypto.randomUUID(), file }));
    for (const entry of entries) localFiles.current.set(entry.id, entry.file);
    setUploads((old) => [...old, ...entries]);
    // Upload sequentially so each saved preview retains the previous one.
    void (async () => {
      try {
        for (const entry of entries)
          await uploadQueue(queueKey, { put: entry });
        for (const entry of entries) await upload(entry);
      } catch (e) {
        setUploads((old) =>
          old.map((u) =>
            entries.some((entry) => entry.id === u.id)
              ? { ...u, error: (e as Error).message }
              : u,
          ),
        );
      }
    })();
  };
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Attach files"
        onChange={(e) => {
          addFiles.current?.(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      <div className="composer-context">
        {(value.attachments.length > 0 || uploads.length > 0) && (
          <div
            className="composer-attachments"
            role="group"
            aria-label="Message attachments"
          >
            {files.map((file) => {
              const pending = uploads.find((entry) => entry.id === file.id);
              const saved = value.attachments.some(
                (entry) => entry.id === file.id,
              );
              return (
                <ConversationFile
                  key={file.id}
                  file={file}
                  downloadable={false}
                  localFile={localFiles.current.get(file.id)}
                  uploading={!!pending && !pending.error}
                  uploadError={pending?.error}
                  onRetry={
                    pending?.error ? () => void upload(pending) : undefined
                  }
                  onRemove={
                    pending?.error
                      ? () => {
                          void uploadQueue(queueKey, { remove: file.id })
                            .then(() => {
                              setUploads((old) =>
                                old.filter((entry) => entry.id !== file.id),
                              );
                              if (saved)
                                onChange({
                                  ...current.current,
                                  attachments:
                                    current.current.attachments.filter(
                                      (entry) => entry.id !== file.id,
                                    ),
                                });
                              composerRef.current?.focus({
                                preventScroll: true,
                              });
                            })
                            .catch((e) => notify(e.message, { tone: "error" }));
                        }
                      : disabled
                        ? undefined
                        : () => {
                            if (
                              onChange({
                                ...value,
                                attachments: value.attachments.filter(
                                  (entry) => entry.id !== file.id,
                                ),
                              })
                            )
                              composerRef.current?.focus({
                                preventScroll: true,
                              });
                          }
                  }
                />
              );
            })}
          </div>
        )}
        {value.quotes.map((quote, index) => (
          <div className="composer-reference" key={quote.turnId + index}>
            <span>
              “{quote.text.slice(0, 100)}
              {quote.text.length > 100 ? "…" : ""}”
            </span>
            <IconButton
              disabled={disabled}
              aria-label="Remove quoted passage"
              size="icon-xs"
              onClick={() =>
                onChange({
                  ...value,
                  quotes: value.quotes.filter((_, i) => i !== index),
                })
              }
            >
              <X size={14} />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="composer-options">
        <IconButton
          disabled={disabled}
          aria-label="Add files or project context"
          aria-expanded={addOpen}
          aria-haspopup="listbox"
          size="icon"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onAdd}
        >
          <Plus size={18} />
        </IconButton>
        {value.tool !== "discuss" && !manual && (
          <div className="composer-tool">
            <Button
              variant="quiet"
              size="sm"
              className="group gap-1.5 text-muted-foreground"
              disabled={disabled}
              aria-label={`Clear ${planningTools[value.tool].label} tool`}
              title={`${planningTools[value.tool].label} · Click to clear`}
              onClick={() => {
                if (onChange({ ...value, tool: "discuss" }))
                  composerRef.current?.focus({ preventScroll: true });
              }}
            >
              <span className="relative size-4 shrink-0" aria-hidden="true">
                <ToolIcon className="absolute size-4 group-hover:opacity-0 group-focus-visible:opacity-0 [@media(hover:none)]:opacity-0" />
                <X className="absolute size-4 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100" />
              </span>
              {composerToolDetails[value.tool].shortLabel}
            </Button>
          </div>
        )}
        <div className="composer-actions">
          <ReasoningControl
            value={value}
            onChange={onChange}
            disabled={disabled || manual}
          />
          {children}
        </div>
      </div>
    </>
  );
}
