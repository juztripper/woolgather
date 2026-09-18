-- Apply the final preparation lock order to development databases that
-- received the terminal-receipt migration before this concurrency refinement.
-- Fresh databases already have this definition; replacement is idempotent.

create or replace function public.project_voice_prepare(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c jsonb; run account_private.project_voice_sessions; p planning.projects; attempt uuid;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 perform account_private.project_voice_signature(payload,signature,'woolgather.voice.v1:'||actor::text||':'); c:=payload::jsonb;
 if c->>'action' is distinct from 'prepare' or (c->>'runId')::uuid is null or (c->>'projectId')::uuid is null or (c->>'revision')::integer is null or (c->>'attemptId')::uuid is null or coalesce(c->>'capability','')='' then
  raise exception 'Invalid voice preparation' using errcode='22023';
 end if;
 attempt:=(c->>'attemptId')::uuid;
 select * into run from account_private.project_voice_sessions where id=(c->>'runId')::uuid and owner_id=actor for update;
 if run.id is null then raise exception 'Voice run unavailable' using errcode='P0002'; end if;
 select * into p from planning.projects where id=(c->>'projectId')::uuid and owner_id=actor for update;
 if p.id is null or p.lifecycle<>'active' then raise exception 'Project unavailable' using errcode='P0002'; end if;
 if p.revision is distinct from (c->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if run.project_id is distinct from p.id or run.revision is distinct from p.revision then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if run.capability_hash is distinct from encode(extensions.digest(c->>'capability','sha256'),'hex') then raise exception 'Voice capability mismatch' using errcode='42501'; end if;
 if run.status<>'reserved' then raise exception 'Voice admission is no longer preparable' using errcode='PT425'; end if;
 if run.provider_session_id is not null then raise exception 'Voice provider session is already bound' using errcode='PT425'; end if;
 if run.attempt_id is not null then
  if run.attempt_id is distinct from attempt then raise exception 'Voice attempt mismatch' using errcode='PT409'; end if;
  return jsonb_build_object('prepared',false,'started',false,'replayed',true,'runId',run.id,'status',run.status,'expiresAt',floor(extract(epoch from run.expires_at)*1000));
 end if;
 if run.expires_at<=clock_timestamp() then raise exception 'Voice admission has expired' using errcode='PT425'; end if;
 update account_private.project_voice_sessions set attempt_id=attempt where id=run.id;
 return jsonb_build_object('prepared',true,'started',false,'replayed',false,'runId',run.id,'status','reserved','expiresAt',floor(extract(epoch from run.expires_at)*1000));
end; $$;
revoke all on function public.project_voice_prepare(text,text) from public,anon;
grant execute on function public.project_voice_prepare(text,text) to authenticated;
