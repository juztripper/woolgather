-- DEC-145. Commercial allowance accounting is separate from provider spending.
-- No funding, enrollment, payment activation or historical ledger reset.
alter table account_private.guidance_allowances drop constraint guidance_allowances_max_requests_check,
 add constraint guidance_allowances_max_requests_check check(max_requests>=0);
create table account_private.plan_settings (
 id boolean primary key default true check(id), enabled boolean not null default false,
 free_accounts_max integer not null default 0 check(free_accounts_max>=0),
 funding_microusd bigint not null default 0 check(funding_microusd>=0),
 issued_microusd bigint not null default 0 check(issued_microusd>=0),
 storage_capacity_bytes bigint not null default 943718400 check(storage_capacity_bytes>=0)
);
insert into account_private.plan_settings(id) values(true);
create table account_private.plan_accounts (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 anchor_at timestamptz not null default clock_timestamp()
);
create table account_private.plan_grants (
 id text primary key, owner_id uuid references auth.users(id) on delete set null,
 environment text not null check(environment in ('test','live')),
 kind text not null check(kind in ('welcome','free','paid')),
 starts_at timestamptz not null, ends_at timestamptz,
 credits integer not null check(credits>=0), spent integer not null default 0 check(spent>=0),
 held integer not null default 0 check(held>=0),
 voice_seconds numeric not null default 0 check(voice_seconds>=0),
 voice_spent numeric not null default 0 check(voice_spent>=0), voice_held numeric not null default 0 check(voice_held>=0),
 revoked boolean not null default false, tariff_version text not null default '2026-09-17' check(tariff_version='2026-09-17'),
 payment_id text, subscription_id text,
 check(ends_at is null or ends_at>starts_at), check(spent+held<=credits), check(voice_spent+voice_held<=voice_seconds)
);
create unique index plan_paid_payment on account_private.plan_grants(environment,payment_id) where payment_id is not null;
create unique index plan_paid_period on account_private.plan_grants(environment,subscription_id,starts_at) where subscription_id is not null;
create index plan_grants_owner on account_private.plan_grants(owner_id,environment,ends_at);
create table account_private.plan_actions (
 id uuid primary key, owner_id uuid references auth.users(id) on delete set null,
 project_id uuid references planning.projects(id) on delete set null, turn_id uuid not null,
 fingerprint text not null, model text not null check(model in ('gpt-5.6-luna','gpt-5.6-sol')),
 cap integer not null check(cap between 1 and 500), charged integer not null default 0,
 status text not null default 'reserved' check(status in ('reserved','running','pending','charged','released')),
 billable boolean not null default false, created_at timestamptz not null default clock_timestamp(), settled_at timestamptz,
 tariff_version text not null default '2026-09-17' check(tariff_version='2026-09-17')
);
create index plan_actions_owner on account_private.plan_actions(owner_id,status);
create table account_private.plan_allocations (
 action_id uuid references account_private.plan_actions(id), grant_id text references account_private.plan_grants(id),
 reserved integer not null check(reserved>0), charged integer not null default 0 check(charged>=0),
 primary key(action_id,grant_id)
);
alter table account_private.project_planning_runs add column credit_action_id uuid references account_private.plan_actions(id);
create index planning_runs_credit_action on account_private.project_planning_runs(credit_action_id);
alter table account_private.project_voice_sessions add column credit_grant_id text references account_private.plan_grants(id);
alter table account_private.project_voice_sessions add column allowance_settled boolean not null default false;
do $$ declare t text; begin
 foreach t in array array['plan_settings','plan_accounts','plan_grants','plan_actions','plan_allocations'] loop
  execute format('alter table account_private.%I enable row level security',t);
  execute format('revoke all on account_private.%I from public,anon,authenticated',t);
 end loop;
end $$;

-- Anniversary is always computed from the original anchor, not the previous
-- clamped month. Jan 31 -> Feb 28 -> Mar 31, independent of database timezone.
create function account_private.plan_month(anchor timestamptz, at_time timestamptz) returns timestamptz
language plpgsql immutable set search_path='' as $$
declare a timestamp:=anchor at time zone 'UTC'; n timestamp:=at_time at time zone 'UTC'; months integer; result timestamp;
begin
 months:=(extract(year from n)::integer-extract(year from a)::integer)*12+extract(month from n)::integer-extract(month from a)::integer;
 result:=a+make_interval(months=>months);
 if result>n then result:=a+make_interval(months=>months-1); end if;
 return result at time zone 'UTC';
