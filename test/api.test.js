import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// Use a test-specific database
// Use a test-specific database or fallback to localhost
const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://localhost:5432/learn';

let pool;

async function setupTestDb() {
  process.env.DATABASE_URL = TEST_DB_URL;
  pool = new pg.Pool({ connectionString: TEST_DB_URL });

  // Clean any previous test tables
  await pool.query(`
    DROP TABLE IF EXISTS arena_log CASCADE;
    DROP TABLE IF EXISTS arena_session CASCADE;
    DROP TABLE IF EXISTS learning_progress CASCADE;
    DROP TABLE IF EXISTS verification_codes CASCADE;
    DROP TABLE IF EXISTS cache_meta CASCADE;
    DROP TABLE IF EXISTS solve_history CASCADE;
    DROP TABLE IF EXISTS problem_solve_log CASCADE;
    DROP TABLE IF EXISTS daily_assignments CASCADE;
    DROP TABLE IF EXISTS problems_cache CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `);

  // Run migrations inline (same as 001_initial.sql)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      daily_target_count INTEGER DEFAULT 3,
      rating_min INTEGER DEFAULT 800,
      rating_max INTEGER DEFAULT 1400,
      selected_tags JSONB DEFAULT '[]'::jsonb,
      cursor_problem_id TEXT DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS problems_cache (
      id TEXT PRIMARY KEY,
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      name TEXT NOT NULL,
      rating INTEGER,
      tags JSONB DEFAULT '[]'::jsonb,
      solved_count INTEGER DEFAULT 0,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS daily_assignments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      problem_ids JSONB NOT NULL,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, date)
    );

    CREATE TABLE IF NOT EXISTS problem_solve_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      problem_id TEXT NOT NULL,
      assigned_date DATE,
      solved_at TIMESTAMPTZ,
      verdict_checked_at TIMESTAMPTZ,
      UNIQUE(user_id, problem_id, assigned_date)
    );

    CREATE TABLE IF NOT EXISTS solve_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      problem_id TEXT NOT NULL,
      solved_at TIMESTAMPTZ NOT NULL,
      contest_id INTEGER,
      problem_index TEXT,
      problem_name TEXT,
      problem_rating INTEGER,
      problem_tags JSONB DEFAULT '[]'::jsonb,
      UNIQUE(user_id, problem_id)
    );

    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id SERIAL PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL,
      problem_contest_id INTEGER DEFAULT 1000,
      problem_index TEXT DEFAULT 'A',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      verified_at TIMESTAMPTZ DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_progress (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      article_key TEXT NOT NULL,
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, article_key)
    );

    CREATE TABLE IF NOT EXISTS arena_session (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      problem_id TEXT,
      problem_name TEXT,
      difficulty TEXT,
      state TEXT DEFAULT 'idle',
      accumulated_ms BIGINT DEFAULT 0,
      started_at BIGINT,
      last_active BIGINT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS arena_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      problem_id TEXT,
      problem_name TEXT,
      difficulty TEXT,
      solved INTEGER NOT NULL DEFAULT 0,
      time_ms BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_solve_history_user_date ON solve_history(user_id, solved_at);
    CREATE INDEX IF NOT EXISTS idx_problems_cache_rating ON problems_cache(rating);
    CREATE INDEX IF NOT EXISTS idx_daily_assignments_user_date ON daily_assignments(user_id, date);
  `);
}

async function teardownTestDb() {
  if (pool) {
    await pool.query(`
      TRUNCATE TABLE arena_log, arena_session, learning_progress, verification_codes,
                     solve_history, problem_solve_log, daily_assignments, users CASCADE;
    `).catch(() => {});
    await pool.end();
  }
  const { closePool } = await import('../src/db.js');
  await closePool();
}

// Import pure utility functions
const { calculateStreaks } = await import('../src/utils/streaks.js');

describe('CF Daily Grind Test Suite (PostgreSQL)', () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  // ---------- Schema Tests ----------
  describe('Schema', () => {
    it('should have all required tables', async () => {
      const { rows } = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      const tables = rows.map(r => r.table_name);
      const required = [
        'users', 'problems_cache', 'daily_assignments',
        'problem_solve_log', 'solve_history', 'cache_meta',
        'verification_codes', 'learning_progress', 'arena_session', 'arena_log',
      ];
      for (const t of required) {
        assert(tables.includes(t), `Table "${t}" missing. Found: ${tables.join(', ')}`);
      }
    });

    it('users table should have correct columns', async () => {
      const { rows } = await pool.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'users' ORDER BY ordinal_position
      `);
      const colNames = rows.map(r => r.column_name);
      assert(colNames.includes('id'));
      assert(colNames.includes('handle'));
      assert(colNames.includes('daily_target_count'));
      assert(colNames.includes('rating_min'));
      assert(colNames.includes('rating_max'));
      assert(colNames.includes('selected_tags'));
    });

    it('verification_codes should have problem_contest_id and problem_index', async () => {
      const { rows } = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'verification_codes'
      `);
      const colNames = rows.map(r => r.column_name);
      assert(colNames.includes('problem_contest_id'));
      assert(colNames.includes('problem_index'));
    });
  });

  // ---------- Streak Tests ----------
  describe('Streak Calculation', () => {
    it('should calculate streaks correctly', () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];
      const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString().split('T')[0];
      const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];

      const result = calculateStreaks([fiveDaysAgo, fourDaysAgo, twoDaysAgo, yesterday, today]);
      assert.equal(result.currentStreak, 3, `Expected current streak of 3, got ${result.currentStreak}`);
      assert.equal(result.longestStreak, 3, `Expected longest streak of 3, got ${result.longestStreak}`);
      assert.equal(result.totalActiveDays, 5, `Expected 5 active days, got ${result.totalActiveDays}`);
    });

    it('should return zero streaks for empty dates', () => {
      const result = calculateStreaks([]);
      assert.equal(result.currentStreak, 0);
      assert.equal(result.longestStreak, 0);
      assert.equal(result.totalActiveDays, 0);
    });

    it('should handle single day', () => {
      const today = new Date().toISOString().split('T')[0];
      const result = calculateStreaks([today]);
      assert.equal(result.currentStreak, 1);
      assert.equal(result.longestStreak, 1);
      assert.equal(result.totalActiveDays, 1);
    });
  });

  // ---------- User CRUD Tests ----------
  describe('User CRUD', () => {
    let userId;

    it('should create a user', async () => {
      await pool.query(
        `INSERT INTO users (handle, daily_target_count, rating_min, rating_max, selected_tags)
         VALUES ($1, $2, $3, $4, $5)`,
        ['test_user', 3, 1000, 1400, JSON.stringify([])]
      );
      const { rows } = await pool.query('SELECT * FROM users WHERE handle = $1', ['test_user']);
      assert(rows.length === 1, 'User not found');
      assert.equal(rows[0].daily_target_count, 3);
      assert.equal(rows[0].rating_min, 1000);
      assert.equal(rows[0].rating_max, 1400);
      userId = rows[0].id;
    });

    it('should update user settings', async () => {
      await pool.query(
        'UPDATE users SET daily_target_count = $1, rating_min = $2, rating_max = $3, updated_at = NOW() WHERE id = $4',
        [5, 1200, 1600, userId]
      );
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      assert.equal(rows[0].daily_target_count, 5);
      assert.equal(rows[0].rating_min, 1200);
      assert.equal(rows[0].rating_max, 1600);

      // Reset for other tests
      await pool.query(
        'UPDATE users SET daily_target_count = 3, rating_min = 1000, rating_max = 1400 WHERE id = $1',
        [userId]
      );
    });

    it('should enforce unique handles', async () => {
      await assert.rejects(
        pool.query('INSERT INTO users (handle) VALUES ($1)', ['test_user']),
        /duplicate key/
      );
    });

    it('ON CONFLICT should work for upsert', async () => {
      await pool.query(
        'INSERT INTO users (handle) VALUES ($1) ON CONFLICT (handle) DO NOTHING',
        ['test_user']
      );
      const { rows } = await pool.query('SELECT * FROM users WHERE handle = $1', ['test_user']);
      assert.equal(rows.length, 1);
    });
  });

  // ---------- Problem Cache & Ordering Tests ----------
  describe('Problem Cache & Natural Ordering', () => {
    it('should store problems and maintain natural CF ordering', async () => {
      const problems = [
        ['100-B', 100, 'B', 'Problem 100B', 1200, JSON.stringify(['math']), 500],
        ['100-A', 100, 'A', 'Problem 100A', 1100, JSON.stringify(['implementation']), 1000],
        ['101-A', 101, 'A', 'Problem 101A', 1300, JSON.stringify(['greedy']), 300],
        ['101-B', 101, 'B', 'Problem 101B', 1400, JSON.stringify(['dp']), 200],
        ['99-A', 99, 'A', 'Problem 99A', 1000, JSON.stringify(['implementation']), 800],
        ['102-A', 102, 'A', 'Problem 102A', 1200, JSON.stringify(['math']), 400],
      ];

      for (const p of problems) {
        await pool.query(
          `INSERT INTO problems_cache (id, contest_id, problem_index, name, rating, tags, solved_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          p
        );
      }

      const { rows } = await pool.query(
        'SELECT * FROM problems_cache WHERE rating >= $1 AND rating <= $2 ORDER BY contest_id ASC, problem_index ASC',
        [1000, 1400]
      );

      assert.equal(rows[0].id, '99-A');
      assert.equal(rows[1].id, '100-A');
      assert.equal(rows[2].id, '100-B');
      assert.equal(rows[3].id, '101-A');
      assert.equal(rows[4].id, '101-B');
      assert.equal(rows[5].id, '102-A');
    });

    it('should support JSONB tag filtering', async () => {
      const { rows } = await pool.query(
        `SELECT * FROM problems_cache WHERE tags @> $1::jsonb`,
        [JSON.stringify(['math'])]
      );
      assert(rows.length >= 2, `Expected at least 2 math problems, got ${rows.length}`);
      for (const r of rows) {
        const tags = typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags;
        assert(tags.includes('math'), `Problem ${r.id} should have math tag`);
      }
    });
  });

  // ---------- Daily Assignments & Overdue Tests ----------
  describe('Daily Assignments & Overdue', () => {
    it('should detect overdue unsolved problems', async () => {
      const { rows: users } = await pool.query('SELECT id FROM users WHERE handle = $1', ['test_user']);
      const userId = users[0].id;

      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];

      await pool.query(
        'INSERT INTO daily_assignments (user_id, date, problem_ids) VALUES ($1, $2, $3) ON CONFLICT (user_id, date) DO NOTHING',
        [userId, yesterday, JSON.stringify(['99-A', '100-A', '100-B'])]
      );

      // 99-A solved, 100-A and 100-B unsolved
      await pool.query(
        `INSERT INTO problem_solve_log (user_id, problem_id, assigned_date, solved_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, problem_id, assigned_date) DO NOTHING`,
        [userId, '99-A', yesterday, new Date(yesterday + 'T10:00:00Z')]
      );
      await pool.query(
        `INSERT INTO problem_solve_log (user_id, problem_id, assigned_date, solved_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, problem_id, assigned_date) DO NOTHING`,
        [userId, '100-A', yesterday, null]
      );
      await pool.query(
        `INSERT INTO problem_solve_log (user_id, problem_id, assigned_date, solved_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, problem_id, assigned_date) DO NOTHING`,
        [userId, '100-B', yesterday, null]
      );

      const { rows: overdue } = await pool.query(
        'SELECT problem_id FROM problem_solve_log WHERE user_id = $1 AND solved_at IS NULL AND assigned_date < $2',
        [userId, today]
      );

      assert.equal(overdue.length, 2, `Expected 2 overdue, got ${overdue.length}`);
      const overdueIds = overdue.map(r => r.problem_id).sort();
      assert.deepEqual(overdueIds, ['100-A', '100-B']);
    });
  });

  // ---------- Auto-Advance Tests ----------
  describe('Auto-Advance', () => {
    it('should suggest advancement with >80% solve rate', async () => {
      const { rows: users } = await pool.query('SELECT id, rating_min, rating_max FROM users WHERE handle = $1', ['test_user']);
      const userId = users[0].id;

      // Insert 10 solved assignments in the last 14 days
      for (let i = 2; i <= 11; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        await pool.query(
          `INSERT INTO daily_assignments (user_id, date, problem_ids) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, date) DO NOTHING`,
          [userId, d, JSON.stringify([`mock-${i}`])]
        );
        await pool.query(
          `INSERT INTO problem_solve_log (user_id, problem_id, assigned_date, solved_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, problem_id, assigned_date) DO NOTHING`,
          [userId, `mock-${i}`, d, new Date(d + 'T12:00:00Z')]
        );
      }

      // Import and test auto-advance
      const { checkAutoAdvance } = await import('../src/utils/autoAdvance.js');

      // Temporarily set DATABASE_URL so the db module connects correctly
      const result = await checkAutoAdvance(userId);
      assert(result.suggest, 'Auto-advance should suggest with high solve rate');
      assert.equal(result.newMin, users[0].rating_min + 100);
      assert.equal(result.newMax, users[0].rating_max + 100);
    });
  });

  // ---------- Verification Codes Tests ----------
  describe('Verification Codes', () => {
    it('should store and retrieve verification codes', async () => {
      await pool.query(
        `INSERT INTO verification_codes (handle, code, problem_contest_id, problem_index)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (handle) DO UPDATE SET code = $2, problem_contest_id = $3, problem_index = $4, created_at = NOW(), verified_at = NULL`,
        ['verify_test_user', 'CF_VERIFY_TEST123', 4, 'A']
      );

      const { rows } = await pool.query('SELECT * FROM verification_codes WHERE handle = $1', ['verify_test_user']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].code, 'CF_VERIFY_TEST123');
      assert.equal(rows[0].problem_contest_id, 4);
      assert.equal(rows[0].problem_index, 'A');
      assert.equal(rows[0].verified_at, null);
    });

    it('should mark verification as complete', async () => {
      await pool.query('UPDATE verification_codes SET verified_at = NOW() WHERE handle = $1', ['verify_test_user']);
      const { rows } = await pool.query('SELECT * FROM verification_codes WHERE handle = $1', ['verify_test_user']);
      assert(rows[0].verified_at !== null, 'verified_at should be set');
    });

    it('should allow login with case-insensitive handle matching', async () => {
      await pool.query(
        "INSERT INTO users (handle, daily_target_count) VALUES ('TourisT', 3) ON CONFLICT (handle) DO NOTHING"
      );
      const { rows } = await pool.query(
        'SELECT * FROM users WHERE LOWER(handle) = LOWER($1)',
        ['tourist']
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].handle, 'TourisT');
    });

    it('should securely hash password with bcrypt and verify login credentials', async () => {
      const bcrypt = (await import('bcryptjs')).default;
      const plainPassword = 'mySecretPassword123';
      const hash = await bcrypt.hash(plainPassword, 10);

      await pool.query(
        "INSERT INTO users (handle, password_hash) VALUES ('pass_user', $1) ON CONFLICT (handle) DO UPDATE SET password_hash = $1",
        [hash]
      );

      const { rows } = await pool.query('SELECT * FROM users WHERE handle = $1', ['pass_user']);
      assert(rows[0].password_hash, 'password_hash should be stored');

      const isMatch = await bcrypt.compare(plainPassword, rows[0].password_hash);
      assert.equal(isMatch, true, 'Valid password must match bcrypt hash');

      const isWrong = await bcrypt.compare('wrongPassword', rows[0].password_hash);
      assert.equal(isWrong, false, 'Invalid password must be rejected');
    });
  });

  // ---------- Solve History Tests ----------
  describe('Solve History', () => {
    it('should upsert solve history correctly', async () => {
      const { rows: users } = await pool.query('SELECT id FROM users WHERE handle = $1', ['test_user']);
      const userId = users[0].id;

      await pool.query(
        `INSERT INTO solve_history (user_id, problem_id, solved_at, contest_id, problem_index, problem_name, problem_rating, problem_tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, problem_id) DO UPDATE SET solved_at = LEAST(solve_history.solved_at, $3)`,
        [userId, '99-A', new Date('2024-01-01T10:00:00Z'), 99, 'A', 'Problem 99A', 1000, JSON.stringify(['implementation'])]
      );

      const { rows } = await pool.query('SELECT * FROM solve_history WHERE user_id = $1 AND problem_id = $2', [userId, '99-A']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].problem_name, 'Problem 99A');
    });
  });

  // ---------- Arena Session Tests ----------
  describe('Arena Session', () => {
    it('should create and update arena sessions', async () => {
      const { rows: users } = await pool.query('SELECT id FROM users WHERE handle = $1', ['test_user']);
      const userId = users[0].id;

      const now = Date.now();
      await pool.query(
        `INSERT INTO arena_session (user_id, problem_id, problem_name, difficulty, state, accumulated_ms, started_at, last_active)
         VALUES ($1, $2, $3, $4, 'running', 0, $5, $5)
         ON CONFLICT (user_id) DO UPDATE SET
           problem_id = $2, problem_name = $3, difficulty = $4,
           state = 'running', accumulated_ms = 0, started_at = $5, last_active = $5`,
        [userId, '100-A', 'Problem 100A', 'medium', now]
      );

      const { rows } = await pool.query('SELECT * FROM arena_session WHERE user_id = $1', [userId]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, 'running');
      assert.equal(rows[0].problem_id, '100-A');
    });

    it('should log arena results', async () => {
      const { rows: users } = await pool.query('SELECT id FROM users WHERE handle = $1', ['test_user']);
      const userId = users[0].id;

      await pool.query(
        `INSERT INTO arena_log (user_id, problem_id, problem_name, difficulty, solved, time_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, '100-A', 'Problem 100A', 'medium', 1, 120000]
      );

      const { rows } = await pool.query('SELECT * FROM arena_log WHERE user_id = $1', [userId]);
      assert(rows.length >= 1);
      assert.equal(rows[rows.length - 1].solved, 1);
    });
  });

  // ---------- Verification Code Generation Tests ----------
  describe('Verification Code Generation', () => {
    it('should generate cryptographically random codes', async () => {
      const { generateVerificationCode } = await import('../src/cfApi.js');
      const code1 = generateVerificationCode();
      const code2 = generateVerificationCode();

      assert(code1.startsWith('CF_VERIFY_'), `Code should start with CF_VERIFY_, got: ${code1}`);
      assert.equal(code1.length, 'CF_VERIFY_'.length + 12);
      assert.notEqual(code1, code2, 'Two codes should be different');
    });

    it('should pick from verification problem pool', async () => {
      const { pickVerificationProblem } = await import('../src/cfApi.js');
      const seen = new Set();
      for (let i = 0; i < 50; i++) {
        const p = pickVerificationProblem();
        assert(p.contestId, 'Problem should have contestId');
        assert(p.index, 'Problem should have index');
        seen.add(`${p.contestId}-${p.index}`);
      }
      // With 5 problems and 50 tries, we should see at least 2 different problems
      assert(seen.size >= 2, `Should see variety in verification problems, got ${seen.size}`);
    });
  });

  // ---------- JSONB & Date Handling Tests ----------
  describe('JSONB & Date Handling', () => {
    it('JSONB columns should be parsed automatically by pg driver', async () => {
      const { rows: users } = await pool.query('SELECT selected_tags FROM users WHERE handle = $1', ['test_user']);
      assert(Array.isArray(users[0].selected_tags), 'selected_tags should be an array');
    });

    it('TIMESTAMPTZ should be consistent regardless of insert format', async () => {
      const { rows: users } = await pool.query('SELECT id FROM users WHERE handle = $1', ['test_user']);
      const userId = users[0].id;

      // Insert with ISO string
      await pool.query(
        `INSERT INTO solve_history (user_id, problem_id, solved_at, problem_name, problem_tags)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, problem_id) DO UPDATE SET solved_at = $3`,
        [userId, 'date-test-1', '2024-06-15T10:30:00.000Z', 'Date Test 1', '[]']
      );

      // Insert with NOW()
      await pool.query(
        `INSERT INTO solve_history (user_id, problem_id, solved_at, problem_name, problem_tags)
         VALUES ($1, $2, NOW(), $3, $4)
         ON CONFLICT (user_id, problem_id) DO UPDATE SET solved_at = NOW()`,
        [userId, 'date-test-2', 'Date Test 2', '[]']
      );

      const { rows } = await pool.query(
        'SELECT solved_at FROM solve_history WHERE user_id = $1 AND problem_id IN ($2, $3)',
        [userId, 'date-test-1', 'date-test-2']
      );

      // Both should be Date instances (pg driver parses TIMESTAMPTZ)
      for (const r of rows) {
        assert(r.solved_at instanceof Date, `solved_at should be a Date, got: ${typeof r.solved_at}`);
        // Should be extractable to YYYY-MM-DD
        const dateStr = r.solved_at.toISOString().split('T')[0];
        assert(/^\d{4}-\d{2}-\d{2}$/.test(dateStr), `Date should be extractable: ${dateStr}`);
      }
    });
  });

  // ---------- CASCADE Delete Tests ----------
  describe('CASCADE Deletes', () => {
    it('deleting a user should cascade to related tables', async () => {
      // Create a temporary user
      await pool.query('INSERT INTO users (handle) VALUES ($1)', ['cascade_test']);
      const { rows } = await pool.query('SELECT id FROM users WHERE handle = $1', ['cascade_test']);
      const uid = rows[0].id;

      // Insert related data
      await pool.query(
        'INSERT INTO daily_assignments (user_id, date, problem_ids) VALUES ($1, $2, $3)',
        [uid, '2024-01-01', '["test"]']
      );
      await pool.query(
        'INSERT INTO solve_history (user_id, problem_id, solved_at, problem_tags) VALUES ($1, $2, NOW(), $3)',
        [uid, 'cascade-prob', '[]']
      );

      // Delete user
      await pool.query('DELETE FROM users WHERE id = $1', [uid]);

      // Verify cascades
      const { rows: assignments } = await pool.query(
        'SELECT * FROM daily_assignments WHERE user_id = $1', [uid]
      );
      assert.equal(assignments.length, 0, 'Assignments should be deleted');

      const { rows: history } = await pool.query(
        'SELECT * FROM solve_history WHERE user_id = $1', [uid]
      );
      assert.equal(history.length, 0, 'Solve history should be deleted');
    });
  });
});
