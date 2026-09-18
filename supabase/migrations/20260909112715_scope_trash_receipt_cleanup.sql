-- Hosted safe-update protection requires an explicit owner predicate.
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
  if not found or not i.trashed or i.revision is distinct from (entry->>'revision')::integer or (i.project_id is not null and not i.project_id=any(pids)) then raise exception 'Trash changed. Close this dialog and reload before deleting.' using errcode='PT409'; end if;
  iids:=array_append(iids,i.id);
 end loop;
 select iids||coalesce(array_agg(id),'{}'::uuid[]) into iids from planning.ideas where project_id=any(pids);
 if cardinality(pids)+cardinality(iids)=0 then raise exception 'Select something in Trash' using errcode='22023'; end if;
 insert into planning.trash_receipts values(actor,cid,command,pids,iids);
 -- Remove all retained copies, including snapshots in unrelated library receipts.
 delete from planning.library_receipts where (request->>'targetId')::uuid=any(iids);
 update planning.library_receipts r set result=jsonb_set(r.result,'{ideas}',coalesce((select jsonb_agg(v) from jsonb_array_elements(r.result->'ideas') v where not (v->>'id')::uuid=any(iids)),'[]'::jsonb)) where r.owner_id=actor and cardinality(iids)>0;
 delete from planning.ideas where id=any(iids);
 delete from planning.projects where id=any(pids);
 return jsonb_build_object('projects',pids,'ideas',iids);
end;
$$;
