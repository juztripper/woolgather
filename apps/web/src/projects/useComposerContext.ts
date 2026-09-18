import type {
  ComposerEditorElement,
  ComposerEditorEvents,
} from "./ComposerEditor";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  insertComposerMention,
  readComposerMention,
  type ComposerMention,
} from "./composerMentions";

export type ContextKind = "agent" | "thought" | "source";
export type ContextChoice = {
  id: string;
  targetId?: string;
  avatar?: string;
  kind: ContextKind | "upload" | "page" | "back";
  page?: ContextKind;
  label: string;
  description: string;
  disabled?: boolean;
};
export type ContextCatalog = Record<ContextKind, ContextChoice[]>;

const pages: ContextChoice[] = [
  {
    id: "upload",
    kind: "upload",
    label: "Files or images",
    description: "Upload to this project",
  },
  {
    id: "sources",
    kind: "page",
    page: "source",
    label: "Project sources",
    description: "Use a saved file or image",
  },
  {
    id: "thoughts",
    kind: "page",
    page: "thought",
    label: "Reference a thought",
    description: "From your project's plan",
  },
  {
    id: "agents",
    kind: "page",
    page: "agent",
    label: "Mention an agent",
    description: "Bring a specialist into this conversation",
  },
];
const pageTitles = {
  agent: "Agents",
  thought: "Thoughts",
  source: "Project sources",
};

