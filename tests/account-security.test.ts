import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
const sql = postgres(
  process.env.TEST_DATABASE_URL || "postgres://ripper@127.0.0.1:55432/postgres",
);
test("Account sessions and MFA enforce ownership and immediately block revoked tokens", async () => {
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID();
  const current = crypto.randomUUID(),
    remote = crypto.randomUUID(),
    foreign = crypto.randomUUID();
  const factor = crypto.randomUUID();
  const as = (user: string, session: string, aal: string, query: string) =>
    sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub',${user},true)`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: session, aal })},true)`;
      return tx.unsafe(query);
    });
  try {
    await sql`insert into auth.users(id,encrypted_password) values(${owner},'test-only'),(${other},null)`;
    await sql`insert into auth.sessions(id,user_id) values(${current},${owner}),(${remote},${owner}),(${foreign},${other})`;
    const overview = (
      await as(owner, current, "aal1", "select public.account_overview() value")
    )[0].value;
    assert.equal(overview.hasPassword, true);
    assert.equal(overview.sessions.length, 2);
    assert.equal(overview.sessions[0].current, true);
    assert.ok(overview.sessions.every((s: { id: string }) => s.id !== foreign));
    await assert.rejects(
      as(
        owner,
        current,
        "aal1",
        `select public.revoke_account_session('${foreign}')`,
      ),
      /Session not found/,
    );
    await assert.rejects(
      as(
        owner,
        current,
        "aal1",
        `select public.revoke_account_session('${current}')`,
      ),
      /Use sign out/,
    );
    await sql`insert into auth.mfa_factors(id,user_id,status) values(${factor},${owner},'verified')`;
    assert.equal(
      (
        await as(owner, current, "aal1", "select public.account_access() value")
      )[0].value,
      "mfa_required",
    );
    await assert.rejects(
      as(owner, current, "aal1", "select public.account_overview()"),
      /verification required/,
    );
    await assert.rejects(
      as(
        owner,
        current,
        "aal1",
        `insert into planning.projects(id,owner_id,name) values('${crypto.randomUUID()}','${owner}','blocked')`,
      ),
      /row-level security/,
    );
    assert.equal(
      (
        await as(owner, current, "aal2", "select public.account_access() value")
      )[0].value,
      "ok",
    );
    await as(
      owner,
      current,
      "aal2",
      `select public.revoke_account_session('${remote}')`,
    );
    assert.equal(
      (
        await as(owner, remote, "aal2", "select public.account_access() value")
      )[0].value,
      "signed_out",
    );
    await assert.rejects(
      as(owner, remote, "aal2", "select public.account_overview()"),
      /verification required/,
    );
    await assert.rejects(
      as(
        owner,
        remote,
        "aal2",
        `insert into planning.projects(id,owner_id,name) values('${crypto.randomUUID()}','${owner}','blocked')`,
      ),
      /row-level security/,
    );
    assert.equal(
      (
        await as(other, foreign, "aal1", "select public.account_access() value")
      )[0].value,
      "ok",
    );
    await sql`update auth.sessions set not_after=now()-interval '1 minute' where id=${current}`;
    assert.equal(
      (
        await as(owner, current, "aal2", "select public.account_access() value")
      )[0].value,
      "signed_out",
    );
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`set local role anon`;
        return tx`select public.account_overview()`;
      }),
      /permission denied/,
    );
    const permissions =
      await sql`select has_table_privilege('authenticated','auth.sessions','select') as can_read, has_table_privilege('authenticated','auth.users','select') as can_read_users`;
    assert.equal(permissions[0].can_read, false);
    assert.equal(permissions[0].can_read_users, false);
  } finally {
    await sql`delete from auth.users where id in (${owner},${other})`;
    await sql.end();
  }
});
