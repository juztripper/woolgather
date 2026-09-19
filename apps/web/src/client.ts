import { readPlanningStream } from "./projects/readPlanningStream";
import { rememberMcpReturn, consumeMcpReturn } from "./account/mcpReturn";
import type { PlanningLiveEvent } from "../../../packages/domain/src/planningStream";
import { captureDeletionLink } from "./account/deletion";
import { finishSignInHistory } from "./signInHistory";
import { finishOAuth } from "./oauth";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  initializeAccountPool,
  selectAccountForAction,
  prepareAccountSignIn,
  accountClient,
  routeAccountCallback,
  clearAccountRedirect,
} from "./account/sessionPool";
import type { Action, Command, Project } from "../../../packages/domain/src";
let auth: SupabaseClient;
let connection: Promise<SupabaseClient> | undefined;
let signInNotice = "";
const recoveryKey = "woolgather:password-recovery";
let recoveryUser = "";
export function setPasswordRecovery(userId: string) {
  recoveryUser = userId;
  try {
    if (userId) sessionStorage.setItem(recoveryKey, userId);
    else sessionStorage.removeItem(recoveryKey);
  } catch {
    /* The active recovery flow still works without storage. */
  }
}
export function isPasswordRecovery(userId: string) {
  try {
    return (recoveryUser || sessionStorage.getItem(recoveryKey)) === userId;
  } catch {
    return recoveryUser === userId;
  }
}
export function getSignInNotice() {
  return signInNotice;
}
export function connect() {
  return (connection ||= initialize());
}
async function initialize() {
  rememberMcpReturn(new URL(window.location.href));
  const response = await fetch("/api/config");
  const config = (await response.json()) as { url: string; key: string };
  if (!config.url || !config.key)
    throw new Error(
      "The workspace is being connected. Please try again shortly.",
    );
  auth = initializeAccountPool(config.url, config.key);
  const deletionLink = captureDeletionLink(new URL(window.location.href));
  auth = accountClient(routeAccountCallback(new URL(window.location.href)));
  if (deletionLink && location.pathname !== "/auth/callback")
    auth = await selectAccountForAction(deletionLink.owner);
  const callback = await completeAuthCallback(
    auth,
    new URL(window.location.href),
  );
  signInNotice = callback.notice;
  if (callback.handled) {
    if (!callback.notice) clearAccountRedirect();
    window.history.replaceState(null, "", consumeMcpReturn() || "/recent");
  }
  return auth;
}

export async function completeAuthCallback(client: SupabaseClient, url: URL) {
  // Recovery fires during exchange, before App installs its regular listener.
  const recoveryListener = client.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" && session)
      setPasswordRecovery(session.user.id);
  });
  try {
    const result = await finishOAuth(url, async (code) => {
      await prepareAccountSignIn();
      return client.auth.exchangeCodeForSession(code);
    });
    if (result.handled) finishSignInHistory(!result.notice && !recoveryUser);
    return result;
  } finally {
    recoveryListener.data.subscription.unsubscribe();
  }
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details: { code?: string; runId?: string; retryAfter?: number } = {},
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  onProgress?: (event: PlanningLiveEvent) => void,
): Promise<T> {
  const client = await connect();
  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session)
    throw new ApiError("Sign in again to save. Your draft is kept.", 401);
  try {
    const response = await fetch("/api" + path, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(
        path === "/project-planning" ? 195000 : 20000,
      ),
      headers: {
        ...(onProgress ? { Accept: "text/event-stream" } : {}),
        Authorization: `Bearer ${session.access_token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const streamed =
      onProgress &&
      response.headers.get("Content-Type")?.includes("text/event-stream")
        ? await readPlanningStream(response, onProgress)
        : undefined;
    const status = streamed?.status ?? response.status;
    const data = (streamed ? streamed.data : await response.json()) as T & {
      error?: string;
      accountAccess?: string;
      code?: string;
      runId?: string;
      retryAfter?: number;
    };
    if (data.accountAccess)
      window.dispatchEvent(new Event("woolgather:account-access"));
    if (status >= 400)
      throw new ApiError(
        data.error || "Unable to connect. Please try again.",
        status,
        { code: data.code, runId: data.runId, retryAfter: data.retryAfter },
      );
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      onProgress
        ? "Live connection interrupted. Check the saved conversation before trying again."
        : "Connection interrupted. Your draft is kept. Please reconnect and retry.",
      0,
    );
  }
}
export function makeCommand(
  projectId: string,
  expectedRevision: number,
  action: Action,
): Command {
  return { id: crypto.randomUUID(), projectId, expectedRevision, action };
}
export async function sendCommand(command: Command) {
  const receipt = await api<Project>("/commands", command);
  // An old retry receipt proves the write, but the reopened plan must be current.
  const latest = await api<Project>("/projects/" + command.projectId);
  return latest.revision >= receipt.revision ? latest : receipt;
}

export async function exportProject(id: string): Promise<string> {
  const client = await connect();
  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) throw new ApiError("Sign in to export your plan.", 401);
  const response = await fetch("/api/projects/" + id + "/export", {
    headers: { Authorization: `Bearer ${session.access_token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new ApiError(
      "Unable to export. Please reconnect and try again.",
      response.status,
    );
  return response.text();
}
