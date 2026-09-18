-- Direct OpenAI billing: exact usage settlement plus an independent lifetime
-- wallet. Operator funding is explicit; monthly provider limits never refill it.
create table account_private.guidance_wallet (
 id text primary key check(id='openai'),
 enabled boolean not null default false,
 budget_microusd bigint not null default 0 check(budget_microusd>=0),
 spent_microusd bigint not null default 0 check(spent_microusd>=0),
 reserved_microusd bigint not null default 0 check(reserved_microusd>=0)
);
alter table account_private.guidance_wallet enable row level security;
revoke all on account_private.guidance_wallet from public,anon,authenticated;
insert into account_private.guidance_wallet(id) values('openai');
alter table account_private.guidance_allowances
 add column budget_microusd bigint not null default 0 check(budget_microusd>=0),
 add column spent_microusd bigint not null default 0 check(spent_microusd>=0),
 add column reserved_microusd bigint not null default 0 check(reserved_microusd>=0);
alter table account_private.guidance_runs
 add column model text,
 add column reserve_microusd bigint not null default 0 check(reserve_microusd>=0),
 add column usage jsonb,
 add column settled_at timestamptz;
-- Preserve old counters and records. No historical reservations are refunded.
create or replace function account_private.idea_guidance_command(payload text, signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); key_value text; expected bytea; supplied bytea;
 difference integer:=0; i integer; command jsonb; allowance account_private.guidance_allowances;
 existing account_private.guidance_runs; idea planning.ideas;
 wallet account_private.guidance_wallet; reserve_amount bigint; actual_amount bigint;
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
 -- Stable global -> owner -> run lock order across reservations and settlement.
 select * into wallet from account_private.guidance_wallet where id='openai' for update;
 select * into allowance from account_private.guidance_allowances where owner_id=actor for update;
 if allowance.owner_id is null then raise exception 'Guidance unavailable' using errcode='42501'; end if;
 if command->>'action'='finish' then
  select * into existing from account_private.guidance_runs where id=(command->>'runId')::uuid and owner_id=actor for update;
  if existing.id is null then raise exception 'Run unavailable' using errcode='P0002'; end if;
  if existing.settled_at is not null then return '{}'::jsonb; end if;
  actual_amount:=(command->'usage'->>'costMicrousd')::bigint;
  if actual_amount is null or actual_amount<0 or actual_amount>5000000 or (command->'usage'->>'model') is distinct from existing.model then raise exception 'Invalid usage' using errcode='22023'; end if;
  update account_private.guidance_runs set result=nullif(command->'result','null'::jsonb),usage=command->'usage',settled_at=clock_timestamp() where id=existing.id;
  update account_private.guidance_allowances set reserved_microusd=reserved_microusd-existing.reserve_microusd,spent_microusd=spent_microusd+actual_amount where owner_id=actor;
  update account_private.guidance_wallet set reserved_microusd=reserved_microusd-existing.reserve_microusd,spent_microusd=spent_microusd+actual_amount,
   enabled=enabled and actual_amount<=existing.reserve_microusd where id='openai';
  return '{}'::jsonb;
 end if;
 if command->>'action' is distinct from 'reserve' then raise exception 'Invalid action' using errcode='22023'; end if;
 select * into idea from planning.ideas where id=(command->>'ideaId')::uuid and owner_id=actor for share;
 if idea.id is null or idea.trashed or idea.archived or idea.project_id is not null then raise exception 'Idea unavailable' using errcode='P0002'; end if;
 if idea.revision is distinct from (command->>'revision')::integer then raise exception 'Idea changed' using errcode='PT409'; end if;
 select * into existing from account_private.guidance_runs where owner_id=actor and idea_id=idea.id and fingerprint=command->>'fingerprint';
 if existing.id is not null then return jsonb_build_object('reserved',false,'result',existing.result); end if;
 reserve_amount:=(command->>'reserveMicrousd')::bigint;
 if reserve_amount is null or reserve_amount<=0 or reserve_amount>2000000 or coalesce(command->>'model','') not in ('gpt-5.6-sol','gpt-5.6-terra','gpt-6-astra') then raise exception 'Invalid reservation' using errcode='22023'; end if;
 if not wallet.enabled or wallet.spent_microusd+wallet.reserved_microusd+reserve_amount>wallet.budget_microusd
  or allowance.spent_microusd+allowance.reserved_microusd+reserve_amount>allowance.budget_microusd
  or allowance.used_requests>=allowance.max_requests or allowance.last_requested_at>clock_timestamp()-interval '15 seconds' then raise exception 'Guidance allowance reached' using errcode='PT429'; end if;
 update account_private.guidance_wallet set reserved_microusd=reserved_microusd+reserve_amount where id='openai';
 update account_private.guidance_allowances set used_requests=used_requests+1,reserved_microusd=reserved_microusd+reserve_amount,last_requested_at=clock_timestamp() where owner_id=actor;
 insert into account_private.guidance_runs(id,owner_id,idea_id,fingerprint,model,reserve_microusd) values((command->>'runId')::uuid,actor,idea.id,command->>'fingerprint',command->>'model',reserve_amount);
 return jsonb_build_object('reserved',true);
end;
$$;