end $$;
revoke all on function account_private.plan_month(timestamptz,timestamptz) from public,anon,authenticated;
create function account_private.issue_plan_grant(gid text, actor uuid, kind_value text, start_at timestamptz, end_at timestamptz, units integer) returns void
language plpgsql security definer set search_path='' as $$
declare amount bigint:=units::bigint*3300; cfg account_private.plan_settings;
begin
 if exists(select 1 from account_private.plan_grants where id=gid) then return; end if;
 select * into cfg from account_private.plan_settings where id for update;
 if not cfg.enabled or cfg.issued_microusd+amount>cfg.funding_microusd then raise exception 'Free assistance is awaiting funded capacity. Your writing remains available.' using errcode='PT429'; end if;
 insert into account_private.plan_grants(id,owner_id,environment,kind,starts_at,ends_at,credits) values(gid,actor,'live',kind_value,start_at,end_at,units);
 update account_private.plan_settings set issued_microusd=issued_microusd+amount where id;
 -- Existing lifetime spending and holds are never erased. Only already funded
 -- grants add new account capacity; the global provider wallet remains a guard.
 insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(actor,1000000,amount)
 on conflict(owner_id) do update set budget_microusd=account_private.guidance_allowances.budget_microusd+amount,max_requests=greatest(account_private.guidance_allowances.max_requests,1000000);
end $$;
revoke all on function account_private.issue_plan_grant(text,uuid,text,timestamptz,timestamptz,integer) from public,anon,authenticated;
create function account_private.refresh_plan(actor uuid) returns void
language plpgsql security definer set search_path='' as $$
declare anchor timestamptz; start_at timestamptz; end_at timestamptz; cfg account_private.plan_settings;
begin
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 perform pg_advisory_xact_lock(hashtextextended('plan:'||actor::text,0));
 select * into cfg from account_private.plan_settings where id for update;
 if not cfg.enabled or exists(select 1 from account_private.guidance_allowances where owner_id=actor and testing_request_exempt) then return; end if;
 select anchor_at into anchor from account_private.plan_accounts where owner_id=actor;
 if anchor is null then
  if (select count(*) from account_private.plan_accounts)>=cfg.free_accounts_max then return; end if;
  -- Capacity checks precede enrollment so an unfunded signup cannot consume a slot.
  if cfg.issued_microusd+990000>cfg.funding_microusd then return; end if;
  insert into account_private.plan_accounts(owner_id) values(actor) returning anchor_at into anchor;
  perform account_private.issue_plan_grant('welcome:'||actor,actor,'welcome',anchor,null,200);
 end if;
 start_at:=account_private.plan_month(anchor,clock_timestamp());
 end_at:=account_private.plan_month(anchor,start_at+interval '35 days');
 -- Paid periods suppress the free period they intersect. Downgrade waits for
 -- the next anniversary; replaying upgrade/refund cannot mint a second grant.
 if exists(select 1 from account_private.plan_grants where owner_id=actor and environment='live' and kind='paid' and starts_at<end_at and ends_at>start_at) then return; end if;
 if cfg.issued_microusd+330000<=cfg.funding_microusd then
  perform account_private.issue_plan_grant('free:'||actor||':'||to_char(start_at at time zone 'UTC','YYYYMMDDHH24MISSUS'),actor,'free',start_at,end_at,100);
 end if;
end $$;
revoke all on function account_private.refresh_plan(uuid) from public,anon,authenticated;

