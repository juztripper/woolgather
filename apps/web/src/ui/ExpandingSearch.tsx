import { useLayoutEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { IconButton } from "./Button";
import { Input } from "@/components/ui/input";

export function ExpandingSearch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || !!value;
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (open) field.current?.focus({ preventScroll: true });
  }, [open]);
  const close = () => {
    onChange("");
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  return (
    <div
      className="expanding-search"
      data-open={expanded}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <IconButton
        ref={trigger}
        aria-label={label}
        aria-expanded={expanded}
        className="active:not-disabled:scale-100"
        onClick={() => {
          if (expanded) close();
          else setOpen(true);
        }}
      >
        <Search />
      </IconButton>
      <div className="expanding-search-field" inert={!expanded}>
        <Input
          ref={field}
          className="h-full border-0 bg-transparent px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0"
          aria-label={label}
          placeholder={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <IconButton size="icon-sm" aria-label="Close search" onClick={close}>
          <X />
        </IconButton>
      </div>
    </div>
  );
}
