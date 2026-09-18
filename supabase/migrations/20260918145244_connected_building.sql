-- Connected building stores delivery evidence separately from authored plans.
-- Only this narrow, Worker-signed boundary can write reducer-produced state.
-- Tokens are project scoped capabilities: hashes only, never account sessions.
create schema delivery_private;
revoke all on schema delivery_private from public;
grant usage on schema delivery_private to anon, authenticated;

create table delivery_private.states (
 project_id uuid primary key references planning.projects(id) on delete cascade,
 state jsonb not null,
 updated_at timestamptz not null default clock_timestamp(),
 check(jsonb_typeof(state)='object' and octet_length(state::text)<=2000000)
);
create table delivery_private.tokens (
 id uuid primary key,
 project_id uuid not null references planning.projects(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(char_length(name) between 1 and 80),
 token_hash text unique not null check(token_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 revoked_at timestamptz,
 last_used_at timestamptz
);
create index delivery_tokens_project on delivery_private.tokens(project_id,created_at desc);
create table delivery_private.receipts (
 project_id uuid not null references planning.projects(id) on delete cascade,
 id uuid not null,
 request jsonb not null,
 actor text not null check(actor in ('owner','agent')),
 token_id uuid,
 result jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(project_id,id)
);
alter table delivery_private.states enable row level security;
alter table delivery_private.tokens enable row level security;
alter table delivery_private.receipts enable row level security;
revoke all on all tables in schema delivery_private from public,anon,authenticated;

create function delivery_private.exchange(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c jsonb; p planning.projects; capability delivery_private.tokens;
 receipt delivery_private.receipts; current_state jsonb; result jsonb;
 expected bytea; supplied bytea; secret_value text; difference integer:=0; n integer;
 actor_id uuid:=auth.uid(); pid uuid; actor_kind text; operation text; token_id uuid;
begin
 if payload is null or octet_length(payload)>2100000 or signature is null or signature !~ '^[0-9a-f]{64}$' then
  raise exception 'Invalid delivery authorization' using errcode='42501';
 end if;
 select secret into secret_value from account_private.action_secrets where purpose='account_deletion';
 expected:=extensions.hmac(convert_to('woolgather.delivery.v1:'||payload,'UTF8'),convert_to(secret_value,'UTF8'),'sha256');
 if expected is null then raise exception 'Delivery unavailable' using errcode='42501'; end if;
 supplied:=decode(signature,'hex');
 for n in 0..31 loop difference:=difference | (get_byte(expected,n) # get_byte(supplied,n)); end loop;
 if difference<>0 then raise exception 'Invalid delivery authorization' using errcode='42501'; end if;
 c:=payload::jsonb;
 if coalesce((c->>'expiresAt')::bigint,0)<extract(epoch from clock_timestamp()) or (c->>'expiresAt')::bigint>extract(epoch from clock_timestamp())+120 then
  raise exception 'Delivery authorization expired' using errcode='42501';
 end if;
 actor_kind:=c->>'actor'; operation:=c->>'operation';
 if actor_kind='owner' then
  if actor_id is null or c->>'ownerId' is distinct from actor_id::text or account_private.access_status()<>'ok' then
   raise exception 'Account verification required' using errcode='42501';
  end if;
  pid:=(c->>'projectId')::uuid;
 elsif actor_kind='agent' then
  select * into capability from delivery_private.tokens where token_hash=c->>'tokenHash';
  if capability.id is null then raise exception 'Connection expired or revoked' using errcode='28000'; end if;
  pid:=capability.project_id;
  token_id:=capability.id;
  if operation not in ('read','write') then raise exception 'Agent operation forbidden' using errcode='42501'; end if;
 else raise exception 'Invalid actor' using errcode='42501';
 end if;
 -- One consistent lock order serializes token revocation, plan edits and delivery.
 select * into p from planning.projects where id=pid for update;
 if p.id is null or (actor_kind='owner' and p.owner_id<>actor_id) then raise exception 'Project not found' using errcode='P0002'; end if;
 if actor_kind='agent' then
  select * into capability from delivery_private.tokens where id=token_id for update;
  if capability.id is null or capability.owner_id<>p.owner_id or capability.revoked_at is not null or capability.expires_at<=clock_timestamp()
   or not exists(select 1 from auth.users u where u.id=capability.owner_id
     and coalesce((to_jsonb(u)->>'is_anonymous')::boolean,false)=false
     and (to_jsonb(u)->>'deleted_at') is null
     and (nullif(to_jsonb(u)->>'banned_until','')::timestamptz is null or (to_jsonb(u)->>'banned_until')::timestamptz<=clock_timestamp())) then
   raise exception 'Connection expired or revoked' using errcode='28000';
  end if;
  update delivery_private.tokens set last_used_at=clock_timestamp() where id=token_id;
 end if;
 if p.lifecycle<>'active' and operation not in ('tokens','revoke_token') then raise exception 'Restore this project before building' using errcode='22023'; end if;
 if operation in ('tokens','create_token','revoke_token') then
  if actor_kind<>'owner' then raise exception 'Owner access required' using errcode='42501'; end if;
  if operation='create_token' then
   if (select count(*) from delivery_private.tokens where project_id=pid and revoked_at is null and expires_at>clock_timestamp())>=20 then
    raise exception 'Revoke an existing connection before creating another' using errcode='22023';
   end if;
   if (c->>'tokenExpiresAt')::timestamptz<=clock_timestamp() or (c->>'tokenExpiresAt')::timestamptz>clock_timestamp()+interval '90 days 1 minute' then
    raise exception 'Invalid token expiry' using errcode='22023';
   end if;
   insert into delivery_private.tokens(id,project_id,owner_id,name,token_hash,expires_at)
   values((c->>'tokenId')::uuid,pid,actor_id,c->>'name',c->>'tokenHash',(c->>'tokenExpiresAt')::timestamptz)
   returning * into capability;
  elsif operation='revoke_token' then
   update delivery_private.tokens set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=(c->>'tokenId')::uuid and project_id=pid returning * into capability;
   if capability.id is null then raise exception 'Connection not found' using errcode='P0002'; end if;
  end if;
  if operation='tokens' then
   return coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'createdAt',t.created_at,'expiresAt',t.expires_at,'revokedAt',t.revoked_at,'lastUsedAt',t.last_used_at) order by t.created_at desc)
    from delivery_private.tokens t where t.project_id=pid),'[]'::jsonb);
  end if;
  return jsonb_build_object('id',capability.id,'name',capability.name,'createdAt',capability.created_at,'expiresAt',capability.expires_at,'revokedAt',capability.revoked_at,'lastUsedAt',capability.last_used_at);
 end if;
 if operation not in ('read','write') then raise exception 'Invalid delivery operation' using errcode='22023'; end if;
 if c ? 'command' then
  if actor_kind='agent' and not(c->'command' ? 'projectId') then
   c:=jsonb_set(c,'{command,projectId}',to_jsonb(pid::text));
  end if;
  if c->'command'->>'projectId' is distinct from pid::text then raise exception 'Project scope mismatch' using errcode='42501'; end if;
  if actor_kind='agent' and c->'command'->'action'->>'type' not in ('report_outcome','connect_repository') then
   raise exception 'Agents can only connect repositories or report evidence' using errcode='42501';
  end if;
  select * into receipt from delivery_private.receipts where project_id=pid and id=(c->'command'->>'id')::uuid;
  if receipt.id is not null then
   if receipt.request is distinct from c->'command' or receipt.actor<>actor_kind or receipt.token_id is distinct from token_id then
    raise exception 'Retry key reused with different command' using errcode='PT409';
   end if;
   -- A retry acknowledges the original write, while preserving later updates.
   return jsonb_build_object('state',coalesce((select state from delivery_private.states where project_id=pid),receipt.result),'replayed',true);
  end if;
 end if;
 select state into current_state from delivery_private.states where project_id=pid;
 current_state:=coalesce(current_state,'{"version":1,"revision":0,"repository":null,"scopes":[],"reports":[],"reviews":[]}'::jsonb);
 if operation='read' then
  -- The reducer needs authored thoughts and governing context, never chat history
  -- or the source Idea document. Keep them out of the integration transport.
  return jsonb_build_object('project',jsonb_set(
    public.project_snapshot(pid)-'ideaDocument'-'ideaQuestions'-'originalIdea'-'references',
    '{thinking}',jsonb_build_object('relations',coalesce(p.thinking->'relations','[]'::jsonb))),
    'state',current_state,'replayed',false);
 end if;
 if not(c ? 'command') or jsonb_typeof(c->'state') is distinct from 'object' then raise exception 'Invalid delivery state' using errcode='22023'; end if;
 if (c->'command'->>'expectedRevision')::integer is distinct from (current_state->>'revision')::integer
  or (c->>'projectRevision')::integer is distinct from p.revision then
  raise exception 'Delivery or plan changed; reload before trying again' using errcode='PT409';
 end if;
 if (c->'state'->>'revision')::integer is distinct from (current_state->>'revision')::integer+1 or c->'state'->>'version' is distinct from '1' then
  raise exception 'Invalid delivery revision' using errcode='22023';
 end if;
 result:=c->'state';
 insert into delivery_private.states(project_id,state) values(pid,result)
 on conflict(project_id) do update set state=excluded.state,updated_at=clock_timestamp();
 insert into delivery_private.receipts(project_id,id,request,actor,token_id,result)
 values(pid,(c->'command'->>'id')::uuid,c->'command',actor_kind,token_id,result);
 return jsonb_build_object('state',result,'replayed',false);
end; $$;
revoke all on function delivery_private.exchange(text,text) from public;
grant execute on function delivery_private.exchange(text,text) to anon,authenticated;
create function public.project_delivery_exchange(payload text,signature text) returns jsonb
language sql security invoker set search_path='' as $$ select delivery_private.exchange(payload,signature); $$;
revoke all on function public.project_delivery_exchange(text,text) from public;
grant execute on function public.project_delivery_exchange(text,text) to anon,authenticated;
