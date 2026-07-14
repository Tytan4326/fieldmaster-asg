CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE game_state AS ENUM ('DRAFT','LOBBY','ACTIVE','PAUSED','FINISHED');
  CREATE TYPE team AS ENUM ('SERE','OPFOR');
  CREATE TYPE participant_status AS ENUM ('WAITING','READY','ACTIVE','TIMER','RESPAWN_WAIT','RESPAWN','CAPTURED','OUTSIDE','SOS','DISCONNECTED','FINISHED','REMOVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  state game_state NOT NULL DEFAULT 'LOBBY',
  duration_minutes integer NOT NULL DEFAULT 1440 CHECK (duration_minutes BETWEEN 10 AND 2880),
  sere_timer_seconds integer NOT NULL DEFAULT 20,
  opfor_timer_seconds integer NOT NULL DEFAULT 60,
  boundary jsonb NOT NULL,
  started_at timestamptz,
  paused_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_definitions (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  icon text NOT NULL,
  color text NOT NULL,
  description text NOT NULL DEFAULT '',
  capabilities jsonb NOT NULL DEFAULT '[]',
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(game_id, code)
);

CREATE TABLE IF NOT EXISTS operational_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  side team NOT NULL,
  color text NOT NULL,
  map_sharing text NOT NULL DEFAULT 'SQUAD' CHECK (map_sharing IN ('NONE','SQUAD','SIDE')),
  respawn_seconds integer CHECK (respawn_seconds BETWEEN 5 AND 1800),
  max_players integer NOT NULL DEFAULT 100 CHECK (max_players BETWEEN 1 AND 500),
  radio_channel text NOT NULL DEFAULT '',
  allowed_roles jsonb NOT NULL DEFAULT '["OPERATOR"]',
  active boolean NOT NULL DEFAULT true,
  UNIQUE(game_id, code)
);

CREATE TABLE IF NOT EXISTS participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  callsign text NOT NULL,
  normalized_callsign text NOT NULL,
  team team NOT NULL,
  squad_id uuid REFERENCES operational_teams(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'OPERATOR',
  status participant_status NOT NULL DEFAULT 'READY',
  map_access boolean NOT NULL DEFAULT true,
  consent_version text NOT NULL,
  consented_at timestamptz NOT NULL,
  battery smallint CHECK (battery BETWEEN 0 AND 100),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(game_id, normalized_callsign)
);

CREATE TABLE IF NOT EXISTS locations (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m real,
  speed_mps real,
  heading real,
  battery smallint,
  device_time timestamptz NOT NULL,
  server_time timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS locations_participant_time ON locations(participant_id, server_time DESC);

CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  event_key uuid NOT NULL DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid REFERENCES participants(id) ON DELETE SET NULL,
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'INFO',
  payload jsonb NOT NULL DEFAULT '{}',
  device_time timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(game_id, event_key)
);
CREATE INDEX IF NOT EXISTS events_game_time ON events(game_id, created_at DESC);

CREATE TABLE IF NOT EXISTS timers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 3600),
  started_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz
);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  latitude double precision,
  longitude double precision,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ACKNOWLEDGED','RESOLVED','FALSE_ALARM')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution_note text
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('ALL','SERE','OPFOR','STAFF','PARTICIPANT')),
  sender_participant_id uuid REFERENCES participants(id) ON DELETE SET NULL,
  recipient_participant_id uuid REFERENCES participants(id) ON DELETE SET NULL,
  sender_staff_id uuid,
  recipient_staff_id uuid,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zones (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  team text NOT NULL,
  geometry jsonb NOT NULL,
  sequence integer,
  objective_id uuid,
  runtime jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS objectives (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  team text NOT NULL,
  points integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING',
  zone_id uuid,
  progress real NOT NULL DEFAULT 0,
  visibility text NOT NULL DEFAULT 'ALL'
);

CREATE TABLE IF NOT EXISTS session_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  label text NOT NULL,
  automatic boolean NOT NULL DEFAULT false,
  snapshot jsonb NOT NULL,
  participant_count integer NOT NULL DEFAULT 0,
  event_count integer NOT NULL DEFAULT 0,
  track_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_archives_game_time ON session_archives(game_id, created_at DESC);
