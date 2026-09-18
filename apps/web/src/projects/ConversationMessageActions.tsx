import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  failureActivityLabel,
  failureWorkActivity,
  narrativeActivity,
  visibleWorkActivity,
  workPresentation,
} from "./conversationWork";
import { ProjectText } from "./ProjectText";
import {
  CircleAlert,
  CircleX,
  Check,
  Copy,
  FileText,
  GitBranch,
  LoaderCircle,
  Search,
  Wrench,
  Users,
} from "lucide-react";
import type { PlanningTurn } from "../../../../packages/domain/src/projectPlanning";
import { MorphText } from "../ui/MorphText";
import { IconSwap } from "../ui/IconSwap";
import { Disclosure } from "../ui/Disclosure";
import { IconButton, Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import "./conversation-messages.css";

export type ConversationMessageActionsProps = {
  text: string;
  onBranch?: () => void;
  disabled?: boolean;
  createdAt: string;
  replyDetails?: string;
  persistent?: boolean;
};

export type TurnWorkActivity = {
  label: string;
  detail?: string;
  durationMs?: number;
};

export type TurnWorkSummaryProps = {
  createdAt: string;
  completedAt?: string;
  changedItems: Array<{ id: string; title: string }>;
  onSelect: (id: string) => void;
  activity?: TurnWorkActivity[];
  pending?: boolean;
  replying?: boolean;
  status?: PlanningTurn["status"];
  interrupted?: boolean;
};

type CopyState = "idle" | "copied";

function parseDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function formatMessageTime(value: string) {
  const date = parseDate(value);
  if (!date) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(durationMs: number | undefined) {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  )
    return undefined;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return remainingSeconds
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function workDuration(createdAt: string, completedAt?: string) {
  if (!completedAt) return undefined;
  const start = parseDate(createdAt);
  const end = parseDate(completedAt);
  if (!start || !end || end.getTime() < start.getTime()) return undefined;
  return formatDuration(end.getTime() - start.getTime());
}

export function ConversationMessageActions({
  text,
  onBranch,
  disabled = false,
  createdAt,
  replyDetails,
  persistent = false,
}: ConversationMessageActionsProps) {
  const { notify } = useToast();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== undefined)
        window.clearTimeout(copyTimer.current);
    };
  }, []);

  async function copyMessage() {
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("idle");
      notify("Copy unavailable", { tone: "error", duration: 5000 });
      return;
    }
    copyTimer.current = window.setTimeout(() => {
      setCopyState("idle");
      copyTimer.current = undefined;
    }, 1800);
  }

  const time = formatMessageTime(createdAt);
  const copyLabel = copyState === "copied" ? "Copied message" : "Copy message";

  return (
    <div
      className="conversation-message-actions"
      data-persistent={persistent || undefined}
      role="group"
      aria-label="Message actions"
    >
      <div className="conversation-message-action-buttons">
        <IconButton
          size="icon-sm"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => void copyMessage()}
        >
          <IconSwap active={copyState === "copied"} alternate={<Check />}>
            <Copy />
          </IconSwap>
        </IconButton>
        {onBranch && (
          <IconButton
            size="icon-sm"
            aria-label="Branch to new chat"
            title="Branch to new chat"
            disabled={disabled}
            onClick={onBranch}
          >
            <GitBranch aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {time && (
        <time
          className="conversation-message-time"
          dateTime={createdAt}
          title={replyDetails}
        >
          {time}
        </time>
      )}
    </div>
  );
}

export function TurnWorkSummary({
  createdAt,
  completedAt,
  changedItems,
  onSelect,
  activity = [],
  pending = false,
  replying = false,
  status,
  interrupted: interruptedProp = false,
}: TurnWorkSummaryProps) {
  const { interrupted, failed, stale, cancelled, stopped, working, complete } =
    workPresentation({
      status,
      pending,
      replying,
      completedAt,
      interrupted: interruptedProp,
    });
  const duration = workDuration(createdAt, completedAt);
  const visibleActivity = visibleWorkActivity(activity);
  const failureActivity = failureWorkActivity(activity);
  const disclosureActivity = visibleActivity.filter(
    (entry) =>
      !(
        failed &&
        entry.label === failureActivityLabel &&
        failureActivity?.detail?.trim()
      ),
  );
  const latestOperation = [...visibleActivity]
    .reverse()
    .find(
      (entry) =>
        !/^(Thinking|.+ is thinking|Writing a reply|.+ is replying)$/.test(
          entry.label,
        ),
    );
  const title = stopped
    ? interrupted
      ? "Reply interrupted"
      : failed
        ? failureActivity?.label || "Reply stopped"
        : stale
          ? "Reply saved"
          : "Stopped"
    : working
      ? latestOperation?.label || "Thinking"
      : duration
        ? `Worked for ${duration}`
        : "Activity";
  const [open, setOpen] = useState(working);
  useLayoutEffect(() => {
    if (!working) setOpen(false);
  }, [working]);

  if (!visibleActivity.length && !changedItems.length) return null;

  return (
    <div
      className="conversation-work-summary"
      data-complete={complete || undefined}
    >
      {visibleActivity.length > 0 && (
        <Disclosure
          title={
            <>
              {working ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="thinking-wait-spinner"
                />
              ) : failed || cancelled || interrupted ? (
                <CircleX
                  aria-hidden="true"
                  className={failed ? "text-destructive" : undefined}
                />
              ) : stale ? (
                <CircleAlert aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              <MorphText>{title}</MorphText>
            </>
          }
          variant="inline"
          className={disclosureActivity.length ? "" : "conversation-work-empty"}
          open={open && disclosureActivity.length > 0}
          onOpenChange={setOpen}
        >
          <div className="conversation-work-summary-body">
            {disclosureActivity.length > 0 && (
              <ul
                className="conversation-work-activity"
                aria-label="Work activity"
              >
                {disclosureActivity.map((entry, index) => (
                  <li key={index}>
                    {(!entry.detail ||
                      !narrativeActivity.test(entry.label)) && (
                      <p className="conversation-work-activity-label">
                        {entry.label === failureActivityLabel ? (
                          <CircleX
                            aria-hidden="true"
                            className="text-destructive"
                          />
                        ) : /search|looked up/i.test(entry.label) ? (
                          <Search aria-hidden="true" />
                        ) : /agent|consult/i.test(entry.label) ? (
                          <Users aria-hidden="true" />
                        ) : /plan|thought|creat|sav/i.test(entry.label) ? (
                          <Wrench aria-hidden="true" />
                        ) : (
                          <FileText aria-hidden="true" />
                        )}
                        <MorphText>{entry.label}</MorphText>
                      </p>
                    )}
                    {entry.detail && (
                      <div className="conversation-work-detail">
                        <ProjectText text={entry.detail} streaming={working} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Disclosure>
      )}
      {changedItems.length > 0 && (
        <Disclosure
          variant="inline"
          title={
            <>
              <Check aria-hidden="true" />
              {`Updated ${changedItems.length} ${changedItems.length === 1 ? "thought" : "thoughts"}`}
            </>
          }
        >
          <div className="conversation-work-change-list">
            {changedItems.map((item) => (
              <Button
                key={item.id}
                variant="inline"
                size="sm"
                className="conversation-work-change"
                onClick={() => onSelect(item.id)}
              >
                <FileText aria-hidden="true" />
                {item.title}
              </Button>
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}
