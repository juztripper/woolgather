-- Identifier tombstones prevent old folder-save retries from recreating a deleted folder.
create table planning.deleted_folders (
 id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade
);
alter table planning.deleted_folders enable row level security;
create policy own_rows on planning.deleted_folders to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy live_session_and_mfa on planning.deleted_folders as restrictive to authenticated using((select account_private.access_status())='ok') with check((select account_private.access_status())='ok');
grant select,insert on planning.deleted_folders to authenticated;
grant delete on planning.folders to authenticated;
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
