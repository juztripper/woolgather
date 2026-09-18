import { AgentAvatar } from "./AgentAvatar";
import { Bot, FileImage, FileText } from "lucide-react";
import { Fragment } from "react";
import { Button } from "../ui/Button";
import { ProjectSourceThumbnail } from "./ProjectSourceThumbnail";
import { conversationReferenceMatches } from "./conversationReferenceText";

export type ConversationReference = {
  id: string;
  label: string;
  kind: "agent" | "thought" | "source";
  image?: boolean;
  avatar?: string;
  attachmentId?: string;
  onOpen: () => void;
};
export function ConversationReferenceLink({
  reference,
}: {
  reference: ConversationReference;
}) {
  const Icon =
    reference.kind === "agent" ? Bot : reference.image ? FileImage : FileText;
  return (
    <Button
      variant="inline"
      size="xs"
      className="conversation-reference-link inline h-auto min-h-0 gap-0 border-0 p-0 align-baseline text-[length:inherit] font-normal leading-[inherit] whitespace-normal active:not-disabled:scale-100"
      onClick={reference.onOpen}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="conversation-reference-mark" aria-hidden="true">
        {reference.kind === "agent" ? (
          <AgentAvatar
            id={reference.id.replace(/^agent-/, "")}
            avatar={reference.avatar}
            className="agent-avatar--inline"
            quiet
          />
        ) : reference.image && reference.attachmentId ? (
          <ProjectSourceThumbnail attachmentId={reference.attachmentId} />
        ) : (
          <Icon className="size-full" aria-hidden="true" />
        )}
      </span>
      <span>{reference.label}</span>
    </Button>
  );
}
export function ConversationReferences({
  references,
}: {
  references: ConversationReference[];
}) {
  return references.length ? (
    <div className="conversation-reference-list">
      {references.map((reference) => (
        <ConversationReferenceLink key={reference.id} reference={reference} />
      ))}
    </div>
  ) : null;
}
/** Names are presentation only. Every action remains bound to its saved ID. */
export function ConversationContextText({
  text,
  references,
}: {
  text: string;
  references: ConversationReference[];
}) {
  const matched = new Set<string>();
  const parts = [];
  let start = 0;
  for (const match of conversationReferenceMatches(text, references)) {
    const { reference } = match;
    parts.push(
      <Fragment key={`text-${start}`}>
        {text.slice(start, match.start)}
      </Fragment>,
    );
    parts.push(
      <ConversationReferenceLink
        key={`reference-${match.start}`}
        reference={reference}
      />,
    );
    matched.add(reference.id);
    start = match.end;
  }
  parts.push(<Fragment key="tail">{text.slice(start)}</Fragment>);
  return (
    <>
      <p className="conversation-context-text">{parts}</p>
      <ConversationReferences
        references={references.filter(
          (reference) => !matched.has(reference.id),
        )}
      />
    </>
  );
}
