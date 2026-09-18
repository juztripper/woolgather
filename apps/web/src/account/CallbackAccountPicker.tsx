import { Button } from "../ui/Button";
import {
  chooseAccountCallback,
  getAccountCallbackChoices,
} from "./sessionPool";
export function CallbackAccountPicker() {
  return (
    <main className="account-verification">
      <div className="verification-card">
        <h1>Finish signing in</h1>
        <p>
          More than one account has a pending link. Choose the one this link
          belongs to.
        </p>
        {getAccountCallbackChoices().map((entry) => (
          <Button
            key={entry.id}
            onClick={() => {
              chooseAccountCallback(entry);
              location.reload();
            }}
          >
            {entry.label}
          </Button>
        ))}
        <Button variant="quiet" onClick={() => location.assign("/")}>
          Back to woolgather
        </Button>
      </div>
    </main>
  );
}
