-- Personal library data uses the same live-session and ownership boundaries as plans.
create table planning.folders (
 id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(char_length(trim(name)) between 1 and 120),
 revision integer not null default 1 check(revision>0), unique(id,owner_id)
);
alter table planning.projects add column folder_id uuid;
alter table planning.projects add column lifecycle text not null default 'active' check(lifecycle in ('active','archived','trashed'));
alter table planning.projects add constraint project_folder_owner foreign key(folder_id,owner_id) references planning.folders(id,owner_id);
create index projects_folder on planning.projects(folder_id,owner_id);
create table planning.ideas (
 id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
 body text not null default '' check(char_length(body)<=12000),
 revision integer not null default 1 check(revision>0), updated_at timestamptz not null default now(),
 project_id uuid references planning.projects(id), trashed boolean not null default false
);
create index ideas_owner on planning.ideas(owner_id,updated_at desc);
create index ideas_project on planning.ideas(project_id);
create table planning.library_receipts (
 owner_id uuid not null references auth.users(id) on delete cascade, id uuid not null,
 request jsonb not null, result jsonb not null, primary key(owner_id,id)
);
alter table planning.folders enable row level security;
create policy own_rows on planning.folders to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy live_session_and_mfa on planning.folders as restrictive to authenticated using((select account_private.access_status())='ok') with check((select account_private.access_status())='ok');
grant select,insert ,update on planning.folders to authenticated;
alter table planning.ideas enable row level security;
create policy own_rows on planning.ideas to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy live_session_and_mfa on planning.ideas as restrictive to authenticated using((select account_private.access_status())='ok') with check((select account_private.access_status())='ok');
grant select,insert ,update on planning.ideas to authenticated;
alter table planning.library_receipts enable row level security;
create policy own_rows on planning.library_receipts to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy live_session_and_mfa on planning.library_receipts as restrictive to authenticated using((select account_private.access_status())='ok') with check((select account_private.access_status())='ok');
grant select,insert on planning.library_receipts to authenticated;
create function public.library_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'folders',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'revision',revision) order by lower(name)) from planning.folders),'[]'::jsonb),
 'ideas',coalesce((select jsonb_agg(jsonb_build_object('id',id,'body',body,'revision',revision,'updatedAt',updated_at,'projectId',project_id,'trashed',trashed) order by updated_at desc) from planning.ideas),'[]'::jsonb));
$$;
create or replace function public.list_projects() returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(s order by s."updatedAt" desc),'[]'::jsonb) from (
 select p.id,p.name,p.description,p.revision,p.updated_at as "updatedAt",p.folder_id as "folderId",p.lifecycle,
 (select count(*) from planning.items i where i.project_id=p.id and not i.removed) as "itemCount" from planning.projects p) s;
$$;
create or replace function public.project_snapshot(project_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'revision',p.revision,'updatedAt',p.updated_at,'folderId',p.folder_id,'lifecycle',p.lifecycle,'originalIdea',(select body from planning.ideas where project_id=p.id limit 1),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'body',i.body,'category',i.category,'certainty',i.certainty,'status',i.status,'answer',i.answer,'links',i.links,'removed',i.removed,'source',i.source,'promotedFrom',i.promoted_from) order by i.created_at,i.id) from planning.items i where i.project_id=p.id),'[]'::jsonb))
 from planning.projects p where p.id=project_id;
