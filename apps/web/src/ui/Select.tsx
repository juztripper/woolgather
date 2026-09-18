import { useState } from "react";
import {
  Select as SelectRoot,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { cn } from "../lib/utils";
export type SelectOption = { value: string; label: string; disabled?: boolean };
/** Choose a form value. Menus of actions use DropdownMenu instead. */
export function Select({
  label,
  name,
  value,
  defaultValue,
  options,
  disabled = false,
  openOnMount = false,
  className,
  onValueChange,
}: {
  label: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  options: readonly SelectOption[];
  disabled?: boolean;
  openOnMount?: boolean;
  className?: string;
  onValueChange?: (value: string) => void;
}) {
  const [local, setLocal] = useState(defaultValue ?? options[0]?.value ?? "");
  const selected = value ?? local;
  return (
    <SelectRoot
      name={name}
      value={selected}
      items={options}
      disabled={disabled}
      defaultOpen={openOnMount && !disabled}
      onValueChange={(next) => {
        if (next === null) return;
        setLocal(next);
        onValueChange?.(next);
      }}
    >
      <SelectTrigger
        className={cn("min-w-0 max-w-full", className)}
        aria-label={label}
      >
        <SelectValue className="min-w-0">
          <span className="truncate">
            {options.find((option) => option.value === selected)?.label ??
              "Choose"}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        aria-label={label}
      >
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              <span className="min-w-0 whitespace-normal break-words">
                {option.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </SelectRoot>
  );
}
