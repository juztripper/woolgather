import { useMaterialSurface } from "../ui/materialMotion";
import { MorphText } from "../ui/MorphText";
import { Popover } from "@base-ui/react/popover";
import { Slider } from "@base-ui/react/slider";
import { ChevronDown } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { Button } from "../ui/Button";
import { formatModelName } from "./modelName";
import { usePlan, openPlan } from "../account/PlanProvider";
import { planRoute } from "../../../../packages/domain/src/plans";
import { Select } from "../ui/Select";
import {
  planningModes,
  reasoningLevels,
  type ComposerOptions,
} from "../../../../packages/domain/src/planningComposer";
const positions = ["auto", ...reasoningLevels] as const;
const labels = ["Auto", "Quick", "Thoughtful", "Deep"];
export function ReasoningControl({
  value,
  onChange,
  disabled,
}: {
  value: ComposerOptions;
  onChange: (v: ComposerOptions) => boolean;
  disabled: boolean;
}) {
  const surfaceRef = useMaterialSurface<HTMLDivElement>();
  const { plan } = usePlan();
  const [open, setOpen] = useState(false);
  const index = positions.indexOf(value.reasoning);
  const level = value.reasoning === "auto" ? "thoughtful" : value.reasoning;
  const selected = plan?.enabled
    ? planRoute(level, plan.tier, value.modelPreference)
    : value.modelPreference === "luna"
      ? planRoute(level, "paid", "luna")
      : planningModes[level];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            variant="quiet"
            disabled={disabled}
            aria-label="Reasoning mode"
            className="w-auto justify-center gap-1.5 px-3 text-center"
          />
        }
      >
        <MorphText>{open ? "Select effort" : labels[index]}</MorphText>{" "}
        <ChevronDown size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="center"
          sideOffset={8}
          className="z-50"
        >
          <Popover.Popup
            ref={surfaceRef}
            className="material-popup w-64 max-w-[calc(100vw-1rem)] rounded-xl p-4 text-popover-foreground outline-none"
          >
            <div className="flex items-center justify-center">
              <div className="text-center">
                <Popover.Title className="text-sm font-medium text-primary">
                  <MorphText>{labels[index]}</MorphText>
                </Popover.Title>
                <p
                  className="text-xs text-muted-foreground"
                  title={
                    value.reasoning === "auto" ? undefined : selected.model
                  }
                >
                  {value.reasoning === "auto"
                    ? (plan?.enabled && plan.tier === "free") ||
                      value.modelPreference === "luna"
                      ? "GPT-5.6 Luna · adaptive effort"
                      : "Chosen for your message"
                    : formatModelName(selected.model)}
                </p>
              </div>
            </div>
            <Slider.Root
              thumbAlignment="edge"
              min={0}
              max={3}
              step={1}
              value={index}
              onValueChange={(v) =>
                onChange({ ...value, reasoning: positions[v] })
              }
              className="reasoning-slider mt-3 w-full"
              style={{ "--reasoning-progress": index / 3 } as CSSProperties}
            >
              <Slider.Control className="relative flex h-9 w-full touch-none items-center select-none">
                <Slider.Track className="relative mx-0.5 h-6 w-full overflow-hidden rounded-full bg-muted">
                  <Slider.Indicator className="reasoning-slider-fill bg-primary" />
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-3 inset-y-0 flex items-center justify-between"
                  >
                    {labels.map((label) => (
                      <span
                        key={label}
                        className={`size-1 rounded-full transition-colors ${labels.indexOf(label) < index ? "bg-primary-foreground/50" : "bg-foreground/30"}`}
                      />
                    ))}
                  </div>
                </Slider.Track>
                <Slider.Thumb
                  getAriaLabel={() => "Reasoning level"}
                  getAriaValueText={(_, v) => labels[v]}
                  className="reasoning-slider-thumb block size-7 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="reasoning-slider-knob pointer-events-none block size-full rounded-full border border-border bg-background shadow-sm" />
                </Slider.Thumb>
              </Slider.Control>
            </Slider.Root>
            {(plan?.tier === "paid" || plan?.testing) && (
              <div className="mt-3">
                <Select
                  label="Model choice"
                  value={value.modelPreference || "auto"}
                  onValueChange={(modelPreference) =>
                    onChange({
                      ...value,
                      modelPreference: modelPreference as "auto" | "luna",
                    })
                  }
                  options={[
                    { value: "auto", label: "Luna and Sol" },
                    { value: "luna", label: "Luna · lower usage" },
                  ]}
                />
              </div>
            )}
            {plan?.enabled && plan.tier === "free" && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Luna at every effort.{" "}
                <Button
                  variant="inline"
                  onClick={() => {
                    setOpen(false);
                    openPlan();
                  }}
                >
                  Unlock Sol
                </Button>
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
