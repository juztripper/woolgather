-- A result may be deleted; its incurred cost must remain accountable.
create table account_private.guidance_review_periods (
 id text primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('development','trial','subscription','topup')),
 environment text not null default 'development' check(environment in ('development','test','live')),
 starts_at timestamptz not null default now(), ends_at timestamptz,
 max_reviews integer not null check(max_reviews between 0 and 100000),
 used_reviews integer not null default 0 check(used_reviews>=0),
 reserved_reviews integer not null default 0 check(reserved_reviews>=0),
 check(ends_at is null or ends_at>starts_at)
);
create index guidance_review_periods_owner on account_private.guidance_review_periods(owner_id,ends_at);
create table account_private.guidance_journal (
 id uuid primary key,
 owner_id uuid references auth.users(id) on delete set null,
 period_id text references account_private.guidance_review_periods(id) on delete set null,
 status text not null check(status in ('reserved','running','completed','failed','unknown','cancelled')),
 model text not null,
 revision integer not null,
 reserve_microusd bigint not null check(reserve_microusd>=0),
 actual_microusd bigint check(actual_microusd>=0),
 capability_hash text,
 attempt_id uuid,
 config_version text not null,
 price_version text not null,
 max_output_tokens integer not null default 2000 check(max_output_tokens between 200 and 3000),
 usage jsonb,
 error_code text,
 accounting_anomaly text,
 finish_hash text,
 created_at timestamptz not null default now(),
 started_at timestamptz, settled_at timestamptz
);
create index guidance_journal_owner on account_private.guidance_journal(owner_id);
create index guidance_journal_period on account_private.guidance_journal(period_id);
create index guidance_journal_unresolved on account_private.guidance_journal(created_at) where settled_at is null;
alter table account_private.guidance_runs add column source_key text;
-- Several deliberate attempts may exist, but admission remains serialized by
-- the wallet/owner lock. Unknown attempts always block another paid attempt.
alter table account_private.guidance_runs drop constraint guidance_runs_owner_id_idea_id_fingerprint_key;
create index guidance_runs_lookup on account_private.guidance_runs(owner_id,idea_id,fingerprint,created_at desc);
create table account_private.guidance_feedback (
 owner_id uuid not null references auth.users(id) on delete cascade,
 idea_id uuid not null references planning.ideas(id) on delete cascade,
 question_key text not null,
 question text not null check(length(question) between 1 and 200),
 disposition text not null check(disposition in ('dismissed','kept','answered')),
 updated_at timestamptz not null default now(),
 primary key(owner_id,idea_id,question_key)
);
create index guidance_feedback_idea on account_private.guidance_feedback(idea_id);
insert into account_private.guidance_review_periods(id,owner_id,kind,max_reviews,used_reviews,reserved_reviews)
 select 'development:'||a.owner_id,a.owner_id,'development',a.max_requests,
 (select count(*) from account_private.guidance_runs r where r.owner_id=a.owner_id and r.result is not null),
 (select count(*) from account_private.guidance_runs r where r.owner_id=a.owner_id and r.settled_at is null)
 from account_private.guidance_allowances a;
insert into account_private.guidance_journal(id,owner_id,period_id,status,model,revision,reserve_microusd,actual_microusd,config_version,price_version,usage,created_at,settled_at)
 select r.id,r.owner_id,'development:'||r.owner_id,
 case when r.settled_at is null then 'unknown' when r.result is null then 'failed' else 'completed' end,
 coalesce(r.model,'legacy'),0,r.reserve_microusd,case when r.usage->>'costMicrousd' ~ '^[0-9]{1,12}$' then (r.usage->>'costMicrousd')::bigint end,'legacy','2026-09-10',r.usage,r.created_at,r.settled_at
 from account_private.guidance_runs r;
-- Do not alter the existing dollar wallet or lifetime request counts.
create function account_private.new_guidance_review_period() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into account_private.guidance_review_periods(id,owner_id,kind,max_reviews)
 values('development:'||new.owner_id,new.owner_id,'development',new.max_requests);
 return new;
end; $$;
revoke all on function account_private.new_guidance_review_period() from public,anon,authenticated;
create trigger guidance_allowance_review_period after insert on account_private.guidance_allowances
for each row execute function account_private.new_guidance_review_period();
alter table account_private.guidance_review_periods enable row level security;
alter table account_private.guidance_journal enable row level security;
alter table account_private.guidance_feedback enable row level security;
revoke all on account_private.guidance_review_periods,account_private.guidance_journal,account_private.guidance_feedback from public,anon,authenticated;

