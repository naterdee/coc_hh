create table if not exists public.person_meetings (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  title text not null default '',
  meeting_day text not null check (meeting_day in ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')),
  meeting_time time not null,
  frequency text not null default 'Weekly'
    check (frequency in ('Weekly', 'Every 2 weeks', 'Monthly')),
  start_date date not null default current_date,
  is_legacy boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists person_meetings_legacy_person_idx
  on public.person_meetings (person_id) where is_legacy;

create table if not exists public.meeting_logs (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.person_meetings(id) on delete cascade,
  occurrence_date date not null,
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists meeting_logs_occurrence_idx
  on public.meeting_logs (occurrence_date desc, created_at desc);

create table if not exists public.meeting_cancellations (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.person_meetings(id) on delete cascade,
  occurrence_date date not null,
  created_at timestamptz not null default now(),
  unique (meeting_id, occurrence_date)
);

alter table public.person_meetings enable row level security;
alter table public.meeting_logs enable row level security;
alter table public.meeting_cancellations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'person_meetings'
      and policyname = 'Authenticated users can manage person meetings'
  ) then
    create policy "Authenticated users can manage person meetings"
      on public.person_meetings for all to authenticated
      using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meeting_logs'
      and policyname = 'Authenticated users can manage meeting logs'
  ) then
    create policy "Authenticated users can manage meeting logs"
      on public.meeting_logs for all to authenticated
      using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meeting_cancellations'
      and policyname = 'Authenticated users can manage meeting cancellations'
  ) then
    create policy "Authenticated users can manage meeting cancellations"
      on public.meeting_cancellations for all to authenticated
      using (true) with check (true);
  end if;
end
$$;

insert into public.person_meetings (
  person_id, title, meeting_day, meeting_time, frequency, start_date, is_legacy
)
select
  id,
  'Recurring meeting',
  meeting_day,
  nullif(meeting_time::text, '')::time,
  case
    when frequency in ('Weekly', 'Every 2 weeks', 'Monthly') then frequency
    else 'Weekly'
  end,
  current_date,
  true
from public.people
where meeting_day in ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')
  and nullif(meeting_time::text, '') is not null
on conflict (person_id) where is_legacy do nothing;
