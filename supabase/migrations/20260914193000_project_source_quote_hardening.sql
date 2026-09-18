-- Harden source decision evidence after the source-library migration was applied.
-- Quotes are normalized like the domain validator before containment checks, so
-- whitespace-only and sub-three-character normalized quotes cannot become durable
-- source meaning. The adjacent annotation validator applies the same shape check
-- to direct writes; completion still performs the authored-context check below.
create or replace function planning.valid_project_source_annotations(value jsonb, pid uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare t jsonb; c jsonb; r jsonb; u jsonb; source_id text; agent_id text;
begin
 if jsonb_typeof(value) is distinct from 'object' then return false; end if;
 for t in select x from jsonb_array_elements(coalesce(value->'turns','[]'::jsonb)) x loop
  c:=coalesce(t->'composer','{}'::jsonb);
  if jsonb_typeof(coalesce(c->'agentIds','[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(c->'agentIds','[]'::jsonb))>2
    or (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(coalesce(c->'agentIds','[]'::jsonb)) x)
    or exists(select 1 from jsonb_array_elements(coalesce(c->'agentIds','[]'::jsonb)) x where jsonb_typeof(x) is distinct from 'string') then return false; end if;
  for agent_id in select x#>>'{}' from jsonb_array_elements(coalesce(c->'agentIds','[]'::jsonb)) x loop
   if not exists(select 1 from jsonb_array_elements(coalesce(value->'agents','[]'::jsonb)) a where a->>'id'=agent_id) then return false; end if;
  end loop;
  if jsonb_typeof(coalesce(c->'sourceIds','[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(c->'sourceIds','[]'::jsonb))>6
    or (select count(*)<>count(distinct x#>>'{}') from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x)
    or exists(select 1 from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x where coalesce(x#>>'{}','') !~ '^[0-9a-fA-F-]{36}$') then return false; end if;
  for source_id in select x#>>'{}' from jsonb_array_elements(coalesce(c->'sourceIds','[]'::jsonb)) x loop
   if not exists(select 1 from planning.project_sources s where s.id=source_id::uuid and s.project_id=pid) then return false; end if;
  end loop;
  if t ? 'sourceReferences' then
   if jsonb_typeof(t->'sourceReferences') is distinct from 'array' or jsonb_array_length(t->'sourceReferences')>6 then return false; end if;
   for r in select x from jsonb_array_elements(t->'sourceReferences') x loop
    if jsonb_typeof(r) is distinct from 'object' or (r-array['sourceId','quote'])<>'{}'::jsonb
      or coalesce(r->>'sourceId','') !~ '^[0-9a-fA-F-]{36}$'
      or (r ? 'quote' and (jsonb_typeof(r->'quote') is distinct from 'string' or char_length(r->>'quote')>2000)) then return false; end if;
    if not exists(select 1 from planning.project_sources s where s.id=(r->>'sourceId')::uuid and s.project_id=pid) then return false; end if;
   end loop;
  end if;
  if t ? 'sourceUpdates' then
   if jsonb_typeof(t->'sourceUpdates') is distinct from 'array' or jsonb_array_length(t->'sourceUpdates')>6 then return false; end if;
   for u in select x from jsonb_array_elements(t->'sourceUpdates') x loop
    if jsonb_typeof(u) is distinct from 'object' or (u-array['sourceId','note','meaning','sourceTurn','quote','origin'])<>'{}'::jsonb
      or coalesce(u->>'sourceId','') !~ '^[0-9a-fA-F-]{36}$'
      or coalesce(u->>'sourceTurn','') !~ '^(brief|t[1-9][0-9]*)$' or char_length(u->>'sourceTurn')>100
      or jsonb_typeof(u->'quote') is distinct from 'string' or char_length(btrim(regexp_replace(coalesce(u->>'quote',''),'\s+',' ','g'))) not between 3 and 6000
      or coalesce(u->>'origin','')<>'author'
      or (u ? 'note' and (jsonb_typeof(u->'note') is distinct from 'string' or char_length(u->>'note')>4000))
      or (u ? 'meaning' and coalesce(u->>'meaning','') not in ('use','avoid','undecided'))
      or not (u ? 'note' or u ? 'meaning') then return false; end if;
    if not exists(select 1 from planning.project_sources s where s.id=(u->>'sourceId')::uuid and s.project_id=pid) then return false; end if;
   end loop;
  end if;
 end loop;
 return true;
exception when others then return false;
end;
$$;

create or replace function planning.apply_project_source_updates() returns trigger
language plpgsql security definer set search_path='' as $$
declare t jsonb; old_t jsonb; u jsonb; evidence text; normalized_evidence text; normalized_quote text; source_turn text; source_index integer; source_conversation text;
begin
 for t in select x from jsonb_array_elements(coalesce(new.thinking->'turns','[]'::jsonb)) x loop
  select x into old_t from jsonb_array_elements(coalesce(old.thinking->'turns','[]'::jsonb)) x where x->>'id'=t->>'id';
  if t->>'status'='complete' and jsonb_typeof(t->'sourceUpdates')='array'
    and t->'sourceUpdates' is distinct from coalesce(old_t->'sourceUpdates','[]'::jsonb) then
   for u in select x from jsonb_array_elements(t->'sourceUpdates') x loop
    source_turn:=u->>'sourceTurn';
    if source_turn ~ '^t[1-9][0-9]*$' then
     source_index:=substring(source_turn from 2)::integer;
     select x->>'text' into evidence from jsonb_array_elements(new.thinking->'turns') with ordinality a(x,n) where n=source_index;
     source_conversation:=coalesce(t->>'conversationId','main');
     normalized_evidence:=btrim(regexp_replace(coalesce(evidence,''),'\s+',' ','g'));
     normalized_quote:=btrim(regexp_replace(coalesce(u->>'quote',''),'\s+',' ','g'));
     if char_length(normalized_quote)<3 or evidence is null or not planning.source_turn_visible(new.thinking,source_conversation,source_index)
       or strpos(normalized_evidence,normalized_quote)=0 then
      raise exception 'A source decision needs an exact quote from your authored context' using errcode='22023';
     end if;
    elsif source_turn='brief' then
     select regexp_replace(concat_ws(E'\n\n',nullif(new.description,''),case when new.idea_document->>'version'='2' then
       (select string_agg(planning.idea_block_text(block),E'\n\n' order by n) from jsonb_array_elements(coalesce(new.idea_document->'blocks','[]'::jsonb)) with ordinality blocks(block,n))
       else concat_ws(E'\n\n',nullif(new.original_idea,''),(select string_agg(value,E'\n\n' order by key) from jsonb_each_text(coalesce(new.idea_document->'answers','{}'::jsonb)))) end),'\s+',' ','g') into evidence;
     normalized_evidence:=btrim(regexp_replace(coalesce(evidence,''),'\s+',' ','g'));
     normalized_quote:=btrim(regexp_replace(coalesce(u->>'quote',''),'\s+',' ','g'));
     if char_length(normalized_quote)<3 or evidence is null or strpos(normalized_evidence,normalized_quote)=0 then
      raise exception 'A source decision needs an exact quote from your authored context' using errcode='22023';
     end if;
    else
     raise exception 'Invalid source decision evidence' using errcode='22023';
    end if;
    if not exists(select 1 from planning.project_sources s where s.id=(u->>'sourceId')::uuid and s.project_id=new.id and not s.archived) then
     raise exception 'Source is unavailable for this decision' using errcode='P0002';
    end if;
    update planning.project_sources set note=case when u ? 'note' then u->>'note' else note end,
     meaning=case when u ? 'meaning' then u->>'meaning' else meaning end,updated_at=clock_timestamp()
     where id=(u->>'sourceId')::uuid and project_id=new.id;
   end loop;
  end if;
 end loop;
 return new;
exception when invalid_text_representation or numeric_value_out_of_range then
 raise exception 'Invalid source decision evidence' using errcode='22023';
end;
$$;
