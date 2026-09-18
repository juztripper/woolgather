import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { defaultBlockSpecs, type BlockNoteEditor } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { Image, Paperclip, LoaderCircle } from "lucide-react";
import { Button } from "../ui/Button";
import { imagePreviewBounds } from "./ideaImageSize";

export const IdeaAttachmentControls = createContext({
  choose: (_blockId: string) => {},
  uploading: new Map<string, string>(),
});

type AttachmentProps = {
  block: {
    id: string;
    type: "image" | "file";
    props: {
      url: string;
      name: string;
      caption: string;
      showPreview?: boolean;
      textAlignment?: string;
      previewWidth?: number;
    };
  };
  editor: BlockNoteEditor<any, any, any>;
};

// Files keep the native preview. Images stay mounted while their size, caption
// or alignment changes, so a document edit never restarts image decoding.
function ImagePreview({ block, editor }: AttachmentProps) {
  const [src, setSrc] = useState("");
  const wrapper = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);
  const gripSides =
    block.props.textAlignment === "center"
      ? (["left", "right"] as const)
      : ([block.props.textAlignment === "right" ? "left" : "right"] as const);
  const gesture = useRef<
    | {
        x: number;
        width: number;
        next: number;
        direction: number;
        max: number;
        pointerId: number;
      }
    | undefined
  >(undefined);
  const width = block.props.previewWidth || imagePreviewBounds.width;
  useEffect(() => {
    let current = true;
    setSrc("");
    void Promise.resolve(
      editor.resolveFileUrl
        ? editor.resolveFileUrl(block.props.url)
        : block.props.url,
    ).then((url) => {
      if (current) setSrc(url);
    });
    return () => {
      current = false;
    };
  }, [editor, block.props.url]);
  const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = undefined;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel || !editor.isEditable) {
      wrapper.current!.style.width = `${width}px`;
    } else if (drag.next !== width) {
      editor.updateBlock(block.id, { props: { previewWidth: drag.next } });
    }
  };
  return (
    <figure
      className="bn-file-block-content-wrapper"
      ref={wrapper}
      data-resizing={resizing || undefined}
      style={{ width }}
    >
      <div className="bn-visual-media-wrapper">
        <img
          className="bn-visual-media"
          src={src || undefined}
          alt={block.props.name || ""}
          draggable={false}
        />
        {editor.isEditable &&
          gripSides.map((side) => (
            <Button
              variant="quiet"
              key={side}
              type="button"
              className="idea-image-resize-grip h-[44px] min-h-0 w-[24px] [@media(pointer:coarse)]:w-[44px] rounded-none border-0 bg-transparent p-0 shadow-none hover:bg-transparent active:scale-100"
              data-side={side}
              aria-label={`Resize image from ${side}`}
              title="Drag to resize"
              onKeyDown={(event) => {
                if (event.key === "Escape" && gesture.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  const pointerId = gesture.current.pointerId;
                  if (event.currentTarget.hasPointerCapture(pointerId))
                    event.currentTarget.releasePointerCapture(pointerId);
                  gesture.current = undefined;
                  setResizing(false);
                  wrapper.current!.style.width = `${width}px`;
                } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  const available =
                    wrapper.current!.closest(".bn-block")?.clientWidth ||
                    imagePreviewBounds.width;
                  editor.updateBlock(block.id, {
                    props: {
                      previewWidth: Math.max(
                        32,
                        Math.min(
                          available,
                          width +
                            (event.key === "ArrowRight" ? 1 : -1) *
                              (event.shiftKey ? 10 : 1),
                        ),
                      ),
                    },
                  });
                }
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.focus({ preventScroll: true });
                setResizing(true);
                const element = wrapper.current!;
                const start = element.getBoundingClientRect().width;
                gesture.current = {
                  x: event.clientX,
                  width: start,
                  next: start,
                  direction:
                    (side === "left" ? -1 : 1) *
                    (block.props.textAlignment === "center" ? 2 : 1),
                  pointerId: event.pointerId,
                  max:
                    element.closest(".bn-block")?.clientWidth ||
                    imagePreviewBounds.width,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = gesture.current;
                if (!drag) return;
                drag.next = Math.round(
                  Math.max(
                    32,
                    Math.min(
                      drag.max,
                      drag.width + (event.clientX - drag.x) * drag.direction,
                    ),
                  ),
                );
                wrapper.current!.style.width = `${drag.next}px`;
              }}
              onPointerUp={(event) => finish(event)}
              onPointerCancel={(event) => finish(event, true)}
              onLostPointerCapture={(event) => finish(event, true)}
            >
              <span aria-hidden="true" />
            </Button>
          ))}
      </div>
      {block.props.caption && (
        <figcaption className="bn-file-caption">
          {block.props.caption}
        </figcaption>
      )}
    </figure>
  );
}

