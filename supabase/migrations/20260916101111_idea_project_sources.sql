-- Every conversion must register the original private files before its first
-- snapshot is returned. Only insertion does this: reopening, renaming and
-- restoring must never resurrect a deliberately deleted source.
create function planning.inherit_idea_sources() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into planning.project_sources
   (id,project_id,owner_id,attachment_id,name,mime_type,byte_size)
 select gen_random_uuid(),new.id,new.owner_id,a.id,a.name,a.mime_type,a.byte_size
 from account_private.attachments a
 where a.owner_id=new.owner_id and a.state='ready'
   and new.idea_document->'attachments' @> jsonb_build_array(a.id::text)
 on conflict (project_id,attachment_id) do nothing;
 return new;
end;
$$;
revoke all on function planning.inherit_idea_sources() from public,anon,authenticated;
create trigger inherit_idea_sources after insert on planning.projects
 for each row execute function planning.inherit_idea_sources();

-- Repair missed handoffs. Deletion history does not retain an attachment ID,
-- so conservatively leave projects with an explicit source deletion alone.
-- Existing source IDs, notes and meaning are preserved.
insert into planning.project_sources
 (id,project_id,owner_id,attachment_id,name,mime_type,byte_size)
select gen_random_uuid(),p.id,p.owner_id,a.id,a.name,a.mime_type,a.byte_size
from planning.projects p
join account_private.attachments a on a.owner_id=p.owner_id and a.state='ready'
 and p.idea_document->'attachments' @> jsonb_build_array(a.id::text)
where not exists (
 select 1 from planning.history h
 where h.project_id=p.id and h.action='project_delete_source'
)
on conflict (project_id,attachment_id) do nothing;
