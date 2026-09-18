-- Optional assistance is closed by default. Operator grants are finite and are
-- never replenished by client calls. Each reserved request consumes 10 US cents
-- against the configured provider price/input/output limits; ambiguous failures
-- consume their reservation too. Also provision a credit-limited provider key.
create table account_private.guidance_allowances (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 max_requests integer not null default 0 check(max_requests between 0 and 100),
 used_requests integer not null default 0 check(used_requests>=0),
 last_requested_at timestamptz
);
create table account_private.guidance_runs (
 id uuid primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 idea_id uuid not null references planning.ideas(id) on delete cascade,
 fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
 result jsonb,
 created_at timestamptz not null default now(),
 unique(owner_id,idea_id,fingerprint)
);
create index guidance_runs_idea on account_private.guidance_runs(idea_id);
alter table account_private.guidance_allowances enable row level security;
alter table account_private.guidance_runs enable row level security;
revoke all on account_private.guidance_allowances,account_private.guidance_runs from public,anon,authenticated;
create function account_private.idea_guidance_command(payload text, signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); key_value text; expected bytea; supplied bytea;
 difference integer:=0; i integer; command jsonb; allowance account_private.guidance_allowances;
 existing account_private.guidance_runs; idea planning.ideas;
begin
 if actor is null or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
 if payload is null or octet_length(payload)>64000 or signature is null or signature !~ '^[0-9a-f]{64}$' then raise exception 'Invalid guidance command' using errcode='22023'; end if;
 select secret into key_value from account_private.action_secrets where purpose='account_deletion';
 if key_value is null then raise exception 'Guidance unavailable' using errcode='42501'; end if;
 expected:=extensions.hmac(convert_to('woolgather.guidance.v1:'||actor::text||':'||payload,'UTF8'),convert_to(key_value,'UTF8'),'sha256');
 supplied:=decode(signature,'hex');
 for i in 0..31 loop difference:=difference | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
 if difference<>0 then raise exception 'Invalid guidance signature' using errcode='42501'; end if;
 command:=payload::jsonb;
 select * into allowance from account_private.guidance_allowances where owner_id=actor for update;
 if allowance.owner_id is null then raise exception 'Guidance unavailable' using errcode='42501'; end if;
 if command->>'action'='finish' then
  update account_private.guidance_runs set result=command->'result'
   where id=(command->>'runId')::uuid and owner_id=actor and result is null;
  if not found then raise exception 'Run unavailable' using errcode='P0002'; end if;
  return '{}'::jsonb;
 end if;
 if command->>'action' is distinct from 'reserve' then raise exception 'Invalid action' using errcode='22023'; end if;
 select * into idea from planning.ideas where id=(command->>'ideaId')::uuid and owner_id=actor for share;
 if idea.id is null or idea.trashed or idea.archived or idea.project_id is not null then raise exception 'Idea unavailable' using errcode='P0002'; end if;
 if idea.revision is distinct from (command->>'revision')::integer then raise exception 'Idea changed' using errcode='PT409'; end if;
 select * into existing from account_private.guidance_runs where owner_id=actor and idea_id=idea.id and fingerprint=command->>'fingerprint';
 if existing.id is not null then return jsonb_build_object('reserved',false,'result',existing.result); end if;
 if allowance.used_requests>=allowance.max_requests or allowance.last_requested_at>clock_timestamp()-interval '15 seconds' then raise exception 'Guidance allowance reached' using errcode='PT429'; end if;
 update account_private.guidance_allowances set used_requests=used_requests+1,last_requested_at=clock_timestamp() where owner_id=actor;
 insert into account_private.guidance_runs(id,owner_id,idea_id,fingerprint) values((command->>'runId')::uuid,actor,idea.id,command->>'fingerprint');
 return jsonb_build_object('reserved',true);
end;
$$;
revoke all on function account_private.idea_guidance_command(text,text) from public,anon;
grant execute on function account_private.idea_guidance_command(text,text) to authenticated;
create function public.idea_guidance_command(payload text,signature text) returns jsonb
language sql security invoker set search_path='' as $$ select account_private.idea_guidance_command(payload,signature); $$;
revoke all on function public.idea_guidance_command(text,text) from public,anon;
grant execute on function public.idea_guidance_command(text,text) to authenticated;
