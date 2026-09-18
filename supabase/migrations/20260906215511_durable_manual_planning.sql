-- Canonical tables are deliberately outside the Data API's exposed schemas.
-- Public RPCs run as the caller, under ownership RLS; no service-role bypass.
create schema if not exists planning;
revoke all on schema planning from public;
grant usage on schema planning to authenticated;

create table planning.projects (
 id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null check (char_length(name) between 1 and 120),
 description text not null default '' check (char_length(description)<=12000),
 revision integer not null default 0 check (revision>=0),
 updated_at timestamptz not null default now()
);
create index projects_owner on planning.projects(owner_id, updated_at desc);
create table planning.items (
 id uuid primary key, project_id uuid not null references planning.projects(id) on delete cascade,
 title text not null check(char_length(title) between 1 and 200),
 body text not null default '' check(char_length(body)<=12000),
 category text not null check(category in ('purpose','feature','constraint','decision','question','gap','note')),
 certainty text not null check(certainty in ('stated','tentative','confirmed')),
 status text not null default 'open' check(status in ('open','answered','deferred','resolved','recheck')),
 answer text not null default '' check(char_length(answer)<=12000),
 links uuid[] not null default '{}', removed boolean not null default false,
 source text not null default 'Written by you', promoted_from uuid unique references planning.items(id),
 created_at timestamptz not null default now()
);
create index items_project on planning.items(project_id);
create table planning.commands (
 owner_id uuid not null references auth.users(id) on delete cascade,
 id uuid not null, project_id uuid not null references planning.projects(id) on delete cascade,
 request jsonb not null, result jsonb not null, primary key(owner_id,id)
);
create table planning.history (
 project_id uuid not null references planning.projects(id) on delete cascade,
 revision integer not null, action text not null, at timestamptz not null default now(),
 before_item jsonb, after_item jsonb, primary key(project_id,revision)
);

alter table planning.projects enable row level security;
alter table planning.items enable row level security;
alter table planning.commands enable row level security;
alter table planning.history enable row level security;
create policy own_projects on planning.projects to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy own_items on planning.items to authenticated using(exists(select 1 from planning.projects p where p.id=project_id and p.owner_id=(select auth.uid()))) with check(exists(select 1 from planning.projects p where p.id=project_id and p.owner_id=(select auth.uid())));
create policy own_commands on planning.commands to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy own_history on planning.history to authenticated using(exists(select 1 from planning.projects p where p.id=project_id and p.owner_id=(select auth.uid()))) with check(exists(select 1 from planning.projects p where p.id=project_id and p.owner_id=(select auth.uid())));
grant select,insert,update on planning.projects,planning.items to authenticated;
grant select,insert on planning.commands,planning.history to authenticated;

create function public.project_snapshot(project_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'revision',p.revision,'updatedAt',p.updated_at,
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'body',i.body,'category',i.category,'certainty',i.certainty,'status',i.status,'answer',i.answer,'links',i.links,'removed',i.removed,'source',i.source,'promotedFrom',i.promoted_from) order by i.created_at,i.id) from planning.items i where i.project_id=p.id),'[]'::jsonb))
 from planning.projects p where p.id=project_id;
$$;
create function public.list_projects() returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(s order by s."updatedAt" desc),'[]'::jsonb) from (
 select p.id,p.name,p.description,p.revision,p.updated_at as "updatedAt",(select count(*) from planning.items i where i.project_id=p.id and not i.removed) as "itemCount" from planning.projects p
 ) s;
$$;
create function public.project_history(project_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('revision',h.revision,'action',h.action,'at',h.at,'before',h.before_item,'after',h.after_item) order by h.revision desc),'[]'::jsonb) from planning.history h where h.project_id=project_history.project_id;
$$;

