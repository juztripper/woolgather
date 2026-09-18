import { useLayoutEffect, useRef, useState } from "react";
import { reducedMotion, motionTiming } from "../ui/motion";

/** Follow the conversation until the reader chooses to explore its history. */
export function useConversationScroll(
  chatKey: string,
  visible: boolean,
  restoredContentKey = "",
) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const jumping = useRef(false);
  const restorePosition = useRef<(() => void) | null>(null);
  const [away, setAway] = useState(false);

  function toLatest(smooth = true) {
    const node = viewport.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    following.current = true;
    jumping.current = smooth && !reducedMotion();
    node.scrollTo({
      top: node.scrollHeight,
      behavior: jumping.current ? "smooth" : "instant",
    });
  }

  useLayoutEffect(() => {
    const node = viewport.current;
    const body = content.current;
    if (!node || !body || !visible) return;
    following.current = true;
    jumping.current = false;
    const atBottom = () =>
      node.scrollHeight - node.clientHeight - node.scrollTop <= 24;
    const smoothing = motionTiming().layout / 5;
    let frame = 0;
    let lastFrame = 0;
    let initialized = false;
    let userScrolling = false;
    let anchor: { element: Element; offset: number } | undefined;
    const rememberPosition = () => {
      if (following.current || jumping.current) {
        anchor = undefined;
        return;
      }
      const bounds = node.getBoundingClientRect();
      const element = Array.from(body.children).find((child) => {
        const rect = child.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      anchor = element
        ? {
            element,
            offset: element.getBoundingClientRect().top - bounds.top,
          }
        : undefined;
    };
    restorePosition.current = () => {
      // Restored history can arrive after the messages. Compensate before paint
      // so it neither replays the follow animation nor moves a reader's place.
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
      if (following.current && !jumping.current) {
        node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
      } else if (!jumping.current && anchor?.element.isConnected) {
        const offset =
          anchor.element.getBoundingClientRect().top -
          node.getBoundingClientRect().top;
        node.scrollTo({
          top: node.scrollTop + offset - anchor.offset,
          behavior: "instant",
        });
      }
      rememberPosition();
    };
    const follow = (now: number) => {
      frame = 0;
      if (!following.current || jumping.current) return;
      const target = Math.max(0, node.scrollHeight - node.clientHeight);
      const distance = target - node.scrollTop;
      const elapsed = lastFrame ? Math.min(50, now - lastFrame) : 16;
      lastFrame = now;
      const step =
        reducedMotion() || Math.abs(distance) < 1
          ? distance
          : distance * (1 - Math.exp(-elapsed / smoothing));
      node.scrollTo({ top: node.scrollTop + step, behavior: "instant" });
      rememberPosition();
      if (Math.abs(target - node.scrollTop) >= 1)
        frame = requestAnimationFrame(follow);
      else {
        lastFrame = 0;
        setAway(false);
      }
    };
    const measure = () => {
      if (following.current && !jumping.current) {
        if (!initialized || reducedMotion()) {
          node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
        } else if (!frame) frame = requestAnimationFrame(follow);
      }
      initialized = true;
      rememberPosition();
      setAway(!following.current && !atBottom());
    };
    const onScroll = () => {
      if (jumping.current) return;
      // Collapsing work can clamp scrollTop while the answer grows. That is
      // layout movement, not a reader choosing history. Wheel, key, touch and
      // scrollbar input below explicitly release following.
      rememberPosition();
      if (!following.current && !userScrolling && atBottom())
        following.current = true;
      setAway(!following.current && !atBottom());
    };
    const stopJump = () => {
      userScrolling = true;
      if (jumping.current) {
        jumping.current = false;
        node.scrollTo({ top: node.scrollTop, behavior: "instant" });
      }
      following.current = false;
      rememberPosition();
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
    };
    const onPointer = (event: PointerEvent) => {
      const bounds = node.getBoundingClientRect();
      if (
        jumping.current ||
        (event.target === node && event.clientX >= bounds.right - 16)
      )
        stopJump();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 || jumping.current) stopJump();
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      )
        stopJump();
    };
    const onEnd = () => {
      if (!jumping.current) {
        if (userScrolling) {
          userScrolling = false;
          following.current = atBottom();
          setAway(!following.current);
        }
        return;
      }
      userScrolling = false;
      jumping.current = false;
      following.current = true;
      measure();
    };
    // Resize covers incoming replies, image/font loads and composer/plan resizing.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(body);
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("scrollend", onEnd);
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("pointerdown", onPointer, { passive: true });
    node.addEventListener("keydown", onKey);
    node.addEventListener("touchmove", stopJump, { passive: true });
    measure();
    return () => {
      restorePosition.current = null;
      observer.disconnect();
      cancelAnimationFrame(frame);
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("scrollend", onEnd);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", onPointer);
      node.removeEventListener("keydown", onKey);
      node.removeEventListener("touchmove", stopJump);
    };
  }, [chatKey, visible]);

  useLayoutEffect(() => {
    restorePosition.current?.();
  }, [chatKey, visible, restoredContentKey]);

  return { viewport, content, following, away, toLatest };
}
