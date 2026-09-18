create table if not exists public.telegram_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_id text not null unique,
  telegram_username text,
  telegram_first_name text,
  linked_at timestamptz not null default now()
);

alter table public.telegram_links enable row level security;

drop policy if exists "telegram_links_select_own" on public.telegram_links;
create policy "telegram_links_select_own"
on public.telegram_links
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "telegram_links_delete_own" on public.telegram_links;
create policy "telegram_links_delete_own"
on public.telegram_links
for delete
to authenticated
using (auth.uid() = user_id);

create table if not exists public.telegram_link_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.telegram_link_codes enable row level security;

drop policy if exists "telegram_link_codes_select_own" on public.telegram_link_codes;
create policy "telegram_link_codes_select_own"
on public.telegram_link_codes
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "telegram_link_codes_insert_own" on public.telegram_link_codes;
create policy "telegram_link_codes_insert_own"
on public.telegram_link_codes
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "telegram_link_codes_update_own" on public.telegram_link_codes;
create policy "telegram_link_codes_update_own"
on public.telegram_link_codes
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "telegram_link_codes_delete_own" on public.telegram_link_codes;
create policy "telegram_link_codes_delete_own"
on public.telegram_link_codes
for delete
to authenticated
using (auth.uid() = user_id);

create index if not exists telegram_links_chat_id_idx on public.telegram_links(chat_id);
create index if not exists telegram_link_codes_expires_at_idx on public.telegram_link_codes(expires_at);
