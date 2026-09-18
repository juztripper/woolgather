-- Explicit operator-only testing exemption; dollar guards and counters remain intact.
alter table account_private.guidance_allowances
 add column testing_request_exempt boolean not null default false;
comment on column account_private.guidance_allowances.testing_request_exempt is
 'Operator-authorized development testing only. Bypasses request count, never monetary limits or unresolved holds.';

-- Preserve the current signed admission implementations and their grants.
do $$
declare target regprocedure; definition text;
begin
 foreach target in array array[
  'public.project_planning_budget(text,text)'::regprocedure,
  'public.project_voice_start(text,text)'::regprocedure
 ] loop
  definition := pg_get_functiondef(target);
  if position('allowance.used_requests>=allowance.max_requests' in definition)=0 then
   raise exception 'Expected request guard missing in %', target;
  end if;
  execute replace(definition,
   'allowance.used_requests>=allowance.max_requests',
   '(not allowance.testing_request_exempt and allowance.used_requests>=allowance.max_requests)');
 end loop;
end $$;
