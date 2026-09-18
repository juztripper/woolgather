import { Popover } from "@base-ui/react/popover";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { useMaterialSurface } from "@/ui/materialMotion";
import { menuStyles } from "./menu-styles";
import { MenuItemContent } from "./menu-item-content";

type Suggestion = {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  disabled?: boolean;
  trailing?: ReactNode;
};

/** A native editor owns focus and keyboard navigation; this surface presents its suggestions. */
export function CommandSuggestions<T extends Suggestion>({
  id,
  open,
  anchorRef,
  inputRef,
  items,
  activeId,
  onHighlight,
  onChoose,
  onDismiss,
  label = "Planning tools",
  heading,
  noun = "tool",
  emptyText = "No matching tools. Try another name.",
  empty,
}: {
  id: string;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  inputRef: RefObject<HTMLElement | null>;
  items: T[];
  activeId?: string;
  onHighlight: (item: T) => void;
  onChoose: (item: T) => void;
  onDismiss: () => void;
  label?: string;
  heading?: string;
  noun?: string;
  emptyText?: string;
  empty?: boolean;
}) {
  const surfaceRef = useMaterialSurface<HTMLDivElement>();
  const list = useRef<HTMLDivElement>(null);
  // Keep the chosen result in place during dissolution; resetting to all tools
  // here would make the panel grow again as it closes.
  const lastOpen = useRef({ items, activeId, heading, empty, emptyText });
  if (open) lastOpen.current = { items, activeId, heading, empty, emptyText };
  const visible = open
    ? { items, activeId, heading, empty, emptyText }
    : lastOpen.current;
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  return (
    <Popover.Root
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        if (
          !next &&
          details.event.target === inputRef.current &&
          details.reason !== "escape-key"
        ) {
          details.cancel();
          return;
        }
        if (!next) onDismiss();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchorRef}
          side="top"
          align="start"
          sideOffset={8}
          disableAnchorTracking={!open}
          className="isolate z-50 outline-none"
        >
          <Popover.Popup
            ref={surfaceRef}
            role="presentation"
            initialFocus={false}
            finalFocus={false}
            className={cn(menuStyles.popup, menuStyles.composerPopup)}
          >
            <div
              ref={list}
              id={id}
              role="listbox"
              aria-label={label}
              aria-hidden={!open}
              className="material-menu-body max-h-[min(22rem,var(--available-height))] overscroll-contain"
            >
              {visible.heading && (
                <div className={menuStyles.label}>{visible.heading}</div>
              )}
              {visible.items.map((item) => (
                <div
                  key={item.id}
                  id={`${id}-${item.id}`}
                  role="option"
                  aria-selected={visible.activeId === item.id}
                  aria-disabled={item.disabled || undefined}
                  data-slot="command-item"
                  data-highlighted={
                    visible.activeId === item.id ? "" : undefined
                  }
                  aria-label={item.label}
                  aria-describedby={`${id}-${item.id}-description`}
                  className={cn(
                    menuStyles.item,
                    "gap-3 data-highlighted:bg-accent data-highlighted:text-accent-foreground aria-disabled:opacity-50",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => onHighlight(item)}
                  onClick={() => {
                    if (!item.disabled) onChoose(item);
                  }}
                >
                  <MenuItemContent
                    icon={item.icon}
                    label={item.label}
                    description={item.description}
                    descriptionId={`${id}-${item.id}-description`}
                  />
                  {item.trailing}
                </div>
              ))}
              {(visible.empty ?? !visible.items.length) && (
                <p className="px-2 py-3 text-[length:var(--text-menu)] text-muted-foreground">
                  {visible.emptyText}
                </p>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
      <span role="status" className="sr-only">
        {open
          ? `${items.length} ${items.length === 1 ? noun : `${noun}s`} available. Use arrow keys to browse, Enter to choose, or Escape to close.`
          : ""}
      </span>
    </Popover.Root>
  );
}
