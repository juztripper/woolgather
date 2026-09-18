-- Chats and project sources are user content with no trash state.  The two
-- commands below purge their durable records in one transaction while keeping
-- separately authored plan items, Idea documents, and accounting receipts.

-- A settled spend is an accounting record, not chat content.  Once its
-- conversation is purged, clear the turn/conversation pointers so a receipt
-- cannot be used as a recovery index.  Active runs are rejected by the purge
-- functions below; these nullable columns are for already-settled receipts.
alter table account_private.project_planning_runs
  alter column turn_id drop not null;
alter table account_private.project_voice_sessions
  alter column conversation_id drop not null;

-- The original validator requires a main slot for legacy projects.  Keep that
-- validator as the implementation and wrap it so an explicit empty array is
-- valid after the user permanently deletes the main conversation.  The command
-- dispatcher synthesizes the slot only for the next explicit main turn.
alter table planning.projects drop constraint if exists valid_project_thinking;
alter function planning.validate_thinking(jsonb) rename to validate_thinking_legacy;
create function planning.validate_thinking(value jsonb) returns boolean
language sql immutable set search_path='' as $$
 select planning.validate_thinking_legacy(
   case when jsonb_typeof(value->'conversations')='array'
             and not exists(
               select 1 from jsonb_array_elements(value->'conversations') c
               where c->>'id'='main'
             )
     then jsonb_set(value,'{conversations}',jsonb_build_array(jsonb_build_object(
       'id','main','title','Main conversation','agentIds','[]'::jsonb,
       'createdAt','1970-01-01T00:00:00.000Z',
       'updatedAt','1970-01-01T00:00:00.000Z',
       'archived',false,'branch',null
     )) || (value->'conversations'),true)
     else value
   end
 );
$$;
alter table planning.projects add constraint valid_project_thinking
  check (planning.validate_thinking(thinking));
revoke all on function planning.validate_thinking(jsonb) from public,anon;
grant execute on function planning.validate_thinking(jsonb) to authenticated;

-- Remove a conversation from a thinking document.  Turn ordinals in
-- sourceUpdates are rebased against the retained turn list; updates that cite
-- a deleted turn are dropped.  Branches depending on the deleted conversation
-- become standalone conversations, and the undo snapshot is always cleared.
create function planning.purge_conversation_state(value jsonb, target_id text)
returns jsonb
language plpgsql immutable set search_path='' as $$
declare
 state jsonb:=value;
 entry jsonb;
 composer jsonb;
 quote jsonb;
 update_row jsonb;
 conversation jsonb;
 proposal jsonb;
 relation jsonb;
 next_turns jsonb:='[]'::jsonb;
 next_conversations jsonb:='[]'::jsonb;
 next_proposals jsonb:='[]'::jsonb;
 next_relations jsonb:='[]'::jsonb;
 next_quotes jsonb;
 next_updates jsonb;
 old_ids text[]:='{}';
 removed_ids text[]:='{}';
 retained_ids text[]:='{}';
 removed_proposal_ids text[]:='{}';
 old_ordinal integer;
 next_ordinal integer;
 old_id text;
 source_turn text;
