-- Additive durable conversations and specialist definitions.
-- Existing project items remain canonical; this migration adds only chat
-- metadata and turn annotations to the existing thinking document.

alter table planning.projects alter column thinking set default jsonb_build_object(
  'version', 1,
  'turns', '[]'::jsonb,
  'conversations', jsonb_build_array(jsonb_build_object(
    'id', 'main',
    'title', 'Main conversation',
    'agentIds', '[]'::jsonb,
    'createdAt', clock_timestamp(),
    'updatedAt', clock_timestamp(),
    'archived', false,
    'branch', null
  )),
  'agents', '[]'::jsonb,
  'relations', '[]'::jsonb,
  'proposals', '[]'::jsonb,
  'focusId', null,
  'view', 'map',
  'undo', null
);

create or replace function planning.validate_thinking(value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare t jsonb; r jsonb; c jsonb; a jsonb; b jsonb; w jsonb; activity jsonb;
begin
 if jsonb_typeof(value) is distinct from 'object' or value->>'version' is distinct from '1' or octet_length(value::text)>500000
  or (value-array['version','turns','conversations','agents','relations','proposals','focusId','view','undo'])<>'{}'::jsonb
  or jsonb_typeof(value->'turns') is distinct from 'array' or jsonb_array_length(value->'turns')>200
  or jsonb_typeof(value->'conversations') is distinct from 'array' or jsonb_array_length(value->'conversations') not between 1 and 24
  or jsonb_typeof(value->'agents') is distinct from 'array' or jsonb_array_length(value->'agents')>24
  or jsonb_typeof(value->'relations') is distinct from 'array' or jsonb_array_length(value->'relations')>1000
  or jsonb_typeof(value->'proposals') is distinct from 'array' or jsonb_array_length(value->'proposals')>100
  or coalesce(value->>'view','') not in ('map','flow','outline') then return false; end if;
 if not exists(select 1 from jsonb_array_elements(value->'conversations') x where x->>'id'='main' and coalesce((x->>'archived')::boolean,false)=false) then return false; end if;
 if (select count(*)<>count(distinct x->>'id') from jsonb_array_elements(value->'conversations') x) then return false; end if;
 for c in select x from jsonb_array_elements(value->'conversations') x loop
  if jsonb_typeof(c) is distinct from 'object' or coalesce(c->>'id','') !~ '^[A-Za-z0-9_-]{1,80}$'
   or jsonb_typeof(c->'title') is distinct from 'string' or char_length(c->>'title') not between 1 and 120
   or jsonb_typeof(c->'agentIds') is distinct from 'array' or jsonb_array_length(c->'agentIds')>2
   or jsonb_typeof(c->'createdAt') is distinct from 'string' or jsonb_typeof(c->'updatedAt') is distinct from 'string'
   or jsonb_typeof(c->'archived') is distinct from 'boolean'
   or (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(c->'agentIds') x) then return false; end if;
  if jsonb_typeof(c->'branch')='object' then
   b:=c->'branch';
   if coalesce(b->>'conversationId','') !~ '^[A-Za-z0-9_-]{1,80}$'
    or coalesce(b->>'turnId','') !~ '^[0-9a-f-]{36}$'
    or coalesce(b->>'message','') not in ('user','assistant')
    or coalesce(b->>'revision','') !~ '^[0-9]+$' then return false; end if;
  elsif c->'branch' is not null and jsonb_typeof(c->'branch') is distinct from 'null' then return false; end if;
 end loop;
 if (select count(*)<>count(distinct x->>'id') from jsonb_array_elements(value->'agents') x) then return false; end if;
 for a in select x from jsonb_array_elements(value->'agents') x loop
  if jsonb_typeof(a) is distinct from 'object' or coalesce(a->>'id','') !~ '^[A-Za-z0-9_-]{1,80}$'
   or jsonb_typeof(a->'name') is distinct from 'string' or char_length(a->>'name') not between 1 and 120
   or jsonb_typeof(a->'instructions') is distinct from 'string' or char_length(a->>'instructions')>4000
   or jsonb_typeof(a->'scopeIds') is distinct from 'array' or jsonb_array_length(a->'scopeIds')>12
   or (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(a->'scopeIds') x)
   or jsonb_typeof(a->'archived') is distinct from 'boolean'
   or jsonb_typeof(a->'createdAt') is distinct from 'string' then return false; end if;
  if exists(select 1 from jsonb_array_elements(a->'scopeIds') x where coalesce(x#>>'{}','') !~ '^[0-9a-f-]{36}$') then return false; end if;
 end loop;
 for t in select x from jsonb_array_elements(value->'turns') x loop
  if jsonb_typeof(t) is distinct from 'object' or coalesce(t->>'id','') !~ '^[0-9a-f-]{36}$'
   or jsonb_typeof(t->'text') is distinct from 'string' or char_length(t->>'text') not between 1 and 12000
   or jsonb_typeof(t->'reply') is distinct from 'string' or char_length(t->>'reply')>12000
   or coalesce(t->>'status','') not in ('pending','complete','saved','failed','stale','cancelled')
   or jsonb_typeof(t->'changedIds') is distinct from 'array' then return false; end if;
  if t ? 'conversationId' and (jsonb_typeof(t->'conversationId') is distinct from 'string' or (t->>'conversationId') !~ '^[A-Za-z0-9_-]{1,80}$') then return false; end if;
  if t ? 'reaction' then
   if jsonb_typeof(t->'reaction') is distinct from 'object' or ((t->'reaction')-array['user','assistant'])<>'{}'::jsonb
    or (t->'reaction' ? 'user' and coalesce(t->'reaction'->>'user','') not in ('like','dislike'))
    or (t->'reaction' ? 'assistant' and coalesce(t->'reaction'->>'assistant','') not in ('like','dislike')) then return false; end if;
  end if;
  if t ? 'work' then
   w:=t->'work';
   if jsonb_typeof(w) is distinct from 'object' or (w-array['startedAt','completedAt','activity'])<>'{}'::jsonb
    or (w ? 'startedAt' and jsonb_typeof(w->'startedAt') is distinct from 'string')
    or (w ? 'completedAt' and jsonb_typeof(w->'completedAt') is distinct from 'string')
    or jsonb_typeof(w->'activity') is distinct from 'array' or jsonb_array_length(w->'activity')>12 then return false; end if;
   for activity in select x from jsonb_array_elements(w->'activity') x loop
    if jsonb_typeof(activity) is distinct from 'object' or (activity-array['label','detail','durationMs'])<>'{}'::jsonb
     or jsonb_typeof(activity->'label') is distinct from 'string' or char_length(activity->>'label') not between 1 and 120
     or (activity ? 'detail' and (jsonb_typeof(activity->'detail') is distinct from 'string' or char_length(activity->>'detail')>6000))
     or (activity ? 'durationMs' and (jsonb_typeof(activity->'durationMs') is distinct from 'number' or (activity->>'durationMs')::numeric<0 or (activity->>'durationMs')::numeric>600000)) then return false; end if;
   end loop;
  end if;
 end loop;
 if (select count(*)<>count(distinct x->>'id') from jsonb_array_elements(value->'turns') x) then return false; end if;
 for r in select x from jsonb_array_elements(value->'relations') x loop
  if coalesce(r->>'from','') !~ '^[0-9a-f-]{36}$' or coalesce(r->>'to','') !~ '^[0-9a-f-]{36}$' or r->>'from'=r->>'to'
   or coalesce(r->>'kind','') not in ('part_of','requires','enables','affects','alternative_to','sequence')
   or jsonb_typeof(r->'reason') is distinct from 'string' or char_length(r->>'reason')>1000 then return false; end if;
 end loop;
 return true;
exception when others then return false;
end; $$;

-- Rows created before this migration have one implicit main conversation. Keep
-- this backfill small and deterministic; the domain reader still has a main
-- fallback for old snapshots and exported fixtures.
update planning.projects p
set thinking = jsonb_set(
  jsonb_set(
    jsonb_set(
      p.thinking,
      '{conversations}',
      case when jsonb_typeof(p.thinking->'conversations')='array'
        then p.thinking->'conversations'
        else jsonb_build_array(jsonb_build_object(
          'id', 'main', 'title', 'Main conversation', 'agentIds', '[]'::jsonb,
          'createdAt', p.updated_at, 'updatedAt', p.updated_at,
          'archived', false, 'branch', null
        )) end
    ),
    '{agents}',
    case when jsonb_typeof(p.thinking->'agents')='array'
      then p.thinking->'agents' else '[]'::jsonb end
  ),
  '{turns}',
  coalesce((select jsonb_agg(
    case when x ? 'conversationId' then x else x||jsonb_build_object('conversationId','main') end
    order by n
  ) from jsonb_array_elements(coalesce(p.thinking->'turns','[]'::jsonb)) with ordinality a(x,n)),'[]'::jsonb)
)
where jsonb_typeof(p.thinking->'conversations') is distinct from 'array'
   or jsonb_typeof(p.thinking->'agents') is distinct from 'array'
   or exists(select 1 from jsonb_array_elements(coalesce(p.thinking->'turns','[]'::jsonb)) x where not x ? 'conversationId');

-- Preserve the validated legacy implementation and add the new metadata cases
-- as a thin dispatcher. Legacy turns continue through the exact old function,
-- including its source checks and completion semantics.
alter function public.project_planning_command(jsonb) rename to project_planning_command_legacy;

create function public.project_planning_command(command jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid(); pid uuid:=(command->>'projectId')::uuid; cid uuid:=(command->>'id')::uuid;
 expected integer:=(command->>'revision')::integer; kind text:=command->>'action'; state jsonb; p planning.projects; prior planning.commands;
 amended jsonb; target jsonb; parent jsonb; item jsonb; relation jsonb; turn jsonb; reaction jsonb; work jsonb; n bigint;
begin
 if kind not in ('turn','create_conversation','update_conversation','archive_conversation','upsert_agent','archive_agent','react','work') then
  return public.project_planning_command_legacy(command);
 end if;
 if actor is null or public.account_access()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 if octet_length(command::text)>800000 or pid is null or cid is null or expected is null or expected<0 then raise exception 'Invalid planning command' using errcode='22023'; end if;
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
 if p.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
 state:=p.thinking;
 if jsonb_typeof(state->'conversations') is distinct from 'array' then
  state:=jsonb_set(state,'{conversations}',jsonb_build_array(jsonb_build_object('id','main','title','Main conversation','agentIds','[]'::jsonb,'createdAt',p.updated_at,'updatedAt',p.updated_at,'archived',false,'branch',null)));
 end if;
 if jsonb_typeof(state->'agents') is distinct from 'array' then state:=jsonb_set(state,'{agents}','[]'::jsonb); end if;
 if kind='turn' then
  if coalesce(command->>'turnId','') !~ '^[0-9a-f-]{36}$' or jsonb_typeof(command->'text') is distinct from 'string' or char_length(trim(command->>'text')) not between 1 and 12000
   or exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'id'=command->>'turnId')
   or exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'status'='pending') then raise exception 'Turn unavailable' using errcode='PT409'; end if;
  if not exists(select 1 from jsonb_array_elements(state->'conversations') x where x->>'id'=coalesce(command->>'conversationId','main') and coalesce((x->>'archived')::boolean,false)=false) then raise exception 'Conversation unavailable' using errcode='P0002'; end if;
  if command ? 'composer' and not planning.valid_composer(command->'composer',pid) then raise exception 'Invalid message context' using errcode='22023'; end if;
  turn:=jsonb_build_object('id',command->>'turnId','conversationId',coalesce(command->>'conversationId','main'),'text',trim(command->>'text'),'reply','','status',case when command->>'mode'='note' then 'saved' else 'pending' end,'focusId',coalesce(command->'focusId','null'::jsonb),'createdAt',clock_timestamp(),'changedIds','[]'::jsonb);
  if command ? 'composer' then turn:=turn||jsonb_build_object('composer',command->'composer','routing',command->'routing'); end if;
  -- Name an untouched new conversation from its first authored message without
  -- paying for a separate naming request. Explicit titles remain unchanged.
  select jsonb_agg(case when x->>'id'=coalesce(command->>'conversationId','main') then x
    ||jsonb_build_object('updatedAt',clock_timestamp())
    ||case when x->>'title'='New conversation' and not exists(select 1 from jsonb_array_elements(state->'turns') t where coalesce(t->>'conversationId','main')=x->>'id')
      then jsonb_build_object('title',left(regexp_replace(trim(command->>'text'),'\s+',' ','g'),80)) else '{}'::jsonb end
    else x end order by ord) into amended from jsonb_array_elements(state->'conversations') with ordinality a(x,ord);
  state:=jsonb_set(state,'{conversations}',amended);
  state:=jsonb_set(state,'{turns}',state->'turns'||jsonb_build_array(turn));
  if command->>'mode'='note' then
   insert into planning.items(id,project_id,title,body,category,certainty,status,source,evidence) values((command->>'turnId')::uuid,pid,left(regexp_replace(trim(command->>'text'),'\s+',' ','g'),100),command->>'text','note','stated','open','Written by you',jsonb_build_object('turnId',command->>'turnId','quote',command->>'text'));
   if coalesce(command->>'focusId','')<>'' and exists(select 1 from planning.items where id=(command->>'focusId')::uuid and project_id=pid and not removed) then
    state:=jsonb_set(state,'{relations}',state->'relations'||jsonb_build_array(jsonb_build_object('id',(command->>'turnId')||':part_of:'||(command->>'focusId'),'from',command->>'turnId','to',command->>'focusId','kind','part_of','reason','Added while discussing this part.')));
   end if;
  end if;
 elsif kind='create_conversation' then
  if coalesce(command->>'conversationId','') !~ '^[A-Za-z0-9_-]{1,80}$' or command->>'conversationId'='main'
   or exists(select 1 from jsonb_array_elements(state->'conversations') x where x->>'id'=command->>'conversationId') then raise exception 'Conversation already exists' using errcode='22023'; end if;
  if jsonb_typeof(command->'agentIds') is distinct from 'array' or jsonb_array_length(command->'agentIds')>2
   or (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(command->'agentIds') x) then raise exception 'Invalid conversation agents' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(command->'agentIds') x where not exists(select 1 from jsonb_array_elements(state->'agents') a where a->>'id'=x#>>'{}' and coalesce((a->>'archived')::boolean,false)=false)) then raise exception 'Agent unavailable' using errcode='P0002'; end if;
  if jsonb_typeof(command->'branch')='object' then
   parent:=command->'branch';
   if not exists(select 1 from jsonb_array_elements(state->'conversations') x where x->>'id'=parent->>'conversationId' and coalesce((x->>'archived')::boolean,false)=false)
    or parent->>'conversationId'=command->>'conversationId'
    or not exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'id'=parent->>'turnId' and coalesce(x->>'conversationId','main')=parent->>'conversationId')
    or coalesce(parent->>'message','') not in ('user','assistant') or coalesce(parent->>'revision','') !~ '^[0-9]+$' then raise exception 'Invalid conversation branch' using errcode='22023'; end if;
   if (parent->>'revision')::integer<>p.revision
    or (parent->>'message')='assistant' and not exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'id'=parent->>'turnId' and x->>'status'='complete' and coalesce(x->>'reply','')<>'') then raise exception 'Invalid conversation branch' using errcode='22023'; end if;
  elsif command->'branch' is not null and jsonb_typeof(command->'branch') is distinct from 'null' then raise exception 'Invalid conversation branch' using errcode='22023'; end if;
  state:=jsonb_set(state,'{conversations}',state->'conversations'||jsonb_build_array(jsonb_build_object('id',command->>'conversationId','title',trim(command->>'title'),'agentIds',command->'agentIds','createdAt',clock_timestamp(),'updatedAt',clock_timestamp(),'archived',false,'branch',command->'branch')));
 elsif kind='update_conversation' then
  if not exists(select 1 from jsonb_array_elements(state->'conversations') x where x->>'id'=command->>'conversationId') then raise exception 'Conversation not found' using errcode='P0002'; end if;
  if command ? 'agentIds' then
   if jsonb_typeof(command->'agentIds') is distinct from 'array' or jsonb_array_length(command->'agentIds')>2
    or (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(command->'agentIds') x)
    or exists(select 1 from jsonb_array_elements(command->'agentIds') x where not exists(select 1 from jsonb_array_elements(state->'agents') a where a->>'id'=x#>>'{}' and coalesce((a->>'archived')::boolean,false)=false)) then raise exception 'Invalid conversation agents' using errcode='22023'; end if;
  end if;
  if not (command ? 'title' or command ? 'agentIds') then raise exception 'No conversation changes' using errcode='22023'; end if;
  select jsonb_agg(case when x->>'id'=command->>'conversationId' then x
    ||case when command ? 'title' then jsonb_build_object('title',trim(command->>'title')) else '{}'::jsonb end
    ||case when command ? 'agentIds' then jsonb_build_object('agentIds',command->'agentIds') else '{}'::jsonb end
    ||jsonb_build_object('updatedAt',clock_timestamp()) else x end order by ord) into amended
  from jsonb_array_elements(state->'conversations') with ordinality a(x,ord);
  state:=jsonb_set(state,'{conversations}',amended);
 elsif kind='archive_conversation' then
  if command->>'conversationId'='main' then raise exception 'The main conversation cannot be archived' using errcode='22023'; end if;
  if not exists(select 1 from jsonb_array_elements(state->'conversations') x where x->>'id'=command->>'conversationId') then raise exception 'Conversation not found' using errcode='P0002'; end if;
  select jsonb_agg(case when x->>'id'=command->>'conversationId' then x||jsonb_build_object('archived',(command->>'archived')::boolean,'updatedAt',clock_timestamp()) else x end order by ord) into amended
  from jsonb_array_elements(state->'conversations') with ordinality a(x,ord);
  state:=jsonb_set(state,'{conversations}',amended);
 elsif kind='upsert_agent' then
  if coalesce(command->>'agentId','') !~ '^[A-Za-z0-9_-]{1,80}$' or jsonb_typeof(command->'scopeIds') is distinct from 'array' or jsonb_array_length(command->'scopeIds')>12
   or (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(command->'scopeIds') x)
   or exists(select 1 from jsonb_array_elements(command->'scopeIds') x where coalesce(x#>>'{}','') !~ '^[0-9a-f-]{36}$' or not exists(select 1 from planning.items i where i.id=(x#>>'{}')::uuid and i.project_id=pid and not i.removed)) then raise exception 'Invalid agent scope' using errcode='22023'; end if;
  item:=jsonb_build_object('id',command->>'agentId','name',trim(command->>'name'),'instructions',coalesce(command->>'instructions',''),'scopeIds',command->'scopeIds','archived',false,'createdAt',coalesce((select x->>'createdAt' from jsonb_array_elements(state->'agents') x where x->>'id'=command->>'agentId'),clock_timestamp()::text));
  state:=jsonb_set(state,'{agents}',coalesce((select jsonb_agg(case when x->>'id'=command->>'agentId' then item else x end order by ord) from jsonb_array_elements(state->'agents') with ordinality a(x,ord)), '[]'::jsonb) || case when exists(select 1 from jsonb_array_elements(state->'agents') x where x->>'id'=command->>'agentId') then '[]'::jsonb else jsonb_build_array(item) end);
 elsif kind='archive_agent' then
  if not exists(select 1 from jsonb_array_elements(state->'agents') x where x->>'id'=command->>'agentId') then raise exception 'Agent not found' using errcode='P0002'; end if;
  select jsonb_agg(case when x->>'id'=command->>'agentId' then x||jsonb_build_object('archived',(command->>'archived')::boolean) else x end order by ord) into amended
  from jsonb_array_elements(state->'agents') with ordinality a(x,ord);
  state:=jsonb_set(state,'{agents}',amended);
 elsif kind='react' then
  select x into turn from jsonb_array_elements(state->'turns') x where x->>'id'=command->>'turnId';
  if turn is null then raise exception 'Turn not found' using errcode='P0002'; end if;
  reaction:=coalesce(turn->'reaction','{}'::jsonb)-(command->>'message');
  if jsonb_typeof(command->'reaction') is distinct from 'null' then reaction:=reaction||jsonb_build_object(command->>'message',command->'reaction'); end if;
  turn:=case when reaction='{}'::jsonb then turn-'reaction' else jsonb_set(turn,'{reaction}',reaction,true) end;
  select jsonb_agg(case when x->>'id'=command->>'turnId' then turn else x end order by ord) into amended
  from jsonb_array_elements(state->'turns') with ordinality a(x,ord);
  state:=jsonb_set(state,'{turns}',amended);
 elsif kind='work' then
  select x into turn from jsonb_array_elements(state->'turns') x where x->>'id'=command->>'turnId';
  if turn is null then raise exception 'Turn not found' using errcode='P0002'; end if;
  if turn->>'status'<>'pending' then raise exception 'Turn is no longer active' using errcode='PT409'; end if;
  turn:=jsonb_set(turn,'{work}',command->'work',true);
  select jsonb_agg(case when x->>'id'=command->>'turnId' then turn else x end order by ord) into amended
  from jsonb_array_elements(state->'turns') with ordinality a(x,ord);
  state:=jsonb_set(state,'{turns}',amended);
 end if;
 -- Metadata edits still advance the project revision. Rebase an immediately
 -- preceding plan undo marker across those edits so a chat reaction or agent
 -- change does not hide a valid undo. Turn/work writes deliberately do not
 -- rebase it because they are part of the active planning exchange.
 if kind in ('create_conversation','update_conversation','archive_conversation','upsert_agent','archive_agent','react')
  and jsonb_typeof(state->'undo')='object'
  and coalesce(state->'undo'->>'revision','') ~ '^[0-9]+$'
  and (state->'undo'->>'revision')::integer=expected then
  state:=jsonb_set(state,'{undo,revision}',to_jsonb(expected+1),true);
 end if;
 if not planning.validate_thinking(state) then raise exception 'Invalid project thinking' using errcode='22023'; end if;
 update planning.projects set thinking=state,revision=revision+1,updated_at=clock_timestamp() where id=pid returning * into p;
 insert into planning.history(project_id,revision,action,after_item,context) values(pid,p.revision,'planning_'||kind,null,jsonb_build_object('conversationId',command->>'conversationId','turnId',command->>'turnId','agentId',command->>'agentId'));
 target:=public.project_snapshot(pid);
 insert into planning.commands(owner_id,id,project_id,request,result) values(actor,cid,pid,command,target);
 return target;
end; $$;
revoke all on function public.project_planning_command(jsonb) from public,anon;
grant execute on function public.project_planning_command(jsonb) to authenticated;
revoke all on function public.project_planning_command_legacy(jsonb) from public,anon;
