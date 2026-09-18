-- Versioned, validated block documents. Original v1 records remain readable.
-- New file bytes live in a private Storage bucket; only metadata enters Postgres.
create table account_private.attachments (
 id uuid primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(char_length(name) between 1 and 180 and name !~ '[\x00-\x1f\x7f/\\]'),
 mime_type text not null check(mime_type in ('application/octet-stream','image/png','image/jpeg','image/webp','image/gif')),
 byte_size bigint not null check(byte_size between 0 and 20971520),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 state text not null default 'pending' check(state in ('pending','ready')),
 created_at timestamptz not null default now(),
 touched_at timestamptz not null default now()
);
create index attachments_owner on account_private.attachments(owner_id,created_at);
alter table account_private.attachments enable row level security;
revoke all on account_private.attachments from public,anon,authenticated;
create table account_private.attachment_garbage (
 path text primary key, queued_at timestamptz not null default now(), deleted_at timestamptz
);
alter table account_private.attachment_garbage enable row level security;
revoke all on account_private.attachment_garbage from public,anon,authenticated;
create table account_private.attachment_operators (
 owner_id uuid primary key references auth.users(id) on delete cascade
);
alter table account_private.attachment_operators enable row level security;
revoke all on account_private.attachment_operators from public,anon,authenticated;

create function public.can_manage_attachments() returns boolean language sql stable security definer set search_path='' as $$
 select account_private.access_status()='ok' and exists(select 1 from account_private.attachment_operators where owner_id=auth.uid());
$$;
revoke all on function public.can_manage_attachments() from public,anon;
grant execute on function public.can_manage_attachments() to authenticated;

create function public.reserve_attachment(command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); aid uuid:=(command->>'id')::uuid; item account_private.attachments; bytes bigint:=(command->>'size')::bigint;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 if aid is null or bytes is null or bytes not between 0 and 20971520 or octet_length(command::text)>4000 then raise exception 'Invalid attachment' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('woolgather-attachment-budget',0));
 if exists(select 1 from account_private.attachment_garbage where path=actor::text||'/'||aid::text) then raise exception 'This upload was removed. Choose the file again.' using errcode='22023'; end if;
 select * into item from account_private.attachments where id=aid for update;
 if found then
  if item.owner_id<>actor or item.sha256 is distinct from command->>'sha256' or item.name is distinct from command->>'name' or item.byte_size<>bytes or item.mime_type is distinct from command->>'mime' then raise exception 'Upload identifier already used' using errcode='22023'; end if;
  update account_private.attachments set touched_at=clock_timestamp() where id=aid;
  return jsonb_build_object('id',aid,'state',item.state);
 end if;
 if (select coalesce(sum(byte_size),0)+bytes from account_private.attachments)>943718400
 or (select coalesce(sum(byte_size),0)+bytes from account_private.attachments where owner_id=actor)>104857600
 or (select count(*) from account_private.attachments where owner_id=actor)>=200 then raise exception 'Your attachment storage allowance has been reached.' using errcode='PT429'; end if;
 insert into account_private.attachments(id,owner_id,name,mime_type,byte_size,sha256) values(aid,actor,command->>'name',command->>'mime',bytes,command->>'sha256');
 return jsonb_build_object('id',aid,'state','pending');
end;
$$;
revoke all on function public.reserve_attachment(jsonb) from public,anon;
grant execute on function public.reserve_attachment(jsonb) to authenticated;

