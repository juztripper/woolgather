import {
  ArrowUpRight,
  Lightbulb,
  PanelsTopLeft,
  MoreHorizontal,
} from "lucide-react";
import type { LibraryEntry } from "../../../../packages/domain/src/library";
import { entryName } from "../../../../packages/domain/src/library";
import { Button, IconButton } from "../ui/Button";
import { ActionMenu } from "./ProjectMenu";
import type { HTMLAttributes } from "react";

export function LibraryCard({
  entry,
  folder,
  linked,
  busy,
  options,
  extraOptions,
  onOpen,
  onAction,
  ...events
}: {
  entry: LibraryEntry;
  folder?: string;
  linked?: string;
  busy: boolean;
  options?: string[][];
  extraOptions: string[][];
  onOpen: () => void;
  onAction: (action: string) => void;
} & HTMLAttributes<HTMLLIElement>) {
  const name = entryName(entry);
  const excerpt = (
    entry.kind === "project" ? entry.item.description : entry.item.body
  )
    .replace(/^#+\s+.*\n/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*`_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const meta =
    entry.kind === "project"
      ? `${entry.item.itemCount} ${entry.item.itemCount === 1 ? "thought" : "thoughts"}`
      : linked
        ? `Source for ${linked}`
        : folder || "Idea";
  return (
    <li className="library-card" data-kind={entry.kind} {...events}>
      <Button
        variant="surface"
        className="library-card-open flex h-full w-full flex-col items-stretch gap-0 p-5 sm:p-6"
        aria-label={`Open ${entry.kind} ${name}`}
        onClick={onOpen}
      >
        <span className="library-card-kind">
          {entry.kind === "project" ? <PanelsTopLeft /> : <Lightbulb />}
          <span>
            {folder || (entry.kind === "project" ? "Project" : "Idea")}
          </span>
          <ArrowUpRight className="library-card-arrow" />
        </span>
        <span className="library-card-title">{name}</span>
        <span className="library-card-excerpt">
          {excerpt ||
            (entry.kind === "project"
              ? "Open to continue thinking."
              : "Open to start writing.")}
        </span>
        <span className="library-card-meta">
          <span>{meta}</span>
          <time dateTime={entry.item.updatedAt}>
            {new Date(entry.item.updatedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </time>
        </span>
      </Button>
      <div className="library-card-actions">
        <ActionMenu
          active
          trashed={false}
          label={entry.kind === "project" ? "Project actions" : "Idea actions"}
          disabled={busy}
          options={options}
          extraOptions={extraOptions}
          onAction={onAction}
          trigger={
            <IconButton
              size="icon-sm"
              aria-label={`Actions for ${entry.kind} ${name}`}
              disabled={busy}
            >
              <MoreHorizontal />
            </IconButton>
          }
        />
      </div>
    </li>
  );
}
