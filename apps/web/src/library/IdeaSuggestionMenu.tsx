import { Fragment, useEffect, useRef, useState } from "react";
import {
  useComponentsContext,
  useDictionary,
  useBlockNoteContext,
  useBlockNoteEditor,
  type DefaultReactSuggestionItem,
  type SuggestionMenuProps,
} from "@blocknote/react";

/** One active option for pointer hover, arrow navigation and Enter. */
export function IdeaSuggestionMenu<T extends DefaultReactSuggestionItem>(
  props: SuggestionMenuProps<T>,
) {
  const editor = useBlockNoteEditor();
  const Menu = useComponentsContext()!.SuggestionMenu;
  const dict = useDictionary();
  const context = useBlockNoteContext();
  const container = useRef<HTMLDivElement>(null);
  const itemKey = JSON.stringify(
    props.items.map((item) => [item.title, item.group]),
  );
  const [active, setActive] = useState({ key: itemKey, index: 0 });
  const index = props.items.length
    ? active.key === itemKey
      ? Math.min(active.index, props.items.length - 1)
      : 0
    : undefined;
  const current = useRef(index);
  current.current = index;
  const select = (next: number) => {
    current.current = next;
    setActive({ key: itemKey, index: next });
  };
  useEffect(() => {
    // The stock wrapper keeps a separate keyboard-only index. Update the
    // accessible active descendant from this unified selection instead.
    context?.setContentEditableProps?.((previous) => ({
      ...previous,
      "aria-activedescendant":
        index === undefined ? undefined : `bn-suggestion-menu-item-${index}`,
    }));
  }, [context?.setContentEditableProps, index, props.items]);
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.defaultPrevented ||
        !props.items.length
      )
        return;
      const target = event.target;
      if (
        !(target instanceof Node) ||
        !(
          editor.prosemirrorView.dom.contains(target) ||
          container.current?.contains(target)
        )
      )
        return;
      if (
        !["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Enter"].includes(
          event.key,
        )
      )
        return;
      event.preventDefault();
      // Own these keys before the wrapper's keyboard-only navigation handler.
      event.stopImmediatePropagation();
      const selected = current.current ?? 0;
      if (event.key === "Enter") props.onItemClick?.(props.items[selected]);
      else if (event.key === "PageDown") select(props.items.length - 1);
      else if (event.key === "PageUp") select(0);
      else
        select(
          (selected +
            (event.key === "ArrowDown" ? 1 : -1) +
            props.items.length) %
            props.items.length,
        );
    };
    document.addEventListener("keydown", navigate, true);
    return () => document.removeEventListener("keydown", navigate, true);
  }, [editor, props.items, props.onItemClick]);
  const hover = (event: {
    target: EventTarget | null;
    pointerType?: string;
  }) => {
    if (event.pointerType === "touch" || !(event.target instanceof Element))
      return;
    const option = event.target.closest('[role="option"]');
    if (!option || !container.current) return;
    const next = Array.from(
      container.current.querySelectorAll('[role="option"]'),
    ).indexOf(option);
    if (next >= 0 && next !== current.current) select(next);
  };
  return (
    <div
      ref={container}
      onPointerMoveCapture={hover}
      onMouseMoveCapture={hover}
    >
      <Menu.Root id="bn-suggestion-menu" className="bn-suggestion-menu">
        {props.items.map((item, itemIndex) => (
          <Fragment key={item.title}>
            {(itemIndex === 0 ||
              item.group !== props.items[itemIndex - 1].group) &&
              item.group && (
                <Menu.Label className="bn-suggestion-menu-label">
                  {item.group}
                </Menu.Label>
              )}
            <Menu.Item
              className="bn-suggestion-menu-item bn-suggestion-menu-item-small"
              item={item}
              id={`bn-suggestion-menu-item-${itemIndex}`}
              isSelected={index === itemIndex}
              onClick={() => props.onItemClick?.(item)}
            />
          </Fragment>
        ))}
        {!props.items.length && props.loadingState === "loaded" && (
          <Menu.EmptyItem className="bn-suggestion-menu-item">
            {dict.suggestion_menu.no_items_title}
          </Menu.EmptyItem>
        )}
        {props.loadingState !== "loaded" && (
          <Menu.Loader className="bn-suggestion-menu-loader" />
        )}
      </Menu.Root>
    </div>
  );
}
