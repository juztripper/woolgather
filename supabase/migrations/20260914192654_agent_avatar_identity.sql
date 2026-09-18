-- Add a bounded, optional character identity to the existing transactional
-- agent metadata path. Older clients preserve an existing selection on edit.
-- Function ownership, privileges, revision checks and command receipts remain
-- unchanged; no new endpoint or storage bucket is introduced.
do $migration$
declare
 definition text;
 updated text;
begin
 select pg_get_functiondef('public.project_planning_command_before_permanent_delete(jsonb)'::regprocedure) into definition;
 updated := replace(definition, $old$elsif kind='upsert_agent' then$old$, $new$elsif kind='upsert_agent' then
  if command ? 'avatar' and (jsonb_typeof(command->'avatar') is distinct from 'string' or command->>'avatar' not in ('sprout','orbit','moss','spark','pebble','ripple')) then
   raise exception 'Invalid agent avatar' using errcode='22023';
  end if;$new$);
 if updated=definition then raise exception 'Agent metadata branch not found'; end if;
 definition:=updated;
 updated:=replace(definition, $old$  state:=jsonb_set(state,'{agents}',coalesce$old$, $new$  item:=item || case when command ? 'avatar' then jsonb_build_object('avatar',command->'avatar')
    else coalesce((select jsonb_build_object('avatar',x->'avatar') from jsonb_array_elements(state->'agents') x where x->>'id'=command->>'agentId' and x ? 'avatar'), '{}'::jsonb) end;
  state:=jsonb_set(state,'{agents}',coalesce$new$);
 if updated=definition then raise exception 'Agent metadata write not found'; end if;
 execute updated;

 select pg_get_functiondef('planning.validate_thinking_legacy(jsonb)'::regprocedure) into definition;
 updated:=replace(definition, $old$or jsonb_typeof(a->'scopeIds') is distinct from 'array'$old$, $new$or (a ? 'avatar' and (jsonb_typeof(a->'avatar') is distinct from 'string' or a->>'avatar' not in ('sprout','orbit','moss','spark','pebble','ripple')))
   or jsonb_typeof(a->'scopeIds') is distinct from 'array'$new$);
 if updated=definition then raise exception 'Agent validation not found'; end if;
 execute updated;
end;
$migration$;
