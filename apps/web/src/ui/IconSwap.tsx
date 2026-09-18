import type { ReactNode } from "react";
import "./icon-swap.css";

/** Keep both glyphs mounted so state changes crossfade in either direction. */
export function IconSwap({
  active,
  children,
  alternate,
}: {
  active: boolean;
  children: ReactNode;
  alternate: ReactNode;
}) {
  return (
    <span className="icon-swap" data-active={active} aria-hidden="true">
      <span className="icon-swap-default">{children}</span>
      <span className="icon-swap-alternate">{alternate}</span>
    </span>
  );
}
