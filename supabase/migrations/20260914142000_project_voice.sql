-- Bounded GPT-Live voice sessions. Voice shares the existing prepaid wallet and
-- per-account guidance allowance with Ideas and project planning. Nothing in
-- this migration grants funding or enables the feature by default.

-- Keep transcript validation in the database because settlement is a server
-- capability, not a browser operation. The controller applies the same limits
-- before it sends a transcript, while this check protects the durable record
-- if a signed worker request is malformed.
create function account_private.valid_project_voice_transcript(value jsonb) returns boolean
language sql immutable strict set search_path='' as $$
 select case when jsonb_typeof(value)<>'array' then false else
   jsonb_array_length(value)<=120
   and coalesce((select sum(char_length(coalesce(x->>'text',''))) from jsonb_array_elements(value) x),0)<=24000
   and not exists(
     select 1 from jsonb_array_elements(value) x
     where jsonb_typeof(x)<>'object'
       or coalesce(x->>'speaker','') not in ('user','assistant')
       or coalesce(x->>'text','')=''
       or char_length(coalesce(x->>'text',''))>4000
       or coalesce(x->>'startMs','') !~ '^[0-9]{1,12}$'
       or coalesce(x->>'endMs','') !~ '^[0-9]{1,12}$'
       or case when x->>'startMs' ~ '^[0-9]{1,12}$' then (x->>'startMs')::bigint else -1 end
          > case when x->>'endMs' ~ '^[0-9]{1,12}$' then (x->>'endMs')::bigint else -1 end
   ) end;
$$;
revoke all on function account_private.valid_project_voice_transcript(jsonb) from public,anon,authenticated;

create table account_private.project_voice_sessions (
 id uuid primary key,
 owner_id uuid references auth.users(id) on delete set null,
 project_id uuid references planning.projects(id) on delete set null,
 conversation_id text not null check(char_length(conversation_id) between 1 and 80),
 revision integer not null check(revision>=0),
 fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
 status text not null check(status in ('reserved','running','closing','completed','failed','unknown','cancelled')),
 model text not null check(model='gpt-live-1'),
 max_duration_seconds integer not null check(max_duration_seconds=60),
 reserve_microusd bigint not null check(reserve_microusd=62500),
 actual_microusd bigint check(actual_microusd>=0),
 capability_hash text not null check(capability_hash ~ '^[0-9a-f]{64}$'),
 attempt_id uuid,
 provider_session_id text,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 started_at timestamptz,
 closed_at timestamptz,
 settled_at timestamptz,
 finish_hash text,
 final_reason text,
 usage jsonb,
 transcript jsonb not null default '[]'::jsonb check(account_private.valid_project_voice_transcript(transcript)),
 error_code text
);
-- A fingerprint describes the immutable context of one run. It is deliberately
-- not unique: a new explicit run on the same project/revision gets a new client
-- runId. The client runId is the idempotency key for retries of that run.
create index project_voice_sessions_fingerprint
 on account_private.project_voice_sessions(owner_id,fingerprint,created_at desc);
create unique index project_voice_sessions_provider
 on account_private.project_voice_sessions(provider_session_id)
 where provider_session_id is not null;
create index project_voice_sessions_project
 on account_private.project_voice_sessions(project_id,created_at desc);
create index project_voice_sessions_expiry
 on account_private.project_voice_sessions(status,expires_at)
 where status='reserved';
alter table account_private.project_voice_sessions enable row level security;
revoke all on account_private.project_voice_sessions from public,anon,authenticated;

