import type { PlanningWork } from "../../../../packages/domain/src/projectConversations";
import type { PlanningTurn } from "../../../../packages/domain/src/projectPlanning";

export const narrativeActivity =
  /^(Thinking|Working|.+ is thinking|.+ is working)$/;
const routineActivity =
  /^(Writing a reply|.+ is replying|Saving the reply|Saved the reply|Updating the plan|Updated the plan)$/;
const legacyNarrative =
  /^(Reviewed project context|Brought the findings together|.+ replied|.+ read the conversation)$/;
export const failureActivityLabel = "Reply stopped";

export function workPresentation({
  status,
  pending = false,
  replying = false,
  completedAt,
  interrupted: interruptedProp = false,
}: {
  status?: PlanningTurn["status"];
  pending?: boolean;
  replying?: boolean;
  completedAt?: string;
  interrupted?: boolean;
}) {
  const isPending = status === "pending" || (status === undefined && pending);
  const interrupted =
    interruptedProp && (status === undefined || status === "pending");
  const failed = status === "failed";
  const stale = status === "stale";
  const cancelled = status === "cancelled";
  const stopped = interrupted || failed || stale || cancelled;
  const working = !stopped && isPending && !replying && !completedAt;
  const complete =
    !stopped &&
    (status === "complete" ||
      status === "saved" ||
      (isPending && (Boolean(completedAt) || replying)) ||
      (status === undefined && (Boolean(completedAt) || replying)));
  return {
    cancelled,
    complete,
    failed,
    interrupted,
    isPending,
    stale,
    stopped,
    working,
  };
}

/** Older saved turns include bookkeeping that is not useful work to disclose. */
export function visibleWorkActivity(activity: PlanningWork["activity"] = []) {
  return activity.flatMap((entry) => {
    // Thought links already show item changes. Suggestion/connection/source
    // updates have no changedIds, so retain their acknowledged save summary.
    if (
      routineActivity.test(entry.label) &&
      !(
        entry.label === "Updated the plan" &&
        /\b(?:suggestions?|connections?|sources?)\b/.test(entry.detail || "")
      )
    )
      return [];
    const narrative =
      narrativeActivity.test(entry.label) || legacyNarrative.test(entry.label);
    if (narrative && !entry.detail?.trim()) return [];
    return [
      {
        ...entry,
        label: legacyNarrative.test(entry.label) ? "Thinking" : entry.label,
      },
    ];
  });
}

/** The server stores one safe, user-facing reason with failed turns. */
export function failureWorkActivity(activity: PlanningWork["activity"] = []) {
  return [...visibleWorkActivity(activity)]
    .reverse()
    .find((entry) => entry.label === failureActivityLabel);
}

export function failureWorkReason(activity: PlanningWork["activity"] = []) {
  const detail = failureWorkActivity(activity)?.detail?.trim();
  return detail || undefined;
}
