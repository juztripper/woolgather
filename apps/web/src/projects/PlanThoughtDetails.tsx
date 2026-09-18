import {
  Link2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { Project } from "../../../../packages/domain/src";
import { thinkingOf } from "../../../../packages/domain/src/projectPlanning";
import { PanelPage } from "@/components/ui/panel-page";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button, IconButton } from "@/ui/Button";
import { Disclosure } from "@/ui/Disclosure";
import { ProjectText } from "./ProjectText";
import {
  relationLabel,
  inverseRelationLabel,
  visualConcepts,
  type VisualConcept,
} from "./PlanningMap";
import { labels, singular } from "./model";

export function PlanThoughtDetails({
  project,
  chosen,
  busy,
  readOnly,
  onBack,
  onClose,
  onSelect,
  onEdit,
  onAnswer,
  onDiscuss,
  onConnect,
  onDisconnect,
  onRemove,
  onAdopt,
  onDismiss,
}: {
  project: Project;
  chosen: VisualConcept;
  busy: boolean;
  readOnly: boolean;
  onBack: () => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  onEdit: () => void;
  onAnswer: () => void;
  onDiscuss: () => void;
  onConnect: () => void;
  onDisconnect: (id: string) => void;
  onRemove: () => void;
  onAdopt: () => void;
  onDismiss: () => void;
}) {
  const concepts = visualConcepts(project);
  const links = thinkingOf(project)
    .relations.filter((r) => r.from === chosen.id || r.to === chosen.id)
    .flatMap((r) => {
      const other = concepts.find(
        (c) => c.id === (r.from === chosen.id ? r.to : r.from),
      );
      return other
        ? [
            {
              id: r.id,
              other,
              label:
                r.from === chosen.id
                  ? relationLabel[r.kind]
                  : inverseRelationLabel[r.kind],
              reason: r.reason,
            },
          ]
        : [];
    });
  const legacyLinks = (chosen.item?.links || [])
    .filter((id) => !links.some((link) => link.other.id === id))
    .flatMap((id) => {
      const other = concepts.find((c) => c.id === id);
      return other ? [other] : [];
    });
  const wording = chosen.proposal?.item || chosen;
  const question = ["question", "gap"].includes(chosen.category);
  return (
    <PanelPage
      title={`About ${chosen.title}`}
      backLabel="Back to plan"
      onBack={onBack}
      onClose={onClose}
      focusOnMount
      actions={
        !readOnly && chosen.item && !chosen.proposal ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton size="icon-sm" aria-label="Thought options" />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onConnect} disabled={busy}>
                <Link2 />
                Add connection
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onRemove}
                disabled={busy}
                variant="destructive"
              >
                <Trash2 />
                Remove thought
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
      footer={
        chosen.proposal ? (
          <>
            <Button
              size="sm"
              variant="quiet"
              disabled={busy || readOnly}
              onClick={onDismiss}
            >
              Dismiss suggestion
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || readOnly}
              onClick={onAdopt}
            >
              Keep this
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="quiet"
              aria-label="Discuss this"
              disabled={busy || readOnly}
              onClick={onDiscuss}
            >
              <MessageCircle />
              Discuss
            </Button>
            {!readOnly && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={onEdit}
                aria-label="Edit thought"
              >
                <Pencil />
                Edit
              </Button>
            )}
          </>
        )
      }
    >
      <div className="plan-thought-meta">
        <span>{singular[chosen.category] || "Thought"}</span>
        {chosen.proposal ? (
          <span className="plan-status">Suggestion</span>
        ) : (
          <span>
            {chosen.certainty === "tentative"
              ? "Possibility"
              : chosen.certainty === "confirmed"
                ? "Decided"
                : "In your plan"}
          </span>
        )}
        {question && chosen.item && <span>{labels[chosen.item.status]}</span>}
      </div>
      {(!wording.body.trim().startsWith(wording.title.trim()) ||
        wording.body.trim() === wording.title.trim()) && (
        <h3 className="plan-thought-title">{wording.title}</h3>
      )}
      {wording.body.trim() !== wording.title.trim() && (
        <div className="plan-thought-prose">
          <ProjectText text={wording.body} />
        </div>
      )}
      {chosen.proposal && (
        <p className="plan-caption">
          Review this suggestion before keeping it in your plan.
        </p>
      )}
      {chosen.proposal && chosen.item && (
        <Disclosure
          className="plan-source"
          title="Current saved wording"
          variant="plain"
        >
          <h4>{chosen.item.title}</h4>
          <ProjectText text={chosen.item.body} />
        </Disclosure>
      )}
      {question && !chosen.proposal && (
        <section className="plan-detail-section" aria-label="Answer">
          <div className="plan-section-heading">
            <h4>{chosen.category === "gap" ? "Resolution" : "Answer"}</h4>
            {!readOnly && (
              <Button
                size="xs"
                variant="quiet"
                disabled={busy}
                onClick={onAnswer}
              >
                {chosen.item?.answer ? "Edit answer" : "Add answer"}
              </Button>
            )}
          </div>
          {chosen.item?.answer ? (
            <div className="plan-thought-prose">
              <ProjectText text={chosen.item.answer} />
            </div>
          ) : (
            <p className="plan-caption">
              {chosen.item?.status === "deferred"
                ? "Kept for later."
                : "This is still open."}
            </p>
          )}
        </section>
      )}
      {!chosen.proposal && (
        <section
          className="plan-detail-section"
          aria-label="Connected thoughts"
        >
          <div className="plan-section-heading">
            <h4>
              Connections
              {links.length + legacyLinks.length
                ? ` (${links.length + legacyLinks.length})`
                : ""}
            </h4>
            {!readOnly && (
              <Button
                size="xs"
                variant="quiet"
                disabled={busy}
                onClick={onConnect}
              >
                <Plus />
                Connect
              </Button>
            )}
          </div>
          {!links.length && !legacyLinks.length && (
            <p className="plan-caption">
              Connect a thought to show what it needs, affects, or leads to.
            </p>
          )}
          {links.map((link) => (
            <div className="plan-related" key={link.id}>
              <Button
                variant="quiet"
                className="plan-related-open h-auto min-w-0 flex-1 justify-start gap-2 whitespace-normal rounded-xl px-3 py-2 text-left active:not-disabled:scale-100"
                onClick={() => onSelect(link.other.id)}
              >
                <span className="min-w-0">
                  <span className="plan-caption block">{link.label}</span>
                  <span className="block break-words">{link.other.title}</span>
                  {link.reason && (
                    <span className="plan-caption block">{link.reason}</span>
                  )}
                </span>
              </Button>
              {!readOnly && (
                <IconButton
                  size="icon-xs"
                  aria-label={`Disconnect ${link.other.title}`}
                  onClick={() => onDisconnect(link.id)}
                  disabled={busy}
                >
                  <X />
                </IconButton>
              )}
            </div>
          ))}
          {legacyLinks.map((other) => (
            <Button
              variant="quiet"
              key={other.id}
              className="h-auto w-full justify-start whitespace-normal rounded-xl px-3 py-2 text-left active:not-disabled:scale-100"
              onClick={() => onSelect(other.id)}
            >
              <span>
                <span className="plan-caption block">Related to</span>
                {other.title}
              </span>
            </Button>
          ))}
        </section>
      )}
      {chosen.item?.evidence && (
        <Disclosure
          className="plan-source"
          title="Where this came from"
          variant="plain"
        >
          <blockquote>{chosen.item.evidence.quote}</blockquote>
        </Disclosure>
      )}
    </PanelPage>
  );
}
