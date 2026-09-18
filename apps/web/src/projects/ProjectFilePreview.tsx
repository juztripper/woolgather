import { lazy, Suspense, useEffect, useState } from "react";
import { Download, FileText, LoaderCircle, Plus } from "lucide-react";
import {
  attachmentReading,
  type ComposerOptions,
} from "../../../../packages/domain/src/planningComposer";
import { attachmentRequest } from "../library/attachments";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import "./project-file-preview.css";

const ProjectPdfPreview = lazy(() =>
  import("./ProjectPdfPreview").then(({ ProjectPdfPreview: preview }) => ({
    default: preview,
  })),
);

export type ProjectPreviewFile = ComposerOptions["attachments"][number];

export function ProjectFilePreview({
  file,
  onClose,
  onUse,
}: {
  file: ProjectPreviewFile;
  onClose: () => void;
  onUse?: () => void;
}) {
  const { notify } = useToast();
  const [content, setContent] = useState<{
    url?: string;
    text?: string;
    truncated?: boolean;
    blob: Blob;
  }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const reading = attachmentReading(file.name, file.mime);
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    setContent(undefined);
    setError("");
    void attachmentRequest(file.id)
      .then((response) => response.blob())
      .then(async (blob) => {
        let text: string | undefined;
        if (reading === "text") text = await blob.slice(0, 100_000).text();
        else if (reading === "image")
          url = URL.createObjectURL(
            new Blob([blob], {
              type: file.mime,
            }),
          );
        if (active)
          setContent({
            blob,
            text,
            url,
            truncated: reading === "text" && blob.size > 100_000,
          });
        else if (url) URL.revokeObjectURL(url);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not open this file.",
          );
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, file.mime, reading, attempt]);
  return (
    <Modal
      title={file.name}
      wide
      onClose={onClose}
      className={`project-file-preview${reading === "pdf" ? "" : " project-file-preview-compact"}`}
      footer={
        <>
          <Button
            disabled={!content}
            onClick={async () => {
              if (!content) return;
              try {
                const { downloadBlob } = await import("../library/exportIdea");
                downloadBlob(content.blob, file.name);
              } catch {
                notify("Could not download this file.", { tone: "error" });
              }
            }}
          >
            <Download /> Download
          </Button>
          {onUse && (
            <Button variant="primary" onClick={onUse}>
              <Plus /> Use in conversation
            </Button>
          )}
        </>
      }
    >
      {!content && !error && (
        <div className="project-file-preview-status" role="status">
          <LoaderCircle className="refresh-icon-spinning" /> Opening file…
        </div>
      )}
      {error && (
        <div className="project-file-preview-status">
          <p role="alert">{error}</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      )}
      {content &&
        (reading === "image" && content.url ? (
          <img
            src={content.url}
            alt={file.name}
            className="project-file-preview-image"
          />
        ) : reading === "pdf" ? (
          <Suspense
            fallback={
              <div className="project-file-preview-status" role="status">
                <LoaderCircle className="refresh-icon-spinning" />
                <p>Loading PDF preview…</p>
              </div>
            }
          >
            <ProjectPdfPreview blob={content.blob} fileName={file.name} />
          </Suspense>
        ) : content.text !== undefined ? (
          <div className="project-file-preview-text">
            <pre>{content.text}</pre>
            {content.truncated && (
              <p>
                Showing the first 100 KB. Download the file to read it in full.
              </p>
            )}
          </div>
        ) : (
          <div className="project-file-preview-status">
            <FileText />
            <p>This file is saved in your project.</p>
            <p>Download it to open in its app.</p>
          </div>
        ))}
    </Modal>
  );
}