create function public.idea_guidance_snapshot(idea_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 select jsonb_build_object('id',id,'body',body,'document',document,'revision',revision,'updatedAt',updated_at,'projectId',project_id,'trashed',trashed,'archived',archived,'folderId',folder_id)
 into result from planning.ideas where id=idea_id and owner_id=auth.uid();
 return result;
end; $$;
revoke all on function public.idea_guidance_snapshot(uuid) from public,anon;
grant execute on function public.idea_guidance_snapshot(uuid) to authenticated;

create function account_private.guidance_run_view(run_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('runId',r.id,'status',j.status,'revision',j.revision,'sourceKey',r.source_key,
 'result',r.result,'errorCode',j.error_code,'createdAt',j.created_at)
 from account_private.guidance_runs r join account_private.guidance_journal j on j.id=r.id
 where r.id=run_id and r.owner_id=auth.uid();
$$;
revoke all on function account_private.guidance_run_view(uuid) from public,anon,authenticated;

-- With the global wallet locked, an unclaimed expired admission is provably
-- unstarted. Started outcomes remain reserved until usage can be reconciled.
create function account_private.reconcile_guidance_runs() returns void
language plpgsql security definer set search_path='' as $$
declare run account_private.guidance_journal;
begin
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 for run in select * from account_private.guidance_journal where status='reserved' and created_at<now()-interval '60 seconds' order by created_at limit 25 loop
  perform 1 from account_private.guidance_allowances where owner_id=run.owner_id for update;
  perform 1 from account_private.guidance_review_periods where id=run.period_id for update;
  update account_private.guidance_journal set status='cancelled',actual_microusd=0,error_code='expired_before_start',settled_at=clock_timestamp() where id=run.id;
  update account_private.guidance_runs set settled_at=clock_timestamp() where id=run.id;
  update account_private.guidance_wallet set reserved_microusd=reserved_microusd-run.reserve_microusd where id='openai';
  update account_private.guidance_allowances set reserved_microusd=reserved_microusd-run.reserve_microusd where owner_id=run.owner_id;
  update account_private.guidance_review_periods set reserved_reviews=reserved_reviews-1 where id=run.period_id;
 end loop;
 update account_private.guidance_journal set status='unknown',error_code=coalesce(error_code,'worker_interrupted')
 where id in (select id from account_private.guidance_journal where status='running' and started_at<now()-interval '90 seconds' order by started_at limit 25);
end; $$;
revoke all on function account_private.reconcile_guidance_runs() from public,anon,authenticated;

create or replace function account_private.idea_guidance_command(payload text, signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); key_value text; expected bytea; supplied bytea; difference integer:=0; i integer;
 command jsonb; allowance account_private.guidance_allowances; wallet account_private.guidance_wallet;
 existing account_private.guidance_runs; journal account_private.guidance_journal;
 idea planning.ideas; period account_private.guidance_review_periods;
 amount bigint; chosen uuid; question_text text; feedback jsonb; balance jsonb;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 if payload is null or octet_length(payload)>64000 or signature is null or signature !~ '^[0-9a-f]{64}$' then raise exception 'Invalid guidance command' using errcode='22023'; end if;
 select secret into key_value from account_private.action_secrets where purpose='account_deletion';
 expected:=extensions.hmac(convert_to('woolgather.guidance.v1:'||actor::text||':'||payload,'UTF8'),convert_to(key_value,'UTF8'),'sha256');
 if expected is null then raise exception 'Guidance unavailable' using errcode='42501'; end if;
 supplied:=decode(signature,'hex');
 for i in 0..31 loop difference:=difference | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
 if difference<>0 then raise exception 'Invalid guidance signature' using errcode='42501'; end if;
 command:=payload::jsonb;
 -- Lock order is the same for admission, cancellation, and settlement.
 perform account_private.reconcile_guidance_runs();
 select * into wallet from account_private.guidance_wallet where id='openai' for update;
 select * into allowance from account_private.guidance_allowances where owner_id=actor for update;
 if command->>'action'='context' then
  select coalesce(jsonb_agg(jsonb_build_object('question',question,'disposition',disposition) order by question_key),'[]'::jsonb)
  into feedback from account_private.guidance_feedback where owner_id=actor and idea_id=(command->>'ideaId')::uuid;
  select jsonb_build_object('remaining',coalesce(sum(greatest(0,max_reviews-used_reviews-reserved_reviews)),0),'reserved',coalesce(sum(reserved_reviews),0),
   'renewsAt',min(ends_at)) into balance from account_private.guidance_review_periods
   where owner_id=actor and environment<>'test' and starts_at<=now() and (ends_at is null or ends_at>now());
  return jsonb_build_object('dispositions',feedback,'allowance',balance);
 end if;
 if command->>'action'='status' then
  if command ? 'runId' then select id into chosen from account_private.guidance_runs where id=(command->>'runId')::uuid and owner_id=actor and idea_id=(command->>'ideaId')::uuid;
  else select id into chosen from account_private.guidance_runs where owner_id=actor and idea_id=(command->>'ideaId')::uuid order by (source_key=command->>'sourceKey') desc nulls last,created_at desc limit 1; end if;
  return coalesce(account_private.guidance_run_view(chosen),'{"status":"idle"}'::jsonb);
 end if;
 if command->>'action'='feedback' then
  select * into existing from account_private.guidance_runs where id=(command->>'runId')::uuid and owner_id=actor;
  if existing.id is null or existing.idea_id is distinct from (command->>'ideaId')::uuid or existing.result->'question' is null or existing.result->'question'='null'::jsonb then raise exception 'Question unavailable' using errcode='P0002'; end if;
  question_text:=existing.result->'question'->>'text';
  insert into account_private.guidance_feedback(owner_id,idea_id,question_key,question,disposition)
   values(actor,existing.idea_id,md5(lower(regexp_replace(trim(question_text),'\s+',' ','g'))),question_text,command->>'disposition')
   on conflict(owner_id,idea_id,question_key) do update set disposition=excluded.disposition,updated_at=now();
  return '{}'::jsonb;
 end if;
 if command->>'action'='claim' then
  select * into journal from account_private.guidance_journal where id=(command->>'runId')::uuid and owner_id=actor for update;
  if journal.id is null then raise exception 'Run unavailable' using errcode='P0002'; end if;
  if journal.status='running' and journal.attempt_id=(command->>'attemptId')::uuid then return '{"claimed":true}'::jsonb; end if;
  if journal.status<>'reserved' or journal.created_at<now()-interval '60 seconds' then return '{"claimed":false}'::jsonb; end if;
  update account_private.guidance_journal set status='running',started_at=clock_timestamp(),attempt_id=(command->>'attemptId')::uuid where id=journal.id;
  return '{"claimed":true}'::jsonb;
 end if;
 if command->>'action'<>'reserve' then raise exception 'Invalid guidance action' using errcode='22023'; end if;
 -- Retrying a lost admission acknowledgement returns precisely that admission.
 select * into existing from account_private.guidance_runs where id=(command->>'runId')::uuid and owner_id=actor;
 if existing.id is not null then
  if existing.fingerprint<>command->>'fingerprint' or existing.idea_id<>(command->>'ideaId')::uuid then raise exception 'Run conflict' using errcode='PT409'; end if;
  return account_private.guidance_run_view(existing.id)||jsonb_build_object('reserved',(select status='reserved' from account_private.guidance_journal where id=existing.id));
 end if;
 select * into idea from planning.ideas where id=(command->>'ideaId')::uuid and owner_id=actor for share;
 if idea.id is null or idea.trashed or idea.archived or idea.project_id is not null then raise exception 'Idea unavailable' using errcode='P0002'; end if;
 if idea.revision is distinct from (command->>'revision')::integer then raise exception 'Idea changed' using errcode='PT409'; end if;
 select r.* into existing from account_private.guidance_runs r join account_private.guidance_journal j on j.id=r.id
 where r.owner_id=actor and r.idea_id=idea.id and j.status in ('reserved','running','unknown') order by r.created_at desc limit 1;
 if existing.id is not null then return account_private.guidance_run_view(existing.id)||'{"reserved":false}'::jsonb; end if;
 select * into existing from account_private.guidance_runs where owner_id=actor and idea_id=idea.id and fingerprint=command->>'fingerprint' order by created_at desc limit 1;
 if existing.id is not null then
  select * into journal from account_private.guidance_journal where id=existing.id;
  if journal.status not in ('failed','cancelled') or (command->>'retryRunId') is distinct from existing.id::text then
   return account_private.guidance_run_view(existing.id)||'{"reserved":false}'::jsonb;
  end if;
 end if;
 amount:=(command->>'reserveMicrousd')::bigint;
 if amount is null or amount<=0 or amount>2000000 or coalesce(command->>'model','') not in ('gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-6-astra')
  or coalesce(command->>'capabilityHash','') !~ '^[0-9a-f]{64}$' or coalesce(command->>'sourceKey','') !~ '^[0-9a-f]{64}$'
  or coalesce(command->>'priceVersion','')<>'2026-09-11' or coalesce(command->>'configVersion','')<>'focused-review-v3'
  or coalesce((command->>'maxOutputTokens')::integer,0) not between 200 and 3000 then raise exception 'Invalid reservation' using errcode='22023'; end if;
 if allowance.owner_id is null then raise exception 'Guidance unavailable' using errcode='42501'; end if;
 if wallet.id is null or not wallet.enabled or wallet.spent_microusd+wallet.reserved_microusd+amount>wallet.budget_microusd
  or allowance.spent_microusd+allowance.reserved_microusd+amount>allowance.budget_microusd
  or allowance.used_requests>=allowance.max_requests then raise exception 'Guidance allowance reached' using errcode='PT429'; end if;
 if allowance.last_requested_at>clock_timestamp()-interval '15 seconds' then raise exception 'Guidance busy' using errcode='PT425'; end if;
 select * into period from account_private.guidance_review_periods where owner_id=actor and environment<>'test' and starts_at<=now() and (ends_at is null or ends_at>now())
  and used_reviews+reserved_reviews<max_reviews order by ends_at nulls last,id limit 1 for update;
 if period.id is null then raise exception 'Review allowance reached' using errcode='PT429'; end if;
 update account_private.guidance_wallet set reserved_microusd=reserved_microusd+amount where id='openai';
 update account_private.guidance_allowances set used_requests=used_requests+1,reserved_microusd=reserved_microusd+amount,last_requested_at=clock_timestamp() where owner_id=actor;
 update account_private.guidance_review_periods set reserved_reviews=reserved_reviews+1 where id=period.id;
 insert into account_private.guidance_runs(id,owner_id,idea_id,fingerprint,source_key,model,reserve_microusd)
 values((command->>'runId')::uuid,actor,idea.id,command->>'fingerprint',command->>'sourceKey',command->>'model',amount);
 insert into account_private.guidance_journal(id,owner_id,period_id,status,model,revision,reserve_microusd,capability_hash,config_version,price_version,max_output_tokens)
 values((command->>'runId')::uuid,actor,period.id,'reserved',command->>'model',idea.revision,amount,command->>'capabilityHash',command->>'configVersion',command->>'priceVersion',(command->>'maxOutputTokens')::integer);
 return account_private.guidance_run_view((command->>'runId')::uuid)||'{"reserved":true}'::jsonb;
end; $$;

-- A narrowly scoped signed capability settles an already admitted run. It is
-- callable with the publishable key after the user's session/account disappears.
-- It grants no read access or ability to admit work; no service-role key needed.
create function account_private.settle_idea_guidance(payload text, signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare key_value text; expected bytea; supplied bytea; difference integer:=0; i integer; command jsonb;
 journal account_private.guidance_journal; amount bigint; usage_value jsonb; digest text; target_status text;
 p_input numeric; p_cached numeric; p_write numeric; p_output numeric; multiplier numeric;
begin
 if payload is null or octet_length(payload)>64000 or signature is null or signature !~ '^[0-9a-f]{64}$' then raise exception 'Invalid settlement' using errcode='22023'; end if;
 select secret into key_value from account_private.action_secrets where purpose='account_deletion';
 expected:=extensions.hmac(convert_to('woolgather.guidance.settle.v1:'||payload,'UTF8'),convert_to(key_value,'UTF8'),'sha256');
 if expected is null then raise exception 'Settlement unavailable' using errcode='42501'; end if;
 supplied:=decode(signature,'hex');
 for i in 0..31 loop difference:=difference | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
 if difference<>0 then raise exception 'Invalid signature' using errcode='42501'; end if;
 command:=payload::jsonb;
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 select * into journal from account_private.guidance_journal where id=(command->>'runId')::uuid;
 if journal.id is null or journal.capability_hash is distinct from encode(extensions.digest(command->>'capability','sha256'),'hex') then raise exception 'Run unavailable' using errcode='42501'; end if;
 perform 1 from account_private.guidance_allowances where owner_id=journal.owner_id for update;
 perform 1 from account_private.guidance_review_periods where id=journal.period_id for update;
 select * into journal from account_private.guidance_journal where id=journal.id for update;
 digest:=encode(extensions.digest(payload,'sha256'),'hex');
 if journal.settled_at is not null then
  if journal.finish_hash is distinct from digest then raise exception 'Settlement conflict' using errcode='PT409'; end if;
  return '{"settled":true}'::jsonb;
 end if;
 if command->>'status'='unknown' then
  if journal.status not in ('running','unknown') or journal.attempt_id is distinct from (command->>'attemptId')::uuid then raise exception 'Unclaimed run' using errcode='PT409'; end if;
  update account_private.guidance_journal set status='unknown',error_code=left(coalesce(command->>'errorCode','outcome_unknown'),80) where id=journal.id;
  return '{"settled":false}'::jsonb;
 end if;
 if command->>'status'='cancelled' then
  if journal.status<>'reserved' then raise exception 'A started run cannot be refunded' using errcode='PT409'; end if;
  amount:=0; target_status:='cancelled';
 else
  if coalesce(command->>'status','') not in ('completed','failed') then raise exception 'Invalid settlement status' using errcode='22023'; end if;
  if journal.status not in ('running','unknown') or journal.attempt_id is distinct from (command->>'attemptId')::uuid then raise exception 'Unclaimed run' using errcode='PT409'; end if;
  usage_value:=command->'usage';
  if usage_value->>'model' is distinct from journal.model or usage_value->>'priceVersion' is distinct from journal.price_version
   or coalesce(usage_value->>'serviceTier','') not in ('default','flex') then raise exception 'Invalid usage' using errcode='22023'; end if;
  foreach key_value in array array['inputTokens','cachedTokens','cacheWriteTokens','outputTokens','reasoningTokens','costMicrousd','latencyMs'] loop
   if coalesce(usage_value->>key_value,'') !~ '^[0-9]+$' or (usage_value->>key_value)::numeric>100000000 then raise exception 'Invalid usage count' using errcode='22023'; end if;
  end loop;
  if (usage_value->>'cachedTokens')::bigint+(usage_value->>'cacheWriteTokens')::bigint>(usage_value->>'inputTokens')::bigint
   or (usage_value->>'reasoningTokens')::bigint>(usage_value->>'outputTokens')::bigint then raise exception 'Invalid usage totals' using errcode='22023'; end if;
  case journal.model
   when 'gpt-5.6-sol' then p_input:=4;p_cached:=0.4;p_write:=5;p_output:=20;
   when 'gpt-5.6-terra' then p_input:=2;p_cached:=0.2;p_write:=2.5;p_output:=12;
   when 'gpt-5.6-luna' then p_input:=0.2;p_cached:=0.02;p_write:=0.25;p_output:=1.2;
   when 'gpt-6-astra' then p_input:=10;p_cached:=1;p_write:=12.5;p_output:=50;
   else raise exception 'Unpriced model' using errcode='22023';
  end case;
  multiplier:=case when usage_value->>'serviceTier'='flex' then 0.5 else 1 end;
  amount:=ceil((((usage_value->>'inputTokens')::numeric-(usage_value->>'cachedTokens')::numeric-(usage_value->>'cacheWriteTokens')::numeric)*p_input
   +(usage_value->>'cachedTokens')::numeric*p_cached+(usage_value->>'cacheWriteTokens')::numeric*p_write+(usage_value->>'outputTokens')::numeric*p_output)*multiplier);
  target_status:=case when command->'result' is null or command->'result'='null'::jsonb then 'failed' else 'completed' end;
 end if;
 update account_private.guidance_journal set status=target_status,actual_microusd=amount,usage=usage_value,settled_at=clock_timestamp(),finish_hash=digest,
  error_code=left(command->>'errorCode',80),accounting_anomaly=case when amount<>(usage_value->>'costMicrousd')::bigint then 'adapter_cost_mismatch' when (usage_value->>'outputTokens')::bigint>journal.max_output_tokens then 'output_limit_exceeded' when amount>journal.reserve_microusd then 'reservation_exceeded' end where id=journal.id;
 update account_private.guidance_runs set result=case when target_status='completed' then command->'result' else null end,usage=usage_value,settled_at=clock_timestamp() where id=journal.id;
 update account_private.guidance_wallet set reserved_microusd=reserved_microusd-journal.reserve_microusd,spent_microusd=spent_microusd+amount,
  enabled=enabled and amount<=journal.reserve_microusd and (usage_value is null or (amount=(usage_value->>'costMicrousd')::bigint and (usage_value->>'outputTokens')::bigint<=journal.max_output_tokens)) where id='openai';
 update account_private.guidance_allowances set reserved_microusd=reserved_microusd-journal.reserve_microusd,spent_microusd=spent_microusd+amount where owner_id=journal.owner_id;
 update account_private.guidance_review_periods set reserved_reviews=reserved_reviews-1,used_reviews=used_reviews+case when target_status='completed' then 1 else 0 end where id=journal.period_id;
 return '{"settled":true}'::jsonb;
end; $$;
create function public.settle_idea_guidance(payload text,signature text) returns jsonb
language sql security definer set search_path='' as $$ select account_private.settle_idea_guidance(payload,signature); $$;
revoke all on function account_private.settle_idea_guidance(text,text),public.settle_idea_guidance(text,text) from public,anon,authenticated;
grant execute on function public.settle_idea_guidance(text,text) to anon,authenticated;

-- An answer keeps its question as context without a fixed category.
create or replace function planning.validate_idea_blocks(blocks jsonb, depth integer default 0) returns boolean language plpgsql immutable set search_path='' as $$
declare block jsonb; props jsonb; key text; value jsonb; kind text; allowed text[]; row jsonb; cell jsonb; cprops jsonb; contents jsonb;
begin
 if depth>8 or jsonb_typeof(blocks) is distinct from 'array' or jsonb_array_length(blocks)>1000 then return false; end if;
 for block in select x from jsonb_array_elements(blocks) x loop
  if jsonb_typeof(block) is distinct from 'object' or (block-array['id','type','props','content','children'])<>'{}' or jsonb_typeof(block->'id') is distinct from 'string' or char_length(block->>'id') not between 1 and 100 or block->>'id' !~ '^[a-zA-Z0-9_-]+$' then return false; end if;
  kind:=block->>'type'; props:=block->'props';
  if jsonb_typeof(props) is distinct from 'object' or not planning.validate_idea_blocks(block->'children',depth+1) then return false; end if;
  if kind in ('paragraph','heading','bulletListItem','numberedListItem','checkListItem','toggleListItem','quote','ideaAnswer','reviewAnswer','openQuestion') then
   allowed:=array['backgroundColor','textColor','textAlignment'];
   if kind='heading' then allowed:=allowed||array['level','isToggleable']; if coalesce(props->>'level','') not in ('1','2','3') then return false; end if; end if;
   if kind='numberedListItem' then allowed:=allowed||'start'::text; end if;
   if kind='checkListItem' then allowed:=allowed||'checked'::text; if jsonb_typeof(props->'checked') is distinct from 'boolean' then return false; end if; end if;
   if kind='ideaAnswer' then
    allowed:=allowed||array['field','prompt'];
    if coalesce(props->>'field','') not in ('purpose','audience','experience','context','constraints','possibilities') or jsonb_typeof(props->'prompt') is distinct from 'string' or char_length(props->>'prompt')>200 then return false; end if;
   end if;
   if kind='reviewAnswer' then allowed:=allowed||'prompt'::text; if jsonb_typeof(props->'prompt') is distinct from 'string' or char_length(props->>'prompt') not between 1 and 200 then return false; end if; end if;
   if kind='openQuestion' then allowed:=allowed||'important'::text; if jsonb_typeof(props->'important') is distinct from 'boolean' or block->>'id' !~ '^[0-9a-fA-F-]{36}$' then return false; end if; perform (block->>'id')::uuid; end if;
   if not planning.validate_idea_inline(block->'content') then return false; end if;
   if kind='openQuestion' and char_length(planning.idea_block_text(block))>200 then return false; end if;
   if kind='ideaAnswer' and char_length(planning.idea_block_text(block))+(case when props->>'prompt'<>'' then char_length(props->>'prompt')+34 else 0 end)>2000 then return false; end if;
  elsif kind in ('file','image') then
   allowed:=array['backgroundColor','name','url','caption'];
   if kind='image' then allowed:=allowed||array['textAlignment','showPreview','previewWidth']; if jsonb_typeof(props->'showPreview') is distinct from 'boolean' then return false; end if; end if;
   if block ? 'content' or jsonb_array_length(block->'children')<>0 then return false; end if;
   if jsonb_typeof(props->'name') is distinct from 'string' or char_length(props->>'name')>180 or jsonb_typeof(props->'caption') is distinct from 'string' or char_length(props->>'caption')>1000 or jsonb_typeof(props->'url') is distinct from 'string' then return false; end if;
   if props->>'url'<>'' then
    if props->>'url' !~ '^woolgather:(file|image):[0-9a-fA-F-]{36}$' then return false; end if;
    perform split_part(props->>'url',':',3)::uuid;
   end if;
  elsif kind='divider' then allowed:='{}'; if block ? 'content' or jsonb_array_length(block->'children')<>0 then return false; end if;
  elsif kind='codeBlock' then allowed:=array['language']; if jsonb_typeof(props->'language') is distinct from 'string' or char_length(props->>'language')>40 or not planning.validate_idea_inline(block->'content') then return false; end if;
  elsif kind='table' then
   allowed:=array['textColor']; contents:=block->'content';
   if jsonb_typeof(contents) is distinct from 'object' or (contents-array['type','columnWidths','headerRows','headerCols','rows'])<>'{}' or contents->>'type' is distinct from 'tableContent' or jsonb_typeof(contents->'columnWidths') is distinct from 'array' or jsonb_array_length(contents->'columnWidths') not between 1 and 20 or jsonb_typeof(contents->'rows') is distinct from 'array' or jsonb_array_length(contents->'rows') not between 1 and 100 then return false; end if;
   for value in select x from jsonb_array_elements(contents->'columnWidths') x loop if value<>'null'::jsonb and (jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric not between 0 and 4000) then return false; end if; end loop;
   for key,value in select * from jsonb_each(contents-array['type','columnWidths','rows']) loop if jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric) or (value#>>'{}')::integer not between 0 and (case when key='headerRows' then 100 else 20 end) then return false; end if; end loop;
   for row in select x from jsonb_array_elements(contents->'rows') x loop
    if (row-array['cells'])<>'{}' or jsonb_typeof(row->'cells') is distinct from 'array' or jsonb_array_length(row->'cells') not between 1 and 20 then return false; end if;
    for cell in select x from jsonb_array_elements(row->'cells') x loop
     if jsonb_typeof(cell)='array' then if not planning.validate_idea_inline(cell) then return false; end if;
     else
      if (cell-array['type','props','content'])<>'{}' or cell->>'type' is distinct from 'tableCell' or not planning.validate_idea_inline(cell->'content') then return false; end if;
      cprops:=cell->'props';
      if jsonb_typeof(cprops) is distinct from 'object' or (cprops-array['backgroundColor','textColor','textAlignment','colspan','rowspan'])<>'{}' or coalesce(cprops->>'textAlignment','') not in ('left','center','right','justify') then return false; end if;
      for key,value in select * from jsonb_each(cprops) loop
       if key in ('textColor','backgroundColor') then if jsonb_typeof(value)<>'string' or char_length(value#>>'{}')>60 or (value#>>'{}') !~ '^[#a-zA-Z0-9(),.%[:space:]-]+$' then return false; end if;
       elsif key in ('colspan','rowspan') then if jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric) or (value#>>'{}')::integer not between 1 and (case when key='colspan' then 20 else 100 end) then return false; end if; end if;
      end loop;
     end if;
    end loop;
   end loop;
  else return false; end if;
  if (props-allowed)<>'{}' then return false; end if;
  for key,value in select * from jsonb_each(props) loop
   if key in ('textColor','backgroundColor') then if jsonb_typeof(value)<>'string' or char_length(value#>>'{}')>60 or (value#>>'{}') !~ '^[#a-zA-Z0-9(),.%[:space:]-]+$' then return false; end if;
   elsif key='textAlignment' then if value#>>'{}' not in ('left','center','right','justify') then return false; end if;
   elsif key in ('checked','important','showPreview','isToggleable') then if jsonb_typeof(value)<>'boolean' then return false; end if;
   elsif key in ('previewWidth','level','start') then
    if jsonb_typeof(value)<>'number' or (key='previewWidth' and (value#>>'{}')::numeric not between 32 and 4000) or (key='start' and ((value#>>'{}')::numeric not between 1 and 1000000 or (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric))) then return false; end if;
   end if;
  end loop;
 end loop;
 return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;
$$;
