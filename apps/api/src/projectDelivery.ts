import { z } from "zod";
import type { Project } from "../../../packages/domain/src";
import {
  applyDeliveryCommand,
  deliveryCommandSchema,
  deliveryContext,
  type DeliveryState,
} from "../../../packages/domain/src/projectDelivery";
import type { GuidanceRpc } from "./ideaGuidance";

export interface DeliveryEnv {
  ACCOUNT_ACTION_SECRET?: string;
}
export type DeliveryActor =
  | { actor: "owner"; ownerId: string; projectId: string }
  | { actor: "agent"; tokenHash: string };

const uuid = z.uuid();
const agentCommandSchema = deliveryCommandSchema.extend({
  projectId: uuid.optional(),
});
const tokenAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      name: z.string().trim().min(1).max(80),
      expiresInDays: z.number().int().min(1).max(90).default(30),
    })
    .strict(),
  z.object({ action: z.literal("revoke"), tokenId: uuid }).strict(),
]);
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
export async function hashIntegrationToken(token: string) {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
}
export async function signDelivery(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`woolgather.delivery.v1:${payload}`),
    ),
  );
}
export async function integrationActor(
  authorization: string | null,
): Promise<DeliveryActor | null> {
  if (!authorization || !/^Bearer wg_[0-9a-f]{64}$/.test(authorization))
    return null;
  return {
    actor: "agent",
    tokenHash: await hashIntegrationToken(authorization.slice(7)),
  };
}

class DeliveryFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
function rpcFailure(error: { code?: string; message?: string }): never {
  if (error.code === "PT409")
    throw new DeliveryFailure(
      "The plan or delivery changed. Reload before trying again.",
      409,
    );
  if (error.code === "P0002")
    throw new DeliveryFailure("Project or connection not found.", 404);
  if (error.code === "28000")
    throw new DeliveryFailure(
      "This connection expired or was revoked. Create a new connection in woolgather.",
      401,
    );
  if (error.code === "42501")
    throw new DeliveryFailure(
      "This connection cannot perform that action. Check account access and connection permissions.",
      403,
    );
  if (error.code === "22023")
    throw new DeliveryFailure(
      error.message || "Please check the delivery fields.",
      422,
    );
  throw new DeliveryFailure(
    "Delivery could not be confirmed. Reload and retry using the same request identifier.",
    503,
  );
}
async function exchange(
  rpc: GuidanceRpc,
  env: DeliveryEnv,
  actor: DeliveryActor,
  fields: Record<string, unknown>,
) {
  if (!env.ACCOUNT_ACTION_SECRET)
    throw new DeliveryFailure(
      "Connected building is not configured on this server.",
      503,
    );
  const payload = JSON.stringify({
    ...actor,
    ...fields,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  });
  const response = await rpc("project_delivery_exchange", {
    payload,
    signature: await signDelivery(env.ACCOUNT_ACTION_SECRET, payload),
  });
  if (response.error) rpcFailure(response.error);
  return response.data;
}
async function safely(action: () => Promise<Response>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof DeliveryFailure)
      return json({ error: error.message }, error.status);
    // Neither a token nor a database/provider error is reflected or logged here.
    return json(
      { error: "Delivery could not be confirmed. Reload before trying again." },
      503,
    );
  }
}
interface DeliverySnapshot {
  state: DeliveryState;
  project?: Project;
  replayed: boolean;
}
export function readDelivery(
  rpc: GuidanceRpc,
  env: DeliveryEnv,
  actor: DeliveryActor,
) {
  return safely(async () => {
    const snapshot = (await exchange(rpc, env, actor, {
      operation: "read",
    })) as DeliverySnapshot;
    if (!snapshot.project) throw new DeliveryFailure("Project not found.", 404);
    const context =
      actor.actor === "agent"
        ? deliveryContext(snapshot.project, snapshot.state)
        : snapshot.state;
    if (new TextEncoder().encode(JSON.stringify(context)).byteLength > 1000000)
      throw new DeliveryFailure(
        "This project's build context exceeds the current integration size limit.",
        413,
      );
    return json(context);
  });
}
export function writeDelivery(
  rpc: GuidanceRpc,
  env: DeliveryEnv,
  actor: DeliveryActor,
  body: unknown,
) {
  return safely(async () => {
    const parsed = (
      actor.actor === "agent" ? agentCommandSchema : deliveryCommandSchema
    ).safeParse(body);
    if (!parsed.success)
      return json(
        { error: "Please check the delivery fields and try again." },
        422,
      );
    const request = parsed.data;
    if (actor.actor === "owner" && request.projectId !== actor.projectId)
      return json({ error: "Project scope mismatch." }, 403);
    if (
      actor.actor === "agent" &&
      !["connect_repository", "report_outcome"].includes(request.action.type)
    )
      return json(
        {
          error:
            "Agents can connect repositories and report evidence. Scope and verification remain with the owner.",
        },
        403,
      );
    const snapshot = (await exchange(rpc, env, actor, {
      operation: "read",
      command: request,
    })) as DeliverySnapshot;
    if (snapshot.replayed) return json(snapshot.state);
    if (!snapshot.project) throw new DeliveryFailure("Project not found.", 404);
    const command = {
      ...request,
      projectId: request.projectId ?? snapshot.project.id,
    };
    if (snapshot.state.revision !== command.expectedRevision)
      throw new DeliveryFailure(
        "The delivery changed. Reload before trying again.",
        409,
      );
    let state: DeliveryState;
    try {
      state = applyDeliveryCommand(
        snapshot.state,
        command,
        snapshot.project,
        actor.actor,
        new Date().toISOString(),
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "Invalid delivery change.",
        },
        422,
      );
    }
    const saved = (await exchange(rpc, env, actor, {
      operation: "write",
      command,
      state,
      projectRevision: snapshot.project.revision,
    })) as DeliverySnapshot;
    return json(saved.state);
  });
}
export function integrationTokens(
  rpc: GuidanceRpc,
  env: DeliveryEnv,
  actor: Extract<DeliveryActor, { actor: "owner" }>,
  body?: unknown,
) {
  return safely(async () => {
    if (body === undefined)
      return json(await exchange(rpc, env, actor, { operation: "tokens" }));
    const parsed = tokenAction.safeParse(body);
    if (!parsed.success)
      return json(
        { error: "Enter a connection name and expiry between 1 and 90 days." },
        422,
      );
    if (parsed.data.action === "revoke")
      return json(
        await exchange(rpc, env, actor, {
          operation: "revoke_token",
          tokenId: parsed.data.tokenId,
        }),
      );
    const random = crypto.getRandomValues(new Uint8Array(32));
    const token = `wg_${hex(random.buffer)}`;
    const metadata = await exchange(rpc, env, actor, {
      operation: "create_token",
      tokenId: crypto.randomUUID(),
      name: parsed.data.name,
      tokenHash: await hashIntegrationToken(token),
      tokenExpiresAt: new Date(
        Date.now() + parsed.data.expiresInDays * 86400000,
      ).toISOString(),
    });
    return json({ ...(metadata as Record<string, unknown>), token }, 201);
  });
}
export const deliveryProjectId = (body: unknown) => {
  const parsed = z.object({ projectId: uuid }).safeParse(body);
  return parsed.success ? parsed.data.projectId : null;
};
