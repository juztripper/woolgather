import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../ui/Button";
import { Avatar } from "./Avatar";
import { displayName } from "./model";
import {
  cancelAddAccount,
  pendingAddition,
  savedAccounts,
  switchAccount,
  type SavedAccount,
} from "./sessionPool";
export function AccountReturn() {
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [error, setError] = useState("");
  const adding = pendingAddition();
  useEffect(() => {
    void savedAccounts()
      .then(setAccounts)
      .catch(() =>
        setError("Your other accounts couldn’t be loaded. Please try again."),
      );
  }, []);
  if (!adding && !accounts.length && !error) return null;
  return (
    <section className="account-return" aria-label="Signed-in accounts">
      {adding ? (
        <>
          <p>Add another account. Your other accounts will stay signed in.</p>
          <Button variant="quiet" onClick={cancelAddAccount}>
            <ArrowLeft /> Back to your account
          </Button>
        </>
      ) : (
        <>
          <p>Already signed in on this browser</p>
          {accounts.map((account) => (
            <Button
              key={account.slot}
              variant="quiet"
              onClick={() =>
                void switchAccount(account.slot).catch((e) =>
                  setError(e.message),
                )
              }
            >
              <Avatar user={account.user} />
              {displayName(account.user)}
            </Button>
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
