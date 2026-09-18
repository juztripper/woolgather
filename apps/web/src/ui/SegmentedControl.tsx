import type { ReactNode, CSSProperties } from "react";
import { Button } from "./Button";

export function SegmentedControl({
  label,
  value,
  onChange,
  options,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; content: ReactNode }[];
  className?: string;
}) {
  return (
    <div
      className={`segmented-control ${className}`}
      role="group"
      aria-label={label}
      style={
        {
          "--segments": options.length,
          "--selected-segment": Math.max(
            0,
            options.findIndex((option) => option.value === value),
          ),
        } as CSSProperties
      }
    >
      <span className="segmented-lens" aria-hidden="true" />
      {options.map((option) => (
        <Button
          key={option.value}
          variant="quiet"
          className="hover:bg-transparent hover:shadow-none active:not-disabled:scale-100"
          size="sm"
          aria-label={option.label}
          title={option.label}
          aria-pressed={value === option.value}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.content}
        </Button>
      ))}
    </div>
  );
}
