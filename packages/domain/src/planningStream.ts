import { z } from "zod";
import { agentAvatarSchema } from "./agentIdentity";

const speakerSchema = z.object({
  id: z.string().max(80),
  name: z.string().max(120),
  avatar: agentAvatarSchema.optional(),
});
export const planningLiveEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("phase"),
    phase: z.enum(["working", "answering"]),
    at: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("activity"),
    id: z.string().max(120),
    label: z.string().max(120),
    detail: z.string().max(6000),
  }),
  z.object({
    type: z.literal("text"),
    id: z.string().max(120),
    index: z.number().int().min(0).max(2),
    text: z.string().max(12000),
    speaker: speakerSchema.optional(),
  }),
]);
export type PlanningLiveEvent = z.infer<typeof planningLiveEventSchema>;
export type LiveMessage = Extract<PlanningLiveEvent, { type: "text" }>;
export type PlanningLiveState = {
  turnId: string;
  startedAt: string;
  activity: Extract<PlanningLiveEvent, { type: "activity" }>[];
  messages: LiveMessage[];
  phase?: "working" | "answering";
  workCompletedAt?: string;
  interrupted?: boolean;
};
export function updatePlanningLive(
  state: PlanningLiveState,
  event: PlanningLiveEvent,
): PlanningLiveState {
  if (event.type === "phase")
    return {
      ...state,
      phase: event.phase,
      workCompletedAt: event.phase === "answering" ? event.at : undefined,
    };
  const key = event.type === "activity" ? "activity" : "messages";
  const values = state[key];
  const index = values.findIndex((entry) => entry.id === event.id);
  return {
    ...state,
    [key]:
      index < 0
        ? [...values, event].slice(-12)
        : values.map((value, i) => {
            if (i !== index) return value;
            if (event.type === "text" && value.type === "text")
              return {
                ...event,
                text: (value.text + event.text).slice(0, 12000),
              };
            if (event.type === "activity" && value.type === "activity")
              return {
                ...event,
                detail: (value.detail + event.detail).slice(0, 6000),
              };
            return value;
          }),
  };
}
