import type { AgentResponse } from "../../../../packages/domain/src/agentConversation";
import { AgentAvatar } from "./AgentAvatar";
import { ProjectText } from "./ProjectText";
import { ConversationMessageActions } from "./ConversationMessageActions";

export function AgentGroupReplies({
  responses,
  turnId,
  disabled,
  onBranch,
  replyDetails,
  streaming = false,
  latest = false,
}: {
  responses: AgentResponse[];
  turnId: string;
  disabled: boolean;
  onBranch: () => void;
  replyDetails?: string;
  streaming?: boolean;
  latest?: boolean;
}) {
  const messages = responses
    .map((r, index) => ({ ...r, index }))
    .filter((r) => r.text);
  return (
    <div className="agent-group-replies">
      {messages.map((message, index) => {
        const previous = messages
          .slice(0, index)
          .findLast((r) => r.agentId === message.replyToAgentId);
        return (
          <div
            className="thinking-reply"
            id={`${turnId}-agent-${message.index}`}
            key={message.index}
          >
            <div className="agent-group-speaker">
              <span className="agent-speaker">
                <AgentAvatar
                  id={message.agentId}
                  avatar={message.avatar}
                  className="agent-avatar--message"
                  quiet
                />
                {message.name}
              </span>
              {previous && (
                <a
                  className="agent-group-reply-to"
                  href={`#${turnId}-agent-${previous.index}`}
                >
                  Replying to {previous.name}
                </a>
              )}
            </div>
            <ProjectText text={message.text!} streaming={streaming} />
            <ConversationMessageActions
              persistent={latest && index === messages.length - 1}
              text={message.text!}
              createdAt={message.createdAt}
              replyDetails={replyDetails}
              disabled={disabled}
              onBranch={index === messages.length - 1 ? onBranch : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

export function AgentReadReceipt({
  responses,
}: {
  responses: AgentResponse[];
}) {
  const listeners = responses.filter(
    (r, index) =>
      !r.text &&
      !responses.some((other) => other.agentId === r.agentId && other.text) &&
      responses.findIndex((other) => other.agentId === r.agentId) === index,
  );
  return listeners.length ? (
    <p className="agent-group-read">
      Read by {listeners.map((r) => r.name).join(" and ")}
    </p>
  ) : null;
}
