-- A disabled Dodo rehearsal. Test entitlements can never fund OpenAI work.
create table account_private.billing_test_secrets (id boolean primary key default true check(id), secret text not null check(length(secret)>=43));
alter table account_private.billing_test_secrets enable row level security;
revoke all on account_private.billing_test_secrets from public,anon,authenticated;
create table account_private.billing_test_inbox (
 event_id text primary key check(length(event_id) between 1 and 200),
 event_type text not null, event_at timestamptz not null, body_hash text not null,
 resource_ids jsonb not null, received_at timestamptz not null default now(),
 last_received_at timestamptz not null default now(), deliveries integer not null default 1,
 status text not null default 'pending' check(status in ('pending','processed','needs_review'))
);
create table account_private.billing_test_customers (
 customer_id text primary key,
 owner_id uuid references auth.users(id) on delete set null
);
create index billing_test_customers_owner on account_private.billing_test_customers(owner_id);
create table account_private.billing_test_products (
 product_id text primary key, reviews integer not null check(reviews between 1 and 1000)
);
create table account_private.billing_test_facts (
 id text primary key, fact jsonb not null, recorded_at timestamptz not null default now()
);
create table account_private.billing_test_grants (
 subscription_id text not null, starts_at timestamptz not null, ends_at timestamptz not null,
 payment_id text unique not null, period_id text unique not null references account_private.guidance_review_periods(id) on delete cascade,
 primary key(subscription_id,starts_at)
);
create table account_private.billing_test_refunds (
 payment_id text primary key, fully_refunded boolean not null default false, needs_review boolean not null default false
);
alter table account_private.billing_test_inbox enable row level security;
alter table account_private.billing_test_customers enable row level security;
alter table account_private.billing_test_products enable row level security;
alter table account_private.billing_test_facts enable row level security;
alter table account_private.billing_test_grants enable row level security;
alter table account_private.billing_test_refunds enable row level security;
revoke all on account_private.billing_test_inbox,account_private.billing_test_customers,account_private.billing_test_products,
 account_private.billing_test_facts,account_private.billing_test_grants,account_private.billing_test_refunds from public,anon,authenticated;