create function public.finish_attachment(attachment_id uuid, actor_id uuid, content_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item account_private.attachments;
begin
 select * into item from account_private.attachments where id=attachment_id and owner_id=actor_id and sha256=content_hash for update;
 if not found then raise exception 'Upload no longer available' using errcode='P0002'; end if;
 update account_private.attachments set state='ready',touched_at=clock_timestamp() where id=attachment_id;
 return jsonb_build_object('id',item.id,'name',item.name,'mime',item.mime_type,'size',item.byte_size,'sha256',item.sha256);
end;
$$;
revoke all on function public.finish_attachment(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.finish_attachment(uuid,uuid,text) to service_role;

create function public.attachment_metadata(attachment_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',id,'name',name,'mime',mime_type,'size',byte_size,'sha256',sha256)
 from account_private.attachments where id=attachment_id and owner_id=auth.uid() and state='ready' and account_private.access_status()='ok';
$$;
revoke all on function public.attachment_metadata(uuid) from public,anon;
grant execute on function public.attachment_metadata(uuid) to authenticated;
create function planning.attachment_available(attachment_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from account_private.attachments where id=attachment_id and owner_id=auth.uid() and state='ready') and account_private.access_status()='ok';
$$;
revoke all on function planning.attachment_available(uuid) from public,anon;
grant execute on function planning.attachment_available(uuid) to authenticated;

create function planning.idea_inline_text(content jsonb) returns text language sql immutable set search_path='' as $$
 select coalesce(string_agg(case when part->>'type'='text' then part->>'text' else (select coalesce(string_agg(t->>'text','' order by n),'') from jsonb_array_elements(part->'content') with ordinality x(t,n)) end,'' order by ordinal),'')
 from jsonb_array_elements(content) with ordinality x(part,ordinal);
$$;
create function planning.idea_block_text(block jsonb) returns text language plpgsql immutable set search_path='' as $$
declare row jsonb; result text:=''; line text;
begin
 if not block ? 'content' then return coalesce(block->'props'->>'caption',''); end if;
 if jsonb_typeof(block->'content')='array' then return planning.idea_inline_text(block->'content'); end if;
 for row in select value from jsonb_array_elements(block->'content'->'rows') loop
  select string_agg(planning.idea_inline_text(case when jsonb_typeof(c)='array' then c else c->'content' end),E'\t' order by n) into line from jsonb_array_elements(row->'cells') with ordinality x(c,n);
  result:=result||case when result='' then '' else E'\n' end||coalesce(line,'');
 end loop;
 return result;
end;
$$;
create function planning.flat_idea_blocks(blocks jsonb) returns setof jsonb language sql immutable set search_path='' as $$
 with recursive nodes(block,path) as (
  select value,array[ordinality] from jsonb_array_elements(blocks) with ordinality
  union all
  select child.value,nodes.path||child.ordinality from nodes cross join lateral jsonb_array_elements(nodes.block->'children') with ordinality child
 ) select block from nodes order by path;
$$;
create function planning.idea_block_projection(blocks jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare block jsonb; body text:=''; first boolean:=true; content text; props jsonb; aid text;
 answers jsonb:='{"purpose":"","audience":"","experience":"","context":"","constraints":"","possibilities":""}';
 questions jsonb:='[]'; refs jsonb:='[]'; attachments jsonb:='[]';
begin
 for block in select planning.flat_idea_blocks(blocks) loop
  props:=block->'props'; content:=planning.idea_block_text(block);
  body:=body||case when first then '' else E'\n\n' end||content; first:=false;
  if block->>'type'='ideaAnswer' then
   answers:=jsonb_set(answers,array[props->>'field'],to_jsonb(case when coalesce(props->>'prompt','')<>'' then 'Guidance question: '||(props->>'prompt')||E'\nYour answer:\n' else '' end||content));
  elsif block->>'type'='openQuestion' and trim(content)<>'' then
   questions:=questions||jsonb_build_array(jsonb_build_object('id',block->>'id','text',trim(content),'important',props->'important'));
  elsif block->>'type' in ('file','image') and coalesce(props->>'url','')<>'' then
   aid:=split_part(props->>'url',':',3);
   if props->>'url' like 'woolgather:image:%' then
    if not refs @> jsonb_build_array(jsonb_build_object('id',aid)) then refs:=refs||jsonb_build_array(jsonb_build_object('id',aid,'name',coalesce(nullif(props->>'name',''),'Reference image'),'caption',coalesce(props->>'caption',''))); end if;
   elsif not attachments @> to_jsonb(aid) then attachments:=attachments||jsonb_build_array(aid); end if;
  end if;
 end loop;
 return jsonb_build_object('body',body,'answers',answers,'questions',questions,'references',refs,'attachments',attachments);
end;
$$;
create function planning.validate_idea_inline(content jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare item jsonb; style text; val jsonb;
begin
 if jsonb_typeof(content) is distinct from 'array' or jsonb_array_length(content)>2000 then return false; end if;
 for item in select value from jsonb_array_elements(content) loop
  if item->>'type'='text' then
   if (item-array['type','text','styles'])<>'{}' or jsonb_typeof(item->'text') is distinct from 'string' or char_length(item->>'text')>100000 or jsonb_typeof(item->'styles') is distinct from 'object' then return false; end if;
   for style,val in select * from jsonb_each(item->'styles') loop
    if style in ('bold','italic','underline','strike','code') then if jsonb_typeof(val)<>'boolean' then return false; end if;
    elsif style in ('textColor','backgroundColor') then if jsonb_typeof(val)<>'string' or char_length(val#>>'{}')>60 or (val#>>'{}') !~ '^[#a-zA-Z0-9(),.%[:space:]-]+$' then return false; end if;
    else return false; end if;
   end loop;
  elsif item->>'type'='link' then
   if (item-array['type','href','content'])<>'{}' or jsonb_typeof(item->'href') is distinct from 'string' or char_length(item->>'href')>2048 or item->>'href' !~ '^(https?://|mailto:|tel:)' or item->>'href' ~ '[[:space:][:cntrl:]]' or not planning.validate_idea_inline(item->'content') or exists(select 1 from jsonb_array_elements(item->'content') x where x->>'type'<>'text') then return false; end if;
  else return false; end if;
 end loop;
 return true;
end;
$$;
create function planning.validate_idea_blocks(blocks jsonb, depth integer default 0) returns boolean language plpgsql immutable set search_path='' as $$
declare block jsonb; props jsonb; key text; value jsonb; kind text; allowed text[]; row jsonb; cell jsonb; cprops jsonb; contents jsonb;
begin
 if depth>8 or jsonb_typeof(blocks) is distinct from 'array' or jsonb_array_length(blocks)>1000 then return false; end if;
 for block in select x from jsonb_array_elements(blocks) x loop
  if jsonb_typeof(block) is distinct from 'object' or (block-array['id','type','props','content','children'])<>'{}' or jsonb_typeof(block->'id') is distinct from 'string' or char_length(block->>'id') not between 1 and 100 or block->>'id' !~ '^[a-zA-Z0-9_-]+$' then return false; end if;
  kind:=block->>'type'; props:=block->'props';
  if jsonb_typeof(props) is distinct from 'object' or not planning.validate_idea_blocks(block->'children',depth+1) then return false; end if;
  if kind in ('paragraph','heading','bulletListItem','numberedListItem','checkListItem','toggleListItem','quote','ideaAnswer','openQuestion') then
   allowed:=array['backgroundColor','textColor','textAlignment'];
   if kind='heading' then allowed:=allowed||array['level','isToggleable']; if coalesce(props->>'level','') not in ('1','2','3') then return false; end if; end if;
   if kind='numberedListItem' then allowed:=allowed||'start'::text; end if;
   if kind='checkListItem' then allowed:=allowed||'checked'::text; if jsonb_typeof(props->'checked') is distinct from 'boolean' then return false; end if; end if;
   if kind='ideaAnswer' then
    allowed:=allowed||array['field','prompt'];
    if coalesce(props->>'field','') not in ('purpose','audience','experience','context','constraints','possibilities') or jsonb_typeof(props->'prompt') is distinct from 'string' or char_length(props->>'prompt')>200 then return false; end if;
   end if;
   if kind='openQuestion' then allowed:=allowed||'important'::text; if jsonb_typeof(props->'important') is distinct from 'boolean' or block->>'id' !~ '^[0-9a-fA-F-]{36}$' then return false; end if; perform (block->>'id')::uuid; end if;
   if not planning.validate_idea_inline(block->'content') then return false; end if;
   if kind='openQuestion' and char_length(planning.idea_block_text(block))>200 then return false; end if;
   if kind='ideaAnswer' and char_length(planning.idea_block_text(block))+(case when props->>'prompt'<>'' then char_length(props->>'prompt')+34 else 0 end)>2000 then return false; end if;
  elsif kind in ('file','image') then
   allowed:=array['backgroundColor','name','url','caption'];
   if kind='image' then allowed:=allowed||array['textAlignment','showPreview','previewWidth']; if jsonb_typeof(props->'showPreview') is distinct from 'boolean' then return false; end if; end if;
   if block ? 'content' or jsonb_array_length(block->'children')<>0 then return false; end if;
   if jsonb_typeof(props->'name') is distinct from 'string' or char_length(props->>'name')>180 or jsonb_typeof(props->'caption') is distinct from 'string' or char_length(props->>'caption')>1000 or jsonb_typeof(props->'url') is distinct from 'string' then return false; end if;
   if props->>'url'<>'' then
    if props->>'url' !~ '^woolgather:(file|image):[0-9a-fA-F-]{36}$' then return false; end if;
    perform split_part(props->>'url',':',3)::uuid;
   end if;
  elsif kind='divider' then allowed:='{}'; if block ? 'content' or jsonb_array_length(block->'children')<>0 then return false; end if;
  elsif kind='codeBlock' then allowed:=array['language']; if jsonb_typeof(props->'language') is distinct from 'string' or char_length(props->>'language')>40 or not planning.validate_idea_inline(block->'content') then return false; end if;
  elsif kind='table' then
   allowed:=array['textColor']; contents:=block->'content';
   if jsonb_typeof(contents) is distinct from 'object' or (contents-array['type','columnWidths','headerRows','headerCols','rows'])<>'{}' or contents->>'type' is distinct from 'tableContent' or jsonb_typeof(contents->'columnWidths') is distinct from 'array' or jsonb_array_length(contents->'columnWidths') not between 1 and 20 or jsonb_typeof(contents->'rows') is distinct from 'array' or jsonb_array_length(contents->'rows') not between 1 and 100 then return false; end if;
   for value in select x from jsonb_array_elements(contents->'columnWidths') x loop if value<>'null'::jsonb and (jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric not between 0 and 4000) then return false; end if; end loop;
   for key,value in select * from jsonb_each(contents-array['type','columnWidths','rows']) loop if jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric) or (value#>>'{}')::integer not between 0 and (case when key='headerRows' then 100 else 20 end) then return false; end if; end loop;
   for row in select x from jsonb_array_elements(contents->'rows') x loop
    if (row-array['cells'])<>'{}' or jsonb_typeof(row->'cells') is distinct from 'array' or jsonb_array_length(row->'cells') not between 1 and 20 then return false; end if;
    for cell in select x from jsonb_array_elements(row->'cells') x loop
     if jsonb_typeof(cell)='array' then if not planning.validate_idea_inline(cell) then return false; end if;
     else
      if (cell-array['type','props','content'])<>'{}' or cell->>'type' is distinct from 'tableCell' or not planning.validate_idea_inline(cell->'content') then return false; end if;
      cprops:=cell->'props';
      if jsonb_typeof(cprops) is distinct from 'object' or (cprops-array['backgroundColor','textColor','textAlignment','colspan','rowspan'])<>'{}' or coalesce(cprops->>'textAlignment','') not in ('left','center','right','justify') then return false; end if;
      for key,value in select * from jsonb_each(cprops) loop
       if key in ('textColor','backgroundColor') then if jsonb_typeof(value)<>'string' or char_length(value#>>'{}')>60 or (value#>>'{}') !~ '^[#a-zA-Z0-9(),.%[:space:]-]+$' then return false; end if;
       elsif key in ('colspan','rowspan') then if jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric) or (value#>>'{}')::integer not between 1 and (case when key='colspan' then 20 else 100 end) then return false; end if; end if;
      end loop;
     end if;
    end loop;
   end loop;
  else return false; end if;
  if (props-allowed)<>'{}' then return false; end if;
  for key,value in select * from jsonb_each(props) loop
   if key in ('textColor','backgroundColor') then if jsonb_typeof(value)<>'string' or char_length(value#>>'{}')>60 or (value#>>'{}') !~ '^[#a-zA-Z0-9(),.%[:space:]-]+$' then return false; end if;
   elsif key='textAlignment' then if value#>>'{}' not in ('left','center','right','justify') then return false; end if;
   elsif key in ('checked','important','showPreview','isToggleable') then if jsonb_typeof(value)<>'boolean' then return false; end if;
   elsif key in ('previewWidth','level','start') then
    if jsonb_typeof(value)<>'number' or (key='previewWidth' and (value#>>'{}')::numeric not between 32 and 4000) or (key='start' and ((value#>>'{}')::numeric not between 1 and 1000000 or (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric))) then return false; end if;
   end if;
  end loop;
 end loop;
 return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;
$$;

alter function planning.validate_idea_document(jsonb) rename to validate_idea_document_v1;
create function planning.validate_idea_document(doc jsonb) returns boolean language plpgsql stable security invoker set search_path='' as $$
declare projection jsonb; flat jsonb; aid jsonb;
begin
 if doc->'version'='1'::jsonb then return planning.validate_idea_document_v1(doc); end if;
 if jsonb_typeof(doc) is distinct from 'object' or doc->'version' is distinct from '2'::jsonb or octet_length(doc::text)>1000000 or (doc-array['version','title','answers','covered','later','questions','references','blocks','attachments'])<>'{}' then return false; end if;
 if not planning.validate_idea_document_v1((doc-array['blocks','attachments'])||'{"version":1}'::jsonb) then return false; end if;
 if not planning.validate_idea_blocks(doc->'blocks') or jsonb_array_length(doc->'blocks')<1 then return false; end if;
 select coalesce(jsonb_agg(x),'[]') into flat from planning.flat_idea_blocks(doc->'blocks') x;
 if jsonb_array_length(flat)>1000 or (select count(distinct x->>'id') from jsonb_array_elements(flat) x)<>jsonb_array_length(flat) then return false; end if;
 if (select count(*) from jsonb_array_elements(flat) x where x->>'type'='ideaAnswer')<>(select count(distinct x->'props'->>'field') from jsonb_array_elements(flat) x where x->>'type'='ideaAnswer') then return false; end if;
 projection:=planning.idea_block_projection(doc->'blocks');
 if char_length(projection->>'body')>100000 or (projection-'body') is distinct from jsonb_build_object('answers',doc->'answers','questions',doc->'questions','references',doc->'references','attachments',doc->'attachments') then return false; end if;
 if jsonb_typeof(doc->'attachments') is distinct from 'array' or jsonb_array_length(doc->'attachments')>40 then return false; end if;
 for aid in select value from jsonb_array_elements(doc->'attachments') loop
  if jsonb_typeof(aid)<>'string' or not planning.attachment_available((aid#>>'{}')::uuid) then return false; end if;
 end loop;
 return true;
exception when invalid_text_representation then return false;
end;
$$;
revoke all on function planning.validate_idea_document(jsonb),planning.idea_inline_text(jsonb),planning.idea_block_text(jsonb),planning.flat_idea_blocks(jsonb),planning.idea_block_projection(jsonb),planning.validate_idea_inline(jsonb),planning.validate_idea_blocks(jsonb,integer) from public,anon;
grant execute on function planning.validate_idea_document(jsonb),planning.idea_inline_text(jsonb),planning.idea_block_text(jsonb),planning.flat_idea_blocks(jsonb),planning.idea_block_projection(jsonb),planning.validate_idea_inline(jsonb),planning.validate_idea_blocks(jsonb,integer) to authenticated;

-- Enforce the same source/projection invariant even for direct Data API writes.
create function planning.check_block_document() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='UPDATE' and old.document->'version'='2'::jsonb and new.document->'version' is distinct from '2'::jsonb then raise exception 'Reload this idea in the current editor before editing.' using errcode='22023'; end if;
 if new.document->'version'='2'::jsonb then
  if not planning.validate_idea_document(new.document) or new.body is distinct from planning.idea_block_projection(new.document->'blocks')->>'body' then raise exception 'Invalid block document or projection' using errcode='22023'; end if;
 end if;
 return new;
end;
$$;
create trigger check_block_document before insert or update of document,body on planning.ideas for each row execute function planning.check_block_document();
-- Raise the text projection bound without changing existing rows or their revisions.
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='planning.ideas'::regclass and contype='c' and pg_get_constraintdef(oid) like '%body%' loop execute format('alter table planning.ideas drop constraint %I',c.conname); end loop;
end $$;
alter table planning.ideas add constraint ideas_body_size check(char_length(body)<=100000);

create function account_private.attachment_referenced(aid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from planning.ideas where document->'attachments' @> jsonb_build_array(aid::text))
 or exists(select 1 from planning.projects where idea_document->'attachments' @> jsonb_build_array(aid::text));
$$;
create function account_private.queue_attachment_delete() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into account_private.attachment_garbage(path) values(old.owner_id::text||'/'||old.id::text) on conflict do nothing;
 return old;
end;
$$;
create trigger queue_attachment_delete after delete on account_private.attachments for each row execute function account_private.queue_attachment_delete();
create function account_private.collect_removed_document_files() returns trigger language plpgsql security definer set search_path='' as $$
declare doc jsonb; aid jsonb;
begin
 doc:=case when tg_table_name='ideas' then to_jsonb(old)->'document' else to_jsonb(old)->'idea_document' end;
 for aid in select value from jsonb_array_elements(coalesce(doc->'attachments','[]'::jsonb)) loop
  if not account_private.attachment_referenced((aid#>>'{}')::uuid) then delete from account_private.attachments where id=(aid#>>'{}')::uuid; end if;
 end loop;
 return old;
end;
$$;
create trigger collect_idea_files after delete on planning.ideas for each row execute function account_private.collect_removed_document_files();
create trigger collect_project_files after delete on planning.projects for each row execute function account_private.collect_removed_document_files();
create function account_private.touch_document_files() returns trigger language plpgsql security definer set search_path='' as $$
declare doc jsonb:=new.document;
begin
 update account_private.attachments set touched_at=clock_timestamp() where owner_id=new.owner_id and id in(select value::uuid from jsonb_array_elements_text(coalesce(doc->'attachments','[]'::jsonb)));
 return new;
end;
$$;
create trigger touch_document_files after insert or update of document on planning.ideas for each row execute function account_private.touch_document_files();
revoke all on function account_private.attachment_referenced(uuid),account_private.queue_attachment_delete(),account_private.collect_removed_document_files(),account_private.touch_document_files() from public,anon,authenticated;

create function public.collect_attachment_garbage() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('woolgather-attachment-budget',0));
 delete from account_private.attachments where (state='pending' and touched_at<now()-interval '1 day') or (state='ready' and touched_at<now()-interval '7 days' and not account_private.attachment_referenced(id));
 -- An upload interrupted after account deletion can leave bytes without metadata.
 -- Read Storage's metadata; removal always goes through its API in the worker.
 insert into account_private.attachment_garbage(path)
 select name from storage.objects o where bucket_id='idea-attachments' and created_at<now()-interval '2 hours' and not exists(select 1 from account_private.attachments a where o.name=a.owner_id::text||'/'||a.id::text)
 on conflict(path) do update set deleted_at=null;
 return coalesce((select jsonb_agg(path) from (select path from account_private.attachment_garbage where deleted_at is null order by queued_at limit 100) x),'[]'::jsonb);
end;
$$;
create function public.ack_attachment_garbage(paths jsonb) returns void language sql security definer set search_path='' as $$
 update account_private.attachment_garbage set deleted_at=clock_timestamp() where path in(select value from jsonb_array_elements_text(paths));
$$;
revoke all on function public.collect_attachment_garbage(),public.ack_attachment_garbage(jsonb) from public,anon,authenticated;
grant execute on function public.collect_attachment_garbage(),public.ack_attachment_garbage(jsonb) to service_role;

-- Service-only bootstrap: the Edge Function supplies its own built-in service
-- credential directly to Vault. It never passes through the browser/Worker.
create function public.configure_attachment_maintenance(endpoint text, service_token text) returns void language plpgsql security definer set search_path='' as $$
declare secret_id uuid; job_id bigint; sql_command text;
begin
 if endpoint !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/attachments\?action=cleanup$' or length(service_token)<30 then raise exception 'Invalid maintenance configuration'; end if;
 if not exists(select 1 from pg_extension where extname='pg_cron') then create extension pg_cron; end if;
 if not exists(select 1 from pg_extension where extname='pg_net') then create extension pg_net with schema extensions; end if;
 if not exists(select 1 from pg_extension where extname='supabase_vault') then create extension supabase_vault with schema vault; end if;
 select id into secret_id from vault.secrets where name='woolgather_attachment_maintenance';
 if secret_id is null then perform vault.create_secret(service_token,'woolgather_attachment_maintenance'); else perform vault.update_secret(secret_id,service_token); end if;
 select jobid into job_id from cron.job where jobname='woolgather-attachment-cleanup';
 if job_id is not null then perform cron.unschedule(job_id); end if;
 sql_command:=format('select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''Authorization'',''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name=''woolgather_attachment_maintenance'')), body := ''{"action":"cleanup"}''::jsonb, timeout_milliseconds := 55000);',endpoint);
 perform cron.schedule('woolgather-attachment-cleanup','17 * * * *',sql_command);
end;
$$;
revoke all on function public.configure_attachment_maintenance(text,text) from public,anon,authenticated;
grant execute on function public.configure_attachment_maintenance(text,text) to service_role;

-- Existing idempotent command contract, widened for canonical block JSON.
create or replace function public.library_command(command jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid(); cid uuid:=(command->>'id')::uuid; target_id uuid:=(command->>'targetId')::uuid;
 kind text:=command->>'type'; expected integer:=(command->>'expectedRevision')::integer;
 prior planning.library_receipts; idea planning.ideas; folder planning.folders; result jsonb; pid uuid; created jsonb; q jsonb; project_revision integer; question_id uuid;
begin
 if actor is null or public.account_access()<>'ok' then raise exception 'Sign in required' using errcode='28000'; end if;
 if octet_length(command::text)>1500000 or cid is null or target_id is null or kind is null or expected is null or expected<0 then raise exception 'Invalid command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('planning-write:'||actor::text,0));
 if exists(select 1 from planning.trash_receipts where idea_ids @> array[target_id] or project_ids @> array[(command->>'projectId')::uuid]) then raise exception 'Item permanently deleted' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into prior from planning.library_receipts where owner_id=actor and id=cid;
 if found then
  if prior.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return prior.result;
 end if;
 if kind='save_idea' and command ? 'document' and not planning.validate_idea_document(command->'document') then raise exception 'Invalid idea document' using errcode='22023'; end if;
 if kind='save_folder' and exists(select 1 from planning.deleted_folders where id=target_id) then raise exception 'Folder deleted' using errcode='P0002'; end if;
 if kind='delete_folder' then
  select * into folder from planning.folders where id=target_id for update;
  if not found then raise exception 'Folder not found' using errcode='P0002'; end if;
  if folder.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
  update planning.projects set folder_id=null,revision=revision+1,updated_at=clock_timestamp() where folder_id=target_id;
  update planning.ideas set folder_id=null,revision=revision+1,updated_at=clock_timestamp() where folder_id=target_id;
  insert into planning.deleted_folders values(target_id,actor);
  delete from planning.folders where id=target_id;
 elsif kind='save_folder' then
  if expected=0 then
   insert into planning.folders(id,owner_id,name) values(target_id,actor,trim(command->>'name'));
  else
   select * into folder from planning.folders where id=target_id for update;
   if not found then raise exception 'Folder not found' using errcode='P0002'; end if;
   if folder.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
   update planning.folders set name=trim(command->>'name'),revision=revision+1 where id=target_id;
  end if;
 elsif kind='save_idea' and expected=0 then
  if nullif(command->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(command->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
  insert into planning.ideas(id,owner_id,body,folder_id,document) values(target_id,actor,command->>'body',nullif(command->>'folderId','')::uuid,command->'document');
 elsif kind in ('save_idea','move_idea','archive_idea','trash_idea','restore_idea','convert_idea') then
  select * into idea from planning.ideas where id=target_id for update;
  if not found then raise exception 'Idea not found' using errcode='P0002'; end if;
  if idea.revision<>expected then raise exception 'Revision conflict' using errcode='PT409'; end if;
  if kind='save_idea' then
   if idea.project_id is not null or idea.trashed or idea.archived then raise exception 'Idea is read only' using errcode='22023'; end if;
   update planning.ideas set body=command->>'body',document=case when command ? 'document' then command->'document' else document end where id=target_id;
  elsif kind='move_idea' then
   if idea.trashed or idea.archived then raise exception 'Restore this idea before moving it' using errcode='22023'; end if;
   if nullif(command->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(command->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
   update planning.ideas set folder_id=nullif(command->>'folderId','')::uuid where id=target_id;
  elsif kind='convert_idea' then
   if idea.project_id is not null or idea.trashed or idea.archived or (trim(idea.body)='' and not exists(select 1 from jsonb_each_text(coalesce(idea.document->'answers','{}'::jsonb)) answer where trim(answer.value)<>'') and jsonb_array_length(coalesce(idea.document->'references','[]'::jsonb))=0 and jsonb_array_length(coalesce(idea.document->'questions','[]'::jsonb))=0 and jsonb_array_length(coalesce(idea.document->'attachments','[]'::jsonb))=0) then raise exception 'Idea cannot be converted' using errcode='22023'; end if;
   if nullif(command->>'folderId','') is not null and not exists(select 1 from planning.folders where id=(command->>'folderId')::uuid) then raise exception 'Folder not found' using errcode='22023'; end if;
   if command ? 'brief' and (jsonb_typeof(command->'brief') is distinct from 'string' or char_length(command->>'brief')>12000) then raise exception 'Invalid brief' using errcode='22023'; end if;
   pid:=(command->>'projectId')::uuid;
   insert into planning.projects(id,owner_id,name,description,folder_id,original_idea,idea_document,image_references,revision) values(pid,actor,coalesce(nullif(trim(command->>'name'),''),'Untitled Project'),coalesce(command->>'brief',idea.body),nullif(command->>'folderId','')::uuid,idea.body,idea.document,coalesce(idea.document->'references','[]'::jsonb),1);
   if command ? 'questions' then
    if jsonb_typeof(command->'questions') is distinct from 'array' or jsonb_array_length(command->'questions')>15 then raise exception 'Invalid questions' using errcode='22023'; end if;
    for q in select value from jsonb_array_elements(command->'questions') loop
     if jsonb_typeof(q) is distinct from 'string' or char_length(trim(q#>>'{}')) not between 1 and 200 then raise exception 'Invalid question' using errcode='22023'; end if;
     question_id:=gen_random_uuid();
     insert into planning.items(id,project_id,title,body,category,certainty,status,source) values(question_id,pid,q#>>'{}','Carried forward from the idea. This is an open question, not a requirement.','question','tentative','open','Open question from original idea');
    end loop;
   end if;
   created:=public.project_snapshot(pid);
   insert into planning.history(project_id,revision,action,after_item,context) values(pid,1,'create_project',jsonb_build_object('title',created->>'name','body',created->>'description'),jsonb_build_object('sourceIdeaId',target_id,'openQuestions',coalesce(command->'questions','[]'::jsonb)));
   created:=public.project_snapshot(pid);
   insert into planning.commands(owner_id,id,project_id,request,result) values(actor,cid,pid,command,created);
   update planning.ideas set project_id=pid,folder_id=nullif(command->>'folderId','')::uuid where id=target_id;
  else
   update planning.ideas set trashed=(kind='trash_idea'),archived=(kind='archive_idea') where id=target_id;
  end if;
  update planning.ideas set revision=revision+1,updated_at=clock_timestamp() where id=target_id;
 else raise exception 'Unknown command' using errcode='22023';
 end if;
 result:=public.library_snapshot();
 insert into planning.library_receipts values(actor,cid,command,result);
 return result;
end;
$$;
