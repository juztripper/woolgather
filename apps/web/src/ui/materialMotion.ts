import { useCallback, useRef, type Ref } from "react";

/** Establish one reveal value for a newly mounted surface, including dialogs
 * mounted open. The material, clipping and content share that value. Base UI
 * still owns positioning, focus, reversible transitions and exit retention. */
export function useMaterialSurface<T extends HTMLElement>(
  forwardedRef?: Ref<T>,
) {
  const frame = useRef<number | undefined>(undefined);
  return useCallback(
    (node: T | null) => {
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      if (!node) return;
      if (
        document.documentElement.dataset.motion === "reduce" ||
        matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      node.dataset.materialStart = "";
      frame.current = requestAnimationFrame(() => {
        getComputedStyle(node).getPropertyValue("--material-presence");
        delete node.dataset.materialStart;
      });
    },
    [forwardedRef],
  );
}
