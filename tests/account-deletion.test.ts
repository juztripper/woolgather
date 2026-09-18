import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { signDeletion } from "../apps/api/src/accountDeletion";
const sql = postgres(process.env.TEST_DATABASE_URL!);
test("Email deletion rejects forged, expired, cross-account and replayed links; demands fresh MFA and cascades only the caller", async () => {
  const secret = "local-test-secret-".repeat(4);
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID(),
    session = crypto.randomUUID(),
    foreign = crypto.randomUUID(),
    project = crypto.randomUUID();
  const as = (
    user: string,
    sid: string,
    action: string,
    requestId: string | null = null,
    signature: string | null = null,
    aal = "aal1",
  ) =>
    sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub',${user},true)`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: sid, aal })},true)`;
      return (
        await tx`select public.account_deletion(${action},${requestId}::uuid,${signature}) value`
      )[0].value;
    });
  try {
    await sql`insert into account_private.action_secrets values('account_deletion',${secret}) on conflict(purpose) do nothing`;
    await sql`insert into auth.users(id,email,email_confirmed_at) values(${owner},'delete@example.test',now()),(${other},'other@example.test',now())`;
    await sql`insert into auth.sessions(id,user_id) values(${session},${owner}),(${foreign},${other})`;
    await sql`insert into planning.projects(id,owner_id,name) values(${project},${owner},'Disposable')`;
    await sql`insert into planning.items(id,project_id,title,category,certainty) values(${crypto.randomUUID()},${project},'Item','note','stated')`;
    await sql`insert into planning.commands(owner_id,id,project_id,request,result) values(${owner},${crypto.randomUUID()},${project},'{}','{}')`;
    await sql`insert into planning.history(project_id,revision,action) values(${project},1,'create_project')`;
    const req = await as(owner, session, "begin", crypto.randomUUID());
    assert.equal(req.email, "delete@example.test");
    assert.deepEqual(
      await as(owner, session, "begin", req.id),
      req,
      "retry keeps exactly the same email request",
    );
    await assert.rejects(
      as(owner, session, "begin", crypto.randomUUID()),
      /wait a minute/,
    );
    const sig = await signDeletion(req, secret);
    await assert.rejects(
      as(owner, session, "complete", req.id),
      /Invalid deletion link/,
    );
    await assert.rejects(
      as(owner, session, "complete", req.id, "0".repeat(64)),
      /Invalid deletion link/,
    );
    await assert.rejects(
      as(other, foreign, "complete", req.id, sig),
      /expired/,
    );
    await assert.rejects(
      as(owner, foreign, "complete", req.id, sig),
      /Sign in/,
    );
    await sql`update auth.users set email='changed@example.test' where id=${owner}`;
    await assert.rejects(
      as(owner, session, "complete", req.id, sig),
      /expired/,
    );
    await sql`update auth.users set email='delete@example.test' where id=${owner}`;
    await sql`update account_private.deletion_requests set expires_at=0 where user_id=${owner}`;
    await assert.rejects(
      as(owner, session, "complete", req.id, sig),
      /expired/,
    );
    await sql`update account_private.deletion_requests set expires_at=${req.expiresAt} where user_id=${owner}`;
    assert.equal(
      (await as(owner, session, "status", req.id, sig)).ready,
      true,
      "no MFA is automatic",
    );
    // Enabling MFA after requesting mail must still stop automatic deletion.
    const factor = crypto.randomUUID();
    await sql`insert into auth.mfa_factors(id,user_id,status) values(${factor},${owner},'verified')`;
    await sql`insert into auth.mfa_amr_claims values(${session},'totp',now()-interval '1 minute')`;
    assert.deepEqual(await as(owner, session, "status", req.id, sig, "aal2"), {
      ready: false,
      requiresMfa: true,
    });
    await assert.rejects(
      as(owner, session, "complete", req.id, sig, "aal2"),
      /fresh authenticator/,
    );
    await sql`delete from auth.mfa_factors where id=${factor}`;
    await assert.rejects(
      as(owner, session, "complete", req.id, sig, "aal2"),
      /fresh authenticator/,
      "removing MFA cannot downgrade pending confirmation",
    );
    await sql`insert into auth.mfa_factors(id,user_id,status) values(${factor},${owner},'verified')`;
    await sql`update auth.mfa_amr_claims set updated_at=clock_timestamp() where session_id=${session}`;
    await assert.rejects(
      as(owner, session, "complete", req.id, sig),
      /fresh authenticator/,
      "fresh DB claim also requires aal2 JWT",
    );
    assert.equal(
      (await as(owner, session, "status", req.id, sig, "aal2")).ready,
      true,
    );
    assert.deepEqual(
      await as(owner, session, "complete", req.id, sig, "aal2"),
      { deleted: true },
    );
    for (const table of ["projects", "items", "commands", "history"])
      assert.equal(
        Number(
          (
            await sql.unsafe(
              `select count(*) n from planning.${table} where ${table === "projects" ? "id" : "project_id"}='${project}'`,
            )
          )[0].n,
        ),
        0,
      );
    assert.equal(
      (await sql`select id from auth.sessions where user_id=${owner}`).length,
      0,
    );
    assert.equal(
      (await sql`select id from auth.users where id=${other}`).length,
      1,
    );
    await assert.rejects(
      as(owner, session, "complete", req.id, sig, "aal2"),
      /Sign in/,
    );
    const cancelled = await as(other, foreign, "begin", crypto.randomUUID());
    await as(other, foreign, "cancel", cancelled.id);
    await assert.rejects(
      as(
        other,
        foreign,
        "status",
        cancelled.id,
        await signDeletion(cancelled, secret),
      ),
      /expired/,
    );
    // Second account demonstrates automatic completion with no MFA or extra sign-in.
    await assert.rejects(
      as(other, foreign, "begin", crypto.randomUUID()),
      /wait a minute/,
    );
    await sql`update account_private.deletion_requests set requested_at=now()-interval '61 seconds' where user_id=${other}`;
    const plain = await as(other, foreign, "begin", crypto.randomUUID());
    assert.deepEqual(
      await as(
        other,
        foreign,
        "complete",
        plain.id,
        await signDeletion(plain, secret),
      ),
      { deleted: true },
    );
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`set local role anon`;
        await tx`select public.account_deletion('begin')`;
      }),
      /permission denied/,
    );
    for (const table of ["action_secrets", "deletion_requests"])
      assert.equal(
        (
          await sql`select has_table_privilege('authenticated',${"account_private." + table},'select') allowed`
        )[0].allowed,
        false,
      );
  } finally {
    await sql`delete from auth.users where id in (${owner},${other})`;
    await sql.end();
  }
});
