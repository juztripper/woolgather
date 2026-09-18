import test from "node:test";
import assert from "node:assert/strict";
import { partialJsonString } from "../apps/api/src/partialJson";
import { fetchPlanningTool } from "../apps/api/src/openaiPlanning";
import { GuidanceFailure } from "../apps/api/src/openaiGuidance";
import {
  readEventStream,
  encodeEvent,
} from "../packages/domain/src/eventStream";
import { planningEventChannel } from "../apps/api/src/planningStream";
import { readPlanningStream } from "../apps/web/src/projects/readPlanningStream";
import {
  updatePlanningLive,
  type PlanningLiveState,
} from "../packages/domain/src/planningStream";

const bytes = (data: Uint8Array, step = 1) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < data.length; i += step)
        c.enqueue(data.slice(i, i + step));
      c.close();
    },
  });
const providerBody = JSON.stringify({
  model: "gpt-5.6-sol",
  reasoning: { effort: "low" },
  max_output_tokens: 800,
  tools: [{ name: "develop_project" }],
});
const final = {
  id: "resp_test",
  model: "gpt-5.6-sol",
  status: "completed",
  service_tier: "default",
  usage: {
    input_tokens: 30,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 25,
    output_tokens_details: { reasoning_tokens: 4 },
  },
  output: [
    {
      type: "function_call",
      id: "call",
      name: "develop_project",
      arguments: JSON.stringify({ reply: "Hello 🌿\nnext" }),
    },
  ],
};

test("partial JSON exposes only the chosen top-level text across every character boundary", () => {
  const text = 'Say "hello", then \\ walk.\n🌿';
  const json = JSON.stringify({
    nested: { reply: "DO NOT DISPLAY" },
    reply: text,
    other: "PRIVATE",
  });
  let last = "";
  for (let i = 0; i <= json.length; i++) {
    const value = partialJsonString(json.slice(0, i), "reply");
    if (value !== undefined) {
      assert.ok(text.startsWith(value));
      assert.ok(value.startsWith(last));
      last = value;
    }
  }
  assert.equal(last, text);
  assert.equal(
    partialJsonString('{"text":null,"reply":"not text"}', "text"),
    undefined,
  );
  assert.equal(partialJsonString('{"reply":"\\uD83C', "reply"), "");
  assert.equal(partialJsonString('{"reply":"\\uD83C\\uDF3F"}', "reply"), "🌿");
});

test("SSE handles split UTF-8, CRLF frames and comments, and rejects truncation and excessive bytes", async () => {
  const events: string[] = [];
  await readEventStream(
    bytes(
      new TextEncoder().encode(
        ": heartbeat\r\n\r\ndata: 🌿\r\ndata: two\r\n\r\n",
      ),
    ),
    (s) => {
      events.push(s);
    },
  );
  assert.deepEqual(events, ["🌿\ntwo"]);
  await assert.rejects(
    readEventStream(
      bytes(new TextEncoder().encode("data: unfinished")),
      () => {},
    ),
    /during an event/,
  );
  await assert.rejects(
    readEventStream(bytes(encodeEvent({ text: "long" })), () => {}, 4),
    /size limit/,
  );
});

