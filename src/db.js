import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DB_PATH || './data/cf_daily_grind.db';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode
db.pragma('journal_mode = WAL');

// Run migrations
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT NOT NULL UNIQUE,
    daily_target_count INTEGER DEFAULT 3,
    rating_min INTEGER DEFAULT 800,
    rating_max INTEGER DEFAULT 1400,
    selected_tags TEXT DEFAULT '[]',
    cursor_problem_id TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS problems_cache (
    id TEXT PRIMARY KEY,
    contest_id INTEGER NOT NULL,
    problem_index TEXT NOT NULL,
    name TEXT NOT NULL,
    rating INTEGER,
    tags TEXT DEFAULT '[]',
    solved_count INTEGER DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    problem_ids TEXT NOT NULL,
    generated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, date)
  );

  CREATE TABLE IF NOT EXISTS problem_solve_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    problem_id TEXT NOT NULL,
    assigned_date TEXT,
    solved_at TEXT,
    verdict_checked_at TEXT,
    UNIQUE(user_id, problem_id, assigned_date)
  );

  CREATE TABLE IF NOT EXISTS solve_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    problem_id TEXT NOT NULL,
    solved_at TEXT NOT NULL,
    contest_id INTEGER,
    problem_index TEXT,
    problem_name TEXT,
    problem_rating INTEGER,
    problem_tags TEXT DEFAULT '[]',
    UNIQUE(user_id, problem_id)
  );

  CREATE TABLE IF NOT EXISTS cache_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS learning_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    article_key TEXT NOT NULL,
    completed_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, article_key)
  );

  CREATE TABLE IF NOT EXISTS arena_session (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    problem_id TEXT,
    problem_name TEXT,
    difficulty TEXT,
    state TEXT DEFAULT 'idle',
    accumulated_ms INTEGER DEFAULT 0,
    started_at INTEGER,
    last_active INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS arena_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    problem_id TEXT,
    problem_name TEXT,
    difficulty TEXT,
    solved INTEGER NOT NULL DEFAULT 0,
    time_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_solve_history_user_date ON solve_history(user_id, solved_at);
  CREATE INDEX IF NOT EXISTS idx_problems_cache_rating ON problems_cache(rating);
  CREATE INDEX IF NOT EXISTS idx_daily_assignments_user_date ON daily_assignments(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_learning_progress_user ON learning_progress(user_id);
  CREATE INDEX IF NOT EXISTS idx_arena_log_user ON arena_log(user_id, created_at);
`);

try {
  db.prepare(`ALTER TABLE arena_session ADD COLUMN last_active INTEGER`).run();
} catch (e) {
  // column already exists
}

export default db;
