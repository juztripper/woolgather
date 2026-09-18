-- Email confirmation is a narrow signed capability, bound to the caller's live
-- session, current email and one expiring request. No service-role key is used.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create table account_private.action_secrets (
 purpose text primary key check(purpose='account_deletion'),
 secret text not null check(length(secret)>=43)
);
alter table account_private.action_secrets enable row level security;
revoke all on account_private.action_secrets from public, anon, authenticated;
-- Provision the random signing secret separately; never put credentials in migrations.
delete from account_private.deletion_requests;
alter table account_private.deletion_requests drop column original_session,
 add column email text not null, add column expires_at bigint not null,
 add column mfa_required boolean not null default false,
 add column mfa_after timestamptz, add column mfa_session uuid;
drop function public.account_deletion(text,uuid,text);
drop function account_private.deletion(text,uuid,text);

create function account_private.deletion(action text, request_id uuid default null, signature text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); req account_private.deletion_requests;
 email_now text; key_value text; expected bytea; supplied bytea; difference integer:=0;
 i integer; has_mfa boolean; ready boolean; current_session uuid:=(auth.jwt()->>'session_id')::uuid;
begin
 if actor is null or account_private.access_status()='signed_out' then
  raise exception 'Sign in to confirm account deletion.' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text,83019));
 select email into email_now from auth.users where id=actor and email_confirmed_at is not null;
 if email_now is null then raise exception 'A confirmed account email is required.' using errcode='42501'; end if;
 select exists(select 1 from auth.mfa_factors where user_id=actor and status='verified') into has_mfa;
 select * into req from account_private.deletion_requests where user_id=actor for update;
 if action='begin' then
  if account_private.access_status()<>'ok' then raise exception 'Verify your authenticator first.' using errcode='42501'; end if;
  if request_id is null then raise exception 'Invalid request' using errcode='22023'; end if;
  if req.nonce is distinct from request_id or req.expires_at<=extract(epoch from clock_timestamp()) or req.email is distinct from email_now then
   if req.requested_at>clock_timestamp()-interval '60 seconds' then raise exception 'Please wait a minute before requesting another email.' using errcode='PT429'; end if;
   insert into account_private.deletion_requests(user_id,nonce,requested_at,email,expires_at,mfa_required)
   values(actor,request_id,clock_timestamp(),email_now,floor(extract(epoch from clock_timestamp()+interval '15 minutes')),has_mfa)
   on conflict(user_id) do update set nonce=excluded.nonce, requested_at=excluded.requested_at,
    email=excluded.email,expires_at=excluded.expires_at,mfa_required=excluded.mfa_required,mfa_after=null,mfa_session=null
   returning * into req;
  end if;
  return jsonb_build_object('id',req.nonce,'userId',actor,'email',req.email,'expiresAt',req.expires_at);
 end if;
 if req.nonce is null or request_id is distinct from req.nonce or req.email is distinct from email_now or req.expires_at<=extract(epoch from clock_timestamp()) then
  raise exception 'This deletion link has expired. Request a new one in Account settings.' using errcode='22023';
 end if;
 if action='cancel' then
  delete from account_private.deletion_requests where user_id=actor;
  return '{}'::jsonb;
 end if;
 if action not in ('status','complete') then raise exception 'Invalid action' using errcode='22023'; end if;
 select secret into key_value from account_private.action_secrets where purpose='account_deletion';
 if key_value is null or signature is null or signature !~ '^[0-9a-f]{64}$' then raise exception 'Invalid deletion link.' using errcode='22023'; end if;
 expected:=extensions.hmac(convert_to('woolgather.delete.v1:'||req.nonce::text||':'||actor::text||':'||req.expires_at::text||':'||req.email,'UTF8'),convert_to(key_value,'UTF8'),'sha256');
 supplied:=decode(signature,'hex');
 for i in 0..31 loop difference:=difference | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
 if difference<>0 then raise exception 'Invalid deletion link.' using errcode='22023'; end if;
 if has_mfa or req.mfa_required then
  if req.mfa_after is null or req.mfa_session is distinct from current_session then
   update account_private.deletion_requests set mfa_required=true,mfa_after=clock_timestamp(),mfa_session=current_session where user_id=actor returning * into req;
  end if;
  ready:= has_mfa and coalesce(auth.jwt()->>'aal','aal1')='aal2' and exists(
   select 1 from auth.mfa_amr_claims c where c.session_id=current_session and c.authentication_method='totp' and c.updated_at>req.mfa_after
  );
 else ready:=true;
 end if;
 if action='status' then return jsonb_build_object('ready',ready,'requiresMfa',has_mfa or req.mfa_required); end if;
 if not ready then raise exception 'Enter a fresh authenticator code to confirm deletion.' using errcode='42501'; end if;
 delete from auth.users where id=actor;
 if not found then raise exception 'Account not found' using errcode='P0002'; end if;
 return jsonb_build_object('deleted',true);
end;
$$;
revoke all on function account_private.deletion(text,uuid,text) from public, anon;
grant execute on function account_private.deletion(text,uuid,text) to authenticated;
create function public.account_deletion(action text, request_id uuid default null, signature text default null) returns jsonb
language sql security invoker set search_path='' as $$ select account_private.deletion(action,request_id,signature); $$;
revoke all on function public.account_deletion(text,uuid,text) from public, anon;
grant execute on function public.account_deletion(text,uuid,text) to authenticated;
