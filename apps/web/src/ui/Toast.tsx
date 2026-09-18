import { type ReactNode, useCallback, useEffect, useId, useRef } from "react";
import { toast } from "sonner";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";
import { ToastContext, useToast, type ToastOptions } from "./toastContext";
export { useToast } from "./toastContext";
/** Notifications outlive the dialog or page that caused them. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const notify = useCallback((message: string, options: ToastOptions = {}) => {
    const tone = options.tone ?? "success";
    const duration =
      options.duration ??
      (tone === "error" ? Infinity : tone === "info" ? 8000 : 5000);
    toast[tone](message, {
      id: options.id,
      duration: duration === 0 ? Infinity : duration,
      action: options.action,
    });
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      <TooltipProvider>
        {children}
        <Toaster closeButton position="bottom-right" />
      </TooltipProvider>
    </ToastContext.Provider>
  );
}
/** Bridge existing form feedback to the page notification without inline layout. */
export function Feedback({
  message,
  tone = "info",
  action,
}: {
  message: string;
  tone?: ToastOptions["tone"];
  action?: ToastOptions["action"];
}) {
  const { notify } = useToast();
  const actionRef = useRef(action);
  actionRef.current = action;
  const id = useId();
  useEffect(() => {
    if (!message) return;
    notify(message, {
      id,
      tone,
      action: actionRef.current
        ? {
            label: actionRef.current.label,
            onClick: () => actionRef.current?.onClick(),
          }
        : undefined,
    });
    return () => {
      if (tone === "error") toast.dismiss(id);
    };
  }, [message, tone, notify, id]);
  return null;
}
