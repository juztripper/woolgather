import {
  stripeBillingMode,
  stripeCheckoutMode,
  stripeWebhook,
  stripeCheckout,
  processStripeEvent,
  type StripeBillingEnv,
} from "./stripeBilling";
import { accountPlan } from "./plans";
import { mcpConsent, mcpSetup } from "./mcpAuthorization";
import { planningEventChannel } from "./planningStream";
import { projectDeletionError } from "./projectDeletionError";
import { projectVoice, type ProjectVoiceEnv } from "./projectVoice";
import {
  projectPlanning,
  planningEnabled,
  type PlanningEnv,
} from "./projectPlanning";
import { billingTestWebhook, type BillingTestEnv } from "./billing";
import {
  libraryCommandSchema,
  deleteTrashSchema,
} from "../../../packages/domain/src/library";
import { accountDeletion } from "./accountDeletion";
import { uploadImageSchema } from "../../../packages/domain/src/ideaDocument";
import { commandSchema } from "../../../packages/domain/src/commands";
import { createClient } from "@supabase/supabase-js";
import { exportMarkdown, type Project } from "../../../packages/domain/src";
import { projectSourceCommandSchema } from "../../../packages/domain/src/projectSources";
import {
  deliveryProjectId,
  integrationActor,
  integrationTokens,
  readDelivery,
  writeDelivery,
} from "./projectDelivery";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
async function boundedBody(request: Request, limit = 110000) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Empty request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Request too large");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(buffer));
}
function billingRpc(env: Env) {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(4000) }),
    },
  });
  return async (name: string, args: Record<string, unknown>) =>
    client.rpc(name, args);
}
export default {
  async scheduled(_event, env) {
    if (
      stripeBillingMode(env as Env & StripeBillingEnv) === "unavailable" ||
      !env.SUPABASE_URL ||
      !env.SUPABASE_PUBLISHABLE_KEY
    )
      return;
    for (let i = 0; i < 5; i++)
      if (
        !(await processStripeEvent(
          billingRpc(env),
          env as Env & StripeBillingEnv,
        ))
      )
        break;
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const guidanceRoute = [
      "/api/project-planning",
      "/api/project-voice",
    ].includes(url.pathname);
    const guidanceDeadline =
      Date.now() + (url.pathname === "/api/project-planning" ? 180000 : 45000);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/mcp/setup" && request.method === "GET")
      return json(mcpSetup(env));
    if (url.pathname === "/api/config" && request.method === "GET")
      return json({
        url: env.SUPABASE_URL,
        key: env.SUPABASE_PUBLISHABLE_KEY,
        assistance: planningEnabled(env as Env & PlanningEnv),
        voice:
          env.PROJECT_VOICE_ENABLED === "true" &&
          !!env.OPENAI_API_KEY &&
          !!env.ACCOUNT_ACTION_SECRET,
      });
    if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY)
      return json(
        {
          error: "The workspace is being connected. Please try again shortly.",
        },
        503,
      );
    if (!["GET", "POST"].includes(request.method))
      return json({ error: "Method not allowed" }, 405);
    if (url.pathname === "/api/billing/stripe/webhook") {
      const billingEnv = env as Env & StripeBillingEnv;
      const response = await stripeWebhook(
        request,
        billingRpc(env),
        billingEnv,
      );
      if (response.ok)
        ctx.waitUntil(
          processStripeEvent(billingRpc(env), billingEnv).catch(() => {
            console.error(
              JSON.stringify({ event: "billing_reconciliation_deferred" }),
            );
          }),
        );
      return response;
    }
    if (url.pathname === "/api/billing/test/webhook") {
      const billingClient = createClient(
        env.SUPABASE_URL,
        env.SUPABASE_PUBLISHABLE_KEY,
        {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (input, init) =>
              fetch(input, { ...init, signal: AbortSignal.timeout(4000) }),
          },
        },
      );
      return billingTestWebhook(
        request,
        env as Env & BillingTestEnv,
        async (name, args) => billingClient.rpc(name, args),
      );
    }
    const authorization = request.headers.get("Authorization");
    if (url.pathname.startsWith("/api/integrations/")) {
      const actor = await integrationActor(authorization);
      if (!actor)
        return json({ error: "A project integration token is required." }, 401);
      if (
        url.pathname === "/api/integrations/context" &&
        request.method === "GET"
      )
        return readDelivery(billingRpc(env), env, actor);
      if (
        url.pathname === "/api/integrations/delivery" &&
        request.method === "POST"
      ) {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        try {
          return await writeDelivery(
            billingRpc(env),
            env,
            actor,
            await boundedBody(request, 128000),
          );
        } catch {
          return json({ error: "Invalid or oversized delivery request." }, 422);
        }
      }
      return json({ error: "Not found" }, 404);
    }
    if (!authorization?.startsWith("Bearer "))
      return json({ error: "Sign in to open your projects." }, 401);
    // Fresh client per request. The caller token reaches Postgres RLS; no service key.
    const client = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_PUBLISHABLE_KEY,
      {
        global: {
          headers: { Authorization: authorization },
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([
                AbortSignal.timeout(
                  guidanceRoute
                    ? Math.max(1, Math.min(4000, guidanceDeadline - Date.now()))
                    : 12000,
                ),
                ...(init?.signal ? [init.signal] : []),
              ]),
            }),
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
    try {
      const {
        data: { user },
        error: authError,
      } = await client.auth.getUser(authorization.slice(7));
      if (authError || !user || user.is_anonymous)
        return json(
          {
            error: "Your session has ended. Sign in again; your draft is kept.",
          },
          401,
        );
      if (url.pathname.startsWith("/api/account/deletion/")) {
        if (request.method !== "POST")
          return json({ error: "Method not allowed" }, 405);
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        return await accountDeletion(
          request,
          client,
          env,
          await boundedBody(request),
        );
      }
      const access = await client.rpc("account_access");
      if (access.error)
        return json(
          { error: "Unable to verify account access. Please try again." },
          503,
        );
      if (access.data !== "ok")
        return json(
          {
            error:
              access.data === "mfa_required"
                ? "Verify your authenticator code to continue."
                : "Your session has ended. Sign in again; your draft is kept.",
            accountAccess: access.data,
          },
          access.data === "mfa_required" ? 403 : 401,
        );
      if (url.pathname === "/api/mcp/authorization") {
        if (
          request.method === "POST" &&
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        return await mcpConsent(
          request,
          env,
          async (name, args) => client.rpc(name, args),
          user.id,
          request.method === "POST"
            ? await boundedBody(request, 4000)
            : undefined,
        );
      }
      const deliveryRoute = url.pathname.match(
        /^\/api\/projects\/([0-9a-f-]{36})\/(delivery|integration-tokens)$/i,
      );
      if (deliveryRoute) {
        const actor = {
          actor: "owner" as const,
          ownerId: user.id,
          projectId: deliveryRoute[1],
        };
        const rpc = async (name: string, args: Record<string, unknown>) =>
          client.rpc(name, args);
        if (request.method === "GET")
          return deliveryRoute[2] === "delivery"
            ? readDelivery(rpc, env, actor)
            : integrationTokens(rpc, env, actor);
        if (
          deliveryRoute[2] !== "integration-tokens" ||
          request.method !== "POST"
        )
          return json({ error: "Method not allowed" }, 405);
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        return integrationTokens(
          rpc,
          env,
          actor,
          await boundedBody(request, 4000),
        );
      }
      if (
        url.pathname === "/api/project-delivery" &&
        request.method === "POST"
      ) {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        const body = await boundedBody(request, 128000);
        const projectId = deliveryProjectId(body);
        if (!projectId) return json({ error: "Invalid project." }, 422);
        return writeDelivery(
          async (name, args) => client.rpc(name, args),
          env,
          { actor: "owner", ownerId: user.id, projectId },
          body,
        );
      }
      if (
        ["/api/billing/checkout", "/api/billing/portal"].includes(url.pathname)
      ) {
        if (request.method !== "POST")
          return json({ error: "Method not allowed" }, 405);
        try {
          return json(
            await stripeCheckout(
              async (name, args) => client.rpc(name, args),
              env as Env & StripeBillingEnv,
              user,
              url.pathname.endsWith("/portal") ? "portal" : "checkout",
            ),
          );
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error &&
                !("type" in error && String(error.type).startsWith("Stripe"))
                  ? error.message
                  : "Checkout is unavailable. Try again shortly.",
            },
            503,
          );
        }
      }
      if (url.pathname === "/api/plan" && request.method === "GET") {
        const plan = await accountPlan(
          async (name, args) => client.rpc(name, args),
          env.PLAN_ALLOWANCES_ENABLED !== "true",
        );
        return json({
          ...plan,
          checkout: stripeCheckoutMode(env as Env & StripeBillingEnv, user.id),
        });
      }
      if (/^\/api\/attachments\/[0-9a-f-]{36}$/i.test(url.pathname)) {
        const target = new URL(env.SUPABASE_URL + "/functions/v1/attachments");
        target.searchParams.set("id", url.pathname.split("/").pop()!);
        if (request.method === "POST")
          target.searchParams.set(
            "name",
            url.searchParams.get("name") || "File",
          );
        return await fetch(target, {
          method: request.method,
          headers: {
            Authorization: authorization,
            apikey: env.SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": "application/octet-stream",
          },
          body: request.method === "POST" ? request.body : undefined,
          signal: AbortSignal.timeout(90000),
        });
      }
      if (
        url.pathname === "/api/project-planning" &&
        request.method === "POST"
      ) {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        const accounting = createClient(
          env.SUPABASE_URL,
          env.SUPABASE_PUBLISHABLE_KEY,
          {
            auth: { persistSession: false, autoRefreshToken: false },
            global: {
              fetch: (input, init) =>
                fetch(input, { ...init, signal: AbortSignal.timeout(4000) }),
            },
          },
        );
        const attachmentDeadline = AbortSignal.timeout(45000);
        const channel = request.headers
          .get("Accept")
          ?.includes("text/event-stream")
          ? planningEventChannel()
          : undefined;
        const work = projectPlanning(
          async (name, args) => client.rpc(name, args),
          async (name, args) => accounting.rpc(name, args),
          env as Env & PlanningEnv,
          user.id,
          await boundedBody(request, 64000),
          fetch,
          async (id) => {
            const target = new URL(
              env.SUPABASE_URL + "/functions/v1/attachments",
            );
            target.searchParams.set("id", id);
            return fetch(target, {
              headers: {
                Authorization: authorization,
                apikey: env.SUPABASE_PUBLISHABLE_KEY,
              },
              signal: attachmentDeadline,
            });
          },
          channel?.emit,
        );
        if (channel) {
          ctx.waitUntil(
            work
              .then((result) => channel.finish(result))
              .catch(() => channel.fail()),
          );
          return channel.response;
        }
        ctx.waitUntil(work.then(() => undefined));
        return await work;
      }
      if (
        url.pathname === "/api/project-sources" &&
        request.method === "POST"
      ) {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        const parsed = projectSourceCommandSchema.safeParse(
          await boundedBody(request, 32000),
        );
        if (!parsed.success)
          return json(
            { error: "Please check the source fields and try again." },
            422,
          );
        const response = await client.rpc("project_source_command", {
          command: parsed.data,
        });
        if (response.error && parsed.data.action === "delete_source") {
          const failure = projectDeletionError(response.error, "source");
          return json({ error: failure.error }, failure.status);
        }
        if (response.error)
          return json(
            { error: response.error.message },
            response.error.code === "PT409"
              ? 409
              : response.error.code === "P0002"
                ? 404
                : 422,
          );
        return json(response.data);
      }
      if (url.pathname === "/api/project-voice" && request.method === "POST") {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        const accounting = createClient(
          env.SUPABASE_URL,
          env.SUPABASE_PUBLISHABLE_KEY,
          {
            auth: { persistSession: false, autoRefreshToken: false },
            global: {
              fetch: (input, init) =>
                fetch(input, { ...init, signal: AbortSignal.timeout(4000) }),
            },
          },
        );
        const controller = {
          start: async (
            input: import("./projectVoice").ProjectVoiceProviderStart,
          ) =>
            env.PROJECT_VOICE_SESSIONS.getByName(
              `${user.id}:${input.runId}`,
            ).start(input),
          attach: async (
            input: import("./projectVoice").ProjectVoiceAttachment,
          ) =>
            env.PROJECT_VOICE_SESSIONS.getByName(
              `${user.id}:${input.runId}`,
            ).attach(input),
          stop: async (input: { runId: string; providerSessionId: string }) =>
            env.PROJECT_VOICE_SESSIONS.getByName(
              `${user.id}:${input.runId}`,
            ).stop(input.providerSessionId),
        };
        const work = projectVoice(
          async (name, args) => client.rpc(name, args),
          async (name, args) => accounting.rpc(name, args),
          env as Env & ProjectVoiceEnv,
          user.id,
          await boundedBody(request, 70000),
          controller,
        );
        ctx.waitUntil(work.then(() => undefined));
        return await work;
      }
      let response;
      if (url.pathname === "/api/images" && request.method === "POST") {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        const parsed = uploadImageSchema.safeParse(
          await boundedBody(request, 460000),
        );
        if (!parsed.success)
          return json({ error: "Choose a PNG, JPEG, or WebP image." }, 422);
        response = await client.rpc("upload_reference_image", {
          command: parsed.data,
        });
      } else if (
        /^\/api\/images\/[0-9a-f-]{36}$/i.test(url.pathname) &&
        request.method === "GET"
      ) {
        response = await client.rpc("reference_image", {
          image_id: url.pathname.split("/").pop(),
        });
        if (!response.error && !response.data)
          return json({ error: "Image not found." }, 404);
      } else if (url.pathname === "/api/library" && request.method === "GET")
        response = await client.rpc("library_snapshot");
      else if (url.pathname === "/api/library" && request.method === "POST") {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        const parsed = libraryCommandSchema.safeParse(
          await boundedBody(request, 1500000),
        );
        if (!parsed.success)
          return json({ error: "Please check the fields and try again." }, 422);
        response = await client.rpc("library_command", {
          command: parsed.data,
        });
      } else if (url.pathname === "/api/trash" && request.method === "POST") {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        const parsed = deleteTrashSchema.safeParse(await boundedBody(request));
        if (!parsed.success)
          return json({ error: "Please select items in Trash." }, 422);
        response = await client.rpc("delete_trash", { command: parsed.data });
      } else if (url.pathname === "/api/projects" && request.method === "GET")
        response = await client.rpc("list_projects");
      else if (url.pathname === "/api/commands" && request.method === "POST") {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return json({ error: "JSON required" }, 415);
        const parsed = commandSchema.safeParse(await boundedBody(request));
        if (!parsed.success)
          return json({ error: "Please check the fields and try again." }, 422);
        response = await client.rpc("execute_command", {
          command: parsed.data,
        });
      } else {
        const match = url.pathname.match(
          /^\/api\/projects\/([0-9a-f-]{36})(\/export|\/history)?$/i,
        );
        if (!match || request.method !== "GET")
          return json({ error: "Not found" }, 404);
        response = await client.rpc(
          match[2] === "/history" ? "project_history" : "project_snapshot",
          { project_id: match[1] },
        );
        if (!response.error && !response.data)
          return json({ error: "Project not found" }, 404);
        if (!response.error && match[2] === "/export") {
          const project = response.data as Project;
          const ids = [
            ...new Set(
              [
                ...(project.references || []),
                ...(project.ideaDocument?.references || []),
              ].map((r) => r.id),
            ),
          ];
          const images: Record<string, string> = {};
          for (const id of ids) {
            const image = await client.rpc("reference_image", { image_id: id });
            if (image.error || !image.data)
              return json(
                {
                  error:
                    "Unable to include a reference image. Please retry the export.",
                },
                503,
              );
            images[id] = image.data.dataUrl;
          }
          return new Response(exportMarkdown(project, images), {
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
              "Content-Disposition":
                'attachment; filename="woolgather-plan.md"',
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
      }
      if (response.error) {
        const code = response.error.code;
        if (code === "PT409")
          return json(
            {
              error:
                url.pathname === "/api/trash"
                  ? "Trash changed. Close this dialog and reload before deleting."
                  : url.pathname === "/api/library"
                    ? "This item changed in another window. Reload the latest version before saving."
                    : "This project changed in another window. Your draft is kept. Reload the latest plan before saving.",
              conflict: true,
            },
            409,
          );
        if (code === "P0002")
          return json({ error: "Project or item not found." }, 404);
        if (["22023", "23514", "23502", "23505", "22P02"].includes(code))
          return json(
            {
              error:
                "This change could not be saved. Check your fields and linked items.",
            },
            422,
          );
        console.error(
          JSON.stringify({
            event: "command_failed",
            code,
            requestId: crypto.randomUUID(),
          }),
        );
        return json(
          {
            error:
              request.method === "GET"
                ? "Unable to load your workspace right now. Please retry."
                : "Unable to save right now. Your draft is kept; please retry.",
          },
          503,
        );
      }
      return json(response.data);
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          ["Empty request", "Request too large"].includes(error.message))
      )
        return json({ error: "Invalid request" }, 400);
      return json(
        { error: "Connection interrupted. Your draft is kept; please retry." },
        503,
      );
    }
  },
} satisfies ExportedHandler<Env>;
