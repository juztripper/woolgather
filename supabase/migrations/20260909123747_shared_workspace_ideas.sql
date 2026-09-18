-- Folders are workspace locations shared by projects and ideas.
alter table planning.ideas add column folder_id uuid;
alter table planning.ideas add column archived boolean not null default false;
alter table planning.ideas add constraint idea_folder_owner foreign key(folder_id,owner_id) references planning.folders(id,owner_id);
alter table planning.ideas add constraint idea_single_lifecycle check(not (archived and trashed));
create index ideas_folder on planning.ideas(folder_id,owner_id);
-- Preserve existing converted ideas next to their project without changing their text.
update planning.ideas i set folder_id=p.folder_id from planning.projects p where i.project_id=p.id;
-- Source evidence survives independent organization/deletion of the original idea.
alter table planning.projects add column original_idea text;
update planning.projects p set original_idea=i.body from planning.ideas i where i.project_id=p.id;

create or replace function public.library_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'folders',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'revision',revision) order by lower(name)) from planning.folders),'[]'::jsonb),
 'ideas',coalesce((select jsonb_agg(jsonb_build_object('id',id,'body',body,'revision',revision,'updatedAt',updated_at,'projectId',project_id,'trashed',trashed,'archived',archived,'folderId',folder_id) order by updated_at desc) from planning.ideas),'[]'::jsonb));
$$;
create or replace function public.project_snapshot(project_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'revision',p.revision,'updatedAt',p.updated_at,'folderId',p.folder_id,'lifecycle',p.lifecycle,'originalIdea',p.original_idea,
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'body',i.body,'category',i.category,'certainty',i.certainty,'status',i.status,'answer',i.answer,'links',i.links,'removed',i.removed,'source',i.source,'promotedFrom',i.promoted_from) order by i.created_at,i.id) from planning.items i where i.project_id=p.id),'[]'::jsonb))
 from planning.projects p where p.id=project_id;
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
 if kind='save_folder' and exists(select 1 from planning.deleted_folders where id=target_id) then raise exception 'Folder deleted' using errcode='P0002'; end if;
 if kind='delete_folder' then
  select * into folder from planning.folders where id=target_id for update;
  if not found then raise exception 'Folder not found' using errcode='P0002'; end if;
  if folder.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
  update planning.projects set folder_id=null,revision=revision+1,updated_at=clock_timestamp() where folder_id=target_id;
  update planning.ideas set folder_id=null,revision=revision+1,updated_at=clock_timestamp() where folder_id=target_id;
  insert into planning.deleted_folders values(target_id,actor);
  delete from planning.folders where id=target_id;
 elsif kind='save_folder' then
  if expected=0 then
   insert into planning.folders(id,owner_id,name) values(target_id,actor,trim(command->>'name'));
  else
   select * into folder from planning.folders where id=target_id for update;
   if not found then raise exception 'Folder not found' using errcode='P0002'; end if;
   if folder.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
   update planning.folders set name=trim(command->>'name'),revision=revision+1 where id=target_id;
  end if;
 elsif kind='save_idea' and expected=0 then
  if nullif(command->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(command->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
  insert into planning.ideas(id,owner_id,body,folder_id) values(target_id,actor,command->>'body',nullif(command->>'folderId','')::uuid);
 elsif kind in ('save_idea','move_idea','archive_idea','trash_idea','restore_idea','convert_idea') then
  select * into idea from planning.ideas where id=target_id for update;
  if not found then raise exception 'Idea not found' using errcode='P0002'; end if;
  if idea.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
  if kind='save_idea' then
   if idea.project_id is not null or idea.trashed or idea.archived then raise exception 'Idea is read only' using errcode='22023'; end if;
   update planning.ideas set body=command->>'body' where id=target_id;
  elsif kind='move_idea' then
   if idea.trashed or idea.archived then raise exception 'Restore this idea before moving it' using errcode='22023'; end if;
   if nullif(command->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(command->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
   update planning.ideas set folder_id=nullif(command->>'folderId','')::uuid where id=target_id;
  elsif kind='convert_idea' then
   if idea.project_id is not null or idea.trashed or idea.archived or trim(idea.body)='' then raise exception 'Idea cannot be converted' using errcode='22023'; end if;
   if nullif(command->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(command->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
   pid:=(command->>'projectId')::uuid;
   created:=public.execute_command(jsonb_build_object('id',cid,'projectId',pid,'expectedRevision',0,'action',jsonb_build_object('type','create_project','name',command->>'name','description',idea.body)));
   update planning.projects set folder_id=nullif(command->>'folderId','')::uuid,original_idea=idea.body where id=pid;
   update planning.ideas set project_id=pid,folder_id=nullif(command->>'folderId','')::uuid where id=target_id;
  else
   update planning.ideas set trashed=(kind='trash_idea'),archived=(kind='archive_idea') where id=target_id;
  end if;
  update planning.ideas set revision=revision+1,updated_at=clock_timestamp() where id=target_id;
 else raise exception 'Unknown command' using errcode='22023';
 end if;
 result:=public.library_snapshot();
 insert into planning.library_receipts values(actor,cid,command,result);
 return result;
end;
$$;
create or replace function public.delete_trash(command jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
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
  if not found or not i.trashed or i.revision is distinct from (entry->>'revision')::integer then raise exception 'Trash changed. Close this dialog and reload before deleting.' using errcode='PT409'; end if;
  iids:=array_append(iids,i.id);
 end loop;

 if cardinality(pids)+cardinality(iids)=0 then raise exception 'Select something in Trash' using errcode='22023'; end if;
 insert into planning.trash_receipts values(actor,cid,command,pids,iids);
 -- Remove all retained copies, including snapshots in unrelated library receipts.
 delete from planning.library_receipts where (request->>'targetId')::uuid=any(iids) or (request->>'projectId')::uuid=any(pids);
 update planning.library_receipts r set result=jsonb_set(r.result,'{ideas}',coalesce((select jsonb_agg(v) from jsonb_array_elements(r.result->'ideas') v where not (v->>'id')::uuid=any(iids)),'[]'::jsonb)) where r.owner_id=actor and cardinality(iids)>0;
 delete from planning.ideas where id=any(iids);
 -- A project and its original idea are independent workspace items.
 update planning.ideas set project_id=null,revision=revision+1,updated_at=clock_timestamp() where project_id=any(pids);
 delete from planning.projects where id=any(pids);
 return jsonb_build_object('projects',pids,'ideas',iids);
end;
$$;
