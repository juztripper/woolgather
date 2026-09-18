import { createExtension } from "@blocknote/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { motionTiming, onMotionReduction, reducedMotion } from "../ui/motion";
import { blockDissolveMasks } from "./ideaBlockDissolve";

// Text and colour edits don't change this signature. Only structural actions
// (including Enter, Backspace, undo and drag/drop) should move the document.
function structure(doc: ProseMirrorNode) {
  const blocks: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "blockContainer") {
      blocks.push(
        `${node.attrs.id}:${node.firstChild?.type.name}:${node.firstChild?.attrs.level ?? ""}:${node.childCount}`,
      );
    }
    return ["blockContainer", "blockGroup"].includes(node.type.name);
  });
  return blocks.join("|");
}

type BlockFrame = {
  element: HTMLElement;
  kind: string;
  visible: boolean;
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  copy?: HTMLElement;
};
type Snapshot = { frames: Map<string, BlockFrame>; origin: DOMRect };

function capture(view: EditorView, copy = false): Snapshot {
  const origin = view.dom.getBoundingClientRect();
  const frames = new Map<string, BlockFrame>();
  view.dom
    .querySelectorAll<HTMLElement>(".bn-block-outer[data-id]")
    .forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      frames.set(element.dataset.id!, {
        element,
        visible: rect.bottom > 0 && rect.top < innerHeight,
        kind:
          element.querySelector<HTMLElement>(".bn-block-content")?.dataset
            .contentType ?? "",
        parentId:
          element.parentElement?.closest<HTMLElement>(
            ".bn-block-outer[data-id]",
          )?.dataset.id ?? null,
        x: rect.left - origin.left,
        y: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
        // Copy before the transaction reaches the DOM. A removed node view may
        // be reused for another block by the time plugin-view update runs.
        copy:
          copy && rect.bottom > 0 && rect.top < innerHeight
            ? (element.cloneNode(true) as HTMLElement)
            : undefined,
      });
    });
  return { frames, origin };
}

