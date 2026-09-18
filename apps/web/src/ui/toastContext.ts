import { createContext, useContext } from "react";

export type ToastOptions = {
  id?: string;
  tone?: "success" | "info" | "error";
  duration?: number;
  action?: { label: string; onClick: () => void };
};

// Keep context identity stable when the rendered notification components refresh.
export const ToastContext = createContext<
  ((message: string, options?: ToastOptions) => void) | null
>(null);

export function useToast() {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast requires ToastProvider");
  return { notify };
}
