import { useEffect, useRef, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  readSidebarPreferences,
  saveSidebarPreferences,
  type SidebarPreferences,
} from "./sidebarPreferences";

export function useSidebarPreferences(auth: SupabaseClient, session: Session) {
  const [preferences, setPreferences] = useState(() =>
    readSidebarPreferences(session.user.user_metadata.sidebar_v1),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writing = useRef(false);
  const generation = useRef(0);
  const owner = session.user.id;
  useEffect(() => {
    let alive = true;
    async function refresh() {
      if (writing.current || document.visibilityState === "hidden") return;
      const turn = ++generation.current;
      try {
        const { data, error } = await auth.auth.getUser();
        if (
          alive &&
          turn === generation.current &&
          !writing.current &&
          !error &&
          data.user?.id === owner
        )
          setPreferences(
            readSidebarPreferences(data.user.user_metadata.sidebar_v1),
          );
      } catch {
        /* A refresh failure keeps the last acknowledged preferences. */
      }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const {
      data: { subscription },
    } = auth.auth.onAuthStateChange((_event, next) => {
      if (alive && !writing.current && next?.user.id === owner) {
        generation.current++;
        setPreferences(
          readSidebarPreferences(next.user.user_metadata.sidebar_v1),
        );
      }
    });
    return () => {
      alive = false;
      generation.current++;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      subscription.unsubscribe();
    };
  }, [auth, owner]);
  async function change(
    update: (current: SidebarPreferences) => SidebarPreferences,
  ) {
    if (writing.current) return false;
    writing.current = true;
    generation.current++;
    const previous = preferences;
    setPreferences(readSidebarPreferences(update(previous)));
    setBusy(true);
    setError("");
    try {
      setPreferences(await saveSidebarPreferences(auth, owner, update));
      return true;
    } catch (e) {
      setPreferences(previous);
      setError((e as Error).message);
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return { preferences, busy, error, change, clearError: () => setError("") };
}
