import { useEffect, useState } from "react";

/** Crossfade and reposition words without stretching glyphs or delaying state. */
export function MorphText({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  const [current, setCurrent] = useState(children);
  const [previous, setPrevious] = useState<string | null>(null);
  if (current !== children) {
    setPrevious(current);
    setCurrent(children);
  }
  useEffect(() => {
    if (!previous) return;
    const timer = window.setTimeout(() => setPrevious(null), 320);
    return () => window.clearTimeout(timer);
  }, [current, previous]);
  return (
    <span className={`morph-text ${className}`}>
      {previous && (
        <span className="morph-text-old" aria-hidden="true">
          {previous}
        </span>
      )}
      <span key={current} className={previous ? "morph-text-new" : undefined}>
        {current}
      </span>
    </span>
  );
}
