import { SurfacePresence } from "@/ui/Modal";
import { useRef, useState } from "react";
import { Folder, Lightbulb, PanelsTopLeft, MoreHorizontal } from "lucide-react";
import { Button, IconButton } from "../ui/Button";
import { ActionMenu, ProjectMenu } from "./ProjectMenu";
import {
  pinKey,
  type ResolvedPin,
  type SidebarPin,
} from "./sidebarPreferences";

const pinnedActions = [
  ["unpin", "Remove from sidebar"],
  ["personalize", "Personalize sidebar"],
];

export function PinnedItems({
  pins,
  busy,
  onOpen,
  onUnpin,
  onReorder,
  onPersonalize,
}: {
  pins: ResolvedPin[];
  busy: boolean;
  onOpen: (pin: SidebarPin) => void;
  onUnpin: (pin: SidebarPin) => void;
  onReorder: (key: string, target: string) => void;
  onPersonalize: () => void;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    pin: ResolvedPin;
    x: number;
    y: number;
  } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const close = () => {
    setMenu(null);
    trigger.current?.focus();
  };
  if (!pins.length) return null;
  return (
    <div className="sidebar-pinned-items" aria-label="Pinned items">
      <span className="workspace-label">Pinned</span>
      {pins.map((pin) => {
        const key = pinKey(pin);
        const Icon =
          pin.kind === "folder"
            ? Folder
            : pin.kind === "idea"
              ? Lightbulb
              : PanelsTopLeft;
        return (
          <div
            key={key}
            className={`sidebar-pinned-row ${target === key ? "pin-drop-target" : ""}`}
            onDragOver={(e) => {
              if (dragged && dragged !== key && !busy) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                setTarget(key);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setTarget(null);
            }}
            onDrop={(e) => {
              if (dragged) {
                e.preventDefault();
                e.stopPropagation();
                onReorder(dragged, key);
                setDragged(null);
                setTarget(null);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              trigger.current = e.currentTarget.querySelector("button");
              setMenu({ pin, x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                e.preventDefault();
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                trigger.current = e.currentTarget.querySelector("button");
                setMenu({ pin, x: r.left, y: r.bottom });
              }
            }}
          >
            <Button
              variant="navigation"
              className="nav-item sidebar-pin-open"
              title={`${pin.name} · ${pin.kind}`}
              onClick={() => onOpen(pin)}
              draggable={!busy}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("application/x-woolgather-pin", key);
                setDragged(key);
              }}
              onDragEnd={() => {
                setDragged(null);
                setTarget(null);
              }}
            >
              <Icon size={17} />
              <span>{pin.name}</span>
            </Button>
            <ActionMenu
              active={false}
              trashed={false}
              disabled={busy}
              label="Pinned item actions"
              trigger={
                <IconButton
                  aria-label={`Actions for pinned ${pin.name}`}
                  disabled={busy}
                >
                  <MoreHorizontal />
                </IconButton>
              }
              options={pinnedActions}
              onAction={(action) =>
                action === "unpin" ? onUnpin(pin) : onPersonalize()
              }
            />
          </div>
        );
      })}
      <SurfacePresence>
        {menu && (
          <ProjectMenu
            x={menu.x}
            y={menu.y}
            active={false}
            trashed={false}
            label="Pinned item actions"
            disabled={busy}
            options={pinnedActions}
            onClose={close}
            onAction={(action) => {
              const pin = menu.pin;
              close();
              if (action === "unpin") onUnpin(pin);
              else onPersonalize();
            }}
          />
        )}
      </SurfacePresence>
    </div>
  );
}
