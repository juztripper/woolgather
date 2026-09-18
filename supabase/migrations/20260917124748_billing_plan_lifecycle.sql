-- DEC-145: disabled, environment-isolated payment reconciliation.
create table account_private.plan_billing_config (
 environment text primary key check(environment in ('test','live')), enabled boolean not null default false,
 secret text check(length(secret)>=43), account_id text, product_id text, price_id text,
 price_minor integer not null default 2400 check(price_minor=2400), currency text not null default 'eur' check(currency='eur')
);
insert into account_private.plan_billing_config(environment) values('test'),('live');
create table account_private.plan_billing_customers (
 environment text references account_private.plan_billing_config(environment), owner_id uuid references auth.users(id) on delete set null,
 customer_id text, setup_id uuid not null, created_at timestamptz not null default clock_timestamp(), checkout_nonce uuid, checkout_started_at timestamptz, checkout_id text, checkout_url text, checkout_pending boolean not null default false,
 subscription_id text, primary key(environment,setup_id), unique(environment,owner_id), unique(environment,customer_id)
);
create table account_private.plan_billing_inbox (
 environment text references account_private.plan_billing_config(environment), event_id text,
 event_type text not null, event_at timestamptz not null, body_hash text not null, resource_ids jsonb not null,
 status text not null default 'pending' check(status in ('pending','processed','needs_review')), reason text,
 deliveries integer not null default 1, attempts integer not null default 0, next_attempt_at timestamptz not null default clock_timestamp(),
 received_at timestamptz not null default clock_timestamp(), primary key(environment,event_id)
);
-- Immutable invoice -> subscription line period, reconciled from Stripe.
-- Current subscription dates and browser metadata are not payment authority.
create table account_private.plan_billing_periods (
 environment text references account_private.plan_billing_config(environment), payment_id text,
 customer_id text not null, product_id text not null, subscription_id text not null,
 starts_at timestamptz not null, ends_at timestamptz not null check(ends_at>starts_at), evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 primary key(environment,payment_id), unique(environment,subscription_id,starts_at)
);
create table account_private.plan_billing_refunds (
 environment text references account_private.plan_billing_config(environment), payment_id text,
 fully_refunded boolean not null default false, needs_review boolean not null default false, primary key(environment,payment_id)
);
do $$ declare t text; begin
 foreach t in array array['plan_billing_config','plan_billing_customers','plan_billing_inbox','plan_billing_periods','plan_billing_refunds'] loop
  execute format('alter table account_private.%I enable row level security',t);
  execute format('revoke all on account_private.%I from public,anon,authenticated',t);
 end loop;
end $$;

