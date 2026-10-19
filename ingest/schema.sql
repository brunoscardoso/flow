-- The ingest store. Two tables, one idea each.
--
-- THE EVENT IS A DOCUMENT, not a column per property. A shipped desktop binary
-- keeps posting the shape it was built with for months, and no migration ever
-- reaches a copy somebody installed in March. Columns are projected in SQL at
-- read time, where they can change as often as a question does.

create table if not exists events (
  id           bigserial primary key,
  -- Extracted because every question starts with one of them. Both are still
  -- present inside `body`; these are an index, not a second source of truth.
  install_id   text,
  event_name   text,
  received_at  timestamptz not null default now(),
  body         jsonb not null
);

-- The three shapes every question takes: this install's history, this event
-- over time, and "what arrived recently".
create index if not exists events_install_idx on events (install_id, received_at desc);
create index if not exists events_name_idx    on events (event_name, received_at desc);
create index if not exists events_recent_idx  on events (received_at desc);

-- The rate limit's counter. One row per install per window, upserted.
--
-- A SEPARATE TABLE, not a count over `events`: counting rows in a growing table
-- to decide whether to add a row is the query that gets slower exactly as it
-- matters more.
create table if not exists ingest_counters (
  install_id    text not null,
  window_start  timestamptz not null,
  event_count   integer not null default 0,
  primary key (install_id, window_start)
);

-- Old counters are worthless the moment their window passes. Delete them on a
-- schedule; nothing reads a window that is not the current one.
create index if not exists ingest_counters_window_idx on ingest_counters (window_start);

-- ── EXAMPLE QUESTIONS, answered against the document ────────────────────────
--
-- How many installations ran this week, by version:
--   select body->>'appVersion' as version, count(distinct install_id)
--   from events where received_at > now() - interval '7 days' group by 1;
--
-- Median session length, by platform:
--   select body->>'platform' as platform,
--          percentile_cont(0.5) within group (order by (body->>'durationMs')::bigint)
--   from events where event_name = 'session.ended' group by 1;
--
-- Which installations belong to a signed-in person:
--   select distinct install_id, body->>'identityId'
--   from events where body ? 'identityId';

-- ── SIGN-IN (client-sign-in) ────────────────────────────────────────────────
--
-- WHO somebody is, and the short-lived record of an authorization in flight.
-- Deliberately small: a subject, where it came from, and a name to show back.
-- Nothing here is needed to run Flow — signing in gates nothing.

create table if not exists identities (
  subject       text primary key,
  provider      text not null,
  display_name  text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- An authorization the server started, so the callback can tell a real one from
-- a replayed one. Rows are retired on use and worthless once stale.
create table if not exists auth_states (
  state         text primary key,
  redirect_uri  text not null,
  created_at    timestamptz not null default now(),
  used_at       timestamptz
);

-- Stale states are swept by age; nothing reads one that is not current.
create index if not exists auth_states_created_idx on auth_states (created_at);

-- Which installations belong to a person — the join, read from the events
-- themselves rather than stored twice:
--   select distinct install_id from events where body->>'identityId' = $1;

-- The sign-in hand-back (client-sign-in, corrected flow).
--
-- GitHub redirects to the SERVER, not the app — an OAuth App registers one
-- callback URL and a loopback port can never be it. So the server holds the
-- issued session against the state until the app collects it over its own
-- connection, and only the state ever travels through the browser.
alter table auth_states add column if not exists session_token text;
alter table auth_states add column if not exists subject      text;
alter table auth_states add column if not exists display_name text;
alter table auth_states add column if not exists expires_at   bigint;
alter table auth_states add column if not exists claimed_at   timestamptz;

-- Early cut-off for a desktop session (feature-view-sharing).
--
-- A session token is signed, not looked up, so nothing can end one before its
-- 30 days are up. Publishing a share is the one place a stolen token could do
-- harm somebody else sees, so the share API reads this row on every publish and
-- refuses an identity with `disabled_at` set. Set it by hand to cut a lost
-- laptop off; nothing in ingest writes it. Applied by a person, not an agent.
alter table identities add column if not exists disabled_at timestamptz;
