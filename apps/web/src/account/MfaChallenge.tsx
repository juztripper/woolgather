import { VerificationCode } from "../ui/VerificationCode";
import { Feedback } from "../ui/Toast";
import { Select } from "../ui/Select";
import { useEffect, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ShieldCheck } from "lucide-react";
import { Button } from "../ui/Button";
import "./account.css";
export function MfaChallenge({
  auth,
  onVerified,
  onSignOut,
  title = "One more step.",
  description = "Enter the six-digit code from your authenticator to open your workspace.",
  confirmLabel = "Verify and continue",
  exitLabel = "Back to sign in",
}: {
  auth: SupabaseClient;
  onVerified: () => void;
  onSignOut: () => void;
  title?: string;
  description?: string;
  confirmLabel?: string;
  exitLabel?: string;
}) {
  const [factors, setFactors] = useState<
    { id: string; friendly_name?: string }[]
  >([]);
  const [selected, setSelected] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setError("");
    try {
      const result = await auth.auth.mfa.listFactors();
      if (result.error) throw result.error;
      const items = result.data.totp;
      setFactors(items);
      setSelected(items[0]?.id || "");
      if (!items.length)
        setError("No supported authenticator was found. Please sign in again.");
    } catch {
      setError("Unable to load your authenticators. Try again.");
    }
  }
  useEffect(() => {
    void load();
  }, [auth]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !/^[0-9]{6}$/.test(code)) return;
    setBusy(true);
    setError("");
    try {
      const result = await auth.auth.mfa.challengeAndVerify({
        factorId: selected,
        code,
      });
      if (result.error) throw result.error;
      setCode("");
      onVerified();
    } catch {
      setError(
        "That code could not be verified. Try the latest code from your authenticator.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="account-verification">
      <form onSubmit={submit} className="verification-card">
        <ShieldCheck size={32} />
        <h1>{title}</h1>
        <p>{description}</p>
        {factors.length > 1 && (
          <label>
            Authenticator
            <Select
              label="Authenticator"
              value={selected}
              disabled={busy}
              onValueChange={setSelected}
              options={factors.map((f) => ({
                value: f.id,
                label: f.friendly_name || "Authenticator",
              }))}
            />
          </label>
        )}
        <VerificationCode
          value={code}
          onChange={setCode}
          autoFocus
          disabled={busy}
        />
        {error && <Feedback message={error} tone="error" />}
        <div className="verification-actions">
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !selected || !/^[0-9]{6}$/.test(code)}
          >
            {busy ? "Verifying…" : confirmLabel}
          </Button>
          {!factors.length && (
            <Button onClick={() => void load()}>Try again</Button>
          )}
          <Button variant="inline" disabled={busy} onClick={onSignOut}>
            {exitLabel}
          </Button>
        </div>
      </form>
    </main>
  );
}