-- Only server code knows the action secret. Authenticated RPCs use the
-- caller-bound prefix; settlement uses a separate server-only prefix and is
-- intentionally callable after the bearer session has expired.
create function account_private.project_voice_signature(payload text,signature text,prefix text) returns void
language plpgsql security definer set search_path='' as $$
declare secret_value text; expected bytea; supplied bytea; difference integer:=0; n integer;
begin
 if payload is null or octet_length(payload)>120000 or signature is null or signature !~ '^[0-9a-f]{64}$' then
  raise exception 'Invalid voice signature' using errcode='42501';
 end if;
 select secret into secret_value from account_private.action_secrets where purpose='account_deletion';
 if secret_value is null then raise exception 'Voice unavailable' using errcode='42501'; end if;
 expected:=extensions.hmac(convert_to(prefix||payload,'UTF8'),convert_to(secret_value,'UTF8'),'sha256');
 supplied:=decode(signature,'hex');
 for n in 0..31 loop difference:=difference | (get_byte(expected,n) # get_byte(supplied,n)); end loop;
 if difference<>0 then raise exception 'Invalid voice signature' using errcode='42501'; end if;
end; $$;
revoke all on function account_private.project_voice_signature(text,text,text) from public,anon,authenticated;

-- A reservation is safe to release only while it has no provider session ID.
-- Once a provider ID exists, a worker/DO must close it and settle as unknown;
-- SQL must never silently release that hold merely because a worker vanished.
create function account_private.reconcile_project_voice_reservations() returns void
language plpgsql security definer set search_path='' as $$
declare candidate record; run account_private.project_voice_sessions;
begin
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 for candidate in
   select id,owner_id from account_private.project_voice_sessions
   where status='reserved' and expires_at<=clock_timestamp()
   order by expires_at,id limit 100
 loop
  if candidate.owner_id is not null then
   perform 1 from account_private.guidance_allowances where owner_id=candidate.owner_id for update;
  end if;
  select * into run from account_private.project_voice_sessions where id=candidate.id for update;
  if run.id is null or run.status<>'reserved' or run.expires_at>clock_timestamp() then continue; end if;
  if run.provider_session_id is not null then
   update account_private.project_voice_sessions
    set status='unknown',error_code=coalesce(error_code,'provider_created_before_claim')
    where id=run.id;
   continue;
  end if;
  update account_private.project_voice_sessions
   set status='cancelled',actual_microusd=0,closed_at=clock_timestamp(),settled_at=clock_timestamp(),final_reason='expired_before_provider'
   where id=run.id;
  update account_private.guidance_wallet
   set reserved_microusd=reserved_microusd-run.reserve_microusd where id='openai';
  if run.owner_id is not null then
   update account_private.guidance_allowances
    set reserved_microusd=reserved_microusd-run.reserve_microusd where owner_id=run.owner_id;
  end if;
 end loop;
end; $$;
revoke all on function account_private.reconcile_project_voice_reservations() from public,anon,authenticated;

create function public.project_voice_start(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; run account_private.project_voice_sessions;
 wallet account_private.guidance_wallet; allowance account_private.guidance_allowances; p planning.projects;
 amount bigint; expires timestamptz;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.v1:'||actor::text||':');
 c:=payload::jsonb;
 if c->>'action' is distinct from 'reserve' or (c->>'runId')::uuid is null or (c->>'projectId')::uuid is null
  or (c->>'revision')::integer is null or (c->>'maxDurationSeconds')::integer<>60
  or c->>'model' is distinct from 'gpt-live-1' or (c->>'reserveMicrousd')::bigint<>62500
  or coalesce(c->>'fingerprint','') !~ '^[0-9a-f]{64}$' or coalesce(c->>'capabilityHash','') !~ '^[0-9a-f]{64}$'
  or coalesce(c->>'conversationId','') !~ '^[A-Za-z0-9_-]{1,80}$' then
  raise exception 'Invalid voice admission' using errcode='22023';
 end if;
 -- The wallet is the first lock for every voice/planning/Ideas reservation.
 -- Reconcile only unstarted voice reservations while holding that lock.
 perform account_private.reconcile_project_voice_reservations();
 select * into wallet from account_private.guidance_wallet where id='openai' for update;
 select * into allowance from account_private.guidance_allowances where owner_id=actor for update;
 if allowance.owner_id is null or wallet.id is null or not wallet.enabled then raise exception 'Voice unavailable' using errcode='42501'; end if;
 -- runId is the client idempotency key. All context and capability fields are
 -- immutable for that run, so a lost response can safely replay this branch.
 select * into run from account_private.project_voice_sessions where id=(c->>'runId')::uuid for update;
 if run.id is not null then
 if run.owner_id is distinct from actor
   or run.project_id is distinct from (c->>'projectId')::uuid
   or run.conversation_id is distinct from c->>'conversationId'
   or run.revision is distinct from (c->>'revision')::integer
   or run.fingerprint is distinct from c->>'fingerprint'
   or run.model is distinct from c->>'model'
   or run.max_duration_seconds is distinct from (c->>'maxDurationSeconds')::integer
   or run.reserve_microusd is distinct from (c->>'reserveMicrousd')::bigint
   or run.capability_hash is distinct from c->>'capabilityHash' then
   raise exception 'Voice run conflict' using errcode='PT409';
  end if;
  return jsonb_build_object('runId',run.id,'status',run.status,'created',false,'replayed',true,'expiresAt',floor(extract(epoch from run.expires_at)*1000),'providerSessionId',run.provider_session_id);
 end if;
 select * into p from planning.projects where id=(c->>'projectId')::uuid and owner_id=actor for update;
 if p.id is null or p.lifecycle<>'active' then raise exception 'Project unavailable' using errcode='P0002'; end if;
 if p.revision is distinct from (c->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if c->>'conversationId'<>'main' and not exists(
   select 1 from jsonb_array_elements(coalesce(p.thinking->'conversations','[]'::jsonb)) x
   where x->>'id'=c->>'conversationId' and coalesce(x->>'archived','false')<>'true'
 ) then raise exception 'Conversation unavailable' using errcode='P0002'; end if;
 if exists(select 1 from account_private.project_voice_sessions where project_id=p.id and status in ('reserved','running','closing','unknown')) then
  raise exception 'A voice session is still being reconciled' using errcode='PT425';
 end if;
 amount:=(c->>'reserveMicrousd')::bigint;
 if wallet.spent_microusd+wallet.reserved_microusd+amount>wallet.budget_microusd
  or allowance.spent_microusd+allowance.reserved_microusd+amount>allowance.budget_microusd
  or allowance.used_requests>=allowance.max_requests then raise exception 'Voice allowance reached' using errcode='PT429'; end if;
 expires:=clock_timestamp()+interval '60 seconds';
 update account_private.guidance_wallet set reserved_microusd=reserved_microusd+amount where id='openai';
 update account_private.guidance_allowances set reserved_microusd=reserved_microusd+amount,used_requests=used_requests+1,last_requested_at=clock_timestamp() where owner_id=actor;
 insert into account_private.project_voice_sessions(id,owner_id,project_id,conversation_id,revision,fingerprint,status,model,max_duration_seconds,reserve_microusd,capability_hash,expires_at)
 values((c->>'runId')::uuid,actor,p.id,c->>'conversationId',(c->>'revision')::integer,c->>'fingerprint','reserved','gpt-live-1',60,amount,c->>'capabilityHash',expires);
 return jsonb_build_object('runId',c->>'runId','status','reserved','created',true,'replayed',false,'expiresAt',floor(extract(epoch from expires)*1000));
end; $$;
revoke all on function public.project_voice_start(text,text) from public,anon;
grant execute on function public.project_voice_start(text,text) to authenticated;

create function public.project_voice_claim(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; run account_private.project_voice_sessions;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.v1:'||actor::text||':'); c:=payload::jsonb;
 if coalesce(c->>'providerSessionId','')='' or char_length(c->>'providerSessionId')>200 or coalesce(c->>'attemptId','') !~ '^[0-9a-f-]{36}$' then raise exception 'Invalid voice claim' using errcode='22023'; end if;
 select * into run from account_private.project_voice_sessions where id=(c->>'runId')::uuid and owner_id=actor for update;
 if run.id is null then raise exception 'Voice run unavailable' using errcode='P0002'; end if;
 if (c->>'projectId')::uuid is distinct from run.project_id or (c->>'revision')::integer is distinct from run.revision then
  raise exception 'Revision conflict' using errcode='PT409';
 end if;
 if run.capability_hash is distinct from encode(extensions.digest(c->>'capability','sha256'),'hex') then raise exception 'Voice capability mismatch' using errcode='42501'; end if;
 if run.status='running' and run.attempt_id=(c->>'attemptId')::uuid and run.provider_session_id=c->>'providerSessionId' then
  return jsonb_build_object('claimed',true,'runId',run.id,'status',run.status,'expiresAt',floor(extract(epoch from run.expires_at)*1000));
 end if;
 if run.status<>'reserved' then raise exception 'Voice admission is no longer claimable' using errcode='PT425'; end if;
 if run.expires_at<=clock_timestamp() then
  -- Persist the external ID before rejecting the late claim. The caller/DO can
  -- still close it, while the reservation remains an explicit unknown hold.
  update account_private.project_voice_sessions set status='unknown',attempt_id=(c->>'attemptId')::uuid,provider_session_id=c->>'providerSessionId',error_code='provider_claim_after_expiry' where id=run.id;
  return jsonb_build_object('claimed',false,'runId',run.id,'status','unknown','expiresAt',floor(extract(epoch from run.expires_at)*1000),'providerSessionId',c->>'providerSessionId');
 end if;
 update account_private.project_voice_sessions set status='running',attempt_id=(c->>'attemptId')::uuid,provider_session_id=c->>'providerSessionId',started_at=clock_timestamp() where id=run.id;
 return jsonb_build_object('claimed',true,'runId',run.id,'status','running','expiresAt',floor(extract(epoch from run.expires_at)*1000));
end; $$;
revoke all on function public.project_voice_claim(text,text) from public,anon;
grant execute on function public.project_voice_claim(text,text) to authenticated;

create function public.project_voice_stop(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; run account_private.project_voice_sessions; wallet account_private.guidance_wallet; allowance account_private.guidance_allowances;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.v1:'||actor::text||':'); c:=payload::jsonb;
 select * into run from account_private.project_voice_sessions where id=(c->>'runId')::uuid and owner_id=actor;
 if run.id is null then raise exception 'Voice run unavailable' using errcode='P0002'; end if;
 select * into wallet from account_private.guidance_wallet where id='openai' for update;
 select * into allowance from account_private.guidance_allowances where owner_id=actor for update;
 select * into run from account_private.project_voice_sessions where id=(c->>'runId')::uuid and owner_id=actor for update;
 if run.id is null then raise exception 'Voice run unavailable' using errcode='P0002'; end if;
 if (c->>'projectId')::uuid is distinct from run.project_id or (c->>'revision')::integer is distinct from run.revision then
  raise exception 'Revision conflict' using errcode='PT409';
 end if;
 if run.status='reserved' and run.provider_session_id is null then
  if wallet.id is null or allowance.owner_id is null or wallet.reserved_microusd<run.reserve_microusd or allowance.reserved_microusd<run.reserve_microusd then raise exception 'Voice accounting unavailable' using errcode='42501'; end if;
  update account_private.guidance_wallet set reserved_microusd=reserved_microusd-run.reserve_microusd where id='openai';
  update account_private.guidance_allowances set reserved_microusd=reserved_microusd-run.reserve_microusd where owner_id=actor;
  update account_private.project_voice_sessions set status='cancelled',actual_microusd=0,closed_at=clock_timestamp(),settled_at=clock_timestamp(),final_reason='stopped_before_provider' where id=run.id;
  return jsonb_build_object('status','cancelled','runId',run.id);
 end if;
 if run.status='reserved' and run.provider_session_id is not null then
  update account_private.project_voice_sessions set status='unknown',error_code='provider_close_required' where id=run.id;
  return jsonb_build_object('status','unknown','runId',run.id,'providerSessionId',run.provider_session_id);
 end if;
 if run.status in ('running','closing','unknown') then
  if run.status='running' then update account_private.project_voice_sessions set status='closing' where id=run.id; end if;
  return jsonb_build_object('status',case when run.status='running' then 'closing' else run.status end,'runId',run.id,'providerSessionId',run.provider_session_id);
 end if;
 return jsonb_build_object('status',run.status,'runId',run.id,'providerSessionId',run.provider_session_id);
end; $$;
revoke all on function public.project_voice_stop(text,text) from public,anon;
grant execute on function public.project_voice_stop(text,text) to authenticated;

create function public.project_voice_status(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; run account_private.project_voice_sessions;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.v1:'||actor::text||':'); c:=payload::jsonb;
 select * into run from account_private.project_voice_sessions where id=(c->>'runId')::uuid and owner_id=actor;
 if run.id is null then return jsonb_build_object('status','idle'); end if;
 if (c->>'projectId')::uuid is distinct from run.project_id or (c->>'revision')::integer is distinct from run.revision then
  raise exception 'Revision conflict' using errcode='PT409';
 end if;
 return jsonb_build_object('status',run.status,'runId',run.id,'providerSessionId',run.provider_session_id,'expiresAt',floor(extract(epoch from run.expires_at)*1000),
  'transcript',run.transcript,
  'durationSeconds',case when coalesce(run.usage->>'seconds','') ~ '^[0-9]+(\\.[0-9]+)?$' then (run.usage->>'seconds')::numeric else null end);
end; $$;
revoke all on function public.project_voice_status(text,text) from public,anon;
grant execute on function public.project_voice_status(text,text) to authenticated;

-- Reopenable voice context is owned by the project account. Return only the
-- bounded app transcript and lifecycle metadata; provider IDs, capabilities,
-- and accounting fields never cross this read boundary. Active sessions stay
-- on the status route so an open Durable Object remains the source of truth.
create function public.project_voice_history(project_id uuid,conversation_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); requested_project_id uuid:=project_id; requested_conversation_id text:=conversation_id;
 project_exists boolean;
 result jsonb;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 if requested_project_id is null or requested_conversation_id is null or requested_conversation_id !~ '^[A-Za-z0-9_-]{1,80}$' then
  raise exception 'Invalid voice history request' using errcode='22023';
 end if;
 select exists(select 1 from planning.projects p where p.id=requested_project_id and p.owner_id=actor) into project_exists;
 if not project_exists then raise exception 'Project unavailable' using errcode='P0002'; end if;
 select jsonb_build_object(
   'projectId',requested_project_id,
   'conversationId',requested_conversation_id,
   'sessions',coalesce((
     select jsonb_agg(jsonb_build_object(
       'runId',recent.id,
       'revision',recent.revision,
       'status',recent.status,
       'model',recent.model,
       'maxDurationSeconds',recent.max_duration_seconds,
       'createdAt',recent.created_at,
       'startedAt',recent.started_at,
       'closedAt',recent.closed_at,
       'settledAt',recent.settled_at,
       'durationSeconds',case when coalesce(recent.usage->>'seconds','') ~ '^[0-9]+([.][0-9]+)?$' then (recent.usage->>'seconds')::numeric else null end,
       'transcript',recent.transcript,
       'finalReason',recent.final_reason,
       'errorCode',recent.error_code
     ) order by recent.created_at)
     from (
       select s.*
       from account_private.project_voice_sessions s
       where s.owner_id=actor
         and s.project_id=requested_project_id
         and s.conversation_id=requested_conversation_id
         and s.status in ('completed','failed','cancelled','unknown')
       order by s.created_at desc
       limit 12
     ) recent
   ),'[]'::jsonb)
 ) into result;
 return result;
end; $$;
revoke all on function public.project_voice_history(uuid,text) from public,anon;
grant execute on function public.project_voice_history(uuid,text) to authenticated;

create function public.settle_project_voice(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 c jsonb; run account_private.project_voice_sessions; wallet account_private.guidance_wallet; allowance account_private.guidance_allowances;
 amount bigint; seconds numeric; usage_seconds numeric; finish_digest text; final_status text; usage_value jsonb;
begin
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.settle.v1:'); c:=payload::jsonb;
 if (c->>'runId')::uuid is null or (c->>'attemptId')::uuid is null or coalesce(c->>'capability','')='' then raise exception 'Invalid voice settlement' using errcode='22023'; end if;
 select * into run from account_private.project_voice_sessions where id=(c->>'runId')::uuid;
 if run.id is null then raise exception 'Voice run unavailable' using errcode='42501'; end if;
 -- Lock order matches every other provider reservation: wallet -> account
 -- allowance -> run. Reselecting the run after the locks prevents two close
 -- notifications from both spending the same reservation.
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 if run.owner_id is not null then perform 1 from account_private.guidance_allowances where owner_id=run.owner_id for update; end if;
 select * into run from account_private.project_voice_sessions where id=run.id for update;
 if run.capability_hash is distinct from encode(extensions.digest(c->>'capability','sha256'),'hex') then raise exception 'Voice run unavailable' using errcode='42501'; end if;
 finish_digest:=encode(extensions.digest(payload,'sha256'),'hex');
 if run.settled_at is not null then
  if run.finish_hash is distinct from finish_digest then raise exception 'Settlement conflict' using errcode='PT409'; end if;
  return jsonb_build_object('settled',true,'status',run.status,'actualMicrousd',run.actual_microusd);
 end if;
 if run.status not in ('reserved','running','closing','unknown') then raise exception 'Unclaimed voice run' using errcode='PT409'; end if;
 if run.attempt_id is not null and run.attempt_id is distinct from (c->>'attemptId')::uuid then raise exception 'Voice attempt mismatch' using errcode='PT409'; end if;
 if c ? 'transcript' and ((c->'transcript') is null or not account_private.valid_project_voice_transcript(c->'transcript')) then raise exception 'Invalid voice transcript' using errcode='22023'; end if;
 usage_value:=case when c->'usage' is null then null else c->'usage' end;
 if usage_value is not null and jsonb_typeof(usage_value)<>'object' then raise exception 'Invalid voice usage' using errcode='22023'; end if;
 if c->>'status'='unknown' then
  if run.attempt_id is null then update account_private.project_voice_sessions set attempt_id=(c->>'attemptId')::uuid where id=run.id; end if;
  update account_private.project_voice_sessions set status='unknown',error_code=left(coalesce(c->>'errorCode','voice_finalization_unconfirmed'),80),usage=coalesce(usage_value,usage),
   transcript=case when c ? 'transcript' then c->'transcript' else transcript end where id=run.id;
  return jsonb_build_object('settled',false,'status','unknown');
 end if;
 final_status:=c->>'status';
 if final_status not in ('completed','failed','cancelled') then raise exception 'Invalid voice settlement status' using errcode='22023'; end if;
 if coalesce(c->>'durationSeconds','') !~ '^[0-9]+(\\.[0-9]+)?$' then raise exception 'Invalid voice duration' using errcode='22023'; end if;
 seconds:=(c->>'durationSeconds')::numeric;
 if seconds<0 or seconds>75 then raise exception 'Voice duration exceeds cap' using errcode='22023'; end if;
 if run.status='reserved' and not (final_status='failed' and run.provider_session_id is null and seconds=0) then raise exception 'Reserved voice run has no final provider outcome' using errcode='PT409'; end if;
 if run.status='unknown' then
  if c->>'providerClosed' is distinct from 'true' then raise exception 'Unknown voice run requires provider close confirmation' using errcode='PT409'; end if;
 end if;
 if run.status in ('running','closing','unknown') then
  if usage_value is null or coalesce(usage_value->>'seconds','') !~ '^[0-9]+(\\.[0-9]+)?$' then raise exception 'Authoritative voice usage is required' using errcode='22023'; end if;
  usage_seconds:=(usage_value->>'seconds')::numeric;
  if usage_seconds<>seconds then raise exception 'Voice usage mismatch' using errcode='22023'; end if;
 end if;
 if run.attempt_id is null then
  update account_private.project_voice_sessions set attempt_id=(c->>'attemptId')::uuid where id=run.id;
 end if;
 amount:=case when run.provider_session_id is null then 0 else ceil(greatest(15,seconds)*50000/60) end;
 if amount>run.reserve_microusd then raise exception 'Voice cost exceeds reservation' using errcode='22023'; end if;
 select * into wallet from account_private.guidance_wallet where id='openai';
 if wallet.id is null or wallet.reserved_microusd<run.reserve_microusd then raise exception 'Voice accounting unavailable' using errcode='42501'; end if;
 if run.owner_id is not null then
  select * into allowance from account_private.guidance_allowances where owner_id=run.owner_id;
  if allowance.owner_id is null or allowance.reserved_microusd<run.reserve_microusd then raise exception 'Voice accounting unavailable' using errcode='42501'; end if;
 end if;
 update account_private.project_voice_sessions set status=final_status,actual_microusd=amount,usage=coalesce(usage_value,jsonb_build_object('seconds',seconds)),
  transcript=case when c ? 'transcript' then c->'transcript' else transcript end,
  closed_at=clock_timestamp(),settled_at=clock_timestamp(),finish_hash=finish_digest,final_reason=left(c->>'reason',80),error_code=left(c->>'errorCode',80) where id=run.id;
 update account_private.guidance_wallet set reserved_microusd=reserved_microusd-run.reserve_microusd,spent_microusd=spent_microusd+amount where id='openai';
 if run.owner_id is not null then update account_private.guidance_allowances set reserved_microusd=reserved_microusd-run.reserve_microusd,spent_microusd=spent_microusd+amount where owner_id=run.owner_id; end if;
 return jsonb_build_object('settled',true,'status',final_status,'actualMicrousd',amount);
end; $$;
revoke all on function public.settle_project_voice(text,text) from public,authenticated;
grant execute on function public.settle_project_voice(text,text) to anon;
