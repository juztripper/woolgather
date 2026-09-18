import { reducedMotion } from "../account/model";

export { reducedMotion };

export function motionTiming() {
  const tokens = getComputedStyle(document.documentElement);
  return {
    layout: parseFloat(tokens.getPropertyValue("--motion-layout")) || 240,
    exit: parseFloat(tokens.getPropertyValue("--motion-exit")) || 160,
    dissolve: parseFloat(tokens.getPropertyValue("--motion-dissolve")) || 420,
    ease:
      tokens.getPropertyValue("--motion-ease").trim() ||
      "cubic-bezier(.2,.8,.2,1)",
  };
}

/** Cancel running decoration immediately if either motion preference changes. */
export function onMotionReduction(cancel: () => void) {
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  const changed = () => {
    if (reducedMotion()) cancel();
  };
  media.addEventListener("change", changed);
  window.addEventListener("woolgather:preferences", changed);
  return () => {
    media.removeEventListener("change", changed);
    window.removeEventListener("woolgather:preferences", changed);
  };
}
