import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { selectBuildThoughts } from "../apps/web/src/projects/buildSelection";
import {
  agentSetup,
  cursorInstallUrl,
  claudeSetupCommand,
} from "../apps/web/src/projects/agentSetup";

const thoughts = Array.from({ length: 80 }, (_, index) => ({
  id: `thought-${index}`,
  title: `Thought ${index}`,
  body: `Criterion ${index}`,
}));

test("large-plan bulk selection is atomic at the version limit and retains edits across search groups", () => {
  const edited = { "thought-0": "My refined criterion" };
  assert.equal(selectBuildThoughts(edited, thoughts), edited);
  const firstGroup = selectBuildThoughts(edited, thoughts.slice(0, 30));
  const nextGroup = selectBuildThoughts(firstGroup, thoughts.slice(30, 50));
  assert.equal(Object.keys(nextGroup).length, 50);
  assert.equal(nextGroup["thought-0"], "My refined criterion");
  assert.equal(selectBuildThoughts(nextGroup, thoughts.slice(50)), nextGroup);
  assert.equal(Object.keys(edited).length, 1);
});

test("Cursor installer preserves a Unicode path as one argument and contains environment references only", () => {
  const folder = "/Users/example/Código & ideas/woolgather/";
  const url = new URL(cursorInstallUrl(folder, "woolgather-project")!);
  assert.equal(url.protocol, "cursor:");
  assert.equal(url.searchParams.get("name"), "woolgather-project");
  const config = JSON.parse(
    Buffer.from(url.searchParams.get("config")!, "base64").toString("utf8"),
  );
  assert.deepEqual(config.args, [
    folder + "packages/agent-connector/bin/woolgather-mcp.mjs",
  ]);
  assert.equal(config.env.WOOLGATHER_TOKEN, "${env:WOOLGATHER_TOKEN}");
  assert.equal(config.env.WOOLGATHER_URL, "${env:WOOLGATHER_URL}");
  for (const invalid of [
    "",
    "relative/path",
    "~/woolgather",
    "/path\nnode malicious",
  ])
    assert.equal(cursorInstallUrl(invalid, "project"), null);
});

test("Claude setup command quotes paths without shell expansion", () => {
  const folder = "/Users/example/it's $(printf unsafe) `printf unsafe` folder";
  const command = claudeSetupCommand(folder, "woolgather-project");
  // Replace the actual CLI with a local function that prints its received arguments.
  const output = execFileSync(
    "/bin/sh",
    ["-c", `claude() { printf '%s\\n' "$@"; }; ${command}`],
    { encoding: "utf8" },
  );
  const args = output.trim().split("\n");
  assert.deepEqual(args.slice(0, 5), [
    "mcp",
    "add-json",
    "--scope",
    "user",
    "woolgather-project",
  ]);
  assert.deepEqual(
    JSON.parse(args[5]),
    agentSetup("claude", folder, "woolgather-project").server,
  );
});

test("configuration safely represents Windows paths and isolates different projects", () => {
  const folder = 'C:\\work\\a "quoted" folder';
  const codex = agentSetup("codex", folder, "woolgather-a").configuration;
  const args = JSON.parse(
    codex
      .split("\n")
      .find((line) => line.startsWith("args = "))!
      .slice(7),
  );
  assert.deepEqual(args, [
    folder + "/packages/agent-connector/bin/woolgather-mcp.mjs",
  ]);
  assert.ok(
    codex.includes('env_vars = ["WOOLGATHER_URL", "WOOLGATHER_TOKEN"]'),
  );
  const a = JSON.parse(
    agentSetup("cursor", "/repo", "woolgather-a").configuration,
  );
  const b = JSON.parse(
    agentSetup("cursor", "/repo", "woolgather-b").configuration,
  );
  assert.deepEqual(Object.keys({ ...a.mcpServers, ...b.mcpServers }), [
    "woolgather-a",
    "woolgather-b",
  ]);
});
