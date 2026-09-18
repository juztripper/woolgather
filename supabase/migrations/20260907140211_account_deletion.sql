-- A deletion request confers no access: a new, live sign-in after the request
-- and the account's MFA policy are required. Only the authenticated actor is deleted.
create table account_private.deletion_requests (
 user_id uuid primary key references auth.users(id) on delete cascade,
 nonce uuid not null,
 requested_at timestamptz not null,
 original_session uuid not null
);
alter table account_private.deletion_requests enable row level security;
revoke all on account_private.deletion_requests from public, anon, authenticated;

create function account_private.deletion(action text, token uuid default null, confirmation text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); request account_private.deletion_requests; ready boolean;
begin
 if account_private.access_status()<>'ok' then raise exception 'Account verification required' using errcode='42501'; end if;
 if action='begin' then
  insert into account_private.deletion_requests values(actor,gen_random_uuid(),clock_timestamp(),(auth.jwt()->>'session_id')::uuid)
  on conflict(user_id) do update set nonce=excluded.nonce, requested_at=excluded.requested_at, original_session=excluded.original_session
  returning * into request;
  return jsonb_build_object('token',request.nonce);
 end if;
 select * into request from account_private.deletion_requests where user_id=actor for update;
 if not found or token is distinct from request.nonce then raise exception 'Deletion request expired. Start again.' using errcode='22023'; end if;
 if action='cancel' then
  delete from account_private.deletion_requests where user_id=actor;
  return '{}'::jsonb;
 end if;
 ready := request.requested_at > now()-interval '15 minutes' and exists(
  select 1 from auth.sessions s where s.user_id=actor and s.id::text=auth.jwt()->>'session_id'
  and s.id<>request.original_session and s.created_at>request.requested_at
  and s.created_at>now()-interval '5 minutes'
 );
 if action='status' then return jsonb_build_object('ready',ready,'expired',request.requested_at<=now()-interval '15 minutes'); end if;
 if action<>'delete' then raise exception 'Invalid action' using errcode='22023'; end if;
 if not ready then raise exception 'Sign in again before deleting your account.' using errcode='42501'; end if;
 if confirmation is distinct from 'DELETE' then raise exception 'Type DELETE to confirm.' using errcode='22023'; end if;
 -- FK cascades remove planning projects/items/history/receipts and Auth identities,
 -- sessions (including refresh tokens), factors and one-time tokens atomically.
 delete from auth.users where id=actor;
 if not found then raise exception 'Account not found' using errcode='P0002'; end if;
 return jsonb_build_object('deleted',true);
end;
$$;
revoke all on function account_private.deletion(text,uuid,text) from public, anon;
grant execute on function account_private.deletion(text,uuid,text) to authenticated;
create function public.account_deletion(action text, token uuid default null, confirmation text default null) returns jsonb
language sql security invoker set search_path='' as $$ select account_private.deletion(action,token,confirmation); $$;
revoke all on function public.account_deletion(text,uuid,text) from public, anon;
grant execute on function public.account_deletion(text,uuid,text) to authenticated;
