import { useMemo, type ReactElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
} from "../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../components/ui/dropdown-menu";
import { useSurfacePresence } from "../ui/Modal";
import {
  Pin,
  PinOff,
  SlidersHorizontal,
  Lightbulb,
  PanelsTopLeft,
  FolderPlus,
  ExternalLink,
  Pencil,
  FolderInput,
  Settings,
  Archive,
  ArchiveRestore,
  Trash2,
  type LucideIcon,
  FileText,
  Image,
  Link2,
  History,
} from "lucide-react";
const actionIcons: Record<string, LucideIcon> = {
  pin: Pin,
  unpin: PinOff,
  hide: PinOff,
  personalize: SlidersHorizontal,
  new_idea: Lightbulb,
  new_project: PanelsTopLeft,
  new_folder: FolderPlus,
  open: ExternalLink,
  rename: Pencil,
  move: FolderInput,
  settings: Settings,
  archive: Archive,
  restore: ArchiveRestore,
  trash: Trash2,
  delete: Trash2,
  source: FileText,
  references: Image,
  connections: Link2,
  history: History,
  removed: Trash2,
};

type ActionProps = {
  active: boolean;
  options?: string[][];
  extraOptions?: string[][];
  disabled?: boolean;
  label?: string;
  folder?: boolean;
  trashed: boolean;
  onAction: (action: string) => void;
};
function actions({
  options,
  extraOptions = [],
  folder,
  active,
  trashed,
}: ActionProps) {
  const entries = [
    ...extraOptions,
    ...(options ??
      (folder
        ? [
            ["rename", "Rename"],
            ["delete", "Delete folder"],
          ]
        : active
          ? [
              ["rename", "Rename"],
              ["move", "Move to folder"],
              ["settings", "Project settings"],
              ["archive", "Archive"],
              ["trash", "Move to trash"],
            ]
          : [
              ["settings", "Project settings"],
              ["restore", "Restore"],
              trashed
                ? ["delete", "Delete permanently"]
                : ["trash", "Move to trash"],
            ])),
  ];
  // Both remove a navigation shortcut, never the underlying item. Preserve the
  // distinct persistence commands while presenting the same user action.
  return entries.map(([id, label]) => [
    id,
    id === "unpin" || id === "hide" ? "Remove from sidebar" : label,
  ]);
}
/** Button-invoked actions use a persistent DropdownMenu root and its real trigger. */
export function ActionMenu({
  trigger,
  ...props
}: ActionProps & { trigger: ReactElement }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" aria-label={props.label || "Actions"}>
        {actions(props).map(([id, label]) => {
          const Icon = actionIcons[id];
          return (
            <DropdownMenuItem
              key={id}
              disabled={props.disabled}
              variant={
                ["trash", "delete"].includes(id) ? "destructive" : "default"
              }
              onClick={() => props.onAction(id)}
            >
              {Icon && <Icon />}
              {label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
/** Pointer and keyboard context menus retain the invocation point for collision handling. */
export function ProjectMenu({
  x,
  y,
  onClose,
  ...props
}: ActionProps & { x: number; y: number; onClose: () => void }) {
  const presence = useSurfacePresence();
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }),
    [x, y],
  );
  return (
    <ContextMenu
      open={presence?.open ?? true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) presence?.complete();
      }}
    >
      <ContextMenuContent
        anchor={anchor}
        align="start"
        side="bottom"
        alignOffset={0}
        aria-label={
          props.label || (props.folder ? "Folder actions" : "Project actions")
        }
        finalFocus={false}
      >
        {actions(props).map(([id, label]) => {
          const Icon = actionIcons[id];
          return (
            <ContextMenuItem
              key={id}
              disabled={props.disabled}
              variant={
                ["trash", "delete"].includes(id) ? "destructive" : "default"
              }
              onClick={() => props.onAction(id)}
            >
              {Icon && <Icon />}
              {label}
            </ContextMenuItem>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}
