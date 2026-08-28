import express from 'express';
import { query, queryOne, execute, getClient } from '../db.js';
import { ensureProblemsCache } from '../problemCache.js';
import { requireAuth, requireOwnership } from '../middleware/auth.js';

const router = express.Router();

// Natural Codeforces problem-index ordering helper for JS sort
function cfIndexKey(index) {
  const m = String(index || '').match(/^([A-Z]+)(\d*)$/);
  let letterVal = 0;
  if (m) {
    for (const ch of m[1]) letterVal = letterVal * 26 + (ch.charCodeAt(0) - 64);
  }
  const numVal = m && m[2] ? parseInt(m[2], 10) : 0;
  return letterVal * 1000 + numVal;
}

// Newest-first: descending by contest_id, then descending by problem index
function cfProblemCompareNewest(a, b) {
  if (+a.contest_id !== +b.contest_id) return +b.contest_id - +a.contest_id;
  return cfIndexKey(b.problem_index) - cfIndexKey(a.problem_index);
}

router.get('/:userId', requireAuth, requireOwnership, async (req, res) => {
  try {
    const user = req.user;
    const userId = user.id;

    const today = new Date().toISOString().split('T')[0];
    let existingAssignment = await queryOne(
      'SELECT * FROM daily_assignments WHERE user_id = $1 AND date = $2',
      [userId, today]
    );

    // Support force-regenerating today's problems
    if (req.query.force === '1' && existingAssignment) {
      await execute('DELETE FROM daily_assignments WHERE user_id = $1 AND date = $2', [userId, today]);
      await execute('DELETE FROM problem_solve_log WHERE user_id = $1 AND assigned_date = $2', [userId, today]);
      existingAssignment = null;
    }

    let assignedProblemIds = [];
    if (existingAssignment) {
      assignedProblemIds = typeof existingAssignment.problem_ids === 'string'
        ? JSON.parse(existingAssignment.problem_ids)
        : (existingAssignment.problem_ids || []);
    } else {
      // GENERATE
      const solvedRows = await query('SELECT problem_id FROM solve_history WHERE user_id = $1', [userId]);
      const solvedSet = new Set(solvedRows.map(r => r.problem_id));

      const overdueRows = await query(
        'SELECT problem_id FROM problem_solve_log WHERE user_id = $1 AND solved_at IS NULL AND assigned_date < $2',
        [userId, today]
      );
      const overdueSet = new Set(overdueRows.map(r => r.problem_id));

      await ensureProblemsCache();

      // Optional ?level=XXXX overrides the saved rating range temporarily
      let genMin = user.rating_min;
      let genMax = user.rating_max;
      if (req.query.level) {
        const lvl = parseInt(req.query.level, 10);
        if (!isNaN(lvl)) {
          genMin = lvl;
          genMax = lvl;
        }
      }

      const selectedTags = Array.isArray(user.selected_tags) ? user.selected_tags : [];

      let allMatchingProblems;
      if (selectedTags.length > 0) {
        // Build tag filter conditions
        const tagConditions = selectedTags.map((t, i) => `p.tags @> $${i + 3}::jsonb`);
        const tagParams = selectedTags.map(t => JSON.stringify([t]));
        allMatchingProblems = await query(
          `SELECT DISTINCT p.* FROM problems_cache p
           WHERE p.rating >= $1 AND p.rating <= $2 AND (${tagConditions.join(' OR ')})
           ORDER BY p.contest_id ASC, p.problem_index ASC`,
          [genMin, genMax, ...tagParams]
        );
      } else {
        allMatchingProblems = await query(
          'SELECT * FROM problems_cache WHERE rating >= $1 AND rating <= $2 ORDER BY contest_id ASC, problem_index ASC',
          [genMin, genMax]
        );
      }

      // Re-sort in JS for newest-first selection
      allMatchingProblems.sort(cfProblemCompareNewest);

      const candidateProblems = allMatchingProblems.filter(p => !solvedSet.has(p.id) && !overdueSet.has(p.id));

      let selected = [];
      if (candidateProblems.length > 0) {
        const targetCount = Math.min(user.daily_target_count || 3, candidateProblems.length);
        selected = candidateProblems.slice(0, targetCount);
      }

      assignedProblemIds = selected.map(p => p.id);

      if (assignedProblemIds.length > 0) {
        const client = await getClient();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO daily_assignments (user_id, date, problem_ids)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, date) DO UPDATE SET problem_ids = $3`,
            [userId, today, JSON.stringify(assignedProblemIds)]
          );

          for (const pid of assignedProblemIds) {
            await client.query(
              `INSERT INTO problem_solve_log (user_id, problem_id, assigned_date)
               VALUES ($1, $2, $3)
               ON CONFLICT (user_id, problem_id, assigned_date) DO NOTHING`,
              [userId, pid, today]
            );
          }

          await client.query(
            'UPDATE users SET cursor_problem_id = $1, updated_at = NOW() WHERE id = $2',
            [assignedProblemIds[assignedProblemIds.length - 1], userId]
          );

          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      }
    }

    // Fetch details for today
    const todayProblems = [];
    for (const pid of assignedProblemIds) {
      let row = await queryOne(
        `SELECT p.*, l.solved_at
         FROM problems_cache p
         JOIN problem_solve_log l ON p.id = l.problem_id
         WHERE l.user_id = $1 AND l.assigned_date = $2 AND p.id = $3`,
        [userId, today, pid]
      );
      if (!row) {
        row = await queryOne('SELECT * FROM problems_cache WHERE id = $1', [pid]);
        if (row) row.solved_at = null;
      }
      if (row) {
        row.tags = typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags || []);
        todayProblems.push(row);
      }
    }

    // Fetch overdue (deduplicated by problem_id)
    const rawOverdue = await query(
      `SELECT DISTINCT ON (p.id) p.*, l.solved_at, l.assigned_date
       FROM problems_cache p
       JOIN problem_solve_log l ON p.id = l.problem_id
       WHERE l.user_id = $1 AND l.solved_at IS NULL AND l.assigned_date < $2
       ORDER BY p.id, l.assigned_date DESC`,
      [userId, today]
    );

    const overdueDetails = rawOverdue.map(p => ({
      ...p,
      tags: typeof p.tags === 'string' ? JSON.parse(p.tags) : (p.tags || []),
    }));

    res.json({
      today: todayProblems,
      overdue: overdueDetails,
      date: today,
    });
  } catch (error) {
    console.error('Error generating daily assignment:', error);
    res.status(500).json({ error: error.message || 'Failed to generate daily assignment' });
  }
});

router.get('/:userId/history', requireAuth, requireOwnership, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);

    const assignments = await query(
      'SELECT * FROM daily_assignments WHERE user_id = $1 ORDER BY date DESC LIMIT $2',
      [userId, limit]
    );

    const history = [];
    for (const a of assignments) {
      const pids = typeof a.problem_ids === 'string' ? JSON.parse(a.problem_ids) : (a.problem_ids || []);
      const problems = [];
      for (const pid of pids) {
        const log = await queryOne(
          `SELECT p.*, l.solved_at
           FROM problem_solve_log l
           JOIN problems_cache p ON l.problem_id = p.id
           WHERE l.user_id = $1 AND l.problem_id = $2 AND l.assigned_date = $3`,
          [userId, pid, a.date]
        );
        if (log) {
          log.tags = typeof log.tags === 'string' ? JSON.parse(log.tags) : (log.tags || []);
          problems.push(log);
        } else {
          problems.push({ id: pid, missing: true });
        }
      }
      history.push({ ...a, problem_ids: pids, problems });
    }

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

export default router;
