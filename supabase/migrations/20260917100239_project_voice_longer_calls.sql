-- Longer calls preserve historical receipts and reserve their entire bounded
-- cost before connecting. Testing bypasses product access/counts, never money.
alter table account_private.guidance_allowances
 add column paid_voice_until timestamptz;
comment on column account_private.guidance_allowances.paid_voice_until is
 'Operator-only expiry of verified paid voice access. Billing activation must populate this from authoritative paid periods; test billing grants never qualify. Testing uses testing_request_exempt instead.';

alter table account_private.project_voice_sessions
 drop constraint project_voice_sessions_max_duration_seconds_check,
 drop constraint project_voice_sessions_reserve_microusd_check,
 add constraint project_voice_sessions_max_duration_seconds_check check(max_duration_seconds in (60,600)),
 add constraint project_voice_sessions_reserve_microusd_check check(reserve_microusd=(max_duration_seconds+15)*50000/60);

do $$
declare definition text;
begin
 definition:=pg_get_functiondef('public.project_voice_start(text,text)'::regprocedure);
 if position('(c->>''maxDurationSeconds'')::integer<>60' in definition)=0
  or position('interval ''60 seconds''' in definition)=0
  or position('not allowance.testing_request_exempt' in definition)=0 then
  raise exception 'Expected voice admission contract missing';
 end if;
 definition:=replace(definition,'(c->>''maxDurationSeconds'')::integer<>60',
  'coalesce((c->>''maxDurationSeconds'')::integer,0) not in (60,600)');
 definition:=replace(definition,'(c->>''reserveMicrousd'')::bigint<>62500',
  'coalesce((c->>''reserveMicrousd'')::bigint,0)<>((c->>''maxDurationSeconds'')::integer+15)*50000/60');
 definition:=replace(definition,'amount:=(c->>''reserveMicrousd'')::bigint;',
  'if not allowance.testing_request_exempt and (allowance.paid_voice_until is null or allowance.paid_voice_until<=clock_timestamp()) then raise exception ''Voice requires a paid plan'' using errcode=''PT403''; end if; amount:=(c->>''reserveMicrousd'')::bigint;');
 definition:=replace(definition,'interval ''60 seconds''','make_interval(secs => (c->>''maxDurationSeconds'')::integer)');
 definition:=replace(definition,'''gpt-live-1'',60,amount','''gpt-live-1'',(c->>''maxDurationSeconds'')::integer,amount');
 execute definition;
 definition:=pg_get_functiondef('public.settle_project_voice(text,text)'::regprocedure);
 if position('seconds>75' in definition)=0 then raise exception 'Expected voice settlement bound missing'; end if;
 execute replace(definition,'seconds>75','seconds>run.max_duration_seconds+15');
end $$;
