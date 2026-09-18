-- Voice rows retain their accounting receipt after project/account deletion,
-- but their transcript is private content and must not survive either foreign
-- key being cleared. This trigger also covers a late Durable Object settlement
-- update after the parent deletion has already happened.

create or replace function account_private.redact_orphan_project_voice_transcript() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.owner_id is null or new.project_id is null then
  new.transcript:='[]'::jsonb;
 end if;
 return new;
end; $$;
revoke all on function account_private.redact_orphan_project_voice_transcript() from public,anon,authenticated;

drop trigger if exists project_voice_redact_orphan_transcript on account_private.project_voice_sessions;
create trigger project_voice_redact_orphan_transcript
before insert or update on account_private.project_voice_sessions
for each row execute function account_private.redact_orphan_project_voice_transcript();

-- Clean any orphaned rows that may have been created before this migration.
update account_private.project_voice_sessions
set transcript='[]'::jsonb
where owner_id is null or project_id is null;
