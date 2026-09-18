-- Developed ideas and small visual references share canonical ownership and session checks.
-- Image bytes are separate from documents, library listings, and command receipts.
create table planning.reference_images (
 id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
 mime_type text not null check(mime_type in ('image/png','image/jpeg','image/webp')),
 content bytea not null check(octet_length(content) between 1 and 330000),
 created_at timestamptz not null default now()
);
create index reference_images_owner on planning.reference_images(owner_id,created_at);
alter table planning.reference_images enable row level security;
create policy own_rows on planning.reference_images to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy live_session_and_mfa on planning.reference_images as restrictive to authenticated using((select account_private.access_status())='ok') with check((select account_private.access_status())='ok');
grant select,insert,delete on planning.reference_images to authenticated;
alter table planning.ideas add column document jsonb;
alter table planning.projects add column idea_document jsonb;
alter table planning.projects add column image_references jsonb not null default '[]'::jsonb;

create function planning.validate_references(refs jsonb) returns boolean language plpgsql stable security invoker set search_path='' as $$
declare r jsonb; seen uuid[]:='{}'; rid uuid;
begin
 if jsonb_typeof(refs) is distinct from 'array' or jsonb_array_length(refs)>8 then return false; end if;
 for r in select value from jsonb_array_elements(refs) loop
  if jsonb_typeof(r) is distinct from 'object' or (r - array['id','name','caption'])<>'{}'::jsonb then return false; end if;
  if jsonb_typeof(r->'id') is distinct from 'string' or jsonb_typeof(r->'name') is distinct from 'string' or jsonb_typeof(r->'caption') is distinct from 'string' then return false; end if;
  if char_length(r->>'name') not between 1 and 180 or char_length(r->>'caption')>1000 then return false; end if;
  rid:=(r->>'id')::uuid;
  if rid=any(seen) or not exists(select 1 from planning.reference_images where id=rid) then return false; end if;
  seen:=array_append(seen,rid);
 end loop;
 return true;
exception when invalid_text_representation then return false;
end;
$$;
create function planning.validate_idea_document(doc jsonb) returns boolean language plpgsql stable security invoker set search_path='' as $$
declare field text; q jsonb; seen uuid[]:='{}'; qid uuid;
begin
 if jsonb_typeof(doc) is distinct from 'object' or doc->'version' is distinct from '1'::jsonb or octet_length(doc::text)>110000 then return false; end if;
 if (doc - array['version','title','answers','covered','later','questions','references'])<>'{}'::jsonb or jsonb_typeof(doc->'title') is distinct from 'string' or char_length(doc->>'title')>120 then return false; end if;
 if jsonb_typeof(doc->'answers') is distinct from 'object' or ((doc->'answers') - array['purpose','audience','experience','context','constraints','possibilities'])<>'{}'::jsonb then return false; end if;
 foreach field in array array['purpose','audience','experience','context','constraints','possibilities'] loop
  if jsonb_typeof(doc->'answers'->field) is distinct from 'string' or char_length(doc->'answers'->>field)>2000 then return false; end if;
 end loop;
 foreach field in array array['covered','later'] loop
  if jsonb_typeof(doc->field) is distinct from 'array' or jsonb_array_length(doc->field)>6 then return false; end if;
  if exists(select 1 from jsonb_array_elements(doc->field) v where jsonb_typeof(v)<>'string' or (v#>>'{}') not in ('purpose','audience','experience','context','constraints','possibilities')) then return false; end if;
 end loop;
 if jsonb_typeof(doc->'questions') is distinct from 'array' or jsonb_array_length(doc->'questions')>12 then return false; end if;
 for q in select value from jsonb_array_elements(doc->'questions') loop
  if jsonb_typeof(q) is distinct from 'object' or (q - array['id','text','important'])<>'{}'::jsonb or jsonb_typeof(q->'id') is distinct from 'string' or jsonb_typeof(q->'text') is distinct from 'string' or jsonb_typeof(q->'important') is distinct from 'boolean' or char_length(trim(q->>'text')) not between 1 and 200 then return false; end if;
  qid:=(q->>'id')::uuid;
  if qid=any(seen) then return false; end if;
  seen:=array_append(seen,qid);
 end loop;
 return planning.validate_references(doc->'references');
exception when invalid_text_representation then return false;
end;
$$;

-- The same image may be referenced by an idea and its project's preserved source.
create function planning.image_is_referenced(image_id uuid) returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from planning.ideas where document->'references' @> jsonb_build_array(jsonb_build_object('id',image_id)))
 or exists(select 1 from planning.projects where image_references @> jsonb_build_array(jsonb_build_object('id',image_id)) or idea_document->'references' @> jsonb_build_array(jsonb_build_object('id',image_id)));
$$;
create function public.upload_reference_image(command jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid(); iid uuid:=(command->>'id')::uuid; uri text:=command->>'dataUrl'; mime text; bytes bytea; prior planning.reference_images;
begin
 if actor is null or public.account_access()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 if iid is null or uri is null or octet_length(command::text)>460000 or uri !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$' then raise exception 'Invalid image' using errcode='22023'; end if;
 mime:=split_part(split_part(uri,';',1),':',2);
 bytes:=decode(split_part(uri,',',2),'base64');
 if octet_length(bytes) not between 12 and 330000 then raise exception 'Image too large or invalid' using errcode='22023'; end if;
 if (mime='image/png' and substring(bytes from 1 for 8)<>decode('89504e470d0a1a0a','hex')) or
    (mime='image/jpeg' and substring(bytes from 1 for 3)<>decode('ffd8ff','hex')) or
    (mime='image/webp' and (substring(bytes from 1 for 4)<>decode('52494646','hex') or substring(bytes from 9 for 4)<>decode('57454250','hex'))) then raise exception 'Invalid image format' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 select * into prior from planning.reference_images where id=iid;
 if found then
  if prior.content<>bytes or prior.mime_type<>mime then raise exception 'Retry key reused with different image' using errcode='22023'; end if;
  return jsonb_build_object('id',iid);
 end if;
 -- Collect abandoned uploads on subsequent uploads; saved and source references survive.
 delete from planning.reference_images where created_at<now()-interval '1 day' and not planning.image_is_referenced(id);
 insert into planning.reference_images(id,owner_id,mime_type,content) values(iid,actor,mime,bytes);
 return jsonb_build_object('id',iid);
end;
$$;
create function public.reference_image(image_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',id,'dataUrl','data:'||mime_type||';base64,'||replace(encode(content,'base64'),E'\n','')) from planning.reference_images where id=image_id;
$$;
revoke all on function public.upload_reference_image(jsonb),public.reference_image(uuid) from public,anon;
grant execute on function public.upload_reference_image(jsonb),public.reference_image(uuid) to authenticated;
revoke all on function planning.validate_references(jsonb),planning.validate_idea_document(jsonb),planning.image_is_referenced(uuid) from public,anon;
grant execute on function planning.validate_references(jsonb),planning.validate_idea_document(jsonb),planning.image_is_referenced(uuid) to authenticated;

create or replace function public.library_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'folders',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'revision',revision) order by lower(name)) from planning.folders),'[]'::jsonb),
 'ideas',coalesce((select jsonb_agg(jsonb_build_object('id',id,'body',body,'document',document,'revision',revision,'updatedAt',updated_at,'projectId',project_id,'trashed',trashed,'archived',archived,'folderId',folder_id) order by updated_at desc) from planning.ideas),'[]'::jsonb));
