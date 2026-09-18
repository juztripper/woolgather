import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ReviewWeave } from "./ReviewWeave";
import { motionTiming, onMotionReduction, reducedMotion } from "../ui/motion";

/** One stable place for the wait and its result; content always remains real DOM. */
export function IdeaReviewSurface({
  mode,
  children,
}: {
  mode: string;
  children: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const priorMode = useRef(mode);
  const resizeMode = useRef(mode);
  const latestMode = useRef(mode);
  latestMode.current = mode;
  const heightAnimation = useRef<Animation | undefined>(undefined);
  const revealAnimation = useRef<Animation | undefined>(undefined);
  useEffect(() => {
    let height = inner.current!.getBoundingClientRect().height;
    const settle = () => {
      heightAnimation.current?.cancel();
      revealAnimation.current?.cancel();
    };
    const observer = new ResizeObserver(() => {
      if (!outer.current || !inner.current) return;
      const next = inner.current.getBoundingClientRect().height;
      const from =
        heightAnimation.current?.playState === "running"
          ? outer.current.getBoundingClientRect().height
          : height;
      if (Math.abs(next - height) < 1) return;
      height = next;
      // Nested disclosures already animate themselves. Only morph a review-state change.
      if (resizeMode.current === latestMode.current) return;
      resizeMode.current = latestMode.current;
      heightAnimation.current?.cancel();
      if (reducedMotion()) return;
      heightAnimation.current = outer.current.animate(
        [{ height: `${from}px` }, { height: `${next}px` }],
        { duration: motionTiming().layout, easing: motionTiming().ease },
      );
    });
    observer.observe(inner.current!);
    const stopPreference = onMotionReduction(settle);
    return () => {
      observer.disconnect();
      settle();
      stopPreference();
    };
  }, []);
  useLayoutEffect(() => {
    if (
      priorMode.current !== mode &&
      mode.startsWith("result") &&
      !reducedMotion()
    ) {
      revealAnimation.current?.cancel();
      revealAnimation.current = inner.current?.animate(
        [
          { opacity: 0, filter: "blur(2px)" },
          { opacity: 1, filter: "blur(0px)" },
        ],
        { duration: 320, easing: motionTiming().ease },
      );
    }
    priorMode.current = mode;
  }, [mode]);
  return (
    <div className="idea-review-surface" ref={outer}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

export function IdeaReviewPending({
  followingAnswer = false,
}: {
  followingAnswer?: boolean;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="idea-review-pending" role="status" aria-live="polite">
      <ReviewWeave />
      <div>
        <p>
          {followingAnswer
            ? "Following your answer…"
            : "Finding the connections…"}
        </p>
        <p className="idea-field-hint">
          {slow
            ? "Still reviewing. You can keep writing while you wait."
            : followingAnswer
              ? "Bringing it together with your idea."
              : "Finding what could make your idea clearer."}
        </p>
      </div>
    </div>
  );
}
