-- Row Level Security for the core tables.
--
-- The app talks to Supabase with the public (publishable) key, so RLS is the ONLY
-- thing that stops one user from reading another user's pay data.
-- The migrations in this repo only covered the Telegram tables; run this once to make
-- sure the tables below are locked down as well. It is idempotent.
--
-- BEFORE RUNNING: open Supabase -> Authentication -> Policies. If these tables already
-- show RLS enabled with "user_id = auth.uid()" policies, you can skip this file.
-- The Edge Functions and the reminder cron use the service role, which bypasses RLS.

alter table public.kv_store enable row level security;
drop policy if exists "kv_store_own_rows" on public.kv_store;
create policy "kv_store_own_rows" on public.kv_store
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists "push_subscriptions_own_rows" on public.push_subscriptions;
create policy "push_subscriptions_own_rows" on public.push_subscriptions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.break_reminders enable row level security;
drop policy if exists "break_reminders_own_rows" on public.break_reminders;
create policy "break_reminders_own_rows" on public.break_reminders
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
