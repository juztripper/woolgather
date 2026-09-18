import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import "./disclosure.css";
export function Disclosure({
  title,
  children,
  className = "",
  variant = "default",
  defaultOpen = false,
  revealKey,
  open: controlledOpen,
  onOpenChange,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  variant?: "default" | "plain" | "inline";
  defaultOpen?: boolean;
  revealKey?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    setInternalOpen(value);
    onOpenChange?.(value);
  };
  useEffect(() => {
    if (revealKey !== undefined) setOpen(true);
  }, [revealKey]);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "ui-disclosure",
        variant === "plain" && "ui-disclosure--plain",
        variant === "inline" && "ui-disclosure--inline",
        className,
      )}
    >
      <CollapsibleTrigger
        contentEditable={false}
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "ui-disclosure-trigger h-auto min-h-control-sm pointer-coarse:min-h-control-lg max-w-full justify-start whitespace-normal py-1 text-left font-normal transition-[background-color,color,border-color] hover:bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] aria-expanded:bg-transparent aria-expanded:hover:bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] active:not-disabled:scale-100",
              variant === "default" && "border-border",
              variant === "inline" &&
                "px-0 text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:hover:bg-transparent",
            )}
          />
        }
      >
        {variant === "plain" && (
          <ChevronRight
            className={cn(
              "ui-disclosure-caret size-4 shrink-0",
              open && "rotate-90",
            )}
          />
        )}
        <span className="flex min-w-0 items-center gap-2">{title}</span>
        {variant === "inline" && (
          <ChevronRight
            className={cn(
              "ui-disclosure-caret size-4 shrink-0",
              open && "rotate-90",
            )}
          />
        )}
        {variant === "default" && (
          <ChevronDown
            className={cn(
              "ui-disclosure-caret size-4 shrink-0",
              open && "rotate-180",
            )}
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent
        keepMounted
        className="ui-disclosure-panel"
        inert={!open}
      >
        <div className="ui-disclosure-content">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
