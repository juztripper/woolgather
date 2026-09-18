-- Project sources are a durable catalog over the existing private attachment
-- store. The catalog adds project meaning and provenance without copying file
-- bytes into a second bucket or treating model context as canonical state.
create table planning.project_sources (
 id uuid primary key,
 project_id uuid not null references planning.projects(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 attachment_id uuid not null references account_private.attachments(id) on delete cascade,
 name text not null check(char_length(name) between 1 and 180 and name !~ '[\x00-\x1f\x7f/\\]'),
 mime_type text not null check(mime_type in ('application/octet-stream','image/png','image/jpeg','image/webp','image/gif')),
 byte_size bigint not null check(byte_size between 0 and 20971520),
 note text not null default '' check(char_length(note)<=4000),
 meaning text not null default 'undecided' check(meaning in ('use','avoid','undecided')),
 archived boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(project_id,attachment_id)
);
create index project_sources_project on planning.project_sources(project_id,archived,updated_at desc);
create index project_sources_attachment on planning.project_sources(attachment_id);
alter table planning.project_sources enable row level security;
revoke all on planning.project_sources from public,anon;
grant select on planning.project_sources to authenticated;
create policy own_project_sources on planning.project_sources
 for select to authenticated
 using (
  owner_id=(select auth.uid()) and
  exists(select 1 from planning.projects p where p.id=project_id and p.owner_id=(select auth.uid()))
 );

create function planning.check_project_source_owner() returns trigger
language plpgsql security definer set search_path='' as $$
declare project_owner uuid; attachment_owner uuid; ready text;
begin
 select owner_id into project_owner from planning.projects where id=new.project_id;
 select owner_id,state into attachment_owner,ready from account_private.attachments where id=new.attachment_id;
 if project_owner is null or project_owner is distinct from new.owner_id
   or attachment_owner is distinct from new.owner_id or ready is distinct from 'ready' then
  raise exception 'Source file is unavailable' using errcode='P0002';
 end if;
 return new;
end;
$$;
revoke all on function planning.check_project_source_owner() from public,anon,authenticated;
create trigger check_project_source_owner
 before insert or update of project_id,owner_id,attachment_id on planning.project_sources
 for each row execute function planning.check_project_source_owner();

-- Keep old attachment garbage collection aware of catalog references. A
-- source row is removed only by project deletion today; this trigger also
-- makes future detach commands safe and idempotent.
create or replace function account_private.attachment_referenced(aid uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from planning.ideas where document->'attachments' @> jsonb_build_array(aid::text))
 or exists(select 1 from planning.projects where idea_document->'attachments' @> jsonb_build_array(aid::text))
 or exists(select 1 from planning.projects p, jsonb_array_elements(coalesce(p.thinking->'turns','[]'::jsonb)) t, jsonb_array_elements(coalesce(t->'composer'->'attachments','[]'::jsonb)) a where a->>'id'=aid::text)
 or exists(select 1 from planning.project_sources where attachment_id=aid);
$$;
create function account_private.collect_removed_source_file() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not account_private.attachment_referenced(old.attachment_id) then
  delete from account_private.attachments where id=old.attachment_id;
 end if;
 return old;
end;
$$;
revoke all on function account_private.collect_removed_source_file() from public,anon,authenticated;
create trigger collect_source_file after delete on planning.project_sources
 for each row execute function account_private.collect_removed_source_file();

-- Existing saved conversation/idea attachments become source entries during
-- migration. This preserves their stable attachment IDs where possible and
-- gives a generated project-local ID if one old attachment was shared across
-- projects. Uploads remain in the original private bucket.
with legacy as (
 select distinct on (p.id,a.id)
  p.id as project_id,p.owner_id,a.id as attachment_id,a.name,a.mime_type,a.byte_size,
  row_number() over (partition by a.id order by p.id) as attachment_project_number
 from planning.projects p
 cross join lateral jsonb_array_elements(
   coalesce(p.idea_document->'attachments','[]'::jsonb) ||
   coalesce((select jsonb_agg(x->'id') from jsonb_array_elements(coalesce(p.thinking->'turns','[]'::jsonb)) t, jsonb_array_elements(coalesce(t->'composer'->'attachments','[]'::jsonb)) x),'[]'::jsonb)
 ) entry
 join account_private.attachments a on a.id=case when entry#>>'{}' ~ '^[0-9a-fA-F-]{36}$' then (entry#>>'{}')::uuid else null end
  and a.owner_id=p.owner_id and a.state='ready'
 order by p.id,a.id
)
insert into planning.project_sources(id,project_id,owner_id,attachment_id,name,mime_type,byte_size,note,meaning)
select case when attachment_project_number=1 then attachment_id else gen_random_uuid() end,
 project_id,owner_id,attachment_id,name,mime_type,byte_size,'','undecided'
from legacy
on conflict (project_id,attachment_id) do nothing;

-- Snapshot/catalog reads remain owner-scoped through the project and source
-- RLS policies. The attachment ID is only a stable lookup key for the same
-- authenticated owner; bytes still come from the existing private endpoint.
create or replace function public.project_snapshot(project_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'id',p.id,'name',p.name,'description',p.description,'revision',p.revision,'updatedAt',p.updated_at,
  'folderId',p.folder_id,'lifecycle',p.lifecycle,'originalIdea',p.original_idea,'ideaDocument',p.idea_document,
  'references',p.image_references,'thinking',p.thinking,
  'ideaQuestions',coalesce((select h.context->'openQuestions' from planning.history h where h.project_id=p.id and h.revision=1),'[]'::jsonb),
  'sources',coalesce((select jsonb_agg(jsonb_build_object(
    'id',s.id,'attachmentId',s.attachment_id,'name',s.name,'mime',s.mime_type,'size',s.byte_size,
    'note',s.note,'meaning',s.meaning,'archived',s.archived,'createdAt',s.created_at,'updatedAt',s.updated_at
  ) order by s.created_at,s.id) from planning.project_sources s where s.project_id=p.id),'[]'::jsonb),
  'items',coalesce((select jsonb_agg(jsonb_build_object(
    'id',i.id,'title',i.title,'body',i.body,'category',i.category,'certainty',i.certainty,'status',i.status,
    'answer',i.answer,'links',i.links,'removed',i.removed,'source',i.source,'promotedFrom',i.promoted_from,'evidence',i.evidence
  ) order by i.created_at,i.id) from planning.items i where i.project_id=p.id),'[]'::jsonb)
 )
 from planning.projects p where p.id=project_id;
$$;
revoke all on function public.project_snapshot(uuid) from public,anon;
grant execute on function public.project_snapshot(uuid) to authenticated;

create function public.project_source_catalog(project_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',s.id,'attachmentId',s.attachment_id,'name',s.name,'mime',s.mime_type,'size',s.byte_size,
  'note',s.note,'meaning',s.meaning,'archived',s.archived,'createdAt',s.created_at,'updatedAt',s.updated_at
 ) order by s.created_at,s.id),'[]'::jsonb)
 from planning.project_sources s
 where s.project_id=project_source_catalog.project_id;
