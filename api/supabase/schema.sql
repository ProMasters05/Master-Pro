-- Pro Masters Studio: accounts and server-side free export counts.
-- Run once in Supabase: Dashboard > SQL Editor > New query > Run.
-- Safe to re-run. Keep the free allowance (2) in step with CONFIG.FREE_CREDITS in index.html.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  free_exports_used integer not null default 0 check (free_exports_used >= 0),
  bonus_granted boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile" on public.profiles
  for select to authenticated using (auth.uid() = id);
-- No insert, update or delete policies: browsers cannot edit their own counters.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts created before this script ran
insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;

create or replace function public.free_exports_left()
returns json language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); p public.profiles; allowance integer;
begin
  if uid is null then return json_build_object('ok', false, 'remaining', 0, 'reason', 'signed_out'); end if;
  insert into public.profiles (id) values (uid) on conflict (id) do nothing;
  select * into p from public.profiles where id = uid;
  allowance := 2 + case when p.bonus_granted then 1 else 0 end;
  return json_build_object('ok', true, 'remaining', greatest(allowance - p.free_exports_used, 0));
end $$;

create or replace function public.consume_free_export()
returns json language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); p public.profiles; allowance integer; remaining integer;
begin
  if uid is null then return json_build_object('ok', false, 'remaining', 0, 'reason', 'signed_out'); end if;
  insert into public.profiles (id) values (uid) on conflict (id) do nothing;
  select * into p from public.profiles where id = uid for update;
  allowance := 2 + case when p.bonus_granted then 1 else 0 end;
  remaining := greatest(allowance - p.free_exports_used, 0);
  if remaining <= 0 then
    return json_build_object('ok', false, 'remaining', 0, 'reason', 'no_free_exports');
  end if;
  update public.profiles set free_exports_used = free_exports_used + 1 where id = uid;
  return json_build_object('ok', true, 'remaining', remaining - 1);
end $$;

create or replace function public.claim_signup_bonus(p_email text)
returns json language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); me text; p public.profiles; allowance integer;
begin
  if uid is null then return json_build_object('ok', false, 'granted', false, 'reason', 'signed_out'); end if;
  select email into me from auth.users where id = uid;
  insert into public.profiles (id) values (uid) on conflict (id) do nothing;
  select * into p from public.profiles where id = uid for update;
  allowance := 2 + case when p.bonus_granted then 1 else 0 end;
  if p.bonus_granted then
    return json_build_object('ok', true, 'granted', false, 'reason', 'already_claimed', 'remaining', greatest(allowance - p.free_exports_used, 0));
  end if;
  if lower(coalesce(me, '')) <> lower(coalesce(p_email, '')) then
    return json_build_object('ok', false, 'granted', false, 'reason', 'email_mismatch', 'remaining', greatest(allowance - p.free_exports_used, 0));
  end if;
  update public.profiles set bonus_granted = true where id = uid;
  return json_build_object('ok', true, 'granted', true, 'remaining', greatest(allowance + 1 - p.free_exports_used, 0));
end $$;

revoke all on function public.free_exports_left() from public, anon;
revoke all on function public.consume_free_export() from public, anon;
revoke all on function public.claim_signup_bonus(text) from public, anon;
grant execute on function public.free_exports_left() to authenticated;
grant execute on function public.consume_free_export() to authenticated;
grant execute on function public.claim_signup_bonus(text) to authenticated;
