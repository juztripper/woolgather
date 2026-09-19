import { useState } from "react";
import { Check, Search } from "lucide-react";
import type { Item } from "../../../../packages/domain/src";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Checkbox } from "../components/ui/checkbox";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/ui/tabs";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { Disclosure } from "../ui/Disclosure";
import { buildSelectionLimit, selectBuildThoughts } from "./buildSelection";

const kinds = [
  { value: "all", label: "All thoughts" },
  { value: "feature", label: "Features" },
  { value: "purpose", label: "Purpose" },
  { value: "decision", label: "Decisions" },
  { value: "note", label: "Notes" },
];

export function BuildScopePicker({
  thoughts,
  criteria,
  onChange,
  disabled,
}: {
  thoughts: Item[];
  criteria: Record<string, string>;
  onChange: (criteria: Record<string, string>) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [tab, setTab] = useState("choose");
  const selected = thoughts.filter((item) => Object.hasOwn(criteria, item.id));
  const visible = thoughts.filter(
    (item) =>
      (kind === "all" || kind === item.category) &&
      `${item.title} ${item.body}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const additions = visible.filter(
    (item) => !Object.hasOwn(criteria, item.id),
  ).length;
  const fits = selected.length + additions <= buildSelectionLimit;
  function toggle(item: Item, checked: boolean) {
    if (checked) onChange(selectBuildThoughts(criteria, [item]));
    else {
      const next = { ...criteria };
      delete next[item.id];
      onChange(next);
    }
  }
  return (
    <Tabs value={tab} onValueChange={setTab} className="build-scope-picker">
      <TabsList aria-label="Version scope">
        <TabsTrigger value="choose">Thoughts</TabsTrigger>
        <TabsTrigger value="review" disabled={!selected.length}>
          Review {selected.length ? `(${selected.length})` : "selection"}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="choose">
        <div className="build-picker-tools">
          <div className="build-picker-search">
            <Search aria-hidden="true" size={16} />
            <Input
              className="pl-9"
              aria-label="Find a thought for this version"
              placeholder={`Search ${thoughts.length} thoughts…`}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Select
            label="Thought kind"
            value={kind}
            options={kinds}
            onValueChange={setKind}
          />
        </div>
        <div className="build-picker-summary">
          <span role="status">
            {selected.length} of {buildSelectionLimit} selected ·{" "}
            {visible.length} shown
          </span>
          <Button
            size="sm"
            variant="quiet"
            disabled={disabled || !additions || !fits}
            onClick={() => onChange(selectBuildThoughts(criteria, visible))}
          >
            Select results
          </Button>
        </div>
        {!fits && additions > 0 && (
          <p className="project-build-help">
            Narrow the search or choose individual thoughts. Each version holds
            up to {buildSelectionLimit}.
          </p>
        )}
        <div className="build-picker-list" aria-label="Available thoughts">
          {visible.map((item) => {
            const checked = Object.hasOwn(criteria, item.id);
            return (
              <label
                key={item.id}
                className="build-picker-row"
                data-selected={checked}
              >
                <Checkbox
                  checked={checked}
                  disabled={
                    disabled ||
                    (!checked && selected.length >= buildSelectionLimit)
                  }
                  onCheckedChange={(value) => toggle(item, value === true)}
                />
                <span>
                  <strong>{item.title}</strong>
                  <span className="build-picker-preview">
                    {item.body || item.category}
                  </span>
                </span>
              </label>
            );
          })}
          {!visible.length && (
            <p className="build-picker-empty">
              {thoughts.length
                ? "No matching thoughts. Try a different search or kind."
                : "Add features, decisions or notes in your Plan first."}
            </p>
          )}
        </div>
      </TabsContent>
      <TabsContent value="review">
        <p className="project-build-help">
          Open a thought to refine what “done” means. Your original Plan stays
          as it is.
        </p>
        <div className="build-picker-review">
          {selected.map((item, index) => (
            <Disclosure
              key={item.id}
              title={
                <>
                  <Check size={14} />
                  {item.title}
                </>
              }
              variant="plain"
              defaultOpen={index === 0}
            >
              <label className="project-build-criterion">
                Done when
                <Textarea
                  aria-label={`Done when: ${item.title}`}
                  value={criteria[item.id]}
                  maxLength={2000}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...criteria, [item.id]: event.target.value })
                  }
                />
              </label>
              <Button
                size="sm"
                variant="quiet"
                disabled={disabled}
                onClick={() => {
                  toggle(item, false);
                  if (selected.length === 1) setTab("choose");
                }}
              >
                Remove from version
              </Button>
            </Disclosure>
          ))}
        </div>
      </TabsContent>
    </Tabs>
  );
}
