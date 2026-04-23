-- Drop existing tables (safe reset)
drop table if exists positions cascade;
drop table if exists trade_ideas cascade;

-- Create tables
create table trade_ideas (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default now(),
  date date not null,
  session text,
  bias_h1 text,
  bias_m5 text,
  key_levels text,
  sl_level decimal,
  tp_target decimal,
  result text,
  total_pnl decimal,
  memo text,
  post_trade_notes text,
  screenshots text[]
);

create table positions (
  id uuid default gen_random_uuid() primary key,
  trade_idea_id uuid references trade_ideas(id) on delete cascade,
  entry_price decimal,
  lot_size decimal,
  created_at timestamp with time zone default now()
);

-- Storage bucket (skip if already exists)
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do nothing;

-- Storage policies
drop policy if exists "Public read" on storage.objects;
drop policy if exists "Anyone upload" on storage.objects;
create policy "Public read" on storage.objects for select using (bucket_id = 'screenshots');
create policy "Anyone upload" on storage.objects for insert with check (bucket_id = 'screenshots');

-- RLS
alter table trade_ideas enable row level security;
alter table positions enable row level security;
create policy "Open access trade_ideas" on trade_ideas for all using (true) with check (true);
create policy "Open access positions" on positions for all using (true) with check (true);
