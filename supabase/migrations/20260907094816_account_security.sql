-- Only these narrowly scoped helpers can inspect Auth's private tables.
-- The application still uses caller JWTs and never receives service credentials.
create schema if not exists account_private;
revoke all on schema account_private from public, anon;
grant usage on schema account_private to authenticated;

create function account_private.access_status() returns text
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); claims jsonb := auth.jwt();
begin
 if actor is null or coalesce((claims->>'is_anonymous')::boolean,false) then return 'signed_out'; end if;
 if not exists(select 1 from auth.sessions s where s.user_id=actor and s.id::text=claims->>'session_id' and (s.not_after is null or s.not_after>now())) then return 'signed_out'; end if;
 if coalesce(claims->>'aal','aal1') <> 'aal2' and exists(select 1 from auth.mfa_factors f where f.user_id=actor and f.status='verified') then return 'mfa_required'; end if;
 return 'ok';
end;
$$;
revoke all on function account_private.access_status() from public, anon;
grant execute on function account_private.access_status() to authenticated;

create function public.account_access() returns text
language sql stable security invoker set search_path='' as $$ select account_private.access_status(); $$;
revoke all on function public.account_access() from public, anon;
grant execute on function public.account_access() to authenticated;

create function account_private.overview() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result jsonb;
begin
 if account_private.access_status()<>'ok' then raise exception 'Account verification required' using errcode='42501'; end if;
 select jsonb_build_object(
  'hasPassword',coalesce(length(u.encrypted_password)>0,false),
  'sessions',coalesce((select jsonb_agg(jsonb_build_object(
   'id',s.id,'createdAt',s.created_at,'lastActiveAt',coalesce(s.refreshed_at at time zone 'UTC',s.updated_at,s.created_at),
   'userAgent',left(coalesce(s.user_agent,''),512), 'current',s.id::text=auth.jwt()->>'session_id'
  ) order by (s.id::text=auth.jwt()->>'session_id') desc,s.created_at desc)
  from auth.sessions s where s.user_id=actor and (s.not_after is null or s.not_after>now())), '[]'::jsonb)
 ) into result from auth.users u where u.id=actor;
 return result;
end;
$$;
revoke all on function account_private.overview() from public, anon;
grant execute on function account_private.overview() to authenticated;
create function public.account_overview() returns jsonb
language sql stable security invoker set search_path='' as $$ select account_private.overview(); $$;
revoke all on function public.account_overview() from public, anon;
grant execute on function public.account_overview() to authenticated;

-- Session deletion cascades to its refresh tokens in Supabase Auth. RLS below
-- also refuses still-unexpired access tokens on the next planning request.
create function account_private.revoke_session(target uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if account_private.access_status()<>'ok' then raise exception 'Account verification required' using errcode='42501'; end if;
 if target::text=auth.jwt()->>'session_id' then raise exception 'Use sign out for this session' using errcode='22023'; end if;
 delete from auth.sessions where id=target and user_id=auth.uid();
 if not found then raise exception 'Session not found' using errcode='P0002'; end if;
end;
$$;
revoke all on function account_private.revoke_session(uuid) from public, anon;
grant execute on function account_private.revoke_session(uuid) to authenticated;
create function public.revoke_account_session(session_id uuid) returns void
language sql security invoker set search_path='' as $$ select account_private.revoke_session(session_id); $$;
revoke all on function public.revoke_account_session(uuid) from public, anon;
grant execute on function public.revoke_account_session(uuid) to authenticated;

create policy live_session_and_mfa on planning.projects as restrictive to authenticated using ((select account_private.access_status())='ok') with check ((select account_private.access_status())='ok');
create policy live_session_and_mfa on planning.items as restrictive to authenticated using ((select account_private.access_status())='ok') with check ((select account_private.access_status())='ok');
create policy live_session_and_mfa on planning.commands as restrictive to authenticated using ((select account_private.access_status())='ok') with check ((select account_private.access_status())='ok');
create policy live_session_and_mfa on planning.history as restrictive to authenticated using ((select account_private.access_status())='ok') with check ((select account_private.access_status())='ok');
