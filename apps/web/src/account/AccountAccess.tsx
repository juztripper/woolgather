import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { Button } from "../ui/Button";
import { MfaChallenge } from "./MfaChallenge";
export function AccountAccess({
  auth,
  session,
  children,
  fallback,
}: {
  auth: SupabaseClient;
  session: Session;
  children: ReactNode;
  fallback: ReactNode;
}) {
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState("");
  const generation = useRef(0);
  const check = useCallback(async () => {
    const turn = ++generation.current;
    try {
      const result = await auth.rpc("account_access");
      if (turn !== generation.current) return;
      if (result.error) throw result.error;
      setStatus(result.data);
      setError("");
    } catch {
      if (turn === generation.current)
        setError(
          "We couldn’t verify your session. Your saved projects and drafts are kept.",
        );
    }
  }, [auth]);
  useEffect(() => {
    void check();
    const refresh = () => void check();
    window.addEventListener("focus", refresh);
    window.addEventListener("woolgather:account-access", refresh);
    return () => {
      generation.current++;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("woolgather:account-access", refresh);
    };
  }, [check, session.access_token]);
  async function signOut() {
    try {
      const result = await auth.auth.signOut({ scope: "local" });
      if (result.error) throw result.error;
    } catch {
      setError("Unable to sign out. Please try again.");
    }
  }
  if (error)
    return (
      <main className="account-verification">
        <div className="verification-card">
          <h1>A moment to reconnect.</h1>
          <p role="alert">{error}</p>
          <Button variant="primary" onClick={() => void check()}>
            Try again
          </Button>
          <Button variant="inline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </main>
    );
  if (!status) return fallback;
  if (status === "mfa_required")
    return (
      <MfaChallenge
        auth={auth}
        onVerified={() => void check()}
        onSignOut={() => void signOut()}
      />
    );
  if (status !== "ok")
    return (
      <main className="account-verification">
        <div className="verification-card">
          <h1>Please sign in again.</h1>
          <p>
            This session has ended. Your projects and local drafts are kept.
          </p>
          <Button variant="primary" onClick={() => void signOut()}>
            Back to sign in
          </Button>
        </div>
      </main>
    );
  return children;
}
