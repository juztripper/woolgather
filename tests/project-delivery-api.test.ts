import test from "node:test";
import assert from "node:assert/strict";
import {
  deliveryProjectId,
  hashIntegrationToken,
  integrationActor,
  integrationTokens,
  readDelivery,
  signDelivery,
  writeDelivery,
  type DeliveryActor,
} from "../apps/api/src/projectDelivery";
import type { GuidanceRpc } from "../apps/api/src/ideaGuidance";
import { planningTestDatabase } from "../scripts/planning-test-database";
import {
  emptyDeliveryState,
  type DeliveryState,
} from "../packages/domain/src/projectDelivery";
import type { Project } from "../packages/domain/src";
import worker from "../apps/api/src/index";
import { Client } from "../packages/agent-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../packages/agent-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { createConnectorServer } from "../packages/agent-connector/src/server.mjs";

const id = () => crypto.randomUUID();

test("integration HTTP routes reject missing credentials, unsupported methods and malformed bodies", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "public",
  } as Env;
  const run = (path: string, init?: RequestInit) =>
    worker.fetch(
      new Request(`https://woolgather.example${path}`, init) as Parameters<
        typeof worker.fetch
      >[0],
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
  assert.equal((await run("/api/integrations/context")).status, 401);
  assert.equal(
    (
      await run("/api/integrations/context", {
        headers: { Authorization: "Bearer account-jwt" },
      })
    ).status,
    401,
  );
  assert.equal(
    (await run("/api/integrations/context", { method: "DELETE" })).status,
    405,
  );
  const authorization = { Authorization: `Bearer wg_${"a".repeat(64)}` };
  assert.equal(
    (
      await run("/api/integrations/delivery", {
        method: "POST",
        headers: authorization,
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await run("/api/integrations/delivery", {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
    422,
  );
  assert.equal(
    (await run("/api/integrations/unknown", { headers: authorization })).status,
    404,
  );
});

test("delivery rejects invalid capabilities and owner-only agent commands without database or inference", async () => {
  assert.equal(await integrationActor("Bearer an-account-jwt"), null);
  assert.equal(await integrationActor("Bearer wg_short"), null);
  assert.equal(deliveryProjectId({ projectId: "bad" }), null);
  const token = `wg_${"a".repeat(64)}`;
  const actor = await integrationActor(`Bearer ${token}`);
  assert.deepEqual(actor, {
    actor: "agent",
    tokenHash: await hashIntegrationToken(token),
  });
  assert.equal(JSON.stringify(actor).includes(token), false);
  const rpc: GuidanceRpc = async () =>
    assert.fail("Unauthorized command reached persistence");
  const response = await writeDelivery(rpc, {}, actor!, {
    id: id(),
    projectId: id(),
    expectedRevision: 0,
    action: { type: "move_scope", scopeId: id(), lane: "now" },
  });
  assert.equal(response.status, 403);
  assert.equal((await readDelivery(rpc, {}, actor!)).status, 503);
});

test("connected building persists independently and enforces its database capability boundary", async (t) => {
  const db = await planningTestDatabase(55541);
  try {
    const env = { ACCOUNT_ACTION_SECRET: db.secret };
    let project = await db.createProject("A small library", "Library");
    const thoughtId = id();
    const added = await db.rpc("execute_command", {
      command: {
        id: id(),
        projectId: project.id,
        expectedRevision: project.revision,
        action: {
          type: "add_item",
          itemId: thoughtId,
          item: {
            title: "Search books",
            body: "Find books by their title",
            category: "feature",
            certainty: "confirmed",
            status: "open",
            answer: "",
            links: [],
          },
        },
      },
    });
    assert.equal(added.error, null);
    project = added.data as Project;
    const actor: DeliveryActor = {
      actor: "owner",
      ownerId: db.owner,
      projectId: project.id,
    };
    const rpcFor =
      (owner: string | null, aal = "aal1"): GuidanceRpc =>
      async (name, args) => {
        assert.equal(name, "project_delivery_exchange");
        try {
          const data = await db.sql.begin(async (tx) => {
            if (owner) {
              await tx`set local role authenticated`;
              await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
              await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: owner, aal })},true)`;
            } else await tx`set local role anon`;
            return (
              await tx`select public.project_delivery_exchange(${args.payload as string},${args.signature as string}) d`
            )[0].d;
          });
          return { data, error: null };
        } catch (error) {
          return {
            data: null,
            error: {
              code: (error as { code?: string }).code,
              message: (error as Error).message,
            },
          };
        }
      };
    const rpc = rpcFor(db.owner),
      anonymous = rpcFor(null);
    const scopeId = id(),
      requirementId = id();
    const create = {
      id: id(),
      projectId: project.id,
      expectedRevision: 0,
      action: {
        type: "create_scope",
        scopeId,
        name: "MVP",
        lane: "now",
        requirements: [
          {
            id: requirementId,
            thoughtId,
            criterion: "Searching a title finds the matching book",
          },
        ],
      },
    };
    let state: DeliveryState = emptyDeliveryState();
    let token = "",
      tokenId = "",
      agent: DeliveryActor;

    await t.test(
      "a scope is durable, replayable and separate from plan revision",
      async () => {
        assert.deepEqual(
          await (await readDelivery(rpc, env, actor)).json(),
          state,
        );
        const response = await writeDelivery(rpc, env, actor, create);
        assert.equal(
          response.status,
          200,
          JSON.stringify(await response.clone().json()),
        );
        state = (await response.json()) as DeliveryState;
        assert.equal(state.revision, 1);
        assert.equal(state.scopes[0].requirements[0].thoughtId, thoughtId);
        assert.deepEqual(
          await (await writeDelivery(rpc, env, actor, create)).json(),
          state,
        );
        assert.deepEqual(
          (await db.rpc("project_snapshot", { project_id: project.id })).data,
          project,
        );
        const conflict = await writeDelivery(rpc, env, actor, {
          ...create,
          action: { ...create.action, name: "Changed" },
        });
        assert.equal(conflict.status, 409);
      },
    );
    await t.test(
      "tokens are high entropy, hash-only, bounded and returned once",
      async () => {
        const response = await integrationTokens(rpc, env, actor, {
          action: "create",
          name: "Codex",
        });
        assert.equal(response.status, 201);
        const issued = (await response.json()) as {
          id: string;
          token: string;
          expiresAt: string;
        };
        token = issued.token;
        tokenId = issued.id;
        assert.match(token, /^wg_[0-9a-f]{64}$/);
        assert.ok(
          new Date(issued.expiresAt).getTime() - Date.now() > 29 * 86400000,
        );
        agent = (await integrationActor(`Bearer ${token}`))!;
        const stored =
          await db.sql`select * from delivery_private.tokens where id=${tokenId}`;
        assert.equal(stored[0].token_hash, await hashIntegrationToken(token));
        assert.equal(JSON.stringify(stored).includes(token), false);
        const listed = (await (
          await integrationTokens(rpc, env, actor)
        ).json()) as unknown[];
        assert.equal(listed.length, 1);
        assert.equal(JSON.stringify(listed).includes(token), false);
        assert.equal(
          JSON.stringify(listed).includes(stored[0].token_hash),
          false,
        );
        assert.equal(
          (
            await integrationTokens(rpc, env, actor, {
              action: "create",
              name: "Too long",
              expiresInDays: 91,
            })
          ).status,
          422,
        );
      },
    );
    await t.test(
      "agent context and reports use no full session and cannot verify or change scope",
      async () => {
        const server = createConnectorServer({
          origin: "https://woolgather.example",
          token,
          fetchImpl: async (
            input: string | URL | Request,
            init?: RequestInit,
          ) => {
            const request = new Request(String(input), init);
            const capability = await integrationActor(
              request.headers.get("Authorization"),
            );
            assert.ok(capability);
            if (new URL(request.url).pathname === "/api/integrations/context")
              return readDelivery(anonymous, env, capability);
            assert.equal(
              new URL(request.url).pathname,
              "/api/integrations/delivery",
            );
            return writeDelivery(
              anonymous,
              env,
              capability,
              await request.json(),
            );
          },
        });
        const client = new Client({
          name: "woolgather-database-test",
          version: "1.0.0",
        });
        const [serverTransport, clientTransport] =
          InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          const initialContext = await client.callTool({
            name: "get_project_context",
            arguments: {},
          });
          assert.equal(initialContext.isError, undefined);
          assert.equal(
            (initialContext.structuredContent as { delivery: DeliveryState })
              .delivery.scopes[0].id,
            scopeId,
          );
          const contextResponse = await readDelivery(anonymous, env, agent);
          assert.equal(contextResponse.status, 200);
          const context = (await contextResponse.json()) as {
            project: { id: string };
            delivery: DeliveryState;
          };
          assert.equal(context.project.id, project.id);
          assert.deepEqual(context.delivery, state);
          const connected = await client.callTool({
            name: "connect_repository",
            arguments: {
              commandId: id(),
              expectedRevision: state.revision,
              label: "Library",
              remoteUrl: "https://github.com/example/library",
              branch: "main",
            },
          });
          assert.equal(connected.isError, undefined, JSON.stringify(connected));
          state = connected.structuredContent as unknown as DeliveryState;
          const report = {
            id: id(),
            expectedRevision: state.revision,
            action: {
              type: "report_outcome",
              scopeId,
              requirementId,
              state: "implemented",
              summary: "Search implemented",
              commit: "a".repeat(40),
              checks: [{ command: "npm test", result: "passed" }],
            },
          };
          const { type: _type, ...outcome } = report.action;
          const response = await client.callTool({
            name: "report_implementation_outcome",
            arguments: {
              commandId: report.id,
              expectedRevision: report.expectedRevision,
              ...outcome,
            },
          });
          assert.equal(response.isError, undefined, JSON.stringify(response));
          state = response.structuredContent as unknown as DeliveryState;
          assert.equal(state.reports[0].actor, "agent");
          assert.deepEqual(state.reviews, []);
          const reportedContext = await client.callTool({
            name: "get_project_context",
            arguments: {},
          });
          const progress = (
            reportedContext.structuredContent as {
              progress: {
                implemented: number;
                verified: number;
                percent: number;
              }[];
            }
          ).progress[0];
          assert.equal(progress.implemented, 1);
          assert.equal(progress.verified, 0);
          assert.equal(progress.percent, 0);
          assert.deepEqual(
            await (await writeDelivery(anonymous, env, agent, report)).json(),
            state,
          );
          assert.equal(
            (
              await writeDelivery(anonymous, env, agent, {
                id: id(),
                projectId: project.id,
                expectedRevision: state.revision,
                action: {
                  type: "review_requirement",
                  scopeId,
                  requirementId,
                  verified: true,
                  note: "Untrusted",
                },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await writeDelivery(anonymous, env, agent, {
                ...report,
                id: id(),
                projectId: id(),
              })
            ).status,
            403,
          );
        } finally {
          await client.close();
          await server.close();
        }
      },
    );
    await t.test("concurrent writes cannot overwrite each other", async () => {
      const command = {
        projectId: project.id,
        expectedRevision: state.revision,
        action: { type: "move_scope", scopeId, lane: "next" },
      };
      const responses = await Promise.all([
        writeDelivery(rpc, env, actor, { ...command, id: id() }),
        writeDelivery(rpc, env, actor, { ...command, id: id() }),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      state = (await responses
        .find((r) => r.status === 200)!
        .json()) as DeliveryState;
    });
    await t.test(
      "owner verification requires ownership and current MFA",
      async () => {
        const stranger = id();
        await db.sql`insert into auth.users(id) values(${stranger})`;
        await db.sql`insert into auth.sessions(id,user_id) values(${stranger},${stranger})`;
        assert.equal(
          (
            await readDelivery(rpcFor(stranger), env, {
              ...actor,
              ownerId: stranger,
            })
          ).status,
          404,
        );
        const mfa = id();
        await db.sql`insert into auth.mfa_factors(id,user_id,status) values(${mfa},${db.owner},'verified')`;
        assert.equal((await readDelivery(rpc, env, actor)).status, 403);
        assert.equal(
          (await readDelivery(rpcFor(db.owner, "aal2"), env, actor)).status,
          200,
        );
        await db.sql`delete from auth.mfa_factors where id=${mfa}`;
        const response = await writeDelivery(rpc, env, actor, {
          id: id(),
          projectId: project.id,
          expectedRevision: state.revision,
          action: {
            type: "review_requirement",
            scopeId,
            requirementId,
            verified: true,
            note: "Tested in the app",
          },
        });
        assert.equal(response.status, 200);
        state = (await response.json()) as DeliveryState;
        assert.equal(state.reviews.length, 1);
        assert.deepEqual(
          await (await writeDelivery(rpc, env, actor, create)).json(),
          state,
        );
      },
    );
    await t.test(
      "version deletion persists, deduplicates retries and rejects stale agent reports",
      async () => {
        const before = structuredClone(state);
        const command = {
          id: id(),
          projectId: project.id,
          expectedRevision: state.revision,
          action: { type: "delete_scope", scopeId },
        };
        assert.equal(
          (await writeDelivery(anonymous, env, agent, command)).status,
          403,
        );
        const forbidden = JSON.stringify({
          ...agent,
          operation: "read",
          command,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        });
        assert.equal(
          (
            await anonymous("project_delivery_exchange", {
              payload: forbidden,
              signature: await signDelivery(db.secret, forbidden),
            })
          ).error?.code,
          "42501",
        );
        assert.equal(
          (
            await writeDelivery(rpc, env, actor, {
              ...command,
              expectedRevision: state.revision - 1,
            })
          ).status,
          409,
        );
        assert.deepEqual(
          await (await readDelivery(rpc, env, actor)).json(),
          before,
        );
        const response = await writeDelivery(rpc, env, actor, command);
        assert.equal(response.status, 200);
        state = (await response.json()) as DeliveryState;
        assert.equal(state.revision, before.revision + 1);
        assert.deepEqual(state.scopes, []);
        assert.deepEqual(state.reports, []);
        assert.deepEqual(state.reviews, []);
        assert.deepEqual(state.repository, before.repository);
        assert.deepEqual(
          await (await readDelivery(rpc, env, actor)).json(),
          state,
        );
        assert.deepEqual(
          await (await writeDelivery(rpc, env, actor, command)).json(),
          state,
        );
        // Retrying the original creation must never resurrect a deleted version.
        assert.deepEqual(
          await (await writeDelivery(rpc, env, actor, create)).json(),
          state,
        );
        const context = (await (
          await readDelivery(anonymous, env, agent)
        ).json()) as { delivery: DeliveryState; project: { revision: number } };
        assert.deepEqual(context.delivery.scopes, []);
        assert.equal(context.project.revision, project.revision);
        assert.equal(
          (
            await writeDelivery(anonymous, env, agent, {
              id: id(),
              projectId: project.id,
              expectedRevision: state.revision,
              action: {
                type: "report_outcome",
                scopeId,
                requirementId,
                state: "implemented",
                summary: "Late report",
                commit: "",
                checks: [],
              },
            })
          ).status,
          422,
        );
      },
    );
    await t.test(
      "direct DB mutation and forged signed requests are denied",
      async () => {
        await assert.rejects(
          db.sql.begin(async (tx) => {
            await tx`set local role authenticated`;
            await tx`insert into delivery_private.states(project_id,state) values(${id()},'{}')`;
          }),
          /permission denied/,
        );
        const payload = JSON.stringify({
          ...agent,
          operation: "read",
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        });
        assert.equal(
          (
            await anonymous("project_delivery_exchange", {
              payload,
              signature: "0".repeat(64),
            })
          ).error?.code,
          "42501",
        );
        const expired = JSON.stringify({
          ...agent,
          operation: "read",
          expiresAt: 1,
        });
        assert.equal(
          (
            await anonymous("project_delivery_exchange", {
              payload: expired,
              signature: await signDelivery(db.secret, expired),
            })
          ).error?.code,
          "42501",
        );
        // Even the Worker boundary cannot grant an agent a forbidden operation.
        const forbidden = JSON.stringify({
          ...agent,
          operation: "create_token",
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        });
        assert.equal(
          (
            await anonymous("project_delivery_exchange", {
              payload: forbidden,
              signature: await signDelivery(db.secret, forbidden),
            })
          ).error?.code,
          "42501",
        );
      },
    );
    await t.test(
      "archive, token expiry, revocation and account deletion fail closed",
      async () => {
        await db.sql`update planning.projects set lifecycle='archived' where id=${project.id}`;
        assert.equal((await readDelivery(anonymous, env, agent)).status, 422);
        await db.sql`update planning.projects set lifecycle='active' where id=${project.id}`;
        await db.sql`update delivery_private.tokens set expires_at=clock_timestamp()-interval '1 second' where id=${tokenId}`;
        assert.equal((await readDelivery(anonymous, env, agent)).status, 401);
        await db.sql`update delivery_private.tokens set expires_at=clock_timestamp()+interval '1 day' where id=${tokenId}`;
        assert.equal(
          (
            await integrationTokens(rpc, env, actor, {
              action: "revoke",
              tokenId,
            })
          ).status,
          200,
        );
        assert.equal((await readDelivery(anonymous, env, agent)).status, 401);
        const fresh = (await (
          await integrationTokens(rpc, env, actor, {
            action: "create",
            name: "Claude Code",
          })
        ).json()) as { token: string };
        const freshActor = (await integrationActor(`Bearer ${fresh.token}`))!;
        await db.sql`delete from auth.users where id=${db.owner}`;
        assert.equal(
          (await readDelivery(anonymous, env, freshActor)).status,
          401,
        );
        assert.equal(
          (await db.sql`select count(*) n from delivery_private.states`)[0].n,
          "0",
        );
      },
    );
  } finally {
    await db.close();
  }
});
