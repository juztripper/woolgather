import { encodeEvent } from "../../../packages/domain/src/eventStream";
import type { PlanningLiveEvent } from "../../../packages/domain/src/planningStream";

/** Disconnecting a reader never retries inference or blocks its settlement. */
export function planningEventChannel() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let sequence = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      cancel() {
        closed = true;
      },
    },
    { highWaterMark: 1_000_000, size: (chunk) => chunk.byteLength },
  );
  const write = (value: unknown) => {
    if (closed) return;
    if ((controller.desiredSize ?? 0) <= 0) {
      closed = true;
      controller.error(
        new Error(
          "The live reader fell behind. Reopen the saved conversation.",
        ),
      );
      return;
    }
    controller.enqueue(encodeEvent(value));
  };
  return {
    response: new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
      },
    }),
    emit(event: PlanningLiveEvent) {
      write({ type: "progress", sequence: ++sequence, event });
    },
    async finish(result: Response) {
      write({
        type: "result",
        status: result.status,
        data: await result.json(),
      });
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
    fail() {
      write({
        type: "result",
        status: 500,
        data: {
          error:
            "The reply was interrupted. Reopen the saved conversation to check it.",
        },
      });
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
  };
}
