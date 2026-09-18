-- Exact, revision-checked trash selections; receipts contain identifiers only.
create table planning.trash_receipts (
 owner_id uuid not null references auth.users(id) on delete cascade,
 id uuid not null, request jsonb not null, project_ids uuid[] not null, idea_ids uuid[] not null,
 primary key(owner_id,id)
);
alter table planning.trash_receipts enable row level security;
create policy own_rows on planning.trash_receipts to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy live_session_and_mfa on planning.trash_receipts as restrictive to authenticated using((select account_private.access_status())='ok') with check((select account_private.access_status())='ok');
grant select,insert on planning.trash_receipts to authenticated;
create index trash_projects on planning.trash_receipts using gin(project_ids);
create index trash_ideas on planning.trash_receipts using gin(idea_ids);
grant delete on planning.projects,planning.ideas,planning.library_receipts to authenticated;
grant update on planning.library_receipts to authenticated;
create policy only_trashed on planning.projects as restrictive for delete to authenticated using(lifecycle='trashed');
create policy only_trashed on planning.ideas as restrictive for delete to authenticated using(trashed or exists(select 1 from planning.projects p where p.id=project_id and p.lifecycle='trashed'));
create function public.delete_trash(command jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid(); cid uuid:=(command->>'id')::uuid; prior planning.trash_receipts;
 entry jsonb; p planning.projects; i planning.ideas; pids uuid[]:='{}'; iids uuid[]:='{}';
begin
 if actor is null or public.account_access()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 if cid is null or octet_length(command::text)>110000 or jsonb_typeof(command->'projects') is distinct from 'array' or jsonb_typeof(command->'ideas') is distinct from 'array' then raise exception 'Invalid selection' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 select * into prior from planning.trash_receipts where owner_id=actor and id=cid;
 if found then
  if prior.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return jsonb_build_object('projects',prior.project_ids,'ideas',prior.idea_ids);
 end if;
 for entry in select value from jsonb_array_elements(command->'projects') loop
  select * into p from planning.projects where id=(entry->>'id')::uuid for update;
  if not found or p.lifecycle<>'trashed' or p.revision is distinct from (entry->>'revision')::integer then raise exception 'Trash changed. Close this dialog and reload before deleting.' using errcode='PT409'; end if;
  pids:=array_append(pids,p.id);
 end loop;
 for entry in select value from jsonb_array_elements(command->'ideas') loop
  select * into i from planning.ideas where id=(entry->>'id')::uuid for update;
  if not found or not i.trashed or i.revision is distinct from (entry->>'revision')::integer or (i.project_id is not null and not i.project_id=any(pids)) then raise exception 'Trash changed. Close this dialog and reload before deleting.' using errcode='PT409'; end if;
  iids:=array_append(iids,i.id);
 end loop;
 select iids||coalesce(array_agg(id),'{}'::uuid[]) into iids from planning.ideas where project_id=any(pids);
 if cardinality(pids)+cardinality(iids)=0 then raise exception 'Select something in Trash' using errcode='22023'; end if;
 insert into planning.trash_receipts values(actor,cid,command,pids,iids);
 -- Remove all retained copies, including snapshots in unrelated library receipts.
 delete from planning.library_receipts where (request->>'targetId')::uuid=any(iids);
 update planning.library_receipts r set result=jsonb_set(r.result,'{ideas}',coalesce((select jsonb_agg(v) from jsonb_array_elements(r.result->'ideas') v where not (v->>'id')::uuid=any(iids)),'[]'::jsonb));
 delete from planning.ideas where id=any(iids);
 delete from planning.projects where id=any(pids);
 return jsonb_build_object('projects',pids,'ideas',iids);
end;
$$;
revoke all on function public.delete_trash(jsonb) from public,anon;
grant execute on function public.delete_trash(jsonb) to authenticated;

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
 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 if exists(select 1 from planning.trash_receipts where project_ids @> array[pid]) then raise exception 'Project permanently deleted' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into previous from planning.commands c where c.owner_id=actor and c.id=cid;
 if found then
  if previous.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return previous.result;
 end if;
 if kind='create_project' then
  if expected<>0 then raise exception 'Revision conflict' using errcode='PT409'; end if;
  if nullif(a->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(a->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
  insert into planning.projects(id,owner_id,name,description,folder_id) values(pid,actor,coalesce(nullif(trim(a->>'name'),''),'Untitled Project'),coalesce(a->>'description',''),nullif(a->>'folderId','')::uuid);
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
create or replace function public.library_command(command jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid(); cid uuid:=(command->>'id')::uuid; target_id uuid:=(command->>'targetId')::uuid;
 kind text:=command->>'type'; expected integer:=(command->>'expectedRevision')::integer;
 prior planning.library_receipts; idea planning.ideas; folder planning.folders; result jsonb; pid uuid; created jsonb;
begin
 if actor is null or public.account_access()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 if octet_length(command::text)>110000 or cid is null or target_id is null or kind is null or expected is null or expected<0 then raise exception 'Invalid command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 if exists(select 1 from planning.trash_receipts where idea_ids @> array[target_id] or project_ids @> array[(command->>'projectId')::uuid]) then raise exception 'Item permanently deleted' using errcode='P0002'; end if;
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
