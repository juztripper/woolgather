import { reducedMotion } from "./account/model";
import { useEffect, useRef, useState } from "react";

// A fast acknowledgement never waits for decoration. Once visible, the accepted
// shader completes only its dissolve (1.9s), not its 7.4s separation sequence.
export function useOperationMotion() {
  const [phase, setPhase] = useState<
    "idle" | "pending" | "forming" | "departing"
  >("idle");
  const current = useRef(phase);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const release = useRef<(() => void) | undefined>(undefined);
  const alive = useRef(true);
  const change = (next: typeof phase) => {
    current.current = next;
    if (alive.current) setPhase(next);
  };
  useEffect(() => {
    alive.current = true;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const skip = () => {
      if (reducedMotion()) release.current?.();
    };
    media.addEventListener("change", skip);
    window.addEventListener("woolgather:preferences", skip);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      release.current?.();
      media.removeEventListener("change", skip);
      window.removeEventListener("woolgather:preferences", skip);
    };
  }, []);
  function begin() {
    clearTimeout(timer.current);
    change("pending");
    timer.current = setTimeout(() => change("forming"), 450);
  }
  async function finish() {
    clearTimeout(timer.current);
    if (current.current === "forming" && !reducedMotion()) {
      change("departing");
      await new Promise<void>((resolve) => {
        release.current = resolve;
        timer.current = setTimeout(resolve, 1900);
      });
      clearTimeout(timer.current);
      release.current = undefined;
    }
    change("idle");
    return alive.current;
  }
  return { phase, begin, finish };
}
