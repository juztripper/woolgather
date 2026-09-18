/** Bounded SSE decoding shared by provider and authenticated browser streams. */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void | boolean,
  maxBytes = 4_000_000,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("Stream exceeded its size limit.");
      buffer += decoder.decode(chunk.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data && data !== "[DONE]" && onData(data) === false) return;
      }
      if (buffer.length > 1_000_000)
        throw new Error("Stream event exceeded its size limit.");
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw new Error("Stream ended during an event.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const encodeEvent = (value: unknown) =>
  new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
