import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { openVoiceSideband } from "./voiceSideband";
import { nameVoiceConversation } from "./voiceConversationTitle";
import {
  PROJECT_VOICE_MAX_SECONDS,
  PROJECT_VOICE_SETTLEMENT_MAX_SECONDS,
  appendProjectVoiceTranscript,
  providerSession,
  projectVoiceTranscriptFragment,
  signProjectVoiceSettlement,
  type ProjectVoiceAttachment,
  type ProjectVoiceEnv,
  type ProjectVoiceProviderStart,
  type ProjectVoiceTranscriptFragment,
} from "./projectVoice";

type VoiceActiveSession = Omit<ProjectVoiceAttachment, "providerSessionId"> & {
  providerSessionId?: string;
  providerSdp?: string;
  phase: "starting" | "running";
  closed?: false;
  latestUsage?: Record<string, unknown>;
  transcript?: ProjectVoiceTranscriptFragment[];
  closeRequested?: boolean;
  closeRequestedAt?: number;
  finalUsage?: Record<string, unknown>;
  finalReason?: string;
  finalEventReceived?: boolean;
};

type VoiceTerminalTombstone = {
  runId: string;
  phase: "closed";
  closed: true;
};

type VoiceUnknownRecovery = {
  runId: string;
  phase: "unknown";
  closed: true;
  attemptId: string;
  capability: string;
  providerSessionId?: string;
  errorCode?: string;
  providerClosed?: boolean;
};

type VoiceStoredSession =
  VoiceActiveSession | VoiceUnknownRecovery | VoiceTerminalTombstone;

function terminalTombstone(
  session: Pick<VoiceStoredSession, "runId">,
): VoiceTerminalTombstone {
  return { runId: session.runId, phase: "closed", closed: true };
}

function unknownRecovery(
  session: VoiceActiveSession,
  errorCode: string,
  providerClosed = false,
): VoiceUnknownRecovery {
  const recovery: VoiceUnknownRecovery = {
    runId: session.runId,
    phase: "unknown",
    closed: true,
    attemptId: session.attemptId,
    capability: session.capability,
    errorCode,
    providerClosed,
  };
  if (session.providerSessionId)
    recovery.providerSessionId = session.providerSessionId;
  return recovery;
}

function scrubClosedSession(session: VoiceStoredSession) {
  // An unknown hold still needs its random capability/attempt and provider id
  // for a later authoritative terminal receipt. All other closed records can
  // be reduced to a replay tombstone.
  if (session.closed && session.phase === "unknown") {
    const recovery: VoiceUnknownRecovery = {
      runId: session.runId,
      phase: "unknown",
      closed: true,
      attemptId: session.attemptId,
      capability: session.capability,
      providerClosed: session.providerClosed,
    };
    if (session.providerSessionId)
      recovery.providerSessionId = session.providerSessionId;
    if (session.errorCode) recovery.errorCode = session.errorCode;
    return recovery;
  }
  return terminalTombstone(session);
}

