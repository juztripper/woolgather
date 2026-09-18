import { useRef } from "react";

/** Append-only words keep their nodes; only newly arriving words dissolve in. */
export function StreamingText({
  text,
  active = false,
}: {
  text: string;
  active?: boolean;
}) {
  const animated = useRef(active);
  if (!animated.current) return text;
  return text.split(/(\s+)/).map((part, index) =>
    /\S/.test(part) ? (
      <span key={index} className="streaming-word">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