function AttachmentPreview({ block, editor }: AttachmentProps) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const native = defaultBlockSpecs[block.type];
    const rendered = native.implementation.render.call(
      { renderType: "dom", blockContentDOMAttributes: {} } as any,
      block as any,
      editor,
    );
    const container = host.current!;
    container.appendChild(rendered.dom);
    return () => {
      rendered.destroy?.();
      container.replaceChildren();
    };
  }, [block, editor]);
  return <div className="idea-attachment-preview" ref={host} />;
}

function AttachmentBlock(props: AttachmentProps) {
  const controls = useContext(IdeaAttachmentControls);
  const filename = controls.uploading.get(props.block.id);
  const isImage = props.block.type === "image";
  return (
    <div
      className="idea-attachment"
      contentEditable={false}
      onMouseDown={(event) => {
        if (
          !props.editor.isEditable ||
          !props.block.props.url ||
          event.button !== 0 ||
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey
        )
          return;
        const target = event.target as Element;
        if (target.closest("button, input, a")) return;
        event.preventDefault();
        event.stopPropagation();
        const editor = props.editor;
        if (target.closest(".bn-file-block-content-wrapper")) {
          editor.setTextCursorPosition(props.block.id, "end");
        } else {
          // The full-width block gutter is writing space, not part of the
          // image hit target. Reuse adjacent text, or make a place to write.
          const rect = event.currentTarget.getBoundingClientRect();
          const before = event.clientY < rect.top + rect.height / 2;
          const adjacent = before
            ? editor.getPrevBlock(props.block.id)
            : editor.getNextBlock(props.block.id);
          const destination =
            adjacent &&
            editor.schema.blockSchema[adjacent.type].content === "inline"
              ? adjacent
              : editor.insertBlocks(
                  [{ type: "paragraph" }],
                  props.block.id,
                  before ? "before" : "after",
                )[0];
          editor.setTextCursorPosition(
            destination.id,
            before ? "end" : "start",
          );
        }
        editor.focus();
      }}
    >
      {props.block.props.url ? (
        isImage && props.block.props.showPreview ? (
          <div className="idea-attachment-preview">
            <ImagePreview {...props} />
          </div>
        ) : (
          <AttachmentPreview {...props} />
        )
      ) : (
        <div className="idea-attachment-empty">
          <Button
            className="idea-attachment-choose"
            disabled={!props.editor.isEditable || !!filename}
            onClick={() => controls.choose(props.block.id)}
          >
            {isImage ? <Image size={16} /> : <Paperclip size={16} />}
            {isImage ? "Add image" : "Add file"}
          </Button>
          {!filename && <span className="idea-field-hint">Up to 20 MB</span>}
        </div>
      )}
      {filename && (
        <div className="idea-attachment-progress" role="status">
          <LoaderCircle size={14} aria-hidden="true" />
          <span>Uploading {filename}…</span>
        </div>
      )}
    </div>
  );
}

const image = createReactBlockSpec(defaultBlockSpecs.image.config, {
  meta: defaultBlockSpecs.image.implementation.meta,
  render: AttachmentBlock,
})();
const file = createReactBlockSpec(defaultBlockSpecs.file.config, {
  meta: defaultBlockSpecs.file.implementation.meta,
  render: AttachmentBlock,
})();
// Parsing and export retain their original formats; only interactive rendering changes.
image.implementation.parse = defaultBlockSpecs.image.implementation.parse;
image.implementation.toExternalHTML =
  defaultBlockSpecs.image.implementation.toExternalHTML;
file.implementation.parse = defaultBlockSpecs.file.implementation.parse;
file.implementation.toExternalHTML =
  defaultBlockSpecs.file.implementation.toExternalHTML;
export const ideaAttachmentBlocks = { image, file };
