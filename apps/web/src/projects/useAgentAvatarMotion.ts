import { useEffect, useRef } from "react";
import { motionTiming, reducedMotion } from "../ui/motion";

export type AgentActivity = "idle" | "working" | "done";

/** Keep decorative motion outside React's render loop and stop it off screen. */
export function useAgentAvatarMotion(
  character: string,
  interactive: boolean,
  activity: AgentActivity,
) {
  const ref = useRef<HTMLSpanElement>(null);
  const greeting = useRef<Animation | null>(null);
  const previous = useRef({ character, activity });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const trigger =
      node.closest("button, a, [role='option'], [role='menuitem']") || node;
    const trackingArea = interactive
      ? node.closest("[role='dialog']") || trigger
      : trigger;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let frame = 0;
    let pointer = { x: 0, y: 0 };
    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      node.style.removeProperty("--agent-look-x");
      node.style.removeProperty("--agent-look-y");
      node.style.removeProperty("--agent-tilt");
    };
    const sync = () => {
      const active = visible && !document.hidden && !reducedMotion();
      node.dataset.animate = String(active);
      if (!active) {
        greeting.current?.cancel();
        node.dataset.greeting = "false";
        reset();
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(node);
    const move = (event: Event) => {
      const e = event as PointerEvent;
      if (e.pointerType === "touch" || node.dataset.animate !== "true") return;
      pointer = { x: e.clientX, y: e.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const box = node.getBoundingClientRect();
        const reach = interactive ? 180 : Math.max(box.width, 1);
        const x = Math.max(
          -1,
          Math.min(1, (pointer.x - box.left - box.width / 2) / reach),
        );
        const y = Math.max(
          -1,
          Math.min(1, (pointer.y - box.top - box.height / 2) / reach),
        );
        node.style.setProperty("--agent-look-x", `${x * 4}px`);
        node.style.setProperty("--agent-look-y", `${y * 2.5}px`);
        node.style.setProperty("--agent-tilt", `${x * 4}deg`);
      });
    };
    const engage = () => {
      node.dataset.engaged = "true";
    };
    const release = () => {
      node.dataset.engaged = "false";
      reset();
    };
    trigger.addEventListener("pointerenter", engage);
    trigger.addEventListener("pointerleave", release);
    trigger.addEventListener("focusin", engage);
    trigger.addEventListener("focusout", release);
    trackingArea.addEventListener("pointermove", move);
    trackingArea.addEventListener("pointerleave", reset);
    media.addEventListener("change", sync);
    window.addEventListener("woolgather:preferences", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      reset();
      observer.disconnect();
      greeting.current?.cancel();
      trigger.removeEventListener("pointerenter", engage);
      trigger.removeEventListener("pointerleave", release);
      trigger.removeEventListener("focusin", engage);
      trigger.removeEventListener("focusout", release);
      trackingArea.removeEventListener("pointermove", move);
      trackingArea.removeEventListener("pointerleave", reset);
      media.removeEventListener("change", sync);
      window.removeEventListener("woolgather:preferences", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [interactive]);

  useEffect(() => {
    const changed = previous.current.character !== character;
    const finished =
      previous.current.activity === "working" && activity === "done";
    previous.current = { character, activity };
    const node = ref.current;
    if (
      (!changed && !finished) ||
      reducedMotion() ||
      node?.dataset.animate !== "true"
    )
      return;
    const timing = motionTiming();
    const layer = node.querySelector(".agent-avatar-reaction");
    if (!layer) return;
    const from = getComputedStyle(layer).transform;
    greeting.current?.cancel();
    node.dataset.greeting = "true";
    greeting.current = layer.animate(
      [
        { transform: from === "none" ? "translateY(0) scale(1)" : from },
        { transform: "translateY(1px) scale(1.04, .96)", offset: 0.18 },
        {
          transform: "translateY(-5px) rotate(-7deg) scale(.98, 1.03)",
          offset: 0.45,
        },
        { transform: "translateY(-1px) rotate(4deg)", offset: 0.72 },
        { transform: "translateY(0) rotate(0deg) scale(1)" },
      ],
      { duration: timing.layout * 2, easing: timing.ease },
    );
    greeting.current.onfinish = () => {
      node.dataset.greeting = "false";
    };
  }, [character, activity]);
  return ref;
}
