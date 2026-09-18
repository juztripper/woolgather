-- Conversation and visual relationships belong to the existing owned project.
-- Existing manual items remain canonical; no migration invents a project plan.
alter table planning.projects add column thinking jsonb not null default '{"version":1,"turns":[],"relations":[],"proposals":[],"focusId":null,"view":"map","undo":null}'::jsonb;
alter table planning.items add column evidence jsonb;

create or replace function public.project_snapshot(project_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'revision',p.revision,'updatedAt',p.updated_at,'folderId',p.folder_id,'lifecycle',p.lifecycle,'originalIdea',p.original_idea,'ideaDocument',p.idea_document,'references',p.image_references,'thinking',p.thinking,'ideaQuestions',coalesce((select h.context->'openQuestions' from planning.history h where h.project_id=p.id and h.revision=1),'[]'::jsonb),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'body',i.body,'category',i.category,'certainty',i.certainty,'status',i.status,'answer',i.answer,'links',i.links,'removed',i.removed,'source',i.source,'promotedFrom',i.promoted_from,'evidence',i.evidence) order by i.created_at,i.id) from planning.items i where i.project_id=p.id),'[]'::jsonb))
 from planning.projects p where p.id=project_id;
$$;

create function planning.validate_thinking(value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare t jsonb; r jsonb;
begin
 if jsonb_typeof(value) is distinct from 'object' or value->>'version' is distinct from '1' or octet_length(value::text)>500000
  or (value-array['version','turns','relations','proposals','focusId','view','undo'])<>'{}'::jsonb
  or jsonb_typeof(value->'turns') is distinct from 'array' or jsonb_array_length(value->'turns')>200
  or jsonb_typeof(value->'relations') is distinct from 'array' or jsonb_array_length(value->'relations')>1000
  or jsonb_typeof(value->'proposals') is distinct from 'array' or jsonb_array_length(value->'proposals')>100
  or coalesce(value->>'view','') not in ('map','flow','outline') then return false; end if;
 for t in select x from jsonb_array_elements(value->'turns') x loop
  if jsonb_typeof(t) is distinct from 'object' or coalesce(t->>'id','') !~ '^[0-9a-f-]{36}$'
   or jsonb_typeof(t->'text') is distinct from 'string' or char_length(t->>'text') not between 1 and 12000
   or jsonb_typeof(t->'reply') is distinct from 'string' or char_length(t->>'reply')>12000
   or coalesce(t->>'status','') not in ('pending','complete','saved','failed','stale','cancelled')
   or jsonb_typeof(t->'changedIds') is distinct from 'array' then return false; end if;
 end loop;
 if (select count(*)<>count(distinct x->>'id') from jsonb_array_elements(value->'turns') x) then return false; end if;
 for r in select x from jsonb_array_elements(value->'relations') x loop
  if coalesce(r->>'from','') !~ '^[0-9a-f-]{36}$' or coalesce(r->>'to','') !~ '^[0-9a-f-]{36}$' or r->>'from'=r->>'to'
   or coalesce(r->>'kind','') not in ('part_of','requires','enables','affects','alternative_to','sequence')
   or jsonb_typeof(r->'reason') is distinct from 'string' or char_length(r->>'reason')>1000 then return false; end if;
 end loop;
 return true;
end; $$;
revoke all on function planning.validate_thinking(jsonb) from public,anon;
grant execute on function planning.validate_thinking(jsonb) to authenticated;
alter table planning.projects add constraint valid_project_thinking check(planning.validate_thinking(thinking));

create function public.project_planning_command(command jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid(); pid uuid:=(command->>'projectId')::uuid; cid uuid:=(command->>'id')::uuid;
 expected integer:=(command->>'revision')::integer; kind text:=command->>'action'; tid text:=command->>'turnId';
 p planning.projects; prior planning.commands; state jsonb; t jsonb; data jsonb; next_items jsonb;
 result jsonb; iid uuid; item_ids uuid[]:='{}'; linked uuid[]; old_item planning.items; proposal jsonb; amended jsonb;
begin
 if actor is null or public.account_access()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 if octet_length(command::text)>800000 or pid is null or cid is null or expected is null or kind is null then raise exception 'Invalid planning command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into prior from planning.commands where owner_id=actor and id=cid;
 if found then
  if prior.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return public.project_snapshot(pid);
 end if;
 select * into p from planning.projects where id=pid for update;
 if not found then raise exception 'Project not found' using errcode='P0002'; end if;
 if p.lifecycle<>'active' then raise exception 'Restore this project before editing' using errcode='22023'; end if;
 state:=p.thinking;
 if kind='complete' then
  select x into t from jsonb_array_elements(state->'turns') x where x->>'id'=tid;
  if t is null then raise exception 'Turn not found' using errcode='P0002'; end if;
  -- Cancellation and a newer edit always win. Retain the reply without applying stale changes.
  if t->>'status'<>'pending' then return public.project_snapshot(pid); end if;
  if p.revision<>expected then
   select jsonb_agg(case when x->>'id'=tid then x||jsonb_build_object('status','stale','reply',left(coalesce(command->>'reply',''),12000)) else x end order by n)
   into amended from jsonb_array_elements(state->'turns') with ordinality a(x,n);
   state:=jsonb_set(state,'{turns}',amended);
  else
   state:=command->'thinking'; next_items:=command->'items';
   if not planning.validate_thinking(state) then raise exception 'Invalid project thinking' using errcode='22023'; end if;
   -- A completion can only replace the matching turn; it cannot rewrite the author transcript.
   if (select coalesce(jsonb_agg(x order by n),'[]'::jsonb) from jsonb_array_elements(state->'turns') with ordinality a(x,n) where x->>'id'<>tid)
      is distinct from (select coalesce(jsonb_agg(x order by n),'[]'::jsonb) from jsonb_array_elements(p.thinking->'turns') with ordinality a(x,n) where x->>'id'<>tid)
    or (select x->>'text' from jsonb_array_elements(state->'turns') x where x->>'id'=tid) is distinct from t->>'text' then raise exception 'Conversation changed' using errcode='22023'; end if;
  end if;
 else
  if p.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
  if kind='turn' then
   if coalesce(tid,'') !~ '^[0-9a-f-]{36}$' or jsonb_typeof(command->'text') is distinct from 'string' or char_length(trim(command->>'text')) not between 1 and 12000 then raise exception 'Write something first' using errcode='22023'; end if;
   if exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'id'=tid) then raise exception 'Turn already exists' using errcode='22023'; end if;
   if exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'status'='pending') then raise exception 'A reply is still pending' using errcode='PT409'; end if;
   t:=jsonb_build_object('id',tid,'text',command->>'text','reply','','status',case when command->>'mode'='note' then 'saved' else 'pending' end,'focusId',command->'focusId','createdAt',clock_timestamp(),'changedIds','[]'::jsonb);
   state:=jsonb_set(state,'{turns}',state->'turns'||jsonb_build_array(t));
   if command->>'mode'='note' then
    insert into planning.items(id,project_id,title,body,category,certainty,status,source,evidence) values(tid::uuid,pid,left(regexp_replace(trim(command->>'text'),'\s+',' ','g'),100),command->>'text','note','stated','open','Written by you',jsonb_build_object('turnId',tid,'quote',command->>'text'));
    if coalesce(command->>'focusId','')<>'' and exists(select 1 from planning.items where id=(command->>'focusId')::uuid and project_id=pid and not removed) then
     state:=jsonb_set(state,'{relations}',state->'relations'||jsonb_build_array(jsonb_build_object('id',tid||':part_of:'||(command->>'focusId'),'from',tid,'to',command->>'focusId','kind','part_of','reason','Added while discussing this part.')));
    end if;
   end if;
  elsif kind='retry' then
   select x into t from jsonb_array_elements(state->'turns') x where x->>'id'=tid;
   if t is null or t->>'status' not in ('failed','stale','cancelled','saved') then raise exception 'Thought cannot be retried' using errcode='PT409'; end if;
   if exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'status'='pending') then raise exception 'A reply is still pending' using errcode='PT409'; end if;
   select jsonb_agg(case when x->>'id'=tid then x||jsonb_build_object('status','pending','reply','','createdAt',clock_timestamp(),'changedIds','[]'::jsonb) else x end order by n)
   into amended from jsonb_array_elements(state->'turns') with ordinality a(x,n);
   state:=jsonb_set(state,'{turns}',amended);
  elsif kind in ('fail','cancel') then
   if not exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'id'=tid and x->>'status'='pending') then return public.project_snapshot(pid); end if;
   select coalesce(jsonb_agg(case when x->>'id'=tid and x->>'status'='pending' then x||jsonb_build_object('status',case when kind='cancel' then 'cancelled' else 'failed' end,'reply',case when kind='fail' then left(coalesce(command->>'reply',x->>'reply',''),12000) else x->>'reply' end) else x end order by n),'[]'::jsonb)
   into amended from jsonb_array_elements(state->'turns') with ordinality a(x,n);
   state:=jsonb_set(state,'{turns}',amended);
  elsif kind in ('adopt','dismiss') then
   select x into proposal from jsonb_array_elements(state->'proposals') x where x->>'id'=command->>'proposalId';
   if proposal is null then raise exception 'Suggestion not found' using errcode='P0002'; end if;
   if kind='adopt' then
    data:=proposal->'item'; iid:=(proposal->>'itemId')::uuid;
    select * into old_item from planning.items where id=iid and project_id=pid;
    if old_item.id is null and exists(select 1 from planning.items where id=iid) then raise exception 'Concept unavailable' using errcode='22023'; end if;
    insert into planning.items(id,project_id,title,body,category,certainty,status,answer,links,source,evidence)
     values(iid,pid,data->>'title',data->>'body',data->>'category',data->>'certainty',data->>'status',data->>'answer',coalesce((select array_agg(v::uuid) from jsonb_array_elements_text(data->'links') v),'{}'),'Suggestion adopted by you',jsonb_build_object('turnId',proposal->>'turnId','quote','Adopted in the project view'))
     on conflict(id) do update set title=excluded.title,body=excluded.body,category=excluded.category,certainty=excluded.certainty,status=excluded.status,answer=excluded.answer,removed=false,source=excluded.source,evidence=excluded.evidence where planning.items.project_id=pid;
   end if;
   state:=jsonb_set(state,'{proposals}',(select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(state->'proposals') x where x->>'id'<>command->>'proposalId'));
   -- Keep a durable conversational record of the author's explicit choice.
   state:=jsonb_set(state,'{turns}',state->'turns'||jsonb_build_array(jsonb_build_object('id',cid,'text',(case when kind='adopt' then 'I adopted the suggestion: ' else 'I dismissed the suggestion: ' end)||(proposal->'item'->>'title'),'reply','','status','saved','focusId',proposal->>'itemId','createdAt',clock_timestamp(),'changedIds','[]'::jsonb)));
  elsif kind='connect' then
   if command->>'from'=command->>'to' or not exists(select 1 from planning.items where id=(command->>'from')::uuid and project_id=pid and not removed)
    or not exists(select 1 from planning.items where id=(command->>'to')::uuid and project_id=pid and not removed) then raise exception 'Choose two saved thoughts' using errcode='22023'; end if;
   data:=jsonb_build_object('id',cid,'from',command->>'from','to',command->>'to','kind',command->>'kind','reason',coalesce(command->>'reason',''));
   state:=jsonb_set(state,'{relations}',(select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(state->'relations') x where not(x->>'from'=command->>'from' and x->>'to'=command->>'to' and x->>'kind'=command->>'kind'))||jsonb_build_array(data));
  elsif kind='disconnect' then
   state:=jsonb_set(state,'{relations}',(select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(state->'relations') x where x->>'id'<>command->>'relationId'));
  elsif kind='undo' then
   if state->'undo' is null or state->'undo'='null' or (state->'undo'->>'revision')::integer<>p.revision then raise exception 'The project changed after this update' using errcode='PT409'; end if;
   next_items:=state->'undo'->'items';
   -- Newly captured concepts are removed, preserving their identities and history.
   next_items:=next_items||coalesce((select jsonb_agg(x||'{"removed":true}'::jsonb) from jsonb_array_elements(public.project_snapshot(pid)->'items') x where not exists(select 1 from jsonb_array_elements(next_items) b where b->>'id'=x->>'id')),'[]'::jsonb);
   state:=state||jsonb_build_object('relations',state->'undo'->'relations','proposals',state->'undo'->'proposals','undo',null);
   state:=jsonb_set(state,'{turns}',state->'turns'||jsonb_build_array(jsonb_build_object('id',cid,'text','I undid the last project changes. Keep the earlier plan.','reply','','status','saved','focusId',null,'createdAt',clock_timestamp(),'changedIds','[]'::jsonb)));
  else raise exception 'Unknown planning command' using errcode='22023'; end if;
 end if;
 if next_items is not null then
  if jsonb_typeof(next_items) is distinct from 'array' or jsonb_array_length(next_items)>500 then raise exception 'Invalid concepts' using errcode='22023'; end if;
  if exists(select 1 from planning.items i where i.project_id=pid and not exists(select 1 from jsonb_array_elements(next_items) x where x->>'id'=i.id::text)) then raise exception 'Existing concepts must be preserved' using errcode='22023'; end if;
  for data in select x from jsonb_array_elements(next_items) x loop
   iid:=(data->>'id')::uuid;
   if iid is null or iid=any(item_ids) or exists(select 1 from planning.items where id=iid and project_id<>pid) then raise exception 'Invalid concept identity' using errcode='22023'; end if;
   item_ids:=array_append(item_ids,iid);
   if jsonb_typeof(data->'links') is distinct from 'array' or jsonb_array_length(data->'links')>100 then raise exception 'Invalid links' using errcode='22023'; end if;
   select coalesce(array_agg(v::uuid),'{}') into linked from jsonb_array_elements_text(data->'links') v;
   if exists(select 1 from unnest(linked) x where x=iid or not exists(select 1 from jsonb_array_elements(next_items) j where j->>'id'=x::text)) then raise exception 'Unknown linked concept' using errcode='22023'; end if;
   insert into planning.items(id,project_id,title,body,category,certainty,status,answer,links,removed,source,promoted_from,evidence)
    values(iid,pid,data->>'title',data->>'body',data->>'category',data->>'certainty',data->>'status',data->>'answer',linked,(data->>'removed')::boolean,data->>'source',(data->>'promotedFrom')::uuid,data->'evidence')
    on conflict(id) do update set title=excluded.title,body=excluded.body,category=excluded.category,certainty=excluded.certainty,status=excluded.status,answer=excluded.answer,links=excluded.links,removed=excluded.removed,source=excluded.source,evidence=excluded.evidence where planning.items.project_id=pid;
  end loop;
 end if;
 state:=jsonb_set(state,'{relations}',(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(state->'relations') x
  where (exists(select 1 from planning.items where id=(x->>'from')::uuid and project_id=pid and not removed) or exists(select 1 from jsonb_array_elements(state->'proposals') s where s->>'itemId'=x->>'from'))
   and (exists(select 1 from planning.items where id=(x->>'to')::uuid and project_id=pid and not removed) or exists(select 1 from jsonb_array_elements(state->'proposals') s where s->>'itemId'=x->>'to'))));
 if not planning.validate_thinking(state) then raise exception 'Invalid project thinking' using errcode='22023'; end if;
 update planning.projects set thinking=state,revision=revision+1,updated_at=clock_timestamp() where id=pid returning * into p;
 insert into planning.history(project_id,revision,action,after_item,context) values(pid,p.revision,'planning_'||kind,jsonb_build_object('title',case when kind='turn' then 'Your thought' else 'Project discussion' end,'body',coalesce(command->>'text',command->>'reply','')),jsonb_build_object('turnId',tid));
 result:=public.project_snapshot(pid);
 insert into planning.commands(owner_id,id,project_id,request,result) values(actor,cid,pid,command,result);
 return result;