create function public.plan_billing_command(payload text,signature text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c jsonb; cfg account_private.plan_billing_config; expected bytea; supplied bytea; difference integer:=0; i integer;
 actor uuid; customer account_private.plan_billing_customers; proof account_private.plan_billing_periods;
 g account_private.plan_grants; event account_private.plan_billing_inbox; gid text; is_revoked boolean; result jsonb; amount bigint:=6077500;
begin
 if octet_length(payload)>12000 or signature is null or signature !~ '^[0-9a-f]{64}$' then raise exception 'Invalid billing command' using errcode='22023'; end if;
 c:=payload::jsonb;
 select * into cfg from account_private.plan_billing_config where environment=c->>'environment';
 if not coalesce(cfg.enabled,false) or cfg.secret is null or cfg.account_id is null or cfg.product_id is null or cfg.price_id is null then raise exception 'Billing unavailable' using errcode='42501'; end if;
 expected:=extensions.hmac(convert_to('woolgather.billing.plan.v1:'||payload,'UTF8'),convert_to(cfg.secret,'UTF8'),'sha256'); supplied:=decode(signature,'hex');
 for i in 0..31 loop difference:=difference | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
 if difference<>0 then raise exception 'Invalid signature' using errcode='42501'; end if;
 if c->>'accountId' is distinct from cfg.account_id then raise exception 'Billing account mismatch' using errcode='42501'; end if;
 -- Same wallet-first ordering as planning, voice, and grant expiry.
 perform 1 from account_private.guidance_wallet where id='openai' for update;
 perform pg_advisory_xact_lock(hashtextextended('billing:'||cfg.environment,0));
 if c->>'action' in ('account','customer_saved','checkout_claim','checkout_saved','checkout_expired') then
  actor:=auth.uid();
  if actor is null or actor::text is distinct from c->>'ownerId' or account_private.access_status()<>'ok' then raise exception 'Sign in required' using errcode='42501'; end if;
  select * into customer from account_private.plan_billing_customers where environment=cfg.environment and owner_id=actor for update;
  if c->>'action'='account' then
   if customer.setup_id is null then
    insert into account_private.plan_billing_customers(environment,owner_id,setup_id) values(cfg.environment,actor,(c->>'setupId')::uuid) returning * into customer;
    result:=jsonb_build_object('createCustomer',true);
   end if;
  elsif c->>'action'='customer_saved' then
   if customer.setup_id is distinct from (c->>'setupId')::uuid or (customer.customer_id is not null and customer.customer_id is distinct from c->>'customerId') then raise exception 'Customer conflict' using errcode='PT409'; end if;
   update account_private.plan_billing_customers set customer_id=c->>'customerId' where environment=cfg.environment and owner_id=actor returning * into customer;
  elsif c->>'action'='checkout_expired' then
   if customer.checkout_id is distinct from c->>'checkoutId' then raise exception 'Checkout conflict' using errcode='PT409'; end if;
   update account_private.plan_billing_customers set checkout_id=null,checkout_url=null,checkout_pending=false,checkout_nonce=null,checkout_started_at=null where environment=cfg.environment and owner_id=actor;
   return '{}'::jsonb;
  elsif c->>'action'='checkout_claim' then
   if customer.customer_id is null or customer.checkout_id is not null or (customer.checkout_pending and customer.checkout_started_at<clock_timestamp()-interval '20 hours') then return jsonb_build_object('claimed',false); end if;
   update account_private.plan_billing_customers set checkout_pending=true,checkout_nonce=coalesce(checkout_nonce,(c->>'setupId')::uuid),checkout_started_at=coalesce(checkout_started_at,clock_timestamp()) where environment=cfg.environment and owner_id=actor returning * into customer;
   return jsonb_build_object('claimed',true,'nonce',customer.checkout_nonce);
  else
   if not customer.checkout_pending or customer.customer_id is null or (customer.checkout_id is not null and customer.checkout_id is distinct from c->>'checkoutId') then raise exception 'Checkout conflict' using errcode='PT409'; end if;
   update account_private.plan_billing_customers set checkout_id=c->>'checkoutId',checkout_url=c->>'url' where environment=cfg.environment and owner_id=actor returning * into customer;
  end if;
  return coalesce(result,'{}')||jsonb_build_object('customerId',customer.customer_id,'setupId',customer.setup_id,'checkoutUrl',customer.checkout_url,'subscriptionId',customer.subscription_id,'checkoutId',customer.checkout_id,'productId',cfg.product_id,'priceId',cfg.price_id,'createCustomer',customer.customer_id is null and customer.created_at>clock_timestamp()-interval '20 hours');
 elsif c->>'action'='record' then
  if coalesce(c->>'bodyHash','') !~ '^[0-9a-f]{64}$' or jsonb_typeof(c->'resourceIds') is distinct from 'object' then raise exception 'Invalid event' using errcode='22023'; end if;
  insert into account_private.plan_billing_inbox(environment,event_id,event_type,event_at,body_hash,resource_ids) values(cfg.environment,c->>'eventId',c->>'type',(c->>'eventAt')::timestamptz,c->>'bodyHash',c->'resourceIds')
  on conflict(environment,event_id) do update set deliveries=account_private.plan_billing_inbox.deliveries+1,
   status=case when account_private.plan_billing_inbox.body_hash=excluded.body_hash then account_private.plan_billing_inbox.status else 'needs_review' end,
   reason=case when account_private.plan_billing_inbox.body_hash=excluded.body_hash then account_private.plan_billing_inbox.reason else 'changed_event' end;
  return '{"received":true}';
 elsif c->>'action'='claim' then
  select * into event from account_private.plan_billing_inbox where environment=cfg.environment and status='pending' and next_attempt_at<=clock_timestamp() order by received_at,event_id limit 1 for update skip locked;
  if event.event_id is null then return '{}'::jsonb; end if;
  update account_private.plan_billing_inbox set attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '5 minutes' where environment=cfg.environment and event_id=event.event_id;
  return jsonb_build_object('eventId',event.event_id,'type',event.event_type,'resourceIds',event.resource_ids);
 elsif c->>'action'='period' then
  select * into proof from account_private.plan_billing_periods where environment=cfg.environment and payment_id=c->>'paymentId';
  return case when proof.payment_id is null then '{}'::jsonb else jsonb_build_object('customerId',proof.customer_id,'productId',proof.product_id,'subscriptionId',proof.subscription_id,'startsAt',proof.starts_at,'endsAt',proof.ends_at) end;
 elsif c->>'action'='finish' then
  select * into event from account_private.plan_billing_inbox where environment=cfg.environment and event_id=c->>'eventId' for update;
  if event.event_id is null or event.status<>'pending' then return '{"replayed":true}'; end if;
  if c->>'outcome'='paid' then
   insert into account_private.plan_billing_periods(environment,payment_id,customer_id,product_id,subscription_id,starts_at,ends_at,evidence_sha256)
    values(cfg.environment,c->>'paymentId',c->>'customerId',c->>'productId',c->>'subscriptionId',(c->>'startsAt')::timestamptz,(c->>'endsAt')::timestamptz,c->>'evidenceHash') on conflict(environment,payment_id) do nothing;
   select * into proof from account_private.plan_billing_periods where environment=cfg.environment and payment_id=c->>'paymentId';
   if proof.starts_at is distinct from (c->>'startsAt')::timestamptz or proof.ends_at is distinct from (c->>'endsAt')::timestamptz or proof.product_id is distinct from c->>'productId' then raise exception 'Invoice conflict' using errcode='PT409'; end if;
   select * into customer from account_private.plan_billing_customers where environment=cfg.environment and customer_id=c->>'customerId'; actor:=customer.owner_id;
   if proof.payment_id is null or actor is null or proof.customer_id is distinct from c->>'customerId' or proof.product_id is distinct from cfg.product_id or proof.subscription_id is distinct from c->>'subscriptionId'
    or c->>'paymentStatus' is distinct from 'succeeded' or c->>'currency' is distinct from cfg.currency or (c->>'paidAmountMinor')::integer is distinct from cfg.price_minor then raise exception 'Verified paid period required' using errcode='22023'; end if;
   select * into g from account_private.plan_grants where environment=cfg.environment and payment_id=proof.payment_id;
   if g.id is null then
    is_revoked:=coalesce((select fully_refunded from account_private.plan_billing_refunds where environment=cfg.environment and payment_id=proof.payment_id),false);
    if cfg.environment='live' and not is_revoked then
     if not exists(select 1 from account_private.plan_settings where id and enabled and issued_microusd+amount<=funding_microusd) then raise exception 'Paid provider capacity requires funding' using errcode='PT429'; end if;
     update account_private.plan_settings set issued_microusd=issued_microusd+amount where id;
     insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(actor,1000000,amount) on conflict(owner_id) do update set budget_microusd=account_private.guidance_allowances.budget_microusd+amount,max_requests=greatest(account_private.guidance_allowances.max_requests,1000000);
    end if;
    gid:='stripe:'||cfg.environment||':'||proof.payment_id;
    insert into account_private.plan_grants(id,owner_id,environment,kind,starts_at,ends_at,credits,voice_seconds,payment_id,subscription_id,revoked)
    values(gid,actor,cfg.environment,'paid',proof.starts_at,proof.ends_at,1500,1200,proof.payment_id,proof.subscription_id,is_revoked);
   elsif g.starts_at<>proof.starts_at or g.ends_at<>proof.ends_at or g.subscription_id<>proof.subscription_id then raise exception 'Paid period conflict' using errcode='PT409'; end if;
   update account_private.plan_billing_customers set subscription_id=proof.subscription_id where environment=cfg.environment and owner_id=actor;
  elsif c->>'outcome'='subscription' then
   update account_private.plan_billing_customers set subscription_id=c->>'subscriptionId' where environment=cfg.environment and customer_id=c->>'customerId';
  elsif c->>'outcome'='refund' then
   insert into account_private.plan_billing_refunds(environment,payment_id,fully_refunded,needs_review) values(cfg.environment,c->>'paymentId',(c->>'full')::boolean,not (c->>'full')::boolean)
   on conflict(environment,payment_id) do update set fully_refunded=account_private.plan_billing_refunds.fully_refunded or excluded.fully_refunded,needs_review=account_private.plan_billing_refunds.needs_review or excluded.needs_review;
   if (c->>'full')::boolean then update account_private.plan_grants set revoked=true where environment=cfg.environment and payment_id=c->>'paymentId'; end if;
   select owner_id into actor from account_private.plan_grants where environment=cfg.environment and payment_id=c->>'paymentId';
  elsif c->>'outcome' not in ('ignored','review','retry') then raise exception 'Unsupported billing outcome' using errcode='22023'; end if;
  if cfg.environment='live' and actor is not null then
   update account_private.guidance_allowances set paid_voice_until=(select max(ends_at) from account_private.plan_grants where owner_id=actor and environment='live' and kind='paid' and not revoked and starts_at<=clock_timestamp() and ends_at>clock_timestamp()) where owner_id=actor;
  end if;
  update account_private.plan_billing_inbox set status=case when c->>'outcome'='retry' then 'pending' when c->>'outcome'='review' or (c->>'outcome'='refund' and not (c->>'full')::boolean) then 'needs_review' else 'processed' end,
   reason=left(c->>'reason',100),next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))::integer) where environment=cfg.environment and event_id=event.event_id;
  return '{"applied":true}';
 else raise exception 'Unknown billing command' using errcode='22023'; end if;
end $$;
revoke all on function public.plan_billing_command(text,text) from public;
grant execute on function public.plan_billing_command(text,text) to anon,authenticated;
