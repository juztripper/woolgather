import assert from "node:assert/strict";
import test from "node:test";
import { voiceTranscriptTurns } from "../apps/web/src/projects/voiceTranscript";

test("saved voice deltas read as complete speaker turns without changing source text", () => {
  const fragments = [
    ...["Hello", " there", ", what", " should", " we do", " next?"].map(
      (text, index) => ({
        speaker: "user" as const,
        text,
        startMs: index * 100,
        endMs: (index + 1) * 100,
      }),
    ),
    { speaker: "assistant" as const, text: "Let’s ", startMs: 700, endMs: 800 },
    { speaker: "assistant" as const, text: "plan.", startMs: 800, endMs: 900 },
    { speaker: "user" as const, text: "Yes.", startMs: 1000, endMs: 1100 },
  ];
  const original = structuredClone(fragments);
  assert.deepEqual(voiceTranscriptTurns(fragments), [
    {
      speaker: "user",
      text: "Hello there, what should we do next?",
      startMs: 0,
      endMs: 600,
    },
    { speaker: "assistant", text: "Let’s plan.", startMs: 700, endMs: 900 },
    { speaker: "user", text: "Yes.", startMs: 1000, endMs: 1100 },
  ]);
  assert.deepEqual(fragments, original);
  assert.deepEqual(voiceTranscriptTurns([]), []);
});

test("transcript joining preserves token splits, multilingual text and whitespace", () => {
  const fragments = [
    "pro",
    "ject",
    " — ",
    "你好",
    "。",
    "\nNext paragraph.",
  ].map((text) => ({
    speaker: "user" as const,
    text,
    startMs: 0,
    endMs: 100,
  }));
  assert.equal(
    voiceTranscriptTurns(fragments)[0].text,
    "project — 你好。\nNext paragraph.",
  );
});
