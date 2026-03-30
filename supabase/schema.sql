-- Sports Fatigue Bot — Supabase Schema
-- Run this in your Supabase SQL editor (https://app.supabase.com → SQL Editor)

create table if not exists fatigue_reports (
  id          uuid primary key default gen_random_uuid(),
  player_id   text not null,
  player_name text not null,
  acwr        numeric(5,3) not null,
  sprint_efficiency      numeric(6,3) not null,
  sprint_efficiency_drop numeric(5,3) not null,
  ucl_penalty boolean not null default false,
  risk_zone   text not null check (risk_zone in ('RED','AMBER','GREEN')),
  alert_message text not null,
  confidence  numeric(4,3) not null,
  created_at  timestamptz not null default now()
);

create table if not exists payments (
  id                    uuid primary key default gen_random_uuid(),
  telegram_user_id      bigint not null,
  stars_amount          integer not null,
  feature               text not null,
  telegram_charge_id    text not null unique,
  created_at            timestamptz not null default now()
);

-- Indexes for common queries
create index if not exists idx_reports_player_id on fatigue_reports(player_id);
create index if not exists idx_reports_risk_zone on fatigue_reports(risk_zone);
create index if not exists idx_payments_user_feature on payments(telegram_user_id, feature);

-- ─── Players ──────────────────────────────────────────────────────────────────

create table if not exists players (
  id               uuid primary key default gen_random_uuid(),
  external_id      text not null unique,           -- e.g. FBref / Opta player ID
  name             text not null,
  position         text not null check (position in ('GK','DEF','MID','FWD')),
  team             text not null,
  league           text not null default 'EPL',    -- EPL | UCL | UEL
  baseline_sprint  numeric(6,3) not null default 0, -- km sprint per 90 min
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ─── Match Stats ──────────────────────────────────────────────────────────────

create table if not exists match_stats (
  id                  uuid primary key default gen_random_uuid(),
  player_id           uuid not null references players(id) on delete cascade,
  match_date          date not null,
  minutes_played      integer not null default 0,
  total_distance      numeric(5,2) not null default 0,   -- km
  sprint_distance     numeric(5,3) not null default 0,   -- km (>25 km/h)
  high_intensity_runs integer not null default 0,        -- runs >21 km/h
  is_european_away    boolean not null default false,
  is_midweek          boolean not null default false,
  opponent            text,
  created_at          timestamptz not null default now()
);

-- ─── Alerts ───────────────────────────────────────────────────────────────────

create table if not exists alerts (
  id              uuid primary key default gen_random_uuid(),
  player_id       uuid not null references players(id) on delete cascade,
  risk_zone       text not null check (risk_zone in ('RED','AMBER','GREEN')),
  acwr            numeric(5,3) not null,
  sprint_drop     numeric(5,3) not null,
  ucl_penalty     boolean not null default false,
  message         text not null,
  confidence      numeric(4,3) not null,
  acknowledged    boolean not null default false,
  created_at      timestamptz not null default now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

create index if not exists idx_reports_player_id   on fatigue_reports(player_id);
create index if not exists idx_reports_risk_zone   on fatigue_reports(risk_zone);
create index if not exists idx_payments_user_feat  on payments(telegram_user_id, feature);
create index if not exists idx_match_stats_player  on match_stats(player_id, match_date);
create index if not exists idx_alerts_player       on alerts(player_id, created_at);
create index if not exists idx_alerts_zone         on alerts(risk_zone) where acknowledged = false;

-- ─── Subscriptions ───────────────────────────────────────────────────────────
-- Created instantly on successful_payment. Drives all paywall checks.
--
-- Plans:
--   single_report  — 50 Stars  — one-time use (used_at set on first delivery)
--   matchday_pass  — 150 Stars — expires 24 h after purchase
--   medical_pro    — 1500 Stars — expires 30 days after purchase

create table if not exists subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  telegram_user_id    bigint not null,
  plan                text not null check (plan in ('single_report','matchday_pass','medical_pro')),
  stars_paid          integer not null,
  telegram_charge_id  text not null unique,
  expires_at          timestamptz,           -- null = single-use (check used_at instead)
  used_at             timestamptz,           -- set when single_report is consumed
  created_at          timestamptz not null default now()
);

create index if not exists idx_subs_user        on subscriptions(telegram_user_id);
create index if not exists idx_subs_active      on subscriptions(telegram_user_id, expires_at)
  where used_at is null;

-- ─── Telegram Subscribers ────────────────────────────────────────────────────
-- Populated automatically when a user sends /start to the bot.
-- Used by the watchdog to broadcast alerts.

create table if not exists telegram_subscribers (
  id                uuid primary key default gen_random_uuid(),
  telegram_user_id  bigint not null unique,
  chat_id           bigint not null,
  username          text,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

create index if not exists idx_subscribers_active on telegram_subscribers(is_active) where is_active = true;

-- ─── Row Level Security (enable after testing) ────────────────────────────────
-- alter table fatigue_reports enable row level security;
-- alter table payments         enable row level security;
-- alter table players          enable row level security;
-- alter table match_stats      enable row level security;
-- alter table alerts           enable row level security;
