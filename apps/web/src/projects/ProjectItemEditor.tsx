import { PanelPage } from "@/components/ui/panel-page";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Link2, RotateCcw, Trash2, CheckCheck } from "lucide-react";
import {
  categories,
  type Action,
  type Command,
  type Item,
  type ItemInput,
  type Project,
} from "../../../../packages/domain/src";
import { ApiError, makeCommand } from "../client";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Select } from "../ui/Select";
import { Disclosure } from "../ui/Disclosure";
import { Feedback } from "../ui/Toast";
import { ProjectTransport } from "./ProjectTransport";
import {
  labels,
  singular,
  blankThought,
  readDraft,
  storeDraft,
  clearDraft,
} from "./model";
const blank = blankThought();

export function ProjectItemEditor({
  project,
  item,
  owner,
  initial,
  readOnly = false,
  embedded = false,
  focusField = "title",
  initialRevision,
  onExit,
  onClose,
  onSaved,
}: {
  project: Project;
  item: Item | null;
  owner: string;
  initial?: Partial<ItemInput>;
  readOnly?: boolean;
  embedded?: boolean;
  focusField?: "title" | "answer";
  initialRevision?: number;
  onExit?: () => void;
  onClose: () => void;
  onSaved: (p: Project, focusId: string) => void;
}) {
  const { command: sendCommand, request: api } = useContext(ProjectTransport);
  const key = `wg:${owner}:${project.id}:${item?.id || "new"}`;
  const cached = useRef(readOnly ? null : readDraft(key));
  const original: ItemInput = item
    ? {
        title: item.title,
        body: item.body,
        category: item.category,
        certainty: item.certainty,
        status: item.status,
        answer: item.answer,
        links: item.links,
      }
    : { ...blank, category: initial?.category || blank.category };
  const [value, setValue] = useState<ItemInput>(
    cached.current?.value || { ...original, ...initial },
  );
  const [base, setBase] = useState<number>(
    cached.current?.base ?? initialRevision ?? project.revision,
  );
  const [pending, setPending] = useState<Command | null>(
    cached.current?.pending || null,
  );
  const itemId = useRef<string>(
    cached.current?.itemId || item?.id || crypto.randomUUID(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Project | null>(null);
  const [draftSafe, setDraftSafe] = useState(true);
  const dirty = JSON.stringify(value) !== JSON.stringify(original);
  useEffect(() => {
    if (readOnly) return;
    if (!dirty && !pending) {
      clearDraft(key);
      return;
    }
    setDraftSafe(
      storeDraft(key, { value, base, pending, itemId: itemId.current }),
    );
  }, [key, value, base, pending, dirty, readOnly]);
  const update = <K extends keyof ItemInput>(field: K, next: ItemInput[K]) =>
    setValue((v) => ({ ...v, [field]: next }));
  async function execute(action: Action) {
    if (busy || readOnly) return;
    setBusy(true);
    setError("");
    const cmd = pending || makeCommand(project.id, base, action);
    setPending(cmd);
    storeDraft(key, { value, base, pending: cmd, itemId: itemId.current });
    try {
      const p = await sendCommand(cmd);
      clearDraft(key);
      onSaved(
        p,
        cmd.action.type === "promote_answer"
          ? p.items.find((i) => i.promotedFrom === item?.id)?.id ||
              itemId.current
          : itemId.current,
      );
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        setPending(null);
      } else if (e instanceof ApiError && [400, 404, 422].includes(e.status))
        setPending(null);
    } finally {
      setBusy(false);
    }
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    void execute({
      type: item ? "edit_item" : "add_item",
      itemId: itemId.current,
      item: value,
    });
  };
  const questionOrGap = ["question", "gap"].includes(value.category);
  const title = readOnly
    ? "View thought"
    : item?.removed
      ? "Removed thought"
      : item
        ? "Edit thought"
        : "Add a thought";
  const footer = readOnly ? (
    <Button onClick={onClose}>Close</Button>
  ) : (
    <>
      <span className="draft-state">
        {!dirty && !pending
          ? item
            ? "Saved in this project"
            : "Your words, your plan"
          : draftSafe
            ? "Draft kept on this device"
            : "Recovery copy unavailable"}
      </span>
      <Button
        variant="secondary"
        disabled={busy || !!pending}
        onClick={() => {
          clearDraft(key);
          onClose();
        }}
      >
        {dirty ? "Discard draft" : "Cancel"}
      </Button>
      <Button
        variant="primary"
        disabled={
          busy || conflict || !!item?.removed || (!!item && !dirty && !pending)
        }
        type="submit"
        form="item-form"
      >
        {busy ? "Saving…" : pending ? "Retry save" : "Save thought"}
        <Check size={16} />
      </Button>
    </>
  );
  const content = (
    <form id="item-form" onSubmit={save}>
      <fieldset disabled={readOnly || busy || !!pending || !!item?.removed}>
        <label>
          Title
          <Input
            autoFocus={focusField === "title"}
            required
            maxLength={200}
            value={value.title}
            onChange={(e) => update("title", e.target.value)}
            placeholder="What would you like to capture?"
          />
        </label>
        <label>
          Details <span className="optional">Optional</span>
          <Textarea
            rows={4}
            maxLength={12000}
            value={value.body}
            onChange={(e) => update("body", e.target.value)}
            placeholder="What matters about this? Any boundaries or details to keep?"
          />
        </label>
        {questionOrGap && (
          <div className="question-fields">
            <label>
              {value.category === "question"
                ? "Your answer"
                : "Resolution or next thought"}
              <Textarea
                autoFocus={focusField === "answer"}
                required={["answered", "resolved"].includes(value.status)}
                rows={3}
                maxLength={12000}
                value={value.answer}
                onChange={(e) => update("answer", e.target.value)}
                placeholder="Leave the reasoning here, so it stays with the plan."
              />
            </label>
            <label>
              Where does this stand?
              <Select
                label="Where does this stand?"
                value={value.status}
                options={(value.category === "question"
                  ? ["open", "answered", "deferred"]
                  : ["open", "resolved", "deferred", "recheck"]
                ).map((status) => ({ value: status, label: labels[status] }))}
                onValueChange={(next) =>
                  update("status", next as ItemInput["status"])
                }
              />
            </label>
          </div>
        )}
        <div className="field-pair">
          <label>
            Kind
            <Select
              label="Kind"
              value={value.category}
              options={categories.map((c) => ({
                value: c,
                label: singular[c],
              }))}
              onValueChange={(next) => {
                update("category", next as ItemInput["category"]);
                update("status", "open");
              }}
            />
          </label>
          <label>
            Certainty
            <Select
              label="Certainty"
              value={value.certainty}
              options={[
                { value: "stated", label: "Stated · part of your idea" },
                {
                  value: "tentative",
                  label: "Tentative · still a possibility",
                },
                { value: "confirmed", label: "Confirmed · you’ve decided" },
              ]}
              onValueChange={(next) =>
                update("certainty", next as ItemInput["certainty"])
              }
            />
          </label>
        </div>
        <Disclosure
          variant="plain"
          title={
            <>
              <Link2 size={15} />
              Connected thoughts <span>{value.links.length || ""}</span>
            </>
          }
        >
          <p className="muted">Link the ideas affected by this thought.</p>
          <div className="link-choices">
            {project.items
              .filter((i) => i.id !== item?.id && !i.removed)
              .map((i) => (
                <label key={i.id}>
                  <Checkbox
                    checked={value.links.includes(i.id)}
                    onCheckedChange={(checked) =>
                      update(
                        "links",
                        checked
                          ? [...value.links, i.id]
                          : value.links.filter((id) => id !== i.id),
                      )
                    }
                  />
                  <span>{i.title}</span>
                </label>
              ))}
            {project.items.filter((i) => i.id !== item?.id && !i.removed)
              .length === 0 && (
              <p className="muted">Add another thought to connect it here.</p>
            )}
          </div>
        </Disclosure>
      </fieldset>
      {item && (
        <div className="item-provenance">
          <span>{item.source}</span>
          <span>
            {item.promotedFrom
              ? "Linked to the question you answered"
              : "Your intent, recorded directly"}
          </span>
        </div>
      )}
      {cached.current && (
        <p className="draft-recovered">
          Your previous draft is here, just as you left it.
        </p>
      )}
      {error && (
        <Feedback
          message={error}
          tone="error"
          action={
            pending && !conflict
              ? {
                  label: "Retry save",
                  onClick: () => void execute(pending.action),
                }
              : undefined
          }
        />
      )}
      {conflict && (
        <div className="conflict">
          <Button
            variant="secondary"
            type="button"
            onClick={async () => {
              try {
                setLatest(await api<Project>("/projects/" + project.id));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Review latest version
          </Button>
          {latest && (
            <>
              <h3>Latest saved thought</h3>
              <p>
                {latest.items.find((i) => i.id === item?.id)?.title ||
                  "This is a new thought."}
              </p>
              <p>{latest.items.find((i) => i.id === item?.id)?.body}</p>
              <p>
                {
                  labels[
                    latest.items.find((i) => i.id === item?.id)?.certainty || ""
                  ]
                }
                {latest.items.find((i) => i.id === item?.id)?.removed
                  ? " · Removed in the latest plan"
                  : ""}
              </p>
              <p>
                {
                  labels[
                    latest.items.find((i) => i.id === item?.id)?.category || ""
                  ]
                }{" "}
                ·{" "}
                {
                  labels[
                    latest.items.find((i) => i.id === item?.id)?.status || ""
                  ]
                }
              </p>
              <p>
                Connected thoughts:{" "}
                {latest.items
                  .find((i) => i.id === item?.id)
                  ?.links.map(
                    (id) => latest.items.find((i) => i.id === id)?.title || id,
                  )
                  .join(", ") || "None"}
              </p>
              <p>{latest.items.find((i) => i.id === item?.id)?.answer}</p>
              <p>
                Your draft remains in the fields above. Review any differences
                before saving.
              </p>
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  setBase(latest.revision);
                  setConflict(false);
                  setLatest(null);
                  setError("");
                }}
              >
                I’ve reviewed it — keep editing my draft
              </Button>
            </>
          )}
        </div>
      )}
      {item && !pending && !readOnly && (
        <div className="editor-actions">
          {item.removed ? (
            <Button
              variant="secondary"
              type="button"
              disabled={busy || conflict}
              onClick={() =>
                void execute({ type: "restore_item", itemId: item.id })
              }
            >
              <RotateCcw size={14} />
              Restore thought
            </Button>
          ) : (
            <>
              <Button
                variant="danger"
                type="button"
                disabled={busy || conflict}
                onClick={() =>
                  void execute({ type: "remove_item", itemId: item.id })
                }
              >
                <Trash2 size={14} />
                Move to removed
              </Button>
              {item.category === "question" && item.status === "answered" && (
                <Button
                  variant="secondary"

                  type="button"
                  disabled={busy || conflict}
                  onClick={() =>
                    void execute({
                      type: "promote_answer",
                      itemId: item.id,
                      decisionId: crypto.randomUUID(),
                    })
                  }
                >
                  <CheckCheck size={14} />
                  Add saved answer to decisions
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </form>
  );
  if (embedded)
    return (
      <PanelPage
        title={title}
        backLabel="Back to thought"
        onBack={onClose}
        onClose={onExit || onClose}
        footer={footer}
        className="project-thought-editor plan-editor"
      >
        {content}
      </PanelPage>
    );
  return (
    <Modal
      title={title}
      className="project-thought-editor"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={footer}
    >
      {content}
    </Modal>
  );
}