begin
 if jsonb_typeof(value) is distinct from 'object' or target_id is null then
  return value;
 end if;

 for entry in
   select x from jsonb_array_elements(coalesce(state->'turns','[]'::jsonb)) x
 loop
  old_ids:=array_append(old_ids,entry->>'id');
  if coalesce(entry->>'conversationId','main')=target_id then
   removed_ids:=array_append(removed_ids,entry->>'id');
  else
   retained_ids:=array_append(retained_ids,entry->>'id');
  end if;
 end loop;

 for entry in
   select x from jsonb_array_elements(coalesce(state->'turns','[]'::jsonb)) x
 loop
  if coalesce(entry->>'conversationId','main')=target_id then continue; end if;
  composer:=entry->'composer';
  if jsonb_typeof(composer)='object' and composer ? 'quotes' then
   next_quotes:='[]'::jsonb;
   for quote in select x from jsonb_array_elements(coalesce(composer->'quotes','[]'::jsonb)) x loop
    if not (quote->>'turnId'=any(removed_ids)) then
     next_quotes:=next_quotes||jsonb_build_array(quote);
    end if;
   end loop;
   composer:=jsonb_set(composer,'{quotes}',next_quotes,true);
   entry:=jsonb_set(entry,'{composer}',composer,true);
  end if;
  if entry ? 'sourceUpdates' then
   next_updates:='[]'::jsonb;
   for update_row in select x from jsonb_array_elements(coalesce(entry->'sourceUpdates','[]'::jsonb)) x loop
    source_turn:=update_row->>'sourceTurn';
    if source_turn='brief' or source_turn !~ '^t[1-9][0-9]*$' then
     next_updates:=next_updates||jsonb_build_array(update_row);
     continue;
    end if;
    old_ordinal:=substring(source_turn from 2)::integer;
    old_id:=case when old_ordinal<=coalesce(array_length(old_ids,1),0)
      then old_ids[old_ordinal] end;
    if old_id is null or old_id=any(removed_ids) then continue; end if;
    next_ordinal:=array_position(retained_ids,old_id);
    if next_ordinal is not null then
     next_updates:=next_updates||jsonb_build_array(
       jsonb_set(update_row,'{sourceTurn}',to_jsonb('t'||next_ordinal),true)
     );
    end if;
   end loop;
   entry:=jsonb_set(entry,'{sourceUpdates}',next_updates,true);
  end if;
  next_turns:=next_turns||jsonb_build_array(entry);
 end loop;

 for conversation in
   select x from jsonb_array_elements(coalesce(state->'conversations','[]'::jsonb)) x
 loop
  if conversation->>'id'=target_id then continue; end if;
  if jsonb_typeof(conversation->'branch')='object'
     and (conversation->'branch'->>'conversationId'=target_id
       or conversation->'branch'->>'turnId'=any(removed_ids)) then
   conversation:=jsonb_set(conversation,'{branch}','null'::jsonb,true);
  end if;
  next_conversations:=next_conversations||jsonb_build_array(conversation);
 end loop;

 for proposal in
   select x from jsonb_array_elements(coalesce(state->'proposals','[]'::jsonb)) x
 loop
  if proposal->>'turnId'=any(removed_ids) then
   removed_proposal_ids:=array_append(removed_proposal_ids,proposal->>'itemId');
  else
   next_proposals:=next_proposals||jsonb_build_array(proposal);
  end if;
 end loop;
 for relation in
   select x from jsonb_array_elements(coalesce(state->'relations','[]'::jsonb)) x
 loop
  if relation->>'from'=any(removed_proposal_ids)
     or relation->>'to'=any(removed_proposal_ids) then continue; end if;
  next_relations:=next_relations||jsonb_build_array(relation);
 end loop;

 state:=jsonb_set(state,'{turns}',next_turns,true);
 state:=jsonb_set(state,'{conversations}',next_conversations,true);
 state:=jsonb_set(state,'{proposals}',next_proposals,true);
 state:=jsonb_set(state,'{relations}',next_relations,true);
 state:=jsonb_set(state,'{undo}','null'::jsonb,true);
 return state;
end;
$$;
revoke all on function planning.purge_conversation_state(jsonb,text) from public,anon,authenticated;

-- Remove a source catalog ID and its backing attachment from saved composer
-- context in this project.  An attachment referenced by an Idea or a separate
-- project remains owned by that independent document and is retained by the
-- attachment garbage-collection trigger.
create function planning.purge_source_state(value jsonb, target_id text, target_attachment_id text default null)
returns jsonb
language plpgsql immutable set search_path='' as $$
declare
 state jsonb:=value;
 entry jsonb;
 composer jsonb;
 attachment jsonb;
 reference jsonb;
 update_row jsonb;
 next_turns jsonb:='[]'::jsonb;
 next_values jsonb;
