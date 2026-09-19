import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  Link2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { Project } from "../../../../packages/domain/src";
import {
  eligibleBuildThoughts,
  deliveryCommandSchema,
  requirementStatus,
  type BuildScope,
  type DeliveryCommand,
  type DeliveryState,
} from "../../../../packages/domain/src/projectDelivery";
import { Input } from "../components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Disclosure } from "../ui/Disclosure";
import { Button, IconButton } from "../ui/Button";
import { Select } from "../ui/Select";
import { Modal, ModalPresence } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { ApiError } from "../client";
import { ProjectTransport } from "./ProjectTransport";
import { clearDraft, readDraft, storeDraft } from "./model";
import { BuildScopePicker } from "./BuildScopePicker";
import { BuildProgress, type BuildStatus } from "./BuildProgress";
import { AgentConnection } from "./ProjectAgentConnection";
import "./project-build.css";

type Lane = BuildScope["lane"];
type ScopeDraft = {
  name: string;
  lane: Lane;
  criteria: Record<string, string>;
};
type Pending = { command: DeliveryCommand; conflict?: boolean };
const lanes = [
  { value: "now", label: "Now" },
  { value: "next", label: "Next" },
  { value: "later", label: "Later" },
] as const;
const statusNames = {
  not_started: "Not started",
  in_progress: "In progress",
  implemented: "Agent reported",
  blocked: "Blocked",
  needs_recheck: "Needs recheck",
  verified: "Verified",
};
const blankDraft = (): ScopeDraft => ({ name: "", lane: "now", criteria: {} });
function restoredDraft(key: string): ScopeDraft {
  const value = readDraft(key);
  return value &&
    typeof value.name === "string" &&
    lanes.some((lane) => lane.value === value.lane) &&
    value.criteria &&
    Object.values(value.criteria).every((text) => typeof text === "string")
    ? value
    : blankDraft();
}
function restoredPending(key: string): Pending | null {
  const value = readDraft(key);
  const parsed = deliveryCommandSchema.safeParse(value?.command);
  return parsed.success
    ? { command: parsed.data, conflict: value.conflict === true }
    : null;
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to connect. Try again.";
}

