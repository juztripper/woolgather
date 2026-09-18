import { RemovedThoughts } from "./RemovedThoughts";
import { Input } from "@/components/ui/input";
import { ModalPresence } from "@/ui/Modal";
import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  FileText,
  History as HistoryIcon,
  Lightbulb,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import {
  categories,
  type Action,
  type Command,
  type History,
  type Item,
  type ItemInput,
  type Project,
} from "../../../../packages/domain/src";
import {
  fieldLabels,
  ideaFields,
} from "../../../../packages/domain/src/ideaDocument";
import { makeCommand } from "../client";
import { Button, IconButton } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { Select } from "../ui/Select";
import { ActionMenu } from "../library/ProjectMenu";
import { ProjectReferences } from "../library/ProjectReferences";
import { ReferenceImages } from "../library/ReferenceImages";
import { ProjectTransport } from "./ProjectTransport";
import { ProjectItemEditor } from "./ProjectItemEditor";
import { ProjectBriefEditor } from "./ProjectBriefEditor";
import { ProjectText } from "./ProjectText";
import {
  briefSections,
  clearDraft,
  labels,
  readDraft,
  singular,
  storeDraft,
} from "./model";
import "./project-workspace.css";

const IdeaBlockEditor = lazy(() => import("../library/IdeaBlockEditor"));
const viewNames: Record<string, string> = {
  overview: "Overview",
  plan: "Plan",
  questions: "Questions",
  source: "Original idea",
  references: "Images & references",
  connections: "Connections",
  history: "Activity",
  removed: "Removed thoughts",
};
const prompts: [ItemInput["category"], string, string][] = [
  ["feature", "Shape a feature", "What should someone be able to do?"],
  ["constraint", "Set a boundary", "What needs to stay true?"],
  ["question", "Explore a question", "What do you need to work out?"],
];
const isOpenQuestion = (i: Item) =>
  ["question", "gap"].includes(i.category) &&
  ["open", "recheck"].includes(i.status);

