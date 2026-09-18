-- Provider-confirmed closure and final cost settlement are separate facts.
-- Keep uncertain monetary holds, but do not let a confirmed closed call block
-- content deletion. Unconfirmed/active calls still block the transaction.
do $migration$
declare
 target text;
 definition text;
 updated text;
begin
 foreach target in array array[
  'planning.delete_project_conversation(jsonb)',
  'planning.delete_project_source(jsonb)'
 ] loop
  select pg_get_functiondef(target::regprocedure) into definition;
  updated:=replace(definition,
   $old$where project_id=pid and status in ('reserved','running','closing','unknown')$old$,
   $new$where project_id=pid and (status in ('reserved','running','closing') or (status='unknown' and closed_at is null))$new$);
  if updated=definition then raise exception 'Voice deletion guard not found in %',target; end if;
  definition:=updated;

  if target='planning.delete_project_conversation(jsonb)' then
   -- Retain the unresolved run's capability, provider identity and cost hold.
   -- Removing its content pointer activates existing transcript redaction for
   -- late settlement without preventing that settlement from finalizing cost.
   updated:=replace(definition,
    $old$where project_id=pid and conversation_id=target_id
   and status in ('completed','failed','cancelled');$old$,
    $new$where project_id=pid and conversation_id=target_id
   and (status in ('completed','failed','cancelled') or (status='unknown' and closed_at is not null));$new$);
   if updated=definition then raise exception 'Voice content purge not found'; end if;
   definition:=updated;
  end if;
  execute definition;
 end loop;
end;
$migration$;
