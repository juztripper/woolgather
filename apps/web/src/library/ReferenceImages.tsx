import { Input } from "@/components/ui/input";
import { ModalPresence } from "@/ui/Modal";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Maximize2, X, Download } from "lucide-react";
import type { ImageReference } from "../../../../packages/domain/src/ideaDocument";
import { api } from "../client";
import { Button, IconButton } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Feedback } from "../ui/Toast";
import "./idea-document.css";

async function referenceCopy(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error(
      "Choose a PNG, JPEG, or WebP image. You can upload a photo of a sketch too.",
    );
  if (file.size > 12 * 1024 * 1024)
    throw new Error("Choose an image smaller than 12 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 60000000
    )
      throw new Error(
        "This image is too large to prepare. Choose a smaller copy.",
      );
    // Reference copies retain transparency, strip embedded metadata, and are
    // bounded before uploading. The file on the user's device is untouched.
    const canvas = document.createElement("canvas");
    let size = Math.min(
      1,
      1600 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * size));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * size));
      const ctx = canvas.getContext("2d");
      if (!ctx)
        throw new Error("Unable to prepare this image in your browser.");
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/webp", 0.86 - attempt * 0.07);
      if (data.length <= 440000) return data;
      size *= 0.78;
    }
    throw new Error(
      "This image could not be made small enough. Try a smaller copy.",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ReferenceCard({
  reference,
  readOnly,
  disabled,
  onChange,
  onRemove,
}: {
  reference: ImageReference;
  readOnly: boolean;
  disabled: boolean;
  onChange: (caption: string) => void;
  onRemove: () => void;
}) {
  const [data, setData] = useState(""),
    [error, setError] = useState(""),
    [view, setView] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void api<{ dataUrl: string }>(`/images/${reference.id}`)
      .then((image) => {
        if (active) setData(image.dataUrl);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [reference.id, attempt]);
  return (
    <figure className="idea-reference">
      <div className="idea-reference-image">
        {data ? (
          <Button
            variant="surface"
            aria-label={`View ${reference.name}`}
            onClick={() => setView(true)}
          >
            <img src={data} alt={reference.caption || reference.name} />
            <Maximize2 size={14} aria-hidden="true" />
          </Button>
        ) : error ? (
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Retry image
          </Button>
        ) : (
          <span role="status">Loading image…</span>
        )}
        {!readOnly && (
          <IconButton
            className="idea-reference-remove"
            aria-label={`Remove ${reference.name}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <X size={14} />
          </IconButton>
        )}
      </div>
      <figcaption>
        <span className="idea-reference-name" title={reference.name}>
          {reference.name}
        </span>
        {readOnly ? (
          reference.caption && <p>{reference.caption}</p>
        ) : (
          <Input
            aria-label={`Caption for ${reference.name}`}
            placeholder="What does this show?"
            value={reference.caption}
            maxLength={1000}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </figcaption>
      <ModalPresence>
        {view && (
          <Modal
            title={reference.name}
            wide
            className="reference-viewer"
            onClose={() => setView(false)}
            footer={
              <>
                <Button
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = data;
                    a.download =
                      reference.name.replace(/\.[^.]+$/, "") +
                      (data.startsWith("data:image/webp")
                        ? ".webp"
                        : data.startsWith("data:image/png")
                          ? ".png"
                          : ".jpg");
                    a.click();
                  }}
                >
                  <Download size={14} /> Download reference
                </Button>
                <Button variant="primary" onClick={() => setView(false)}>
                  Done
                </Button>
              </>
            }
          >
            <img src={data} alt={reference.caption || reference.name} />
            {reference.caption && <p>{reference.caption}</p>}
          </Modal>
        )}
      </ModalPresence>
    </figure>
  );
}

export function ReferenceImages({
  references,
  onChange,
  readOnly = false,
  disabled = false,
  onBusy,
}: {
  references: ImageReference[];
  onChange?: (references: ImageReference[]) => void;
  readOnly?: boolean;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const current = useRef(references);
  current.current = references;
  const changed = useRef(onChange);
  changed.current = onChange;
  const [uploading, setUploading] = useState(false),
    [error, setError] = useState("");
  async function add(files: File[]) {
    if (uploading || disabled || readOnly) return;
    if (files.length + current.current.length > 8) {
      setError("You can keep up to eight reference images here.");
      return;
    }
    setUploading(true);
    onBusy?.(true);
    setError("");
    try {
      for (const file of files) {
        const dataUrl = await referenceCopy(file);
        const id = crypto.randomUUID();
        await api("/images", { id, dataUrl });
        const next = [
          ...current.current,
          {
            id,
            name: file.name.slice(0, 180) || "Reference image",
            caption: "",
          },
        ];
        current.current = next;
        changed.current?.(next);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      onBusy?.(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  return (
    <div className="idea-references">
      {error && <Feedback tone="error" message={error} />}
      {!!references.length && (
        <div className="idea-reference-grid">
          {references.map((reference) => (
            <ReferenceCard
              key={reference.id}
              reference={reference}
              readOnly={readOnly}
              disabled={disabled || uploading}
              onChange={(caption) =>
                onChange?.(
                  current.current.map((r) =>
                    r.id === reference.id ? { ...r, caption } : r,
                  ),
                )
              }
              onRemove={() =>
                onChange?.(current.current.filter((r) => r.id !== reference.id))
              }
            />
          ))}
        </div>
      )}
      {!readOnly && (
        <>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(e) => void add(Array.from(e.target.files || []))}
          />
          <Button
            disabled={disabled || uploading || references.length >= 8}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus size={16} />
            {uploading ? "Adding image…" : "Add images or sketches"}
          </Button>
          <p className="idea-field-hint">
            PNG, JPEG, or WebP · Up to 8 images. Saved as optimized reference
            copies.
          </p>
        </>
      )}
    </div>
  );
}