/** Click and @ share this state, catalog, selection and native-editor keyboard behavior. */
export function useComposerContext({
  text,
  onTextChange,
  inputRef,
  catalog,
  disabled,
  onChoose,
  onOpen,
}: {
  text: string;
  onTextChange: (value: string) => void;
  inputRef: RefObject<ComposerEditorElement | null>;
  catalog: ContextCatalog;
  disabled: boolean;
  onChoose: (choice: ContextChoice) => boolean;
  onOpen: () => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<"closed" | "trigger" | "mention">("closed");
  const [mention, setMention] = useState<ComposerMention | null>(null);
  const [page, setPage] = useState<ContextKind | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const insertion = useRef({ start: 0, end: 0 });
  const selection = useRef<number | null>(null);
  const composing = useRef(false);
  const current = mention && readComposerMention(text, mention.end);
  const open =
    !disabled &&
    mode !== "closed" &&
    (mode === "trigger" ||
      (current?.start === mention?.start && current?.query === mention?.query));
  const query =
    mode === "mention" ? mention?.query.trim().toLocaleLowerCase() || "" : "";
  const matching = (choice: ContextChoice) =>
    query
      .split(/\s+/u)
      .every((part) =>
        `${choice.label} ${choice.description}`
          .toLocaleLowerCase()
          .includes(part),
      );
  const back: ContextChoice = {
    id: "back",
    kind: "back",
    label: "Back",
    description: "All project context",
  };
  const items = page
    ? [back, ...catalog[page].filter(matching)]
    : query
      ? [...catalog.agent, ...catalog.source, ...catalog.thought].filter(
          matching,
        )
      : pages;
  const active = !items[activeIndex]?.disabled
    ? items[activeIndex]
    : items.find((item) => !item.disabled);

  useLayoutEffect(() => {
    if (selection.current === null) return;
    const caret = selection.current;
    selection.current = null;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.setSelectionRange(caret, caret);
  }, [text, mode, inputRef]);

  function dismiss() {
    setMode("closed");
    setMention(null);
    setPage(null);
  }
  function resetPage() {
    setPage(null);
    setActiveIndex(0);
  }
  function update(field: ComposerEditorElement, allowOpen: boolean) {
    const candidate =
      !disabled && !composing.current && (mode === "mention" || allowOpen)
        ? readComposerMention(
            field.value,
            field.selectionStart,
            field.selectionEnd,
          )
        : null;
    const next =
      candidate && !field.hasReference(candidate.start, candidate.end)
        ? candidate
        : null;
    if (!next) {
      dismiss();
      return;
    }
    if (next.query !== mention?.query || next.start !== mention?.start)
      setActiveIndex(0);
    if (mode !== "mention") {
      resetPage();
      onOpen();
    }
    setMention(next);
    setMode("mention");
  }
  function toggle() {
    if (open) {
      dismiss();
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (disabled) return;
    const field = inputRef.current;
    insertion.current = {
      start: field?.selectionStart ?? text.length,
      end: field?.selectionEnd ?? text.length,
    };
    resetPage();
    setMode("trigger");
    setMention(null);
    onOpen();
    field?.focus({ preventScroll: true });
  }
  function choose(choice: ContextChoice) {
    if (!open || choice.disabled) return;
    if (choice.kind === "back") {
      resetPage();
      return;
    }
    if (choice.kind === "page") {
      setPage(choice.page || null);
      const first = choice.page
        ? catalog[choice.page].findIndex((item) => !item.disabled)
        : -1;
      setActiveIndex(first < 0 ? 0 : first + 1);
      return;
    }
    const range = mode === "mention" && mention ? mention : insertion.current;
    const next = insertComposerMention(
      text,
      range,
      choice.kind === "upload" ? undefined : choice.label,
    );
    if (next.text.length > 12000 || !onChoose(choice)) return;
    selection.current = next.caret;
    if (
      choice.kind === "agent" ||
      choice.kind === "thought" ||
      choice.kind === "source"
    ) {
      inputRef.current?.insertReference(range.start, range.end, {
        id: choice.id,
        label: choice.label,
        kind: choice.kind,
      });
    }
    onTextChange(next.text);
    dismiss();
  }
  const inputProps: ComposerEditorEvents = {
    "aria-autocomplete": disabled ? undefined : "list",
    "aria-haspopup": disabled ? undefined : "listbox",
    "aria-controls": open ? id : undefined,
    "aria-activedescendant": open && active ? `${id}-${active.id}` : undefined,
    onChange(event) {
      const input = event.nativeEvent as InputEvent;
      if (input.inputType === "insertFromPaste" || input.isComposing) {
        dismiss();
        return;
      }
      update(
        event.currentTarget,
        input.inputType === "insertText" && input.data === "@",
      );
    },
    onSelect(event) {
      if (mode === "mention") update(event.currentTarget, false);
    },
    onCompositionStart() {
      composing.current = true;
      dismiss();
    },
    onCompositionEnd() {
      composing.current = false;
    },
    onKeyDown(event) {
      if (event.nativeEvent.isComposing || composing.current) return;
      if (!open) {
        if (event.key === "ArrowDown" && !disabled) {
          const next = readComposerMention(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
            event.currentTarget.selectionEnd,
          );
          if (next && !event.currentTarget.hasReference(next.start, next.end)) {
            event.preventDefault();
            setMention(next);
            setMode("mention");
            resetPage();
            onOpen();
          }
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (page) resetPage();
        else dismiss();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        for (let offset = 1; offset <= items.length; offset++) {
          const next =
            (activeIndex + direction * offset + items.length) % items.length;
          if (!items[next].disabled) {
            setActiveIndex(next);
            break;
          }
        }
      } else if (event.key === "ArrowLeft" && page) {
        event.preventDefault();
        resetPage();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (active) choose(active);
      } else if (event.key === "Tab") {
        if (!event.shiftKey && active && !active.disabled) {
          event.preventDefault();
          choose(active);
        } else dismiss();
      } else if (event.key === "Enter") dismiss();
    },
  };
  return {
    id,
    open,
    items,
    activeId: active?.id,
    title: page ? pageTitles[page] : "Add to conversation",
    inputProps,
    choose,
    toggle,
    dismiss,
    highlight: (choice: ContextChoice) =>
      setActiveIndex(items.findIndex((item) => item.id === choice.id)),
  };
}
