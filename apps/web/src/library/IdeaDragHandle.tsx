import { useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtension,
  useExtensionState,
} from "@blocknote/react";
import { useShadCNComponentsContext } from "@blocknote/shadcn";

export function IdeaDragHandle({ children }: { children: ReactNode }) {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const Menu = useShadCNComponentsContext()!.DropdownMenu;
  const dict = useDictionary();
  const sideMenu = useExtension(SideMenuExtension);
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  });
  const [open, setOpen] = useState(false);
  const dragging = useRef(false);
  const dragged = useRef(false);
  const ownsFreeze = useRef(false);
  const pressedBlock = useRef<string | undefined>(undefined);
  const freeze = () => {
    ownsFreeze.current = true;
    sideMenu.freezeMenu();
  };
  const unfreeze = () => {
    if (!ownsFreeze.current) return;
    ownsFreeze.current = false;
    sideMenu.unfreezeMenu();
  };
  const changeOpen = (next: boolean) => {
    if (next && dragging.current) return;
    setOpen(next);
    if (next) freeze();
    else if (!dragging.current) unfreeze();
  };
  useEffect(
    () => () => {
      if (dragging.current) {
        dragging.current = false;
        sideMenu.blockDragEnd();
      }
      // Strict Mode replays cleanup on mount. Unfreezing also hides the whole
      // side menu, so only release a freeze that this handle actually acquired.
      if (ownsFreeze.current) {
        ownsFreeze.current = false;
        sideMenu.unfreezeMenu();
      }
    },
    [sideMenu],
  );
  if (!block) return null;
  return (
    <Menu.DropdownMenu open={open} onOpenChange={changeOpen} modal={false}>
      <Menu.DropdownMenuTrigger
        // Base UI normally opens on mouse-down. Leave the browser's native
        // drag gesture intact and open only after a completed pointer click.
        onMouseDown={(event) => event.preventBaseUIHandler()}
        onPointerDown={() => {
          dragged.current = false;
          pressedBlock.current = block.id;
        }}
        onClick={(event) => {
          // Base UI retains Enter/Space/arrow-key behavior and focus handling.
          if (event.detail === 0) return;
          event.preventBaseUIHandler();
          if (!dragged.current) changeOpen(!open);
        }}
        render={
          <Components.SideMenu.Button
            className="bn-button idea-drag-handle"
            label={dict.side_menu.drag_handle_label}
            icon={<GripVertical size={18} aria-hidden="true" />}
            draggable
            onDragStart={(event) => {
              const current = editor.getBlock(pressedBlock.current || block.id);
              if (!current) {
                event.preventDefault();
                return;
              }
              dragging.current = true;
              dragged.current = true;
              changeOpen(false);
              freeze();
              sideMenu.blockDragStart(event, current);
              // The library appends the native drag image outside the editor.
              // Restore our style scope and bound its size before capture.
              const preview =
                document.querySelector<HTMLElement>(".bn-drag-preview");
              if (preview) {
                const source =
                  editor.prosemirrorView.dom.querySelector<HTMLElement>(
                    `.bn-block-outer[data-id="${CSS.escape(current.id)}"]`,
                  );
                preview.classList.add(
                  "idea-block-editor",
                  "idea-block-drag-preview",
                  "bn-container",
                  "light",
                );
                preview.style.width = `${Math.min(source?.getBoundingClientRect().width || 480, 480)}px`;
                preview.setAttribute("aria-hidden", "true");
                preview.inert = true;
                preview
                  .querySelectorAll("[id]")
                  .forEach((node) => node.removeAttribute("id"));
                preview
                  .querySelectorAll(".idea-code-language")
                  .forEach((node) => node.remove());
                event.dataTransfer.setDragImage(preview, 12, 18);
              }
            }}
            onDragEnd={() => {
              dragging.current = false;
              sideMenu.blockDragEnd();
              unfreeze();
            }}
          />
        }
      />
      {children}
    </Menu.DropdownMenu>
  );
}
