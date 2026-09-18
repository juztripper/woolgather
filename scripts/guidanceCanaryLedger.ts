import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type CanaryRun = {
  id?: string;
  model: string;
  name: string;
  reserve: number;
  status: string;
  promptVersion?: number;
  configVersion?: string;
  ledgerVersion?: number;
  effort?: string;
  startedAt?: string;
  [key: string]: unknown;
};
export type CanaryLedger = {
  budget: number;
  spent: number;
  reserved: number;
  runs: CanaryRun[];
};
export function readCanaryLedger(file: string): CanaryLedger {
  // Funding is initialized once by an operator, never by a test invocation.
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    value.budget !== 1000000 ||
    !Number.isSafeInteger(value.spent) ||
    value.spent < 0 ||
    !Number.isSafeInteger(value.reserved) ||
    value.reserved < 0 ||
    !Array.isArray(value.runs) ||
    value.runs.some(
      (run: CanaryRun) => !Number.isSafeInteger(run.reserve) || run.reserve < 0,
    )
  )
    throw new Error(
      "Invalid canary accounting. Restore and reconcile the existing ledger; do not recreate it.",
    );
  let spent = 0,
    reserved = 0;
  for (const run of value.runs as CanaryRun[]) {
    const usage = run.usage as { costMicrousd?: unknown } | undefined;
    if (usage) {
      if (
        !Number.isSafeInteger(usage.costMicrousd) ||
        Number(usage.costMicrousd) < 0
      )
        throw new Error("Invalid recorded canary usage.");
      spent += Number(usage.costMicrousd);
    } else if (run.status !== "cancelled_before_send") reserved += run.reserve;
  }
  if (spent !== value.spent || reserved !== value.reserved)
    throw new Error(
      "Canary totals do not reconcile with prior attempts. Stop and reconcile; never reset accounting.",
    );
  return value;
}
export function saveCanaryLedger(file: string, state: CanaryLedger) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
export function lockCanaryLedger(file: string) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        const owner = JSON.parse(fs.readFileSync(file, "utf8"));
        if (owner.token === token) fs.unlinkSync(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Serialise stale-lock recovery so two rescuers cannot remove a new lock.
    const recovery = file + ".recovery",
      fd = fs.openSync(recovery, "wx", 0o600);
    try {
      const owner = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !owner.token)
        throw new Error(
          "Unrecognised canary lock. Inspect the process and ledger before recovering it.",
        );
      if (alive(owner.pid)) throw new Error("Another canary is running.");
      fs.unlinkSync(file);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(recovery);
    }
  }
  throw new Error("Could not acquire the canary lock.");
}
export function recoverCanaryReservations(state: CanaryLedger) {
  for (const run of state.runs) {
    // Only the new protocol proves that inference has not been sent yet.
    if (
      run.ledgerVersion === 2 &&
      run.status === "reserved" &&
      !run.startedAt
    ) {
      state.reserved -= run.reserve;
      run.status = "cancelled_before_send";
    } else if (run.status === "running") run.status = "unknown";
  }
  if (state.reserved < 0)
    throw new Error(
      "Canary reservation mismatch; reconcile before continuing.",
    );
}
