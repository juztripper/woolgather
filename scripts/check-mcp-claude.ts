import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

/** Native connection qualification only. No prompts or inference are submitted. */
export async function checkClaude(
  profile: string,
  origin: string,
  projectId: string,
) {
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: profile,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
  };
  const run = (args: string[]) =>
    promisify(execFile)("claude", args, {
      env,
      cwd: join(profile, "workspace"),
      timeout: 20000,
    });
  const version = (await run(["--version"])).stdout.trim();
  await run([
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "local",
    "woolgather",
    `${origin}/mcp`,
  ]);
  // Headless login requires a terminal. Python supplies a disposable PTY without a login shell.
  const child = spawn(
    "python3",
    [
      "-c",
      "import pty, os; status = pty.spawn(['claude', 'mcp', 'login', 'woolgather', '--no-browser']); raise SystemExit(os.waitstatus_to_exitcode(status))",
    ],
    { env, cwd: join(profile, "workspace"), stdio: ["pipe", "pipe", "pipe"] },
  );
  const finished = new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  let output = "";
  const authUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude OAuth start timed out"));
    }, 20000);
    child.stdout.on("data", (data) => {
      output += data.toString();
      const url = output.match(
        /http:\/\/127\.0\.0\.1:4261\/oauth\/authorize[^\s\u0000-\u001f]+/,
      );
      if (url) {
        clearTimeout(timer);
        resolve(url[0]);
      }
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(
        new Error(
          "Claude exited before OAuth started: " +
            output.replace(/https?:\/\/[^\s]+/g, "[URL]").slice(-1200),
        ),
      );
    });
  });
  try {
    const start = await fetch(authUrl, { redirect: "manual" });
    assert.equal(start.status, 302, await start.clone().text());
    const request = new URL(start.headers.get("location")!).searchParams.get(
      "request",
    );
    const approved = await fetch(
      `${origin}/api/mcp/authorization?request=${request}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer owner-session",
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: start.headers.get("set-cookie")!.split(";")[0],
        },
        body: JSON.stringify({ decision: "allow", projectId }),
      },
    );
    assert.equal(approved.status, 200);
    const { redirectTo } = (await approved.json()) as { redirectTo: string };
    child.stdin.write(redirectTo + "\n");
    const timeout = setTimeout(() => child.kill(), 25000);
    const code = await finished;
    clearTimeout(timeout);
    assert.equal(code, 0, "Claude OAuth login failed");
    assert.match(
      (await run(["mcp", "get", "woolgather"])).stdout,
      /Connected/i,
    );
    console.log(
      `PASS ${version}: native OAuth and authenticated MCP connection. Tool execution through Claude remains a separate check; no inference requested.`,
    );
  } finally {
    child.kill();
    await run(["mcp", "logout", "woolgather"]).catch(() => {});
  }
}
