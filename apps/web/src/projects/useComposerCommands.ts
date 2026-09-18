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
  consumeComposerCommand,
  filterComposerCommands,
  readComposerCommand,
  type ComposerCommand,
  type ComposerTool,
} from "./composerCommands";

/** Suggestions enhance the native textarea without taking focus or intercepting ordinary editing. */
export function useComposerCommands({
  text,
  onTextChange,
  inputRef,
  disabled,
  onChoose,
}: {
  text: string;
  onTextChange: (value: string) => void;
  inputRef: RefObject<ComposerEditorElement | null>;
  disabled: boolean;
  onChoose: (tool: ComposerTool) => boolean;
}) {
  const id = useId();
  const [command, setCommand] = useState<ComposerCommand | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const composing = useRef(false);
  const selection = useRef<number | null>(null);
  const current = command && readComposerCommand(text, command.start + 1);
  const open =
    !disabled &&
    !!current &&
    current.query === command?.query &&
    current.start === command.start &&
    current.end === command.end;
  const items = filterComposerCommands(open ? command!.query : "");
  const active = items[activeIndex] ?? items[0];

  useLayoutEffect(() => {
    if (selection.current === null) return;
    const caret = selection.current;
    selection.current = null;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.setSelectionRange(caret, caret);
  }, [text, inputRef]);

  function update(field: ComposerEditorElement, allowOpen: boolean) {
    const next =
      !disabled && !composing.current && (command || allowOpen)
        ? readComposerCommand(
            field.value,
            field.selectionStart,
            field.selectionEnd,
          )
        : null;
    if (next?.query !== command?.query || next?.start !== command?.start)
      setActiveIndex(0);
    setCommand(next);
  }

  function choose(tool: ComposerTool) {
    if (!open || !command || !onChoose(tool)) return;
    selection.current = command.start;
    onTextChange(consumeComposerCommand(text, command));
    setCommand(null);
  }

  const inputProps: ComposerEditorEvents = {
    "aria-autocomplete": disabled ? undefined : "list",
    "aria-haspopup": disabled ? undefined : "listbox",
    "aria-controls": open ? id : undefined,
    "aria-activedescendant": open && active ? `${id}-${active.id}` : undefined,
    onChange(event) {
      const field = event.currentTarget;
      const input = event.nativeEvent as InputEvent;
      onTextChange(field.value);
      if (input.inputType === "insertFromPaste" || input.isComposing) {
        setCommand(null);
        return;
      }
      update(field, input.inputType === "insertText" && input.data === "/");
    },
    onSelect(event) {
      if (command) update(event.currentTarget, false);
    },
    onCompositionStart() {
      composing.current = true;
      setCommand(null);
    },
    onCompositionEnd() {
      composing.current = false;
    },
    onKeyDown(event) {
      if (event.nativeEvent.isComposing || composing.current) return;
      if (!open) {
        if (event.key === "ArrowDown" && !disabled) {
          const next = readComposerCommand(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
            event.currentTarget.selectionEnd,
          );
          if (next) {
            event.preventDefault();
            setCommand(next);
            setActiveIndex(0);
          }
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCommand(null);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length)
          setActiveIndex(
            (index) =>
              (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length,
          );
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (active) choose(active.id);
      } else if (event.key === "Tab") {
        if (!event.shiftKey && active) {
          event.preventDefault();
          choose(active.id);
        } else setCommand(null);
      } else if (event.key === "Enter") {
        setCommand(null);
      }
    },
  };
  return {
    id,
    open,
    items,
    activeId: active?.id,
    inputProps,
    choose,
    highlight: (tool: ComposerTool) =>
      setActiveIndex(items.findIndex((item) => item.id === tool)),
    dismiss: () => setCommand(null),
  };
}
