import { useEffect, useRef, useState } from "react";
import { IdeaReviewSurface, IdeaReviewPending } from "./IdeaReviewSurface";
import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import { Feedback } from "../ui/Toast";
import { useIdeaGuidance } from "./useIdeaGuidance";
import {
  guidanceFollowUp,
  sameGuidanceQuestion,
} from "../../../../packages/domain/src/ideaGuidance";
import {
  materializeIdea,
  insertIdeaQuestionBlock,
  availableIdeaWritingPrompts,
  ideaWritingPrompts,
  type IdeaDocument,
  type IdeaField,
} from "../../../../packages/domain/src/ideaDocument";
import {
  flatBlocks,
  blockText,
  textBlock,
  type IdeaBlock,
} from "../../../../packages/domain/src/ideaBlocks";
import type { Idea } from "../../../../packages/domain/src/library";
import "./focused-idea-guidance.css";
import { preservesIdeaReadiness } from "../../../../packages/domain/src/ideaReadiness";
export function FocusedIdeaGuidance({
  idea,
  body,
  document: doc,
  paused,
  locked,
  visible,
  mobileView,
  onChoose,
  onBlocks,
  onSave,
  onFocus,
}: {
  idea: Idea;
  body: string;
  document: IdeaDocument;
  paused: boolean;
  locked: boolean;
  visible: boolean;
  mobileView: string;
  onChoose: (field: IdeaField) => void;
  onBlocks: (blocks: IdeaBlock[]) => void;
  onSave: () => Promise<boolean>;
  onFocus: (id: string) => void;
}) {
  const [wide, setWide] = useState(
    () => matchMedia("(min-width: 1101px)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(min-width: 1101px)");
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const guidance = useIdeaGuidance(
    idea,
    paused,
    visible && (wide || mobileView === "guide"),
  );
  const [actionError, setActionError] = useState(""),
    [notice, setNotice] = useState(""),
    [acting, setActing] = useState(false);
  const availablePrompts = availableIdeaWritingPrompts(body, doc);
  const run = guidance.run;
  const ready =
    run?.status === "completed" &&
    !!run.readinessBasis &&
    preservesIdeaReadiness(run.readinessBasis, body, doc);
  const result =
    run?.result?.outcome === "ready" && !ready ? null : run?.result;
  const readinessCleared = !!run?.readinessBasis && !ready;
  const heading = useRef<HTMLHeadingElement>(null);
  // Run status protects the same saved writing even after a lost browser response.
  const unresolved =
    !!run && ["reserved", "running", "unknown"].includes(run.status);
  const pending =
    guidance.busy || run?.status === "reserved" || run?.status === "running";
  const legacy = !!result && result.outcome === undefined;
  const reviewed =
    ready ||
    (!!result &&
      result.outcome !== "ready" &&
      guidance.current &&
      run?.status === "completed" &&
      !legacy);
  const allowanceReached = run?.allowance?.remaining === 0;
  const followUp = run?.followUp || guidanceFollowUp(result, body, doc);
  const answerBlock = followUp
    ? flatBlocks(materializeIdea(body, doc).document.blocks).find(
        (block) =>
          block.id === followUp.blockId &&
          block.type === "reviewAnswer" &&
          sameGuidanceQuestion(
            String(block.props.prompt || ""),
            followUp.question,
          ),
      )
    : undefined;
  const continuation =
    answerBlock && (!guidance.current || !result?.question)
      ? {
          blockId: answerBlock.id,
          question: followUp!.question,
          answered: !!blockText(answerBlock).trim(),
        }
      : null;

  const evidence = [
    ...(result?.finding?.evidence || []),
    ...(result?.question?.evidence || []),
  ].filter(
    (item, index, all) =>
      all.findIndex(
        (other) =>
          other.sourceId === item.sourceId && other.quote === item.quote,
      ) === index,
  );
  useEffect(() => setNotice(""), [run?.runId]);
  async function questionAction(action: "answer" | "keep" | "dismiss") {
    const question = result?.question;
    if (!question || !guidance.current || locked || acting) return;
    setActing(true);
    setActionError("");
    try {
      if (action !== "dismiss") {
        const blocks = materializeIdea(body, doc).document.blocks;
        const existing = flatBlocks(blocks).find((b) =>
          action === "answer"
            ? b.type === "reviewAnswer" &&
              sameGuidanceQuestion(String(b.props.prompt), question.text)
            : b.type === "openQuestion" &&
              doc.questions.some(
                (q) =>
                  q.id === b.id && sameGuidanceQuestion(q.text, question.text),
              ),
        );
        const id = existing?.id || crypto.randomUUID();
        if (!existing)
          onBlocks(
            insertIdeaQuestionBlock(
              blocks,
              textBlock(
                id,
                action === "answer" ? "" : question.text,
                action === "answer" ? "reviewAnswer" : "openQuestion",
                action === "answer"
                  ? { prompt: question.text }
                  : { important: false },
              ),
            ),
          );
        if (!(await onSave()))
          throw new Error(
            "The question is in your draft. Save it before continuing.",
          );
        onFocus(id);
      }
      // Starting an answer is not evidence that it has already been answered.
      await guidance.feedback(action === "dismiss" ? "dismissed" : "kept");
      setNotice(
        action === "dismiss"
          ? "Question dismissed."
          : action === "keep"
            ? "Question kept in your document."
            : "Continue with your answer in the document.",
      );
      if (action === "dismiss")
        requestAnimationFrame(() =>
          heading.current?.focus({ preventScroll: true }),
        );
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActing(false);
    }
  }
  return (
    <div className="focused-guidance" aria-label="Idea guidance">
      <div className="focused-guidance-intro">
        <h2 ref={heading} tabIndex={-1}>
          Review
        </h2>
        {!result &&
          !pending &&
          !continuation &&
          run?.status !== "completed" && (
            <p>
              Clarify your idea so a project can start with the right context.
            </p>
          )}
      </div>
      {guidance.error && <Feedback tone="error" message={guidance.error} />}
      {actionError && <Feedback tone="error" message={actionError} />}
      <span className="sr-only" role="status">
        {!pending && result && !continuation ? "Review ready." : ""}
      </span>
      <IdeaReviewSurface
        mode={
          pending
            ? "pending"
            : result
              ? `result-${run?.runId}`
              : run?.status || "idle"
        }
      >
        {pending && (
          <IdeaReviewPending followingAnswer={!!continuation?.answered} />
        )}
        {run?.status === "unknown" && !pending && (
          <div className="idea-review-message" role="status">
            <p>
              This review is taking longer to confirm. Your writing is saved.
            </p>
            <Button variant="quiet" onClick={guidance.check}>
              Check review status
            </Button>
            <p className="idea-field-hint">
              Checking does not start another review.
            </p>
          </div>
        )}
        {run?.status === "failed" && (
          <p role="status">
            A useful review could not be produced. Your writing is saved and no
            review was used from your allowance.
          </p>
        )}
        {run?.status === "cancelled" && (
          <p role="status">
            The review did not start. Your allowance is unchanged.
          </p>
        )}
        {continuation && !pending && (
          <section
            className="focused-continuation"
            aria-label="Continue your review"
          >
            <h3>
              {continuation.answered
                ? "Build on your answer"
                : "Your next thought"}
            </h3>
            <p>
              {continuation.answered
                ? paused
                  ? "Your answer is being saved."
                  : "Your answer is saved. Review it with the rest of your idea."
                : "Answer the question in your document, then continue the review when you’re ready."}
            </p>
            <Button
              variant="inline"
              onClick={() => onFocus(continuation.blockId)}
            >
              {continuation.answered
                ? "Back to your answer"
                : "Write your answer"}
            </Button>
            <Disclosure title="Question you’re answering" variant="plain">
              <p>{continuation.question}</p>
            </Disclosure>
          </section>
        )}
        {!result &&
          !pending &&
          !continuation &&
          run?.status === "completed" && (
            <p className="idea-field-hint">
              {readinessCleared
                ? "Some reviewed content was removed. You can review this version when you’re ready."
                : "Your writing has changed since the last review. Review this version when you’re ready."}
            </p>
          )}
        {result && !pending && !continuation && (
          <>
            {!guidance.current && !ready && (
              <p className="idea-field-hint">
                Based on earlier writing. Review the latest version when you are
                ready.
              </p>
            )}
            {legacy && (
              <p className="idea-field-hint">
                This is an earlier review. Review again to focus on your idea’s
                direction and leave detailed planning for the project.
              </p>
            )}
            {result.outcome === "ready" && (
              <div className="focused-finding">
                <h3>Ready to start a project</h3>
                <p>
                  Your idea gives the project a useful starting point. You can
                  keep adding notes here or choose Create project to work
                  through the details.
                </p>
              </div>
            )}
            {result.finding && (
              <div className="focused-finding">
                <h3>{result.finding.title}</h3>
                <p>{result.finding.detail}</p>
                {!result.question && result.finding.nextStep && !notice && (
                  <p className="focused-next-step">{result.finding.nextStep}</p>
                )}
              </div>
            )}
            {result.question ? (
              <section
                className="focused-question"
                aria-label="Suggested question"
              >
                <p className="focused-question-text">{result.question.text}</p>
                {!result.finding && <p>{result.question.why}</p>}
                <div className="focused-question-actions">
                  <Button
                    disabled={locked || !guidance.current || acting}
                    onClick={() => void questionAction("answer")}
                  >
                    Answer in document
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={
                      locked ||
                      !guidance.current ||
                      acting ||
                      doc.questions.length >= 12
                    }
                    onClick={() => void questionAction("keep")}
                  >
                    Keep question
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={locked || !guidance.current || acting}
                    onClick={() => void questionAction("dismiss")}
                  >
                    Dismiss
                  </Button>
                </div>
              </section>
            ) : notice ? (
              <p className="focused-stop" role="status">
                {notice}
              </p>
            ) : result.outcome === "clarify" ? (
              <p className="focused-stop">
                You can leave this question open and start a project whenever
                you’re ready.
              </p>
            ) : null}
            {evidence.length > 0 && (
              <Disclosure title="Based on your writing" variant="plain">
                {evidence.map((item, index) => (
                  <blockquote key={index}>{item.quote}</blockquote>
                ))}
              </Disclosure>
            )}
            {result.recognition.length > 0 && (
              <Disclosure
                title={legacy ? "Earlier summary" : "What I understood"}
                variant="plain"
              >
                <div className="focused-recognition">
                  {result.recognition.map((item) => (
                    <p key={item.summary}>{item.summary}</p>
                  ))}
                </div>
              </Disclosure>
            )}
          </>
        )}
      </IdeaReviewSurface>
      {guidance.available && (
        <div className="focused-review-action">
          <Button
            variant={continuation ? "primary" : "secondary"}
            disabled={
              paused ||
              locked ||
              guidance.busy ||
              guidance.checking ||
              unresolved ||
              run?.allowance?.remaining === 0 ||
              (!!continuation && !continuation.answered) ||
              (reviewed && !continuation?.answered)
            }
            onClick={() =>
              guidance.review(
                continuation?.answered ? continuation.blockId : undefined,
              )
            }
          >
            {guidance.checking
              ? "Checking review…"
              : pending
                ? "Reviewing…"
                : continuation
                  ? "Continue review"
                  : reviewed
                    ? "Reviewed"
                    : readinessCleared ||
                        legacy ||
                        run?.status === "failed" ||
                        run?.status === "cancelled"
                      ? "Review again"
                      : result && !guidance.current
                        ? "Review latest writing"
                        : "Review idea"}
          </Button>
          {allowanceReached && (!reviewed || continuation?.answered) && (
            <p className="idea-field-hint" role="status">
              Your review allowance has been reached. Your idea is saved, and
              you can still create a project or keep developing it manually.
            </p>
          )}
        </div>
      )}
      {availablePrompts.length > 0 && (
        <Disclosure title="Writing prompts" variant="plain">
          <div className="focused-manual-prompts">
            {availablePrompts.map((value) => (
              <Button
                variant="inline"
                className="h-auto min-h-control-sm w-full justify-start whitespace-normal px-0 py-1 text-left"
                key={value}
                disabled={locked}
                onClick={() => onChoose(value)}
              >
                {ideaWritingPrompts[value]}
              </Button>
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}
