-- Trashing a project releases its separate idea. The project keeps its source snapshot.
create function planning.release_trashed_project_idea() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  update planning.ideas
  set project_id = null, revision = revision + 1, updated_at = clock_timestamp()
  where project_id = new.id and owner_id = new.owner_id;
  return new;
end;
$$;
revoke all on function planning.release_trashed_project_idea() from public, anon;
create trigger release_trashed_project_idea
  after update of lifecycle on planning.projects
  for each row when (new.lifecycle = 'trashed' and old.lifecycle is distinct from new.lifecycle)
  execute function planning.release_trashed_project_idea();

-- Repair ideas linked to projects already in Trash without changing their content.
update planning.ideas i
set project_id = null, revision = i.revision + 1, updated_at = clock_timestamp()
from planning.projects p
where i.project_id = p.id and i.owner_id = p.owner_id and p.lifecycle = 'trashed';
