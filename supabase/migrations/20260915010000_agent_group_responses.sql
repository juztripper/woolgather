-- Preserve per-participant messages through progress, failure and reopening.
-- Reuse the owned, revision-checked command and its idempotent receipts.
create function planning.valid_agent_responses(responses jsonb, agents jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare r jsonb; seen text[]:='{}'; speakers text[]:='{}';
begin
 if jsonb_typeof(responses) is distinct from 'array' or jsonb_array_length(responses)>3 then return false; end if;
 for r in select x from jsonb_array_elements(responses) x loop
  if jsonb_typeof(r) is distinct from 'object'
   or (r-array['agentId','name','avatar','text','replyToAgentId','createdAt'])<>'{}'::jsonb
   or not (r ?& array['agentId','name','text','replyToAgentId','createdAt'])
   or jsonb_typeof(r->'agentId') is distinct from 'string'
   or coalesce(r->>'agentId','') !~ '^[A-Za-z0-9_-]{1,80}$'
   or not exists(select 1 from jsonb_array_elements(agents) a where a->>'id'=r->>'agentId')
   or jsonb_typeof(r->'name') is distinct from 'string' or char_length(r->>'name') not between 1 and 120
   or jsonb_typeof(r->'createdAt') is distinct from 'string' or char_length(r->>'createdAt') not between 1 and 80
   or (jsonb_typeof(r->'text') is distinct from 'null' and (jsonb_typeof(r->'text') is distinct from 'string' or char_length(btrim(r->>'text')) not between 1 and 3500))
   or (r ? 'avatar' and (jsonb_typeof(r->'avatar') is distinct from 'string' or r->>'avatar' not in ('sprout','orbit','moss','spark','pebble','ripple')))
   or (jsonb_typeof(r->'replyToAgentId') is distinct from 'null' and (jsonb_typeof(r->'replyToAgentId') is distinct from 'string' or not (r->>'replyToAgentId'=any(speakers)) or r->>'replyToAgentId'=r->>'agentId' or jsonb_typeof(r->'text')='null'))
   then return false; end if;
  seen:=array_append(seen,r->>'agentId');
  if (select count(*) from unnest(seen) x where x=r->>'agentId')>2 or (select count(distinct x) from unnest(seen) x)>2 then return false; end if;
  if jsonb_typeof(r->'text')='string' then speakers:=array_append(speakers,r->>'agentId'); end if;
 end loop;
 return true;
exception when others then return false;
end; $$;
revoke all on function planning.valid_agent_responses(jsonb,jsonb) from public,anon;
grant execute on function planning.valid_agent_responses(jsonb,jsonb) to authenticated;

do $migration$
declare definition text; updated text;
begin
 select pg_get_functiondef('planning.validate_thinking_legacy(jsonb)'::regprocedure) into definition;
 updated:=replace(definition, $old$  if t ? 'reaction' then$old$, $new$  if t ? 'agentResponses' and not planning.valid_agent_responses(t->'agentResponses',value->'agents') then return false; end if;
  if t ? 'reaction' then$new$);
 if updated=definition then raise exception 'Turn validation not found'; end if;
 execute updated;

 select pg_get_functiondef('public.project_planning_command_before_permanent_delete(jsonb)'::regprocedure) into definition;
 updated:=replace(definition, $old$  turn:=jsonb_set(turn,'{work}',command->'work',true);$old$, $new$  turn:=jsonb_set(turn,'{work}',command->'work',true);
  if command ? 'agentResponses' then
   if not planning.valid_agent_responses(command->'agentResponses',state->'agents')
    or exists(select 1 from jsonb_array_elements(command->'agentResponses') r where not exists(
      select 1 from jsonb_array_elements(state->'conversations') c where c->>'id'=turn->>'conversationId' and c->'agentIds' ? (r->>'agentId')))
    or exists(select 1 from jsonb_array_elements(coalesce(turn->'agentResponses','[]'::jsonb)) with ordinality response_row(r,response_ordinal)
      where r is distinct from (command->'agentResponses')->((response_ordinal-1)::integer))
    then raise exception 'Invalid group progress' using errcode='22023'; end if;
   turn:=turn||jsonb_build_object('agentResponses',command->'agentResponses','reply',coalesce(
     (select string_agg((r->>'name')||': '||(r->>'text'),E'\n\n' order by response_ordinal)
      from jsonb_array_elements(command->'agentResponses') with ordinality response_row(r,response_ordinal) where jsonb_typeof(r->'text')='string'),''));
  end if;$new$);
 if updated=definition then raise exception 'Work write not found'; end if;
 execute updated;

 select pg_get_functiondef('public.project_planning_command_legacy(jsonb)'::regprocedure) into definition;
 updated:=replace(definition, $old$then x||jsonb_build_object('status','pending','reply',''$old$, $new$then (x-'agentResponses')||jsonb_build_object('status','pending','reply',''$new$);
 if updated=definition then raise exception 'Retry reset not found'; end if;
 execute updated;
end; $migration$;
