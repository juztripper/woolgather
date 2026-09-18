-- A Durable Object can create a GPT-Live provider session before the
-- authenticated claim RPC reaches Postgres.  In that race the reservation is
-- still `reserved`, but the DO can later deliver a signed terminal
-- `session.closed` receipt with authoritative usage.  Let that receipt bind
-- the provider id and settle exactly once without weakening the unverified
-- unknown path.

create or replace function account_private.reconcile_project_voice_reservations() returns void
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
  -- Once prepare has bound an attempt, the external POST may be in flight even
  -- though SQL has no provider id yet. Keep that reservation unknown rather
  -- than refunding it while a provider session can still be created.
  if run.provider_session_id is not null or run.attempt_id is not null then
   update account_private.project_voice_sessions
    set status='unknown',error_code=coalesce(error_code,case when run.provider_session_id is not null then 'provider_created_before_claim' else 'provider_prepare_expired' end)
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

create or replace function public.project_voice_prepare(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; run account_private.project_voice_sessions; p planning.projects; attempt uuid;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.v1:'||actor::text||':'); c:=payload::jsonb;
 if c->>'action' is distinct from 'prepare' or (c->>'runId')::uuid is null or (c->>'projectId')::uuid is null or (c->>'revision')::integer is null or (c->>'attemptId')::uuid is null or coalesce(c->>'capability','')='' then
  raise exception 'Invalid voice preparation' using errcode='22023';
 end if;
 attempt:=(c->>'attemptId')::uuid;
 select * into run from account_private.project_voice_sessions where id=(c->>'runId')::uuid and owner_id=actor for update;
 if run.id is null then raise exception 'Voice run unavailable' using errcode='P0002'; end if;
 select * into p from planning.projects where id=(c->>'projectId')::uuid and owner_id=actor for update;
 if p.id is null or p.lifecycle<>'active' then raise exception 'Project unavailable' using errcode='P0002'; end if;
 if p.revision is distinct from (c->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if run.project_id is distinct from p.id or run.revision is distinct from p.revision then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if run.capability_hash is distinct from encode(extensions.digest(c->>'capability','sha256'),'hex') then raise exception 'Voice capability mismatch' using errcode='42501'; end if;
 if run.status<>'reserved' then raise exception 'Voice admission is no longer preparable' using errcode='PT425'; end if;
 if run.provider_session_id is not null then raise exception 'Voice provider session is already bound' using errcode='PT425'; end if;
 if run.attempt_id is not null then
  if run.attempt_id is distinct from attempt then raise exception 'Voice attempt mismatch' using errcode='PT409'; end if;
  return jsonb_build_object('prepared',false,'started',false,'replayed',true,'runId',run.id,'status',run.status,'expiresAt',floor(extract(epoch from run.expires_at)*1000));
 end if;
 if run.expires_at<=clock_timestamp() then raise exception 'Voice admission has expired' using errcode='PT425'; end if;
 update account_private.project_voice_sessions set attempt_id=attempt where id=run.id;
 return jsonb_build_object('prepared',true,'started',false,'replayed',false,'runId',run.id,'status','reserved','expiresAt',floor(extract(epoch from run.expires_at)*1000));
end; $$;
revoke all on function public.project_voice_prepare(text,text) from public,anon;
grant execute on function public.project_voice_prepare(text,text) to authenticated;

create or replace function public.project_voice_claim(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; run account_private.project_voice_sessions; attempt uuid;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.v1:'||actor::text||':'); c:=payload::jsonb;
 if coalesce(c->>'providerSessionId','')='' or char_length(c->>'providerSessionId')>200 or coalesce(c->>'attemptId','') !~ '^[0-9a-f-]{36}$' then raise exception 'Invalid voice claim' using errcode='22023'; end if;
 attempt:=(c->>'attemptId')::uuid;
 select * into run from account_private.project_voice_sessions where id=(c->>'runId')::uuid and owner_id=actor for update;
 if run.id is null then raise exception 'Voice run unavailable' using errcode='P0002'; end if;
 if (c->>'projectId')::uuid is distinct from run.project_id or (c->>'revision')::integer is distinct from run.revision then
  raise exception 'Revision conflict' using errcode='PT409';
 end if;
 if run.capability_hash is distinct from encode(extensions.digest(c->>'capability','sha256'),'hex') then raise exception 'Voice capability mismatch' using errcode='42501'; end if;
 -- A prepared reservation owns its attempt marker. A later claim may use that
 -- exact attempt, but it can never replace it with a retry's attempt id.
 if run.attempt_id is not null and run.attempt_id is distinct from attempt then raise exception 'Voice attempt mismatch' using errcode='PT409'; end if;
 if run.status='running' and run.attempt_id=attempt and run.provider_session_id=c->>'providerSessionId' then
  return jsonb_build_object('claimed',true,'runId',run.id,'status',run.status,'expiresAt',floor(extract(epoch from run.expires_at)*1000));
 end if;
 if run.status<>'reserved' then raise exception 'Voice admission is no longer claimable' using errcode='PT425'; end if;
 if run.provider_session_id is not null then raise exception 'Voice provider session is already bound' using errcode='PT425'; end if;
 if run.expires_at<=clock_timestamp() then
  -- Persist the external ID before rejecting the late claim. The caller/DO can
  -- still close it, while the reservation remains an explicit unknown hold.
  update account_private.project_voice_sessions set status='unknown',attempt_id=coalesce(run.attempt_id,attempt),provider_session_id=c->>'providerSessionId',error_code='provider_claim_after_expiry' where id=run.id;
  return jsonb_build_object('claimed',false,'runId',run.id,'status','unknown','expiresAt',floor(extract(epoch from run.expires_at)*1000),'providerSessionId',c->>'providerSessionId');
 end if;
 if run.attempt_id is null then
  update account_private.project_voice_sessions set attempt_id=attempt,provider_session_id=c->>'providerSessionId',status='running',started_at=clock_timestamp() where id=run.id;
 else
  update account_private.project_voice_sessions set provider_session_id=c->>'providerSessionId',status='running',started_at=clock_timestamp() where id=run.id and attempt_id=attempt;
 end if;
 return jsonb_build_object('claimed',true,'runId',run.id,'status','running','expiresAt',floor(extract(epoch from run.expires_at)*1000));
end; $$;
revoke all on function public.project_voice_claim(text,text) from public,anon;
grant execute on function public.project_voice_claim(text,text) to authenticated;

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
  'transcript',run.transcript,
  'durationSeconds',case when coalesce(run.usage->>'seconds','') ~ '^[0-9]+([.][0-9]+)?$' then (run.usage->>'seconds')::numeric else null end,
  'actualMicrousd',run.actual_microusd);
end; $$;
revoke all on function public.project_voice_status(text,text) from public,anon;
grant execute on function public.project_voice_status(text,text) to authenticated;

create or replace function public.project_voice_stop(payload text,signature text) returns jsonb
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
 -- A prepared reservation may already be in the external POST race. Keep its
 -- hold unknown until a signed provider-close receipt arrives; only an
 -- untouched reservation can be cancelled and refunded immediately.
 if run.status='reserved' and run.provider_session_id is null and run.attempt_id is null then
  if wallet.id is null or allowance.owner_id is null or wallet.reserved_microusd<run.reserve_microusd or allowance.reserved_microusd<run.reserve_microusd then raise exception 'Voice accounting unavailable' using errcode='42501'; end if;
  update account_private.guidance_wallet set reserved_microusd=reserved_microusd-run.reserve_microusd where id='openai';
  update account_private.guidance_allowances set reserved_microusd=reserved_microusd-run.reserve_microusd where owner_id=actor;
  update account_private.project_voice_sessions set status='cancelled',actual_microusd=0,closed_at=clock_timestamp(),settled_at=clock_timestamp(),final_reason='stopped_before_provider' where id=run.id;
  return jsonb_build_object('status','cancelled','runId',run.id);
 end if;
 if run.status='reserved' then
  update account_private.project_voice_sessions set status='unknown',error_code=case when run.provider_session_id is not null then 'provider_close_required' else 'voice_stopped_after_prepare' end where id=run.id;
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
  update account_private.project_voice_sessions set attempt_id=run.attempt_id,status='unknown',error_code=left(coalesce(c->>'errorCode','voice_finalization_unconfirmed'),80),usage=coalesce(usage_value,usage),
   transcript=case when c ? 'transcript' then c->'transcript' else transcript end where id=run.id;
  return jsonb_build_object('settled',false,'status','unknown');
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

revoke all on function public.settle_project_voice(text,text) from public,authenticated;
grant execute on function public.settle_project_voice(text,text) to anon;
