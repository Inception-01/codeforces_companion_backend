import express from 'express';
import db from '../db.js';

const router = express.Router();

// Auto-cancel a session whose owner hasn't touched it within 3 hours.
const INACTIVE_CANCEL_MS = 3 * 60 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function getSession(userId) {
  return db.prepare('SELECT * FROM arena_session WHERE user_id = ?').get(userId);
}

// If the session is not idle and last_active is older than the window, discard it (no log).
function cancelIfStale(userId) {
  const session = getSession(userId);
  if (!session || session.state === 'idle') return session;
  const lastActive = session.last_active || session.started_at || 0;
  if (nowMs() - lastActive > INACTIVE_CANCEL_MS) {
    db.prepare(
      `UPDATE arena_session SET state='idle', problem_id=NULL, problem_name=NULL,
        difficulty=NULL, accumulated_ms=0, started_at=NULL, last_active=?, updated_at=datetime('now')
       WHERE user_id=?`
    ).run(nowMs(), userId);
    return getSession(userId);
  }
  return session;
}

function touch(userId) {
  db.prepare(`UPDATE arena_session SET last_active=?, updated_at=datetime('now') WHERE user_id=?`).run(nowMs(), userId);
}


function totalElapsedMs(session, now) {
  if (!session) return 0;
  let base = session.accumulated_ms || 0;
  if (session.state === 'running' && session.started_at) {
    base += (now - session.started_at);
  }
  return Math.max(0, Math.round(base));
}

function serializeSession(session) {
  const now = nowMs();
  const elapsed = totalElapsedMs(session, now);
  return {
    problem_id: session.problem_id || null,
    problem_name: session.problem_name || null,
    difficulty: session.difficulty || null,
    state: session.state || 'idle',
    elapsedMs: elapsed,
    startedAt: session.started_at || null,
    serverTime: now,
  };
}

function computeStats(userId) {
  const rows = db.prepare(`
    SELECT solved, time_ms, created_at FROM arena_log WHERE user_id = ? ORDER BY id ASC
  `).all(userId);

  const solvedRows = rows.filter(r => r.solved === 1);
  const solved = solvedRows.length;
  const attempted = rows.length;
  const avgMs = solvedRows.length
    ? Math.round(solvedRows.reduce((a, b) => a + b.time_ms, 0) / solvedRows.length)
    : null;
  const fastestMs = solvedRows.length
    ? Math.min(...solvedRows.map(r => r.time_ms))
    : null;

  // consecutive days practiced, counting back from today
  const days = new Set(rows.map(r => String(r.created_at).slice(0, 10)));
  const today = new Date().toISOString().slice(0, 10);
  let streakDays = 0;
  let cursor = new Date(`${today}T00:00:00Z`);
  while (true) {
    const key = cursor.toISOString().slice(0, 10);
    if (days.has(key)) {
      streakDays++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    } else {
      break;
    }
  }
  const totalDays = days.size;

  return {
    solved,
    attempted,
    avgMs,
    fastestMs,
    streakDays,
    totalDays,
  };
}

function getUserIdOr404(req, res) {
  const { userId } = req.params;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(parseInt(userId, 10));
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  return user.id;
}

// Current session + log + stats
router.get('/:userId', (req, res) => {
  const userId = getUserIdOr404(req, res);
  if (userId === null) return;
  try {
    cancelIfStale(userId);
    const session = getSession(userId);
    const log = db.prepare(`
      SELECT id, problem_id, problem_name, difficulty, solved, time_ms, created_at
      FROM arena_log WHERE user_id = ? ORDER BY id DESC LIMIT 50
    `).all(userId);

    res.json({
      session: session ? serializeSession(session) : { state: 'idle', elapsedMs: 0, problem_id: null, problem_name: null, difficulty: null, startedAt: null, serverTime: nowMs() },
      log: log.map(r => ({ ...r, solved: !!r.solved })),
      stats: computeStats(userId),
    });
  } catch (error) {
    console.error('Error loading arena:', error.message);
    res.status(500).json({ error: 'Failed to load arena' });
  }
});

