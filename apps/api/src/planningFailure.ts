import { ZodError } from "zod";
import { PlanningUpdateError } from "../../../packages/domain/src/projectPlanning";
import { GuidanceFailure } from "./openaiGuidance";

export type PlanningStage =
  | "admission"
  | "planning"
  | "create_conversation"
  | "source_lookup"
  | "history_lookup"
  | "consultation"
  | "specialist"
  | "group_reply"
  | "plan_validation"
  | "plan_save";

// Only fixed messages and codes may enter durable diagnostics. A thrown error
// or malformed tool result can otherwise contain private input/provider data.
const knownFailures: Record<string, { code: string; message: string }> = {
  "The requested specialist is unavailable.": {
    code: "specialist_unavailable",
    message:
      "The reply requested a specialist that could not be selected. Your thought is saved; try again.",
  },
  "This specialist is no longer available.": {
    code: "specialist_unavailable",
    message:
      "The selected specialist is no longer available. Your thought is saved; choose another specialist or try again.",
  },
  "The specialist returned an unsupported response.": {
    code: "invalid_specialist_response",
    message:
      "The specialist's response could not be used. Your thought is saved; try again.",
  },
  "Conversation unavailable.": {
    code: "conversation_unavailable",
    message:
      "The requested conversation could not be found. Your thought is saved; try again.",
  },
  "Message unavailable.": {
    code: "history_message_unavailable",
    message:
      "The requested earlier message could not be found. Your thought is saved; try again.",
  },
  "Project source unavailable.": {
    code: "source_unavailable",
    message:
      "The requested project source is unavailable. Your thought is saved; check its sources before trying again.",
  },
};

// Expected app errors already contain useful, authored recovery instructions.
const recoveryMessages = [
  "Your planning allowance has been reached. You can keep adding and editing thoughts.",
  "A previous reply is still being checked. Your thought is saved.",
  "The project changed. Reload the saved project before continuing.",
  "Discussion is unavailable for this account. You can keep adding and editing thoughts.",
  "The reply could not be confirmed. Your writing is saved; check the saved conversation before trying again.",
  "The project changed while working. Reopen the conversation to continue.",
  "The conversation reached its work limit.",
  "The conversation reached its work limit. Your writing is saved.",
  "This discussion reached its usage limit. Your writing is saved.",
  "This discussion has too much context for one request. Your writing is saved.",
  "This project is too large for one discussion request. Your writing and visual workspace remain available.",
  "The reply's usage could not be confirmed. Reopen the conversation before trying again.",
  "Your writing is saved. The reply is still being checked.",
  "The new agent conversation could not be saved.",
  "The project source lookup limit was reached.",
  "A selected project source is unavailable. Remove it or restore the source.",
  "Select up to six files for one discussion.",
  "Attachment reading is unavailable. Your files are saved.",
  "Project source reading is unavailable. Your writing is saved.",
  "An attachment could not be read. Your message is kept.",
  "Attachments are too large for this discussion. Send fewer files or save them as a thought.",
  "Use at most 12 MB of readable attachments per message. Your files and thought are kept.",
  "These attachments exceed the discussion limit. Use a shorter excerpt or fewer files.",
  "This agent is archived. Choose another conversation.",
  "This agent's proposed changes reach outside its project branches.",
  "This connection belongs to another project branch.",
  "This suggestion belongs to another project branch.",
  "The group update included an unrequested suggestion. Your writing is saved.",
  "The agent returned an unsupported group response.",
  "The agent referred to an unavailable group message.",
  "The agent invited someone outside this conversation.",
  "A listening agent cannot send a reply or invitation.",
];

export function planningFailure(error: unknown, stage: PlanningStage) {
  if (error instanceof GuidanceFailure) {
    if (!error.usage)
      return {
        code: "provider_outcome_unknown",
        message:
          "The reply was interrupted. Your writing is saved; another paid attempt is paused while its outcome is checked.",
      };
    return {
      code:
        error.code === "response_incomplete"
          ? "provider_response_incomplete"
          : "provider_response_invalid",
      message:
        error.code === "response_incomplete"
          ? "The reply ended before it was complete. Your thought is saved; try again."
          : "The reply could not be added safely. Your writing is saved.",
    };
  }
  if (error instanceof PlanningUpdateError)
    return { code: "plan_update_rejected", message: error.message };
  if (error instanceof ZodError)
    return {
      code: "invalid_tool_arguments",
      message:
        stage === "consultation"
          ? "The specialist request was invalid. Your thought is saved; try again."
          : stage === "specialist"
            ? "The specialist's response could not be used. Your thought is saved; try again."
            : "The reply included an invalid action. Your thought is saved; try again.",
    };
  if (error instanceof Error) {
    const known = Object.hasOwn(knownFailures, error.message)
      ? knownFailures[error.message]
      : undefined;
    if (known) return known;
    if (recoveryMessages.includes(error.message))
      return { code: "operation_stopped", message: error.message };
  }
  return {
    code: "operation_failed",
    message:
      "The reply couldn't be completed. Your thought is saved; try again.",
  };
}