create function account_private.reconcile_plan_action(target_action_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a account_private.plan_actions; state jsonb; outcome text; cost bigint; debit integer; remaining integer; row record;
begin
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 select * into a from account_private.plan_actions where id=target_action_id for update;
 if a.id is null or a.settled_at is not null then return; end if;
 select t into state from planning.projects p cross join lateral jsonb_array_elements(p.thinking->'turns') t where p.id=a.project_id and t->>'id'=a.turn_id::text;
 outcome:=state->>'status';
 if outcome='pending' and a.created_at>clock_timestamp()-interval '210 seconds' then return; end if;
 if outcome='complete' and exists(select 1 from account_private.project_planning_runs where credit_action_id=a.id and status in ('reserved','running','unknown')) then
  update account_private.plan_actions set status='pending' where id=a.id; return;
 end if;
 if outcome='pending' and exists(select 1 from account_private.project_planning_runs where credit_action_id=a.id and status in ('running','unknown')) then
  update account_private.plan_actions set status='pending' where id=a.id; return;
 end if;
 -- The frozen customer tariff is independent from future provider prices.
 select coalesce(sum(ceil(((usage->>'inputTokens')::numeric-(usage->>'cachedTokens')::numeric-(usage->>'cacheWriteTokens')::numeric)*case model when 'gpt-5.6-sol' then 4 else .2 end
  +(usage->>'cachedTokens')::numeric*case model when 'gpt-5.6-sol' then .4 else .02 end
  +(usage->>'cacheWriteTokens')::numeric*case model when 'gpt-5.6-sol' then 5 else .25 end
  +(usage->>'outputTokens')::numeric*case model when 'gpt-5.6-sol' then 20 else 1.2 end)),0)
 into cost from account_private.project_planning_runs where credit_action_id=a.id and settled_at is not null;
 debit:=case when outcome='complete' and a.billable then least(a.cap,ceil(cost/3000.0)::integer) else 0 end;
 remaining:=debit;
 for row in select x.*,g.ends_at from account_private.plan_allocations x join account_private.plan_grants g on g.id=x.grant_id where x.action_id=a.id order by g.ends_at nulls last,g.id for update of g loop
  update account_private.plan_grants set held=held-row.reserved,spent=spent+least(remaining,row.reserved) where id=row.grant_id;
  update account_private.plan_allocations set charged=least(remaining,row.reserved) where action_id=a.id and grant_id=row.grant_id;
  remaining:=remaining-least(remaining,row.reserved);
 end loop;
 update account_private.plan_actions set status=case when debit>0 then 'charged' else 'released' end,charged=debit,settled_at=clock_timestamp() where id=a.id;
end $$;
revoke all on function account_private.reconcile_plan_action(uuid) from public,anon,authenticated;

create function public.account_plan() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); cfg account_private.plan_settings; testing boolean; tier text; paid_until timestamptz; renewal timestamptz; a record; result jsonb; voice record; seconds numeric;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.refresh_plan(actor);
 select * into cfg from account_private.plan_settings where id;
 select coalesce(testing_request_exempt,false) into testing from account_private.guidance_allowances where owner_id=actor;
 testing:=coalesce(testing,false);
 for a in select id from account_private.plan_actions where owner_id=actor and settled_at is null loop perform account_private.reconcile_plan_action(a.id); end loop;
 for voice in select * from account_private.project_voice_sessions where owner_id=actor and credit_grant_id is not null and not allowance_settled and settled_at is not null for update loop
  seconds:=case when voice.status='completed' then least(voice.max_duration_seconds,coalesce((voice.usage->>'seconds')::numeric,0)) else 0 end;
  update account_private.plan_grants set voice_held=voice_held-voice.max_duration_seconds,voice_spent=voice_spent+seconds where id=voice.credit_grant_id;
  update account_private.project_voice_sessions set allowance_settled=true where id=voice.id;
 end loop;
 select max(ends_at) into paid_until from account_private.plan_grants where owner_id=actor and environment='live' and kind='paid' and not revoked and starts_at<=clock_timestamp() and ends_at>clock_timestamp();
 if cfg.enabled and not testing then update account_private.guidance_allowances set paid_voice_until=paid_until where owner_id=actor; end if;
 tier:=case when paid_until is not null or testing then 'paid' else 'free' end;
 select min(ends_at) into renewal from account_private.plan_grants where owner_id=actor and environment='live' and kind<>'welcome' and not revoked and starts_at<=clock_timestamp() and ends_at>clock_timestamp();
 if tier='paid' then renewal:=paid_until; end if;
 select jsonb_build_object(
  'enabled',cfg.enabled and not testing,'testing',testing,'tier',tier,
  'credits',coalesce(sum(credits-spent-held) filter(where not revoked and starts_at<=clock_timestamp() and (ends_at is null or ends_at>clock_timestamp())),0),
  'reservedCredits',coalesce(sum(held),0),
  'monthlyCredits',coalesce(sum(credits-spent-held) filter(where kind<>'welcome' and not revoked and starts_at<=clock_timestamp() and ends_at>clock_timestamp()),0),
  'welcomeCredits',coalesce(sum(credits-spent-held) filter(where kind='welcome' and not revoked),0),
  'renewsAt',renewal,'paidUntil',paid_until,
  'voiceSeconds',coalesce(sum(voice_seconds-voice_spent-voice_held) filter(where kind='paid' and not revoked and starts_at<=clock_timestamp() and ends_at>clock_timestamp()),0),
  'reservedVoiceSeconds',coalesce(sum(voice_held),0),
  'storageBytes',(select coalesce(sum(byte_size),0) from account_private.attachments where owner_id=actor)+(select coalesce(sum(octet_length(content)),0) from planning.reference_images where owner_id=actor),
  'storageLimitBytes',case when tier='paid' then 1073741824 else 104857600 end,
  'pending',coalesce((select jsonb_agg(jsonb_build_object('id',id,'credits',cap,'status',status)) from account_private.plan_actions where owner_id=actor and settled_at is null),'[]'::jsonb)) into result
 from account_private.plan_grants where owner_id=actor and environment='live';
 return result;