$$;
revoke all on function public.project_source_catalog(uuid) from public,anon;
grant execute on function public.project_source_catalog(uuid) to authenticated;

-- A branch can cite its own messages and the bounded ancestor prefix from its
-- branch record. This mirrors conversationTurns() without copying messages or
-- allowing a source update to quote an unrelated private chat.
create function planning.source_turn_visible(state jsonb, target_conversation text, source_index integer) returns boolean
language sql immutable set search_path='' as $$
 with recursive visible(conversation_id,max_index,depth) as (
   select target_conversation,2147483647,0
   union all
   select c->'branch'->>'conversationId',
     coalesce((select min(n)::integer
       from jsonb_array_elements(coalesce(state->'turns','[]'::jsonb)) with ordinality turns(t,n)
       where t->>'id'=c->'branch'->>'turnId'
         and coalesce(t->>'conversationId','main')=c->'branch'->>'conversationId'),visible.max_index),
     visible.depth+1
   from visible
   join jsonb_array_elements(coalesce(state->'conversations','[]'::jsonb)) c
     on c->>'id'=visible.conversation_id
   where visible.depth<24 and jsonb_typeof(c->'branch')='object'
 )
 select exists(
   select 1
   from jsonb_array_elements(coalesce(state->'turns','[]'::jsonb)) with ordinality turns(t,n)
   join visible on coalesce(t->>'conversationId','main')=visible.conversation_id
   where n=source_index and n<=visible.max_index
 );
