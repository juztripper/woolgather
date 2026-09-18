import { createContext, useContext } from "react";
import { Disclosure } from "../ui/Disclosure";
import {
  ideaWritingPrompts,
  type IdeaField,
} from "../../../../packages/domain/src/ideaDocument";

export type IdeaBlockFocus = { id: string; request: number };
export const IdeaBlockFocusContext = createContext<IdeaBlockFocus | undefined>(
  undefined,
);

/** The content DOM stays mounted when collapsed, preserving the editor's history. */
export function IdeaAnswerBlock({
  block,
  contentRef,
}: {
  block: { id: string; props: { prompt: string; field?: string } };
  contentRef: (node: HTMLElement | null) => void;
}) {
  const focus = useContext(IdeaBlockFocusContext);
  const prompt =
    block.props.prompt || ideaWritingPrompts[block.props.field as IdeaField];
  return (
    <Disclosure
      title={prompt}
      variant="plain"
      className="idea-answer-section"
      defaultOpen
      revealKey={focus?.id === block.id ? focus.request : undefined}
    >
      <div
        className="idea-answer-content"
        ref={contentRef}
        data-placeholder="Write your answer…"
      />
    </Disclosure>
  );
}
