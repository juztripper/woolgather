import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ChevronRight,
  CircleHelp,
  FileText,
  Lightbulb,
  Link2,
  Route,
} from "lucide-react";
import type { Item, Project } from "../../../../packages/domain/src";
import {
  thinkingOf,
  type PlanningProposal,
  type PlanningRelation,
} from "../../../../packages/domain/src/projectPlanning";
import { Button } from "../ui/Button";
import { labels, singular } from "./model";
import { planningFlow } from "./planningFlow";
export const relationLabel = {
  part_of: "is part of",
  requires: "needs",
  enables: "makes possible",
  affects: "affects",
  alternative_to: "is an alternative to",
  sequence: "then",
};
export type VisualConcept = {
  id: string;
  title: string;
  body: string;
  certainty: string;
  category: string;
  proposal?: PlanningProposal;
  item?: Item;
};

export function bodyStartsWithTitleAtWordBoundary(
  title: string,
  body: string,
): boolean {
  const normalizedTitle = title.trim();
  const normalizedBody = body.trim();
  if (!normalizedTitle || !normalizedBody.startsWith(normalizedTitle)) {
    return false;
  }
  const nextCharacter = Array.from(
    normalizedBody.slice(normalizedTitle.length),
  )[0];
  return (
    nextCharacter === undefined || !/[\p{L}\p{M}\p{N}_]/u.test(nextCharacter)
  );
}

export function planRowTitle(title: string, body: string): string {
  const normalizedTitle = title.trim();
  const normalizedBody = body.trim();
  if (!bodyStartsWithTitleAtWordBoundary(normalizedTitle, normalizedBody))
    return title;
  return normalizedBody === normalizedTitle
    ? title
    : `${normalizedTitle.replace(/\s+\S*$/, "")}…`;
}

export function visualConcepts(project: Project): VisualConcept[] {
  const active: VisualConcept[] = project.items
    .filter((i) => !i.removed)
    .map((item) => ({ ...item, item }));
  for (const proposal of thinkingOf(project).proposals) {
    const saved = active.find((i) => i.id === proposal.itemId);
    if (saved) saved.proposal = proposal;
    else active.push({ ...proposal.item, id: proposal.itemId, proposal });
  }
  return active;
}

export const inverseRelationLabel = {
  part_of: "includes",
  requires: "is needed by",
  enables: "is made possible by",
  affects: "is affected by",
  alternative_to: "is an alternative to",
  sequence: "comes after",
};

function ThoughtCard({
  concept,
  onOpen,
  count = 0,
}: {
  concept: VisualConcept;
  onOpen: (id: string) => void;
  count?: number;
}) {
  const bodyStartsWithTitle = bodyStartsWithTitleAtWordBoundary(
    concept.title,
    concept.body,
  );
  return (
    <Button
      variant="quiet"
      data-plan-thought={concept.id}
      className="plan-thought-row h-auto w-full justify-start items-start gap-3 rounded-xl px-3 py-3 whitespace-normal text-left active:not-disabled:scale-100"
      onClick={() => onOpen(concept.id)}
    >
      <span className="plan-thought-icon" aria-hidden="true">
        {["question", "gap"].includes(concept.category) ? (
          <CircleHelp />
        ) : concept.proposal ? (
          <Lightbulb />
        ) : (
          <FileText />
        )}
      </span>
      <span className="plan-thought-copy">
        <span className="plan-row-meta">
          {singular[concept.category] || "Thought"}
          {concept.item &&
            ["question", "gap"].includes(concept.category) &&
            ` · ${labels[concept.item.status]}`}
          {concept.proposal
            ? " · Suggestion"
            : concept.certainty === "tentative"
              ? " · Possibility"
              : concept.certainty === "confirmed"
                ? " · Decided"
                : ""}
        </span>
        <span className="plan-row-title">
          {planRowTitle(concept.title, concept.body)}
        </span>
        {!bodyStartsWithTitle && (
          <span className="plan-row-summary">{concept.body}</span>
        )}
        {count > 0 && (
          <span className="plan-row-meta">
            {count} {count === 1 ? "connection" : "connections"}
          </span>
        )}
      </span>
      <ChevronRight className="plan-row-chevron" />
    </Button>
  );
}