export function ProjectWorkspace({
  project,
  owner,
  view,
  folderName,
  navigation,
  onView,
  onBack,
  onSaved,
  onSettings,
  secondary = false,
}: {
  project: Project;
  owner: string;
  view: string;
  folderName?: string;
  navigation?: import("react").ReactNode;
  onView: (view: string) => void;
  onBack: () => void;
  onSaved: (p: Project) => void;
  onSettings: () => void;
  secondary?: boolean;
}) {
  const transport = useContext(ProjectTransport),
    { notify } = useToast();
  const nextCategory = useRef<string | null>(null);
  const current = useRef(project);
  current.current = project;
  const workspace = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<{
    item: Item | null;
    initial?: Partial<ItemInput>;
  }>();
  const [editingText, setEditingText] = useState<"name" | "description">();
  const scroll = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("all"),
    [status, setStatus] = useState("open");
  const [history, setHistory] = useState<History[]>([]),
    [historyLoading, setHistoryLoading] = useState(false),
    [historyError, setHistoryError] = useState("");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false),
    [error, setError] = useState("");
  const operationKey = `woolgather:project-operation:${owner}:${project.id}`;
  const [pending, setPending] = useState<Command | null>(() =>
    readDraft(operationKey),
  );
  const readOnly = !!project.lifecycle && project.lifecycle !== "active";
  const active = project.items.filter((i) => !i.removed);
  const questions = active.filter((i) =>
    ["question", "gap"].includes(i.category),
  );
  const openQuestions = questions.filter(isOpenQuestion);
  const plan = active.filter((i) => !["question", "gap"].includes(i.category));
  const sections = briefSections(project.description)
    .filter(
      (section) =>
        section.title !== "Questions & answers" || section.body.trim(),
    )
    .map((section) => {
      const field = ideaFields.find((field) => field === section.title);
      const answer =
        field &&
        section.body.match(
          /^Guidance question: ([^\n]+)\n\nYour answer:\n\n([\s\S]*)$/,
        );
      return {
        ...section,
        title: field ? fieldLabels[field] : section.title,
        prompt: answer ? answer[1] : "",
        body: answer ? answer[2] : section.body,
      };
    });
  const hasSource = !!(project.originalIdea || project.ideaDocument);
  useEffect(() => {
    setQuery("");
    setCategory(nextCategory.current || "all");
    nextCategory.current = null;
    scroll.current?.scrollTo({ top: 0 });
  }, [view]);
  useEffect(() => {
    if (view !== "history") return;
    let alive = true;
    setHistoryLoading(true);
    setHistoryError("");
    void transport
      .request<History[]>(`/projects/${project.id}/history`)
      .then((h) => {
        if (alive) setHistory(h);
      })
      .catch((e) => {
        if (alive) setHistoryError(e.message);
      })
      .finally(() => {
        if (alive) setHistoryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [view, project.id, project.revision, historyAttempt, transport]);

  function add(initial: Partial<ItemInput> = {}) {
    if (!readOnly) setEditor({ item: null, initial });
  }
  function openItem(item: Item) {
    setEditor({ item });
  }
  async function run(action?: Action) {
    if (busy || readOnly) return;
    const p = current.current;
    const cmd = pending || (action && makeCommand(p.id, p.revision, action));
    if (!cmd) return;
    setBusy(true);
    setError("");
    setPending(cmd);
    storeDraft(operationKey, cmd);
    try {
      const next = await transport.command(cmd);
      current.current = next;
      onSaved(next);
      setPending(null);
      clearDraft(operationKey);
      notify("Thought restored");
    } catch (e) {
      setError((e as Error).message);
      if (
        [400, 404, 409, 422].includes((e as { status?: number }).status || 0)
      ) {
        setPending(null);
        clearDraft(operationKey);
      }
    } finally {
      setBusy(false);
    }
  }
  async function exportPlan() {
    if (exporting) return;
    setExporting(true);
    try {
      const markdown = await transport.export(project.id);
      const { projectArchive, downloadBlob } =
        await import("../library/exportIdea");
      const blob = await projectArchive(project, markdown);
      const filename =
        blob.type === "application/zip"
          ? "woolgather-project.zip"
          : "woolgather-plan.md";
      downloadBlob(blob, filename);
      notify("Export ready", {
        action: {
          label: "Download again",
          onClick: () => downloadBlob(blob, filename),
        },
      });
    } catch (e) {
      notify((e as Error).message, {
        tone: "error",
        action: { label: "Retry export", onClick: () => void exportPlan() },
      });
    } finally {
      setExporting(false);
    }
  }
  function itemSaved(next: Project, id: string) {
    const before = current.current.items.find((i) => i.id === id),
      after = next.items.find((i) => i.id === id);
    current.current = next;
    onSaved(next);
    setEditor(undefined);
    if (!before) {
      setCategory("all");
      setQuery("");
      if (
        view === "questions" &&
        after &&
        ["question", "gap"].includes(after.category)
      )
        setStatus(
          ["answered", "resolved"].includes(after.status)
            ? "done"
            : after.status === "deferred"
              ? "deferred"
              : "open",
        );
    }
    if (after?.removed && !before?.removed)
      notify("Thought moved to Removed", {
        action: {
          label: "Undo",
          onClick: () => void run({ type: "restore_item", itemId: id }),
        },
      });
    else if (after?.promotedFrom && !before)
      notify("Answer added to decisions", {
        action: {
          label: "Open decision",
          onClick: () => setEditor({ item: after }),
        },
      });
    else notify(before ? "Thought saved" : "Thought added to your plan");
    requestAnimationFrame(() => {
      const target =
        workspace.current?.querySelector<HTMLElement>(
          `#thought-${id} .project-thought-open`,
        ) || workspace.current?.querySelector<HTMLElement>(".project-add");
      target?.focus({ preventScroll: true });
    });
  }
  const list = (
    view === "removed"
      ? project.items.filter((i) => i.removed)
      : view === "questions"
        ? questions
        : view === "connections"
          ? active.filter(
              (i) =>
                i.links.length ||
                active.some((other) => other.links.includes(i.id)),
            )
          : plan
  ).filter(
    (i) =>
      (category === "all" || i.category === category) &&
      (view !== "questions" ||
        status === "all" ||
        (status === "open"
          ? isOpenQuestion(i)
          : status === "done"
            ? ["answered", "resolved"].includes(i.status)
            : i.status === "deferred")) &&
      `${i.title} ${i.body} ${i.answer}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  function row(item: Item) {
    const links = active.filter(
      (i) =>
        i.id !== item.id &&
        (item.links.includes(i.id) || i.links.includes(item.id)),
    );
    return (
      <article
        className="project-thought"
        key={item.id}
        id={`thought-${item.id}`}
      >
        <Button
          variant="surface"
          className="project-thought-open"
          onClick={() => openItem(item)}
          aria-label={`Open ${item.title}`}
        >
          <span
            className={`project-kind-mark ${item.category}`}
            aria-hidden="true"
          >
            {["question", "gap"].includes(item.category) ? (
              <CircleHelp size={16} />
            ) : item.certainty === "confirmed" ? (
              <Check size={16} />
            ) : (
              <span />
            )}
          </span>
          <span className="project-thought-content">
            <span className="project-thought-title">{item.title}</span>
            {item.body && (
              <span className="project-thought-preview">{item.body}</span>
            )}
            <span className="project-thought-meta">
              {["question", "gap"].includes(item.category)
                ? labels[item.status]
                : labels[item.certainty]}
              {item.promotedFrom && " · From an answer"}
              {links.length > 0 && (
                <>
                  <Link2 size={12} />
                  {links.length} connected
                </>
              )}
            </span>
          </span>
          <ChevronRight className="project-row-arrow" size={16} />
        </Button>
        {item.answer && (
          <div className="project-answer-preview">
            <span>
              {item.category === "question" ? "Answer" : "Resolution"}
            </span>
            <ProjectText text={item.answer} />
          </div>
        )}
        {view === "connections" && links.length > 0 && (
          <div className="project-row-links">
            {links.map((i) => (
              <Button variant="quiet" key={i.id} onClick={() => openItem(i)}>
                <Link2 size={13} />
                {i.title}
              </Button>
            ))}
          </div>
        )}
        {item.removed && !readOnly && (
          <Button
            variant="quiet"
            className="project-restore"
            disabled={busy || !!pending}
            onClick={() => void run({ type: "restore_item", itemId: item.id })}
          >
            <RotateCcw size={14} />
            Restore
          </Button>
        )}
      </article>
    );
  }
  function starters() {
    return (
      <div className="project-starters">
        {prompts.map(([kind, label, hint]) => (
          <Button
            variant="surface"
            key={kind}
            disabled={readOnly}
            onClick={() => add({ category: kind })}
          >
            <span className={`category-dot ${kind}`} />
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
            <Plus size={16} />
          </Button>
        ))}
      </div>
    );
  }
  if (view === "removed")
    return (
      <RemovedThoughts
        items={project.items}
        navigation={navigation}
        readOnly={readOnly}
        busy={busy}
        pending={!!pending}
        error={error}
        onBack={() => onView("home")}
        onRestore={(id) => run({ type: "restore_item", itemId: id })}
        onRetry={() => void run()}
      />
    );
  return (
    <section
      ref={workspace}
      className="project-workspace"
      aria-label="Project workspace"
    >
      <div className="project-workspace-toolbar">
        {navigation}
        <Button
          variant="quiet"
          className="project-back"
          onClick={secondary ? () => onView("overview") : onBack}
        >
          <ArrowLeft size={15} />
          <span>
            {secondary ? "Back to conversation" : folderName || "Projects"}
          </span>
        </Button>
        <div className="project-toolbar-actions">
          <span
            className="project-saved"
            title={`Saved revision ${project.revision}`}
          >
            <CheckCheck size={14} />
            Saved
          </span>
          <IconButton
            aria-label={exporting ? "Exporting project" : "Export project"}
            disabled={exporting}
            onClick={() => void exportPlan()}
          >
            <ArrowDownToLine size={16} />
          </IconButton>
          <ActionMenu
            active={!readOnly}
            trashed={project.lifecycle === "trashed"}
            label="Project menu"
            trigger={
              <IconButton aria-label="Project menu">
                <MoreHorizontal />
              </IconButton>
            }
            options={[
              ...(hasSource ? [["source", "Original idea"]] : []),
              ["references", "Images & references"],
              ["connections", "Connections"],
              ["history", "Activity"],
              ["removed", "Removed thoughts"],
              ["settings", "Project settings"],
            ]}
            onAction={(id) => (id === "settings" ? onSettings() : onView(id))}
          />
        </div>
      </div>
      <header className="project-workspace-heading">
        <div className="project-title-line">
          <h1>
            {secondary
              ? view === "source" && !hasSource
                ? "Working brief"
                : viewNames[view]
              : project.name}
          </h1>
          {!readOnly && !secondary && (
            <IconButton
              aria-label="Rename project"
              onClick={() => setEditingText("name")}
            >
              <Pencil size={15} />
            </IconButton>
          )}
        </div>
        {!secondary && (
          <div className="project-tabs-line">
            <nav aria-label="Project views">
              {["overview", "plan", "questions"].map((id) => (
                <Button
                  variant="navigation"
                  key={id}
                  aria-current={view === id ? "page" : undefined}
                  onClick={() => onView(id)}
                >
                  {viewNames[id]}
                  {id === "questions" && openQuestions.length > 0 && (
                    <span className="project-tab-count">
                      {openQuestions.length}
                    </span>
                  )}
                </Button>
              ))}
              {!["overview", "plan", "questions"].includes(view) && (
                <span className="project-secondary-view">
                  {viewNames[view]}
                </span>
              )}
            </nav>
            {!readOnly && (
              <Button
                variant="primary"
                className="project-add"
                onClick={() =>
                  add(view === "questions" ? { category: "question" } : {})
                }
              >
                <Plus size={15} />
                Add thought
              </Button>
            )}
          </div>
        )}
      </header>
      {readOnly && (
        <div className="project-notice">
          This project is{" "}
          {project.lifecycle === "trashed" ? "in Trash" : "archived"}.
          <Button variant="inline" onClick={onSettings}>
            Restore project
          </Button>
        </div>
      )}
      {(pending || error) && (
        <div className="project-notice" role="status">
          <span>{error || "A change is waiting to save."}</span>
          {pending ? (
            <Button disabled={busy} onClick={() => void run()}>
              {busy ? "Saving…" : "Retry change"}
            </Button>
          ) : (
            <Button
              onClick={async () => {
                try {
                  onSaved(
                    await transport.request<Project>(`/projects/${project.id}`),
                  );
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Reload latest
            </Button>
          )}
        </div>
      )}
      <div className="project-workspace-scroll" ref={scroll}>
        <div
          className={`project-workspace-layout${!["overview", "plan"].includes(view) ? " project-workspace-layout--wide" : ""}`}
        >
          <div className="project-working-page">
            {view === "overview" ? (
              <>
                <div className="project-section-heading">
                  <h2>Working brief</h2>
                  {!readOnly && sections.length > 0 && (
                    <Button
                      variant="quiet"
                      onClick={() => setEditingText("description")}
                    >
                      <Pencil size={14} />
                      Edit
                    </Button>
                  )}
                </div>
                {sections.length ? (
                  <div className="project-brief">
                    {sections.map((section, index) => (
                      <section key={index} className="project-brief-section">
                        {section.title && <h3>{section.title}</h3>}
                        <ProjectText text={section.body} />
                        {section.prompt && (
                          <p className="project-brief-prompt">
                            {section.prompt}
                          </p>
                        )}
                        {!readOnly && section.body.trim() && (
                          <Button
                            variant="quiet"
                            className="project-develop"
                            aria-label={`Develop ${section.title || "this passage"}`}
                            onClick={() =>
                              add({
                                title: section.title.slice(0, 200),
                                certainty:
                                  section.title === "Possibilities"
                                    ? "tentative"
                                    : "stated",
                                body:
                                  (section.prompt
                                    ? section.prompt + "\n\n"
                                    : "") + section.body,
                              })
                            }
                          >
                            <Plus size={13} />
                            Develop this
                          </Button>
                        )}
                      </section>
                    ))}
                  </div>
                ) : (
                  <div className="project-brief-empty">
                    <FileText size={24} strokeWidth={1.4} />
                    <h3>Give the project a little context.</h3>
                    <p>
                      Capture what you’re making, who it’s for, and what
                      matters.
                    </p>
                    {!readOnly && (
                      <Button onClick={() => setEditingText("description")}>
                        Write a brief
                      </Button>
                    )}
                  </div>
                )}
                {plan.length > 0 && (
                  <section className="project-overview-plan">
                    <div className="project-section-heading">
                      <h2>
                        {plan.length ? "Taking shape" : "Build on your idea"}
                      </h2>
                      {plan.length > 0 && (
                        <Button variant="quiet" onClick={() => onView("plan")}>
                          Open plan
                          <ArrowRight size={14} />
                        </Button>
                      )}
                    </div>
                    {plan.length ? plan.slice(-3).map(row) : starters()}
                  </section>
                )}
              </>
            ) : view === "source" ? (
              <>
                <div className="project-section-heading">
                  {!secondary && (
                    <h2>{hasSource ? "Original idea" : "Working brief"}</h2>
                  )}
                  {hasSource && (
                    <span className="project-subtle">Kept at creation</span>
                  )}
                  {!hasSource && !readOnly && (
                    <Button
                      variant="quiet"
                      onClick={() => setEditingText("description")}
                    >
                      <Pencil size={14} /> Edit working brief
                    </Button>
                  )}
                </div>
                <p className="project-view-description">
                  {hasSource
                    ? "The complete starting point, including your words, answers and possibilities."
                    : "The context you want to keep close as the project develops."}
                </p>
                {!hasSource && <ProjectText text={project.description} />}
                {project.ideaDocument?.title && (
                  <h3 className="project-source-title">
                    {project.ideaDocument.title}
                  </h3>
                )}
                {project.ideaDocument?.version === 2 ? (
                  <Suspense fallback={<p>Opening original idea…</p>}>
                    <IdeaBlockEditor
                      blocks={project.ideaDocument.blocks}
                      readOnly
                    />
                  </Suspense>
                ) : (
                  <>
                    <ProjectText text={project.originalIdea || ""} />
                    {project.ideaDocument &&
                      ideaFields
                        .filter((f) => project.ideaDocument!.answers[f].trim())
                        .map((f) => (
                          <section className="project-brief-section" key={f}>
                            <h3>
                              {fieldLabels[f]}
                              {f === "possibilities"
                                ? " · not commitments"
                                : ""}
                            </h3>
                            <ProjectText
                              text={project.ideaDocument!.answers[f]}
                            />
                          </section>
                        ))}
                    <ReferenceImages
                      references={project.ideaDocument?.references || []}
                      readOnly
                    />
                  </>
                )}
                {!!project.ideaQuestions?.length && (
                  <section className="project-original-questions">
                    <h3>Open questions at creation</h3>
                    <ul>
                      {project.ideaQuestions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            ) : view === "references" ? (
              <>
                {!secondary && (
                  <div className="project-section-heading">
                    <h2>Images & references</h2>
                  </div>
                )}
                <ProjectReferences
                  project={project}
                  owner={owner}
                  onSaved={onSaved}
                  embedded
                />
              </>
            ) : view === "history" ? (
              <>
                {!secondary && (
                  <div className="project-section-heading">
                    <h2>Activity</h2>
                  </div>
                )}
                <p className="project-view-description">
                  Changes and the reasoning you’ve kept along the way.
                </p>
                {historyLoading ? (
                  <p role="status">Opening activity…</p>
                ) : historyError ? (
                  <div className="project-notice" role="alert">
                    {historyError}
                    <Button onClick={() => setHistoryAttempt((n) => n + 1)}>
                      Retry activity
                    </Button>
                  </div>
                ) : (
                  <ol className="project-activity">
                    {[...history]
                      .sort((a, b) => b.revision - a.revision)
                      .map((entry) => (
                        <li key={entry.revision}>
                          <HistoryIcon size={15} />
                          <div>
                            <strong>
                              {(
                                {
                                  create_project: "Project created",
                                  add_item: "Thought added",
                                  edit_item: "Thought updated",
                                  remove_item: "Thought removed",
                                  restore_item: "Thought restored",
                                  promote_answer: "Answer added to decisions",
                                  update_project: "Project details updated",
                                  rename_project: "Project renamed",
                                  update_references: "References updated",
                                  set_project_lifecycle: "Project moved",
                                } as Record<string, string>
                              )[entry.action] || "Project updated"}
                            </strong>
                            {entry.after && (
                              <ProjectText
                                text={
                                  entry.after.title +
                                  (entry.after.body
                                    ? "\n\n" + entry.after.body
                                    : "") +
                                  (entry.after.answer
                                    ? "\n\nAnswer: " + entry.after.answer
                                    : "")
                                }
                              />
                            )}
                            <time dateTime={entry.at}>
                              {new Date(entry.at).toLocaleString(undefined, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })}
                            </time>
                          </div>
                        </li>
                      ))}
                  </ol>
                )}
              </>
            ) : (
              <>
                <div className="project-list-tools">
                  <label className="project-search">
                    <Search size={16} />
                    <Input
                      aria-label="Search this project view"
                      placeholder={
                        view === "questions"
                          ? "Find a question or answer…"
                          : "Find a thought…"
                      }
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                      <IconButton
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                      >
                        <X size={14} />
                      </IconButton>
                    )}
                  </label>
                  {view === "questions" ? (
                    <Select
                      label="Question status"
                      value={status}
                      options={[
                        { value: "open", label: "Open" },
                        { value: "done", label: "Answered & resolved" },
                        { value: "deferred", label: "For later" },
                        { value: "all", label: "All questions" },
                      ]}
                      onValueChange={setStatus}
                    />
                  ) : (
                    <Select
                      label="Thought kind"
                      value={category}
                      options={[
                        { value: "all", label: "All kinds" },
                        ...categories
                          .filter(
                            (c) =>
                              view !== "plan" ||
                              !["question", "gap"].includes(c),
                          )
                          .map((c) => ({ value: c, label: labels[c] })),
                      ]}
                      onValueChange={setCategory}
                    />
                  )}
                </div>
                {view === "questions" && (
                  <p className="project-view-description">
                    Work through the unknowns. Keep each answer with its
                    question.
                  </p>
                )}
                {view === "connections" && (
                  <p className="project-view-description">
                    Thoughts you’ve linked, with their context close by.
                  </p>
                )}
                {view === "removed" && (
                  <p className="project-view-description">
                    Nothing is lost. Restore a thought whenever it belongs in
                    the plan again.
                  </p>
                )}
                {list.length ? (
                  categories
                    .filter((c) => list.some((i) => i.category === c))
                    .map((c) => (
                      <section className="project-thought-group" key={c}>
                        <div className="project-section-heading">
                          <h2>
                            <span className={`category-dot ${c}`} />
                            {labels[c]}
                            <span className="project-group-count">
                              {list.filter((i) => i.category === c).length}
                            </span>
                          </h2>
                          {!readOnly && view === "plan" && (
                            <IconButton
                              aria-label={`Add ${singular[c].toLowerCase()}`}
                              onClick={() => add({ category: c })}
                            >
                              <Plus size={14} />
                            </IconButton>
                          )}
                        </div>
                        {list.filter((i) => i.category === c).map(row)}
                      </section>
                    ))
                ) : (
                  <div className="project-list-empty">
                    <span className="project-empty-symbol">
                      {view === "questions" ? (
                        <CircleHelp size={25} strokeWidth={1.3} />
                      ) : view === "connections" ? (
                        <Link2 size={25} strokeWidth={1.3} />
                      ) : (
                        <FileText size={25} strokeWidth={1.3} />
                      )}
                    </span>
                    <h2>
                      {query || category !== "all"
                        ? "No thoughts match that."
                        : view === "questions"
                          ? status === "open"
                            ? "Room for the next question."
                            : "No questions here yet."
                          : view === "connections"
                            ? "Make the relationships visible."
                            : view === "removed"
                              ? "No removed thoughts."
                              : "A place for the details to take shape."}
                    </h2>
                    <p>
                      {query || category !== "all"
                        ? "Try another search or show all kinds."
                        : view === "connections"
                          ? "Open a thought and use Connected thoughts to link the ideas it affects."
                          : view === "removed"
                            ? "Thoughts you remove from the plan will stay here."
                            : view === "questions"
                              ? "Bring a question here when you want to explore it. Answers stay alongside the reasoning."
                              : "Start with a feature, a boundary or something you need to work out."}
                    </p>
                    {view === "plan" && !query && category === "all"
                      ? starters()
                      : !readOnly &&
                        view === "questions" && (
                          <Button onClick={() => add({ category: "question" })}>
                            <Plus size={14} />
                            Add a question
                          </Button>
                        )}
                  </div>
                )}
              </>
            )}
          </div>
          {["overview", "plan"].includes(view) && (
            <aside className="project-context" aria-label="Project context">
              {openQuestions.length > 0 && (
                <section>
                  <h2>
                    Next to explore<span>{openQuestions.length}</span>
                  </h2>
                  <div className="project-context-questions">
                    {openQuestions.slice(0, 3).map((item) => (
                      <Button
                        variant="surface"
                        key={item.id}
                        onClick={() => openItem(item)}
                      >
                        <CircleHelp size={15} />
                        <span>{item.title}</span>
                        <ArrowRight size={13} />
                      </Button>
                    ))}
                  </div>
                  <Button variant="inline" onClick={() => onView("questions")}>
                    All questions
                    <ArrowRight size={13} />
                  </Button>
                </section>
              )}
              <section>
                <h2>{plan.length ? "In the plan" : "Develop the plan"}</h2>
                {plan.length ? (
                  <div className="project-outline">
                    {categories
                      .filter((c) => plan.some((i) => i.category === c))
                      .map((c) => (
                        <Button
                          variant="quiet"
                          key={c}
                          onClick={() => {
                            if (view !== "plan") {
                              nextCategory.current = c;
                              onView("plan");
                            } else {
                              setCategory(c);
                              scroll.current?.scrollTo({ top: 0 });
                            }
                          }}
                        >
                          <span className={`category-dot ${c}`} />
                          {labels[c]}
                          <span>
                            {plan.filter((i) => i.category === c).length}
                          </span>
                        </Button>
                      ))}
                  </div>
                ) : (
                  <>
                    <p>
                      {project.description.trim()
                        ? "Turn the brief into something you can build."
                        : "Start with a feature, boundary or question."}
                    </p>
                    <div className="project-context-start">
                      {["feature", "constraint", "question"].map((kind) => (
                        <Button
                          key={kind}
                          variant="quiet"
                          disabled={readOnly}
                          onClick={() =>
                            add({ category: kind as ItemInput["category"] })
                          }
                        >
                          <Plus size={13} />
                          Add {singular[kind].toLowerCase()}
                        </Button>
                      ))}
                    </div>
                  </>
                )}
              </section>
              {hasSource && (
                <section className="project-context-source">
                  <Lightbulb size={18} strokeWidth={1.5} />
                  <div>
                    <h2>Your starting point</h2>
                    <p>
                      {project.ideaDocument?.title ||
                        "The original idea and everything you brought with it."}
                    </p>
                    <Button variant="inline" onClick={() => onView("source")}>
                      Open original idea
                      <ArrowRight size={13} />
                    </Button>
                  </div>
                </section>
              )}
              <p className="project-updated">
                Updated{" "}
                {new Date(project.updatedAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                })}
              </p>
            </aside>
          )}
        </div>
      </div>

      <ModalPresence>
        {editor && (
          <ProjectItemEditor
            key={editor.item?.id || "new"}
            project={project}
            item={editor.item}
            initial={editor.initial}
            readOnly={readOnly}
            owner={owner}
            onClose={() => setEditor(undefined)}
            onSaved={itemSaved}
          />
        )}
      </ModalPresence>
      <ModalPresence>
        {editingText && (
          <ProjectBriefEditor
            project={project}
            owner={owner}
            field={editingText}
            onClose={() => setEditingText(undefined)}
            onSaved={onSaved}
          />
        )}
      </ModalPresence>
    </section>
  );
}
