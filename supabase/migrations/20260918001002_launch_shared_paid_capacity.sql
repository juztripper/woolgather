-- Explicit launch mode: paid entitlements use shared provider capacity.
-- Never changes the provider wallet, its spend, reservations, or dollar cap.
alter table account_private.plan_settings
 add column shared_paid_capacity boolean not null default false;

do $$
declare definition text;
 old_guard text := 'where id and enabled and issued_microusd+amount<=funding_microusd';
begin
 definition := pg_get_functiondef('public.plan_billing_command(text,text)'::regprocedure);
 if position(old_guard in definition)=0 then raise exception 'Billing funding guard changed'; end if;
 definition := replace(definition,old_guard,
  'where id and enabled and (shared_paid_capacity or issued_microusd+amount<=funding_microusd)');
 execute definition;
end $$;