export function PlanningMap({
  project,
  onFocus,
  view,
  query = "",
}: {
  project: Project;
  focus: string | null;
  onFocus: (id: string | null) => void;
  view: "map" | "flow" | "outline";
  query?: string;
}) {
  const concepts = visualConcepts(project);
  const relations = thinkingOf(project).relations.filter(
    (r) =>
      concepts.some((c) => c.id === r.from) &&
      concepts.some((c) => c.id === r.to),
  );
  if (!concepts.length)
    return (
      <div className="plan-empty">
        <Lightbulb />
        <h3>Start with a thought</h3>
        <p>
          Add something you want to keep in the plan. You can connect and refine
          it as the project develops.
        </p>
      </div>
    );
  if (view === "outline") {
    const visible = concepts.filter((c) =>
      `${c.title} ${c.body} ${singular[c.category]}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    );
    return (
      <div className="plan-thought-list" aria-label="Thoughts">
        {visible.map((c) => (
          <ThoughtCard
            key={c.id}
            concept={c}
            onOpen={onFocus}
            count={
              relations.filter((r) => r.from === c.id || r.to === c.id).length
            }
          />
        ))}
        {!visible.length && (
          <div className="plan-empty">
            <p>No thoughts match “{query}”. Try another word.</p>
          </div>
        )}
      </div>
    );
  }
  if (view === "map") {
    // Older authored links have no direction or kind; display that truth without inventing either.
    const legacy = concepts
      .flatMap((c) =>
        (c.item?.links || []).flatMap((id) => {
          const to = concepts.find((other) => other.id === id);
          if (
            !to ||
            relations.some(
              (r) =>
                (r.from === c.id && r.to === id) ||
                (r.to === c.id && r.from === id),
            )
          )
            return [];
          return [
            {
              id: [c.id, id].sort().join(":"),
              from: c.id,
              to: id,
              kind: "related" as const,
              reason: "",
            },
          ];
        }),
      )
      .filter((r, i, all) => all.findIndex((other) => other.id === r.id) === i);
    const connections = [...relations, ...legacy];
    return (
      <div className="plan-connections-list">
        {connections.length ? (
          connections.map((r) => (
            <article className="plan-connection-pair" key={r.id}>
              <Button
                variant="quiet"
                className="h-auto w-full justify-start rounded-xl px-3 py-2 whitespace-normal text-left active:not-disabled:scale-100"
                onClick={() => onFocus(r.from)}
              >
                <span className="plan-pair-title">
                  {concepts.find((c) => c.id === r.from)!.title}
                </span>
                <ChevronRight className="ml-auto" />
              </Button>
              <div className="plan-relation-label">
                {r.kind === "related" ? (
                  <Link2 size={14} />
                ) : (
                  <ArrowDown size={14} />
                )}
                <span>
                  {r.kind === "related" ? "related to" : relationLabel[r.kind]}
                </span>
              </div>
              <Button
                variant="quiet"
                className="h-auto w-full justify-start rounded-xl px-3 py-2 whitespace-normal text-left active:not-disabled:scale-100"
                onClick={() => onFocus(r.to)}
              >
                <span className="plan-pair-title">
                  {concepts.find((c) => c.id === r.to)!.title}
                </span>
                <ChevronRight className="ml-auto" />
              </Button>
              {r.reason && (
                <p className="plan-caption plan-connection-reason">
                  {r.reason}
                </p>
              )}
            </article>
          ))
        ) : (
          <div className="plan-empty">
            <Link2 />
            <h3>No connections yet</h3>
            <p>
              Open a thought and choose Connect to show how it relates to
              another.
            </p>
          </div>
        )}
      </div>
    );
  }
  const sequences = relations.filter((r) => r.kind === "sequence");
  return (
    <>
      {sequences.length ? (
        <SequenceDiagram
          concepts={concepts}
          relations={sequences}
          onOpen={onFocus}
        />
      ) : (
        <div className="plan-empty">
          <Route />
          <h3>No sequence yet</h3>
          <p>
            Open a thought, choose Connect, then “Followed by” to record what
            happens next.
          </p>
        </div>
      )}
      {sequences.length > 0 && (
        <p className="plan-caption plan-sequence-note">
          Arrows follow your saved order. Thoughts without a next step stay in
          Thoughts.
        </p>
      )}
    </>
  );
}

function SequenceDiagram({
  concepts,
  relations,
  onOpen,
}: {
  concepts: VisualConcept[];
  relations: PlanningRelation[];
  onOpen: (id: string) => void;
}) {
  const diagram = useRef<HTMLDivElement>(null);
  const arrowId = useId();
  const groups = planningFlow(concepts, relations);
  const [drawing, setDrawing] = useState<{
    width: number;
    height: number;
    paths: { id: string; d: string; label: string }[];
  }>({ width: 0, height: 0, paths: [] });
  useLayoutEffect(() => {
    const el = diagram.current;
    if (!el) return;
    const draw = () => {
      const base = el.getBoundingClientRect();
      const nodes = [
        ...el.querySelectorAll<HTMLElement>("[data-plan-thought]"),
      ];
      const bounds = (id: string) => {
        const r = nodes
          .find((n) => n.dataset.planThought === id)
          ?.getBoundingClientRect();
        return (
          r && {
            top: r.top - base.top,
            bottom: r.bottom - base.top,
            left: r.left - base.left,
            right: r.right - base.left,
            x: r.left - base.left + r.width / 2,
            y: r.top - base.top + r.height / 2,
          }
        );
      };
      const paths = relations.flatMap((r, index) => {
        const a = bounds(r.from),
          b = bounds(r.to);
        if (!a || !b) return [];
        const adjacent =
          nodes.findIndex((n) => n.dataset.planThought === r.to) ===
          nodes.findIndex((n) => n.dataset.planThought === r.from) + 1;
        const down = b.y > a.y;
        const lane = down
          ? Math.max(a.right, b.right) + 12 + (index % 3) * 6
          : Math.min(a.left, b.left) - 12 - (index % 3) * 6;
        return [
          {
            id: r.id,
            label: r.reason,
            d: adjacent
              ? `M${a.x},${a.bottom} L${b.x},${b.top}`
              : `M${down ? a.right : a.left},${a.y} L${lane},${a.y} L${lane},${b.y} L${down ? b.right : b.left},${b.y}`,
          },
        ];
      });
      setDrawing({ width: el.clientWidth, height: el.scrollHeight, paths });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    el.querySelectorAll("[data-plan-thought]").forEach((n) =>
      observer.observe(n),
    );
    return () => observer.disconnect();
  }, [concepts, relations]);
  return (
    <div className="plan-sequence" ref={diagram}>
      <svg
        width={drawing.width}
        height={drawing.height}
        aria-hidden="true"
        className="plan-sequence-lines"
      >
        <defs>
          <marker
            id={arrowId}
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0 0 L6 3 L0 6" fill="none" stroke="currentColor" />
          </marker>
        </defs>
        {drawing.paths.map((p) => (
          <path key={p.id} d={p.d} markerEnd={`url(#${arrowId})`}>
            <title>{p.label}</title>
          </path>
        ))}
      </svg>
      {groups.map((group, index) => (
        <section
          className="plan-sequence-group"
          key={group[0].id}
          aria-label={`Sequence ${index + 1}`}
        >
          {group.map((c) => (
            <div className="plan-sequence-step" key={c.id}>
              <ThoughtCard concept={c} onOpen={onOpen} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
