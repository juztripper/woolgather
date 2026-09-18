import type { ComponentProps } from "react";
import type { LoginProvider } from "../oauth";
import { Button as ShadcnButton } from "../components/ui/button";
import { cn } from "../lib/utils";

type ButtonProps = ComponentProps<"button"> & {
  variant?:
    | "primary"
    | "secondary"
    | "quiet"
    | "inline"
    | "danger"
    | "danger-primary"
    | "navigation"
    | "surface";
  fullWidth?: boolean;
  size?:
    "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
};

/** All actions share the same type, target size and states. Layout belongs to the parent. */
export function Button({
  variant = "secondary",
  type = "button",
  fullWidth = false,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <ShadcnButton
      type={type}
      variant={
        variant === "primary"
          ? "default"
          : variant === "secondary"
            ? "outline"
            : variant === "danger" || variant === "danger-primary"
              ? "destructive"
              : variant === "inline"
                ? "link"
                : "ghost"
      }
      className={cn(
        "button",
        `button--${variant}`,
        fullWidth && "w-full",
        variant === "navigation" &&
          "h-control justify-start px-control-padding-sm py-0 font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground active:not-disabled:scale-100",
        variant === "surface" &&
          "block h-auto whitespace-normal rounded-[inherit] p-0 text-left hover:bg-transparent active:not-disabled:scale-100",
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({
  "aria-label": label,
  className = "",
  ...props
}: Omit<ButtonProps, "variant" | "fullWidth"> & { "aria-label": string }) {
  return (
    <Button
      variant="quiet"
      size="icon"
      aria-label={label}
      className={`button--icon ${className}`}
      {...props}
    />
  );
}

/** Provider identity is explicit; provider marks never become woolgather branding. */
export function ProviderButton({
  provider,
  ...props
}: Omit<ButtonProps, "variant" | "children"> & { provider: LoginProvider }) {
  return (
    <Button variant="secondary" fullWidth {...props}>
      <img
        className={`provider-mark provider-mark--${provider}`}
        src={`/brand/${provider === "google" ? "google-gradient.png" : "github.svg"}`}
        alt=""
      />
      Continue with {provider === "google" ? "Google" : "GitHub"}
    </Button>
  );
}
