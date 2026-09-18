import type { ComponentProps } from "react";
import { Badge as ShadcnBadge } from "../components/ui/badge";
export function Badge({
  tone = "neutral",
  ...props
}: ComponentProps<"span"> & { tone?: "neutral" | "accent" }) {
  return (
    <ShadcnBadge
      variant={tone === "accent" ? "secondary" : "outline"}
      {...props}
    />
  );
}
