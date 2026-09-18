import { stableJson } from "../../../../packages/domain/src/stableJson";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { FilePanelExtension } from "@blocknote/core/extensions";
import {
  BlockNoteSchema,
  SyntaxHighlightingExtension,
  defaultBlockSpecs,
  createHeadingBlockSpec,
  defaultProps,
  filterSuggestionItems,
} from "@blocknote/core";
import {
  createReactBlockSpec,
  useCreateBlockNote,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "./idea-editor-controls.css";
import { HelpCircle, Download } from "lucide-react";
import {
  ideaFields,
  fieldLabels,
  type IdeaField,
} from "../../../../packages/domain/src/ideaDocument";
import {
  ideaBlocksSchema,
  attachmentScheme,
  type IdeaBlock,
} from "../../../../packages/domain/src/ideaBlocks";
import { attachmentBlob, attachmentRequest } from "./attachments";
import { initialImageWidth } from "./ideaImageSize";
import { Button } from "../ui/Button";
import { Feedback } from "../ui/Toast";
import { reducedMotion } from "../ui/motion";
import "./idea-block-editor.css";
import { IdeaSideMenuController } from "./IdeaBlockMenu";
import { IdeaFormattingToolbar } from "./IdeaFormattingToolbar";
import { IdeaSuggestionMenu } from "./IdeaSuggestionMenu";
import { ideaCodeBlock, codeBlockSelection } from "./ideaCodeBlock";
import { ideaQuestionGroup } from "./ideaQuestionGroup";
import { ideaBlockMotion } from "./ideaBlockMotion";
import {
  IdeaAnswerBlock,
  IdeaBlockFocusContext,
  type IdeaBlockFocus,
} from "./IdeaAnswerBlock";
import {
  ideaAttachmentBlocks,
  IdeaAttachmentControls,
} from "./ideaAttachmentBlocks";

export const IdeaAttachmentTransport = createContext({
  upload: attachmentRequest,
  read: attachmentBlob,
});
const codeHighlighting = SyntaxHighlightingExtension({
  createHighlighter: () =>
    import("./ideaCodeHighlighting").then((module) =>
      module.createCodeHighlighter(),
    ),
});
const answer = createReactBlockSpec(
  {
    type: "ideaAnswer",
    propSchema: {
      ...defaultProps,
      field: { default: "purpose", values: ideaFields },
      prompt: { default: "" },
    },
    content: "inline",
  },
  {
    meta: { hardBreakShortcut: "enter" },
    render: IdeaAnswerBlock,
    toExternalHTML: ({ block, contentRef }) => (
      <section>
        <h3>
          {block.props.prompt || fieldLabels[block.props.field as IdeaField]}
        </h3>
        <div ref={contentRef} />
      </section>
    ),
  },
);
const question = createReactBlockSpec(
  {
    type: "openQuestion",
    propSchema: { ...defaultProps, important: { default: false } },
    content: "inline",
  },
  {
    render: ({ block, contentRef, editor }) => (
      <div className="idea-question-block">
        <span className="idea-block-label" contentEditable={false}>
          <HelpCircle size={15} /> Open question{" "}
          {editor.isEditable && (
            <label>
              <input
                type="checkbox"
                checked={block.props.important}
                onChange={(e) =>
                  editor.updateBlock(block, {
                    props: { important: e.target.checked },
                  })
                }
              />{" "}
              Could change the direction
            </label>
          )}
          {!editor.isEditable && block.props.important && (
            <span>Could change the direction</span>
          )}
        </span>
        <div ref={contentRef} />
      </div>
    ),
  },
);
const reviewAnswer = createReactBlockSpec(
  {
    type: "reviewAnswer",
    propSchema: { ...defaultProps, prompt: { default: "" } },
    content: "inline",
  },
  {
    meta: { hardBreakShortcut: "enter" },
    render: IdeaAnswerBlock,
    toExternalHTML: ({ block, contentRef }) => (
      <section>
        <h3>{block.props.prompt}</h3>
        <div ref={contentRef} />
      </section>
    ),
  },
);
const { audio: _audio, video: _video, ...standard } = defaultBlockSpecs;
const nativeChecklist = defaultBlockSpecs.checkListItem;
const accessibleChecklist = {
  ...nativeChecklist,
  implementation: {
    ...nativeChecklist.implementation,
    render: function (
      this: ThisParameterType<typeof nativeChecklist.implementation.render>,
      ...args: Parameters<typeof nativeChecklist.implementation.render>
    ) {
      const rendered = nativeChecklist.implementation.render.apply(this, args);
      rendered.dom
        .querySelector('input[type="checkbox"]')
        ?.setAttribute("aria-label", "Toggle checklist item");
      return rendered;
    },
  },
};
const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...standard,
    ...ideaAttachmentBlocks,
    codeBlock: ideaCodeBlock,
    checkListItem: accessibleChecklist,
    heading: createHeadingBlockSpec({ levels: [1, 2, 3] }),
    ideaAnswer: answer(),
    reviewAnswer: reviewAnswer(),
    openQuestion: question(),
  },
});
export default function IdeaBlockEditor({
  blocks,
  onChange,
  readOnly = false,
  onBusy,
  onInvalid,
  focusBlock,
}: {
  blocks: IdeaBlock[];
  onChange?: (blocks: IdeaBlock[]) => void;
  readOnly?: boolean;
  onBusy?: (busy: boolean) => void;
  onInvalid?: (invalid: boolean) => void;
  focusBlock?: IdeaBlockFocus;
}) {
  const transport = useContext(IdeaAttachmentTransport);
  const callbacks = useRef({ onChange, onBusy, onInvalid });
  callbacks.current = { onChange, onBusy, onInvalid };
  const urls = useRef(new Map<string, Promise<string>>());
  const pending = useRef(new Map<string, { file: File; id: string }>());
  const active = useRef(0),
    mounted = useRef(true);
  const [error, setError] = useState(""),
    [failed, setFailed] = useState<string[]>([]);
  const [invalid, setInvalid] = useState(false);
  const [fileReadError, setFileReadError] = useState("");
  const [uploadingFiles, setUploadingFiles] = useState(
    new Map<string, string>(),
  );
  const picker = useRef<HTMLInputElement>(null);
  const pickerBlock = useRef<string | undefined>(undefined);
  async function upload(file: File, blockId?: string) {
    const key = blockId || crypto.randomUUID();
    const prior = pending.current.get(key);
    const entry =
      prior?.file === file ? prior : { file, id: crypto.randomUUID() };
    pending.current.set(key, entry);
    setUploadingFiles((previous) => new Map(previous).set(key, file.name));
    active.current++;
    callbacks.current.onBusy?.(true);
    setError("");
    try {
      const result = (await (
        await transport.upload(entry.id, file)
      ).json()) as { id: string; name: string; mime: string };
      const isImage = result.mime.startsWith("image/");
      const previous = blockId ? editor.getBlock(blockId) : undefined;
      const existingWidth =
        previous?.type === "image" && previous.props.url
          ? previous.props.previewWidth
          : undefined;
      const previewWidth = isImage
        ? existingWidth ||
          (await initialImageWidth(
            file,
            container.current?.querySelector(".bn-block")?.clientWidth || 320,
          ))
        : undefined;
      pending.current.delete(key);
      setFailed([...pending.current.keys()]);
      return {
        type: isImage ? "image" : "file",
        props: {
          url: attachmentScheme + result.id,
          name: result.name,
          ...(previewWidth ? { previewWidth } : {}),
        },
      };
    } catch (e) {
      setError((e as Error).message);
      setFailed([...pending.current.keys()]);
      throw e;
    } finally {
      setUploadingFiles((previous) => {
        const next = new Map(previous);
        next.delete(key);
        return next;
      });
      active.current--;
      callbacks.current.onBusy?.(
        active.current > 0 || pending.current.size > 0,
      );
    }
  }
  const editor = useCreateBlockNote(
    {
      schema,
      dropCursor: { width: 2, color: "var(--muted)" },
      extensions: [
        codeHighlighting,
        codeBlockSelection(),
        ideaBlockMotion(),
        ideaQuestionGroup(),
      ],
      domAttributes: {
        editor: {
          "aria-label": "Idea text",
          "aria-readonly": String(readOnly),
        },
      },
      initialContent: blocks as any,
      uploadFile: upload,
      resolveFileUrl: async (url) => {
        if (!url) return "";
        let cached = urls.current.get(url);
        if (!cached) {
          cached = transport
            .read(url)
            .then((blob) => {
              if (!mounted.current) return "";
              return URL.createObjectURL(blob);
            })
            .catch((error) => {
              urls.current.delete(url);
              if (mounted.current) setFileReadError((error as Error).message);
              return "";
            });
          urls.current.set(url, cached);
        }
        return cached;
      },
      placeholders: { default: "Write, type / for blocks, or drop a file…" },
      pasteHandler: ({ event, defaultPasteHandler }) => {
        const html = event.clipboardData?.getData("text/html");
        // Rich text remains supported; media pasted from another website is represented
        // by its text until the user chooses a local file to attach.
        if (
          html &&
          !event.clipboardData?.types.includes("blocknote/html") &&
          /<(?:img|video|audio|iframe)\b/i.test(html) &&
          !event.clipboardData?.files.length
        ) {
          const document = new DOMParser().parseFromString(html, "text/html");
          document
            .querySelectorAll("img,video,audio,iframe")
            .forEach((node) => node.remove());
          editor.pasteHTML(document.body.innerHTML);
          return true;
        }
        return defaultPasteHandler();
      },
    },
    [],
  );
  const container = useRef<HTMLDivElement>(null);
  function chooseFile(blockId: string) {
    const block = editor.getBlock(blockId);
    if (
      readOnly ||
      !block ||
      !["image", "file"].includes(block.type) ||
      uploadingFiles.has(blockId)
    )
      return;
    pickerBlock.current = blockId;
    const input = picker.current!;
    input.accept =
      block.type === "image" ? "image/png,image/jpeg,image/webp,image/gif" : "";
    input.value = "";
    input.click();
  }
  const chooseFileRef = useRef(chooseFile);
  chooseFileRef.current = chooseFile;
  useEffect(() => {
    // Slash-menu insertion uses this public extension. Its
    // synchronous subscription keeps the native picker inside the user gesture.
    const panel = editor.getExtension(FilePanelExtension);
    return panel?.store.subscribe(({ currentVal }) => {
      if (!currentVal) return;
      panel.closeMenu();
      chooseFileRef.current(currentVal);
    });
  }, [editor]);
  function restorePickerFocus(id?: string) {
    if (!id || !mounted.current) return;
    const block = container.current?.querySelector(
      `[data-id="${CSS.escape(id)}"]`,
    );
    const button = block?.querySelector<HTMLButtonElement>(
      ".idea-attachment-choose",
    );
    if (button) button.focus({ preventScroll: true });
    else if (editor.getBlock(id)) {
      editor.setTextCursorPosition(id, "end");
      editor.focus();
    }
  }
  async function picked(file?: File) {
    const id = pickerBlock.current;
    pickerBlock.current = undefined;
    if (!file || !id || !editor.getBlock(id) || readOnly) {
      restorePickerFocus(id);
      return;
    }
    // Return from the native chooser immediately. Finishing an upload must not
    // move the caret after the author has continued writing elsewhere.
    editor.setTextCursorPosition(id, "end");
    editor.focus();
    try {
      const update = await editor.uploadFile!(file, id);
      if (mounted.current && editor.getBlock(id))
        editor.updateBlock(id, update as any);
    } catch {
      // Keep the selected bytes and the existing Retry/Cancel recovery actions.
    }
  }
  useEffect(() => {
    const input = picker.current;
    const cancel = () => {
      const id = pickerBlock.current;
      pickerBlock.current = undefined;
      restorePickerFocus(id);
    };
    input?.addEventListener("cancel", cancel);
    return () => input?.removeEventListener("cancel", cancel);
  }, [editor]);
  useEffect(() => {
    if (readOnly) return;
    let ownsFocus = false;
    const rememberOwner = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (target !== document.body || event.type === "pointerdown")
      )
        ownsFocus = !!container.current?.contains(target);
    };
    const historyShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey)
      )
        return;
      const key = event.key.toLowerCase();
      if (key !== "z" && !(key === "y" && event.ctrlKey && !event.metaKey))
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const inEditor = !!container.current?.contains(target);
      if (!inEditor && !(target === document.body && ownsFocus)) return;
      // ProseMirror already owns its history shortcut. Other editable fields
      // (e.g. link URLs) must retain their native, independent undo history.
      if (
        target.closest("[contenteditable]")?.getAttribute("contenteditable") ===
          "true" ||
        target.closest(
          'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"])',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "y" || event.shiftKey) editor.redo();
      else editor.undo();
      // A removed block can unmount the focused menu/handle, leaving body
      // focused. Restore the editing surface so subsequent typing works too.
      if (target === document.body) editor.focus();
    };
    document.addEventListener("pointerdown", rememberOwner, true);
    document.addEventListener("focusin", rememberOwner, true);
    document.addEventListener("keydown", historyShortcut, true);
    return () => {
      document.removeEventListener("pointerdown", rememberOwner, true);
      document.removeEventListener("focusin", rememberOwner, true);
      document.removeEventListener("keydown", historyShortcut, true);
    };
  }, [editor, readOnly]);
  useEffect(() => {
    // BlockNote 0.54 sets aria-expanded on its textbox after closing the slash
    // menu. Textboxes support aria-controls/activedescendant, not aria-expanded.
    const target = container.current?.querySelector('[role="textbox"]');
    if (!target) return;
    const repair = () => {
      if (target.hasAttribute("aria-expanded"))
        target.removeAttribute("aria-expanded");
    };
    repair();
    const observer = new MutationObserver(repair);
    observer.observe(target, {
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });
    return () => observer.disconnect();
  }, [editor]);
  const last = useRef(stableJson(blocks));
  useEffect(() => {
    const serialized = stableJson(blocks);
    if (serialized !== last.current) {
      last.current = serialized;
      editor.replaceBlocks(editor.document, blocks as any);
    }
  }, [blocks, editor]);
  useEffect(() => {
    if (!focusBlock || readOnly) return;
    const frame = requestAnimationFrame(() => {
      const block = editor.getBlock(focusBlock.id);
      if (block) {
        // An existing answer can have been moved inside a closed toggle.
        let parent = editor.getParentBlock(block);
        while (parent) {
          container.current
            ?.querySelector(`.bn-block[data-id="${CSS.escape(parent.id)}"]`)
            ?.querySelector<HTMLButtonElement>(
              ':scope > .bn-block-content .bn-toggle-wrapper[data-show-children="false"] > .bn-toggle-button',
            )
            ?.click();
          parent = editor.getParentBlock(parent);
        }
        editor.setTextCursorPosition(block, "end");
        editor.focus();
        container.current
          ?.querySelector(`[data-id="${CSS.escape(block.id)}"]`)
          ?.scrollIntoView({
            block: "nearest",
            behavior: reducedMotion() ? "instant" : "smooth",
          });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusBlock, editor, readOnly]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current.size || invalid) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [invalid]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const retired = [...urls.current.values()];
      urls.current.clear();
      for (const url of retired)
        void url
          .then((value) => {
            if (value) URL.revokeObjectURL(value);
          })
          .catch(() => {});
    };
  }, []);
  async function retry(key: string) {
    const entry = pending.current.get(key);
    if (!entry) return;
    try {
      const props = await upload(entry.file, key);
      if (editor.getBlock(key)) editor.updateBlock(key, props as any);
    } catch {}
  }
  function changed() {
    const value = editor.document;
    const parsed = ideaBlocksSchema.safeParse(value);
    if (!parsed.success) {
      setInvalid(true);
      callbacks.current.onInvalid?.(true);
      setError(
        "This document exceeds a supported limit or contains an unsupported block. Undo the last change, or download a recovery copy before leaving.",
      );
      return;
    }
    setInvalid(false);
    callbacks.current.onInvalid?.(false);
    callbacks.current.onBusy?.(pending.current.size > 0);
    if (!pending.current.size) setError("");
    last.current = stableJson(parsed.data);
    callbacks.current.onChange?.(parsed.data);
  }
  return (
    <div
      className="idea-block-editor"
      data-read-only={readOnly}
      ref={container}
    >
      <input
        ref={picker}
        className="idea-attachment-input"
        type="file"
        hidden
        aria-label="Choose attachment"
        onChange={(event) => void picked(event.target.files?.[0])}
      />
      {error && <Feedback tone="error" message={error} />}
      {fileReadError && (
        <div className="idea-upload-recovery">
          <Feedback tone="error" message={fileReadError} />
          <Button
            onClick={() => {
              setFileReadError("");
              editor.replaceBlocks(editor.document, editor.document);
            }}
          >
            Retry loading files
          </Button>
        </div>
      )}
      {!!failed.length && (
        <div className="idea-upload-recovery">
          {failed.map((key) => (
            <div key={key}>
              <span>{pending.current.get(key)?.file.name} · not uploaded</span>
              <Button
                disabled={uploadingFiles.has(key)}
                onClick={() => void retry(key)}
              >
                Retry upload
              </Button>
              <Button
                disabled={uploadingFiles.has(key)}
                onClick={() => {
                  pending.current.delete(key);
                  setFailed([...pending.current.keys()]);
                  callbacks.current.onBusy?.(pending.current.size > 0);
                  if (!pending.current.size) setError("");
                }}
              >
                Cancel upload
              </Button>
            </div>
          ))}
        </div>
      )}
      {invalid && (
        <Button
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(editor.document, null, 2)], {
                type: "application/json",
              }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = "idea-recovery.json";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download size={14} /> Download recovery copy
        </Button>
      )}
      <IdeaBlockFocusContext.Provider value={focusBlock}>
        <IdeaAttachmentControls.Provider
          value={{ choose: chooseFile, uploading: uploadingFiles }}
        >
          <BlockNoteView
            editor={editor}
            editable={!readOnly}
            theme="light"
            onChange={changed}
            slashMenu={false}
            filePanel={false}
            sideMenu={false}
            formattingToolbar={false}
          >
            <SuggestionMenuController
              triggerCharacter="/"
              suggestionMenuComponent={IdeaSuggestionMenu}
              getItems={async (query) =>
                filterSuggestionItems(
                  [
                    ...getDefaultReactSlashMenuItems(editor),
                    {
                      title: "Open question",
                      subtext: "Keep a question in the idea",
                      group: "Ideas",
                      aliases: ["question", "wondering"],
                      icon: <HelpCircle size={18} />,
                      onItemClick: () => {
                        const added = editor.insertBlocks(
                          [{ type: "openQuestion", id: crypto.randomUUID() }],
                          editor.getTextCursorPosition().block,
                          "after",
                        );
                        editor.setTextCursorPosition(added[0]);
                        editor.focus();
                      },
                    },
                  ].map((item) => ({ ...item, size: "small" as const })),
                  query,
                )
              }
            />
            <IdeaSideMenuController />
            <IdeaFormattingToolbar />
          </BlockNoteView>
        </IdeaAttachmentControls.Provider>
      </IdeaBlockFocusContext.Provider>
    </div>
  );
}