$$;
create or replace function public.execute_command(command jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid(); pid uuid:=(command->>'projectId')::uuid; cid uuid:=(command->>'id')::uuid;
 expected integer:=(command->>'expectedRevision')::integer; a jsonb:=command->'action'; kind text:=a->>'type';
 iid uuid:=(a->>'itemId')::uuid; data jsonb:=a->'item'; previous planning.commands;
 p planning.projects; target planning.items; before_state jsonb; after_state jsonb; context_data jsonb; result jsonb; link_ids uuid[];
begin
 if octet_length(command::text)>110000 then raise exception 'Command too large' using errcode='22023'; end if;
 if actor is null then raise exception 'Sign in required' using errcode='28000'; end if;
 if cid is null or pid is null or expected is null or expected<0 or kind is null then raise exception 'Invalid command' using errcode='22023'; end if;
 -- Serialize identical retry keys before checking their receipt, including create.
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into previous from planning.commands c where c.owner_id=actor and c.id=cid;
 if found then
  if previous.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return previous.result;
 end if;
 if kind='create_project' then
  if expected<>0 then raise exception 'Revision conflict' using errcode='PT409'; end if;
  insert into planning.projects(id,owner_id,name,description) values(pid,actor,coalesce(nullif(trim(a->>'name'),''),'Untitled Project'),coalesce(a->>'description',''));
 end if;
 select * into p from planning.projects where id=pid for update;
 if not found then raise exception 'Project not found' using errcode='P0002'; end if;
 if p.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if p.lifecycle<>'active' and kind not in ('set_project_lifecycle') then
  raise exception 'Restore this project before editing' using errcode='22023';
 end if;
 if kind='update_project' then
  before_state:=jsonb_build_object('title',p.name,'body',p.description,'folderId',p.folder_id);
  if nullif(a->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(a->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
  update planning.projects set name=trim(a->>'name'),description=a->>'description',folder_id=nullif(a->>'folderId','')::uuid where id=pid;
 elsif kind='set_project_lifecycle' then
  before_state:=jsonb_build_object('lifecycle',p.lifecycle);
  if a->>'lifecycle' is null or a->>'lifecycle' not in ('active','archived','trashed') then raise exception 'Invalid state' using errcode='22023'; end if;
  update planning.projects set lifecycle=a->>'lifecycle' where id=pid;
 elsif kind='rename_project' then
  before_state:=jsonb_build_object('title',p.name,'body',p.description);
  update planning.projects set name=trim(a->>'name') where id=pid;
 elsif kind in ('add_item','edit_item') then
  if iid is null or data is null then raise exception 'Invalid item' using errcode='22023'; end if;
  if jsonb_typeof(data->'links')<>'array' or jsonb_array_length(data->'links')>100 then raise exception 'Invalid links' using errcode='22023'; end if;
  select coalesce(array_agg(value::uuid),'{}') into link_ids from jsonb_array_elements_text(data->'links');
  if exists(select 1 from unnest(link_ids) x where x=iid or not exists(select 1 from planning.items i where i.id=x and i.project_id=pid and not i.removed)) then raise exception 'Linked item not found' using errcode='22023'; end if;
  if data->>'category'='question' and data->>'status' not in ('open','answered','deferred') then raise exception 'Invalid question status' using errcode='22023'; end if;
  if data->>'category'='gap' and data->>'status'='answered' then raise exception 'Invalid gap status' using errcode='22023'; end if;
  if data->>'category' not in ('question','gap') and data->>'status'<>'open' then raise exception 'Status belongs to questions and gaps' using errcode='22023'; end if;
  if data->>'status' in ('answered','resolved') and coalesce(trim(data->>'answer'),'')='' then raise exception 'Add an answer or resolution' using errcode='22023'; end if;
  if kind='add_item' then
   insert into planning.items(id,project_id,title,body,category,certainty,status,answer,links) values(iid,pid,trim(data->>'title'),data->>'body',data->>'category',data->>'certainty',data->>'status',data->>'answer',link_ids);
  else
   select * into target from planning.items where id=iid and project_id=pid and not removed;
   if not found then raise exception 'Item not found' using errcode='P0002'; end if;
   before_state:=to_jsonb(target);
   update planning.items set title=trim(data->>'title'),body=data->>'body',category=data->>'category',certainty=data->>'certainty',status=data->>'status',answer=data->>'answer',links=link_ids where id=iid and project_id=pid;
  end if;
 elsif kind in ('remove_item','restore_item','promote_answer') then
  select * into target from planning.items where id=iid and project_id=pid;
  if not found then raise exception 'Item not found' using errcode='P0002'; end if;
  before_state:=to_jsonb(target);
  if kind='promote_answer' then
   if target.removed or target.category<>'question' or target.status<>'answered' or trim(target.answer)='' then raise exception 'Answer the question first' using errcode='22023'; end if;
   -- Repeat promotion preserves the already-created decision, including later edits/removal.
   if not exists(select 1 from planning.items where promoted_from=iid) then
    insert into planning.items(id,project_id,title,body,category,certainty,source,promoted_from,links) values((a->>'decisionId')::uuid,pid,left(regexp_replace(target.answer,E'[\n\r]+',' ','g'),200),target.answer,'decision','confirmed','Answer to a project question',iid,array[iid]);
   end if;
  else
   update planning.items set removed=(kind='remove_item') where id=iid;
  end if;
 elsif kind<>'create_project' then
  raise exception 'Unknown command' using errcode='22023';
 end if;
 -- Changing related meaning reopens resolved gaps for review, never overwrites the explanation.
 if kind in ('edit_item','remove_item','restore_item') then
  select jsonb_build_object('recheckedGaps',coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title)),'[]'::jsonb)) into context_data from planning.items where project_id=pid and category='gap' and status='resolved' and iid=any(links) and id<>iid and not removed;
  update planning.items set status='recheck' where project_id=pid and category='gap' and status='resolved' and iid=any(links) and id<>iid and not removed;
 end if;
 update planning.projects set revision=revision+1,updated_at=clock_timestamp() where id=pid returning * into p;
 if kind in ('create_project','rename_project','update_project','set_project_lifecycle') then
  after_state:=jsonb_build_object('title',p.name,'body',p.description,'folderId',p.folder_id,'lifecycle',p.lifecycle);
 elsif kind='promote_answer' then
  select to_jsonb(i) into after_state from planning.items i where i.promoted_from=iid and i.project_id=pid;
 else
  select to_jsonb(i) into after_state from planning.items i where i.id=iid and i.project_id=pid;
 end if;
 insert into planning.history(project_id,revision,action,before_item,after_item,context) values(pid,p.revision,kind,before_state,after_state,coalesce(context_data,'{}'::jsonb));
 result:=public.project_snapshot(pid);
 insert into planning.commands(owner_id,id,project_id,request,result) values(actor,cid,pid,command,result);
 return result;
