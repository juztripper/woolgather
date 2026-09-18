import { memo, useEffect, useRef } from "react";
import master from "./assets/character-b-neutral.svg?raw";
import { mountMascot } from "./motion";

const Artwork = memo(function Artwork() {
  return (
    <div
      className="welcome-companion-art"
      dangerouslySetInnerHTML={{ __html: master }}
    />
  );
});

/** Small, decorative companion for the isolated onboarding composition review. */
export function WelcomeMascot({
  reduced,
  moment,
}: {
  reduced: boolean;
  moment: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const rig = useRef<ReturnType<typeof mountMascot> | null>(null);
  useEffect(() => {
    const svg = host.current!.querySelector("svg")!;
    const controller = mountMascot(svg, () => {});
    rig.current = controller;
    let visible = true;
    const sync = () =>
      controller.setEnabled(!reduced && !document.hidden && visible);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
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
  }, [reduced]);
  useEffect(() => {
    rig.current?.greet();
  }, [moment, reduced]);
  return (
    <div ref={host} className="welcome-companion" aria-hidden="true">
      <Artwork />
    </div>
  );
}
