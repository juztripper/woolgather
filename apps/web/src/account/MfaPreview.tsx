import type { SupabaseClient } from "@supabase/supabase-js";
import { MfaChallenge } from "./MfaChallenge";
import { useToast } from "../ui/Toast";
// Development-only interaction fixture. Never contacts Auth or grants a session.
const previewAuth = {
  auth: {
    mfa: {
      listFactors: async () => ({
        data: {
          totp: [{ id: "preview", friendly_name: "Preview authenticator" }],
        },
        error: null,
      }),
      challengeAndVerify: async ({ code }: { code: string }) => ({
        error: code === "123456" ? null : new Error("Preview invalid code"),
      }),
    },
  },
} as unknown as SupabaseClient;
export function MfaPreview() {
  const { notify } = useToast();
  return (
    <MfaChallenge
      auth={previewAuth}
      onVerified={() => notify("Example verified. No account was changed.")}
      onSignOut={() => location.assign("/design-system")}
    />
  );
}