// Start a session on a problem
router.post('/:userId/start', (req, res) => {
  const userId = getUserIdOr404(req, res);
  if (userId === null) return;
  try {
    let { problemId, problemName, difficulty } = req.body || {};
    problemId = (problemId || '').trim() || null;
    problemName = (problemName || '').trim() || problemId;
    difficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : null;

    // resolve problem metadata from cache if possible
    let name = problemName;
    if (problemId) {
      const p = db.prepare(`SELECT id, name, contest_id, problem_index FROM problems_cache WHERE id = ?`).get(problemId);
      if (p) name = `${p.contest_id}${p.problem_index} · ${p.name}`;
    }

    db.prepare(`
      INSERT INTO arena_session (user_id, problem_id, problem_name, difficulty, state, accumulated_ms, started_at, last_active, updated_at)
      VALUES (?, ?, ?, ?, 'running', 0, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        problem_id = excluded.problem_id,
        problem_name = excluded.problem_name,
        difficulty = excluded.difficulty,
        state = 'running',
        accumulated_ms = 0,
        started_at = excluded.started_at,
        last_active = excluded.last_active,
        updated_at = datetime('now')
    `).run(userId, problemId, name, difficulty, nowMs(), nowMs());

    res.json({ session: serializeSession(getSession(userId)) });
  } catch (error) {
    console.error('Error starting arena:', error.message);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Toggle pause / resume
router.post('/:userId/pause', (req, res) => {
  const userId = getUserIdOr404(req, res);
  if (userId === null) return;
  try {
    const session = getSession(userId);
    if (!session || session.state === 'idle') {
      return res.json({ session: { state: 'idle', elapsedMs: 0, problem_id: null, problem_name: null, difficulty: null, startedAt: null, serverTime: nowMs() } });
    }
    const now = nowMs();
    if (session.state === 'running') {
      const acc = (session.accumulated_ms || 0) + (now - (session.started_at || now));
      db.prepare(`UPDATE arena_session SET state='paused', accumulated_ms=?, started_at=NULL, last_active=?, updated_at=datetime('now') WHERE user_id=?`).run(Math.round(acc), now, userId);
    } else {
      db.prepare(`UPDATE arena_session SET state='running', started_at=?, last_active=?, updated_at=datetime('now') WHERE user_id=?`).run(now, now, userId);
    }
    res.json({ session: serializeSession(getSession(userId)) });
  } catch (error) {
    console.error('Error pausing arena:', error.message);
    res.status(500).json({ error: 'Failed to pause session' });
  }
});

// Finish the current problem (solved / dnf)
router.post('/:userId/finish', (req, res) => {
  const userId = getUserIdOr404(req, res);
  if (userId === null) return;
  try {
    const session = getSession(userId);
    if (!session || session.state === 'idle' || !session.problem_name) {
      return res.status(400).json({ error: 'No active session' });
    }
    const { solved } = req.body || {};
    const isSolved = !!solved;
    let difficulty = req.body?.difficulty;
    difficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : session.difficulty;

    const totalMs = totalElapsedMs(session, nowMs());

    db.prepare(`
      INSERT INTO arena_log (user_id, problem_id, problem_name, difficulty, solved, time_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(userId, session.problem_id, session.problem_name, difficulty, isSolved ? 1 : 0, totalMs);

    db.prepare(`UPDATE arena_session SET state='idle', problem_id=NULL, problem_name=NULL, difficulty=NULL, accumulated_ms=0, started_at=NULL, updated_at=datetime('now') WHERE user_id=?`).run(userId);

    const log = db.prepare(`
      SELECT id, problem_id, problem_name, difficulty, solved, time_ms, created_at
      FROM arena_log WHERE user_id = ? ORDER BY id DESC LIMIT 50
    `).all(userId);

    res.json({
      session: { state: 'idle', elapsedMs: 0, problem_id: null, problem_name: null, difficulty: null, startedAt: null, serverTime: nowMs() },
      log: log.map(r => ({ ...r, solved: !!r.solved })),
      stats: computeStats(userId),
    });
  } catch (error) {
    console.error('Error finishing arena:', error.message);
    res.status(500).json({ error: 'Failed to finish session' });
  }
});

// Discard active session without logging
router.post('/:userId/reset', (req, res) => {
  const userId = getUserIdOr404(req, res);
  if (userId === null) return;
  try {
    db.prepare(`UPDATE arena_session SET state='idle', problem_id=NULL, problem_name=NULL, difficulty=NULL, accumulated_ms=0, started_at=NULL, updated_at=datetime('now') WHERE user_id=?`).run(userId);
    res.json({ session: { state: 'idle', elapsedMs: 0, problem_id: null, problem_name: null, difficulty: null, startedAt: null, serverTime: nowMs() } });
  } catch (error) {
    console.error('Error resetting arena:', error.message);
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

// Clear the full log
router.delete('/:userId/log', (req, res) => {
  const userId = getUserIdOr404(req, res);
  if (userId === null) return;
  try {
    db.prepare('DELETE FROM arena_log WHERE user_id = ?').run(userId);
    res.json({ ok: true, stats: computeStats(userId) });
  } catch (error) {
    console.error('Error clearing arena log:', error.message);
    res.status(500).json({ error: 'Failed to clear log' });
  }
});

// Search problem cache for the picker
router.get('/:userId/search', (req, res) => {
  const userId = getUserIdOr404(req, res);
  if (userId === null) return;
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 15, 50);
    let rows;
    if (q) {
      rows = db.prepare(`
        SELECT id, contest_id, problem_index, name, rating, tags
        FROM problems_cache
        WHERE id LIKE ? OR name LIKE ?
        ORDER BY contest_id DESC, problem_index ASC
        LIMIT ?
      `).all(`%${q}%`, `%${q}%`, limit);
    } else {
      rows = db.prepare(`
        SELECT id, contest_id, problem_index, name, rating, tags
        FROM problems_cache
        ORDER BY contest_id DESC, problem_index ASC
        LIMIT ?
      `).all(limit);
    }
    res.json({ problems: rows.map(r => ({ ...r, tags: JSON.parse(r.tags || '[]') })) });
  } catch (error) {
    console.error('Error searching arena problems:', error.message);
    res.status(500).json({ error: 'Failed to search problems' });
  }
});

export default router;