export const ideaBlockMotion = createExtension(() => {
  let view: EditorView | undefined;
  let before: Snapshot | undefined;
  let queued = false;
  let dragging = false;
  const animations = new Set<Animation>();
  const ghosts = new Set<HTMLElement>();
  const cancel = () => {
    animations.forEach((animation) => animation.cancel());
    animations.clear();
    ghosts.forEach((ghost) => ghost.remove());
    ghosts.clear();
  };
  const play = (
    element: HTMLElement,
    frames: Keyframe[],
    duration: number,
    finished?: () => void,
    easing = motionTiming().ease,
  ) => {
    const animation = element.animate(frames, {
      duration,
      easing,
    });
    animations.add(animation);
    animation.finished
      .then(() => {
        animations.delete(animation);
        finished?.();
      })
      .catch(() => {});
  };
  function animateChange(current: EditorView, previous: Snapshot) {
    cancel();
    if (reducedMotion() || !current.editable || current.composing) return;
    const after = capture(current);
    // Give scrolling and responsive layout priority over decoration.
    if (
      Math.abs(previous.origin.top - after.origin.top) > 2 ||
      Math.abs(previous.origin.left - after.origin.left) > 2 ||
      Math.abs(previous.origin.width - after.origin.width) > 1
    )
      return;
    const timing = motionTiming();
    const moving = new Set<string>();
    for (const [id, next] of after.frames) {
      const old = previous.frames.get(id);
      if (next.parentId && moving.has(next.parentId)) {
        moving.add(id);
        continue;
      }
      if (!old?.visible && !next.visible) continue;
      if (!old) {
        moving.add(id);
        play(
          next.element,
          [
            {
              opacity: 0,
              filter: "blur(5px)",
              transform: "translateY(-5px) scale(.985)",
              transformOrigin: "top left",
            },
            {
              opacity: 1,
              filter: "blur(0)",
              transform: "none",
              transformOrigin: "top left",
            },
          ],
          timing.layout,
        );
      } else {
        const x = old.x - next.x;
        const y = old.y - next.y;
        if (old.kind !== next.kind) {
          moving.add(id);
          play(
            next.element,
            [
              { opacity: 0.25, transform: `translate(${x}px, ${y}px)` },
              { opacity: 1, transform: "none" },
            ],
            timing.layout,
          );
        } else if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) {
          moving.add(id);
          play(
            next.element,
            [{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }],
            timing.layout,
          );
        }
      }
    }
    const origin = current.dom.getBoundingClientRect();
    const host = current.dom.closest<HTMLElement>(".idea-block-editor");
    if (!host) return;
    // Keep multi-block deletion bounded, including large tables/nested groups.
    let fragmentBudget = 24;
    let nodeBudget = 1800;
    for (const [id, old] of previous.frames) {
      if (
        after.frames.has(id) ||
        !old.copy ||
        (old.parentId && !after.frames.has(old.parentId))
      )
        continue;
      const ghost = document.createElement("div");
      ghost.className =
        "idea-block-editor idea-block-motion-ghost bn-container bn-shadcn light";
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      Object.assign(ghost.style, {
        left: `${origin.left + old.x}px`,
        top: `${origin.top + old.y}px`,
        width: `${old.width}px`,
        height: `${old.height}px`,
      });
      const canvas = document.createElement("div");
      canvas.className = "bn-editor";
      old.copy
        .querySelectorAll("[id]")
        .forEach((element) => element.removeAttribute("id"));
      old.copy
        .querySelectorAll(".idea-code-language")
        .forEach((element) => element.remove());
      canvas.appendChild(old.copy);
      const nodeCount = old.copy.querySelectorAll("*").length + 1;
      const count = Math.min(
        6,
        fragmentBudget,
        Math.floor(nodeBudget / nodeCount),
      );
      const fragments: HTMLElement[] = [];
      if (
        count >= 2 &&
        CSS.supports("mask-image", "linear-gradient(black, black)")
      ) {
        const masks = blockDissolveMasks(old.width, old.height, count);
        for (const mask of masks) {
          const fragment = document.createElement("div");
          fragment.className = "idea-block-dissolve-fragment";
          const masked = canvas.cloneNode(true) as HTMLElement;
          masked.classList.add("idea-block-dissolve-mask");
          masked.style.maskImage = mask;
          fragment.appendChild(masked);
          ghost.appendChild(fragment);
          fragments.push(fragment);
        }
        fragmentBudget -= count;
        nodeBudget -= count * nodeCount;
      } else {
        ghost.appendChild(canvas);
      }
      document.body.appendChild(ghost);
      ghosts.add(ghost);
      fragments.forEach((fragment, index) => {
        const start = index * 0.055;
        const end = 0.64 + index * 0.06;
        const intact = { opacity: 1, transform: "none", filter: "blur(0)" };
        const dissolved = {
          opacity: 0,
          transform: `translate(${((index % 3) - 1) * 6}px, ${-6 - index}px)`,
          filter: "blur(5px)",
        };
        play(
          fragment,
          [
            { ...intact, offset: 0 },
            { ...intact, offset: start },
            { ...dissolved, offset: end },
            { ...dissolved, offset: 1 },
          ],
          timing.dissolve,
          () => fragment.remove(),
          "ease-in",
        );
      });
      play(
        ghost,
        [
          { opacity: 1, filter: "blur(0)", offset: 0 },
          { opacity: 0.75, filter: "blur(0)", offset: 0.4 },
          {
            opacity: 0,
            filter: fragments.length ? "blur(0)" : "blur(6px)",
            offset: 1,
          },
        ],
        timing.dissolve,
        () => {
          ghost.remove();
          ghosts.delete(ghost);
        },
        "linear",
      );
    }
  }
  return {
    key: "ideaBlockMotion",
    prosemirrorPlugins: [
      new Plugin({
        state: {
          init: () => null,
          apply(transaction, value, oldState, nextState) {
            if (
              transaction.docChanged &&
              structure(oldState.doc) !== structure(nextState.doc) &&
              view?.dom.isConnected &&
              !reducedMotion() &&
              view.editable &&
              !view.composing &&
              !dragging
            ) {
              before ??= capture(view, true);
            }
            return value;
          },
        },
        view(editorView) {
          view = editorView;
          const stopOnInput = () => cancel();
          const startDrag = () => {
            dragging = true;
            before = undefined;
            cancel();
          };
          const endDrag = () => {
            dragging = false;
          };
          editorView.dom.addEventListener("beforeinput", stopOnInput);
          editorView.dom.addEventListener("compositionstart", stopOnInput);
          window.addEventListener("scroll", cancel, true);
          document.addEventListener("dragstart", startDrag, true);
          document.addEventListener("dragend", endDrag, true);
          const stopPreference = onMotionReduction(cancel);
          return {
            update(nextView) {
              view = nextView;
              if (!before || queued) return;
              queued = true;
              // ProseMirror must finish scrolling the real caret into view
              // before decorative transforms can affect DOM measurements.
              queueMicrotask(() => {
                queued = false;
                const previous = before;
                before = undefined;
                if (previous && view?.dom.isConnected)
                  animateChange(view, previous);
              });
            },
            destroy() {
              cancel();
              before = undefined;
              view = undefined;
              stopPreference();
              window.removeEventListener("scroll", cancel, true);
              document.removeEventListener("dragstart", startDrag, true);
              document.removeEventListener("dragend", endDrag, true);
              editorView.dom.removeEventListener("beforeinput", stopOnInput);
              editorView.dom.removeEventListener(
                "compositionstart",
                stopOnInput,
              );
            },
          };
        },
      }),
    ],
  };
});
