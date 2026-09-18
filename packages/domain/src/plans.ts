import { z } from "zod";
import { planningModes, type ComposerOptions } from "./planningComposer";

export const planOffer = {
  version: "2026-09-17",
  creditMicrousd: 3000,
  free: {
    name: "Free",
    monthlyCredits: 100,
    welcomeCredits: 200,
    storageBytes: 100 * 1024 * 1024,
    voiceSeconds: 0,
  },
  paid: {
    name: "Plus",
    monthlyCredits: 1500,
    priceMinor: 2400,
    currency: "EUR",
    storageBytes: 1024 ** 3,
    voiceSeconds: 1200,
  },
} as const;
export const planSnapshotSchema = z.object({
  enabled: z.boolean(),
  testing: z.boolean().default(false),
  tier: z.enum(["free", "paid"]),
  credits: z.number().nonnegative(),
  reservedCredits: z.number().nonnegative(),
  monthlyCredits: z.number().nonnegative(),
  welcomeCredits: z.number().nonnegative(),
  renewsAt: z.string().nullable(),
  paidUntil: z.string().nullable(),
  voiceSeconds: z.number().nonnegative(),
  reservedVoiceSeconds: z.number().nonnegative(),
  storageBytes: z.number().nonnegative(),
  storageLimitBytes: z.number().positive(),
  checkout: z.enum(["unavailable", "test", "live"]).default("unavailable"),
  pending: z
    .array(
      z.object({ id: z.string(), credits: z.number(), status: z.string() }),
    )
    .default([]),
});
export type PlanSnapshot = z.infer<typeof planSnapshotSchema>;
export type PlanTier = PlanSnapshot["tier"];
export function planRoute(
  level: "quick" | "thoughtful" | "deep",
  tier: PlanTier,
  preference: ComposerOptions["modelPreference"] = "auto",
) {
  const base = planningModes[level];
  if (tier === "paid" && preference !== "luna") return base;
  return {
    ...base,
    model: "gpt-5.6-luna" as const,
    effort:
      level === "quick"
        ? ("none" as const)
        : level === "thoughtful"
          ? ("medium" as const)
          : ("high" as const),
  };
}
// A whole-action ceiling, including every helper and follow-up. Actual usage
// is settled once; unused reservation returns to its original grant.
export function actionCreditLimit(
  level: "quick" | "thoughtful" | "deep",
  model: string,
  available: number,
  group = false,
) {
  const normal =
    model === "gpt-5.6-luna"
      ? { quick: 20, thoughtful: 40, deep: 60 }[level]
      : { quick: 20, thoughtful: 100, deep: 150 }[level];
  return Math.max(
    0,
    Math.min(Math.floor(available), normal * (group ? 3 : 1), 500),
  );
}
export const freeModelDisclosure =
  "Free includes Luna at every reasoning level. Subscribe to unlock Sol, more credits and live voice.";
