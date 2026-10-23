-- FairyHale Kennel Management — database schema
-- Idempotent: safe to run repeatedly.


-- ---------------------------------------------------------------
-- Users & roles
-- ---------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'user',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions (connect-pg-simple)
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR NOT NULL COLLATE "default",
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);

-- ---------------------------------------------------------------
-- Animals
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS animals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  animal_type          TEXT NOT NULL,          -- Dog, Cat, Rabbit, ...
  breed                TEXT,
  date_of_birth        DATE,                   -- age is derived from this
  age_years_estimate   NUMERIC(4,1),           -- fallback when DOB unknown
  dietary_requirements TEXT,
  medications          TEXT,
  notes                TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,  -- false once checked out / no longer boarded
  created_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_animals_active ON animals (is_active, name);

-- ---------------------------------------------------------------
-- Activity entries: time staff spend with an animal
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_entries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id        UUID NOT NULL REFERENCES animals(id) ON DELETE RESTRICT,
  user_id          UUID NOT NULL REFERENCES users(id),
  activity_type    TEXT NOT NULL,              -- Feeding, Walk, Medication, Grooming, Play, Cleaning, Vet, Other
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
  performed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_animal ON activity_entries (animal_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user   ON activity_entries (user_id, performed_at DESC);

-- ---------------------------------------------------------------
-- Kennel tasks: general chores with a recurrence
-- ---------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE task_frequency AS ENUM ('daily', 'twice_daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'as_needed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS kennel_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  description TEXT,
  frequency   task_frequency NOT NULL DEFAULT 'daily',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_completions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      UUID NOT NULL REFERENCES kennel_tasks(id) ON DELETE RESTRICT,
  user_id      UUID NOT NULL REFERENCES users(id),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_completions_task ON task_completions (task_id, completed_at DESC);

-- ---------------------------------------------------------------
-- Immutable audit log
-- Append-only. UPDATE and DELETE are blocked by trigger; the
-- timestamp is set server-side and cannot be supplied by the app.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  user_id     UUID REFERENCES users(id),
  username    TEXT,                            -- denormalized so history survives user changes
  action      TEXT NOT NULL,                   -- create / update / delete / login / logout / ...
  entity_type TEXT NOT NULL,                   -- animal / activity / task / user / auth
  entity_id   TEXT,
  summary     TEXT NOT NULL,
  before_data JSONB,
  after_data  JSONB,
  ip_address  INET,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity   ON audit_log (entity_type, entity_id);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log;
CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON audit_log;
CREATE TRIGGER trg_audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Force the timestamp to be server-assigned even if a client tries to set it.
CREATE OR REPLACE FUNCTION audit_log_stamp() RETURNS trigger AS $$
BEGIN
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_stamp ON audit_log;
CREATE TRIGGER trg_audit_log_stamp
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_stamp();

-- ---------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','animals','kennel_tasks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------
-- Animal photos (up to 5 per animal, stored in the database so they
-- survive container redeploys; resized on upload)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS animal_photos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id    UUID NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
  position     SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 5),
  content_type TEXT NOT NULL,
  data         BYTEA NOT NULL,        -- full-size (max 1280px, JPEG)
  thumb        BYTEA NOT NULL,        -- thumbnail, longest side 320px, aspect preserved
  thumb_fit    TEXT NOT NULL DEFAULT 'inside',
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  caption      TEXT,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deferred so photos can be renumbered within one transaction.
  CONSTRAINT animal_photos_position_uniq UNIQUE (animal_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_animal_photos_animal ON animal_photos (animal_id, position);

-- Ensure the deferrable uniqueness constraint exists on older tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'animal_photos_animal_id_position_key') THEN
    ALTER TABLE animal_photos DROP CONSTRAINT animal_photos_animal_id_position_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'animal_photos_position_uniq') THEN
    ALTER TABLE animal_photos ADD CONSTRAINT animal_photos_position_uniq UNIQUE (animal_id, position) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
ALTER TABLE animal_photos ADD COLUMN IF NOT EXISTS thumb_fit TEXT NOT NULL DEFAULT 'cover';

-- ---------------------------------------------------------------
-- Medical conditions per animal, plus a cache of reference summaries
-- (fetched from Wikipedia on demand; reference only, not veterinary advice)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS animal_conditions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id   UUID NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,              -- as entered / chosen
  wiki_title  TEXT,                       -- article used for the summary, when known
  notes       TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (animal_id, name)
);
CREATE INDEX IF NOT EXISTS idx_animal_conditions_animal ON animal_conditions (animal_id, created_at);

CREATE TABLE IF NOT EXISTS condition_summaries (
  title       TEXT PRIMARY KEY,           -- normalized Wikipedia title
  display     TEXT,
  extract     TEXT,
  url         TEXT,
  kind        TEXT,                       -- 'standard', 'disambiguation', 'missing'
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Medications per animal, with a dosing schedule and a log of doses given
-- ---------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE med_frequency AS ENUM ('once_daily', 'twice_daily', 'three_times_daily', 'every_other_day', 'weekly', 'monthly', 'as_needed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS animal_medications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id   UUID NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  wiki_title  TEXT,
  dose        TEXT,                        -- e.g. "50 mg", "1 tablet", "0.5 mL"
  frequency   med_frequency NOT NULL DEFAULT 'once_daily',
  notes       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_animal_medications_animal ON animal_medications (animal_id, is_active, name);

CREATE TABLE IF NOT EXISTS medication_doses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medication_id  UUID NOT NULL REFERENCES animal_medications(id) ON DELETE CASCADE,
  animal_id      UUID NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
  given_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  given_by       UUID REFERENCES users(id),
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_medication_doses_med ON medication_doses (medication_id, given_at DESC);

-- ---------------------------------------------------------------
-- Potty groups: which animals can be let out / pottied together
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS potty_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  color       SMALLINT NOT NULL DEFAULT 0,     -- palette index for the badge
  notes       TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_potty_groups_name ON potty_groups (lower(name));

CREATE TABLE IF NOT EXISTS potty_group_members (
  group_id    UUID NOT NULL REFERENCES potty_groups(id) ON DELETE CASCADE,
  animal_id   UUID NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
  added_by    UUID REFERENCES users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, animal_id)
);
CREATE INDEX IF NOT EXISTS idx_potty_group_members_animal ON potty_group_members (animal_id);
