-- One optional, separately metered Luna call after authoritative voice close.
-- Existing receipts are not backfilled. No wallet/allowance is replenished.
alter table account_private.project_voice_sessions add column title_finished boolean not null default true;
alter table account_private.project_voice_sessions alter column title_finished set default false;

create function public.project_voice_title(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c jsonb; voice account_private.project_voice_sessions; run account_private.project_planning_runs;
 wallet account_private.guidance_wallet; allowance account_private.guidance_allowances;
 p planning.projects; chat jsonb; state jsonb; amended jsonb; speech text; proposed text; receipt jsonb;
begin
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.settle.v1:');
 c:=payload::jsonb;
 -- Same wallet -> allowance -> run -> project lock order as existing accounting.
 select * into wallet from account_private.guidance_wallet where id='openai' for update;
 select * into voice from account_private.project_voice_sessions where id=(c->>'runId')::uuid;
 if voice.id is null or voice.capability_hash is distinct from encode(extensions.digest(c->>'capability','sha256'),'hex')
  or voice.attempt_id is distinct from (c->>'attemptId')::uuid then
  raise exception 'Voice unavailable' using errcode='42501';
 end if;
 select * into allowance from account_private.guidance_allowances where owner_id=voice.owner_id for update;
 select * into voice from account_private.project_voice_sessions where id=voice.id for update;
 select * into run from account_private.project_planning_runs where id=voice.id for update;
 if c->>'action'='finish' then
  receipt:=(c->>'settlement')::jsonb;
  if receipt->>'runId' is distinct from voice.id::text or receipt->>'attemptId' is distinct from voice.attempt_id::text
   or receipt->>'capability' is distinct from c->>'capability' or run.id is null then
   raise exception 'Title receipt unavailable' using errcode='42501';
  end if;
  perform public.settle_project_planning(c->>'settlement',c->>'settlementSignature');
  -- A replay settles idempotently but must not apply the title again.
  if voice.title_finished then return '{"finished":true}'::jsonb; end if;
  update account_private.project_voice_sessions set title_finished=true where id=voice.id;
  proposed:=trim(c->>'title');
  if receipt->>'status' is distinct from 'completed' or proposed is null or char_length(proposed) not between 1 and 60 or proposed ~ E'[\r\n]' then
   return '{"finished":true}'::jsonb;
  end if;
  select * into p from planning.projects where id=voice.project_id and owner_id=voice.owner_id for update;
  -- A concurrent rename, manual edit, deletion or text turn wins.
  if p.id is null or p.lifecycle<>'active' or p.revision is distinct from (c->>'revision')::integer then return '{"finished":true}'::jsonb; end if;
  state:=p.thinking;
  select x into chat from jsonb_array_elements(state->'conversations') x where x->>'id'=voice.conversation_id and coalesce(x->>'archived','false')='false';
  if chat is null then return '{"finished":true}'::jsonb; end if;
  select jsonb_agg(case when x->>'id'=voice.conversation_id then x||jsonb_build_object('title',proposed,'updatedAt',clock_timestamp()) else x end order by ord)
   into amended from jsonb_array_elements(state->'conversations') with ordinality a(x,ord);
  state:=jsonb_set(state,'{conversations}',amended);
  if jsonb_typeof(state->'undo')='object' and (state->'undo'->>'revision')::integer=p.revision then
   state:=jsonb_set(state,'{undo,revision}',to_jsonb(p.revision+1));
  end if;
  if not planning.validate_thinking(state) then raise exception 'Invalid thinking' using errcode='22023'; end if;
  update planning.projects set thinking=state,revision=revision+1,updated_at=clock_timestamp() where id=p.id;
  insert into planning.history(project_id,revision,action,context)
   values(p.id,p.revision+1,'planning_update_conversation',jsonb_build_object('conversationId',voice.conversation_id,'voiceRunId',voice.id));
  return '{"finished":true}'::jsonb;
 end if;
 if c->>'action' is distinct from 'prepare' then raise exception 'Invalid title action' using errcode='22023'; end if;
 if voice.title_finished or run.id is not null or voice.status<>'completed' or voice.settled_at is null then return '{"claimed":false}'::jsonb; end if;
 update account_private.project_voice_sessions set title_finished=true where id=voice.id;
 select * into p from planning.projects where id=voice.project_id and owner_id=voice.owner_id for share;
 if p.id is null or p.lifecycle<>'active' then return '{"claimed":false}'::jsonb; end if;
 select x into chat from jsonb_array_elements(p.thinking->'conversations') x where x->>'id'=voice.conversation_id and coalesce(x->>'archived','false')='false';
 if chat is null or not (
  chat->>'title' in ('Main conversation','New conversation') or
  (jsonb_array_length(chat->'agentIds')=1 and exists(select 1 from jsonb_array_elements(p.thinking->'agents') a where a->>'id'=chat->'agentIds'->>0 and a->>'name'=chat->>'title'))
 ) then return '{"claimed":false}'::jsonb; end if;
 if exists(select 1 from jsonb_array_elements(p.thinking->'turns') t where coalesce(t->>'conversationId','main')=voice.conversation_id)
  or exists(select 1 from account_private.project_voice_sessions v join account_private.project_planning_runs r on r.id=v.id where v.project_id=p.id and v.conversation_id=voice.conversation_id)
  then return '{"claimed":false}'::jsonb; end if;
 select left(string_agg(x->>'text',E'\n' order by ord),3000) into speech
  from jsonb_array_elements(voice.transcript) with ordinality a(x,ord) where x->>'speaker'='user';
 if nullif(trim(speech),'') is null then return '{"claimed":false}'::jsonb; end if;
 if wallet.id is null or not wallet.enabled or allowance.owner_id is null
  or wallet.spent_microusd+wallet.reserved_microusd+10000>wallet.budget_microusd
  or allowance.spent_microusd+allowance.reserved_microusd+10000>allowance.budget_microusd
  or (not allowance.testing_request_exempt and allowance.used_requests>=allowance.max_requests)
  or exists(select 1 from account_private.project_planning_runs where project_id=p.id and status in ('reserved','running','unknown'))
  then return '{"claimed":false}'::jsonb; end if;
 update account_private.guidance_wallet set reserved_microusd=reserved_microusd+10000 where id='openai';
 update account_private.guidance_allowances set reserved_microusd=reserved_microusd+10000,used_requests=used_requests+1,last_requested_at=clock_timestamp() where owner_id=voice.owner_id;
 insert into account_private.project_planning_runs(id,owner_id,project_id,turn_id,fingerprint,status,model,max_output_tokens,reserve_microusd,capability_hash,attempt_id,started_at)
  values(voice.id,voice.owner_id,p.id,voice.id,encode(extensions.digest(speech,'sha256'),'hex'),'running','gpt-5.6-luna',128,10000,voice.capability_hash,voice.attempt_id,clock_timestamp());
 update account_private.project_voice_sessions set title_finished=false where id=voice.id;
 return jsonb_build_object('claimed',true,'transcript',speech,'revision',p.revision);
end; $$;
revoke all on function public.project_voice_title(text,text) from public,anon,authenticated;
grant execute on function public.project_voice_title(text,text) to anon,authenticated;

-- Status only observes optional naming; it never starts or retries inference.
-- Bound the UI wait even if the worker dies after claiming an uncertain call.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.project_voice_status(text,text)'::regprocedure);
 if position('''status'',run.status' in definition)=0 then raise exception 'Voice status shape changed'; end if;
 definition:=replace(definition,'''status'',run.status',
  '''titlePending'',run.status=''completed'' and not run.title_finished and run.settled_at>clock_timestamp()-interval ''45 seconds'',''status'',run.status');
 execute definition;
end $$;