-- The Worker verifies Dodo's raw-body signature first. A separate server secret
-- authenticates this sanitized inbox write; it never grants allowance.
create function public.record_billing_test_event(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare key_value text; expected bytea; supplied bytea; difference integer:=0; i integer; event jsonb;
begin
 if octet_length(payload)>8000 or signature is null or signature !~ '^[0-9a-f]{64}$' then raise exception 'Invalid billing event' using errcode='22023'; end if;
 select secret into key_value from account_private.billing_test_secrets where id;
 expected:=extensions.hmac(convert_to('woolgather.billing.test.v1:'||payload,'UTF8'),convert_to(key_value,'UTF8'),'sha256');
 if expected is null then raise exception 'Test billing unavailable' using errcode='42501'; end if;
 supplied:=decode(signature,'hex');
 for i in 0..31 loop difference:=difference | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
 if difference<>0 then raise exception 'Invalid signature' using errcode='42501'; end if;
 event:=payload::jsonb;
 if coalesce(event->>'bodyHash','') !~ '^[0-9a-f]{64}$' or jsonb_typeof(event->'resourceIds') is distinct from 'object' then raise exception 'Invalid event' using errcode='22023'; end if;
 insert into account_private.billing_test_inbox(event_id,event_type,event_at,body_hash,resource_ids)
 values(event->>'eventId',event->>'type',(event->>'eventAt')::timestamptz,event->>'bodyHash',event->'resourceIds')
 on conflict(event_id) do update set deliveries=account_private.billing_test_inbox.deliveries+1,last_received_at=clock_timestamp(),
 status=case when account_private.billing_test_inbox.body_hash=excluded.body_hash then account_private.billing_test_inbox.status else 'needs_review' end;
 return '{"received":true}'::jsonb;
end; $$;
revoke all on function public.record_billing_test_event(text,text) from public;
grant execute on function public.record_billing_test_event(text,text) to anon,authenticated;

-- Operator-only seam for facts reconciled against canonical test payment and
-- subscription records. No untrusted webhook payload or checkout redirect can
-- call this function. Final paid/trial/refund policies are not enabled here.
create function account_private.apply_billing_test_fact(value jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous jsonb; actor uuid; reviews integer; period_key text; start_at timestamptz; end_at timestamptz; grant_row account_private.billing_test_grants;
begin
 -- Rehearsal volume is small; serialize facts and their grant/refund effects.
 perform pg_catalog.pg_advisory_xact_lock(923617);
 select fact into previous from account_private.billing_test_facts where id=value->>'id';
 if previous is not null then
  if previous<>value then raise exception 'Fact conflict' using errcode='PT409'; end if;
  return '{"replayed":true}'::jsonb;
 end if;
 if value->>'kind'='paid_period' then
  if coalesce(value->>'paymentStatus','')<>'succeeded' or coalesce((value->>'paidAmountMinor')::bigint,0)<=0 then raise exception 'A verified paid period is required' using errcode='22023'; end if;
  select owner_id into actor from account_private.billing_test_customers where customer_id=value->>'customerId';
  select p.reviews into reviews from account_private.billing_test_products p where product_id=value->>'productId';
  if actor is null or reviews is null then raise exception 'Unmapped test customer or product' using errcode='22023'; end if;
  start_at:=(value->>'startsAt')::timestamptz;end_at:=(value->>'endsAt')::timestamptz;
  if start_at is null or end_at is null or end_at<=start_at then raise exception 'Invalid paid period' using errcode='22023'; end if;
  select * into grant_row from account_private.billing_test_grants where subscription_id=value->>'subscriptionId' and starts_at=start_at;
  if grant_row.subscription_id is not null then
   if grant_row.payment_id<>value->>'paymentId' or grant_row.ends_at<>end_at then raise exception 'Period conflict' using errcode='PT409'; end if;
  else
   period_key:='dodo-test:'||(value->>'subscriptionId')||':'||to_char(start_at at time zone 'UTC','YYYYMMDDHH24MISS');
   if exists(select 1 from account_private.billing_test_refunds where payment_id=value->>'paymentId' and fully_refunded) then reviews:=0; end if;
   insert into account_private.guidance_review_periods(id,owner_id,kind,starts_at,ends_at,max_reviews,environment)
    values(period_key,actor,'subscription',start_at,end_at,reviews,'test');
   insert into account_private.billing_test_grants values(value->>'subscriptionId',start_at,end_at,value->>'paymentId',period_key);
  end if;
 elsif value->>'kind'='refund' then
  if coalesce(value->>'refundStatus','')<>'succeeded' then raise exception 'A confirmed refund is required' using errcode='22023'; end if;
  insert into account_private.billing_test_refunds(payment_id,fully_refunded,needs_review)
   values(value->>'paymentId',coalesce((value->>'full')::boolean,false),not coalesce((value->>'full')::boolean,false))
   on conflict(payment_id) do update set fully_refunded=account_private.billing_test_refunds.fully_refunded or excluded.fully_refunded,
    needs_review=account_private.billing_test_refunds.needs_review or excluded.needs_review;
  if (value->>'full')::boolean then
   update account_private.guidance_review_periods set max_reviews=0 where id in
    (select period_id from account_private.billing_test_grants where payment_id=value->>'paymentId');
  end if;
 elsif value->>'kind'='no_grant' then
  -- active trials, on-hold/failed renewals and cancellation notices grant no new
  -- period and do not erase an already paid period before its end.
  null;
 else raise exception 'Unsupported test billing fact' using errcode='22023'; end if;
 insert into account_private.billing_test_facts(id,fact) values(value->>'id',value);
 return '{"applied":true}'::jsonb;
end; $$;
revoke all on function account_private.apply_billing_test_fact(jsonb) from public,anon,authenticated;
