import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { openVoiceSideband } from "../apps/api/src/voiceSideband";

const require = createRequire(import.meta.url);

test("voice upgrade cancels a stalled handshake", async () => {
  const send = (async (_url: unknown, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    })) as typeof fetch;
  await assert.rejects(
    openVoiceSideband("https://fixture.invalid", {}, send, 10),
    /aborted/,
  );
});

test("workerd voice socket survives the upgrade deadline and repeated exchanges", async (t) => {
  const { WebSocketServer } = require("ws");
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket: { on: Function; send: Function }) => {
    socket.on("message", (message: Buffer) => socket.send(message.toString()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    sockets.close();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bundled = await build({
    stdin: {
      contents: `import {openVoiceSideband} from './apps/api/src/voiceSideband';
      export default {async fetch(request) {
        const fixed = new URL(request.url).pathname === '/fixed';
        const url = 'http://127.0.0.1:${address.port}';
        const headers = {Upgrade:'websocket'};
        const response = fixed ? await openVoiceSideband(url, headers, fetch, 1000)
          : await fetch(url, {headers, signal:AbortSignal.timeout(1000)});
        const ws = response.webSocket;
        ws.accept();
        let received = 0;
        ws.addEventListener('message', () => received++);
        ws.addEventListener('error', () => {});
        ws.send('first');
        await new Promise(resolve => setTimeout(resolve, 1400));
        const stateAfterDeadline = ws.readyState;
        if (stateAfterDeadline === 1) ws.send('second');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (ws.readyState === 1) ws.close(1000);
        return Response.json({stateAfterDeadline, received});
      }};`,
      resolveDir: process.cwd(),
      sourcefile: "voice-sideband-worker.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
  });
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-09-10",
    }),
  );
  try {
    const [broken, fixed] = await Promise.all([
      runtime.dispatchFetch("http://fixture/broken").then((r) => r.json()),
      runtime.dispatchFetch("http://fixture/fixed").then((r) => r.json()),
    ]);
    assert.notEqual(
      (broken as { stateAfterDeadline: number }).stateAfterDeadline,
      1,
    );
    assert.deepEqual(fixed, { stateAfterDeadline: 1, received: 2 });
  } finally {
    await runtime.dispose();
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
