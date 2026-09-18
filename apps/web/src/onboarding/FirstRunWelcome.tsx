import { ModalPresence } from "../ui/Modal";
import { useEffect, useRef, useState } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { WelcomeModal, type GuideDestination } from "./WelcomeModal";
import { needsWelcome, saveWelcome } from "./welcomeState";

export function AccountWelcome({
  auth,
  owner,
  projectCount,
  ideaCount,
  dismissedForSession,
  onDismissForSession,
  onStart,
}: {
  auth: SupabaseClient;
  owner: string;
  projectCount: number;
  ideaCount: number;
  dismissedForSession: boolean;
  onDismissForSession: () => void;
  onStart: (
    destination: GuideDestination,
    beforeOpen: () => Promise<void>,
  ) => Promise<void>;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [done, setDone] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    void auth.auth
      .getUser()
      .then(({ data, error }) => {
        if (!cancelled && !error && data.user?.id === owner) setUser(data.user);
      })
      .catch(() => {
        /* Optional guidance never blocks the workspace. */
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [auth, owner]);
  return (
    <ModalPresence>
      {user &&
        !done &&
        !dismissedForSession &&
        needsWelcome(user, projectCount, ideaCount) && (
          <WelcomeModal
            firstRun
            onDismissForSession={onDismissForSession}
            onClose={async () => {
              await saveWelcome(auth, owner, "dismissed", "");
              if (alive.current) setDone(true);
            }}
            onStart={async (destination) => {
              await onStart(destination, async () => {
                if (!alive.current) throw new Error("Welcome closed");
                await saveWelcome(auth, owner, "complete", "");
              });
              if (alive.current) setDone(true);
            }}
          />
        )}
    </ModalPresence>
  );
}
