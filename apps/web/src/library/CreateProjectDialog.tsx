import { usePlan } from "../account/PlanProvider";
import { freeModelDisclosure } from "../../../../packages/domain/src/plans";
import { Input } from "@/components/ui/input";
import { useId } from "react";
import { Lightbulb } from "lucide-react";
import type { Folder } from "../../../../packages/domain/src/library";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import "./create-project.css";

export function CreateProjectDialog({
  ideaTitle,
  name,
  folder,
  folders,
  busy,
  pending,
  error,
  startMode,
  onStartModeChange,
  onChange,
  onCreate,
  onClose,
}: {
  ideaTitle: string;
  name: string;
  folder: string;
  folders: Folder[];
  busy: boolean;
  pending: boolean;
  error: string;
  startMode: "assist" | "note";
  onStartModeChange: (mode: "assist" | "note") => void;
  onChange: (values: { name?: string; folder?: string }) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const formId = useId();
  const { plan, loading, error: planError } = usePlan();
  const blocked =
    busy ||
    (!pending &&
      startMode === "assist" &&
      (loading || (!plan && !!planError) || (plan?.enabled && !plan.credits)));
  return (
    <Modal
      title="Create project"
      className="create-project-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button variant="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={blocked}
          >
            {busy
              ? "Creating project…"
              : pending
                ? "Check creation"
                : "Create project"}
          </Button>
        </>
      }
    >
      <div className="create-project-source">
        <Lightbulb size={19} aria-hidden="true" />
        <div>
          <p className="create-project-source-name">
            From {ideaTitle || "your idea"}
          </p>
          <p>
            {startMode === "assist"
              ? "Your idea starts the conversation, with your answers and references already in context."
              : "Your idea becomes the first thought in your project, with your answers and references kept."}
          </p>
        </div>
      </div>
      <form
        id={formId}
        className="create-project-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked) onCreate();
        }}
      >
        <label>
          <span>
            Project name <span className="optional">Optional</span>
          </span>
          <Input
            name="projectName"
            autoComplete="off"
            value={name}
            maxLength={120}
            placeholder="Untitled Project"
            disabled={pending || busy}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <div className="create-project-location">
          <span>Location</span>
          <Select
            label="Location"
            value={folder}
            onValueChange={(folder) => onChange({ folder })}
            disabled={pending || busy}
            options={[
              { value: "", label: "Workspace" },
              ...folders.map((f) => ({ value: f.id, label: f.name })),
            ]}
          />
        </div>
        <div className="create-project-location">
          <span>Planning</span>
          <Select
            label="Planning"
            value={startMode}
            onValueChange={(value) =>
              onStartModeChange(value as "assist" | "note")
            }
            disabled={pending || busy}
            options={[
              { value: "assist", label: "Discuss the idea" },
              { value: "note", label: "Plan on my own" },
            ]}
          />
        </div>
        {startMode === "assist" && (loading || (!plan && planError)) && (
          <p className="text-xs text-muted-foreground" role="status">
            {loading
              ? "Checking your allowance…"
              : "Your allowance could not be checked. Plan on your own or try again later."}
          </p>
        )}
        {plan?.enabled && startMode === "assist" && (
          <p className="text-xs text-muted-foreground">
            {plan.tier === "free" && freeModelDisclosure + " "}
            {plan.credits > 0
              ? `Your first reply uses up to ${Math.min(plan.credits, plan.tier === "free" ? 40 : 100)} credits. Unused credits return to your balance.`
              : "No credits remain. Choose Plan on my own to continue without assistance."}
          </p>
        )}
        {error && (
          <p className="create-project-error" role="alert">
            {error}
          </p>
        )}
        {pending && !busy && (
          <p className="create-project-recovery" role="status">
            Check creation to recover your project without creating another
            copy.
          </p>
        )}
      </form>
    </Modal>
  );
}
