import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCanaryLedger,
  saveCanaryLedger,
  lockCanaryLedger,
  recoverCanaryReservations,
} from "../scripts/guidanceCanaryLedger";
test("canary fails closed on missing/corrupt accounting and atomically preserves uncertain spending", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-ledger-")),
    file = path.join(dir, "ledger.json");
  try {
    assert.throws(() => readCanaryLedger(file));
    fs.writeFileSync(file, "{");
    assert.throws(() => readCanaryLedger(file));
    saveCanaryLedger(file, {
      budget: 1000000,
      spent: 123,
      reserved: 900,
      runs: [
        {
          model: "test",
          name: "settled",
          reserve: 200,
          status: "completed",
          usage: { costMicrousd: 123 },
        },
        {
          model: "test",
          name: "before",
          reserve: 100,
          status: "reserved",
          ledgerVersion: 2,
        },
        {
          model: "test",
          name: "after",
          reserve: 300,
          status: "running",
          ledgerVersion: 2,
          startedAt: "sent",
        },
        { model: "test", name: "legacy", reserve: 500, status: "reserved" },
      ],
    });
    const release = lockCanaryLedger(path.join(dir, "lock"));
    assert.throws(() => lockCanaryLedger(path.join(dir, "lock")), /running/);
    const state = readCanaryLedger(file);
    recoverCanaryReservations(state);
    saveCanaryLedger(file, state);
    assert.equal(readCanaryLedger(file).reserved, 800);
    assert.equal(state.spent, 123);
    assert.equal(state.runs[2].status, "unknown");
    // A crash before rename leaves the prior complete ledger readable.
    fs.writeFileSync(file + ".interrupted.tmp", "{");
    assert.equal(readCanaryLedger(file).reserved, 800);
    release();
    fs.writeFileSync(
      path.join(dir, "lock"),
      JSON.stringify({ pid: 2147483647, token: "dead-process" }),
    );
    lockCanaryLedger(path.join(dir, "lock"))();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
