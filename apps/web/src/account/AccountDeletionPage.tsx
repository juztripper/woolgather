import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { Button } from "../ui/Button";
import { Feedback } from "../ui/Toast";
import { MfaChallenge } from "./MfaChallenge";
import { accountClient, addAccount, savedAccounts } from "./sessionPool";
import {
  clearDeletedAccountDrafts,
  clearDeletionLink,
  deletionApi,
  pendingDeletionLink,
} from "./deletion";
export function AccountDeletionPage({
  auth,
  session,
  signIn,
}: {
  auth: SupabaseClient;
  session: Session | null;
  signIn: ReactNode;
}) {
  const [link] = useState(pendingDeletionLink);
  const [phase, setPhase] = useState<"checking" | "mfa" | "deleted" | "error">(
    "checking",
  );
  const [error, setError] = useState("");
  const operation = useRef<Promise<void> | null>(null);
  const done = useRef(false);
  function leave() {
    clearDeletionLink();
    location.assign("/");
  }
  function process() {
    if (operation.current) return operation.current;
    if (!link || session?.user.id !== link.owner || done.current)
      return Promise.resolve();
    setPhase("checking");
    setError("");
    operation.current = (async () => {
      try {
        const status = await deletionApi(auth, "status", link);
        if (!status.ready) {
          setPhase("mfa");
          return;
        }
        const accounts = await savedAccounts();
        const result = await deletionApi(auth, "complete", link);
        if (!result.deleted)
          throw new Error("Deletion has not been confirmed. Please retry.");
        done.current = true;
        clearDeletionLink();
        try {
          clearDeletedAccountDrafts(link.owner);
        } catch {
          /* Storage cleanup is best effort after confirmed deletion. */
        }
        setPhase("deleted");
        for (const account of accounts.filter(
          (a) => a.user.id === link.owner,
        )) {
          try {
            await accountClient(account.slot).auth.signOut({ scope: "local" });
          } catch {
            /* Revoked by the server regardless. */
          }
        }
      } catch (e) {
        setError((e as Error).message);
        setPhase("error");
      } finally {
        operation.current = null;
      }
    })();
    return operation.current;
  }
  useEffect(() => {
    window.history.replaceState(null, "", "/account/delete");
    void process();
  }, [auth, session?.user.id]);
  if (phase === "deleted")
    return (
      <main className="account-verification">
        <section className="verification-card">
          <h1>Account deleted.</h1>
          <p>Your account and its projects have been permanently deleted.</p>
          <Button variant="primary" onClick={leave}>
            Back to sign in
          </Button>
        </section>
      </main>
    );
  if (!link)
    return (
      <main className="account-verification">
        <section className="verification-card">
          <h1>This link is unavailable.</h1>
          <p>Request a new deletion email in Account settings.</p>
          <Button onClick={leave}>Back to woolgather</Button>
        </section>
      </main>
    );
  if (!session)
    return (
      <>
        <p className="deletion-signin-hint" role="status">
          Sign in to confirm account deletion.
        </p>
        {signIn}
      </>
    );
  if (session.user.id !== link.owner)
    return (
      <main className="account-verification">
        <section className="verification-card">
          <h1>Sign in to the right account.</h1>
          <p>This deletion link belongs to another account.</p>
          <Button
            variant="primary"
            onClick={() => void addAccount().catch((e) => setError(e.message))}
          >
            Sign in to another account
          </Button>
          <Button onClick={leave}>Cancel</Button>
          <Feedback message={error} tone="error" />
        </section>
      </main>
    );
  if (phase === "mfa")
    return (
      <MfaChallenge
        auth={auth}
        title="Confirm account deletion"
        description="Enter your authenticator code to permanently delete your account and its projects."
        confirmLabel="Verify and delete account"
        exitLabel="Keep my account"
        onVerified={() => void process()}
        onSignOut={() => {
          void deletionApi(auth, "cancel", link)
            .then(leave)
            .catch((e) => {
              setError(e.message);
              setPhase("error");
            });
        }}
      />
    );
  return (
    <main className="account-verification">
      <section className="verification-card">
        <h1>
          {phase === "error"
            ? "Unable to confirm deletion."
            : "Deleting your account…"}
        </h1>
        {phase === "checking" ? (
          <p role="status">Confirming your email link.</p>
        ) : (
          <>
            <Feedback message={error} tone="error" />
            <Button variant="primary" onClick={() => void process()}>
              Try again
            </Button>
            <Button onClick={leave}>Back to woolgather</Button>
          </>
        )}
      </section>
    </main>
  );
}
