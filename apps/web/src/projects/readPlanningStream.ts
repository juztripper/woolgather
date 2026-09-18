import { readEventStream } from "../../../../packages/domain/src/eventStream";
import {
  planningLiveEventSchema,
  type PlanningLiveEvent,
} from "../../../../packages/domain/src/planningStream";

export async function readPlanningStream(
  response: Response,
  onProgress: (event: PlanningLiveEvent) => void,
) {
  if (!response.body) throw new Error("The live reply is unavailable.");
  let result: { status: number; data: unknown } | undefined;
  let sequence = 0;
  await readEventStream(response.body, (raw) => {
    const frame = JSON.parse(raw);
    if (result) throw new Error("Unexpected event after completion.");
    if (frame.type === "progress") {
      if (frame.sequence !== ++sequence)
        throw new Error("The live reply was interrupted.");
      onProgress(planningLiveEventSchema.parse(frame.event));
    } else if (
      frame.type === "result" &&
      Number.isInteger(frame.status) &&
      frame.status >= 200 &&
      frame.status <= 599
    ) {
      result = { status: frame.status, data: frame.data };
      return false;
    } else throw new Error("Invalid live reply.");
  });
  if (!result)
    throw new Error(
      "The live reply was interrupted. Check the saved conversation.",
    );
  return result;
}
