import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { cn } from "../lib/utils";
import "./settings-layout.css";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogFooter,
} from "../components/ui/alert-dialog";
const PresenceContext = createContext<{
  open: boolean;
  complete: () => void;
} | null>(null);
/** Retain a conditionally rendered form until Base UI finishes its exit animation.
 * The parent still owns close guards and saving; no timeout delays the action. */
export function SurfacePresence({ children }: { children: ReactNode }) {
  const [retained, setRetained] = useState(children);
  if (children && children !== retained) setRetained(children);
  return (
    <PresenceContext.Provider
      value={{ open: !!children, complete: () => setRetained(null) }}
    >
      {children || retained}
    </PresenceContext.Provider>
  );
}
export const ModalPresence = SurfacePresence;
export function useSurfacePresence() {
  return useContext(PresenceContext);
}
export function Modal({
  title,
  children,
  onClose,
  footer,
  wide = false,
  className = "",
  confirmation = false,
  layout = "default",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
  confirmation?: boolean;
  layout?: "default" | "settings" | "account";
}) {
  const presence = useContext(PresenceContext);
  const popup = useRef<HTMLDivElement>(null);
  if (confirmation)
    return (
      <AlertDialog
        open={presence?.open ?? true}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onOpenChangeComplete={(open) => {
          if (!open) presence?.complete();
        }}
      >
        <AlertDialogContent
          className={cn(
            "max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto",
            className,
          )}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="text-sm text-muted-foreground">{children}</div>
          <AlertDialogFooter>{footer}</AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  return (
    <Dialog
      open={presence?.open ?? true}
      modal={presence?.open ?? true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) presence?.complete();
      }}
    >
      <DialogContent
        ref={popup}
        initialFocus={
          layout === "settings" || layout === "account" ? popup : undefined
        }
        inert={presence ? !presence.open : false}
        className={cn(
          "modal flex max-h-[calc(100dvh-2rem)] flex-col",
          layout === "account"
            ? "account-settings-frame"
            : wide
              ? "wide sm:max-w-2xl"
              : "sm:max-w-md",
          layout === "settings" &&
            "h-[min(30rem,calc(100dvh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-3xl",
          layout === "account" && "gap-0 overflow-hidden p-0",
          className,
        )}
      >
        <DialogHeader
          className={cn(
            "shrink-0 pr-8",
            layout === "settings" && "border-b px-5 py-4 text-left",
          )}
        >
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div
          className={cn(
            "modal-body min-h-0 overflow-y-auto",
            (layout === "settings" || layout === "account") &&
              "flex flex-1 overflow-hidden",
          )}
        >
          {children}
        </div>
        {footer && (
          <DialogFooter
            className={cn("shrink-0", layout === "settings" && "m-0 px-5 py-3")}
          >
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