end;
$$;

create function public.library_command(command jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid(); cid uuid:=(command->>'id')::uuid; target_id uuid:=(command->>'targetId')::uuid;
 kind text:=command->>'type'; expected integer:=(command->>'expectedRevision')::integer;
 prior planning.library_receipts; idea planning.ideas; folder planning.folders; result jsonb; pid uuid; created jsonb;
begin
 if actor is null or public.account_access()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 if octet_length(command::text)>110000 or cid is null or target_id is null or kind is null or expected is null or expected<0 then raise exception 'Invalid command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into prior from planning.library_receipts where owner_id=actor and id=cid;
 if found then
  if prior.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return prior.result;
 end if;
 if kind='save_folder' then
  if expected=0 then
   insert into planning.folders(id,owner_id,name) values(target_id,actor,trim(command->>'name'));
  else
   select * into folder from planning.folders where id=target_id for update;
   if not found then raise exception 'Folder not found' using errcode='P0002'; end if;
   if folder.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
   update planning.folders set name=trim(command->>'name'),revision=revision+1 where id=target_id;
  end if;
 elsif kind='save_idea' and expected=0 then
  insert into planning.ideas(id,owner_id,body) values(target_id,actor,command->>'body');
 elsif kind in ('save_idea','trash_idea','restore_idea','convert_idea') then
  select * into idea from planning.ideas where id=target_id for update;
  if not found then raise exception 'Idea not found' using errcode='P0002'; end if;
  if idea.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
  if kind='save_idea' then
   if idea.project_id is not null or idea.trashed then raise exception 'Idea is read only' using errcode='22023'; end if;
   update planning.ideas set body=command->>'body' where id=target_id;
  elsif kind='convert_idea' then
   if idea.project_id is not null or idea.trashed or trim(idea.body)='' then raise exception 'Idea cannot be converted' using errcode='22023'; end if;
   if nullif(command->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(command->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
   pid:=(command->>'projectId')::uuid;
   created:=public.execute_command(jsonb_build_object('id',cid,'projectId',pid,'expectedRevision',0,'action',jsonb_build_object('type','create_project','name',command->>'name','description',idea.body)));
   update planning.projects set folder_id=nullif(command->>'folderId','')::uuid where id=pid;
   update planning.ideas set project_id=pid where id=target_id;
  else
   update planning.ideas set trashed=(kind='trash_idea') where id=target_id;
  end if;
  update planning.ideas set revision=revision+1,updated_at=clock_timestamp() where id=target_id;
 else raise exception 'Unknown command' using errcode='22023';
 end if;
 result:=public.library_snapshot();
 insert into planning.library_receipts values(actor,cid,command,result);
 return result;
end;
$$;
revoke all on function public.library_snapshot(),public.library_command(jsonb) from public,anon;
grant execute on function public.library_snapshot(),public.library_command(jsonb) to authenticated;
