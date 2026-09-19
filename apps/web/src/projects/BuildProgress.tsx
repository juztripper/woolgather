import type { Project } from "../../../../packages/domain/src";
import {
  deliveryProgress,
  requirementStatus,
  type BuildScope,
  type DeliveryState,
} from "../../../../packages/domain/src/projectDelivery";
import { Button } from "../ui/Button";

export const buildStatusLabels = {
  not_started: "Not started",
  in_progress: "In progress",
  implemented: "Ready to review",
  blocked: "Blocked",
  needs_recheck: "Needs recheck",
  verified: "Verified",
};
export type BuildStatus = keyof typeof buildStatusLabels;

export function BuildProgress({
  scope,
  delivery,
  project,
  filter,
  onFilter,
}: {
  scope: BuildScope;
  delivery: DeliveryState;
  project: Project;
  filter: BuildStatus | "all";
  onFilter: (state: BuildStatus | "all") => void;
}) {
  const progress = deliveryProgress(scope, delivery, project);
  const states = scope.requirements.map(
    (requirement) =>
      requirementStatus(requirement, scope, delivery, project).state,
  );
  const segment = 100 / Math.max(states.length, 1);
  const gap = states.length === 1 ? 0 : Math.min(1.2, segment * 0.2);
  const reported = progress.total
    ? Math.floor((100 * progress.implemented) / progress.total)
    : 0;
  return (
    <div className="build-progress-overview">
      <div
        className="build-progress-ring"
        role="progressbar"
        aria-label={`${scope.name} verified progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent ?? 0}
        aria-valuetext={`${progress.verified} of ${progress.total} criteria verified`}
      >
        <svg viewBox="0 0 120 120" aria-hidden="true">
          {states.map((state, index) => (
            <circle
              key={scope.requirements[index].id}
              className="build-progress-segment"
              data-state={state}
              cx="60"
              cy="60"
              r="52"
              pathLength="100"
              fill="none"
              strokeWidth="7"
              strokeDasharray={`${segment - gap} ${100 - segment + gap}`}
              strokeDashoffset={-index * segment}
              transform="rotate(-90 60 60)"
            />
          ))}
        </svg>
        <div>
          <strong>{progress.percent ?? 0}%</strong>
          <span>verified</span>
        </div>
      </div>
      <div className="build-progress-detail">
        <p>
          <strong>
            {progress.verified} of {progress.total}
          </strong>{" "}
          {progress.total === 1 ? "criterion" : "criteria"} verified by you
        </p>
        <p className="project-build-help">
          {reported}% reported as implemented by your agent
        </p>
        <div
          className="build-progress-filters"
          role="group"
          aria-label={`Requirements in ${scope.name}`}
        >
          <Button
            size="sm"
            variant={filter === "all" ? "secondary" : "quiet"}
            aria-pressed={filter === "all"}
            onClick={() => onFilter("all")}
          >
            All {progress.total}
          </Button>
          {(Object.keys(buildStatusLabels) as BuildStatus[]).map((state) => {
            const count = states.filter((value) => value === state).length;
            if (!count && filter !== state) return null;
            return (
              <Button
                key={state}
                size="sm"
                variant={filter === state ? "secondary" : "quiet"}
                aria-pressed={filter === state}
                onClick={() => onFilter(filter === state ? "all" : state)}
              >
                <span
                  className="build-status-dot"
                  data-state={state}
                  aria-hidden="true"
                />
                {count} {buildStatusLabels[state].toLowerCase()}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
