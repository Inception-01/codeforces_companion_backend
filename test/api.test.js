import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set test DB
const TEST_DB = path.join(__dirname, '../data/test_cf_daily_grind.db');
process.env.DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) {
  fs.unlinkSync(TEST_DB);
}

// Import database after setting DB_PATH
const { default: db } = await import('../src/db.js');
const { calculateStreaks } = await import('../src/utils/streaks.js');
const { checkAutoAdvance } = await import('../src/utils/autoAdvance.js');

console.log('--- Starting Codeforces Companion Test Suite ---');

// Test 1: Tables exist
console.log('Test 1: Verifying SQLite schema creation...');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
assert(tables.includes('users'), 'users table missing');
assert(tables.includes('problems_cache'), 'problems_cache table missing');
assert(tables.includes('daily_assignments'), 'daily_assignments table missing');
assert(tables.includes('problem_solve_log'), 'problem_solve_log table missing');
assert(tables.includes('solve_history'), 'solve_history table missing');
assert(tables.includes('cache_meta'), 'cache_meta table missing');
console.log('✓ Tables initialized correctly');

// Test 2: Streak calculation
console.log('Test 2: Testing streak calculation logic...');
const today = new Date().toISOString().split('T')[0];
const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];
const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString().split('T')[0];
const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];

const streakResult = calculateStreaks([fiveDaysAgo, fourDaysAgo, twoDaysAgo, yesterday, today]);
assert.equal(streakResult.currentStreak, 3, `Expected current streak of 3, got ${streakResult.currentStreak}`);
assert.equal(streakResult.longestStreak, 3, `Expected longest streak of 3, got ${streakResult.longestStreak}`);
assert.equal(streakResult.totalActiveDays, 5, `Expected 5 active days, got ${streakResult.totalActiveDays}`);
console.log('✓ Streak calculation passed');

// Test 3: User creation & settings
console.log('Test 3: User creation & settings...');
db.prepare(`
  INSERT INTO users (handle, daily_target_count, rating_min, rating_max, selected_tags)
  VALUES (?, ?, ?, ?, ?)
`).run('test_user', 3, 1000, 1400, '[]');
const user = db.prepare('SELECT * FROM users WHERE handle = ?').get('test_user');
assert(user, 'User not found in DB');
assert.equal(user.daily_target_count, 3);
assert.equal(user.rating_min, 1000);
assert.equal(user.rating_max, 1400);
console.log('✓ User creation passed');

// Test 4: Problem caching & Natural CF ordering
console.log('Test 4: Populating mock problems and verifying natural CF ordering...');
const insertProblem = db.prepare(`
  INSERT INTO problems_cache (id, contest_id, problem_index, name, rating, tags, solved_count)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Insert out of order
insertProblem.run('100-B', 100, 'B', 'Problem 100B', 1200, JSON.stringify(['math']), 500);
insertProblem.run('100-A', 100, 'A', 'Problem 100A', 1100, JSON.stringify(['implementation']), 1000);
insertProblem.run('101-A', 101, 'A', 'Problem 101A', 1300, JSON.stringify(['greedy']), 300);
insertProblem.run('101-B', 101, 'B', 'Problem 101B', 1400, JSON.stringify(['dp']), 200);
insertProblem.run('99-A', 99, 'A', 'Problem 99A', 1000, JSON.stringify(['implementation']), 800);
insertProblem.run('102-A', 102, 'A', 'Problem 102A', 1200, JSON.stringify(['math']), 400);

const ordered = db.prepare('SELECT * FROM problems_cache WHERE rating >= 1000 AND rating <= 1400 ORDER BY contest_id ASC, problem_index ASC').all();
assert.equal(ordered[0].id, '99-A');
assert.equal(ordered[1].id, '100-A');
assert.equal(ordered[2].id, '100-B');
assert.equal(ordered[3].id, '101-A');
assert.equal(ordered[4].id, '101-B');
assert.equal(ordered[5].id, '102-A');
console.log('✓ Natural Codeforces ordering confirmed (contestId ASC, index ASC)');

// Test 5: Deterministic daily targets & Overdue handling
console.log('Test 5: Daily target generation & overdue carry-over...');
// Assign yesterday's problems
db.prepare(`
  INSERT INTO daily_assignments (user_id, date, problem_ids)
  VALUES (?, ?, ?)
`).run(user.id, yesterday, JSON.stringify(['99-A', '100-A', '100-B']));

db.prepare(`
  INSERT INTO problem_solve_log (user_id, problem_id, assigned_date, solved_at)
  VALUES (?, ?, ?, ?)
`).run(user.id, '99-A', yesterday, yesterday + 'T10:00:00Z');

db.prepare(`
  INSERT INTO problem_solve_log (user_id, problem_id, assigned_date, solved_at)
  VALUES (?, ?, ?, ?)
`).run(user.id, '100-A', yesterday, null); // Unsolved -> becomes overdue

db.prepare(`
  INSERT INTO problem_solve_log (user_id, problem_id, assigned_date, solved_at)
  VALUES (?, ?, ?, ?)
`).run(user.id, '100-B', yesterday, null); // Unsolved -> becomes overdue

db.prepare(`
  INSERT INTO solve_history (user_id, problem_id, solved_at, contest_id, problem_index, problem_name, problem_rating, problem_tags)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(user.id, '99-A', yesterday + 'T10:00:00Z', 99, 'A', 'Problem 99A', 1000, JSON.stringify(['implementation']));

// Check overdue detection
const overdue = db.prepare(`
  SELECT problem_id FROM problem_solve_log 
  WHERE user_id = ? AND solved_at IS NULL AND assigned_date < ?
`).all(user.id, today);
assert.equal(overdue.length, 2);
assert.equal(overdue[0].problem_id, '100-A');
assert.equal(overdue[1].problem_id, '100-B');
console.log('✓ Overdue detection passed');

// Test 6: Auto-advance calculation
console.log('Test 6: Testing Auto-advance suggestion (>80% solve rate)...');
// Insert 10 assignments all solved
for (let i = 2; i <= 11; i++) {
  const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
  db.prepare(`INSERT OR IGNORE INTO daily_assignments (user_id, date, problem_ids) VALUES (?, ?, ?)`).run(user.id, d, JSON.stringify([`mock-${i}`]));
  db.prepare(`INSERT OR IGNORE INTO problem_solve_log (user_id, problem_id, assigned_date, solved_at) VALUES (?, ?, ?, ?)`).run(user.id, `mock-${i}`, d, d + 'T12:00:00Z');
}

const autoAdv = checkAutoAdvance(db, user.id);
assert(autoAdv.suggest, 'Auto-advance should be suggested with high solve rate');
assert.equal(autoAdv.newMin, user.rating_min + 100);
assert.equal(autoAdv.newMax, user.rating_max + 100);
console.log(`✓ Auto-advance suggested upgrade to ${autoAdv.newMin}-${autoAdv.newMax}`);

// Clean up test DB
db.close();
if (fs.existsSync(TEST_DB)) {
  fs.unlinkSync(TEST_DB);
}
console.log('\n--- All Automated Backend Tests Passed Successfully! ---');
