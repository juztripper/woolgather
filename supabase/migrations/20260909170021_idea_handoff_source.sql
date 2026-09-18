-- Preserve the exact reviewed handoff questions even after project questions evolve.
-- Structured details alone can form an idea; the initial free-writing field is optional.
create or replace function public.project_snapshot(project_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'revision',p.revision,'updatedAt',p.updated_at,'folderId',p.folder_id,'lifecycle',p.lifecycle,'originalIdea',p.original_idea,'ideaDocument',p.idea_document,'references',p.image_references,'ideaQuestions',coalesce((select h.context->'openQuestions' from planning.history h where h.project_id=p.id and h.revision=1),'[]'::jsonb),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'body',i.body,'category',i.category,'certainty',i.certainty,'status',i.status,'answer',i.answer,'links',i.links,'removed',i.removed,'source',i.source,'promotedFrom',i.promoted_from) order by i.created_at,i.id) from planning.items i where i.project_id=p.id),'[]'::jsonb))
 from planning.projects p where p.id=project_id;
$$;
create or replace function public.library_command(command jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid(); cid uuid:=(command->>'id')::uuid; target_id uuid:=(command->>'targetId')::uuid;
 kind text:=command->>'type'; expected integer:=(command->>'expectedRevision')::integer;
 prior planning.library_receipts; idea planning.ideas; folder planning.folders; result jsonb; pid uuid; created jsonb; q jsonb; project_revision integer; question_id uuid;
begin
 if actor is null or public.account_access()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 if octet_length(command::text)>200000 or cid is null or target_id is null or kind is null or expected is null or expected<0 then raise exception 'Invalid command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 if exists(select 1 from planning.trash_receipts where idea_ids @> array[target_id] or project_ids @> array[(command->>'projectId')::uuid]) then raise exception 'Item permanently deleted' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into prior from planning.library_receipts where owner_id=actor and id=cid;
 if found then
  if prior.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return prior.result;
 end if;
 if kind='save_idea' and command ? 'document' and not planning.validate_idea_document(command->'document') then raise exception 'Invalid idea document' using errcode='22023'; end if;
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
  insert into planning.ideas(id,owner_id,body,folder_id,document) values(target_id,actor,command->>'body',nullif(command->>'folderId','')::uuid,command->'document');
 elsif kind in ('save_idea','move_idea','archive_idea','trash_idea','restore_idea','convert_idea') then
  select * into idea from planning.ideas where id=target_id for update;
  if not found then raise exception 'Idea not found' using errcode='P0002'; end if;
  if idea.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
  if kind='save_idea' then
   if idea.project_id is not null or idea.trashed or idea.archived then raise exception 'Idea is read only' using errcode='22023'; end if;
   update planning.ideas set body=command->>'body',document=case when command ? 'document' then command->'document' else document end where id=target_id;
  elsif kind='move_idea' then
   if idea.trashed or idea.archived then raise exception 'Restore this idea before moving it' using errcode='22023'; end if;
   if nullif(command->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(command->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
   update planning.ideas set folder_id=nullif(command->>'folderId','')::uuid where id=target_id;
  elsif kind='convert_idea' then
   if idea.project_id is not null or idea.trashed or idea.archived or (trim(idea.body)='' and not exists(select 1 from jsonb_each_text(coalesce(idea.document->'answers','{}'::jsonb)) answer where trim(answer.value)<>'') and jsonb_array_length(coalesce(idea.document->'references','[]'::jsonb))=0 and jsonb_array_length(coalesce(idea.document->'questions','[]'::jsonb))=0) then raise exception 'Idea cannot be converted' using errcode='22023'; end if;
   if nullif(command->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(command->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
   if command ? 'brief' and (jsonb_typeof(command->'brief') is distinct from 'string' or char_length(command->>'brief')>12000) then raise exception 'Invalid brief' using errcode='22023'; end if;
   pid:=(command->>'projectId')::uuid;
   insert into planning.projects(id,owner_id,name,description,folder_id,original_idea,idea_document,image_references,revision) values(pid,actor,coalesce(nullif(trim(command->>'name'),''),'Untitled Project'),coalesce(command->>'brief',idea.body),nullif(command->>'folderId','')::uuid,idea.body,idea.document,coalesce(idea.document->'references','[]'::jsonb),1);
   if command ? 'questions' then
    if jsonb_typeof(command->'questions') is distinct from 'array' or jsonb_array_length(command->'questions')>15 then raise exception 'Invalid questions' using errcode='22023'; end if;
    for q in select value from jsonb_array_elements(command->'questions') loop
     if jsonb_typeof(q) is distinct from 'string' or char_length(trim(q#>>'{}')) not between 1 and 200 then raise exception 'Invalid question' using errcode='22023'; end if;
     question_id:=gen_random_uuid();
     insert into planning.items(id,project_id,title,body,category,certainty,status,source) values(question_id,pid,q#>>'{}','Carried forward from the idea. This is an open question, not a requirement.','question','tentative','open','Open question from original idea');
    end loop;
   end if;
   created:=public.project_snapshot(pid);
   insert into planning.history(project_id,revision,action,after_item,context) values(pid,1,'create_project',jsonb_build_object('title',created->>'name','body',created->>'description'),jsonb_build_object('sourceIdeaId',target_id,'openQuestions',coalesce(command->'questions','[]'::jsonb)));
   created:=public.project_snapshot(pid);
   insert into planning.commands(owner_id,id,project_id,request,result) values(actor,cid,pid,command,created);
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
