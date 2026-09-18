import { flushSync } from "react-dom";

let current: ViewTransition | undefined;
/** Only navigation/presentation changes use snapshots. Editing and dragging stay direct. */
export function transitionView(update: () => void) {
  if (
    !document.startViewTransition ||
    document.documentElement.dataset.motion === "reduce" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  current?.skipTransition();
  current = document.startViewTransition(() => flushSync(update));
  // Skipping rejects ready, while still applying the requested state update.
  void current.ready.catch(() => {});
}
