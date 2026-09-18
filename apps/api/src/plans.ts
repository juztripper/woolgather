import {
  planSnapshotSchema,
  type PlanSnapshot,
} from "../../../packages/domain/src/plans";
import type { GuidanceRpc } from "./ideaGuidance";
import { repeatGuidanceRpc } from "./ideaGuidance";

export type PlanEnv = { PLAN_ALLOWANCES_ENABLED?: string };
export async function accountPlan(
  rpc: GuidanceRpc,
  allowUnconfigured = false,
): Promise<PlanSnapshot> {
  const result = await rpc("account_plan", {});
  // A disabled rollout must remain compatible with a database that has not
  // received the additive plan migration. Enforced assistance never uses this
  // fallback, and transport/authentication failures still fail closed.
  if (
    allowUnconfigured &&
    result.error &&
    ["PGRST202", "42883"].includes(result.error.code || "")
  )
    return {
      enabled: false,
      testing: false,
      tier: "free",
      credits: 0,
      reservedCredits: 0,
      monthlyCredits: 0,
      welcomeCredits: 0,
      renewsAt: null,
      paidUntil: null,
      voiceSeconds: 0,
      reservedVoiceSeconds: 0,
      storageBytes: 0,
      storageLimitBytes: 100 * 1024 ** 2,
      checkout: "unavailable",
      pending: [],
    };
  if (result.error)
    throw new Error(
      "Your allowance could not be checked. Your draft is kept; try again.",
      { cause: result.error },
    );
  return planSnapshotSchema.parse(result.data);
}
export async function planAction(
  rpc: GuidanceRpc,
  secret: string,
  owner: string,
  value: Record<string, unknown>,
) {
  const payload = JSON.stringify(value);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`woolgather.plan.v1:${owner}:${payload}`),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return repeatGuidanceRpc(rpc, "account_plan_action", { payload, signature });
}
