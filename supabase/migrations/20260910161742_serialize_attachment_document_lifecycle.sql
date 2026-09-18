-- A collector must not remove an unreferenced file while a concurrent document
-- is attaching it. Take the same transaction lock before constraints are checked.
create function account_private.lock_attachment_documents() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('woolgather-attachment-budget',0));
 return null;
end;
$$;
revoke all on function account_private.lock_attachment_documents() from public,anon,authenticated;
create trigger lock_attachment_documents before insert or update or delete on planning.ideas for each statement execute function account_private.lock_attachment_documents();
create trigger lock_attachment_documents before insert or update or delete on planning.projects for each statement execute function account_private.lock_attachment_documents();