const attachmentSchema = z
  .object({
    runId: z.uuid(),
    ownerId: z.uuid(),
    projectId: z.uuid(),
    providerSessionId: z.string().min(1).max(200),
    attemptId: z.uuid(),
    capability: z.string().min(32).max(200),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const providerStartSchema = z
  .object({
    runId: z.uuid(),
    ownerId: z.uuid(),
    projectId: z.uuid(),
    attemptId: z.uuid(),
    capability: z.string().min(32).max(200),
    expiresAt: z.number().int().positive(),
    body: z.string().min(1).max(70_000),
  })
  .strict();

/**
 * One deterministic DO owns one GPT-Live sideband and its final transcript.
 * The browser WebRTC media remains the primary connection; this object only
 * observes transcript/usage events and closes the provider session durably.
 */
export class ProjectVoiceSession extends DurableObject<ProjectVoiceEnv> {
  private socket: WebSocket | undefined;
  private eventQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ProjectVoiceEnv) {
    super(ctx, env);
    // Restore storage invariants only. Never hold this lock across provider or
    // Supabase network I/O.
    void ctx.blockConcurrencyWhile(async () => {
      const session = await ctx.storage.get<VoiceStoredSession>("session");
      if (session?.closed) {
        // Older deployments stored the full closed session. Scrub those
        // records on the next DO activation while retaining the minimal
        // recovery fields for an explicit unknown hold.
        await ctx.storage.put("session", scrubClosedSession(session));
        if (
          session.phase === "unknown" &&
          session.providerSessionId &&
          !session.providerClosed
        ) {
          if ((await ctx.storage.getAlarm()) === null)
            await ctx.storage.setAlarm(Date.now() + 5_000);
        } else await ctx.storage.deleteAlarm();
      }
    });
  }

  /** RPC method called by the Worker after authenticated SQL claim. */
  public async attach(input: ProjectVoiceAttachment): Promise<void> {
    await this.enqueue(() => this.attachInternal(input));
  }

  private async attachInternal(input: ProjectVoiceAttachment): Promise<void> {
    const parsed = attachmentSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid voice attachment");
    // SQL is the authoritative admission gate, but keep the same hard bound
    // at the durable boundary in case a stale or malicious route binding
    // supplies a later expiry.
    if (
      input.expiresAt <= Date.now() ||
      input.expiresAt > Date.now() + (PROJECT_VOICE_MAX_SECONDS + 5) * 1_000
    )
      throw new Error("Voice expiry exceeds the server cap");
    const existing = await this.readSession();
    if (existing && (existing.runId !== input.runId || existing.closed))
      throw new Error("Voice durable object is already in use");
    if (
      existing &&
      (existing.ownerId !== input.ownerId ||
        existing.projectId !== input.projectId ||
        existing.capability !== input.capability ||
        existing.providerSessionId !== input.providerSessionId ||
        existing.attemptId !== input.attemptId ||
        existing.closeRequested)
    )
      throw new Error("Voice durable object is already closing");
    const session: VoiceStoredSession = {
      ...input,
      phase: existing?.phase || "running",
      providerSdp: existing?.providerSdp,
      closed: existing?.closed || false,
      latestUsage: existing?.latestUsage,
      transcript: existing?.transcript || [],
      closeRequested: existing?.closeRequested,
      closeRequestedAt: existing?.closeRequestedAt,
      finalUsage: existing?.finalUsage,
      finalReason: existing?.finalReason,
      finalEventReceived: existing?.finalEventReceived,
    };
    await this.ctx.storage.put("session", session);
    await this.ctx.storage.setAlarm(input.expiresAt);
    if (!this.socket) {
      try {
        await this.connectSideband(session);
      } catch (cause) {
        // A claimed provider session must be closed even if sideband attach
        // fails before the browser receives its SDP response. Keep the
        // reservation unknown if settlement itself cannot be confirmed.
        await this.markUnknown("voice_sideband_attach_failed").catch(
          () => undefined,
        );
        throw cause;
      }
    }
  }

  /**
   * Durable provider creation closes the response-to-persistence crash gap:
   * the provider id and answer SDP are written before this RPC resolves. A
   * startup with no provider id is never retried automatically; its alarm
   * settles the bounded reservation as unknown if the worker disappears.
   */
  public async start(
    input: ProjectVoiceProviderStart,
  ): Promise<{ id: string; sdp: string }> {
    return this.enqueue(() => this.startProvider(input));
  }

  private async startProvider(
    input: ProjectVoiceProviderStart,
  ): Promise<{ id: string; sdp: string }> {
    const parsed = providerStartSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid voice provider start");
    if (
      input.expiresAt <= Date.now() ||
      input.expiresAt > Date.now() + (PROJECT_VOICE_MAX_SECONDS + 5) * 1_000
    )
      throw new Error("Voice expiry exceeds the server cap");
    const existing = await this.readSession();
    if (existing && (existing.runId !== input.runId || existing.closed))
      throw new Error("Voice durable object is already in use");
    if (existing?.providerSessionId && existing.providerSdp) {
      if (
        existing.ownerId !== input.ownerId ||
        existing.projectId !== input.projectId ||
        existing.attemptId !== input.attemptId ||
        existing.capability !== input.capability ||
        existing.closeRequested
      )
        throw new Error("Voice durable object start mismatch");
      if (!this.socket) await this.connectSideband(existing);
      return { id: existing.providerSessionId, sdp: existing.providerSdp };
    }
    // A persisted start without a provider id represents an ambiguous POST.
    // Never issue a second paid POST for it. The alarm/settlement path will
    // close the reservation as unknown.
    if (existing) throw new Error("Voice provider start is being reconciled");

    const pending: VoiceStoredSession = {
      runId: input.runId,
      ownerId: input.ownerId,
      projectId: input.projectId,
      attemptId: input.attemptId,
      capability: input.capability,
      expiresAt: input.expiresAt,
      phase: "starting",
      closed: false,
      transcript: [],
    };
    await this.ctx.storage.put("session", pending);
    await this.ctx.storage.setAlarm(input.expiresAt);
    let live: { id: string; sdp: string };
    try {
      live = await providerSession(input.body, this.env, fetch);
    } catch (error) {
      const providerStatus = (error as { providerStatus?: number })
        .providerStatus;
      const ambiguous =
        !providerStatus ||
        providerStatus >= 500 ||
        providerStatus === 408 ||
        providerStatus === 429;
      if (!ambiguous) {
        // A definitive provider rejection has no session to close. Mark the
        // DO terminal; the authenticated route performs the known settlement.
        await this.ctx.storage.put("session", terminalTombstone(pending));
        await this.ctx.storage.deleteAlarm();
      }
      throw error;
    }
    // Persist provider identity before sideband connection and before the RPC
    // returns the answer to the Worker. A later alarm can close this session
    // even if claim/response handling crashes.
    const session: VoiceStoredSession = {
      ...pending,
      phase: "running",
      providerSessionId: live.id,
      providerSdp: live.sdp,
    };
    try {
      await this.ctx.storage.put("session", session);
    } catch (cause) {
      // If persistence fails after the provider returned an id, make one
      // bounded emergency close while that id is still in memory. A later
      // retry is never allowed to create a second provider session.
      await this.hangupProvider(session).catch(() => undefined);
      throw cause;
    }
    if (!this.socket) {
      try {
        await this.connectSideband(session);
      } catch (cause) {
        await this.markUnknown("voice_sideband_attach_failed").catch(
          () => undefined,
        );
        throw cause;
      }
    }
    return { id: live.id, sdp: live.sdp };
  }

  /** RPC method called by the Worker for an explicit user stop. */
  public async stop(providerSessionId?: string): Promise<void> {
    const session = await this.readSession();
    if (!session) return;
    if (session.phase === "closed") return;
    if (providerSessionId && providerSessionId !== session.providerSessionId)
      throw new Error("Voice provider session mismatch");
    if (session.phase === "unknown") {
      await this.enqueue(() => this.recoverClosedSession(session));
      return;
    }
    if (session.closed) return;
    await this.enqueue(() => this.requestClose());
  }

  private async connectSideband(session: VoiceActiveSession) {
    if (!this.env.OPENAI_API_KEY) throw new Error("Missing OpenAI key");
    if (!session.providerSessionId)
      throw new Error("Voice provider session is not persisted");
    const response = await openVoiceSideband(
      `https://api.openai.com/v1/live/sessions/${encodeURIComponent(session.providerSessionId)}/attach?graceful_close=true`,
      {
        Upgrade: "websocket",
        Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
        ...(this.env.OPENAI_PROJECT_ID
          ? { "OpenAI-Project": this.env.OPENAI_PROJECT_ID }
          : {}),
      },
    );
    if (response.status !== 101 || !response.webSocket)
      throw new Error("Live sideband attach failed");
    const socket = response.webSocket;
    socket.accept();
    this.socket = socket;
    // This is an outbound sideband socket. The hibernation helpers are for
    // inbound client sockets; standard listeners keep this bounded DO alive.
    socket.addEventListener("message", (event) => {
      this.ctx.waitUntil(
        this.enqueue(() => this.handleSidebandData(event.data)),
      );
    });
    socket.addEventListener("close", () => {
      this.ctx.waitUntil(this.enqueue(() => this.handleSidebandClose()));
    });
    socket.addEventListener("error", () => {
      this.ctx.waitUntil(this.enqueue(() => this.handleSidebandClose()));
    });
  }

  /** Serialize socket, alarm, and RPC callbacks so a final usage event cannot
   * be overwritten by a concurrent close or expiry write. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.eventQueue.then(work, work);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private currentSocket() {
    return this.socket;
  }

  /** Read the durable record and scrub legacy full closed records on access. */
  private async readSession() {
    const session = await this.ctx.storage.get<VoiceStoredSession>("session");
    if (!session?.closed) return session;
    const closed = scrubClosedSession(session);
    if (closed !== session) await this.ctx.storage.put("session", closed);
    return closed;
  }

  private async hangupProvider(session: { providerSessionId?: string }) {
    // A crash during the provider POST can leave no provider id to hang up.
    // Keep the SQL run unknown and never guess a different provider session.
    if (!session.providerSessionId) return false;
    if (!this.env.OPENAI_API_KEY) throw new Error("Missing OpenAI key");
    const response = await fetch(
      `https://api.openai.com/v1/live/sessions/${encodeURIComponent(session.providerSessionId)}/hangup`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
          ...(this.env.OPENAI_PROJECT_ID
            ? { "OpenAI-Project": this.env.OPENAI_PROJECT_ID }
            : {}),
        },
        signal: AbortSignal.timeout(4_000),
      },
    );
    // Already closed/expired provider sessions are successfully shut down for
    // our purposes; otherwise retry while retaining the unknown reservation.
    if (!response.ok && response.status !== 404)
      throw new Error("Live provider hangup failed");
    return true;
  }

  private async recoverClosedSession(session: VoiceUnknownRecovery) {
    if (session.providerClosed || !session.providerSessionId) return;
    // Never restart inference or invent final usage. Confirm only that this
    // exact provider session has stopped; SQL retains its entire cost hold.
    await this.hangupProvider(session);
    await this.settle(
      session,
      "unknown",
      0,
      undefined,
      undefined,
      session.errorCode,
      true,
    );
    await this.ctx.storage.put("session", { ...session, providerClosed: true });
    await this.ctx.storage.deleteAlarm();
  }

  private async requestClose() {
    const session = await this.readSession();
    if (!session || session.closed) return;
    if (session.finalEventReceived) {
      await this.finalize(
        session,
        session.finalUsage || {},
        session.finalReason,
      );
      return;
    }
    if (session.closeRequested) {
      await this.ctx.storage.setAlarm(
        Math.max(
          Date.now() + 5_000,
          (session.closeRequestedAt || Date.now()) + 5_000,
        ),
      );
      return;
    }
    const closeRequestedAt = Date.now();
    await this.ctx.storage.put("session", {
      ...session,
      closeRequested: true,
      closeRequestedAt,
    });
    const socket = this.currentSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "session.close" }));
      await this.ctx.storage.setAlarm(closeRequestedAt + 5_000);
      return;
    }
    // A DO restart can lose the outbound socket. Close the provider through
    // its authenticated control endpoint before retaining accounting unknown.
    await this.markUnknown("voice_sideband_missing");
  }

  public async alarm() {
    await this.enqueue(() => this.handleAlarm());
  }

  private async handleAlarm() {
    const session = await this.readSession();
    if (session?.phase === "unknown") {
      try {
        await this.recoverClosedSession(session);
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
      return;
    }
    if (!session || session.closed) return;
    const now = Date.now();
    if (session.finalEventReceived) {
      await this.finalize(
        session,
        session.finalUsage || {},
        session.finalReason,
      );
      const afterFinal = await this.readSession();
      if (afterFinal && !afterFinal.closed)
        await this.ctx.storage.setAlarm(now + 5_000);
      return;
    }
    if (!session.closeRequested && now < session.expiresAt) {
      await this.ctx.storage.setAlarm(session.expiresAt);
      return;
    }
    if (
      session.closeRequested &&
      now >= (session.closeRequestedAt || session.expiresAt) + 5_000
    ) {
      try {
        await this.markUnknown("voice_close_unconfirmed");
      } catch {
        await this.ctx.storage.setAlarm(now + 5_000);
      }
      return;
    }
    try {
      await this.requestClose();
    } catch {
      // Unknown outcomes retain their reservation and retry reconciliation.
      await this.ctx.storage.setAlarm(now + 5_000);
      return;
    }
    const afterClose = await this.readSession();
    if (afterClose && !afterClose.closed)
      await this.ctx.storage.setAlarm(now + 5_000);
  }

  private async handleSidebandData(data: unknown) {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else return;
    await this.handleSidebandMessage(text);
  }

  private async handleSidebandMessage(text: string) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const session = await this.readSession();
    if (!session || session.closed) return;
    const fragment = projectVoiceTranscriptFragment(event);
    if (fragment) {
      await this.ctx.storage.put("session", {
        ...session,
        transcript: appendProjectVoiceTranscript(
          session.transcript || [],
          fragment,
        ),
      });
      return;
    }
    if (event.type === "session.usage.updated") {
      await this.ctx.storage.put("session", {
        ...session,
        latestUsage: (event.usage || {}) as Record<string, unknown>,
      });
      return;
    }
    if (event.type !== "session.closed") return;
    const eventUsage =
      event.usage && typeof event.usage === "object"
        ? (event.usage as Record<string, unknown>)
        : undefined;
    // A cumulative `session.usage.updated` snapshot is not authoritative
    // final billing. Only the terminal session.closed usage may settle known;
    // a missing/invalid terminal value remains unknown and keeps its hold.
    const finalUsage = eventUsage || {};
    const finalReason =
      typeof event.reason === "string" ? event.reason : undefined;
    const finalSession: VoiceStoredSession = {
      ...session,
      finalEventReceived: true,
      finalUsage,
      finalReason,
    };
    // Persist the terminal event before the accounting RPC. If SQL is still
    // reserved (or transiently unavailable), the alarm retries this exact
    // authoritative receipt instead of downgrading to an unverified close.
    await this.ctx.storage.put("session", finalSession);
    await this.finalize(finalSession, finalUsage, finalReason);
  }

  private async handleSidebandClose() {
    const session = await this.readSession();
    if (!session || session.closed) return;
    if (session.finalEventReceived) {
      await this.finalize(
        session,
        session.finalUsage || {},
        session.finalReason,
      );
      return;
    }
    await this.markUnknown("voice_sideband_closed_before_final");
  }

  private async finalize(
    session: VoiceActiveSession,
    usage: Record<string, unknown>,
    reason?: string,
  ) {
    if (session.closed) return;
    const finalSession: VoiceStoredSession = {
      ...session,
      finalEventReceived: true,
      finalUsage: usage,
      finalReason: reason,
    };
    if (!session.finalEventReceived)
      await this.ctx.storage.put("session", finalSession);
    const seconds = usage.seconds;
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > PROJECT_VOICE_SETTLEMENT_MAX_SECONDS
    ) {
      await this.markUnknown("voice_usage_unconfirmed");
      return;
    }
    const status = reason === "connection_lost" ? "failed" : "completed";
    try {
      await this.settle(
        finalSession,
        status,
        seconds,
        reason,
        usage,
        undefined,
        true,
      );
    } catch {
      // Keep the authoritative final receipt durable until the SQL run has
      // been claimed or the transient accounting failure clears.
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      return;
    }
    // The call and transcript are already saved. Naming is separately metered
    // and database-claimed once, including when this final receipt is replayed.
    if (status === "completed")
      await nameVoiceConversation(this.env, finalSession);
    await this.ctx.storage.put("session", terminalTombstone(finalSession));
    await this.ctx.storage.deleteAlarm();
    this.currentSocket()?.close();
    this.socket = undefined;
  }

  private async markUnknown(errorCode: string) {
    const session = await this.readSession();
    if (!session || session.closed) return;
    // A lost sideband is not proof that the provider stopped. Close the
    // provider first, then retain the reservation as unknown.
    const providerClosed = await this.hangupProvider(session);
    await this.settle(
      session,
      "unknown",
      // Unverified usage must never be converted into a debit. The SQL
      // unknown state retains the reservation until a separately verified
      // close reconciliation is available.
      0,
      undefined,
      session.latestUsage,
      errorCode,
      providerClosed,
    );
    await this.ctx.storage.put(
      "session",
      unknownRecovery(session, errorCode, providerClosed),
    );
    await this.ctx.storage.deleteAlarm();
    this.currentSocket()?.close();
    this.socket = undefined;
  }

  private async settle(
    session: VoiceActiveSession | VoiceUnknownRecovery,
    status: "completed" | "failed" | "unknown" | "cancelled",
    durationSeconds: number,
    reason?: string,
    usage?: Record<string, unknown>,
    errorCode?: string,
    providerClosed = false,
  ) {
    if (
      !this.env.SUPABASE_URL ||
      !this.env.SUPABASE_PUBLISHABLE_KEY ||
      !this.env.ACCOUNT_ACTION_SECRET
    )
      throw new Error("Missing voice accounting configuration");
    const payload = JSON.stringify({
      runId: session.runId,
      attemptId: session.attemptId,
      capability: session.capability,
      // Signed settlement may finalize a provider that closed before the
      // authenticated claim RPC completed. SQL can persist this id and then
      // reject a late claim instead of resurrecting the run.
      providerSessionId: session.providerSessionId,
      status,
      durationSeconds: Math.max(
        0,
        Math.min(PROJECT_VOICE_SETTLEMENT_MAX_SECONDS, durationSeconds),
      ),
      reason,
      usage,
      providerClosed,
      ...("transcript" in session
        ? { transcript: session.transcript || [] }
        : {}),
      errorCode,
    });
    const response = await fetch(
      `${this.env.SUPABASE_URL}/rest/v1/rpc/settle_project_voice`,
      {
        method: "POST",
        headers: {
          apikey: this.env.SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload,
          signature: await signProjectVoiceSettlement(
            this.env.ACCOUNT_ACTION_SECRET,
            payload,
          ),
        }),
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!response.ok) throw new Error("Voice settlement failed");
    if (status === "unknown" && providerClosed) {
      const result = (await response.json()) as { providerClosed?: boolean };
      if (result.providerClosed !== true)
        throw new Error("Voice closure acknowledgement is unavailable");
    }
  }
}
