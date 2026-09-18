import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, ApiError } from "../client";
import {
  guidanceSourceKey,
  guidanceFollowUp,
  validateGuidance,
  type IdeaGuidance,
  type GuidanceDisposition,
} from "../../../../packages/domain/src/ideaGuidance";
import { emptyIdeaDocument } from "../../../../packages/domain/src/ideaDocument";
import { type IdeaReadinessBasis } from "../../../../packages/domain/src/ideaReadiness";
import type { Idea } from "../../../../packages/domain/src/library";

export type GuidanceRun = {
  status:
    | "idle"
    | "reserved"
    | "running"
    | "completed"
    | "failed"
    | "unknown"
    | "cancelled";
  runId?: string;
  result?: IdeaGuidance | null;
  current: boolean;
  ready?: boolean;
  readinessBasis?: IdeaReadinessBasis | null;
  followUp?: { blockId: string; question: string } | null;
  errorCode?: string | null;
  allowance?: { remaining: number; reserved: number; renewsAt: string | null };
};
export const IdeaGuidanceTransport = createContext({
  request: api,
  enabled: async () => {
    const c: unknown = await (await fetch("/api/config")).json();
    return (
      !!c &&
      typeof c === "object" &&
      "ideaGuidance" in c &&
      c.ideaGuidance === true
    );
  },
});
// A saved edit never launches inference. Only an explicit Review action can.
export function useIdeaGuidance(idea: Idea, paused: boolean, visible = true) {
  const transport = useContext(IdeaGuidanceTransport);
  const [available, setAvailable] = useState(false),
    [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(true),
    [error, setError] = useState("");
  const [run, setRun] = useState<
    (GuidanceRun & { key: string; ideaId: string }) | null
  >(null);
  const key = useMemo(
    () => guidanceSourceKey(idea.body, idea.document || emptyIdeaDocument()),
    [idea.body, idea.document],
  );
  const latest = useRef({ idea, key, paused, visible });
  latest.current = { idea, key, paused, visible };
  const mounted = useRef(false),
    active = useRef(false),
    generation = useRef(0);
  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    mounted.current = true;
    const visibility = () =>
      setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    void transport
      .enabled()
      .then((value) => {
        if (mounted.current) setAvailable(value);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      generation.current++;
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  async function call(
    action: "review" | "status",
    runId?: string,
    continuationBlockId?: string,
  ) {
    const snapshot = latest.current;
    if (
      active.current ||
      !snapshot.visible ||
      document.visibilityState === "hidden" ||
      (action === "review" && snapshot.paused)
    )
      return;
    active.current = true;
    const token = ++generation.current;
    if (action === "review") {
      setBusy(true);
      setError("");
    }
    try {
      const data = await transport.request<GuidanceRun>("/idea-guidance", {
        action,
        ideaId: snapshot.idea.id,
        revision: snapshot.idea.revision,
        ...(action === "status" && runId ? { runId } : {}),
        ...(action === "review" && runId ? { retryRunId: runId } : {}),
        ...(action === "review" && continuationBlockId
          ? { continuationBlockId }
          : {}),
      });
      if (
        !mounted.current ||
        token !== generation.current ||
        latest.current.idea.id !== snapshot.idea.id ||
        latest.current.key !== snapshot.key
      )
        return;
      const result =
        data.result && (data.current || data.ready)
          ? validateGuidance(
              data.result,
              snapshot.idea.body,
              snapshot.idea.document || emptyIdeaDocument(),
              [],
              // Status already removes questions the author has handled.
              { allowHandledQuestion: true },
            )
          : null;
      setRun({ ...data, result, key: snapshot.key, ideaId: snapshot.idea.id });
      setError("");
    } catch (e) {
      if (
        !mounted.current ||
        token !== generation.current ||
        latest.current.idea.id !== snapshot.idea.id ||
        latest.current.key !== snapshot.key
      )
        return;
      if (action === "review" || runId) setError((e as Error).message);
      if (e instanceof ApiError && e.details.runId)
        setRun({
          status: "unknown",
          runId: e.details.runId,
          current: true,
          key: snapshot.key,
          ideaId: snapshot.idea.id,
        });
    } finally {
      if (token === generation.current) {
        active.current = false;
        if (mounted.current) {
          setBusy(false);
          setChecking(false);
          // An edit may have arrived while a status read was in flight. Fetch
          // the new saved state once, without starting paid work.
          if (latest.current.key !== snapshot.key && !latest.current.paused)
            queueMicrotask(() => void call("status"));
        }
      }
    }
  }
  useEffect(() => {
    generation.current++;
    active.current = false;
    setBusy(false);
    setChecking(true);
    setError("");
    setRun(null);
  }, [idea.id]);
  useEffect(() => {
    if (visible && pageVisible && !paused) void call("status");
  }, [key, visible, pageVisible, paused]);
  useEffect(() => {
    if (
      !visible ||
      !pageVisible ||
      paused ||
      !run?.runId ||
      !["reserved", "running"].includes(run.status)
    )
      return;
    const timer = setTimeout(() => void call("status", run.runId), 2500);
    return () => clearTimeout(timer);
  }, [run, visible, pageVisible, paused]);
  const current = !!run?.current && run.key === key && !paused;
  return {
    available,
    busy,
    checking,
    error,
    run: run?.ideaId === idea.id ? run : null,
    current,
    review: (continuationBlockId?: string) =>
      void call(
        "review",
        run?.status === "failed" || run?.status === "cancelled"
          ? run.runId
          : undefined,
        continuationBlockId,
      ),
    check: () => void call("status", run?.runId),
    feedback: async (disposition: GuidanceDisposition["disposition"]) => {
      if (!run?.runId) return;
      await transport.request("/idea-guidance", {
        action: "feedback",
        ideaId: idea.id,
        revision: idea.revision,
        runId: run.runId,
        disposition,
      });
      setRun((previous) =>
        previous && previous.runId === run.runId && previous.result
          ? {
              ...previous,
              followUp:
                previous.followUp ||
                guidanceFollowUp(
                  previous.result,
                  latest.current.idea.body,
                  latest.current.idea.document || emptyIdeaDocument(),
                ),
              result: { ...previous.result, question: null },
            }
          : previous,
      );
    },
  };
}
