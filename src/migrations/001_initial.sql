-- 001_initial.sql — Full PostgreSQL schema for CF Daily Grind

CREATE TABLE IF NOT EXISTS schema_migrations (
  version  INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  handle              TEXT NOT NULL UNIQUE,
  daily_target_count  INTEGER DEFAULT 3,
  rating_min          INTEGER DEFAULT 800,
  rating_max          INTEGER DEFAULT 1400,
  selected_tags       JSONB DEFAULT '[]'::jsonb,
  cursor_problem_id   TEXT DEFAULT NULL,
  password_hash       TEXT DEFAULT NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS problems_cache (
  id              TEXT PRIMARY KEY,
  contest_id      INTEGER NOT NULL,
  problem_index   TEXT NOT NULL,
  name            TEXT NOT NULL,
  rating          INTEGER,
  tags            JSONB DEFAULT '[]'::jsonb,
  solved_count    INTEGER DEFAULT 0,
  fetched_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_assignments (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  problem_ids     JSONB NOT NULL,
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS problem_solve_log (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  problem_id          TEXT NOT NULL,
  assigned_date       DATE,
  solved_at           TIMESTAMPTZ,
  verdict_checked_at  TIMESTAMPTZ,
  UNIQUE(user_id, problem_id, assigned_date)
);

CREATE TABLE IF NOT EXISTS solve_history (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  problem_id      TEXT NOT NULL,
  solved_at       TIMESTAMPTZ NOT NULL,
  contest_id      INTEGER,
  problem_index   TEXT,
  problem_name    TEXT,
  problem_rating  INTEGER,
  problem_tags    JSONB DEFAULT '[]'::jsonb,
  UNIQUE(user_id, problem_id)
);

CREATE TABLE IF NOT EXISTS cache_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id                  SERIAL PRIMARY KEY,
  handle              TEXT NOT NULL UNIQUE,
  code                TEXT NOT NULL,
  problem_contest_id  INTEGER DEFAULT 1000,
  problem_index       TEXT DEFAULT 'A',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  verified_at         TIMESTAMPTZ DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS learning_progress (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_key     TEXT NOT NULL,
  completed_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, article_key)
);

CREATE TABLE IF NOT EXISTS arena_session (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  problem_id    TEXT,
  problem_name  TEXT,
  difficulty    TEXT,
  state         TEXT DEFAULT 'idle',
  accumulated_ms BIGINT DEFAULT 0,
  started_at    BIGINT,
  last_active   BIGINT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS arena_log (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  problem_id      TEXT,
  problem_name    TEXT,
  difficulty      TEXT,
  solved          INTEGER NOT NULL DEFAULT 0,
  time_ms         BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_solve_history_user_date ON solve_history(user_id, solved_at);
CREATE INDEX IF NOT EXISTS idx_problems_cache_rating ON problems_cache(rating);
CREATE INDEX IF NOT EXISTS idx_daily_assignments_user_date ON daily_assignments(user_id, date);
CREATE INDEX IF NOT EXISTS idx_learning_progress_user ON learning_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_arena_log_user ON arena_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_problem_solve_log_user_date ON problem_solve_log(user_id, assigned_date);
CREATE INDEX IF NOT EXISTS idx_verification_codes_handle ON verification_codes(handle);