create function public.execute_command(command jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 actor uuid:=auth.uid(); pid uuid:=(command->>'projectId')::uuid; cid uuid:=(command->>'id')::uuid;
 expected integer:=(command->>'expectedRevision')::integer; a jsonb:=command->'action'; kind text:=a->>'type';
 iid uuid:=(a->>'itemId')::uuid; data jsonb:=a->'item'; previous planning.commands;
 p planning.projects; target planning.items; before_state jsonb; result jsonb; link_ids uuid[];
begin
 if actor is null then raise exception 'Sign in required' using errcode='28000'; end if;
 if cid is null or pid is null or expected is null or expected<0 or kind is null then raise exception 'Invalid command' using errcode='22023'; end if;
 -- Serialize identical retry keys before checking their receipt, including create.
 perform pg_advisory_xact_lock(hashtextextended(actor::text||cid::text,0));
 select * into previous from planning.commands c where c.owner_id=actor and c.id=cid;
 if found then
  if previous.request<>command then raise exception 'Retry key reused with different content' using errcode='22023'; end if;
  return previous.result;
 end if;
 if kind='create_project' then
  if expected<>0 then raise exception 'Revision conflict' using errcode='40001'; end if;
  insert into planning.projects(id,owner_id,name,description) values(pid,actor,coalesce(nullif(trim(a->>'name'),''),'Untitled Project'),coalesce(a->>'description',''));
 end if;
 select * into p from planning.projects where id=pid for update;
 if not found then raise exception 'Project not found' using errcode='P0002'; end if;
 if p.revision<>expected then raise exception 'Revision conflict' using errcode='40001'; end if;
 if kind='rename_project' then
  update planning.projects set name=trim(a->>'name') where id=pid;
 elsif kind in ('add_item','edit_item') then
  if iid is null or data is null then raise exception 'Invalid item' using errcode='22023'; end if;
  if jsonb_typeof(data->'links')<>'array' or jsonb_array_length(data->'links')>100 then raise exception 'Invalid links' using errcode='22023'; end if;
  select coalesce(array_agg(value::uuid),'{}') into link_ids from jsonb_array_elements_text(data->'links');
  if exists(select 1 from unnest(link_ids) x where x=iid or not exists(select 1 from planning.items i where i.id=x and i.project_id=pid and not i.removed)) then raise exception 'Linked item not found' using errcode='22023'; end if;
  if data->>'category' not in ('question','gap') and data->>'status'<>'open' then raise exception 'Status belongs to questions and gaps' using errcode='22023'; end if;
  if data->>'status' in ('answered','resolved') and coalesce(trim(data->>'answer'),'')='' then raise exception 'Add an answer or resolution' using errcode='22023'; end if;
  if kind='add_item' then
   insert into planning.items(id,project_id,title,body,category,certainty,status,answer,links) values(iid,pid,trim(data->>'title'),data->>'body',data->>'category',data->>'certainty',data->>'status',data->>'answer',link_ids);
  else
   select * into target from planning.items where id=iid and project_id=pid and not removed;
   if not found then raise exception 'Item not found' using errcode='P0002'; end if;
   before_state:=to_jsonb(target);
   update planning.items set title=trim(data->>'title'),body=data->>'body',category=data->>'category',certainty=data->>'certainty',status=data->>'status',answer=data->>'answer',links=link_ids where id=iid and project_id=pid;
  end if;
 elsif kind in ('remove_item','restore_item','promote_answer') then
  select * into target from planning.items where id=iid and project_id=pid;
  if not found then raise exception 'Item not found' using errcode='P0002'; end if;
  before_state:=to_jsonb(target);
  if kind='promote_answer' then
   if target.removed or target.category<>'question' or target.status<>'answered' or trim(target.answer)='' then raise exception 'Answer the question first' using errcode='22023'; end if;
   -- Repeat promotion preserves the already-created decision, including later edits/removal.
   if not exists(select 1 from planning.items where promoted_from=iid) then
    insert into planning.items(id,project_id,title,body,category,certainty,source,promoted_from,links) values((a->>'decisionId')::uuid,pid,target.title,target.answer,'decision','confirmed','Answer to a project question',iid,array[iid]);
   end if;
  else
   update planning.items set removed=(kind='remove_item') where id=iid;
  end if;
 elsif kind<>'create_project' then
  raise exception 'Unknown command' using errcode='22023';
 end if;
 -- Changing related meaning reopens resolved gaps for review, never overwrites the explanation.
 if kind in ('edit_item','remove_item','restore_item') then
  update planning.items set status='recheck' where project_id=pid and category='gap' and status='resolved' and iid=any(links) and id<>iid and not removed;
 end if;
 update planning.projects set revision=revision+1,updated_at=clock_timestamp() where id=pid returning * into p;
 insert into planning.history(project_id,revision,action,before_item,after_item) values(pid,p.revision,kind,before_state,(select to_jsonb(i) from planning.items i where i.id=iid and i.project_id=pid));
 result:=public.project_snapshot(pid);
 insert into planning.commands(owner_id,id,project_id,request,result) values(actor,cid,pid,command,result);
 return result;
end;
$$;
revoke all on function public.project_snapshot(uuid),public.list_projects(),public.project_history(uuid),public.execute_command(jsonb) from public,anon;
grant execute on function public.project_snapshot(uuid),public.list_projects(),public.project_history(uuid),public.execute_command(jsonb) to authenticated;
