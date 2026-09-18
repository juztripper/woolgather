import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { Project } from "../../../../packages/domain/src";
import { ApiError } from "../client";
import { Button, IconButton } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { ProjectTransport } from "./ProjectTransport";
import {
  AlertCircle,
  AudioLines,
  Captions,
  LoaderCircle,
  MicOff,
  PhoneOff,
  Volume2,
} from "lucide-react";
import { VoiceSphere } from "./VoiceSphere";
import "./project-voice.css";

type VoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "muted"
  | "delegating"
  | "stopping"
  | "error";

type VoiceReply = {
  runId?: string;
  status: string;
  expiresAt?: number;
  maxDurationSeconds?: number;
  durationSeconds?: number;
  session: { id: string };
  transport: { type: "webrtc"; sdp: string };
};

type ActiveVoiceReply = VoiceReply & { runId: string };

type VoiceCaption = { speaker: "you" | "woolgather"; text: string };

const MAX_CAPTION_CHARACTERS = 800;
const MAX_INPUT_CHARACTERS = 12_000;
const terminalVoiceStatuses = new Set([
  "idle",
  "completed",
  "failed",
  "cancelled",
]);

export type ProjectVoiceTranscriptEntry = {
  speaker: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
};

export type ProjectVoiceHistoryEntry = {
  runId: string;
  status: string;
  durationSeconds?: number;
  createdAt?: string;
  closedAt?: string;
  transcript: ProjectVoiceTranscriptEntry[];
};

type VoiceDelegation = {
  id: string;
  requestId: string;
  turnId: string;
  text: string;
};

type SessionStartWaiter = {
  generation: number;
  timeout: number;
  resolve: () => void;
  reject: (cause: unknown) => void;
};

export type ProjectVoiceStartInput = {
  projectId: string;
  conversationId: string;
  revision: number;
  sdp: string;
  requestId: string;
  runId: string;
};

export type ProjectVoiceStopInput = {
  projectId: string;
  revision: number;
  runId: string;
};

export type ProjectVoiceStatusInput = {
  projectId: string;
  revision: number;
  runId: string;
};

export type ProjectVoiceHistoryInput = {
  projectId: string;
  conversationId: string;
  revision: number;
};

export type ProjectVoiceTransport = {
  start: (input: ProjectVoiceStartInput) => Promise<VoiceReply>;
  stop: (input: ProjectVoiceStopInput) => Promise<unknown>;
  status?: (input: ProjectVoiceStatusInput) => Promise<{
    status?: string;
    providerClosed?: boolean;
    titlePending?: boolean;
    durationSeconds?: number;
    transcript?: ProjectVoiceTranscriptEntry[];
  }>;
  history?: (input: ProjectVoiceHistoryInput) => Promise<{
    history?: ProjectVoiceHistoryEntry[];
  }>;
};

export type ProjectVoiceProps = {
  owner: string;
  project: Project;
  conversationId: string;
  onPrepare?: () => Promise<number>;
  disabled: boolean;
  panelRef?: RefObject<HTMLElement | null>;
  onHistoryChange?: (history: ProjectVoiceHistoryEntry[]) => void;
  /** Keep the mounted transport/history owner while hiding the idle trigger. */
  showTrigger?: boolean;
  onActiveChange?: (active: boolean) => void;
  onDiscuss?: (
    text: string,
    identity?: { requestId: string; turnId: string },
  ) => Promise<string | undefined>;
  onCancel?: (turnId?: string) => void | Promise<void>;
  onSaved?: (reply?: string) => void | Promise<void>;
  transport?: ProjectVoiceTransport;
};

const activeStatuses: VoiceStatus[] = [
  "connecting",
  "listening",
  "speaking",
  "muted",
  "delegating",
  "stopping",
];

type PendingVoiceStart = {
  requestId: string;
  runId: string;
  projectId: string;
  conversationId: string;
  revision: number;
  createdAt: string;
};

function errorText(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Voice could not be connected. Your project is unchanged.";
}

function isKnownVoiceFailure(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  if ([400, 404, 409, 422, 502].includes(error.status)) return true;
  return (
    error.status === 503 &&
    /voice is not connected|voice is unavailable in this isolated preview/i.test(
      error.message,
    )
  );
}

function isTerminalVoiceStatus(
  status: string | undefined,
  providerClosed = false,
) {
  return (
    (!!status && terminalVoiceStatuses.has(status)) ||
    (status === "unknown" && providerClosed)
  );
}

function pendingVoiceKey(
  owner: string,
  projectId: string,
  conversationId: string,
) {
  return `woolgather:project-voice-pending:${owner}:${projectId}:${conversationId}`;
}

function pendingDelegationKey(
  owner: string,
  projectId: string,
  conversationId: string,
  runId: string,
) {
  return `woolgather:project-voice-delegation:${owner}:${projectId}:${conversationId}:${runId}`;
}

function writePendingDelegation(
  owner: string,
  projectId: string,
  conversationId: string,
  runId: string,
  delegation: VoiceDelegation,
) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(
      pendingDelegationKey(owner, projectId, conversationId, runId),
      JSON.stringify(delegation),
    );
    return true;
  } catch {
    return false;
  }
}

function clearPendingDelegation(
  owner: string,
  projectId: string,
  conversationId: string,
  runId: string,
) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.removeItem(
      pendingDelegationKey(owner, projectId, conversationId, runId),
    );
    return true;
  } catch {
    return false;
  }
}

function readPendingVoice(
  owner: string,
  projectId: string,
  conversationId: string,
): PendingVoiceStart | null {
  try {
    const raw = globalThis.localStorage?.getItem(
      pendingVoiceKey(owner, projectId, conversationId),
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingVoiceStart>;
    if (
      typeof value.requestId !== "string" ||
      typeof value.projectId !== "string" ||
      typeof value.conversationId !== "string" ||
      typeof value.revision !== "number" ||
      !Number.isInteger(value.revision) ||
      typeof value.createdAt !== "string" ||
      typeof value.runId !== "string"
    )
      return null;
    return value as PendingVoiceStart;
  } catch {
    return null;
  }
}

function writePendingVoice(
  owner: string,
  projectId: string,
  conversationId: string,
  pending: PendingVoiceStart,
) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(
      pendingVoiceKey(owner, projectId, conversationId),
      JSON.stringify(pending),
    );
    return true;
  } catch {
    return false;
  }
}

