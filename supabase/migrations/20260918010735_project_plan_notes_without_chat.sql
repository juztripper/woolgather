-- A manually captured Plan thought is independent of chat history.  After a
-- user permanently deletes Main, keep the explicit empty conversation array
-- while allowing the note turn and its authored item to be saved.

create function planning.project_plan_note(command jsonb)
returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid();
 pid uuid;
 cid uuid;
 expected integer;
 tid text;
 focus text;
 p planning.projects;
 prior planning.commands;
 state jsonb;
 turn jsonb;
 result jsonb;
begin
 if actor is null or public.account_access()<>'ok' then
  raise exception 'Sign in required' using errcode='28000';
 end if;
 begin
  pid:=(command->>'projectId')::uuid;
  cid:=(command->>'id')::uuid;
  expected:=(command->>'revision')::integer;
 exception when others then
  raise exception 'Invalid planning command' using errcode='22023';
 end;
 tid:=command->>'turnId';
 focus:=nullif(command->>'focusId','');
 if command is null or jsonb_typeof(command) is distinct from 'object'
   or octet_length(command::text)>800000
   or pid is null or cid is null or expected is null or expected<0
   or command->>'action' is distinct from 'turn'
   or command->>'mode' is distinct from 'note'
   or coalesce(command->>'conversationId','main')<>'main'
   or coalesce(tid,'') !~ '^[0-9a-fA-F-]{36}$'
   or (focus is not null and focus !~ '^[0-9a-fA-F-]{36}$')
   or jsonb_typeof(command->'text') is distinct from 'string'
   or char_length(trim(command->>'text')) not between 1 and 12000
   or (command-array['id','projectId','revision','action','turnId','text','conversationId','mode','focusId','composer','routing'])<>'{}'::jsonb then
  raise exception 'Invalid planning command' using errcode='22023';
 end if;

 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into prior from planning.commands where owner_id=actor and id=cid;
 if found then
  if prior.request<>command then
   raise exception 'Retry key reused with different content' using errcode='22023';
  end if;
  return public.project_snapshot(pid);
 end if;

 select * into p from planning.projects where id=pid and owner_id=actor for update;
 if not found then raise exception 'Project not found' using errcode='P0002'; end if;
 if p.lifecycle<>'active' then
  raise exception 'Restore this project before editing' using errcode='22023';
 end if;
 if p.revision<>expected then
  raise exception 'Revision conflict' using errcode='PT409';
 end if;
 state:=p.thinking;
 if jsonb_typeof(state->'conversations') is distinct from 'array'
   or exists(
     select 1
     from jsonb_array_elements(state->'conversations') conversation
     where conversation->>'id'='main'
   ) then
  raise exception 'A Main conversation is available for this note' using errcode='22023';
 end if;
 if jsonb_typeof(state->'turns') is distinct from 'array'
   or jsonb_array_length(state->'turns')>=200 then
  raise exception 'Turn unavailable' using errcode='PT409';
 end if;
 if exists(select 1 from jsonb_array_elements(state->'turns') entry where entry->>'id'=tid)
   or exists(select 1 from jsonb_array_elements(state->'turns') entry where entry->>'status'='pending') then
  raise exception 'Turn unavailable' using errcode='PT409';
 end if;
 if command ? 'composer' and not planning.valid_composer(command->'composer',pid) then
  raise exception 'Invalid message context' using errcode='22023';
 end if;

 turn:=jsonb_build_object(
   'id',tid,
   'conversationId','main',
   'text',command->>'text',
   'reply','',
   'status','saved',
   'focusId',coalesce(command->'focusId','null'::jsonb),
   'createdAt',clock_timestamp(),
   'changedIds','[]'::jsonb
 );
 if command ? 'composer' then
  turn:=turn||jsonb_build_object('composer',command->'composer','routing',command->'routing');
 end if;
 if exists(select 1 from planning.items where id=tid::uuid) then
  raise exception 'Turn unavailable' using errcode='PT409';
 end if;
 insert into planning.items(id,project_id,title,body,category,certainty,status,source,evidence)
 values(
   tid::uuid,
   pid,
   left(regexp_replace(trim(command->>'text'),'\s+',' ','g'),100),
   command->>'text',
   'note',
   'stated',
   'open',
   'Written by you',
   jsonb_build_object('turnId',tid,'quote',command->>'text')
 );
 state:=jsonb_set(
   state,
   '{turns}',
   state->'turns'||jsonb_build_array(turn),
   true
 );
 if focus is not null and exists(
   select 1
   from planning.items
   where id=focus::uuid and project_id=pid and not removed
 ) then
  state:=jsonb_set(
    state,
    '{relations}',
    coalesce(state->'relations','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
      'id',tid||':part_of:'||focus,
      'from',tid,
      'to',focus,
      'kind','part_of',
      'reason','Added while discussing this part.'
    )),
    true
  );
 end if;
 if not planning.validate_thinking(state) then
  raise exception 'Invalid project thinking' using errcode='22023';
 end if;
 update planning.projects
 set thinking=state,revision=revision+1,updated_at=clock_timestamp()
 where id=pid
 returning * into p;
 insert into planning.history(project_id,revision,action,after_item,context)
 values(
   pid,
   p.revision,
   'planning_turn',
   jsonb_build_object('title','Your thought','body',command->>'text'),
   jsonb_build_object('turnId',tid)
 );
 result:=public.project_snapshot(pid);
 insert into planning.commands(owner_id,id,project_id,request,result)
 values(actor,cid,pid,command,result);
 return result;
