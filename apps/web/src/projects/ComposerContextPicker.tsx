import { AgentAvatar } from "./AgentAvatar";
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  FileImage,
  FileText,
  Library,
  Paperclip,
} from "lucide-react";
import type { RefObject } from "react";
import { CommandSuggestions } from "../components/ui/command-suggestions";
import type { ContextChoice } from "./useComposerContext";

export function contextChoiceIcon(
  choice: Pick<
    ContextChoice,
    "kind" | "page" | "label" | "targetId" | "avatar"
  >,
) {
  if (choice.kind === "upload") return <Paperclip aria-hidden="true" />;
  if (choice.kind === "back") return <ArrowLeft aria-hidden="true" />;
  const kind = choice.kind === "page" ? choice.page : choice.kind;
  if (kind === "agent")
    return choice.targetId ? (
      <AgentAvatar
        id={choice.targetId}
        avatar={choice.avatar}
        className="agent-avatar--inline"
      />
    ) : (
      <Bot aria-hidden="true" />
    );
  if (kind === "source")
    return choice.kind === "page" ? (
      <Library aria-hidden="true" />
    ) : /\.(png|jpe?g|webp|gif)$/iu.test(choice.label) ? (
      <FileImage aria-hidden="true" />
    ) : (
      <FileText aria-hidden="true" />
    );
  return <FileText aria-hidden="true" />;
}

/** One surface for + and @, including all collection pages and filtered results. */
export function ComposerContextPicker({
  picker,
  anchorRef,
  inputRef,
}: {
  picker: {
    id: string;
    open: boolean;
    title: string;
    items: ContextChoice[];
    activeId?: string;
    highlight: (item: ContextChoice) => void;
    choose: (item: ContextChoice) => void;
    dismiss: () => void;
  };
  anchorRef: RefObject<HTMLElement | null>;
  inputRef: RefObject<HTMLElement | null>;
}) {
  return (
    <CommandSuggestions
      id={picker.id}
      open={picker.open}
      anchorRef={anchorRef}
      inputRef={inputRef}
      items={picker.items.map((item) => ({
        ...item,
        icon: contextChoiceIcon(item),
        trailing:
          item.kind === "page" ? (
            <ChevronRight className="ml-auto" aria-hidden="true" />
          ) : undefined,
      }))}
      activeId={picker.activeId}
      onHighlight={picker.highlight}
      onChoose={picker.choose}
      onDismiss={picker.dismiss}
      label="Project context"
      heading={picker.title}
      noun="option"
      empty={picker.items.every((item) => item.kind === "back")}
      emptyText={
        picker.title === "Add to conversation"
          ? "No matches. Try another name."
          : `No matching ${picker.title.toLocaleLowerCase()} yet.`
      }
    />
  );
}