end $$;
revoke all on function public.account_plan() from public,anon;
grant execute on function public.account_plan() to authenticated;

create function public.account_plan_action(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; a account_private.plan_actions; info jsonb; remaining integer; take integer; g account_private.plan_grants;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.planning_signature(payload,signature,'woolgather.plan.v1:'||actor::text||':'); c:=payload::jsonb;
 info:=public.account_plan();
 if not (info->>'enabled')::boolean then return jsonb_build_object('enforced',false,'plan',info); end if;
 select * into a from account_private.plan_actions where id=(c->>'id')::uuid for update;
 if a.id is not null and a.owner_id is distinct from actor then raise exception 'Action unavailable' using errcode='42501'; end if;
 if c->>'action'='reserve' then
  if a.id is not null then
   if a.fingerprint is distinct from c->>'fingerprint' then raise exception 'Action conflict' using errcode='PT409'; end if;
   return jsonb_build_object('enforced',true,'status',a.status,'cap',a.cap);
  end if;
  if not exists(select 1 from planning.projects p cross join lateral jsonb_array_elements(p.thinking->'turns') t where p.id=(c->>'projectId')::uuid and p.owner_id=actor and t->>'id'=c->>'turnId' and t->>'status'='pending') then raise exception 'Pending action unavailable' using errcode='PT409'; end if;
  if exists(select 1 from account_private.plan_actions where owner_id=actor and settled_at is null) then raise exception 'Another reply is still using your allowance. Your draft is kept.' using errcode='PT425'; end if;
  if c->>'model'='gpt-5.6-sol' and info->>'tier'<>'paid' then raise exception 'Sol requires a paid plan' using errcode='PT403'; end if;
  remaining:=(c->>'maxCredits')::integer;
  if remaining is null or remaining<1 or remaining>500 or remaining>(info->>'credits')::integer then raise exception 'Your credit allowance has been reached. Manual work remains available.' using errcode='PT429'; end if;
  insert into account_private.plan_actions(id,owner_id,project_id,turn_id,fingerprint,model,cap) values((c->>'id')::uuid,actor,(c->>'projectId')::uuid,(c->>'turnId')::uuid,c->>'fingerprint',c->>'model',remaining);
  for g in select * from account_private.plan_grants where owner_id=actor and environment='live' and not revoked and starts_at<=clock_timestamp() and (ends_at is null or ends_at>clock_timestamp()) and credits>spent+held order by ends_at nulls last,id for update loop
   take:=least(remaining,g.credits-g.spent-g.held);
   insert into account_private.plan_allocations values((c->>'id')::uuid,g.id,take,0);
   update account_private.plan_grants set held=held+take where id=g.id;
   remaining:=remaining-take; exit when remaining=0;
  end loop;
  if remaining<>0 then raise exception 'Credit reservation conflict' using errcode='PT409'; end if;
 elsif c->>'action'='allow' then
  if a.id is null or a.settled_at is not null then raise exception 'Action unavailable' using errcode='PT409'; end if;
  update account_private.plan_actions set billable=true,status='running' where id=a.id;
 elsif c->>'action'='settle' then
  perform account_private.reconcile_plan_action(a.id);
 else raise exception 'Unknown allowance action' using errcode='22023'; end if;
 return public.account_plan();
end $$;
revoke all on function public.account_plan_action(text,text) from public,anon;
grant execute on function public.account_plan_action(text,text) to authenticated;

-- Guard every physical request, not merely the browser's selected route.
alter function public.project_planning_budget(text,text) rename to project_planning_budget_v144;
alter function public.project_planning_budget_v144(text,text) set schema account_private;
revoke all on function account_private.project_planning_budget_v144(text,text) from public,anon,authenticated;
create function public.project_planning_budget(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; a account_private.plan_actions; amount bigint; result jsonb; enforced boolean;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.planning_signature(payload,signature,'woolgather.planning.v1:'||actor::text||':'); c:=payload::jsonb;
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 select enabled and not coalesce((select testing_request_exempt from account_private.guidance_allowances where owner_id=actor),false) into enforced from account_private.plan_settings where id;
 if enforced and c->>'action'='claim' then
  select a0.* into a from account_private.plan_actions a0 join account_private.project_planning_runs r on r.credit_action_id=a0.id where r.id=(c->>'runId')::uuid and a0.owner_id=actor for update of a0;
  if a.id is null or a.settled_at is not null then raise exception 'Credit reservation is no longer available' using errcode='PT409'; end if;
 end if;
 if enforced and c->>'action'='reserve' then
  select * into a from account_private.plan_actions where id=(c->>'creditActionId')::uuid and owner_id=actor for update;
  if a.id is null or a.settled_at is not null or a.project_id is distinct from (c->>'projectId')::uuid or a.turn_id is distinct from (c->>'turnId')::uuid then raise exception 'A credit reservation is required' using errcode='PT403'; end if;
  if c->>'model' not in (a.model,'gpt-5.6-luna') then raise exception 'Model is outside this action' using errcode='PT403'; end if;
  select coalesce(sum(coalesce(actual_microusd,reserve_microusd)),0) into amount from account_private.project_planning_runs where credit_action_id=a.id and id<>(c->>'runId')::uuid;
  if amount+(c->>'reserveMicrousd')::bigint>a.cap::bigint*3000 then raise exception 'This reply reached its agreed credit limit. Your writing is kept.' using errcode='PT429'; end if;
 end if;
 result:=account_private.project_planning_budget_v144(payload,signature);
 if enforced and c->>'action'='reserve' then update account_private.project_planning_runs set credit_action_id=a.id where id=(c->>'runId')::uuid; end if;
 return result;
end $$;
revoke all on function public.project_planning_budget(text,text) from public,anon;
grant execute on function public.project_planning_budget(text,text) to authenticated;

-- Owner quotas include pending uploads, so concurrent uploads cannot overbook.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.reserve_attachment(jsonb)'::regprocedure);
 if position('>943718400' in definition)=0 or position('>104857600' in definition)=0 then raise exception 'Attachment quota contract missing'; end if;
 definition:=replace(definition,'(select coalesce(sum(byte_size),0)+bytes from account_private.attachments)', '(select coalesce(sum(byte_size),0)+bytes from account_private.attachments)+(select coalesce(sum(octet_length(content)),0) from planning.reference_images)');
 definition:=replace(definition,'(select coalesce(sum(byte_size),0)+bytes from account_private.attachments where owner_id=actor)', '(select coalesce(sum(byte_size),0)+bytes from account_private.attachments where owner_id=actor)+(select coalesce(sum(octet_length(content)),0) from planning.reference_images where owner_id=actor)');
 definition:=replace(definition,'>943718400','>(select storage_capacity_bytes from account_private.plan_settings where id)');
 definition:=replace(definition,'>104857600','>(case when exists(select 1 from account_private.plan_grants where owner_id=actor and environment=''live'' and kind=''paid'' and not revoked and starts_at<=clock_timestamp() and ends_at>clock_timestamp()) then 1073741824 else 104857600 end)');
 execute definition;
 -- Older stored composers without modelPreference remain unchanged.
 definition:=pg_get_functiondef('planning.valid_composer(jsonb,uuid)'::regprocedure);
 execute replace(definition, 'if jsonb_typeof(c) is distinct from ''object''', 'if (c ? ''modelPreference'' and coalesce(c->>''modelPreference'','''') not in (''auto'',''luna'')) or jsonb_typeof(c) is distinct from ''object''');
end $$;

-- Voice reserves seconds atomically alongside the original monetary hold.
-- Expiry/unknown outcomes cannot free time while a provider may still be live.
alter table account_private.project_voice_sessions
 drop constraint project_voice_sessions_max_duration_seconds_check,
 drop constraint project_voice_sessions_reserve_microusd_check,
 add constraint project_voice_sessions_max_duration_seconds_check check(max_duration_seconds between 1 and 600),
 add constraint project_voice_sessions_reserve_microusd_check check(reserve_microusd=ceil((max_duration_seconds+15)*50000.0/60));
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.project_voice_start(text,text)'::regprocedure);
 if position('not in (60,600)' in definition)=0 then raise exception 'Voice duration contract missing'; end if;
 definition:=replace(definition,'not in (60,600)','not between 1 and 600');
 definition:=replace(definition,'((c->>''maxDurationSeconds'')::integer+15)*50000/60','ceil(((c->>''maxDurationSeconds'')::integer+15)*50000.0/60)');
 execute definition;
end $$;
alter function public.project_voice_start(text,text) rename to project_voice_start_v144;
alter function public.project_voice_start_v144(text,text) set schema account_private;
revoke all on function account_private.project_voice_start_v144(text,text) from public,anon,authenticated;
create function public.project_voice_start(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; info jsonb; g account_private.plan_grants; result jsonb; seconds integer;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.v1:'||actor::text||':'); c:=payload::jsonb;
 perform account_private.reconcile_project_voice_reservations();
 info:=public.account_plan();
 if (info->>'enabled')::boolean and not exists(select 1 from account_private.project_voice_sessions where id=(c->>'runId')::uuid) then
  seconds:=(c->>'maxDurationSeconds')::integer;
  select * into g from account_private.plan_grants where owner_id=actor and environment='live' and kind='paid' and not revoked and starts_at<=clock_timestamp() and ends_at>clock_timestamp()
   and voice_seconds-voice_spent-voice_held>=seconds and ends_at>=clock_timestamp()+make_interval(secs=>seconds)
   order by ends_at,id limit 1 for update;
  if g.id is null then raise exception 'Your voice allowance is unavailable. Your saved work remains available.' using errcode='PT429'; end if;
 end if;
 result:=account_private.project_voice_start_v144(payload,signature);
 if g.id is not null and (result->>'created')::boolean then
  update account_private.plan_grants set voice_held=voice_held+seconds where id=g.id;
  update account_private.project_voice_sessions set credit_grant_id=g.id where id=(c->>'runId')::uuid;
 end if;
 return result;
end $$;
revoke all on function public.project_voice_start(text,text) from public,anon;
grant execute on function public.project_voice_start(text,text) to authenticated;

-- Legacy inline images share the same owner/global byte quota. Keep RLS on
-- their existing invoker upload path, including direct table insert checks.
create function account_private.guard_reference_image_storage() returns trigger
language plpgsql security definer set search_path='' as $$
declare quota bigint; total_bytes bigint; owner_bytes bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('woolgather-attachment-budget',0));
 quota:=case when exists(select 1 from account_private.plan_grants where owner_id=new.owner_id and environment='live' and kind='paid' and not revoked and starts_at<=clock_timestamp() and ends_at>clock_timestamp()) then 1073741824 else 104857600 end;
 select coalesce(sum(byte_size),0) into total_bytes from account_private.attachments;
 total_bytes:=total_bytes+(select coalesce(sum(octet_length(content)),0) from planning.reference_images);
 select coalesce(sum(byte_size),0) into owner_bytes from account_private.attachments where owner_id=new.owner_id;
 owner_bytes:=owner_bytes+(select coalesce(sum(octet_length(content)),0) from planning.reference_images where owner_id=new.owner_id);
 if total_bytes+octet_length(new.content)>(select storage_capacity_bytes from account_private.plan_settings where id) or owner_bytes+octet_length(new.content)>quota then raise exception 'Your attachment storage allowance has been reached.' using errcode='PT429'; end if;
 return new;
end $$;
revoke all on function account_private.guard_reference_image_storage() from public,anon,authenticated;
create trigger guard_reference_image_storage before insert on planning.reference_images for each row execute function account_private.guard_reference_image_storage();
