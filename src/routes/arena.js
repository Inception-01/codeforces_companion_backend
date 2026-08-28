import express from 'express';
import { query, queryOne, execute } from '../db.js';
import { requireAuth, requireOwnership } from '../middleware/auth.js';

const router = express.Router();

// Auto-cancel a session whose owner hasn't touched it within 3 hours.
const INACTIVE_CANCEL_MS = 3 * 60 * 60 * 1000;

function nowMs() {
  return Date.now();
}

async function getSession(userId) {
  return queryOne('SELECT * FROM arena_session WHERE user_id = $1', [userId]);
}

// If the session is not idle and last_active is older than the window, discard it.
async function cancelIfStale(userId) {
  const session = await getSession(userId);
  if (!session || session.state === 'idle') return session;
  const lastActive = session.last_active || session.started_at || 0;
  if (nowMs() - lastActive > INACTIVE_CANCEL_MS) {
    await execute(
      `UPDATE arena_session SET state='idle', problem_id=NULL, problem_name=NULL,
        difficulty=NULL, accumulated_ms=0, started_at=NULL, last_active=$1, updated_at=NOW()
       WHERE user_id=$2`,
      [nowMs(), userId]
    );
    return getSession(userId);
  }
  return session;
}

function totalElapsedMs(session, now) {
  if (!session) return 0;
  let base = Number(session.accumulated_ms) || 0;
  if (session.state === 'running' && session.started_at) {
    base += (now - Number(session.started_at));
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
    startedAt: session.started_at ? Number(session.started_at) : null,
    serverTime: now,
  };
}

const IDLE_SESSION = { state: 'idle', elapsedMs: 0, problem_id: null, problem_name: null, difficulty: null, startedAt: null, serverTime: nowMs() };

async function computeStats(userId) {
  const rows = await query(
    'SELECT solved, time_ms, created_at FROM arena_log WHERE user_id = $1 ORDER BY id ASC',
    [userId]
  );

  const solvedRows = rows.filter(r => r.solved === 1);
  const solved = solvedRows.length;
  const attempted = rows.length;
  const avgMs = solvedRows.length
    ? Math.round(solvedRows.reduce((a, b) => a + Number(b.time_ms), 0) / solvedRows.length)
    : null;
  const fastestMs = solvedRows.length
    ? Math.min(...solvedRows.map(r => Number(r.time_ms)))
    : null;

  // Consecutive days practiced, counting back from today
  const days = new Set(rows.map(r => {
    const d = r.created_at instanceof Date
      ? r.created_at.toISOString().slice(0, 10)
      : String(r.created_at).slice(0, 10);
    return d;
  }));
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

  return { solved, attempted, avgMs, fastestMs, streakDays, totalDays };
}

