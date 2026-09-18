import { useEffect, useId, useRef, useState } from "react";
import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { Button } from "../ui/Button";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_RENDER_SCALE = 2.5;
const MAX_RENDER_PIXELS = 12_000_000;

function previewError(cause: unknown) {
  if (cause instanceof Error && /password/i.test(cause.message))
    return "This PDF is password-protected. Download it to open it in your PDF app.";
  return "This PDF could not be previewed. You can download the original file.";
}

function isRenderCancellation(cause: unknown) {
  return (
    cause instanceof Error &&
    /cancelled|canceled|RenderingCancelledException/i.test(
      cause.name || cause.message,
    )
  );
}

export function ProjectPdfPreview({
  blob,
  fileName,
}: {
  blob: Blob;
  fileName: string;
}) {
  const descriptionId = useId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(
    null,
  );
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [pageText, setPageText] = useState("");

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setContainerWidth(Math.round(stage.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let loadedDocument: PDFDocumentProxy | undefined;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    setLoading(true);
    setLoadError("");
    setRenderError("");
    setDocumentProxy(null);
    setPageCount(0);
    setPageNumber(1);

    void (async () => {
      try {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (disposed) return;
        loadingTask = getDocument({
          data,
          stopAtErrors: true,
          enableXfa: false,
          useWorkerFetch: false,
          disableAutoFetch: true,
          disableStream: true,
        });
        loadedDocument = await loadingTask.promise;
        if (disposed) {
          await loadingTask.destroy();
          return;
        }
        setDocumentProxy(loadedDocument);
        setPageCount(loadedDocument.numPages);
        setLoading(false);
      } catch (cause) {
        if (disposed) return;
        setLoading(false);
        setLoadError(previewError(cause));
      }
    })();

    return () => {
      disposed = true;
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [blob, loadAttempt]);

  useEffect(() => {
    if (!documentProxy || pageCount === 0) return;
    let disposed = false;
    let renderTask: RenderTask | undefined;
    let page: PDFPageProxy | undefined;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRendering(true);
    setRenderError("");
    setPageText("");

    void (async () => {
      try {
        page = await documentProxy.getPage(pageNumber);
        if (disposed) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const width = containerWidth || stageRef.current?.clientWidth || 0;
        const availableWidth = Math.max(1, width - 24);
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const maxAreaScale = Math.sqrt(
          MAX_RENDER_PIXELS /
            Math.max(
              1,
              baseViewport.width * baseViewport.height * outputScale ** 2,
            ),
        );
        const scale = Math.min(
          MAX_RENDER_SCALE,
          Math.max(0.01, availableWidth / baseViewport.width),
          maxAreaScale,
        );
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas rendering is unavailable.");
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          annotationMode: AnnotationMode.DISABLE,
          background: "white",
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        if (disposed) return;
        setRendering(false);
        const text = await page.getTextContent().catch(() => null);
        if (!disposed && text)
          setPageText(
            text.items
              .map((item) => ("str" in item ? item.str : ""))
              .join(" ")
              .slice(0, 60_000),
          );
      } catch (cause) {
        if (disposed || isRenderCancellation(cause)) return;
        setRendering(false);
        setRenderError(previewError(cause));
      } finally {
        page?.cleanup();
      }
    })();

    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  }, [containerWidth, documentProxy, pageCount, pageNumber, renderAttempt]);

  const pageLabel = documentProxy
    ? `Page ${pageNumber} of ${pageCount}`
    : "PDF preview";

  return (
    <section
      className="project-file-preview-pdf"
      aria-label={`PDF preview of ${fileName}`}
    >
      <div ref={stageRef} className="project-file-preview-pdf-stage">
        <canvas
          ref={canvasRef}
          className="project-file-preview-pdf-canvas"
          role="img"
          aria-label={`${fileName}, ${pageLabel}`}
          aria-describedby={descriptionId}
        />
        {loading && (
          <div className="project-file-preview-status" role="status">
            <LoaderCircle className="refresh-icon-spinning" />
            <p>Opening PDF preview…</p>
          </div>
        )}
        {loadError && (
          <div className="project-file-preview-status" role="alert">
            <p>{loadError}</p>
            <Button
              size="sm"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          </div>
        )}
        {rendering && !loading && !renderError && (
          <div className="project-file-preview-pdf-rendering" role="status">
            Rendering page…
          </div>
        )}
        {renderError && (
          <div className="project-file-preview-status" role="alert">
            <p>{renderError}</p>
            <Button
              size="sm"
              onClick={() => setRenderAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          </div>
        )}
      </div>
      {documentProxy && pageCount > 0 && !loadError && (
        <nav
          className="project-file-preview-pdf-controls"
          aria-label="PDF pages"
        >
          <Button
            size="icon-sm"
            variant="quiet"
            disabled={pageNumber <= 1 || rendering}
            onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
            aria-label="Previous PDF page"
            title="Previous page"
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span aria-live="polite">{pageLabel}</span>
          <Button
            size="icon-sm"
            variant="quiet"
            disabled={pageNumber >= pageCount || rendering}
            onClick={() =>
              setPageNumber((value) => Math.min(pageCount, value + 1))
            }
            aria-label="Next PDF page"
            title="Next page"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </nav>
      )}
      <p id={descriptionId} className="sr-only">
        {pageText ||
          "Use the page controls to browse this document, or download the original file."}
      </p>
    </section>
  );
}
