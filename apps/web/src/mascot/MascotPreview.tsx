import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "../ui/Button";
import { reducedMotion } from "../account/model";
import { mountMascot } from "./motion";
import master from "./assets/character-b-neutral.svg?raw";
import "../account/account.css";
import "./mascot.css";

// React must not replace the animated DOM when controls or live status update.
const Artwork = memo(function Artwork({
  host,
}: {
  host: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={host}
      className="mascot-art"
      dangerouslySetInnerHTML={{ __html: master }}
    />
  );
});

export function MascotPreview() {
  const host = useRef<HTMLDivElement>(null);
  const rig = useRef<ReturnType<typeof mountMascot> | null>(null);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(reducedMotion);
  const [greetings, setGreetings] = useState(0);
  const [paper, setPaper] = useState(false);
  useEffect(() => {
    document.title = "A little hello · woolgather";
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(reducedMotion());
    media.addEventListener("change", update);
    window.addEventListener("woolgather:preferences", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("woolgather:preferences", update);
    };
  }, []);
  useEffect(() => {
    const svg = host.current!.querySelector("svg")!;
    const controller = mountMascot(svg, () => setGreetings((n) => n + 1));
    rig.current = controller;
    let inView = true;
    const sync = () =>
      controller.setEnabled(!paused && !reduced && !document.hidden && inView);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      sync();
    });
    observer.observe(svg);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      controller.dispose();
      rig.current = null;
    };
  }, [paused, reduced]);
  return (
    <div className={`entry-page mascot-page${paper ? " mascot-paper" : ""}`}>
      <header className="entry-header">
        <span className="brand" role="img" aria-label="woolgather">
          <img
            className="brand-symbol"
            src="/brand/gather-symbol.svg"
            alt=""
            width="38"
            height="38"
          />
          <span className="brand-wordmark" aria-hidden="true">
            woolgather
          </span>
        </span>
        <Button variant="secondary" onClick={() => setPaper((value) => !value)}>
          {paper ? "View on sky" : "View on ivory"}
        </Button>
      </header>
      <main className="mascot-main">
        <Artwork host={host} />
        <h1>A little hello.</h1>
        <p>
          {reduced
            ? "A quiet little companion."
            : "Move your pointer nearby, or say hello."}
        </p>
        <div className="mascot-controls">
          <Button
            variant="primary"
            disabled={paused || reduced}
            onClick={() => rig.current?.greet()}
          >
            Say hello
          </Button>
          <Button
            variant="inline"
            aria-pressed={paused}
            disabled={reduced}
            onClick={() => setPaused((value) => !value)}
          >
            {reduced
              ? "Reduced motion"
              : paused
                ? "Resume motion"
                : "Pause motion"}
          </Button>
        </div>
        <span className="sr-only" role="status" key={greetings}>
          {greetings ? "The character gives you a little nod." : ""}
        </span>
      </main>
      <footer className="mascot-footer">
        Character B · interactive motion study
      </footer>
    </div>
  );
}