test("provider streams public text and summaries before completion and retains validated usage", async () => {
  let accumulated = "",
    summary = "",
    commentary = "";
  const provider: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    assert.equal(request.stream, true);
    assert.equal(request.reasoning.summary, "auto");
    return new Response(
      new ReadableStream({
        start(c) {
          for (const [id, phase, text] of [
            ["progress", "commentary", "I’ll check the saved constraints."],
            ["final-message", "final_answer", "NOT A PROGRESS UPDATE"],
          ]) {
            c.enqueue(
              encodeEvent({
                type: "response.output_item.added",
                item: { id, type: "message", role: "assistant", phase },
              }),
            );
            for (const delta of text.split(/(?<= )/))
              c.enqueue(
                encodeEvent({
                  type: "response.output_text.delta",
                  item_id: id,
                  delta,
                }),
              );
            c.enqueue(
              encodeEvent({ type: "response.output_text.done", item_id: id }),
            );
          }
          c.enqueue(
            encodeEvent({
              type: "response.reasoning_text.delta",
              delta: "PRIVATE REASONING",
            }),
          );
          c.enqueue(
            encodeEvent({
              type: "response.reasoning_summary_text.delta",
              delta: "Public summary",
            }),
          );
          c.enqueue(
            encodeEvent({
              type: "response.output_item.added",
              item: {
                id: "call",
                type: "function_call",
                name: "develop_project",
              },
            }),
          );
          c.enqueue(
            encodeEvent({
              type: "response.function_call_arguments.delta",
              item_id: "call",
              delta: '{"reply":"Hello ',
            }),
          );
          setTimeout(() => {
            assert.equal(accumulated, "Hello ");
            assert.equal(commentary, "I’ll check the saved constraints.\n\n");
            c.enqueue(
              encodeEvent({
                type: "response.function_call_arguments.delta",
                item_id: "call",
                delta: '🌿\\nnext"}',
              }),
            );
            c.enqueue(
              encodeEvent({ type: "response.completed", response: final }),
            );
            c.close();
          }, 10);
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const result = await fetchPlanningTool(
    providerBody,
    "synthetic",
    undefined,
    provider,
    undefined,
    (event) => {
      if (event.kind === "text") accumulated += event.text;
      if (event.kind === "summary") summary += event.text;
      if (event.kind === "commentary") commentary += event.text;
    },
  );
  assert.equal(accumulated, "Hello 🌿\nnext");
  assert.equal(summary, "Public summary");
  assert.equal(result.usage.outputTokens, 25);
  assert.deepEqual(result.value, { reply: accumulated });
});

test("missing completion stays an unknown outcome; incomplete responses retain known usage", async () => {
  for (const complete of [false, true]) {
    const provider: typeof fetch = async () =>
      new Response(
        bytes(
          encodeEvent(
            complete
              ? {
                  type: "response.incomplete",
                  response: { ...final, status: "incomplete" },
                }
              : { type: "response.created" },
          ),
        ),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    await assert.rejects(
      fetchPlanningTool(
        providerBody,
        "synthetic",
        undefined,
        provider,
        undefined,
        () => {},
      ),
      (error) =>
        error instanceof GuidanceFailure &&
        (complete ? error.usage?.outputTokens === 25 : !error.usage),
    );
  }
});

test("browser accumulates attributed deltas once and accepts only an explicit final receipt", async () => {
  const channel = planningEventChannel();
  let state: PlanningLiveState = {
    turnId: "turn",
    startedAt: "now",
    activity: [],
    messages: [],
  };
  const reading = readPlanningStream(
    channel.response,
    (event) => (state = updatePlanningLive(state, event)),
  );
  channel.emit({
    type: "phase",
    phase: "working",
    at: "2026-09-15T11:00:00.000Z",
  });
  channel.emit({
    type: "activity",
    id: "read",
    label: "Reading a project source",
    detail: "",
  });
  channel.emit({
    type: "phase",
    phase: "answering",
    at: "2026-09-15T11:00:02.000Z",
  });
  channel.emit({
    type: "text",
    id: "a",
    index: 0,
    speaker: { id: "cleo", name: "Cleo" },
    text: "Hello ",
  });
  channel.emit({
    type: "text",
    id: "a",
    index: 0,
    speaker: { id: "cleo", name: "Cleo" },
    text: "there",
  });
  await channel.finish(Response.json({ project: { id: "saved" } }));
  assert.deepEqual((await reading).data, { project: { id: "saved" } });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].text, "Hello there");
  assert.equal(state.phase, "answering");
  assert.equal(state.workCompletedAt, "2026-09-15T11:00:02.000Z");
  const duplicate = {
    type: "progress",
    sequence: 2,
    event: { type: "text", id: "a", index: 0, text: "oops" },
  };
  await assert.rejects(
    readPlanningStream(new Response(bytes(encodeEvent(duplicate))), () => {}),
    /interrupted/,
  );
  await assert.rejects(
    readPlanningStream(
      new Response(
        bytes(
          encodeEvent({
            type: "progress",
            sequence: 1,
            event: duplicate.event,
          }),
        ),
      ),
      () => {},
    ),
    /interrupted/,
  );
});

test("a disconnected or slow browser cannot prevent the server from finishing", async () => {
  const disconnected = planningEventChannel();
  await disconnected.response.body!.cancel();
  disconnected.emit({ type: "activity", id: "a", label: "Done", detail: "" });
  await disconnected.finish(Response.json({ saved: true }));
  const slow = planningEventChannel();
  for (let i = 0; i < 180; i++)
    slow.emit({
      type: "activity",
      id: "a",
      label: "Thinking",
      detail: "x".repeat(6000),
    });
  await slow.finish(Response.json({ saved: true }));
});