// Current session + log + stats
router.get('/:userId', requireAuth, requireOwnership, async (req, res) => {
  try {
    const userId = req.user.id;
    await cancelIfStale(userId);
    const session = await getSession(userId);
    const log = await query(
      `SELECT id, problem_id, problem_name, difficulty, solved, time_ms, created_at
       FROM arena_log WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
      [userId]
    );

    res.json({
      session: session ? serializeSession(session) : { ...IDLE_SESSION, serverTime: nowMs() },
      log: log.map(r => ({ ...r, solved: !!r.solved })),
      stats: await computeStats(userId),
    });
  } catch (error) {
    console.error('Error loading arena:', error.message);
    res.status(500).json({ error: 'Failed to load arena' });
  }
});

// Start a session
router.post('/:userId/start', requireAuth, requireOwnership, async (req, res) => {
  try {
    const userId = req.user.id;
    let { problemId, problemName, difficulty } = req.body || {};
    problemId = (problemId || '').trim() || null;
    problemName = (problemName || '').trim() || problemId;
    difficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : null;

    let name = problemName;
    if (problemId) {
      const p = await queryOne(
        'SELECT id, name, contest_id, problem_index FROM problems_cache WHERE id = $1',
        [problemId]
      );
      if (p) name = `${p.contest_id}${p.problem_index} · ${p.name}`;
    }

    const now = nowMs();
    await execute(
      `INSERT INTO arena_session (user_id, problem_id, problem_name, difficulty, state, accumulated_ms, started_at, last_active, updated_at)
       VALUES ($1, $2, $3, $4, 'running', 0, $5, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         problem_id = $2, problem_name = $3, difficulty = $4,
         state = 'running', accumulated_ms = 0, started_at = $5, last_active = $5, updated_at = NOW()`,
      [userId, problemId, name, difficulty, now]
    );

    const session = await getSession(userId);
    res.json({ session: serializeSession(session) });
  } catch (error) {
    console.error('Error starting arena:', error.message);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Toggle pause / resume
router.post('/:userId/pause', requireAuth, requireOwnership, async (req, res) => {
  try {
    const userId = req.user.id;
    const session = await getSession(userId);
    if (!session || session.state === 'idle') {
      return res.json({ session: { ...IDLE_SESSION, serverTime: nowMs() } });
    }
    const now = nowMs();
    if (session.state === 'running') {
      const acc = (Number(session.accumulated_ms) || 0) + (now - (Number(session.started_at) || now));
      await execute(
        `UPDATE arena_session SET state='paused', accumulated_ms=$1, started_at=NULL, last_active=$2, updated_at=NOW() WHERE user_id=$3`,
        [Math.round(acc), now, userId]
      );
    } else {
      await execute(
        `UPDATE arena_session SET state='running', started_at=$1, last_active=$1, updated_at=NOW() WHERE user_id=$2`,
        [now, userId]
      );
    }
    const updated = await getSession(userId);
    res.json({ session: serializeSession(updated) });
  } catch (error) {
    console.error('Error pausing arena:', error.message);
    res.status(500).json({ error: 'Failed to pause session' });
  }
});

// Finish the current problem (solved / dnf)
router.post('/:userId/finish', requireAuth, requireOwnership, async (req, res) => {
  try {
    const userId = req.user.id;
    const session = await getSession(userId);
    if (!session || session.state === 'idle' || !session.problem_name) {
      return res.status(400).json({ error: 'No active session' });
    }
    const { solved } = req.body || {};
    const isSolved = !!solved;
    let difficulty = req.body?.difficulty;
    difficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : session.difficulty;

    const totalMs = totalElapsedMs(session, nowMs());

    await execute(
      `INSERT INTO arena_log (user_id, problem_id, problem_name, difficulty, solved, time_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [userId, session.problem_id, session.problem_name, difficulty, isSolved ? 1 : 0, totalMs]
    );

    await execute(
      `UPDATE arena_session SET state='idle', problem_id=NULL, problem_name=NULL, difficulty=NULL, accumulated_ms=0, started_at=NULL, updated_at=NOW() WHERE user_id=$1`,
      [userId]
    );

    const log = await query(
      `SELECT id, problem_id, problem_name, difficulty, solved, time_ms, created_at
       FROM arena_log WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
      [userId]
    );

    res.json({
      session: { ...IDLE_SESSION, serverTime: nowMs() },
      log: log.map(r => ({ ...r, solved: !!r.solved })),
      stats: await computeStats(userId),
    });
  } catch (error) {
    console.error('Error finishing arena:', error.message);
    res.status(500).json({ error: 'Failed to finish session' });
  }
});

// Discard active session without logging
router.post('/:userId/reset', requireAuth, requireOwnership, async (req, res) => {
  try {
    const userId = req.user.id;
    await execute(
      `UPDATE arena_session SET state='idle', problem_id=NULL, problem_name=NULL, difficulty=NULL, accumulated_ms=0, started_at=NULL, updated_at=NOW() WHERE user_id=$1`,
      [userId]
    );
    res.json({ session: { ...IDLE_SESSION, serverTime: nowMs() } });
  } catch (error) {
    console.error('Error resetting arena:', error.message);
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

// Clear the full log
router.delete('/:userId/log', requireAuth, requireOwnership, async (req, res) => {
  try {
    const userId = req.user.id;
    await execute('DELETE FROM arena_log WHERE user_id = $1', [userId]);
    res.json({ ok: true, stats: await computeStats(userId) });
  } catch (error) {
    console.error('Error clearing arena log:', error.message);
    res.status(500).json({ error: 'Failed to clear log' });
  }
});

// Search problem cache for the picker
router.get('/:userId/search', requireAuth, requireOwnership, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 15, 50);
    let rows;
    if (q) {
      rows = await query(
        `SELECT id, contest_id, problem_index, name, rating, tags
         FROM problems_cache
         WHERE id ILIKE $1 OR name ILIKE $1
         ORDER BY contest_id DESC, problem_index ASC
         LIMIT $2`,
        [`%${q}%`, limit]
      );
    } else {
      rows = await query(
        `SELECT id, contest_id, problem_index, name, rating, tags
         FROM problems_cache
         ORDER BY contest_id DESC, problem_index ASC
         LIMIT $1`,
        [limit]
      );
    }
    res.json({
      problems: rows.map(r => ({
        ...r,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags || []),
      })),
    });
  } catch (error) {
    console.error('Error searching arena problems:', error.message);
    res.status(500).json({ error: 'Failed to search problems' });
  }
});

export default router;
