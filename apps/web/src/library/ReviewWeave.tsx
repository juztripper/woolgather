import { useEffect, useId, useRef } from "react";
import { reducedMotion } from "../ui/motion";

/** Threads crossing and separating: a quiet visual for connecting an idea. */
export function ReviewWeave() {
  const gradient = useId();
  const svg = useRef<SVGSVGElement>(null);
  const paths = [
    [
      "M12 58 C48 12 84 96 124 48 S194 26 228 55",
      "M12 54 C58 82 92 12 124 54 S182 90 228 51",
      "M12 50 C42 34 82 78 124 58 S200 14 228 54",
    ],
    [
      "M12 48 C56 92 84 6 124 56 S186 88 228 47",
      "M12 54 C42 20 94 82 124 48 S202 20 228 53",
      "M12 58 C62 72 82 24 124 50 S180 92 228 49",
    ],
    [
      "M12 54 C60 62 88 24 124 54 S184 44 228 52",
      "M12 50 C46 26 96 72 124 56 S194 72 228 56",
      "M12 56 C58 80 80 34 124 50 S178 30 228 50",
    ],
  ];
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      if (reducedMotion() || document.hidden) svg.current?.pauseAnimations();
      else svg.current?.unpauseAnimations();
      if (reducedMotion()) svg.current?.setCurrentTime(0);
    };
    sync();
    media.addEventListener("change", sync);
    window.addEventListener("woolgather:preferences", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("woolgather:preferences", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return (
    <svg
      ref={svg}
      className="review-weave"
      viewBox="0 0 240 108"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={gradient}
          x1="12"
          y1="0"
          x2="228"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--action-ink)" stopOpacity="0" />
          <stop offset=".24" stopColor="var(--action-ink)" stopOpacity=".55" />
          <stop offset=".58" stopColor="var(--action-ink)" />
          <stop offset=".85" stopColor="var(--muted)" stopOpacity=".5" />
          <stop offset="1" stopColor="var(--action-ink)" stopOpacity="0" />
        </linearGradient>
        {paths.map((shapes, index) => (
          <path
            id={`${gradient}-wave-${index}`}
            d={shapes[0]}
            pathLength="100"
            key={index}
          >
            <animate
              attributeName="d"
              values={[...shapes, shapes[0]].join(";")}
              dur={`${[12, 14, 16][index]}s`}
              repeatCount="indefinite"
              calcMode="spline"
              keyTimes="0;.333333;.666667;1"
              keySplines=".4 0 .6 1;.4 0 .6 1;.4 0 .6 1"
            />
          </path>
        ))}
      </defs>
      {paths.map((_, index) => (
        <g
          className={`review-weave-thread review-weave-thread-${index}`}
          key={index}
        >
          <use
            className="review-weave-halo"
            href={`#${gradient}-wave-${index}`}
            stroke={`url(#${gradient})`}
          />
          <use
            className="review-weave-line"
            href={`#${gradient}-wave-${index}`}
            stroke={`url(#${gradient})`}
          />
          <use
            className="review-weave-trace"
            href={`#${gradient}-wave-${index}`}
            stroke={`url(#${gradient})`}
          />
        </g>
      ))}
    </svg>
  );
}
