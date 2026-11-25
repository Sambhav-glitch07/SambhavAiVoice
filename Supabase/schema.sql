create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.memories enable row level security;

drop policy if exists own_c on public.conversations;
drop policy if exists own_m on public.messages;
drop policy if exists own_mem on public.memories;

drop policy if exists conversations_select on public.conversations;
drop policy if exists conversations_insert on public.conversations;
drop policy if exists conversations_update on public.conversations;
drop policy if exists conversations_delete on public.conversations;
create policy conversations_select on public.conversations for select using (user_id = auth.uid());
create policy conversations_insert on public.conversations for insert with check (user_id = auth.uid());
create policy conversations_update on public.conversations for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy conversations_delete on public.conversations for delete using (user_id = auth.uid());

drop policy if exists messages_select on public.messages;
drop policy if exists messages_insert on public.messages;
drop policy if exists messages_update on public.messages;
drop policy if exists messages_delete on public.messages;
create policy messages_select on public.messages for select using (user_id = auth.uid());
create policy messages_insert on public.messages for insert with check (
  user_id = auth.uid()
  and exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.user_id = auth.uid())
);
create policy messages_update on public.messages for update using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.user_id = auth.uid())
);
create policy messages_delete on public.messages for delete using (user_id = auth.uid());

drop policy if exists memories_select on public.memories;
drop policy if exists memories_insert on public.memories;
drop policy if exists memories_update on public.memories;
drop policy if exists memories_delete on public.memories;
create policy memories_select on public.memories for select using (user_id = auth.uid());
create policy memories_insert on public.memories for insert with check (user_id = auth.uid());
create policy memories_update on public.memories for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy memories_delete on public.memories for delete using (user_id = auth.uid());

create index if not exists messages_user_created_idx on public.messages(user_id, created_at desc);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index if not exists memories_user_created_idx on public.memories(user_id, created_at desc);