function clearPendingVoice(
  owner: string,
  projectId: string,
  conversationId: string,
) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.removeItem(pendingVoiceKey(owner, projectId, conversationId));
    return true;
  } catch {
    return false;
  }
}

function waitForIceGathering(pc: RTCPeerConnection, cancelled: () => boolean) {
  if (pc.iceGatheringState === "complete") return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let interval: number | undefined;
    const finish = (complete: boolean) => {
      if (interval !== undefined) window.clearInterval(interval);
      window.clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve(complete);
    };
    const timeout = window.setTimeout(() => finish(true), 4_000);
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish(true);
    };
    interval = window.setInterval(() => {
      if (cancelled()) finish(false);
    }, 50);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function setTimer(
  ref: MutableRefObject<number | undefined>,
  fn: () => void,
  ms: number,
) {
  if (ref.current !== undefined) window.clearTimeout(ref.current);
  ref.current = window.setTimeout(() => {
    ref.current = undefined;
    fn();
  }, ms);
}

function formatElapsed(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function mergeCaption(
  current: VoiceCaption[],
  speaker: VoiceCaption["speaker"],
  delta: string,
) {
  const text = delta.slice(0, MAX_CAPTION_CHARACTERS);
  const last = current[current.length - 1];
  if (last?.speaker === speaker) {
    return [
      ...current.slice(0, -1),
      {
        speaker,
        text: (last.text + text).slice(0, MAX_CAPTION_CHARACTERS),
      },
    ].slice(-8);
  }
  return [...current, { speaker, text }].slice(-8);
}

export function ProjectVoice({
  owner,
  project,
  conversationId,
  disabled,
  panelRef,
  onHistoryChange,
  showTrigger = true,
  onActiveChange,
  onDiscuss,
  onCancel,
  onSaved,
  onPrepare,
  transport,
}: ProjectVoiceProps) {
  const { notify } = useToast();
  const projectTransport = useContext(ProjectTransport);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState<VoiceCaption[]>([]);
  const [captionsVisible, setCaptionsVisible] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [maxDurationSeconds, setMaxDurationSeconds] = useState(600);
  const [audioNeedsPlay, setAudioNeedsPlay] = useState(false);
  const [audioLevels, setAudioLevels] = useState({ input: 0, output: 0 });
  const historyCallback = useRef(onHistoryChange);
  historyCallback.current = onHistoryChange;
  const audioRef = useRef<HTMLAudioElement>(null);
  const endCallRef = useRef<HTMLButtonElement>(null);
  const mutedRef = useRef(false);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioSourcesRef = useRef<MediaStreamAudioSourceNode[]>([]);
  const audioMeterFrameRef = useRef<number | undefined>(undefined);
  const audioMeterActiveRef = useRef(false);
  const audioMeterPaintAtRef = useRef(0);
  const audioLevelsRef = useRef({ input: 0, output: 0 });
  const outputActivityAtRef = useRef(0);
  const runRef = useRef<ActiveVoiceReply | null>(null);
  const closeReceiptRef = useRef<(() => void) | null>(null);
  const pendingVoiceRef = useRef<PendingVoiceStart | null>(null);
  const startedRef = useRef(false);
  const sessionStartWaitRef = useRef<SessionStartWaiter | null>(null);
  const stoppingRef = useRef(false);
  const mountedRef = useRef(true);
  const startPendingRef = useRef(false);
  const startInFlightRef = useRef(false);
  const providerStartAttemptedRef = useRef(false);
  const startFlightGenerationRef = useRef<number | undefined>(undefined);
  const sessionGenerationRef = useRef(0);
  const elapsedStartedAtRef = useRef<number | undefined>(undefined);
  const elapsedTimerRef = useRef<number | undefined>(undefined);
  const expiryTimerRef = useRef<number | undefined>(undefined);
  const activityTimerRef = useRef<number | undefined>(undefined);
  const delegationTimersRef = useRef<Map<string, number>>(new Map());
  const delegationIdsRef = useRef<Set<string>>(new Set());
  const delegationQueueRef = useRef<VoiceDelegation[]>([]);
  const delegationBusyRef = useRef(false);
  const delegationCancelledRef = useRef(false);
  const activeDelegationRef = useRef<VoiceDelegation | null>(null);
  const inputBufferRef = useRef("");
  const onDiscussRef = useRef(onDiscuss);
  const onCancelRef = useRef(onCancel);
  const onSavedRef = useRef(onSaved);
  const onActiveChangeRef = useRef(onActiveChange);
  const projectTransportRef = useRef(projectTransport);
  const statusRef = useRef(status);
  projectTransportRef.current = projectTransport;
  statusRef.current = status;
  const defaultTransportRef = useRef<ProjectVoiceTransport>({
    start: ({ projectId, conversationId, revision, sdp, runId }) =>
      projectTransportRef.current.request<VoiceReply>("/project-voice", {
        action: "start",
        projectId,
        conversationId,
        revision,
        sdp,
        runId,
      }),
    stop: ({ projectId, revision, runId }) =>
      projectTransportRef.current.request("/project-voice", {
        action: "stop",
        projectId,
        revision,
        runId,
      }),
    status: ({ projectId, revision, runId }) =>
      projectTransportRef.current.request("/project-voice", {
        action: "status",
        projectId,
        revision,
        runId,
      }),
    history: ({ projectId, conversationId, revision }) =>
      projectTransportRef.current.request("/project-voice", {
        action: "history",
        projectId,
        conversationId,
        revision,
      }),
  });
  const transportRef = useRef<ProjectVoiceTransport>(
    transport || defaultTransportRef.current,
  );
  const processDelegationsRef = useRef<(() => Promise<void>) | null>(null);
  const storageFailureNotifiedRef = useRef(false);
  mutedRef.current = muted;
  onDiscussRef.current = onDiscuss;
  onCancelRef.current = onCancel;
  onSavedRef.current = onSaved;
  onActiveChangeRef.current = onActiveChange;
  transportRef.current = transport || defaultTransportRef.current;

  const reportError = useCallback(
    (cause: unknown) => {
      notify(errorText(cause), { tone: "error", duration: 8_000 });
    },
    [notify],
  );

  const reportStorageFailure = useCallback(() => {
    if (storageFailureNotifiedRef.current) return;
    storageFailureNotifiedRef.current = true;
    notify(
      "Voice recovery storage is unavailable. Keep this voice panel open until it stops.",
      { tone: "error", duration: 8_000 },
    );
  }, [notify]);

  const reportStorageSuccess = useCallback(() => {
    storageFailureNotifiedRef.current = false;
  }, []);

  const startElapsed = useCallback(() => {
    elapsedStartedAtRef.current = Date.now();
    setElapsedSeconds(0);
    if (elapsedTimerRef.current !== undefined)
      window.clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = window.setInterval(() => {
      const startedAt = elapsedStartedAtRef.current;
      if (startedAt === undefined) return;
      setElapsedSeconds((Date.now() - startedAt) / 1_000);
    }, 250);
  }, []);

  const stopElapsed = useCallback(() => {
    const startedAt = elapsedStartedAtRef.current;
    if (startedAt !== undefined)
      setElapsedSeconds((Date.now() - startedAt) / 1_000);
    elapsedStartedAtRef.current = undefined;
    if (elapsedTimerRef.current !== undefined)
      window.clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = undefined;
  }, []);

  const waitForSessionStarted = useCallback(
    (generation: number, isCurrent: () => boolean) => {
      if (!isCurrent())
        return Promise.reject(new Error("Voice start was cancelled."));
      const previous = sessionStartWaitRef.current;
      if (previous) {
        window.clearTimeout(previous.timeout);
        sessionStartWaitRef.current = null;
        previous.reject(new Error("The previous voice start was replaced."));
      }
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeout: number | undefined;
        const finish = (cause?: unknown) => {
          if (settled) return;
          settled = true;
          if (timeout !== undefined) window.clearTimeout(timeout);
          if (sessionStartWaitRef.current?.generation === generation)
            sessionStartWaitRef.current = null;
          if (cause === undefined) resolve();
          else reject(cause);
        };
        timeout = window.setTimeout(
          () =>
            finish(
              new Error(
                "The voice session did not become ready. Please try again.",
              ),
            ),
          10_000,
        );
        sessionStartWaitRef.current = {
          generation,
          timeout,
          resolve: () => finish(),
          reject: (cause) => finish(cause),
        };
      });
    },
    [],
  );

  const readAudioLevel = useCallback((analyser: AnalyserNode | null) => {
    if (!analyser) return 0;
    const values = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(values);
    let sum = 0;
    for (const value of values) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    return Math.min(1, Math.sqrt(sum / values.length) * 3.2);
  }, []);

  const paintAudioLevels = useCallback(() => {
    if (!mountedRef.current || !audioMeterActiveRef.current) return;
    const input = readAudioLevel(inputAnalyserRef.current);
    const output = readAudioLevel(outputAnalyserRef.current);
    const previous = audioLevelsRef.current;
    const next = {
      input: previous.input * 0.72 + input * 0.28,
      output: previous.output * 0.68 + output * 0.32,
    };
    audioLevelsRef.current = next;
    const now = performance.now();
    if (output > 0.055) outputActivityAtRef.current = now;
    if (statusRef.current !== "stopping" && statusRef.current !== "error") {
      if (
        next.output > 0.04 &&
        !mutedRef.current &&
        statusRef.current !== "delegating"
      )
        setStatus("speaking");
      else if (
        statusRef.current === "speaking" &&
        outputAnalyserRef.current &&
        now - outputActivityAtRef.current > 700
      )
        setStatus(mutedRef.current ? "muted" : "listening");
    }
    if (now - audioMeterPaintAtRef.current > 34) {
      audioMeterPaintAtRef.current = now;
      setAudioLevels(next);
    }
    audioMeterFrameRef.current = window.requestAnimationFrame(paintAudioLevels);
  }, [readAudioLevel]);

  const startAudioMeter = useCallback(() => {
    audioMeterActiveRef.current = true;
    if (audioMeterFrameRef.current !== undefined) return;
    audioMeterFrameRef.current = window.requestAnimationFrame(paintAudioLevels);
  }, [paintAudioLevels]);

  const setupAudioContext = useCallback(() => {
    if (audioContextRef.current) return audioContextRef.current;
    const AudioContextConstructor =
      window.AudioContext ||
      (
        window as Window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextConstructor) return null;
    try {
      const context = new AudioContextConstructor();
      audioContextRef.current = context;
      void context.resume().catch(() => undefined);
      return context;
    } catch {
      return null;
    }
  }, []);

  const setupInputAudioMeter = useCallback(
    (stream: MediaStream) => {
      const context = setupAudioContext();
      if (!context) return;
      try {
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.72;
        const silent = context.createGain();
        silent.gain.value = 0;
        source.connect(analyser);
        analyser.connect(silent);
        silent.connect(context.destination);
        inputAnalyserRef.current = analyser;
        audioSourcesRef.current.push(source);
        startAudioMeter();
      } catch {
        inputAnalyserRef.current = null;
      }
    },
    [setupAudioContext, startAudioMeter],
  );

  const setupOutputAudioMeter = useCallback(
    (stream: MediaStream) => {
      const context = setupAudioContext();
      if (!context) return;
      try {
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.78;
        const silent = context.createGain();
        silent.gain.value = 0;
        source.connect(analyser);
        analyser.connect(silent);
        silent.connect(context.destination);
        outputAnalyserRef.current = analyser;
        audioSourcesRef.current.push(source);
        startAudioMeter();
      } catch {
        outputAnalyserRef.current = null;
      }
    },
    [setupAudioContext, startAudioMeter],
  );

  const cleanupAudioMeter = useCallback(() => {
    audioMeterActiveRef.current = false;
    if (audioMeterFrameRef.current !== undefined)
      window.cancelAnimationFrame(audioMeterFrameRef.current);
    audioMeterFrameRef.current = undefined;
    for (const source of audioSourcesRef.current) source.disconnect();
    audioSourcesRef.current = [];
    inputAnalyserRef.current = null;
    outputAnalyserRef.current = null;
    outputActivityAtRef.current = 0;
    audioLevelsRef.current = { input: 0, output: 0 };
    audioMeterPaintAtRef.current = 0;
    if (audioContextRef.current)
      void audioContextRef.current.close().catch(() => undefined);
    audioContextRef.current = null;
    if (mountedRef.current) setAudioLevels({ input: 0, output: 0 });
  }, []);

  const cancelDelegations = useCallback(() => {
    const hadWork =
      delegationBusyRef.current ||
      delegationQueueRef.current.length > 0 ||
      delegationTimersRef.current.size > 0;
    delegationCancelledRef.current = true;
    delegationBusyRef.current = false;
    if (mountedRef.current) setDelegating(false);
    for (const timer of delegationTimersRef.current.values())
      window.clearTimeout(timer);
    delegationTimersRef.current.clear();
    delegationQueueRef.current = [];
    inputBufferRef.current = "";
    return hadWork;
  }, []);

  const cleanupTransport = useCallback(() => {
    const sessionStartWait = sessionStartWaitRef.current;
    if (sessionStartWait) {
      sessionStartWaitRef.current = null;
      window.clearTimeout(sessionStartWait.timeout);
      sessionStartWait.reject(new Error("Voice session was stopped."));
    }
    if (mountedRef.current) setAudioNeedsPlay(false);
    if (expiryTimerRef.current !== undefined)
      window.clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = undefined;
    if (activityTimerRef.current !== undefined)
      window.clearTimeout(activityTimerRef.current);
    activityTimerRef.current = undefined;
    for (const timer of delegationTimersRef.current.values())
      window.clearTimeout(timer);
    delegationTimersRef.current.clear();
    delegationQueueRef.current = [];
    inputBufferRef.current = "";
    delegationCancelledRef.current = true;
    delegationBusyRef.current = false;
    activeDelegationRef.current = null;
    startedRef.current = false;
    channelRef.current?.close();
    channelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    for (const track of streamRef.current?.getTracks() || []) track.stop();
    streamRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    cleanupAudioMeter();
  }, [cleanupAudioMeter]);

  const markActivity = useCallback((next: "listening" | "speaking") => {
    setStatus((current) =>
      current === "stopping" || mutedRef.current ? "muted" : next,
    );
    setTimer(
      activityTimerRef,
      () => {
        setStatus((current) =>
          current === "stopping"
            ? current
            : mutedRef.current
              ? "muted"
              : "listening",
        );
      },
      1_400,
    );
  }, []);

  const sendEvent = useCallback((value: Record<string, unknown>) => {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== "open" || !startedRef.current)
      return false;
    try {
      channel.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }, []);

  const processDelegations = useCallback(async () => {
    if (
      delegationBusyRef.current ||
      delegationCancelledRef.current ||
      !startedRef.current
    )
      return;
    const next = delegationQueueRef.current.shift();
    if (!next) return;
    const generation = sessionGenerationRef.current;
    activeDelegationRef.current = next;
    delegationBusyRef.current = true;
    if (mountedRef.current) {
      setDelegating(true);
      setStatus("delegating");
    }
    let succeeded = false;
    try {
      const handler = onDiscussRef.current;
      if (!handler)
        throw new Error("Voice discussion is not available in this workspace.");
      const reply = await handler(next.text, {
        requestId: next.requestId,
        turnId: next.turnId,
      });
      if (!reply?.trim())
        throw new Error(
          "The delegated thought could not be confirmed. Your writing is kept for retry.",
        );
      if (
        delegationCancelledRef.current ||
        generation !== sessionGenerationRef.current ||
        !startedRef.current
      )
        return;
      if (reply) {
        const sent = sendEvent({
          type: "session.commentary.append",
          event_id: crypto.randomUUID(),
          delegation_id: next.id,
          content: reply,
        });
        if (!sent)
          throw new Error(
            "The voice reply could not be delivered. Check the saved conversation before retrying.",
          );
      }
      await onSavedRef.current?.(reply);
      const runId = pendingVoiceRef.current?.runId;
      if (
        runId &&
        clearPendingDelegation(owner, project.id, conversationId, runId)
      )
        succeeded = true;
      else reportStorageFailure();
    } catch (cause) {
      if (!delegationCancelledRef.current && mountedRef.current) {
        sendEvent({
          type: "session.commentary.append",
          event_id: crypto.randomUUID(),
          delegation_id: next.id,
          content:
            "The planning result could not be confirmed. Please check the saved conversation before retrying. We can keep talking.",
        });
        reportError(cause);
        setStatus("listening");
      }
    } finally {
      if (generation !== sessionGenerationRef.current) return;
      delegationBusyRef.current = false;
      activeDelegationRef.current = null;
      if (mountedRef.current) {
        setDelegating(false);
        if (!delegationCancelledRef.current)
          setStatus(mutedRef.current ? "muted" : "listening");
      }
      if (succeeded && !delegationCancelledRef.current)
        void processDelegationsRef.current?.();
    }
  }, [
    conversationId,
    owner,
    project.id,
    reportError,
    reportStorageFailure,
    sendEvent,
  ]);

  processDelegationsRef.current = processDelegations;

  const scheduleDelegation = useCallback(
    (id: string) => {
      if (delegationCancelledRef.current || delegationIdsRef.current.has(id))
        return;
      delegationIdsRef.current.add(id);
      const attempt = (remaining: number) => {
        const timer = window.setTimeout(() => {
          delegationTimersRef.current.delete(id);
          if (delegationCancelledRef.current || !startedRef.current) return;
          const text = inputBufferRef.current.trim();
          if (!text && remaining > 0) {
            attempt(remaining - 1);
            return;
          }
          if (!text) return;
          inputBufferRef.current = "";
          const runId = pendingVoiceRef.current?.runId;
          if (!runId) return;
          const delegation: VoiceDelegation = {
            id,
            requestId: crypto.randomUUID(),
            turnId: crypto.randomUUID(),
            text,
          };
          if (
            !writePendingDelegation(
              owner,
              project.id,
              conversationId,
              runId,
              delegation,
            )
          ) {
            reportStorageFailure();
            return;
          }
          reportStorageSuccess();
          delegationQueueRef.current.push(delegation);
          void processDelegations();
        }, 300);
        delegationTimersRef.current.set(id, timer);
      };
      attempt(3);
    },
    [
      conversationId,
      owner,
      processDelegations,
      project.id,
      reportStorageFailure,
      reportStorageSuccess,
    ],
  );

  const stopRemote = useCallback(
    async (runId: string, revision: number) => {
      try {
        await transportRef.current.stop({
          projectId: project.id,
          revision,
          runId,
        });
        return true;
      } catch (cause) {
        if (mountedRef.current) reportError(cause);
        return false;
      }
    },
    [project.id, reportError],
  );

  const discardPendingVoice = useCallback(() => {
    if (clearPendingVoice(owner, project.id, conversationId)) {
      reportStorageSuccess();
      pendingVoiceRef.current = null;
      return true;
    }
    reportStorageFailure();
    return false;
  }, [
    conversationId,
    owner,
    project.id,
    reportStorageFailure,
    reportStorageSuccess,
  ]);

  // The call UI closes immediately. Observe its optional title separately,
  // then refresh the saved project without issuing another inference request.
  const [endedRun, setEndedRun] = useState<PendingVoiceStart | null>(null);
  useEffect(() => {
    if (!endedRun) return;
    let cancelled = false;
    let timer: number | undefined;
    const deadline = Date.now() + 45_000;
    const refreshTitle = async () => {
      try {
        const latest = await transportRef.current.status?.({
          projectId: endedRun.projectId,
          revision: endedRun.revision,
          runId: endedRun.runId,
        });
        if (cancelled) return;
        if (
          latest &&
          (!isTerminalVoiceStatus(latest.status, latest.providerClosed) ||
            latest.titlePending) &&
          Date.now() < deadline
        ) {
          timer = window.setTimeout(() => void refreshTitle(), 1000);
          return;
        }
        await onSavedRef.current?.();
      } catch {
        /* Optional title refresh must not interrupt the saved call. */
      }
      if (!cancelled) setEndedRun(null);
    };
    void refreshTitle();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [endedRun]);

  const pollVoiceStatus = useCallback(
    async (pending: PendingVoiceStart) => {
      const readStatus = transportRef.current.status;
      if (!readStatus) return null;
      let latest: Awaited<ReturnType<typeof readStatus>> | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          latest = await readStatus({
            projectId: project.id,
            revision: pending.revision,
            runId: pending.runId,
          });
        } catch {
          return null;
        }
        if (isTerminalVoiceStatus(latest.status, latest.providerClosed))
          return latest;
        if (attempt < 3)
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      }
      return latest;
    },
    [project.id],
  );

  const reconcilePendingVoice = useCallback(
    async (pending: PendingVoiceStart) => {
      const readStatus = transportRef.current.status;
      if (!readStatus) {
        return (await stopRemote(pending.runId, pending.revision))
          ? discardPendingVoice()
          : false;
      }
      let latest: Awaited<ReturnType<typeof readStatus>> | null = null;
      try {
        latest = await readStatus({
          projectId: project.id,
          revision: pending.revision,
          runId: pending.runId,
        });
      } catch (cause) {
        if (isKnownVoiceFailure(cause)) return discardPendingVoice();
      }
      if (latest && isTerminalVoiceStatus(latest.status, latest.providerClosed))
        return discardPendingVoice();
      if (!(await stopRemote(pending.runId, pending.revision))) return false;
      latest = await pollVoiceStatus(pending);
      if (
        !latest ||
        !isTerminalVoiceStatus(latest.status, latest.providerClosed)
      ) {
        reportError(
          new Error(
            "A previous voice session is still being checked. Try again after it settles.",
          ),
        );
        return false;
      }
      return discardPendingVoice();
    },
    [discardPendingVoice, pollVoiceStatus, project.id, reportError, stopRemote],
  );

  const stopSession = useCallback(
    async (reason: "user" | "expired" | "failed" | "unmount" = "user") => {
      if (stoppingRef.current) {
        if (reason === "unmount") {
          closeReceiptRef.current?.();
          cleanupTransport();
        }
        return;
      }
      const run = runRef.current;
      const pending =
        pendingVoiceRef.current ||
        readPendingVoice(owner, project.id, conversationId);
      const hadTransport =
        startPendingRef.current ||
        startInFlightRef.current ||
        !!run ||
        !!peerRef.current ||
        !!channelRef.current ||
        !!streamRef.current;
      const cancelledTurnId = activeDelegationRef.current?.turnId;
      const hadDelegation = cancelDelegations();
      sessionGenerationRef.current += 1;
      stoppingRef.current = true;
      if (!hadTransport && !hadDelegation) {
        cleanupTransport();
        stopElapsed();
        stoppingRef.current = false;
        if (mountedRef.current && reason !== "unmount") setStatus("idle");
        return;
      }
      if (mountedRef.current && reason !== "unmount") setStatus("stopping");
      // Silence the devices immediately, but let the final provider receipt
      // drain before closing WebRTC. Closing it first loses authoritative usage.
      for (const track of streamRef.current?.getAudioTracks() || [])
        track.enabled = false;
      audioRef.current?.pause();
      const closed = new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          closeReceiptRef.current = null;
          resolve();
        }, 3_000);
        closeReceiptRef.current = () => {
          window.clearTimeout(timer);
          closeReceiptRef.current = null;
          resolve();
        };
      });
      if (channelRef.current?.readyState === "open" && startedRef.current)
        sendEvent({ type: "session.close", event_id: crypto.randomUUID() });
      else closeReceiptRef.current?.();
      stopElapsed();
      runRef.current = null;
      startPendingRef.current = false;
      mutedRef.current = false;
      setMuted(false);
      if (!run && !providerStartAttemptedRef.current && pending)
        discardPendingVoice();
      const cancelPlanner =
        cancelledTurnId && onCancelRef.current
          ? Promise.resolve()
              .then(() => onCancelRef.current?.(cancelledTurnId))
              .catch((cause) => {
                if (reason !== "unmount") reportError(cause);
              })
          : undefined;
      const stopPromise = run
        ? stopRemote(run.runId, pending?.revision || project.revision)
        : Promise.resolve(true);
      if (reason !== "unmount") await closed;
      else closeReceiptRef.current?.();
      cleanupTransport();
      const stopSucceeded = run
        ? reason === "unmount"
          ? false
          : await Promise.race([
              stopPromise,
              new Promise<boolean>((resolve) =>
                window.setTimeout(() => resolve(false), 1_000),
              ),
            ])
        : true;
      if (cancelPlanner && reason !== "unmount") await cancelPlanner;
      if (run && stopSucceeded && pending?.runId === run.runId) {
        if (clearPendingVoice(owner, project.id, conversationId))
          reportStorageSuccess();
        else reportStorageFailure();
        pendingVoiceRef.current = null;
      }
      stoppingRef.current = false;
      if (pending && mountedRef.current && reason !== "unmount")
        setEndedRun(pending);
      if (mountedRef.current && reason !== "unmount")
        setStatus(reason === "failed" ? "error" : "idle");
    },
    [
      cancelDelegations,
      cleanupTransport,
      conversationId,
      owner,
      project.id,
      project.revision,
      discardPendingVoice,
      reportError,
      reportStorageFailure,
      reportStorageSuccess,
      sendEvent,
      stopElapsed,
      stopRemote,
    ],
  );

  const handleEvent = useCallback(
    (raw: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "session.closed") closeReceiptRef.current?.();
      if (stoppingRef.current) return;
      if (event.type === "session.started") {
        if (!startedRef.current) {
          startedRef.current = true;
          startElapsed();
        }
        setStatus(mutedRef.current ? "muted" : "listening");
        sessionStartWaitRef.current?.resolve();
        return;
      }
      if (event.type === "session.closed") {
        const cancelledTurnId = activeDelegationRef.current?.turnId;
        const reason =
          typeof event.reason === "string" ? event.reason : undefined;
        sessionGenerationRef.current += 1;
        cancelDelegations();
        cleanupTransport();
        runRef.current = null;
        stopElapsed();
        stoppingRef.current = false;
        mutedRef.current = false;
        setMuted(false);
        if (cancelledTurnId && onCancelRef.current)
          void Promise.resolve(onCancelRef.current(cancelledTurnId)).catch(
            (cause) => {
              if (mountedRef.current) reportError(cause);
            },
          );
        if (reason === "connection_lost") {
          reportError(new Error("The voice connection closed unexpectedly."));
          setStatus("error");
        } else {
          setStatus("idle");
        }
        return;
      }
      if (event.type === "error") {
        reportError(
          new Error(
            typeof (event.error as { message?: unknown } | undefined)
              ?.message === "string"
              ? (event.error as { message: string }).message
              : "The voice session reported an error.",
          ),
        );
        void stopSession("failed");
        return;
      }
      if (!startedRef.current) return;
      if (event.type === "session.input_transcript.delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        inputBufferRef.current = (inputBufferRef.current + delta).slice(
          0,
          MAX_INPUT_CHARACTERS,
        );
        if (delta)
          setCaptions((current) => mergeCaption(current, "you", delta));
        markActivity("listening");
        return;
      }
      if (event.type === "session.output_transcript.delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta)
          setCaptions((current) => mergeCaption(current, "woolgather", delta));
        markActivity("speaking");
        return;
      }
      if (event.type === "session.usage.updated") {
        return;
      }
      if (event.type === "session.delegation.created") {
        const delegation = event.delegation as { id?: unknown } | undefined;
        if (typeof delegation?.id === "string")
          scheduleDelegation(delegation.id);
        return;
      }
    },
    [
      cancelDelegations,
      cleanupTransport,
      markActivity,
      reportError,
      scheduleDelegation,
      startElapsed,
      stopElapsed,
      stopSession,
    ],
  );

  const startSession = useCallback(async () => {
    if (
      disabled ||
      startInFlightRef.current ||
      !["idle", "error"].includes(status) ||
      stoppingRef.current
    )
      return;
    const generation = ++sessionGenerationRef.current;
    stoppingRef.current = false;
    delegationCancelledRef.current = false;
    delegationIdsRef.current.clear();
    mutedRef.current = false;
    setMuted(false);
    setAudioNeedsPlay(false);
    const storedPending = readPendingVoice(owner, project.id, conversationId);
    const existing =
      storedPending?.projectId === project.id &&
      storedPending.conversationId === conversationId
        ? storedPending
        : null;
    pendingVoiceRef.current = existing;
    startPendingRef.current = true;
    startInFlightRef.current = true;
    startFlightGenerationRef.current = generation;
    setStatus("connecting");
    setCaptions([]);
    setCaptionsVisible(false);
    setElapsedSeconds(0);
    const isCurrent = () =>
      mountedRef.current &&
      generation === sessionGenerationRef.current &&
      !stoppingRef.current;
    let pending: PendingVoiceStart | null = null;
    try {
      if (existing && !(await reconcilePendingVoice(existing))) {
        if (isCurrent()) {
          startPendingRef.current = false;
          setStatus("error");
        }
        return;
      }
      if (!isCurrent()) return;
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof RTCPeerConnection === "undefined"
      )
        throw new Error(
          "Voice requires a secure browser microphone connection.",
        );
      // Start microphone access while the user's gesture is still current.
      // Preparing a new conversation may require a network round trip.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      setupInputAudioMeter(stream);
      const revision = onPrepare ? await onPrepare() : project.revision;
      if (!isCurrent()) return;
      const currentPending: PendingVoiceStart = {
        requestId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        projectId: project.id,
        conversationId,
        revision,
        createdAt: new Date().toISOString(),
      };
      pending = currentPending;
      if (
        !writePendingVoice(owner, project.id, conversationId, currentPending)
      ) {
        cleanupTransport();
        reportStorageFailure();
        startPendingRef.current = false;
        setStatus("error");
        return;
      }
      reportStorageSuccess();
      pendingVoiceRef.current = currentPending;
      providerStartAttemptedRef.current = false;
      const pc = new RTCPeerConnection();
      peerRef.current = pc;
      pc.onconnectionstatechange = () => {
        if (isCurrent() && ["failed", "closed"].includes(pc.connectionState))
          void stopSession("failed");
      };
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      const channel = pc.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.addEventListener("message", (event) => {
        if (peerRef.current === pc && typeof event.data === "string")
          handleEvent(event.data);
      });
      pc.ontrack = (event) => {
        const audio = audioRef.current;
        if (!isCurrent() || !audio || !event.streams[0]) return;
        audio.srcObject = event.streams[0];
        setupOutputAudioMeter(event.streams[0]);
        void audio
          .play()
          .then(() => {
            if (mountedRef.current) setAudioNeedsPlay(false);
          })
          .catch(() => {
            if (mountedRef.current) setAudioNeedsPlay(true);
          });
      };
      const offer = await pc.createOffer();
      if (!isCurrent()) return;
      await pc.setLocalDescription(offer);
      if (!isCurrent()) return;
      if (!(await waitForIceGathering(pc, () => !isCurrent()))) return;
      const sdp = pc.localDescription?.sdp;
      if (!sdp || !isCurrent())
        throw new Error("The browser did not produce a voice offer.");
      providerStartAttemptedRef.current = true;
      const result = await transportRef.current.start({
        projectId: project.id,
        conversationId,
        revision: currentPending.revision,
        sdp,
        requestId: currentPending.requestId,
        runId: currentPending.runId,
      });
      if (!isCurrent()) {
        const staleRunId = result.runId || currentPending.runId;
        if (await stopRemote(staleRunId, currentPending.revision))
          discardPendingVoice();
        return;
      }
      const runId = result.runId || currentPending.runId;
      const activeResult = { ...result, runId };
      runRef.current = activeResult;
      setMaxDurationSeconds(result.maxDurationSeconds || 600);
      pendingVoiceRef.current = { ...currentPending, runId };
      if (
        !writePendingVoice(owner, project.id, conversationId, {
          ...currentPending,
          runId,
        })
      )
        reportStorageFailure();
      else reportStorageSuccess();
      startPendingRef.current = false;
      if (result.expiresAt) {
        const wait = Math.max(0, result.expiresAt - Date.now());
        expiryTimerRef.current = window.setTimeout(
          () => void stopSession("expired"),
          wait,
        );
      }
      const sessionStarted = waitForSessionStarted(generation, isCurrent);
      await pc.setRemoteDescription({
        type: "answer",
        sdp: result.transport.sdp,
      });
      await sessionStarted;
      if (!isCurrent()) {
        await stopRemote(runId, currentPending.revision);
        return;
      }
    } catch (cause) {
      if (!isCurrent()) return;
      const run = runRef.current;
      sessionGenerationRef.current += 1;
      cleanupTransport();
      runRef.current = null;
      startPendingRef.current = false;
      if (run)
        void stopRemote(run.runId, pending?.revision || project.revision);
      if (
        pending &&
        !run &&
        (!providerStartAttemptedRef.current || isKnownVoiceFailure(cause))
      )
        discardPendingVoice();
      reportError(cause);
      setStatus("error");
    } finally {
      if (startFlightGenerationRef.current === generation) {
        startInFlightRef.current = false;
        startFlightGenerationRef.current = undefined;
      }
    }
  }, [
    onPrepare,
    conversationId,
    cleanupTransport,
    disabled,
    handleEvent,
    owner,
    project.id,
    project.revision,
    reportError,
    reportStorageFailure,
    reportStorageSuccess,
    reconcilePendingVoice,
    setupInputAudioMeter,
    setupOutputAudioMeter,
    waitForSessionStarted,
    status,
    discardPendingVoice,
    stopRemote,
    stopSession,
  ]);

  const toggleMute = useCallback(() => {
    if (!activeStatuses.includes(status) || status === "stopping") return;
    const nextMuted = !muted;
    for (const track of streamRef.current?.getAudioTracks() || [])
      track.enabled = !nextMuted;
    mutedRef.current = nextMuted;
    setMuted(nextMuted);
    setStatus(nextMuted ? "muted" : "listening");
  }, [muted, status]);

  const active = activeStatuses.includes(status);

  useEffect(() => {
    onActiveChangeRef.current?.(active);
    if (active) endCallRef.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    const pending = readPendingVoice(owner, project.id, conversationId);
    pendingVoiceRef.current = pending;
    if (!pending?.runId || !transportRef.current.status) return;
    let cancelled = false;
    void transportRef.current
      .status({
        projectId: project.id,
        revision: pending.revision,
        runId: pending.runId,
      })
      .then((result) => {
        if (
          cancelled ||
          !mountedRef.current ||
          startInFlightRef.current ||
          startedRef.current ||
          pendingVoiceRef.current?.runId !== pending.runId
        )
          return;
        if (!isTerminalVoiceStatus(result.status, result.providerClosed)) {
          setStatus("error");
          notify(
            "A previous voice session is still being checked. Try again after it settles.",
            { tone: "error", duration: 8_000 },
          );
          return;
        }
        if (clearPendingVoice(owner, project.id, conversationId))
          reportStorageSuccess();
        else reportStorageFailure();
        pendingVoiceRef.current = null;
        setEndedRun(pending);
      })
      .catch(reportError);
    return () => {
      cancelled = true;
    };
  }, [
    conversationId,
    notify,
    owner,
    project.id,
    reportError,
    reportStorageFailure,
    reportStorageSuccess,
  ]);

  useEffect(() => {
    const loadHistory = transportRef.current.history;
    if (!loadHistory || active) return;
    let cancelled = false;
    void loadHistory({
      projectId: project.id,
      conversationId,
      revision: project.revision,
    })
      .then((result) => {
        if (cancelled || !mountedRef.current) return;
        historyCallback.current?.((result.history || []).slice(0, 12));
      })
      .catch((cause) => {
        if (cancelled || !mountedRef.current) return;
        // A just-finished title can advance the revision before this history
        // read arrives. Refresh metadata and let the effect read it again.
        if (cause instanceof ApiError && cause.status === 409) {
          void Promise.resolve(onSavedRef.current?.()).catch(reportError);
          return;
        }
        reportError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [active, conversationId, project.id, project.revision, reportError]);

  const stopSessionRef = useRef(stopSession);
  stopSessionRef.current = stopSession;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onActiveChangeRef.current?.(false);
      sessionGenerationRef.current += 1;
      void stopSessionRef.current("unmount");
    };
  }, []);

  const label =
    status === "connecting"
      ? "Connecting"
      : status === "listening"
        ? "Listening"
        : status === "speaking"
          ? "Speaking"
          : status === "muted"
            ? "Muted"
            : status === "delegating"
              ? "Saving a thought"
              : status === "stopping"
                ? "Closing"
                : status === "error"
                  ? "Voice unavailable"
                  : "Talk about this project";
  const latestCaptions = captions.slice(-3);
  const elapsedLabel = formatElapsed(elapsedSeconds);
  const visibleStatus =
    status === "connecting" || status === "stopping" || status === "delegating";
  const spherePhase =
    status === "delegating" || status === "stopping"
      ? "connecting"
      : status === "error"
        ? "error"
        : status;

  const voiceSurface = (
    <div className="project-voice-shell">
      <section
        className="project-voice"
        data-state={status}
        data-active={active ? "true" : "false"}
        data-toast-action-shelf=""
        aria-label="Project voice"
      >
        {!active ? (
          <Button
            variant="primary"
            size="icon"
            className="project-voice-idle-action"
            aria-label={
              status === "error"
                ? "Try voice again"
                : "Start voice conversation"
            }
            title={
              status === "error"
                ? "Try voice again"
                : "Start voice conversation"
            }
            disabled={disabled}
            onClick={() => void startSession()}
          >
            {status === "error" ? (
              <AlertCircle aria-hidden="true" />
            ) : (
              <AudioLines aria-hidden="true" />
            )}
          </Button>
        ) : (
          <>
            <div className="project-voice-orb">
              <VoiceSphere
                phase={spherePhase}
                inputLevel={audioLevels.input}
                outputLevel={audioLevels.output}
                size="panel"
              />
            </div>
            <div className="project-voice-meta">
              {visibleStatus && (
                <span className="project-voice-status" role="status">
                  <LoaderCircle
                    className="project-voice-spin"
                    aria-hidden="true"
                  />
                  {label}
                </span>
              )}
              <span
                className="project-voice-time"
                aria-label={`${elapsedLabel} elapsed, ${formatElapsed(maxDurationSeconds)} maximum`}
              >
                {elapsedLabel} / {formatElapsed(maxDurationSeconds)}
              </span>
              {!visibleStatus && (
                <span className="sr-only" role="status">
                  {label}
                </span>
              )}
            </div>
            <div className="project-voice-actions">
              {audioNeedsPlay && (
                <Button
                  size="sm"
                  variant="quiet"
                  className="project-voice-play-audio"
                  onClick={() => {
                    const audio = audioRef.current;
                    if (!audio) return;
                    void audio
                      .play()
                      .then(() => setAudioNeedsPlay(false))
                      .catch(() => setAudioNeedsPlay(true));
                  }}
                  aria-label="Play voice audio"
                >
                  <Volume2 aria-hidden="true" />
                  Play voice audio
                </Button>
              )}
              {status !== "connecting" && status !== "stopping" && (
                <IconButton
                  size="icon-sm"
                  title={muted ? "Unmute microphone" : "Mute microphone"}
                  aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                  aria-pressed={muted}
                  onClick={toggleMute}
                >
                  {muted ? (
                    <MicOff aria-hidden="true" />
                  ) : (
                    <AudioLines aria-hidden="true" />
                  )}
                </IconButton>
              )}
              <IconButton
                size="icon-sm"
                title={captionsVisible ? "Hide captions" : "Show captions"}
                aria-label={captionsVisible ? "Hide captions" : "Show captions"}
                aria-expanded={captionsVisible}
                aria-controls="project-voice-live-captions"
                onClick={() => setCaptionsVisible((visible) => !visible)}
              >
                <Captions aria-hidden="true" />
              </IconButton>
              <IconButton
                ref={endCallRef}
                size="icon-sm"
                className="project-voice-end"
                title="End voice conversation"
                disabled={status === "stopping"}
                onClick={() => void stopSession("user")}
                aria-label="End voice conversation"
              >
                <PhoneOff aria-hidden="true" />
              </IconButton>
            </div>
            <div
              id="project-voice-live-captions"
              className="project-voice-captions"
              aria-live="polite"
              hidden={!captionsVisible}
            >
              {latestCaptions.length > 0 ? (
                latestCaptions.map((caption, index) => (
                  <p key={`${caption.speaker}:${index}`}>
                    <span>
                      {caption.speaker === "you" ? "You" : "woolgather"}
                    </span>
                    {caption.text}
                  </p>
                ))
              ) : (
                <p className="project-voice-caption-empty">
                  Captions will appear here.
                </p>
              )}
            </div>
            <audio ref={audioRef} autoPlay aria-hidden="true" />
          </>
        )}
      </section>
    </div>
  );

  const voiceTarget =
    showTrigger || active
      ? active && panelRef?.current
        ? createPortal(voiceSurface, panelRef.current)
        : voiceSurface
      : null;
  return voiceTarget;
}