end; $$;
revoke all on function public.project_planning_command(jsonb) from public,anon;
grant execute on function public.project_planning_command(jsonb) to authenticated;

-- Shared prepaid wallet; this migration grants no funding and resets no counters.
-- Billing survives removal of the project or account, without retaining its text.
create table account_private.project_planning_runs (
 id uuid primary key,
 owner_id uuid references auth.users(id) on delete set null,
 project_id uuid references planning.projects(id) on delete set null,
 turn_id uuid not null,
 fingerprint text not null,
 status text not null check(status in ('reserved','running','completed','failed','unknown','cancelled')),
 model text not null,
 max_output_tokens integer not null,
 reserve_microusd bigint not null check(reserve_microusd>0),
 actual_microusd bigint,
 capability_hash text not null,
 attempt_id uuid,
 created_at timestamptz not null default clock_timestamp(),
 started_at timestamptz,
 settled_at timestamptz,
 finish_hash text,
 usage jsonb,
 error_code text
);
create index project_planning_runs_project on account_private.project_planning_runs(project_id,created_at desc);
alter table account_private.project_planning_runs enable row level security;
revoke all on account_private.project_planning_runs from public,anon,authenticated;

create function account_private.planning_signature(payload text,signature text,prefix text) returns void
language plpgsql security definer set search_path='' as $$
declare secret_value text; expected bytea; supplied bytea; difference integer:=0; n integer;
begin
 if payload is null or octet_length(payload)>12000 or signature is null or signature !~ '^[0-9a-f]{64}$' then raise exception 'Invalid planning signature' using errcode='42501'; end if;
 select secret into secret_value from account_private.action_secrets where purpose='account_deletion';
 expected:=extensions.hmac(convert_to(prefix||payload,'UTF8'),convert_to(secret_value,'UTF8'),'sha256');
 if expected is null then raise exception 'Planning unavailable' using errcode='42501'; end if;
 supplied:=decode(signature,'hex');
 for n in 0..31 loop difference:=difference | (get_byte(expected,n) # get_byte(supplied,n)); end loop;
 if difference<>0 then raise exception 'Invalid planning signature' using errcode='42501'; end if;
end; $$;
revoke all on function account_private.planning_signature(text,text,text) from public,anon,authenticated;

create function public.project_planning_budget(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; run account_private.project_planning_runs; expired account_private.project_planning_runs;
 wallet account_private.guidance_wallet; allowance account_private.guidance_allowances; p planning.projects; amount bigint;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.planning_signature(payload,signature,'woolgather.planning.v1:'||actor::text||':');
 c:=payload::jsonb;
 select * into wallet from account_private.guidance_wallet where id='openai' for update;
 select * into allowance from account_private.guidance_allowances where owner_id=actor for update;
 -- Only provably unstarted reservations expire without charge. Started work stays reserved.
 for expired in select * from account_private.project_planning_runs where owner_id=actor and status='reserved' and created_at<clock_timestamp()-interval '60 seconds' order by created_at limit 10 for update loop
  update account_private.project_planning_runs set status='cancelled',settled_at=clock_timestamp(),actual_microusd=0 where id=expired.id;
  update account_private.guidance_wallet set reserved_microusd=reserved_microusd-expired.reserve_microusd where id='openai';
  update account_private.guidance_allowances set reserved_microusd=reserved_microusd-expired.reserve_microusd where owner_id=actor;
 end loop;
 update account_private.project_planning_runs set status='unknown',error_code='completion_unconfirmed' where owner_id=actor and status='running' and started_at<clock_timestamp()-interval '90 seconds';
 if c->>'action'='status' and c->>'runId' is null then
  select * into run from account_private.project_planning_runs where project_id=(c->>'projectId')::uuid and turn_id=(c->>'turnId')::uuid and owner_id=actor order by created_at desc limit 1 for update;
 else
  select * into run from account_private.project_planning_runs where id=(c->>'runId')::uuid and owner_id=actor for update;
 end if;
 if c->>'action'='status' then
  return case when run.id is null then '{"status":"idle"}'::jsonb else jsonb_build_object('status',run.status,'runId',run.id) end;
 end if;
 if c->>'action'='claim' then
  if run.id is null then raise exception 'Run unavailable' using errcode='P0002'; end if;
  if run.status='running' and run.attempt_id=(c->>'attemptId')::uuid then return '{"claimed":true}'::jsonb; end if;
  if run.status<>'reserved' then return '{"claimed":false}'::jsonb; end if;
  update account_private.project_planning_runs set status='running',attempt_id=(c->>'attemptId')::uuid,started_at=clock_timestamp() where id=run.id;
  return '{"claimed":true}'::jsonb;
 end if;
 if c->>'action'<>'reserve' then raise exception 'Invalid planning budget action' using errcode='22023'; end if;
 if run.id is not null then
  if run.fingerprint is distinct from c->>'fingerprint' or run.project_id is distinct from (c->>'projectId')::uuid or run.turn_id is distinct from (c->>'turnId')::uuid then raise exception 'Run conflict' using errcode='PT409'; end if;
  return jsonb_build_object('runId',run.id,'status',run.status,'reserved',run.status='reserved');
 end if;
 select * into p from planning.projects where id=(c->>'projectId')::uuid and owner_id=actor for share;
 if p.id is null or p.lifecycle<>'active' then raise exception 'Project unavailable' using errcode='P0002'; end if;
 if p.revision is distinct from (c->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if not exists(select 1 from jsonb_array_elements(p.thinking->'turns') t where t->>'id'=c->>'turnId' and t->>'status'='pending') then raise exception 'Turn unavailable' using errcode='PT409'; end if;
 if exists(select 1 from account_private.project_planning_runs where project_id=p.id and status in ('reserved','running','unknown')) then raise exception 'A reply is still being reconciled' using errcode='PT425'; end if;
 amount:=(c->>'reserveMicrousd')::bigint;
 if amount is null or amount<=0 or amount>1500000 or coalesce(c->>'model','') not in ('gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna')
  or coalesce(c->>'capabilityHash','') !~ '^[0-9a-f]{64}$' or coalesce(c->>'fingerprint','') !~ '^[0-9a-f]{64}$'
  or coalesce((c->>'maxOutputTokens')::integer,0) not between 800 and 8000 then raise exception 'Invalid reservation' using errcode='22023'; end if;
 select * into wallet from account_private.guidance_wallet where id='openai';
 select * into allowance from account_private.guidance_allowances where owner_id=actor;
 if allowance.owner_id is null or wallet.id is null or not wallet.enabled then raise exception 'Planning unavailable' using errcode='42501'; end if;
 if wallet.spent_microusd+wallet.reserved_microusd+amount>wallet.budget_microusd
  or allowance.spent_microusd+allowance.reserved_microusd+amount>allowance.budget_microusd or allowance.used_requests>=allowance.max_requests then raise exception 'Planning allowance reached' using errcode='PT429'; end if;
 update account_private.guidance_wallet set reserved_microusd=reserved_microusd+amount where id='openai';
 update account_private.guidance_allowances set reserved_microusd=reserved_microusd+amount,used_requests=used_requests+1,last_requested_at=clock_timestamp() where owner_id=actor;
 insert into account_private.project_planning_runs(id,owner_id,project_id,turn_id,fingerprint,status,model,max_output_tokens,reserve_microusd,capability_hash)
 values((c->>'runId')::uuid,actor,p.id,(c->>'turnId')::uuid,c->>'fingerprint','reserved',c->>'model',(c->>'maxOutputTokens')::integer,amount,c->>'capabilityHash');
 return jsonb_build_object('runId',c->>'runId','status','reserved','reserved',true);
end; $$;
revoke all on function public.project_planning_budget(text,text) from public,anon;
grant execute on function public.project_planning_budget(text,text) to authenticated;

create function public.settle_project_planning(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c jsonb; run account_private.project_planning_runs; u jsonb; amount bigint; price_input numeric; price_cached numeric; price_write numeric; price_output numeric; v text; finish_digest text;
begin
 perform account_private.planning_signature(payload,signature,'woolgather.planning.settle.v1:'); c:=payload::jsonb;
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 select * into run from account_private.project_planning_runs where id=(c->>'runId')::uuid;
 if run.id is null or run.capability_hash is distinct from encode(extensions.digest(c->>'capability','sha256'),'hex') then raise exception 'Run unavailable' using errcode='42501'; end if;
 perform 1 from account_private.guidance_allowances where owner_id=run.owner_id for update;
 select * into run from account_private.project_planning_runs where id=run.id for update;
 finish_digest:=encode(extensions.digest(payload,'sha256'),'hex');
 if run.settled_at is not null then
  if run.finish_hash is distinct from finish_digest then raise exception 'Settlement conflict' using errcode='PT409'; end if;
  return '{"settled":true}'::jsonb;
 end if;
 if run.status not in ('running','unknown') or run.attempt_id is distinct from (c->>'attemptId')::uuid then raise exception 'Unclaimed run' using errcode='PT409'; end if;
 if c->>'status'='unknown' then
  update account_private.project_planning_runs set status='unknown',error_code=left(c->>'errorCode',80) where id=run.id;
  return '{"settled":false}'::jsonb;
 end if;
 if coalesce(c->>'status','') not in ('completed','failed') then raise exception 'Invalid settlement' using errcode='22023'; end if;
 u:=c->'usage';
 if u->>'model' is distinct from run.model or u->>'serviceTier' is distinct from 'default' or u->>'priceVersion' is distinct from '2026-09-11' then raise exception 'Invalid usage' using errcode='22023'; end if;
 foreach v in array array['inputTokens','cachedTokens','cacheWriteTokens','outputTokens','reasoningTokens','costMicrousd','latencyMs'] loop
  if coalesce(u->>v,'') !~ '^[0-9]+$' or (u->>v)::numeric>100000000 then raise exception 'Invalid usage count' using errcode='22023'; end if;
 end loop;
 if (u->>'cachedTokens')::bigint+(u->>'cacheWriteTokens')::bigint>(u->>'inputTokens')::bigint or (u->>'reasoningTokens')::bigint>(u->>'outputTokens')::bigint then raise exception 'Invalid usage totals' using errcode='22023'; end if;
 case run.model when 'gpt-5.6-sol' then price_input:=4;price_cached:=0.4;price_write:=5;price_output:=20;
  when 'gpt-5.6-terra' then price_input:=2;price_cached:=0.2;price_write:=2.5;price_output:=12;
  when 'gpt-5.6-luna' then price_input:=0.2;price_cached:=0.02;price_write:=0.25;price_output:=1.2;
  else raise exception 'Unpriced model' using errcode='22023'; end case;
 amount:=ceil(((u->>'inputTokens')::numeric-(u->>'cachedTokens')::numeric-(u->>'cacheWriteTokens')::numeric)*price_input+(u->>'cachedTokens')::numeric*price_cached+(u->>'cacheWriteTokens')::numeric*price_write+(u->>'outputTokens')::numeric*price_output);
 update account_private.project_planning_runs set status=c->>'status',actual_microusd=amount,usage=u,settled_at=clock_timestamp(),finish_hash=finish_digest,error_code=left(c->>'errorCode',80) where id=run.id;
 update account_private.guidance_wallet set reserved_microusd=reserved_microusd-run.reserve_microusd,spent_microusd=spent_microusd+amount,
  enabled=enabled and amount<=run.reserve_microusd and amount=(u->>'costMicrousd')::bigint and (u->>'outputTokens')::bigint<=run.max_output_tokens where id='openai';
 update account_private.guidance_allowances set reserved_microusd=reserved_microusd-run.reserve_microusd,spent_microusd=spent_microusd+amount where owner_id=run.owner_id;
 return '{"settled":true}'::jsonb;
end; $$;
revoke all on function public.settle_project_planning(text,text) from public,anon,authenticated;
grant execute on function public.settle_project_planning(text,text) to anon,authenticated;