export function ProjectBuild({
  project,
  owner,
  navigation,
  onBack,
  onSaved,
}: {
  project: Project;
  owner: string;
  navigation?: ReactNode;
  onBack: () => void;
  onSaved: (project: Project, quiet?: boolean) => void;
}) {
  const transport = useContext(ProjectTransport);
  const { notify } = useToast();
  const draftKey = `woolgather:delivery-draft:${owner}:${project.id}`;
  const pendingKey = `woolgather:delivery-pending:${owner}:${project.id}`;
  const [draft, setDraft] = useState<ScopeDraft>(() => restoredDraft(draftKey));
  const [pending, setPending] = useState<Pending | null>(() =>
    restoredPending(pendingKey),
  );
  const [delivery, setDelivery] = useState<DeliveryState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [creating, setCreating] = useState(
    () =>
      !!restoredDraft(draftKey).name ||
      Object.keys(restoredDraft(draftKey).criteria).length > 0,
  );
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [deleting, setDeleting] = useState<{
    scope: BuildScope;
    revision: number;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [comparedRevision, setComparedRevision] = useState<number | null>(null);
  const [syncInterrupted, setSyncInterrupted] = useState(false);
  const restoreCreateFocus = useRef(false);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const readOnly = !!project.lifecycle && project.lifecycle !== "active";
  const thoughts = eligibleBuildThoughts(project);
  const editable = !readOnly && !!delivery && !pending && !busy;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void Promise.all([
      transport.request<DeliveryState>(`/projects/${project.id}/delivery`),
      transport.request<Project>(`/projects/${project.id}`),
    ])
      .then(([value, freshProject]) => {
        if (alive) {
          onSavedRef.current(freshProject, true);
          setDelivery((current) =>
            !current || value.revision >= current.revision ? value : current,
          );
          setError("");
          setSyncInterrupted(false);
          setComparedRevision(value.revision);
        }
      })
      .catch((error) => {
        if (alive) setError(message(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [transport, project.id, attempt]);
  const connected = delivery !== null;
  useEffect(() => {
    if (!connected || busy) return;
    let alive = true;
    let refreshing = false;
    const refresh = async () => {
      if (document.hidden || refreshing) return;
      refreshing = true;
      try {
        const [value, freshProject] = await Promise.all([
          transport.request<DeliveryState>(`/projects/${project.id}/delivery`),
          transport.request<Project>(`/projects/${project.id}`),
        ]);
        if (alive) {
          onSavedRef.current(freshProject, true);
          setSyncInterrupted(false);
          setDelivery((current) =>
            !current || value.revision > current.revision ? value : current,
          );
        }
      } catch {
        // Keep the last confirmed state. Explicit Refresh exposes connection
        // errors without overwriting an interrupted-save recovery notice.
        if (alive) setSyncInterrupted(true);
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 15000);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connected, busy, transport, project.id]);
  useEffect(() => {
    setStorageError(!storeDraft(draftKey, draft));
  }, [draft, draftKey]);
  useEffect(() => {
    if (creating) nameInput.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (!creating && editable && restoreCreateFocus.current) {
      createTrigger.current?.focus();
      restoreCreateFocus.current = false;
    }
  }, [creating, editable]);

  function keepPending(value: Pending | null) {
    setPending(value);
    if (value) {
      if (!storeDraft(pendingKey, value)) setStorageError(true);
    } else clearDraft(pendingKey);
  }
  async function send(command: DeliveryCommand) {
    if (busy) return;
    keepPending({ command });
    setBusy(true);
    setError("");
    setComparedRevision(null);
    try {
      const receipt = await transport.request<DeliveryState>(
        "/project-delivery",
        command,
      );
      setDelivery((current) =>
        !current || receipt.revision >= current.revision ? receipt : current,
      );
      keepPending(null);
      if (command.action.type === "create_scope") {
        setDraft(blankDraft());
        setCreating(false);
        clearDraft(draftKey);
        restoreCreateFocus.current = true;
      }
      if (command.action.type === "delete_scope")
        restoreCreateFocus.current = true;
      // The idempotent receipt may be older than other agent reports. Read the
      // current version without turning a successful save into an uncertain one.
      setAttempt((value) => value + 1);
      notify(
        command.action.type === "create_scope"
          ? "Version saved"
          : command.action.type === "delete_scope"
            ? "Version deleted"
            : "Build progress saved",
      );
    } catch (failure) {
      setError(message(failure));
      if (failure instanceof ApiError && failure.status === 409)
        keepPending({ command, conflict: true });
      else if (
        failure instanceof ApiError &&
        [400, 403, 404, 422].includes(failure.status)
      )
        keepPending(null);
    } finally {
      setBusy(false);
    }
  }
  function act(action: DeliveryCommand["action"]) {
    if (!delivery || !editable) return;
    void send({
      id: crypto.randomUUID(),
      projectId: project.id,
      expectedRevision: delivery.revision,
      action,
    });
  }
  function createScope() {
    const selected = thoughts.filter((item) =>
      Object.hasOwn(draft.criteria, item.id),
    );
    if (
      !draft.name.trim() ||
      !selected.length ||
      selected.some((item) => !draft.criteria[item.id].trim())
    )
      return;
    act({
      type: "create_scope",
      scopeId: crypto.randomUUID(),
      name: draft.name.trim(),
      lane: draft.lane,
      requirements: selected.map((item) => ({
        id: crypto.randomUUID(),
        thoughtId: item.id,
        criterion: draft.criteria[item.id].trim(),
      })),
    });
  }
  function discardDraft() {
    setDraft(blankDraft());
    setCreating(false);
    setConfirmDiscard(false);
    clearDraft(draftKey);
    restoreCreateFocus.current = true;
  }
  const selectedCount = thoughts.filter((item) =>
    Object.hasOwn(draft.criteria, item.id),
  ).length;
  const missingThoughts = Object.keys(draft.criteria).filter(
    (id) => !thoughts.some((thought) => thought.id === id),
  );

  return (
    <section
      className="project-studio project-build"
      aria-label="Project build"
    >
      <header className="thinking-toolbar">
        <div className="thinking-project-identity flex-1">
          {navigation}
          <IconButton
            aria-label="Back to project"
            size="icon-sm"
            onClick={onBack}
          >
            <ArrowLeft />
          </IconButton>
          <span className="project-build-project-name">{project.name}</span>
        </div>
        <div className="thinking-toolbar-tools">
          <Button
            variant="quiet"
            disabled={loading || busy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw /> Refresh
          </Button>
        </div>
      </header>
      <div className="project-build-scroll">
        <div className="project-build-content">
          <div className="project-build-heading">
            <div>
              <h1>Build</h1>
              <p>
                Choose a version. Build it with your coding agent. Review what
                comes back.
              </p>
            </div>
            <div className="project-build-actions">
              <AgentConnection
                projectId={project.id}
                disabled={readOnly || !delivery}
              />
              <Button
                ref={createTrigger}
                variant="primary"
                disabled={!editable || creating}
                onClick={() => setCreating(true)}
              >
                <Plus /> New version
              </Button>
            </div>
          </div>
          {readOnly && (
            <p className="project-build-notice">
              Restore this project in project settings to change its build plan.
            </p>
          )}
          {storageError && (
            <p className="project-build-notice" role="alert">
              This browser could not save a recovery draft. Keep this page open
              until your changes are saved.
            </p>
          )}
          {syncInterrupted && (
            <p className="project-build-notice" role="status">
              Build reports are not updating. Showing the last saved progress;
              use Refresh to reconnect.
            </p>
          )}
          {error && (
            <div className="project-build-notice" role="alert">
              <p>{error}</p>
              {!delivery && (
                <p>
                  Your saved Plan is still available from the project. Build
                  connections may not be enabled on this installation yet.
                </p>
              )}
            </div>
          )}
          {pending && (
            <div className="project-build-notice" role="status">
              <p>
                {pending.conflict
                  ? "Build progress changed in another window or agent. Refresh and review the saved version below before applying your change."
                  : pending.command.action.type === "delete_scope"
                    ? "Deletion has not been confirmed. Retry to check whether the version was deleted."
                    : "A save has not been confirmed. Retry the same change to check its result without duplicating it."}
              </p>
              <div className="project-build-actions">
                <Button
                  disabled={busy || loading}
                  onClick={() =>
                    pending.conflict
                      ? setAttempt((value) => value + 1)
                      : void send(pending.command)
                  }
                >
                  {pending.conflict
                    ? "Reload saved progress"
                    : pending.command.action.type === "delete_scope"
                      ? "Retry deletion"
                      : "Retry save"}
                </Button>
                {pending.conflict && delivery && (
                  <Button
                    variant={
                      pending.command.action.type === "delete_scope"
                        ? "danger"
                        : "secondary"
                    }
                    disabled={
                      busy || loading || comparedRevision !== delivery.revision
                    }
                    onClick={() =>
                      void send({
                        ...pending.command,
                        id: crypto.randomUUID(),
                        expectedRevision: delivery.revision,
                      })
                    }
                  >
                    {pending.command.action.type === "delete_scope"
                      ? "Delete updated version"
                      : `Apply to revision ${delivery.revision}`}
                  </Button>
                )}
                {pending.conflict && (
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => {
                      keepPending(null);
                      setError("");
                    }}
                  >
                    Keep saved version
                  </Button>
                )}
              </div>
            </div>
          )}
          {loading && !delivery && <p role="status">Loading build progress…</p>}
          {creating && (
            <form
              className="project-build-create"
              onSubmit={(event) => {
                event.preventDefault();
                createScope();
              }}
            >
              <h2>Choose what belongs in this version</h2>
              <div className="project-build-fields">
                <label>
                  Version name
                  <Input
                    ref={nameInput}
                    value={draft.name}
                    maxLength={120}
                    placeholder="For example, Visual prototype or MVP"
                    disabled={!editable}
                    onChange={(event) =>
                      setDraft((value) => ({
                        ...value,
                        name: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  Roadmap
                  <Select
                    label="Roadmap"
                    value={draft.lane}
                    options={lanes}
                    disabled={!editable}
                    onValueChange={(lane) =>
                      setDraft((value) => ({ ...value, lane: lane as Lane }))
                    }
                  />
                </label>
              </div>
              <p className="project-build-help">
                Select saved thoughts and describe what you will check. This
                version keeps a snapshot of its scope, with up to 50 criteria.
              </p>
              {!!missingThoughts.length && (
                <p className="project-build-notice">
                  {missingThoughts.length} selected thought(s) are no longer
                  available for this version and will not be included.
                </p>
              )}
              <BuildScopePicker
                thoughts={thoughts}
                criteria={Object.fromEntries(
                  Object.entries(draft.criteria).filter(([id]) =>
                    thoughts.some((item) => item.id === id),
                  ),
                )}
                disabled={!editable}
                onChange={(criteria) =>
                  setDraft((value) => ({ ...value, criteria }))
                }
              />
              <div className="project-build-actions">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    !editable ||
                    !selectedCount ||
                    !draft.name.trim() ||
                    thoughts.some(
                      (item) =>
                        Object.hasOwn(draft.criteria, item.id) &&
                        !draft.criteria[item.id].trim(),
                    )
                  }
                >
                  Save version{selectedCount ? ` (${selectedCount})` : ""}
                </Button>
                <Button variant="quiet" onClick={() => setCreating(false)}>
                  Keep draft
                </Button>
                <Button
                  variant="quiet"
                  disabled={!!pending}
                  onClick={() => setConfirmDiscard(true)}
                >
                  Discard draft
                </Button>
              </div>
            </form>
          )}
          {!creating &&
            (draft.name || Object.keys(draft.criteria).length > 0) && (
              <Button
                variant="secondary"
                disabled={!!pending}
                onClick={() => setCreating(true)}
              >
                Continue version draft
              </Button>
            )}
          {delivery && (
            <>
              {!delivery.scopes.length && !creating && (
                <div className="project-build-empty">
                  <h2>Your first version starts with the Plan</h2>
                  <p>
                    Choose a first feature, a visual test or a focused release.
                    Your agent will receive that exact scope.
                  </p>
                  <Button
                    disabled={!editable}
                    onClick={() => setCreating(true)}
                  >
                    <Plus /> Choose scope
                  </Button>
                </div>
              )}
              {lanes.map((lane) => {
                const scopes = delivery.scopes.filter(
                  (scope) => scope.lane === lane.value,
                );
                if (!scopes.length) return null;
                return (
                  <section
                    className="project-build-lane"
                    key={lane.value}
                    aria-label={lane.label}
                  >
                    <h2>{lane.label}</h2>
                    {scopes.map((scope) => (
                      <Scope
                        key={scope.id}
                        scope={scope}
                        delivery={delivery}
                        project={project}
                        disabled={!editable}
                        onAction={act}
                        onDelete={() =>
                          setDeleting({ scope, revision: delivery.revision })
                        }
                      />
                    ))}
                  </section>
                );
              })}
              {delivery.repository && (
                <p className="project-build-repository">
                  <Link2 size={16} /> {delivery.repository.label}
                  {delivery.repository.branch
                    ? ` · ${delivery.repository.branch}`
                    : ""}
                </p>
              )}
            </>
          )}
        </div>
      </div>
      <ModalPresence>
        {deleting && (
          <Modal
            title="Delete version?"
            confirmation
            onClose={() => setDeleting(null)}
            footer={
              <>
                <Button onClick={() => setDeleting(null)}>Cancel</Button>
                <Button
                  variant="danger"
                  disabled={!editable}
                  onClick={() => {
                    void send({
                      id: crypto.randomUUID(),
                      projectId: project.id,
                      expectedRevision: deleting.revision,
                      action: {
                        type: "delete_scope",
                        scopeId: deleting.scope.id,
                      },
                    });
                    setDeleting(null);
                  }}
                >
                  Delete version
                </Button>
              </>
            }
          >
            <p>
              Delete “{deleting.scope.name}” and its build progress, reports and
              reviews? This cannot be undone. Your Plan and repository code stay
              unchanged.
            </p>
          </Modal>
        )}
      </ModalPresence>
      <ModalPresence>
        {confirmDiscard && (
          <Modal
            title="Discard version draft?"
            confirmation
            onClose={() => setConfirmDiscard(false)}
            footer={
              <>
                <Button onClick={() => setConfirmDiscard(false)}>
                  Keep draft
                </Button>
                <Button variant="danger" onClick={discardDraft}>
                  Discard draft
                </Button>
              </>
            }
          >
            <p>Your saved Plan and existing versions stay available.</p>
          </Modal>
        )}
      </ModalPresence>
    </section>
  );
}

function Scope({
  scope,
  delivery,
  project,
  disabled,
  onAction,
  onDelete,
}: {
  scope: BuildScope;
  delivery: DeliveryState;
  project: Project;
  disabled: boolean;
  onAction: (action: DeliveryCommand["action"]) => void;
  onDelete: () => void;
}) {
  const [filter, setFilter] = useState<BuildStatus | "all">("all");
  return (
    <article className="project-build-scope">
      <div className="project-build-scope-heading">
        <div>
          <h3>{scope.name}</h3>
        </div>
        <div className="project-build-scope-actions">
          <Select
            label={`Roadmap for ${scope.name}`}
            value={scope.lane}
            options={lanes}
            disabled={disabled}
            onValueChange={(lane) =>
              onAction({
                type: "move_scope",
                scopeId: scope.id,
                lane: lane as Lane,
              })
            }
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton
                  aria-label={`Version options for ${scope.name}`}
                  disabled={disabled}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                disabled={disabled}
                onClick={onDelete}
              >
                <Trash2 /> Delete version
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <BuildProgress
        scope={scope}
        delivery={delivery}
        project={project}
        filter={filter}
        onFilter={setFilter}
      />
      <div className="project-build-requirements">
        {filter !== "all" &&
          !scope.requirements.some(
            (requirement) =>
              requirementStatus(requirement, scope, delivery, project).state ===
              filter,
          ) && (
            <p className="project-build-help">
              Nothing left in this group. Choose All to see the full version.
            </p>
          )}
        {scope.requirements.map((requirement) => {
          const status = requirementStatus(
            requirement,
            scope,
            delivery,
            project,
          );
          if (filter !== "all" && status.state !== filter) return null;
          return (
            <Disclosure
              className="project-build-requirement"
              variant="plain"
              key={requirement.id}
              title={
                <span className="project-build-requirement-label">
                  <span className="project-build-requirement-title">
                    {requirement.title}
                  </span>
                  <span
                    className="project-build-status"
                    data-verified={status.state === "verified"}
                  >
                    {status.state === "verified" && <Check size={14} />}
                    {statusNames[status.state]}
                  </span>
                </span>
              }
            >
              <div className="project-build-evidence">
                <p className="project-build-small-heading">Done when</p>
                <p className="project-build-reading">{requirement.criterion}</p>
                {status.stale && (
                  <p className="project-build-notice">
                    This thought, its references, decisions or constraints have
                    changed since the version was saved. Create a new version
                    with its current meaning before verifying it.
                  </p>
                )}
                {status.report && (
                  <>
                    <p className="project-build-small-heading">
                      {status.report.actor === "agent"
                        ? "Agent report"
                        : "Reported outcome"}
                    </p>
                    <p className="project-build-reading">
                      {status.report.summary}
                    </p>
                    {status.report.commit && (
                      <p>
                        Commit <code>{status.report.commit}</code>
                      </p>
                    )}
                    {status.report.checks.length > 0 && (
                      <ul className="project-build-checks">
                        {status.report.checks.map((check, index) => (
                          <li key={index}>
                            <code>{check.command}</code>
                            <span>{check.result.replaceAll("_", " ")}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="project-build-help">
                      Reported {new Date(status.report.at).toLocaleString()}.
                      Reports do not verify completion.
                    </p>
                  </>
                )}
                {status.review?.note && (
                  <p className="project-build-reading">{status.review.note}</p>
                )}
                {!status.stale &&
                  status.state !== "verified" &&
                  status.report?.state !== "implemented" && (
                    <p className="project-build-help">
                      An implemented result is needed before you can verify this
                      criterion.
                    </p>
                  )}
                {!status.stale &&
                  status.report?.checks.some(
                    (check) => check.result === "failed",
                  ) && (
                    <p className="project-build-help">
                      Resolve the failed checks in your agent before verifying
                      this criterion.
                    </p>
                  )}
                <Button
                  size="sm"
                  disabled={
                    disabled ||
                    (status.state !== "verified" &&
                      (status.stale ||
                        status.report?.state !== "implemented" ||
                        status.report.checks.some(
                          (check) => check.result === "failed",
                        )))
                  }
                  onClick={() =>
                    onAction({
                      type: "review_requirement",
                      scopeId: scope.id,
                      requirementId: requirement.id,
                      verified: status.state !== "verified",
                      note: "",
                    })
                  }
                >
                  {status.state === "verified"
                    ? "Reopen criterion"
                    : "Mark verified"}
                </Button>
              </div>
            </Disclosure>
          );
        })}
      </div>
    </article>
  );
}
