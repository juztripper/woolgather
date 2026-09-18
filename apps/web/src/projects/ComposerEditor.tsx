import {
  useLayoutEffect,
  useRef,
  useState,
  type AriaAttributes,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { EditorState, Plugin, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { history, undo, redo, closeHistory } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { baseKeymap } from "@tiptap/pm/commands";
import { Slice } from "@tiptap/pm/model";
import {
  composerSchema,
  inlineDocument,
  inlineText,
  inlineIds,
  plainContent,
  positionAtOffset,
  offsetAtPosition,
} from "./inlineComposerDocument";
import {
  ConversationReferenceLink,
  type ConversationReference,
} from "./ConversationContextText";
import { readDraft, storeDraft } from "./model";

export type ComposerEditorElement = HTMLDivElement & {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  removeReference: (id: string) => void;
  hasReference: (start: number, end: number) => boolean;
  setSelectionRange: (start: number, end: number) => void;
  insertReference: (
    start: number,
    end: number,
    reference: { id: string; label: string; kind: string },
  ) => void;
};
export type ComposerEditorInput = {
  currentTarget: ComposerEditorElement;
  nativeEvent: InputEvent;
};
export type ComposerEditorKey = {
  currentTarget: ComposerEditorElement;
  nativeEvent: KeyboardEvent;
  key: string;
  shiftKey: boolean;
  readonly defaultPrevented: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};
export type ComposerEditorEvents = AriaAttributes & {
  onChange?: (event: ComposerEditorInput) => void;
  onSelect?: (event: { currentTarget: ComposerEditorElement }) => void;
  onCompositionStart?: (event: CompositionEvent) => void;
  onCompositionEnd?: (event: CompositionEvent) => void;
  onKeyDown?: (event: ComposerEditorKey) => void;
};
type Props = ComposerEditorEvents & {
  value: string;
  placeholder: string;
  draftKey: string;
  references: ConversationReference[];
  selectedIds: string[];
  fileSlots: number;
  onReferencesChange: (ids: string[]) => void;
  ref: RefObject<ComposerEditorElement | null>;
};
type Portal = { key: number; host: HTMLElement; id: string; label: string };
const referenceClipboard = "application/x-woolgather-inline";
function sliceText(slice: Slice) {
  let text = "";
  slice.content.forEach((node) => {
    text += inlineText(node);
  });
  return text;
}

/** ProseMirror owns editing/selection/history; React renders the shared inline links. */
export function ComposerEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(props);
  current.current = props;
  const [portals, setPortals] = useState<Portal[]>([]);
  useLayoutEffect(() => {
    setPortals([]);
    let alive = true,
      nextKey = 0;
    let input = new InputEvent("input");
    const selected = () =>
      current.current.references.filter((item) =>
        current.current.selectedIds.includes(item.id),
      );
    let doc = inlineDocument(current.current.value, selected());
    const saved = readDraft(current.current.draftKey + ":inline");
    if (saved?.text === current.current.value) {
      try {
        const restored = composerSchema.nodeFromJSON(saved.doc);
        restored.check();
        if (
          inlineText(restored) === saved.text &&
          inlineIds(restored).every((id) =>
            current.current.selectedIds.includes(id),
          )
        )
          doc = restored;
      } catch {
        /* A stale or incomplete rich draft falls back to its saved text. */
      }
    }
    const plugins = [
      history(),
      keymap({
        "Mod-z": undo,
        "Mod-Shift-z": redo,
        "Mod-y": redo,
        ...baseKeymap,
        Enter: () => true,
      }),
      new Plugin({
        filterTransaction: (tr) => {
          if (!tr.docChanged) return true;
          const ids = inlineIds(tr.doc);
          return (
            inlineText(tr.doc).length <= 12000 &&
            ids.filter((id) => id.startsWith("source-")).length <=
              current.current.fileSlots &&
            ids.filter((id) => id.startsWith("agent-")).length <= 2 &&
            ids.filter((id) => id.startsWith("thought-")).length <= 8
          );
        },
      }),
    ];
    const instance = new EditorView(host.current!, {
      state: EditorState.create({ schema: composerSchema, doc, plugins }),
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Your thought",
        class: "composer-editor-input",
        spellcheck: "true",
      },
      nodeViews: {
        mention(node) {
          const dom = document.createElement("span");
          dom.contentEditable = "false";
          dom.className = "composer-inline-token";
          dom.dataset.mentionId = node.attrs.id;
          const key = nextKey++;
          setPortals((old) => [
            ...old,
            { key, host: dom, id: node.attrs.id, label: node.attrs.label },
          ]);
          return {
            dom,
            stopEvent: (event) => event.target !== dom,
            ignoreMutation: () => true,
            destroy() {
              if (alive)
                setPortals((old) => old.filter((item) => item.key !== key));
            },
          };
        },
      },
      dispatchTransaction(tr) {
        instance.updateState(instance.state.apply(tr));
        if (tr.docChanged) {
          const ids = inlineIds(instance.state.doc);
          current.current.onReferencesChange(ids);
          storeDraft(current.current.draftKey + ":inline", {
            text: inlineText(instance.state.doc),
            doc: instance.state.doc.toJSON(),
          });
          if (!tr.getMeta("external"))
            current.current.onChange?.({
              currentTarget: instance.dom as ComposerEditorElement,
              nativeEvent: input,
            });
          input = new InputEvent("input");
        } else if (tr.selectionSet)
          current.current.onSelect?.({
            currentTarget: instance.dom as ComposerEditorElement,
          });
      },
      handleDOMEvents: {
        copy(editor, event) {
          if (!event.clipboardData || editor.state.selection.empty)
            return false;
          const slice = editor.state.selection.content();
          event.clipboardData.setData("text/plain", sliceText(slice));
          event.clipboardData.setData(
            referenceClipboard,
            JSON.stringify(slice.toJSON()),
          );
          event.preventDefault();
          return true;
        },
        cut(editor, event) {
          if (!event.clipboardData || editor.state.selection.empty)
            return false;
          const slice = editor.state.selection.content();
          event.clipboardData.setData("text/plain", sliceText(slice));
          event.clipboardData.setData(
            referenceClipboard,
            JSON.stringify(slice.toJSON()),
          );
          event.preventDefault();
          editor.dispatch(
            closeHistory(editor.state.tr.deleteSelection()).scrollIntoView(),
          );
          return true;
        },
        beforeinput(_view, event) {
          input = event;
          // Mobile keyboards can emit a line break without a keydown event.
          if (
            !event.isComposing &&
            ["insertParagraph", "insertLineBreak"].includes(event.inputType)
          ) {
            event.preventDefault();
            _view.dispatch(
              _view.state.tr
                .replaceSelectionWith(composerSchema.nodes.hard_break.create())
                .scrollIntoView(),
            );
            return true;
          }
          return false;
        },
        compositionstart(_view, event) {
          current.current.onCompositionStart?.(event);
          return false;
        },
        compositionend(_view, event) {
          current.current.onCompositionEnd?.(event);
          return false;
        },
      },
      handleKeyDown(editor, event) {
        current.current.onKeyDown?.({
          currentTarget: editor.dom as ComposerEditorElement,
          nativeEvent: event,
          key: event.key,
          shiftKey: event.shiftKey,
          get defaultPrevented() {
            return event.defaultPrevented;
          },
          preventDefault: () => event.preventDefault(),
          stopPropagation: () => event.stopPropagation(),
        });
        if (event.defaultPrevented) return true;
        if (event.isComposing || editor.composing) return false;
        if (event.key === "Enter" && event.shiftKey) {
          editor.dispatch(
            editor.state.tr
              .replaceSelectionWith(composerSchema.nodes.hard_break.create())
              .scrollIntoView(),
          );
          return true;
        }
        const { selection } = editor.state;
        if (
          selection.empty &&
          (event.key === "Backspace" || event.key === "Delete")
        ) {
          const node =
            event.key === "Backspace"
              ? selection.$from.nodeBefore
              : selection.$from.nodeAfter;
          if (node?.type.name === "mention") {
            const start = selection.from - (event.key === "Backspace" ? 1 : 0);
            editor.dispatch(
              closeHistory(editor.state.tr.delete(start, start + 1)),
            );
            return true;
          }
        }
        return false;
      },
      handlePaste(editor, event) {
        if (event.clipboardData?.files.length) return true;
        const rich = event.clipboardData?.getData(referenceClipboard);
        if (rich && rich.length <= 100000) {
          try {
            const slice = Slice.fromJSON(composerSchema, JSON.parse(rich));
            let valid =
              sliceText(slice) === event.clipboardData?.getData("text/plain");
            slice.content.forEach((node) => node.check());
            slice.content.descendants((node) => {
              if (
                node.type.name === "mention" &&
                !current.current.references.some(
                  (reference) =>
                    reference.id === node.attrs.id &&
                    reference.kind === node.attrs.kind &&
                    reference.label === node.attrs.label,
                )
              )
                valid = false;
            });
            if (valid) {
              input = new InputEvent("input", { inputType: "insertFromPaste" });
              editor.dispatch(
                closeHistory(
                  editor.state.tr.replaceSelection(slice),
                ).scrollIntoView(),
              );
              return true;
            }
          } catch {
            /* Unavailable or malformed references paste as plain text. */
          }
        }
        const text = event.clipboardData?.getData("text/plain");
        if (text === undefined) return false;
        const available =
          12000 -
          inlineText(editor.state.doc).length +
          offsetAtPosition(editor.state.doc, editor.state.selection.to) -
          offsetAtPosition(editor.state.doc, editor.state.selection.from);
        const fragment = composerSchema.nodes.paragraph.create(
          null,
          plainContent(
            text.replace(/\r\n?/g, "\n").slice(0, Math.max(0, available)),
          ),
        ).content;
        input = new InputEvent("input", { inputType: "insertFromPaste" });
        editor.dispatch(
          editor.state.tr
            .replaceWith(
              editor.state.selection.from,
              editor.state.selection.to,
              fragment,
            )
            .scrollIntoView(),
        );
        return true;
      },
      clipboardTextSerializer: sliceText,
    });
    const element = instance.dom as ComposerEditorElement;
    Object.defineProperties(element, {
      value: { get: () => inlineText(instance.state.doc) },
      selectionStart: {
        get: () =>
          offsetAtPosition(instance.state.doc, instance.state.selection.from),
      },
      selectionEnd: {
        get: () =>
          offsetAtPosition(instance.state.doc, instance.state.selection.to),
      },
      hasReference: {
        value: (start: number, end: number) => {
          let offset = 0,
            found = false;
          instance.state.doc.firstChild?.forEach((node) => {
            const length = inlineText(node).length;
            if (
              node.type.name === "mention" &&
              start < offset + length &&
              end > offset
            )
              found = true;
            offset += length;
          });
          return found;
        },
      },
      setSelectionRange: {
        value: (start: number, end: number) =>
          instance.dispatch(
            instance.state.tr.setSelection(
              TextSelection.create(
                instance.state.doc,
                positionAtOffset(instance.state.doc, start),
                positionAtOffset(instance.state.doc, end),
              ),
            ),
          ),
      },
      removeReference: {
        value: (id: string) => {
          const ranges: Array<{ from: number; to: number }> = [];
          instance.state.doc.descendants((node, pos) => {
            if (node.type.name === "mention" && node.attrs.id === id)
              ranges.push({ from: pos, to: pos + node.nodeSize });
          });
          if (!ranges.length) return;
          const transaction = instance.state.tr;
          for (const range of ranges.reverse())
            transaction.delete(range.from, range.to);
          instance.dispatch(transaction.setMeta("addToHistory", false));
        },
      },
      insertReference: {
        value: (
          start: number,
          end: number,
          reference: { id: string; label: string; kind: string },
        ) => {
          const suffix = inlineText(instance.state.doc).slice(end);
          const nodes = [
            composerSchema.nodes.mention.create(reference),
            ...(!/^\s/u.test(suffix) ? [composerSchema.text(" ")] : []),
          ];
          const from = positionAtOffset(instance.state.doc, start);
          const transaction = closeHistory(
            instance.state.tr.replaceWith(
              from,
              positionAtOffset(instance.state.doc, end),
              nodes,
            ),
          );
          transaction.setSelection(
            TextSelection.create(
              transaction.doc,
              from + nodes.reduce((size, node) => size + node.nodeSize, 0),
            ),
          );
          instance.dispatch(transaction.scrollIntoView());
          instance.dispatch(closeHistory(instance.state.tr));
        },
      },
    });
    props.ref.current = element;
    view.current = instance;
    return () => {
      alive = false;
      props.ref.current = null;
      view.current = null;
      instance.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const selected = props.references.filter((item) =>
      props.selectedIds.includes(item.id),
    );
    let next = inlineDocument(props.value, selected, instance.state.doc);
    const present = new Set(inlineIds(next));
    const missing = selected.filter((item) => !present.has(item.id));
    const value =
      props.value +
      (missing.length
        ? `${props.value && !/\s$/.test(props.value) ? " " : ""}${missing.map((item) => `@${item.label}`).join(" ")} `
        : "");
    if (missing.length)
      next = inlineDocument(value, selected, instance.state.doc);
    if (!next.eq(instance.state.doc)) {
      const start = (instance.dom as ComposerEditorElement).selectionStart;
      if (!value) {
        instance.updateState(
          EditorState.create({
            schema: composerSchema,
            doc: next,
            plugins: instance.state.plugins,
          }),
        );
        storeDraft(props.draftKey + ":inline", {
          text: "",
          doc: next.toJSON(),
        });
      } else {
        const transaction = closeHistory(
          instance.state.tr
            .replaceWith(0, instance.state.doc.content.size, next.content)
            .setMeta("external", true),
        );
        transaction.setSelection(
          TextSelection.create(
            transaction.doc,
            positionAtOffset(
              transaction.doc,
              missing.length ? value.length : start,
            ),
          ),
        );
        instance.dispatch(transaction);
      }
      if (value !== props.value)
        props.onChange?.({
          currentTarget: instance.dom as ComposerEditorElement,
          nativeEvent: new InputEvent("input"),
        });
    }
    const dom = instance.dom;
    dom.setAttribute("data-placeholder", props.placeholder);
    dom.setAttribute("data-empty", String(!inlineText(instance.state.doc)));
    for (const name of [
      "aria-label",
      "aria-controls",
      "aria-activedescendant",
      "aria-autocomplete",
      "aria-haspopup",
    ] as const) {
      const value = props[name];
      if (value === undefined) dom.removeAttribute(name);
      else dom.setAttribute(name, String(value));
    }
  });
  return (
    <>
      <div className="composer-editor" ref={host} />
      {portals.map((portal) => {
        const reference = props.references.find(
          (item) => item.id === portal.id,
        );
        return reference
          ? createPortal(
              <ConversationReferenceLink
                reference={{ ...reference, label: portal.label }}
              />,
              portal.host,
              portal.key,
            )
          : null;
      })}
    </>
  );
}
