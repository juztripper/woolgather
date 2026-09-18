import { testDatabaseBootstrap } from "./test-database-bootstrap.mjs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
let bin = process.env.PG_BIN;
if (!bin) {
  try {
    bin = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
  } catch {}
}
if (!bin || !existsSync(join(bin, "initdb"))) {
  try {
    bin = join(
      execFileSync("brew", ["--prefix", "postgresql@18"], {
        encoding: "utf8",
      }).trim(),
      "bin",
    );
  } catch {
    throw new Error(
      "Install PostgreSQL 18 or set PG_BIN to its bin directory.",
    );
  }
}
const dir = await mkdtemp(join(tmpdir(), "woolgather-test-"));
const port = process.env.PG_TEST_PORT || "55439";
const exec = (name, args) =>
  execFileSync(join(bin, name), args, { stdio: ["ignore", "pipe", "pipe"] });
let started = false;
try {
  exec("initdb", [
    "-D",
    join(dir, "data"),
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  exec("pg_ctl", [
    "-D",
    join(dir, "data"),
    "-l",
    join(dir, "postgres.log"),
    "-o",
    `-p ${port} -h 127.0.0.1 -k ${dir}`,
    "start",
  ]);
  started = true;
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const bootstrap = testDatabaseBootstrap;
  exec("psql", [url, "-v", "ON_ERROR_STOP=1", "-c", bootstrap]);
  for (const file of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    exec("psql", [
      url,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      join("supabase/migrations", file),
    ]);
  const files = (await readdir("tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => join("tests", f));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    {
      stdio: "inherit",
      env: { ...process.env, TEST_DATABASE_URL: url, PG_BIN: bin },
    },
  );
  if (result.status !== 0) process.exitCode = result.status || 1;
  else {
    // Include actual semantic data, not just empty tables, in recovery proof.
    const owner = crypto.randomUUID(),
      project = crypto.randomUUID(),
      item = crypto.randomUUID();
    const create = JSON.stringify({
      id: crypto.randomUUID(),
      projectId: project,
      expectedRevision: 0,
      action: {
        type: "create_project",
        name: "Recovery proof",
        description: "Synthetic durable data",
      },
    });
    const add = JSON.stringify({
      id: crypto.randomUUID(),
      projectId: project,
      expectedRevision: 1,
      action: {
        type: "add_item",
        itemId: item,
        item: {
          title: "Optional reminder",
          body: "Possibly later; outside the first release.",
          category: "feature",
          certainty: "tentative",
          status: "open",
          answer: "",
          links: [],
        },
      },
    });
    const recoveryImageId = crypto.randomUUID();
    const recoveryImage = JSON.stringify({
      id: recoveryImageId,
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    });
    const recoveryIdea = JSON.stringify({
      id: crypto.randomUUID(),
      targetId: crypto.randomUUID(),
      expectedRevision: 0,
      type: "save_idea",
      body: "A tentative idea preserved across recovery.",
      document: {
        version: 1,
        title: "Recovery idea",
        answers: {
          purpose: "Preserve context",
          audience: "Project creators",
          experience: "Reopen an idea",
          context: "",
          constraints: "",
          possibilities: "Maybe later",
        },
        covered: [],
        later: [],
        questions: [],
        references: [
          {
            id: recoveryImageId,
            name: "Recovery reference.png",
            caption: "An image preserved through restart and restore",
          },
        ],
      },
    });
    const recoveryFolder = JSON.stringify({
      id: crypto.randomUUID(),
      targetId: crypto.randomUUID(),
      expectedRevision: 0,
      type: "save_folder",
      name: "Recovery folder",
    });
    exec("psql", [
      url,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `insert into auth.users(id) values('${owner}'); insert into auth.sessions(id,user_id) values('${owner}','${owner}'); begin; set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); select set_config('request.jwt.claims','{"session_id":"${owner}","aal":"aal1"}',true); select public.execute_command('${create}'::jsonb); select public.execute_command('${add}'::jsonb); select public.upload_reference_image('${recoveryImage}'::jsonb); select public.library_command('${recoveryIdea}'::jsonb); select public.library_command('${recoveryFolder}'::jsonb); commit;`,
    ]);
    const snapshot = `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); select set_config('request.jwt.claims','{"session_id":"${owner}","aal":"aal1"}',true); select public.project_snapshot('${project}'); select public.library_snapshot(); select public.reference_image('${recoveryImageId}'); rollback;`;
    const before = exec("psql", [url, "-At", "-c", snapshot]).toString();
    exec("pg_ctl", [
      "-D",
      join(dir, "data"),
      "-l",
      join(dir, "postgres.log"),
      "-m",
      "fast",
      "restart",
    ]);
    const reopened = exec("psql", [url, "-At", "-c", snapshot]).toString();
    if (before !== reopened)
      throw new Error("Project changed across database restart.");
    // Restore migrations and semantic data from a logical backup into an empty database.
    const protectedTablesQuery =
      "select string_agg(c.relname::text, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='planning' and c.relkind='r' and c.relrowsecurity;";
    const protectedTables = exec("psql", [
      url,
      "-At",
      "-c",
      protectedTablesQuery,
    ])
      .toString()
      .trim();
    exec("pg_dump", [
      url,
      "--format=custom",
      "--file",
      join(dir, "restore-proof.dump"),
    ]);
    exec("createdb", [
      "-h",
      "127.0.0.1",
      "-p",
      port,
      "-U",
      "postgres",
      "restore_proof",
    ]);
    exec("pg_restore", [
      "--dbname",
      `postgres://postgres@127.0.0.1:${port}/restore_proof`,
      "--exit-on-error",
      join(dir, "restore-proof.dump"),
    ]);
    const restored = exec("psql", [
      `postgres://postgres@127.0.0.1:${port}/restore_proof`,
      "-At",
      "-c",
      protectedTablesQuery,
    ])
      .toString()
      .trim();
    if (!protectedTables || restored !== protectedTables)
      throw new Error(
        "Restored database did not retain all RLS-protected tables.",
      );
    const recovered = exec("psql", [
      `postgres://postgres@127.0.0.1:${port}/restore_proof`,
      "-At",
      "-c",
      snapshot,
    ]).toString();
    if (recovered !== before)
      throw new Error("Restored project differs from original data.");
    console.log(
      `PASS: fresh migration replay, database restart, and logical backup restore preserve the exact project, structured idea, image bytes, folder, tentative meaning, and all ${protectedTables.split(",").length} RLS-protected tables.`,
    );
  }
} finally {
  if (started) exec("pg_ctl", ["-D", join(dir, "data"), "-m", "fast", "stop"]);
  await rm(dir, { recursive: true, force: true });
}
