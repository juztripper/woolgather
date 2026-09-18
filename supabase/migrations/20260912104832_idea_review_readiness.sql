-- Preserve the actual reviewed document independently of its exact text hash.
-- This stays private, owner-scoped, and is deleted with the idea's review records.
alter table account_private.guidance_runs add column source_snapshot jsonb;

create function account_private.capture_guidance_source() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 select jsonb_build_object('body',i.body,'document',i.document) into new.source_snapshot
 from planning.ideas i where i.id=new.idea_id and i.owner_id=new.owner_id;
 return new;
end; $$;
revoke all on function account_private.capture_guidance_source() from public,anon,authenticated;
create trigger guidance_source_snapshot before insert on account_private.guidance_runs
for each row execute function account_private.capture_guidance_source();

-- Recover existing reviews from the exact saved revision, never from newer text.
-- Library command receipts already preserve the original authored snapshot.
update account_private.guidance_runs r
set source_snapshot=jsonb_build_object('body',i.body,'document',i.document)
from account_private.guidance_journal j, planning.ideas i
where j.id=r.id and i.id=r.idea_id and i.owner_id=r.owner_id and i.revision=j.revision;
update account_private.guidance_runs r set source_snapshot=(
 select jsonb_build_object('body',saved->>'body','document',saved->'document')
 from planning.library_receipts receipt
 cross join lateral jsonb_array_elements(coalesce(receipt.result->'ideas','[]'::jsonb)) saved
 where receipt.owner_id=r.owner_id and saved->>'id'=r.idea_id::text
 and saved->>'revision'=j.revision::text
 limit 1
)
from account_private.guidance_journal j
where j.id=r.id and r.source_snapshot is null;

create or replace function account_private.guidance_run_view(run_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('runId',r.id,'status',j.status,'revision',j.revision,'sourceKey',r.source_key,
 'sourceSnapshot',r.source_snapshot,'result',r.result,'errorCode',j.error_code,'createdAt',j.created_at)
 from account_private.guidance_runs r join account_private.guidance_journal j on j.id=r.id
 where r.id=run_id and r.owner_id=auth.uid();
$$;
revoke all on function account_private.guidance_run_view(uuid) from public,anon,authenticated;

-- Reopening restores the most recent review. A matching older source must not
-- displace a later ready state after an edit/undo or a continued review.
do $$
declare definition text; old_clause text:='order by (source_key=command->>''sourceKey'') desc nulls last,created_at desc limit 1';
begin
 definition:=pg_get_functiondef('account_private.idea_guidance_command(text,text)'::regprocedure);
 if strpos(definition,old_clause)=0 then raise exception 'Guidance status definition changed; inspect migration'; end if;
 execute replace(definition,old_clause,'order by created_at desc,id desc limit 1');
end; $$;
