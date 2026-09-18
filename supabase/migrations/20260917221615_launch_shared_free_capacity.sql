-- Public enrollment can use shared provider capacity without pre-funding every
-- Free grant. Disabled by default; no funds, flags or ledger values are changed.
-- NULL free_accounts_max explicitly means no enrollment count cap.
alter table account_private.plan_settings
 add column shared_free_capacity boolean not null default false,
 alter column free_accounts_max drop not null;

-- Idea guidance was retired in DEC-131. Its development-period trigger cannot
-- accept commercial request ceilings and blocks genuinely new customers.
-- Preserve legacy development compatibility without creating retired review
-- entitlements for commercial allowances, whose ceiling exceeds that contract.
create or replace function account_private.new_guidance_review_period() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.max_requests<=100000 then
  insert into account_private.guidance_review_periods(id,owner_id,kind,max_reviews)
  values('development:'||new.owner_id,new.owner_id,'development',new.max_requests);
 end if;
 return new;
end; $$;
revoke all on function account_private.new_guidance_review_period() from public,anon,authenticated;

create or replace function account_private.issue_plan_grant(gid text, actor uuid, kind_value text, start_at timestamptz, end_at timestamptz, units integer) returns void
language plpgsql security definer set search_path='' as $$
declare amount bigint:=units::bigint*3300; cfg account_private.plan_settings;
begin
 if exists(select 1 from account_private.plan_grants where id=gid) then return; end if;
 select * into cfg from account_private.plan_settings where id for update;
 if not cfg.enabled or (not cfg.shared_free_capacity and cfg.issued_microusd+amount>cfg.funding_microusd) then raise exception 'Free assistance is awaiting funded capacity. Your writing remains available.' using errcode='PT429'; end if;
 insert into account_private.plan_grants(id,owner_id,environment,kind,starts_at,ends_at,credits) values(gid,actor,'live',kind_value,start_at,end_at,units);
 if not cfg.shared_free_capacity then
  update account_private.plan_settings set issued_microusd=issued_microusd+amount where id;
 end if;
 -- Customer allowances are eligibility, not deposits into the provider wallet.
 -- Every paid call still reserves real money against that unchanged wallet.
 insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(actor,1000000,amount)
 on conflict(owner_id) do update set budget_microusd=account_private.guidance_allowances.budget_microusd+amount,max_requests=greatest(account_private.guidance_allowances.max_requests,1000000);
end $$;
revoke all on function account_private.issue_plan_grant(text,uuid,text,timestamptz,timestamptz,integer) from public,anon,authenticated;
create or replace function account_private.refresh_plan(actor uuid) returns void
language plpgsql security definer set search_path='' as $$
declare anchor timestamptz; start_at timestamptz; end_at timestamptz; cfg account_private.plan_settings;
begin
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 perform pg_advisory_xact_lock(hashtextextended('plan:'||actor::text,0));
 select * into cfg from account_private.plan_settings where id for update;
 if not cfg.enabled or exists(select 1 from account_private.guidance_allowances where owner_id=actor and testing_request_exempt) then return; end if;
 select anchor_at into anchor from account_private.plan_accounts where owner_id=actor;
 if anchor is null then
  if (select count(*) from account_private.plan_accounts)>=cfg.free_accounts_max then return; end if;
  -- Pre-funded mode retains its existing admission policy. Shared mode admits
  -- users independently of current cash; provider admission still fails closed.
  if not cfg.shared_free_capacity and cfg.issued_microusd+990000>cfg.funding_microusd then return; end if;
  insert into account_private.plan_accounts(owner_id) values(actor) returning anchor_at into anchor;
  perform account_private.issue_plan_grant('welcome:'||actor,actor,'welcome',anchor,null,200);
 end if;
 start_at:=account_private.plan_month(anchor,clock_timestamp());
 end_at:=account_private.plan_month(anchor,start_at+interval '35 days');
 -- Paid periods suppress the free period they intersect. Downgrade waits for
 -- the next anniversary; replaying upgrade/refund cannot mint a second grant.
 if exists(select 1 from account_private.plan_grants where owner_id=actor and environment='live' and kind='paid' and starts_at<end_at and ends_at>start_at) then return; end if;
 if cfg.shared_free_capacity or cfg.issued_microusd+330000<=cfg.funding_microusd then
  perform account_private.issue_plan_grant('free:'||actor||':'||to_char(start_at at time zone 'UTC','YYYYMMDDHH24MISSUS'),actor,'free',start_at,end_at,100);
 end if;
end $$;
revoke all on function account_private.refresh_plan(uuid) from public,anon,authenticated;
