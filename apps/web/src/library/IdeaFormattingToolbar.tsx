import { useContext, useMemo } from "react";
import { Replace } from "lucide-react";
import { IdeaAttachmentControls } from "./ideaAttachmentBlocks";
import { Select } from "../ui/Select";
import { imagePreviewBounds } from "./ideaImageSize";
import { posToDOMRect } from "@tiptap/core";
import { offset, shift, flip } from "@floating-ui/react";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import {
  FormattingToolbar,
  GenericPopover,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
  useExtension,
  useExtensionState,
  type GenericPopoverReference,
} from "@blocknote/react";

function ImageSizeControl() {
  const editor = useBlockNoteEditor<any, any, any>();
  const block = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor.isEditable) return undefined;
      const selected = editor.getSelection()?.blocks || [
        editor.getTextCursorPosition().block,
      ];
      const image = selected.length === 1 ? selected[0] : undefined;
      return image?.type === "image" &&
        image.props.url &&
        image.props.showPreview
        ? image
        : undefined;
    },
  });
  if (!block) return null;
  const width = Math.round(
    block.props.previewWidth || imagePreviewBounds.width,
  );
  const options = [
    { value: "160", label: "Small" },
    { value: "320", label: "Medium" },
    { value: "480", label: "Large" },
    { value: "fit", label: "Fit document" },
  ];
  if (![160, 320, 480].includes(width))
    options.unshift({ value: String(width), label: `${width} px` });
  return (
    <div className="idea-image-size">
      <span>Size</span>
      <Select
        label="Image size"
        value={String(width)}
        options={options}
        onValueChange={(value) => {
          const available =
            editor.domElement?.querySelector(
              `.bn-block[data-id="${CSS.escape(block.id)}"]`,
            )?.clientWidth || imagePreviewBounds.width;
          editor.updateBlock(block.id, {
            props: {
              previewWidth: Math.max(
                32,
                Math.floor(
                  Math.min(
                    value === "fit" ? available : Number(value),
                    available,
                  ),
                ),
              ),
            },
          });
        }}
      />
    </div>
  );
}

function ReplaceAttachmentButton() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const controls = useContext(IdeaAttachmentControls);
  const block = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor.isEditable) return undefined;
      const selected = editor.getSelection()?.blocks || [
        editor.getTextCursorPosition().block,
      ];
      return selected.length === 1 &&
        ["image", "file"].includes(selected[0].type)
        ? selected[0]
        : undefined;
    },
  });
  if (!block) return null;
  const label = block.type === "image" ? "Replace image" : "Replace file";
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      mainTooltip={label}
      label={label}
      icon={<Replace size={16} />}
      isDisabled={controls.uploading.has(block.id)}
      onClick={() => controls.choose(block.id)}
    />
  );
}

export function IdeaFormattingToolbar() {
  const editor = useBlockNoteEditor();
  const toolbar = useExtension(FormattingToolbarExtension, { editor });
  const show = useExtensionState(FormattingToolbarExtension, { editor });
  const selection = useEditorState({
    editor,
    selector: ({ editor }) => {
      const selected = editor.getSelection()?.blocks || [
        editor.getTextCursorPosition().block,
      ];
      const block = selected.length === 1 ? selected[0] : undefined;
      return {
        from: editor.prosemirrorState.selection.from,
        to: editor.prosemirrorState.selection.to,
        mediaId:
          block && ["image", "file"].includes(block.type)
            ? block.id
            : undefined,
        alignment:
          block && ["image", "file"].includes(block.type)
            ? block.props.textAlignment
            : undefined,
      };
    },
  });
  const reference = useMemo<GenericPopoverReference | undefined>(() => {
    if (!show) return undefined;
    const surface = editor.prosemirrorView.dom;
    if (selection.mediaId) {
      const media = surface.querySelector(
        `.bn-block[data-id="${CSS.escape(selection.mediaId)}"] .bn-file-block-content-wrapper`,
      );
      if (media) return { element: media };
    }
    let anchor: DOMRect | undefined;
    let surfaceAtAnchor: DOMRect | undefined;
    return {
      element: surface.firstElementChild || surface,
      getBoundingClientRect: () => {
        const currentSurface = surface.getBoundingClientRect();
        // Freeze the selection's geometry until the selection changes. Alignment
        // moves glyphs, but must not move the control being clicked. Re-anchor
        // on resize; follow the surface's movement during scrolling/layout shifts.
        if (
          !anchor ||
          !surfaceAtAnchor ||
          currentSurface.width !== surfaceAtAnchor.width
        ) {
          anchor = posToDOMRect(
            editor.prosemirrorView,
            selection.from,
            selection.to,
          );
          surfaceAtAnchor = currentSurface;
        }
        return new DOMRect(
          anchor.x + currentSurface.x - surfaceAtAnchor.x,
          anchor.y + currentSurface.y - surfaceAtAnchor.y,
          anchor.width,
          anchor.height,
        );
      },
    };
  }, [
    editor,
    show,
    selection.from,
    selection.to,
    selection.mediaId,
    selection.alignment,
  ]);
  const controls = useMemo(
    () =>
      getFormattingToolbarItems()
        .filter((item) => item.key !== "blockTypeSelect")
        .map((item) =>
          item.key === "replaceFileButton" ? (
            <ReplaceAttachmentButton key="replaceFileButton" />
          ) : item.key === "fileDeleteButton" ? (
            <span key="fileDeleteButton" className="idea-attachment-delete">
              {item}
            </span>
          ) : (
            item
          ),
        ),
    [],
  );
  return (
    <GenericPopover
      reference={reference}
      useFloatingOptions={{
        open: show,
        placement: selection.mediaId
          ? selection.alignment === "right"
            ? "top-end"
            : selection.alignment === "center"
              ? "top"
              : "top-start"
          : "top-start",
        middleware: [offset(10), shift({ padding: 8 }), flip({ padding: 8 })],
        onOpenChange: (open, _event, reason) => {
          toolbar.store.setState(open);
          if (reason === "escape-key") editor.focus();
        },
      }}
      focusManagerProps={{ disabled: true }}
      useTransitionStylesProps={{ duration: 0 }}
      useTransitionStatusProps={{ duration: 0 }}
      elementProps={{ style: { zIndex: 40 } }}
    >
      {show && (
        <FormattingToolbar>
          <ImageSizeControl />
          {controls}
        </FormattingToolbar>
      )}
    </GenericPopover>
  );
}