begin
 if jsonb_typeof(value) is distinct from 'object' or target_id is null then
  return value;
 end if;
 for entry in select x from jsonb_array_elements(coalesce(state->'turns','[]'::jsonb)) x loop
  composer:=entry->'composer';
  if jsonb_typeof(composer)='object' then
   if composer ? 'sourceIds' then
    next_values:='[]'::jsonb;
    for reference in select x from jsonb_array_elements(coalesce(composer->'sourceIds','[]'::jsonb)) x loop
     if lower(reference#>>'{}')<>lower(target_id) then next_values:=next_values||jsonb_build_array(reference); end if;
    end loop;
    composer:=jsonb_set(composer,'{sourceIds}',next_values,true);
   end if;
   if target_attachment_id is not null and composer ? 'attachments' then
    next_values:='[]'::jsonb;
    for attachment in select x from jsonb_array_elements(coalesce(composer->'attachments','[]'::jsonb)) x loop
     if lower(attachment->>'id')<>lower(target_attachment_id) then next_values:=next_values||jsonb_build_array(attachment); end if;
    end loop;
    composer:=jsonb_set(composer,'{attachments}',next_values,true);
   end if;
   entry:=jsonb_set(entry,'{composer}',composer,true);
  end if;
  if entry ? 'sourceReferences' then
   next_values:='[]'::jsonb;
   for reference in select x from jsonb_array_elements(coalesce(entry->'sourceReferences','[]'::jsonb)) x loop
    if lower(reference->>'sourceId')<>lower(target_id) then next_values:=next_values||jsonb_build_array(reference); end if;
   end loop;
   entry:=jsonb_set(entry,'{sourceReferences}',next_values,true);
  end if;
  if entry ? 'sourceUpdates' then
   next_values:='[]'::jsonb;
   for update_row in select x from jsonb_array_elements(coalesce(entry->'sourceUpdates','[]'::jsonb)) x loop
    if lower(update_row->>'sourceId')<>lower(target_id) then next_values:=next_values||jsonb_build_array(update_row); end if;
   end loop;
   entry:=jsonb_set(entry,'{sourceUpdates}',next_values,true);
  end if;
  next_turns:=next_turns||jsonb_build_array(entry);
 end loop;
 state:=jsonb_set(state,'{turns}',next_turns,true);
 state:=jsonb_set(state,'{undo}','null'::jsonb,true);
 return state;
end;
$$;
revoke all on function planning.purge_source_state(jsonb,text,text) from public,anon,authenticated;

create function planning.scrub_conversation_snapshot(value jsonb, target_id text)
returns jsonb language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(value)='object' and jsonb_typeof(value->'thinking')='object' then
  return jsonb_set(value,'{thinking}',planning.purge_conversation_state(value->'thinking',target_id),true);
 end if;
 return value;
end;
$$;
revoke all on function planning.scrub_conversation_snapshot(jsonb,text) from public,anon,authenticated;

create function planning.scrub_source_snapshot(value jsonb, target_id text, target_attachment_id text default null)
returns jsonb language plpgsql immutable set search_path='' as $$
declare sources jsonb; source_row jsonb; next_sources jsonb:='[]'::jsonb;
begin
 if jsonb_typeof(value)<>'object' then return value; end if;
 if jsonb_typeof(value->'thinking')='object' then
  value:=jsonb_set(value,'{thinking}',planning.purge_source_state(value->'thinking',target_id,target_attachment_id),true);
 end if;
 if jsonb_typeof(value->'sources')='array' then
  for source_row in select x from jsonb_array_elements(value->'sources') x loop
   if lower(source_row->>'id')<>lower(target_id) then next_sources:=next_sources||jsonb_build_array(source_row); end if;
  end loop;
  value:=jsonb_set(value,'{sources}',next_sources,true);
 end if;
 return value;
end;
$$;
revoke all on function planning.scrub_source_snapshot(jsonb,text,text) from public,anon,authenticated;

-- Receipts can contain a turn command whose composer selected the source even
-- when the source ID is not a top-level command field.  Scrub both shapes so a
-- retry receipt cannot retain a private source lookup or attachment pointer.
create function planning.scrub_source_request(value jsonb, target_id text, target_attachment_id text default null)
returns jsonb language plpgsql immutable set search_path='' as $$
declare
 composer jsonb; entry jsonb; next_values jsonb;
begin
 if jsonb_typeof(value)<>'object' then return value; end if;
 if lower(value->>'sourceId')=lower(target_id) then
  value:=jsonb_set(value,'{sourceId}','"[deleted]"'::jsonb,true)-'note'-'meaning';
 end if;
 if target_attachment_id is not null and lower(value->>'attachmentId')=lower(target_attachment_id) then
  value:=jsonb_set(value,'{attachmentId}','"[deleted]"'::jsonb,true);
 end if;
 composer:=value->'composer';
 if jsonb_typeof(composer)='object' then
  if composer ? 'sourceIds' then
   next_values:='[]'::jsonb;
   for entry in select x from jsonb_array_elements(coalesce(composer->'sourceIds','[]'::jsonb)) x loop
    if lower(entry#>>'{}')<>lower(target_id) then next_values:=next_values||jsonb_build_array(entry); end if;
   end loop;
   composer:=jsonb_set(composer,'{sourceIds}',next_values,true);
  end if;
  if target_attachment_id is not null and composer ? 'attachments' then
   next_values:='[]'::jsonb;
   for entry in select x from jsonb_array_elements(coalesce(composer->'attachments','[]'::jsonb)) x loop
    if lower(entry->>'id')<>lower(target_attachment_id) then next_values:=next_values||jsonb_build_array(entry); end if;
   end loop;
   composer:=jsonb_set(composer,'{attachments}',next_values,true);
  end if;
  value:=jsonb_set(value,'{composer}',composer,true);
 end if;
 if value ? 'sourceReferences' then
  next_values:='[]'::jsonb;
  for entry in select x from jsonb_array_elements(coalesce(value->'sourceReferences','[]'::jsonb)) x loop
   if lower(entry->>'sourceId')<>lower(target_id) then next_values:=next_values||jsonb_build_array(entry); end if;
  end loop;
  value:=jsonb_set(value,'{sourceReferences}',next_values,true);
 end if;
 if value ? 'sourceUpdates' then
  next_values:='[]'::jsonb;
  for entry in select x from jsonb_array_elements(coalesce(value->'sourceUpdates','[]'::jsonb)) x loop
   if lower(entry->>'sourceId')<>lower(target_id) then next_values:=next_values||jsonb_build_array(entry); end if;
  end loop;
  value:=jsonb_set(value,'{sourceUpdates}',next_values,true);
 end if;
 return value;
end;
$$;
revoke all on function planning.scrub_source_request(jsonb,text,text) from public,anon,authenticated;

-- Purge a chat's receipts/history and remove the chat pointer from terminal
-- provider receipts.  The project, plan items, Idea links, and spend ledger
-- remain.  Active provider work is rejected before any mutation.
create function planning.delete_project_conversation(command jsonb)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid();
 pid uuid; cid uuid; expected integer; target_id text;
 p planning.projects; prior planning.commands; receipt planning.commands;
 state jsonb; purged jsonb; result jsonb; request_value jsonb; result_value jsonb;
 history_row planning.history;
 removed_ids text[]:='{}';
 removed_attachment_ids text[]:='{}';
 attachment_id text;
 turn_row jsonb;
 attachment_row jsonb;
 target_conversation jsonb;
 active_run boolean;
begin
 if actor is null or public.account_access()<>'ok' then
  raise exception 'Sign in required' using errcode='28000';
 end if;
 begin pid:=(command->>'projectId')::uuid; cid:=(command->>'id')::uuid; expected:=(command->>'revision')::integer; exception when others then
  raise exception 'Invalid planning command' using errcode='22023';
 end;
 target_id:=command->>'conversationId';
 if pid is null or cid is null or expected is null or expected<0
    or target_id is null or target_id !~ '^[A-Za-z0-9_-]{1,80}$'
    or (command-array['id','projectId','revision','action','conversationId'])<>'{}'::jsonb
    or command->>'action' is distinct from 'delete_conversation' then
  raise exception 'Invalid planning command' using errcode='22023';
 end if;

 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into prior from planning.commands where owner_id=actor and id=cid;
 if found then
  if prior.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return prior.result;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('woolgather-attachment-budget',0));
 select * into p from planning.projects where id=pid and owner_id=actor for update;
 if not found then raise exception 'Project not found' using errcode='P0002'; end if;
 if p.lifecycle<>'active' then raise exception 'Restore this project before editing' using errcode='22023'; end if;
 if p.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
 state:=p.thinking;
 if jsonb_typeof(state->'conversations')='array' then
  select x into target_conversation from jsonb_array_elements(state->'conversations') x where x->>'id'=target_id;
  if target_conversation is null then raise exception 'Conversation not found' using errcode='P0002'; end if;
 elsif target_id<>'main' then
  raise exception 'Conversation not found' using errcode='P0002';
 end if;

 for turn_row in select x from jsonb_array_elements(coalesce(state->'turns','[]'::jsonb)) x loop
  if coalesce(turn_row->>'conversationId','main')=target_id then
   removed_ids:=array_append(removed_ids,turn_row->>'id');
   for attachment_row in select x from jsonb_array_elements(coalesce(turn_row->'composer'->'attachments','[]'::jsonb)) x loop
    if coalesce(attachment_row->>'id','') ~ '^[0-9a-fA-F-]{36}$' then
     removed_attachment_ids:=array_append(removed_attachment_ids,attachment_row->>'id');
    end if;
   end loop;
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(state->'turns','[]'::jsonb)) x where x->>'status'='pending') then
  raise exception 'A reply is still being reconciled' using errcode='PT425';
 end if;
 if exists(select 1 from account_private.project_planning_runs where project_id=pid and status in ('reserved','running','unknown')) then
  raise exception 'A reply is still being reconciled' using errcode='PT425';
 end if;
 if exists(select 1 from account_private.project_voice_sessions where project_id=pid and status in ('reserved','running','closing','unknown')) then
  raise exception 'A voice session is still being reconciled' using errcode='PT425';
 end if;

 purged:=planning.purge_conversation_state(state,target_id);
 if not planning.validate_thinking(purged) then raise exception 'Invalid project thinking' using errcode='22023'; end if;

 -- Plan items created from a manual thought remain authored content, but their
 -- evidence cannot keep pointing at a deleted chat turn.
 update planning.items i set evidence=null
 where i.project_id=pid and i.evidence->>'turnId'=any(removed_ids);

 -- Every old snapshot receipt for this project is scrubbed in place.  Keeping
 -- action/revision metadata preserves audit/idempotency boundaries while
 -- removing text and deleted IDs from all recovery copies.
 for receipt in select * from planning.commands where owner_id=actor and project_id=pid for update loop
  request_value:=receipt.request;
  result_value:=planning.scrub_conversation_snapshot(receipt.result,target_id);
  if jsonb_typeof(request_value->'thinking')='object' then
   request_value:=jsonb_set(request_value,'{thinking}',planning.purge_conversation_state(request_value->'thinking',target_id),true);
  end if;
  if request_value->>'conversationId'=target_id then request_value:=jsonb_set(request_value,'{conversationId}','"[deleted]"'::jsonb,true); end if;
  if request_value->>'turnId'=any(removed_ids) or receipt.request->>'conversationId'=target_id then
   request_value:=request_value-'text'-'reply'-'work'-'composer'-'routing'-'sourceReferences'-'sourceUpdates'-'attachments'-'quotes';
  end if;
  if request_value->>'turnId'=any(removed_ids) then
   request_value:=jsonb_set(request_value,'{turnId}','"[deleted]"'::jsonb,true);
  end if;
  if jsonb_typeof(request_value->'branch')='object'
     and (request_value->'branch'->>'conversationId'=target_id or request_value->'branch'->>'turnId'=any(removed_ids)) then
   request_value:=jsonb_set(request_value,'{branch}','null'::jsonb,true);
  end if;
  update planning.commands set request=request_value,result=result_value
   where owner_id=actor and id=receipt.id;
 end loop;

 for history_row in select * from planning.history where project_id=pid for update loop
  if history_row.context->>'conversationId'=target_id
     or history_row.context->>'turnId'=any(removed_ids) then
   delete from planning.history where project_id=pid and revision=history_row.revision;
  else
   if history_row.before_item->'evidence'->>'turnId'=any(removed_ids) then
    history_row.before_item:=history_row.before_item-'evidence';
   end if;
   if history_row.after_item->'evidence'->>'turnId'=any(removed_ids) then
    history_row.after_item:=history_row.after_item-'evidence';
   end if;
   update planning.history set before_item=history_row.before_item,after_item=history_row.after_item
    where project_id=pid and revision=history_row.revision;
  end if;
 end loop;

 -- Terminal voice receipts retain their spend/accounting fields but lose the
 -- transcript and conversation lookup key.  Active sessions were rejected.
 update account_private.project_voice_sessions
 set conversation_id=null,transcript='[]'::jsonb
 where project_id=pid and conversation_id=target_id
   and status in ('completed','failed','cancelled');
 update account_private.project_planning_runs
 set turn_id=null
 where project_id=pid and turn_id::text=any(removed_ids)
   and status in ('completed','failed','cancelled');

 update planning.projects set thinking=purged,revision=revision+1,updated_at=clock_timestamp()
 where id=pid returning * into p;
 for attachment_id in select distinct unnest(removed_attachment_ids) loop
  if not account_private.attachment_referenced(attachment_id::uuid) then
   delete from account_private.attachments where id=attachment_id::uuid;
  end if;
 end loop;
 insert into planning.history(project_id,revision,action,after_item,context)
  values(pid,p.revision,'project_delete_conversation',null,'{}'::jsonb);
 result:=public.project_snapshot(pid);
 insert into planning.commands(owner_id,id,project_id,request,result)
  values(actor,cid,pid,command,result);
 return result;
