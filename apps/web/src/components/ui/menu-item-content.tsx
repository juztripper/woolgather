import type { ReactNode } from "react";

/** Shared icon, name and supporting copy for composer actions and suggestions. */
export function MenuItemContent({
  icon,
  label,
  description,
  descriptionId,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  descriptionId?: string;
}) {
  return (
    <>
      {icon}
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span>{label}</span>
        <span id={descriptionId} className="text-muted-foreground">
          {description}
        </span>
      </span>
    </>
  );
}
