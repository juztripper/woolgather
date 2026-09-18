import type { Project } from "./index";
import { conversationTurns } from "./projectConversations";
import type { PlanningTurn } from "./projectPlanning";
import { z } from "zod";

export const planningInterpretationSchema = z
  .object({
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/),
    intent: z.enum([
      "discussion",
      "authored_update",
      "adopt_existing",
      "prune_duplicates",
    ]),
    reclassifiedThoughtIds: z.array(z.string().max(100)).max(16),
    resolvedThoughtIds: z.array(z.string().max(100)).max(16),
  })
  .strict();
export type PlanningInterpretation = z.infer<
  typeof planningInterpretationSchema
>;
export const planningLanguageInstruction = (language?: string) =>
  language &&
  planningInterpretationSchema.shape.language.safeParse(language).success
    ? `\nUse ${language} as the response language for replies and public progress. This comes from the author's request; quoted reference language does not change it.`
    : "";

export const planningConversationPolicy = `Follow the language of the author's own request, including public progress and specialist findings. Quoted/pasted material, source files, names and an earlier assistant language mistake do not request a language switch. A short acknowledgement continues the author's established language unless they explicitly request another.
Interpret a numbered selection against the immediately preceding options: "3 sounds best" chooses option 3, never all three options. This is explicit authored adoption of that option. When it answers an existing question, preserve that question in its body and put the selected answer in answer with status answered; do not leave it open because different follow-up questions could still be asked. Save the selected meaning with origin author and the evidenceRef for the author's selection; do not leave it as a suggestion. The earlier reply supplies the referent, while the author's selection supplies the authority. Repeat the selected meaning briefly, without reintroducing the unselected options. If the referent is ambiguous, ask one focused question and leave the Plan unchanged for that choice.
Distinguish the player's action, the condition that completes it, and its visible feedback or reward. An icon changing colour describes feedback; it does not by itself specify the gameplay trigger. Keep missing triggers open. When asked what remains, acknowledge decisions already made, name only the remaining consequential uncertainty, and help with one concrete example rather than repeatedly expanding a checklist. Research-dependent advice must be labelled unverified when no current source was actually inspected; never imply a search happened.`;

/** Reference context only. It never substitutes for an authored evidence passage. */
export function planningMeaningContext(
  project: Project,
  pending?: PlanningTurn,
) {
  if (!pending) return null;
  const turns = conversationTurns(project, pending.conversationId || "main");
  const index = turns.findIndex((turn) => turn.id === pending.id);
  const earlier = turns.slice(0, index);
  const previous = earlier.at(-1);
  const choices = previous?.reply.split("\n").flatMap((line) => {
    const match = line.match(/^\s{0,3}(\d{1,2})[.)]\s+(.+)$/);
    return match ? [{ number: Number(match[1]), text: match[2] }] : [];
  });
  // Only annotate one unambiguous, contiguous list and an explicit selection.
  // Never infer a choice from incidental numbers, negation or a multi-choice request.
  const ordinals = ["first", "second", "third", "fourth", "fifth"];
  const selection = pending.text
    .trim()
    .match(
      /^(?:(?:i\s+(?:choose|prefer|pick)|let['’]s\s+(?:choose|pick|go\s+(?:with|for)))\s+)?(?:the\s+)?(?:option\s+)?(\d{1,2}|first|second|third|fourth|fifth)(?:\s+option)?(?:[.!]|\s+(?:please|sounds?\s+(?:the\s+)?best|is\s+(?:the\s+)?best|for\s+me))(?:[\s\S]*)?$/i,
    );
  const number = selection
    ? /^\d+$/.test(selection[1])
      ? Number(selection[1])
      : ordinals.indexOf(selection[1].toLowerCase()) + 1
    : null;
  const selected =
    choices &&
    choices.length >= 2 &&
    choices.every((choice, i) => choice.number === i + 1) &&
    !/\b(?:not|except|or|and|both|all)\b|\d.*\d/i.test(pending.text)
      ? choices.find((choice) => choice.number === number)
      : undefined;
  return {
    activeTurnId: pending.id,
    // Keep the author's lead ahead of pasted reference material. Full text is
    // still present in the evidence catalog; this is a language cue, not a filter.
    authorLanguageSamples: [...earlier.slice(-3), pending].map((turn) =>
      turn.text.split(/\n\s*\n|\n\s*>|```/)[0].slice(0, 400),
    ),
    ...(selected
      ? {
          selectedOption: {
            ...selected,
            fromReplyToTurnId: previous!.id,
            evidenceTurnId: pending.id,
          },
        }
      : {}),
  };
}