end;
$$;
revoke all on function planning.project_plan_note(jsonb) from public,anon;
grant execute on function planning.project_plan_note(jsonb) to authenticated;

-- Route only a missing-Main manual note through the detached-plan command. An
-- explicit assisted Main start still uses the existing dispatcher, which may
-- materialize Main as the user's deliberate new chat action.
create or replace function public.project_planning_command(command jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid();
 pid uuid;
 expected integer;
 kind text:=command->>'action';
begin
 if kind='turn' and command->>'mode'='note' and coalesce(command->>'conversationId','main')='main' then
  begin
   pid:=(command->>'projectId')::uuid;
   expected:=(command->>'revision')::integer;
  exception when others then
   pid:=null;
   expected:=null;
  end;
  if actor is not null and public.account_access()='ok' and pid is not null and expected is not null
    and exists(
      select 1
      from planning.projects p
      where p.id=pid and p.owner_id=actor
        and jsonb_typeof(p.thinking->'conversations')='array'
        and not exists(
          select 1
          from jsonb_array_elements(p.thinking->'conversations') conversation
          where conversation->>'id'='main'
        )
    ) then
   return planning.project_plan_note(command);
  end if;
 end if;
 if kind='delete_conversation' then return planning.delete_project_conversation(command); end if;
 if kind='turn' and coalesce(command->>'conversationId','main')='main' then
  begin pid:=(command->>'projectId')::uuid; expected:=(command->>'revision')::integer; exception when others then pid:=null; expected:=null; end;
  if actor is not null and public.account_access()='ok' and pid is not null and expected is not null then
   perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
   update planning.projects p set thinking=jsonb_set(
     p.thinking,'{conversations}',p.thinking->'conversations'||jsonb_build_array(jsonb_build_object(
       'id','main','title','Main conversation','agentIds','[]'::jsonb,
       'createdAt',p.updated_at,'updatedAt',p.updated_at,'archived',false,'branch',null
     )),true),updated_at=clock_timestamp()
   where p.id=pid and p.owner_id=actor and p.revision=expected
     and jsonb_typeof(p.thinking->'conversations')='array'
     and not exists(
       select 1 from jsonb_array_elements(p.thinking->'conversations') conversation
       where conversation->>'id'='main'
     );
  end if;
 end if;
 return public.project_planning_command_before_permanent_delete(command);
end;
$$;
revoke all on function public.project_planning_command(jsonb) from public,anon;
grant execute on function public.project_planning_command(jsonb) to authenticated;
