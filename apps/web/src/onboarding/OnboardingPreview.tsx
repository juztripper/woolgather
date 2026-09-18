import { useState } from "react";
import { ModalPresence } from "../ui/Modal";
import { Button } from "../ui/Button";
import { WelcomeModal } from "./WelcomeModal";
import "./onboarding.css";

/** Isolated visual preview; real account/creation checks use the App fixture. */
export function OnboardingPreview() {
  const [open, setOpen] = useState(true);
  const [destination, setDestination] = useState("");
  return (
    <main className="welcome-preview">
      <h1>woolgather</h1>
      <p>Welcome preview · no account changes</p>
      <Button onClick={() => setOpen(true)}>Open welcome</Button>
      {destination && <p role="status">{destination}</p>}
      <ModalPresence>
        {open && (
          <WelcomeModal
            firstRun
            onClose={async () => setOpen(false)}
            onStart={async (next) => {
              setDestination(
                next === "idea"
                  ? "In the app, this opens a new Idea."
                  : "In the app, this opens New project.",
              );
              setOpen(false);
            }}
          />
        )}
      </ModalPresence>
    </main>
  );
}
