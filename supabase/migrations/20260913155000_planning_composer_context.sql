-- Message context is durable and checked with the same ownership as the project.
create function planning.valid_composer(c jsonb, pid uuid) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare a jsonb; r jsonb;
begin
 if jsonb_typeof(c) is distinct from 'object' or octet_length(c::text)>40000
 or coalesce(c->>'reasoning','') not in ('auto','quick','thoughtful','deep')
 or coalesce(c->>'autoCeiling','') not in ('quick','thoughtful','deep')
 or coalesce(c->>'tool','') not in ('discuss','alternatives','compare','challenge','next_steps')
 or jsonb_typeof(c->'attachments') is distinct from 'array' or jsonb_array_length(c->'attachments')>6
 or jsonb_typeof(c->'references') is distinct from 'array' or jsonb_array_length(c->'references')>8 then return false; end if;
 if jsonb_typeof(coalesce(c->'quotes','[]')) is distinct from 'array' or jsonb_array_length(coalesce(c->'quotes','[]'))>4 then return false; end if;
 for r in select value from jsonb_array_elements(coalesce(c->'quotes','[]')) loop
  if char_length(coalesce(r->>'text','')) not between 1 and 2000 or not exists(select 1 from planning.projects p, jsonb_array_elements(p.thinking->'turns') t where p.id=pid and t->>'id'=r->>'turnId' and (strpos(t->>'text',r->>'text')>0 or strpos(t->>'reply',r->>'text')>0)) then return false; end if;
 end loop;
 for a in select value from jsonb_array_elements(c->'attachments') loop
  if not planning.attachment_available((a->>'id')::uuid) then return false; end if;
 end loop;
 for r in select value from jsonb_array_elements(c->'references') loop
  if not exists(select 1 from planning.items where id=(r#>>'{}')::uuid and project_id=pid and not removed) then return false; end if;
 end loop;
 return true;
exception when others then return false;
end; $$;
revoke all on function planning.valid_composer(jsonb,uuid) from public,anon;
grant execute on function planning.valid_composer(jsonb,uuid) to authenticated;

create or replace function public.project_planning_command(command jsonb) returns jsonb
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
    or (select x->>'text' from jsonb_array_elements(state->'turns') x where x->>'id'=tid) is distinct from t->>'text'
    or (select x->'composer' from jsonb_array_elements(state->'turns') x where x->>'id'=tid) is distinct from t->'composer'
    or (select x->'routing' from jsonb_array_elements(state->'turns') x where x->>'id'=tid) is distinct from t->'routing' then raise exception 'Conversation changed' using errcode='22023'; end if;
  end if;
 else
  if p.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
  if kind='turn' then
   if coalesce(tid,'') !~ '^[0-9a-f-]{36}$' or jsonb_typeof(command->'text') is distinct from 'string' or char_length(trim(command->>'text')) not between 1 and 12000 then raise exception 'Write something first' using errcode='22023'; end if;
   if exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'id'=tid) then raise exception 'Turn already exists' using errcode='22023'; end if;
   if exists(select 1 from jsonb_array_elements(state->'turns') x where x->>'status'='pending') then raise exception 'A reply is still pending' using errcode='PT409'; end if;
   t:=jsonb_build_object('id',tid,'text',command->>'text','reply','','status',case when command->>'mode'='note' then 'saved' else 'pending' end,'focusId',command->'focusId','createdAt',clock_timestamp(),'changedIds','[]'::jsonb);
   if command ? 'composer' then
    if not planning.valid_composer(command->'composer',pid) then raise exception 'Invalid message context' using errcode='22023'; end if;
    t:=t||jsonb_build_object('composer',command->'composer','routing',command->'routing');
   end if;
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

-- Conversation attachments survive cleanup and project restoration.
create or replace function account_private.attachment_referenced(aid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from planning.ideas where document->'attachments' @> jsonb_build_array(aid::text))
 or exists(select 1 from planning.projects where idea_document->'attachments' @> jsonb_build_array(aid::text)
 or exists(select 1 from jsonb_array_elements(thinking->'turns') t, jsonb_array_elements(coalesce(t->'composer'->'attachments','[]')) a where a->>'id'=aid::text));
$$;
create or replace function account_private.collect_removed_document_files() returns trigger language plpgsql security definer set search_path='' as $$
declare doc jsonb; aid jsonb; ids jsonb;
begin
 doc:=case when tg_table_name='ideas' then to_jsonb(old)->'document' else to_jsonb(old)->'idea_document' end;
 ids:=coalesce(doc->'attachments','[]');
 if tg_table_name='projects' then
  ids:=ids||coalesce((select jsonb_agg(a->'id') from jsonb_array_elements(to_jsonb(old)->'thinking'->'turns') t, jsonb_array_elements(coalesce(t->'composer'->'attachments','[]')) a),'[]');
 end if;
 for aid in select value from jsonb_array_elements(ids) loop
  if not account_private.attachment_referenced((aid#>>'{}')::uuid) then delete from account_private.attachments where id=(aid#>>'{}')::uuid; end if;
 end loop;
 return old;
end; $$;