end;
$$;
revoke all on function planning.delete_project_conversation(jsonb) from public,anon,authenticated;
grant execute on function planning.delete_project_conversation(jsonb) to authenticated;

-- Preserve the existing metadata implementation and route only the new action
-- through the transactional purge.  An empty explicit conversations array is
-- materialized as main only when a new main turn is actually written.
alter function public.project_planning_command(jsonb)
  rename to project_planning_command_before_permanent_delete;
create function public.project_planning_command(command jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid(); pid uuid; expected integer; kind text;
begin
 kind:=command->>'action';
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
       select 1 from jsonb_array_elements(p.thinking->'conversations') c
       where c->>'id'='main'
     );
  end if;
 end if;
 return public.project_planning_command_before_permanent_delete(command);
end;
$$;
revoke all on function public.project_planning_command(jsonb) from public,anon;
grant execute on function public.project_planning_command(jsonb) to authenticated;
revoke all on function public.project_planning_command_before_permanent_delete(jsonb) from public,anon,authenticated;
grant execute on function public.project_planning_command_before_permanent_delete(jsonb) to authenticated;

-- Source deletion follows the same dispatcher pattern.  Source catalog rows
-- are removed before the attachment collector checks references, so bytes are
-- queued for deletion only when no Idea/project composer/source still owns the
-- attachment.
create function planning.delete_project_source(command jsonb)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); pid uuid; cid uuid; expected integer; source_id text; attachment_id text;
 p planning.projects; source_row planning.project_sources; prior planning.commands; receipt planning.commands;
 state jsonb; purged jsonb; result jsonb; request_value jsonb; result_value jsonb;
 history_row planning.history;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 begin pid:=(command->>'projectId')::uuid; cid:=(command->>'id')::uuid; expected:=(command->>'revision')::integer; exception when others then raise exception 'Invalid source command' using errcode='22023'; end;
 source_id:=command->>'sourceId';
 if pid is null or cid is null or expected is null or expected<0
   or source_id is null or source_id !~ '^[0-9a-fA-F-]{36}$'
   or (command-array['id','projectId','revision','action','sourceId'])<>'{}'::jsonb
   or command->>'action' is distinct from 'delete_source' then raise exception 'Invalid source command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into prior from planning.commands where owner_id=actor and id=cid;
 if found then
  if prior.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return prior.result;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('woolgather-attachment-budget',0));
 select * into p from planning.projects where id=pid and owner_id=actor for update;
 if not found then raise exception 'Project not found' using errcode='P0002'; end if;
 if p.lifecycle<>'active' then raise exception 'Restore this project before editing' using errcode='22023'; end if;
 if p.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
 select * into source_row from planning.project_sources where id=source_id::uuid and project_id=pid and owner_id=actor for update;
 if not found then raise exception 'Source not found' using errcode='P0002'; end if;
 attachment_id:=source_row.attachment_id::text;
 if exists(select 1 from jsonb_array_elements(coalesce(p.thinking->'turns','[]'::jsonb)) x where x->>'status'='pending') then
  raise exception 'A reply is still being reconciled' using errcode='PT425';
 end if;
 if exists(select 1 from account_private.project_planning_runs where project_id=pid and status in ('reserved','running','unknown')) then
  raise exception 'A reply is still being reconciled' using errcode='PT425';
 end if;
 if exists(select 1 from account_private.project_voice_sessions where project_id=pid and status in ('reserved','running','closing','unknown')) then
  raise exception 'A voice session is still being reconciled' using errcode='PT425';
 end if;
 state:=p.thinking;
 purged:=planning.purge_source_state(state,source_id,attachment_id);
 if not planning.validate_thinking(purged) then raise exception 'Invalid project thinking' using errcode='22023'; end if;

 for receipt in select * from planning.commands where owner_id=actor and project_id=pid for update loop
  request_value:=planning.scrub_source_request(receipt.request,source_id,attachment_id);
  result_value:=planning.scrub_source_snapshot(receipt.result,source_id,attachment_id);
  if jsonb_typeof(request_value->'thinking')='object' then
   request_value:=jsonb_set(request_value,'{thinking}',planning.purge_source_state(request_value->'thinking',source_id,attachment_id),true);
  end if;
  update planning.commands set request=request_value,result=result_value
   where owner_id=actor and id=receipt.id;
 end loop;
 for history_row in select * from planning.history where project_id=pid for update loop
  if history_row.context->>'sourceId'=source_id then
   delete from planning.history where project_id=pid and revision=history_row.revision;
  end if;
 end loop;

 update planning.projects set thinking=purged,revision=revision+1,updated_at=clock_timestamp()
 where id=pid returning * into p;
 delete from planning.project_sources where id=source_row.id;
 insert into planning.history(project_id,revision,action,after_item,context)
  values(pid,p.revision,'project_delete_source',null,'{}'::jsonb);
 result:=public.project_snapshot(pid);
 insert into planning.commands(owner_id,id,project_id,request,result)
  values(actor,cid,pid,command,result);
 return result;
end;
$$;
revoke all on function planning.delete_project_source(jsonb) from public,anon,authenticated;
grant execute on function planning.delete_project_source(jsonb) to authenticated;

alter function public.project_source_command(jsonb)
  rename to project_source_command_before_permanent_delete;
create function public.project_source_command(command jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
 if command->>'action'='delete_source' then return planning.delete_project_source(command); end if;
 return public.project_source_command_before_permanent_delete(command);
end;
$$;
revoke all on function public.project_source_command(jsonb) from public,anon;
grant execute on function public.project_source_command(jsonb) to authenticated;
revoke all on function public.project_source_command_before_permanent_delete(jsonb) from public,anon,authenticated;
grant execute on function public.project_source_command_before_permanent_delete(jsonb) to authenticated;

-- Any late terminal update from a voice Durable Object remains an accounting
-- receipt but cannot restore a transcript after its conversation was purged.
create or replace function account_private.redact_orphan_project_voice_transcript() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.owner_id is null or new.project_id is null or new.conversation_id is null then
  new.transcript:='[]'::jsonb;
 end if;
 return new;
end;
$$;
