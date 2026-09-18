import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { Button, IconButton } from "@/ui/Button";
import { cn } from "@/lib/utils";
import "./panel-page.css";

/** A contained task page. Actions stay reachable while long content scrolls. */
export function PanelPage({
  title,
  backLabel,
  onBack,
  onClose,
  actions,
  footer,
  children,
  className,
  focusOnMount = false,
}: {
  title: string;
  backLabel?: string;
  onBack?: () => void;
  onClose: () => void;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  focusOnMount?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) heading.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  return (
    <section className={cn("panel-page", className)} aria-label={title}>
      <header className="panel-page-header">
        {onBack && (
          <Button
            variant="quiet"
            size="sm"
            onClick={onBack}
            aria-label={backLabel || "Back"}
            className="gap-1.5 shrink min-w-0"
          >
            <ArrowLeft />
            <span className="truncate">{backLabel || "Back"}</span>
          </Button>
        )}
        <h2
          ref={heading}
          tabIndex={-1}
          className={onBack ? "sr-only" : undefined}
        >
          {title}
        </h2>
        <div className="panel-page-header-actions">
          {actions}
          <IconButton size="icon-sm" aria-label="Close plan" onClick={onClose}>
            <X />
          </IconButton>
        </div>
      </header>
      <div className="panel-page-body">{children}</div>
      {footer && <footer className="panel-page-footer">{footer}</footer>}
    </section>
  );
}
