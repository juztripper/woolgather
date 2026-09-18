let locks = 0;
let releasePage: (() => void) | undefined;

/** Nested dialogs share one page lock and restore the original scroll position. */
export function lockModalScroll() {
  if (locks++ === 0) {
    const body = document.body;
    const root = document.documentElement;
    const x = window.scrollX,
      y = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: root.style.overflow,
    };
    Object.assign(body.style, {
      position: "fixed",
      top: `${-y}px`,
      left: `${-x}px`,
      right: "0",
    });
    root.style.overflow = "hidden";
    releasePage = () => {
      Object.assign(body.style, {
        position: previous.position,
        top: previous.top,
        left: previous.left,
        right: previous.right,
      });
      root.style.overflow = previous.overflow;
      window.scrollTo(x, y);
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) {
      releasePage?.();
      releasePage = undefined;
    }
  };
}
