import { FileText, ImageIcon, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useId } from "react";
import { Button, IconButton } from "@/ui/Button";
import { cn } from "@/lib/utils";
import "./attachment-card.css";

/** A stable preview tile; storage and transfer state belong to its caller. */
export function AttachmentCard({
  name,
  detail,
  description,
  image,
  preview,
  busy,
  status,
  error,
  onOpen,
  onRemove,
  onRetry,
  onPreviewError,
  openLabel,
}: {
  name: string;
  detail: string;
  description: string;
  image: boolean;
  preview?: string;
  busy?: boolean;
  status?: string;
  error?: string;
  onOpen?: () => void;
  onRemove?: () => void;
  onRetry?: () => void;
  onPreviewError?: () => void;
  openLabel?: string;
}) {
  const descriptionId = useId();
  const content = (
    <>
      {preview ? (
        <img
          className="attachment-card-image"
          src={preview}
          alt=""
          onError={onPreviewError}
        />
      ) : (
        <span className="attachment-card-art" aria-hidden="true">
          {image ? (
            <ImageIcon className="size-7" />
          ) : (
            <FileText className="size-7" />
          )}
        </span>
      )}
      <span className="attachment-card-caption">
        <span className="attachment-card-name">{name}</span>
        {!preview && <span className="attachment-card-detail">{detail}</span>}
      </span>
    </>
  );
  return (
    <div
      className={cn("attachment-card", image && "attachment-card--image")}
      role="group"
      aria-label={name}
      aria-describedby={descriptionId}
    >
      <div
        className="attachment-card-tile"
        data-error={error ? "" : undefined}
        data-pending={busy || onRetry ? "" : undefined}
      >
        <Button
          variant="surface"
          className="attachment-card-open h-full w-full border-0 font-normal text-[length:var(--text-menu)] leading-5 disabled:opacity-100"
          aria-label={onOpen ? openLabel || `Download ${name}` : name}
          title={`${name} · ${detail} · ${description}`}
          aria-describedby={descriptionId}
          onClick={onOpen}
          disabled={!onOpen || busy}
        >
          {content}
        </Button>
        {(busy || onRetry) && (
          <div className="attachment-card-state">
            {onRetry ? (
              <Button
                size="xs"
                aria-label={`Retry upload ${name}`}
                onClick={onRetry}
              >
                <RotateCcw /> Retry
              </Button>
            ) : (
              <span role="status">
                <LoaderCircle className="size-4 refresh-icon-spinning" />
                {status}
              </span>
            )}
          </div>
        )}
        {onRemove && (
          <IconButton
            size="icon-xs"
            className="attachment-card-remove border-border bg-background transition-[opacity,background-color]"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
            title={`Remove ${name}`}
          >
            <X />
          </IconButton>
        )}
      </div>
      <span
        id={descriptionId}
        className={error ? "attachment-card-error" : "sr-only"}
        role={error ? "alert" : undefined}
      >
        {error || `${detail} · ${description}`}
      </span>
    </div>
  );
}