$$;
revoke all on function planning.source_turn_visible(jsonb,text,integer) from public,anon,authenticated;

-- Composer source IDs and model-returned source references are checked against
-- the same project catalog. This trigger covers direct database writes as
-- well as the normal planning command path.
create function planning.valid_project_source_annotations(value jsonb, pid uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare t jsonb; c jsonb; r jsonb; u jsonb; source_id text; agent_id text;
begin
 if jsonb_typeof(value) is distinct from 'object' then return false; end if;
 for t in select x from jsonb_array_elements(coalesce(value->'turns','[]'::jsonb)) x loop
  c:=coalesce(t->'composer','{}'::jsonb);
  if jsonb_typeof(coalesce(c->'agentIds','[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(c->'agentIds','[]'::jsonb))>2
    or (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(coalesce(c->'agentIds','[]'::jsonb)) x)
    or exists(select 1 from jsonb_array_elements(coalesce(c->'agentIds','[]'::jsonb)) x where jsonb_typeof(x) is distinct from 'string') then return false; end if;
  for agent_id in select x#>>'{}' from jsonb_array_elements(coalesce(c->'agentIds','[]'::jsonb)) x loop
   if not exists(select 1 from jsonb_array_elements(coalesce(value->'agents','[]'::jsonb)) a where a->>'id'=agent_id) then return false; end if;
  end loop;
  if jsonb_typeof(coalesce(c->'sourceIds','[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(c->'sourceIds','[]'::jsonb))>6
    or (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x)
    or exists(select 1 from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x where coalesce(x#>>'{}','') !~ '^[0-9a-fA-F-]{36}$') then return false; end if;
  for source_id in select x#>>'{}' from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x loop
   if not exists(select 1 from planning.project_sources s where s.id=source_id::uuid and s.project_id=pid) then return false; end if;
  end loop;
  if t ? 'sourceReferences' then
   if jsonb_typeof(t->'sourceReferences') is distinct from 'array' or jsonb_array_length(t->'sourceReferences')>6 then return false; end if;
   for r in select x from jsonb_array_elements(t->'sourceReferences') x loop
    if jsonb_typeof(r) is distinct from 'object' or (r-array['sourceId','quote'])<>'{}'::jsonb
      or coalesce(r->>'sourceId','') !~ '^[0-9a-fA-F-]{36}$'
      or (r ? 'quote' and (jsonb_typeof(r->'quote') is distinct from 'string' or char_length(r->>'quote')>2000)) then return false; end if;
    if not exists(select 1 from planning.project_sources s where s.id=(r->>'sourceId')::uuid and s.project_id=pid) then return false; end if;
   end loop;
  end if;
  if t ? 'sourceUpdates' then
   if jsonb_typeof(t->'sourceUpdates') is distinct from 'array' or jsonb_array_length(t->'sourceUpdates')>6 then return false; end if;
   for u in select x from jsonb_array_elements(t->'sourceUpdates') x loop
    if jsonb_typeof(u) is distinct from 'object' or (u-array['sourceId','note','meaning','sourceTurn','quote','origin'])<>'{}'::jsonb
      or coalesce(u->>'sourceId','') !~ '^[0-9a-fA-F-]{36}$'
      or coalesce(u->>'sourceTurn','')='' or char_length(u->>'sourceTurn')>100
      or jsonb_typeof(u->'quote') is distinct from 'string' or char_length(u->>'quote') not between 3 and 6000
      or coalesce(u->>'origin','')<>'author'
      or (u ? 'note' and (jsonb_typeof(u->'note') is distinct from 'string' or char_length(u->>'note')>4000))
      or (u ? 'meaning' and coalesce(u->>'meaning','') not in ('use','avoid','undecided'))
      or not (u ? 'note' or u ? 'meaning') then return false; end if;
    if not exists(select 1 from planning.project_sources s where s.id=(u->>'sourceId')::uuid and s.project_id=pid) then return false; end if;
   end loop;
  end if;
 end loop;
 return true;
exception when others then return false;
end;
$$;
revoke all on function planning.valid_project_source_annotations(jsonb,uuid) from public,anon,authenticated;
create function planning.check_project_source_annotations() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not planning.valid_project_source_annotations(new.thinking,new.id) then
  raise exception 'Invalid project source references' using errcode='22023';
 end if;
 return new;
end;
$$;
revoke all on function planning.check_project_source_annotations() from public,anon,authenticated;
create trigger check_project_source_annotations
 before insert or update of thinking on planning.projects
 for each row execute function planning.check_project_source_annotations();

-- Source meaning and notes are committed with the same project update as the
-- model reply. The authored quote is checked here too, so a direct database
-- write cannot turn an ungrounded model interpretation into durable metadata.
create function planning.apply_project_source_updates() returns trigger
language plpgsql security definer set search_path='' as $$
declare t jsonb; old_t jsonb; u jsonb; evidence text; source_turn text; source_index integer; source_conversation text;
begin
 for t in select x from jsonb_array_elements(coalesce(new.thinking->'turns','[]'::jsonb)) x loop
  select x into old_t from jsonb_array_elements(coalesce(old.thinking->'turns','[]'::jsonb)) x where x->>'id'=t->>'id';
  if t->>'status'='complete' and jsonb_typeof(t->'sourceUpdates')='array'
    and t->'sourceUpdates' is distinct from coalesce(old_t->'sourceUpdates','[]'::jsonb) then
   for u in select x from jsonb_array_elements(t->'sourceUpdates') x loop
    source_turn:=u->>'sourceTurn';
    if source_turn ~ '^t[1-9][0-9]*$' then
     source_index:=substring(source_turn from 2)::integer;
     select x->>'text' into evidence from jsonb_array_elements(new.thinking->'turns') with ordinality a(x,n) where n=source_index;
     source_conversation:=coalesce(t->>'conversationId','main');
     if evidence is null or not planning.source_turn_visible(new.thinking,source_conversation,source_index)
       or strpos(regexp_replace(evidence,'\s+',' ','g'),regexp_replace(u->>'quote','\s+',' ','g'))=0 then
      raise exception 'A source decision needs an exact quote from your authored context' using errcode='22023';
     end if;
    elsif source_turn='brief' then
     select regexp_replace(concat_ws(E'\n\n',nullif(new.description,''),case when new.idea_document->>'version'='2' then
       (select string_agg(planning.idea_block_text(block),E'\n\n' order by n) from jsonb_array_elements(coalesce(new.idea_document->'blocks','[]'::jsonb)) with ordinality blocks(block,n))
       else concat_ws(E'\n\n',nullif(new.original_idea,''),(select string_agg(value,E'\n\n' order by key) from jsonb_each_text(coalesce(new.idea_document->'answers','{}'::jsonb)))) end),'\s+',' ','g') into evidence;
     if evidence is null or strpos(evidence,regexp_replace(u->>'quote','\s+',' ','g'))=0 then
      raise exception 'A source decision needs an exact quote from your authored context' using errcode='22023';
     end if;
    else
     raise exception 'Invalid source decision evidence' using errcode='22023';
    end if;
    if not exists(select 1 from planning.project_sources s where s.id=(u->>'sourceId')::uuid and s.project_id=new.id and not s.archived) then
     raise exception 'Source is unavailable for this decision' using errcode='P0002';
    end if;
    update planning.project_sources set note=case when u ? 'note' then u->>'note' else note end,
     meaning=case when u ? 'meaning' then u->>'meaning' else meaning end,updated_at=clock_timestamp()
     where id=(u->>'sourceId')::uuid and project_id=new.id;
   end loop;
  end if;
 end loop;
 return new;
exception when invalid_text_representation or numeric_value_out_of_range then
 raise exception 'Invalid source decision evidence' using errcode='22023';
end;
$$;
revoke all on function planning.apply_project_source_updates() from public,anon,authenticated;
create trigger apply_project_source_updates
 before update of thinking on planning.projects
 for each row execute function planning.apply_project_source_updates();

-- Extend the existing composer validator without changing its attachment
-- accounting path. Missing fields remain valid for legacy messages.
create or replace function planning.valid_composer(c jsonb, pid uuid) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare a jsonb; r jsonb;
begin
 if jsonb_typeof(c) is distinct from 'object' or octet_length(c::text)>40000
 or coalesce(c->>'reasoning','') not in ('auto','quick','thoughtful','deep')
 or coalesce(c->>'autoCeiling','') not in ('quick','thoughtful','deep')
 or coalesce(c->>'tool','') not in ('discuss','alternatives','compare','challenge','next_steps')
 or jsonb_typeof(c->'attachments') is distinct from 'array' or jsonb_array_length(c->'attachments')>6
 or jsonb_typeof(c->'references') is distinct from 'array' or jsonb_array_length(c->'references')>8
 or jsonb_typeof(coalesce(c->'agentIds','[]'::jsonb)) is distinct from 'array' or jsonb_array_length(coalesce(c->'agentIds','[]'::jsonb))>2
 or jsonb_typeof(coalesce(c->'sourceIds','[]'::jsonb)) is distinct from 'array' or jsonb_array_length(coalesce(c->'sourceIds','[]'::jsonb))>6 then return false; end if;
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
 if (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(coalesce(c->'agentIds','[]'::jsonb)) x)
  or exists(select 1 from jsonb_array_elements(coalesce(c->'agentIds','[]'::jsonb)) x where jsonb_typeof(x) is distinct from 'string')
  or exists(select 1 from jsonb_array_elements(coalesce(c->'agentIds','[]'::jsonb)) x where not exists(select 1 from jsonb_array_elements((select p.thinking->'agents' from planning.projects p where p.id=pid)) agent_row where agent_row->>'id'=x#>>'{}' and coalesce((agent_row->>'archived')::boolean,false)=false)) then return false; end if;
 if (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x)
  or exists(select 1 from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x where coalesce(x#>>'{}','') !~ '^[0-9a-fA-F-]{36}$')
  or exists(select 1 from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x where not exists(select 1 from planning.project_sources s where s.id=(x#>>'{}')::uuid and s.project_id=pid and not s.archived)) then return false; end if;
 if (select count(*) from (
   select (attachment_entry->>'id')::uuid as attachment_id
   from jsonb_array_elements(c->'attachments') attachment_entry
   union
   select s.attachment_id
   from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x
   join planning.project_sources s on s.id=(x#>>'{}')::uuid and s.project_id=pid and not s.archived
 ) files)>6 then return false; end if;
 return true;
exception when others then return false;
end; $$;
revoke all on function planning.valid_composer(jsonb,uuid) from public,anon;
grant execute on function planning.valid_composer(jsonb,uuid) to authenticated;

-- Idempotent source registration and metadata edits advance the same project
-- revision as planning metadata. Bytes are never accepted through this RPC.
create function public.project_source_command(command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); pid uuid:=(command->>'projectId')::uuid; cid uuid:=(command->>'id')::uuid;
 expected integer:=(command->>'revision')::integer; kind text:=command->>'action'; p planning.projects; next_thinking jsonb;
 prior planning.commands; source_row planning.project_sources; attachment_row account_private.attachments; result jsonb;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 if octet_length(command::text)>30000 or pid is null or cid is null or expected is null or expected<0
  or kind not in ('register_source','update_source','archive_source') then raise exception 'Invalid source command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into prior from planning.commands where owner_id=actor and id=cid;
 if found then
  if prior.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return prior.result;
 end if;
 select * into p from planning.projects where id=pid and owner_id=actor for update;
 if not found then raise exception 'Project not found' using errcode='P0002'; end if;
 if p.lifecycle<>'active' then raise exception 'Restore this project before editing' using errcode='22023'; end if;
 if p.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if kind='register_source' then
  if (command-array['id','projectId','revision','action','sourceId','attachmentId','note','meaning'])<>'{}'::jsonb
   or coalesce(command->>'sourceId','') !~ '^[0-9a-fA-F-]{36}$' or coalesce(command->>'attachmentId','') !~ '^[0-9a-fA-F-]{36}$'
   or char_length(coalesce(command->>'note',''))>4000 or coalesce(command->>'meaning','undecided') not in ('use','avoid','undecided') then raise exception 'Invalid source command' using errcode='22023'; end if;
  if exists(select 1 from planning.project_sources where id=(command->>'sourceId')::uuid)
   or exists(select 1 from planning.project_sources where project_id=pid and attachment_id=(command->>'attachmentId')::uuid) then raise exception 'Source already registered' using errcode='22023'; end if;
  select * into attachment_row from account_private.attachments where id=(command->>'attachmentId')::uuid and owner_id=actor and state='ready' for update;
  if not found then raise exception 'Source file is unavailable' using errcode='P0002'; end if;
  insert into planning.project_sources(id,project_id,owner_id,attachment_id,name,mime_type,byte_size,note,meaning)
   values((command->>'sourceId')::uuid,pid,actor,attachment_row.id,attachment_row.name,attachment_row.mime_type,attachment_row.byte_size,coalesce(command->>'note',''),coalesce(command->>'meaning','undecided'));
 elsif kind='update_source' then
  if (command-array['id','projectId','revision','action','sourceId','note','meaning'])<>'{}'::jsonb
   or coalesce(command->>'sourceId','') !~ '^[0-9a-fA-F-]{36}$'
   or (command ? 'note' and (jsonb_typeof(command->'note') is distinct from 'string' or char_length(command->>'note')>4000))
   or (command ? 'meaning' and coalesce(command->>'meaning','') not in ('use','avoid','undecided')) then raise exception 'Invalid source command' using errcode='22023'; end if;
  select * into source_row from planning.project_sources where id=(command->>'sourceId')::uuid and project_id=pid and owner_id=actor for update;
  if not found then raise exception 'Source not found' using errcode='P0002'; end if;
  update planning.project_sources set note=case when command ? 'note' then command->>'note' else note end,
   meaning=case when command ? 'meaning' then command->>'meaning' else meaning end,updated_at=clock_timestamp()
   where id=source_row.id;
 elsif kind='archive_source' then
  if (command-array['id','projectId','revision','action','sourceId','archived'])<>'{}'::jsonb
   or coalesce(command->>'sourceId','') !~ '^[0-9a-fA-F-]{36}$' or jsonb_typeof(command->'archived') is distinct from 'boolean' then raise exception 'Invalid source command' using errcode='22023'; end if;
  update planning.project_sources set archived=(command->>'archived')::boolean,updated_at=clock_timestamp()
   where id=(command->>'sourceId')::uuid and project_id=pid and owner_id=actor;
  if not found then raise exception 'Source not found' using errcode='P0002'; end if;
 end if;
 next_thinking:=p.thinking;
 if jsonb_typeof(next_thinking->'undo')='object'
   and coalesce(next_thinking->'undo'->>'revision','') ~ '^[0-9]+$'
   and (next_thinking->'undo'->>'revision')::integer=expected then
  next_thinking:=jsonb_set(next_thinking,'{undo,revision}',to_jsonb(expected+1),true);
 end if;
 update planning.projects set thinking=next_thinking,revision=revision+1,updated_at=clock_timestamp() where id=pid returning * into p;
 insert into planning.history(project_id,revision,action,after_item,context)
  values(pid,p.revision,'project_'||kind,null,jsonb_build_object('sourceId',command->>'sourceId'));
 result:=public.project_snapshot(pid);
 insert into planning.commands(owner_id,id,project_id,request,result) values(actor,cid,pid,command,result);
 return result;
end;
$$;
revoke all on function public.project_source_command(jsonb) from public,anon;
grant execute on function public.project_source_command(jsonb) to authenticated;