$$;
create or replace function public.project_snapshot(project_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'revision',p.revision,'updatedAt',p.updated_at,'folderId',p.folder_id,'lifecycle',p.lifecycle,'originalIdea',p.original_idea,'ideaDocument',p.idea_document,'references',p.image_references,
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
 if kind='update_references' then
  if not planning.validate_references(a->'references') then raise exception 'Invalid image references' using errcode='22023'; end if;
  before_state:=jsonb_build_object('references',p.image_references);
  update planning.projects set image_references=a->'references' where id=pid;
 elsif kind='update_project' then
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
 if kind='update_references' then
  after_state:=jsonb_build_object('references',p.image_references);
 elsif kind in ('create_project','rename_project','update_project','set_project_lifecycle') then
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
   if idea.project_id is not null or idea.trashed or idea.archived or trim(idea.body)='' then raise exception 'Idea cannot be converted' using errcode='22023'; end if;
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
create or replace function public.delete_trash(command jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid(); cid uuid:=(command->>'id')::uuid; prior planning.trash_receipts;
 entry jsonb; p planning.projects; i planning.ideas; pids uuid[]:='{}'; iids uuid[]:='{}'; image_ids uuid[]:='{}';
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
 select coalesce(array_agg(distinct (r->>'id')::uuid),'{}') into image_ids from (
  select jsonb_array_elements(coalesce(document->'references','[]'::jsonb)) r from planning.ideas where id=any(iids)
  union all select jsonb_array_elements(image_references) r from planning.projects where id=any(pids)
  union all select jsonb_array_elements(coalesce(idea_document->'references','[]'::jsonb)) r from planning.projects where id=any(pids)
 ) assets;
 -- Remove all retained copies, including snapshots in unrelated library receipts.
 delete from planning.library_receipts where (request->>'targetId')::uuid=any(iids) or (request->>'projectId')::uuid=any(pids);
 update planning.library_receipts r set result=jsonb_set(r.result,'{ideas}',coalesce((select jsonb_agg(v) from jsonb_array_elements(r.result->'ideas') v where not (v->>'id')::uuid=any(iids)),'[]'::jsonb)) where r.owner_id=actor and cardinality(iids)>0;
 delete from planning.ideas where id=any(iids);
 -- A project and its original idea are independent workspace items.
 update planning.ideas set project_id=null,revision=revision+1,updated_at=clock_timestamp() where project_id=any(pids);
 delete from planning.projects where id=any(pids);
 delete from planning.reference_images where id=any(image_ids) and not planning.image_is_referenced(id);
 return jsonb_build_object('projects',pids,'ideas',iids);
end;
$$;
