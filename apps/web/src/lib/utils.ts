import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Custom Tailwind spacing names must also be known to the class merger.
// Otherwise a table row's px-2 and the button's px-control-padding coexist,
// and stylesheet order silently decides the rendered padding.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: [
        "control",
        "control-sm",
        "control-xs",
        "control-lg",
        "icon-xs",
        "control-padding",
        "control-padding-sm",
        "control-padding-xs",
        "control-padding-lg",
        "control-gap",
        "field-padding",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
