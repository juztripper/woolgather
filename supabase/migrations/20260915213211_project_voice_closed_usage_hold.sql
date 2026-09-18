-- A lost final usage receipt must retain its full monetary hold, but a
-- provider-confirmed closed session must not lock a project out of voice.
-- No historical hold, wallet, or allowance is reset by this migration.

create or replace function public.project_voice_start(payload text,signature text) returns jsonb
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
 if exists(select 1 from account_private.project_voice_sessions where project_id=p.id and (status in ('reserved','running','closing') or (status='unknown' and closed_at is null))) then
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

create or replace function public.project_voice_status(payload text,signature text) returns jsonb
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
  'providerClosed',run.closed_at is not null,'transcript',run.transcript,
  'durationSeconds',case when coalesce(run.usage->>'seconds','') ~ '^[0-9]+([.][0-9]+)?$' then (run.usage->>'seconds')::numeric else null end,
  'actualMicrousd',run.actual_microusd);
end; $$;

create or replace function public.settle_project_voice(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 c jsonb; run account_private.project_voice_sessions; wallet account_private.guidance_wallet; allowance account_private.guidance_allowances;
 amount bigint; seconds numeric; usage_seconds numeric; finish_digest text; final_status text; usage_value jsonb; receipt_provider_id text;
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
 receipt_provider_id:=nullif(c->>'providerSessionId','');
 if receipt_provider_id is not null and char_length(receipt_provider_id)>200 then raise exception 'Invalid provider session' using errcode='22023'; end if;
 if run.provider_session_id is not null and receipt_provider_id is not null and run.provider_session_id is distinct from receipt_provider_id then raise exception 'Voice provider session mismatch' using errcode='PT409'; end if;
 if c->>'status'='unknown' then
  if run.attempt_id is null then run.attempt_id:=(c->>'attemptId')::uuid; end if;
  -- Closing transport and finalizing cost are separate facts. A signed
  -- successful hangup/absent-session receipt may release the active-call
  -- lock, but cannot refund or debit the unresolved monetary reservation.
  if c->>'providerClosed'='true' and (jsonb_typeof(c->'providerClosed')<>'boolean' or coalesce(run.provider_session_id,receipt_provider_id) is null) then
   raise exception 'Voice closure requires a provider session' using errcode='PT409';
  end if;
  update account_private.project_voice_sessions set attempt_id=run.attempt_id,status='unknown',
   provider_session_id=coalesce(run.provider_session_id,receipt_provider_id),
   closed_at=case when c->'providerClosed'='true'::jsonb then coalesce(closed_at,clock_timestamp()) else closed_at end,
   error_code=left(coalesce(c->>'errorCode','voice_finalization_unconfirmed'),80),usage=coalesce(usage_value,usage),
   transcript=case when c ? 'transcript' then c->'transcript' else transcript end where id=run.id;
  return jsonb_build_object('settled',false,'status','unknown','providerClosed',(select closed_at is not null from account_private.project_voice_sessions where id=run.id));
 end if;
 final_status:=c->>'status';
 if final_status not in ('completed','failed','cancelled') then raise exception 'Invalid voice settlement status' using errcode='22023'; end if;
 if coalesce(c->>'durationSeconds','') !~ '^[0-9]+([.][0-9]+)?$' then raise exception 'Invalid voice duration' using errcode='22023'; end if;
 seconds:=(c->>'durationSeconds')::numeric;
 if seconds<0 or seconds>75 then raise exception 'Voice duration exceeds cap' using errcode='22023'; end if;

 -- A reserved run can settle with zero cost only when no provider session was
 -- created.  Any reserved usage requires a signed terminal provider-close
 -- receipt, a provider id, and authoritative final usage.  This is the only
 -- path that binds an external provider id before claim; the terminal update
 -- below changes status atomically so a later claim is rejected.
 if run.status='reserved' then
  if final_status='failed' and run.provider_session_id is null and receipt_provider_id is null and seconds=0 then
   null;
  else
   if final_status not in ('completed','failed') or jsonb_typeof(c->'providerClosed')<>'boolean' or c->>'providerClosed' is distinct from 'true' or receipt_provider_id is null then
    raise exception 'Reserved voice run has no verified provider close' using errcode='PT409';
   end if;
  end if;
 end if;
 if run.status='unknown' then
  if jsonb_typeof(c->'providerClosed')<>'boolean' or c->>'providerClosed' is distinct from 'true' then raise exception 'Unknown voice run requires provider close confirmation' using errcode='PT409'; end if;
  if run.provider_session_id is null and receipt_provider_id is null then raise exception 'Unknown voice run has no provider session' using errcode='PT409'; end if;
 end if;
 if run.status in ('running','closing','unknown') or (run.status='reserved' and receipt_provider_id is not null) then
  if usage_value is null or coalesce(usage_value->>'seconds','') !~ '^[0-9]+([.][0-9]+)?$' then raise exception 'Authoritative voice usage is required' using errcode='22023'; end if;
  usage_seconds:=(usage_value->>'seconds')::numeric;
  if usage_seconds<>seconds then raise exception 'Voice usage mismatch' using errcode='22023'; end if;
 end if;
 if run.attempt_id is null then run.attempt_id:=(c->>'attemptId')::uuid; end if;
 if run.provider_session_id is null and receipt_provider_id is not null then run.provider_session_id:=receipt_provider_id; end if;
 amount:=case when run.provider_session_id is null then 0 else ceil(greatest(15,seconds)*50000/60) end;
 if amount>run.reserve_microusd then raise exception 'Voice cost exceeds reservation' using errcode='22023'; end if;
 select * into wallet from account_private.guidance_wallet where id='openai';
 if wallet.id is null or wallet.reserved_microusd<run.reserve_microusd then raise exception 'Voice accounting unavailable' using errcode='42501'; end if;
 if run.owner_id is not null then
  select * into allowance from account_private.guidance_allowances where owner_id=run.owner_id;
  if allowance.owner_id is null or allowance.reserved_microusd<run.reserve_microusd then raise exception 'Voice accounting unavailable' using errcode='42501'; end if;
 end if;
 update account_private.project_voice_sessions set attempt_id=run.attempt_id,provider_session_id=run.provider_session_id,status=final_status,actual_microusd=amount,usage=coalesce(usage_value,jsonb_build_object('seconds',seconds)),
  transcript=case when c ? 'transcript' then c->'transcript' else transcript end,
  closed_at=clock_timestamp(),settled_at=clock_timestamp(),finish_hash=finish_digest,final_reason=left(c->>'reason',80),error_code=left(c->>'errorCode',80) where id=run.id;
 update account_private.guidance_wallet set reserved_microusd=reserved_microusd-run.reserve_microusd,spent_microusd=spent_microusd+amount where id='openai';
 if run.owner_id is not null then update account_private.guidance_allowances set reserved_microusd=reserved_microusd-run.reserve_microusd,spent_microusd=spent_microusd+amount where owner_id=run.owner_id; end if;
 return jsonb_build_object('settled',true,'status',final_status,'actualMicrousd',amount);
end; $$;

revoke all on function public.project_voice_start(text,text) from public,anon;
grant execute on function public.project_voice_start(text,text) to authenticated;
revoke all on function public.project_voice_status(text,text) from public,anon;
grant execute on function public.project_voice_status(text,text) to authenticated;
revoke all on function public.settle_project_voice(text,text) from public,authenticated;
grant execute on function public.settle_project_voice(text,text) to anon;
