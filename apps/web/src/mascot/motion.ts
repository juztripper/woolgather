import { animate, createTimeline } from "animejs";

/** Animate the approved paths in place; one deformation field keeps every seam aligned. */
export function mountMascot(svg: SVGSVGElement, onGreeting: () => void) {
  const get = <T extends SVGElement>(id: string) =>
    svg.querySelector<T>(`#${id}`)!;
  svg.removeAttribute("aria-labelledby");
  svg.setAttribute(
    "aria-label",
    "An ivory character with a curled tuft, tiny feet and a gentle smile",
  );
  const body = get<SVGGElement>("body-and-curl");
  const face = get<SVGGElement>("face");
  const shadow = get<SVGPathElement>("ground-shadow");
  // Feet stay planted. The face follows the body transform, then gets a small gaze offset.
  const root = document.createElementNS("http://www.w3.org/2000/svg", "g");
  body.parentNode!.insertBefore(root, body);
  root.appendChild(body);
  root.appendChild(face);
  const paths = [...body.querySelectorAll("path")].map((path) => ({
    path,
    source: path.getAttribute("d")!,
  }));
  const eyes = [
    get<SVGPathElement>("eye-left"),
    get<SVGPathElement>("eye-right"),
  ];
  const happy = eyes.map((eye, i) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const x = i ? 548 : 442;
    path.setAttribute("d", `M${x - 11} 450 Q${x} 435 ${x + 11} 450`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-width", "4.5");
    path.setAttribute("opacity", "0");
    eye.parentNode!.insertBefore(path, eye.nextSibling);
    return path;
  });
  const pose = {
    breath: 0,
    x: 0,
    y: 0,
    curl: 0,
    blink: 0,
    nod: 0,
    joy: 0,
    curlNod: 0,
  };
  let enabled = false;
  let greeting = false;
  let disposed = false;
  let blinkTimer = 0;
  let gaze: ReturnType<typeof animate> | undefined;
  let curl: ReturnType<typeof animate> | undefined;
  let blink: ReturnType<typeof animate> | undefined;
  let hello: ReturnType<typeof createTimeline> | undefined;
  let idle: ReturnType<typeof animate> | undefined;
  let targetX = 0,
    targetY = 0;

  function render() {
    const scaleY = 1 + pose.breath * 0.009 - pose.nod * 0.025;
    const scaleX = 1 - pose.breath * 0.004 + pose.nod * 0.018;
    const rotate = pose.x * 1.7 + pose.nod * 2.2;
    root.setAttribute(
      "transform",
      `translate(380 692) rotate(${rotate}) scale(${scaleX} ${scaleY}) translate(-380 -692)`,
    );
    face.setAttribute(
      "transform",
      `translate(${pose.x * 6} ${pose.y * 4 + pose.nod * 3})`,
    );
    paths.forEach(({ path, source }) => {
      let index = 0;
      let px = 0;
      const bent = source.replace(/-?\d+(?:\.\d+)?/g, (value) => {
        const number = Number(value);
        if (index++ % 2 === 0) {
          px = number;
          return value;
        }
        // Smooth field vanishes at the attachment and lower body. Applied to every layer.
        const height = Math.max(0, Math.min(1, (449 - number) / 210));
        const left = Math.max(0, Math.min(1, (400 - px) / 200));
        return String(
          number + (pose.curl * 9 - pose.curlNod * 5) * height * height * left,
        );
      });
      path.setAttribute("d", bent);
    });
    eyes.forEach((eye, i) => {
      const x = i ? 548 : 442;
      eye.setAttribute(
        "transform",
        `translate(${x} 447) scale(1 ${Math.max(0.045, 1 - pose.blink)}) translate(${-x} -447)`,
      );
      eye.setAttribute("opacity", String(1 - pose.joy));
      happy[i].setAttribute("opacity", String(pose.joy));
    });
    shadow.setAttribute(
      "transform",
      `translate(357 704) scale(${1 + pose.nod * 0.025 - pose.breath * 0.012} 1) translate(-357 -704)`,
    );
  }
  function scheduleBlink() {
    window.clearTimeout(blinkTimer);
    if (!enabled) return;
    blinkTimer = window.setTimeout(
      () => {
        if (!greeting)
          blink = animate(pose, {
            blink: [
              { to: 1, duration: 65 },
              { to: 1, duration: 30 },
              { to: 0, duration: 115 },
            ],
            ease: "inOutSine",
            onUpdate: render,
          });
        scheduleBlink();
      },
      3500 + Math.random() * 3000,
    );
  }
  function look(x: number, y: number) {
    if (
      !enabled ||
      (Math.abs(x - targetX) < 0.015 && Math.abs(y - targetY) < 0.015)
    )
      return;
    targetX = x;
    targetY = y;
    gaze?.cancel();
    curl?.cancel();
    gaze = animate(pose, {
      x,
      y,
      duration: 650,
      ease: "out(3)",
      onUpdate: render,
    });
    curl = animate(pose, {
      curl: x,
      duration: 1100,
      ease: "outElastic(1, .65)",
      onUpdate: render,
    });
  }
  function move(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    const rect = svg.getBoundingClientRect();
    const clamp = (n: number) => Math.max(-1, Math.min(1, n));
    look(
      clamp((event.clientX - rect.left - rect.width * 0.72) / 300),
      clamp((event.clientY - rect.top - rect.height * 0.45) / 250),
    );
  }
  const rest = () => look(0, 0);
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("blur", rest);
  document.documentElement.addEventListener("pointerleave", rest);
  function setEnabled(next: boolean) {
    if (disposed || enabled === next) return;
    enabled = next;
    [gaze, curl, blink, hello, idle].forEach((animation) =>
      animation?.cancel(),
    );
    window.clearTimeout(blinkTimer);
    greeting = false;
    targetX = targetY = 0;
    Object.assign(pose, {
      breath: 0,
      x: 0,
      y: 0,
      curl: 0,
      blink: 0,
      nod: 0,
      joy: 0,
      curlNod: 0,
    });
    render();
    if (next) {
      idle = animate(pose, {
        breath: [
          { to: 1, duration: 2400 },
          { to: 0, duration: 2400 },
        ],
        loop: true,
        ease: "inOutSine",
        onUpdate: render,
      });
      scheduleBlink();
    }
  }
  render();
  return {
    setEnabled,
    greet() {
      if (!enabled || greeting) return;
      greeting = true;
      blink?.cancel();
      pose.blink = 0;
      hello = createTimeline({
        onUpdate: render,
        onComplete: () => {
          greeting = false;
        },
      })
        .add(pose, { joy: 1, duration: 150, ease: "outSine" }, 0)
        .add(pose, { nod: 1, duration: 330, ease: "inOutSine" }, 80)
        .add(pose, { nod: -0.3, duration: 360, ease: "inOutSine" }, 410)
        .add(pose, { nod: 0, duration: 560, ease: "outElastic(1, .7)" }, 770)
        .add(pose, { joy: 0, duration: 230, ease: "inOutSine" }, 1000)
        .add(pose, { curlNod: 1, duration: 340, ease: "inOutSine" }, 160)
        .add(
          pose,
          { curlNod: 0, duration: 800, ease: "outElastic(1, .65)" },
          500,
        );
      onGreeting();
    },
    dispose() {
      setEnabled(false);
      disposed = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("blur", rest);
      document.documentElement.removeEventListener("pointerleave", rest);
      happy.forEach((path) => path.remove());
      root.parentNode!.insertBefore(body, root);
      root.parentNode!.insertBefore(face, root);
      root.remove();
    },
  };
}
