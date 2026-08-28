import express from 'express';
import db from '../db.js';
import { ensureProblemsCache } from '../problemCache.js';

const router = express.Router();

// Natural Codeforces problem-index ordering: oldest->newest ascending.
// (Descending is achieved by negating the result.)
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

router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const today = new Date().toISOString().split('T')[0];
    let existingAssignment = db.prepare('SELECT * FROM daily_assignments WHERE user_id = ? AND date = ?').get(userId, today);

    // Support force-regenerating today's problems (e.g. when rating level changes)
    if (req.query.force === '1' && existingAssignment) {
      db.prepare('DELETE FROM daily_assignments WHERE user_id = ? AND date = ?').run(userId, today);
      db.prepare('DELETE FROM problem_solve_log WHERE user_id = ? AND assigned_date = ?').run(userId, today);
      existingAssignment = null;
    }

    let assignedProblemIds = [];
    if (existingAssignment) {
      assignedProblemIds = JSON.parse(existingAssignment.problem_ids);
    } else {
      // GENERATE
      const solvedRows = db.prepare('SELECT problem_id FROM solve_history WHERE user_id = ?').all(userId);
      const solvedSet = new Set(solvedRows.map(r => r.problem_id));

      const overdueRows = db.prepare(`
        SELECT problem_id FROM problem_solve_log 
        WHERE user_id = ? AND solved_at IS NULL AND assigned_date < ?
      `).all(userId, today);
      const overdueSet = new Set(overdueRows.map(r => r.problem_id));

      await ensureProblemsCache();

      // Optional ?level=XXXX overrides the saved rating range temporarily
      // (used when the user picks a level chip on the Daily page without
      // changing their saved Settings range). The user row is left untouched.
      let genMin = user.rating_min;
      let genMax = user.rating_max;
      if (req.query.level) {
        const lvl = parseInt(req.query.level, 10);
        if (!isNaN(lvl)) {
          genMin = lvl;
          genMax = lvl;
        }
      }

      let query = 'SELECT * FROM problems_cache WHERE rating >= ? AND rating <= ?';
      const params = [genMin, genMax];

      const selectedTags = JSON.parse(user.selected_tags || '[]');
      if (selectedTags.length > 0) {
        const placeholders = selectedTags.map(() => '?').join(',');
        query = `
          SELECT DISTINCT p.* FROM problems_cache p
          JOIN json_each(p.tags) t
          WHERE p.rating >= ? AND p.rating <= ? AND t.value IN (${placeholders})
        `;
        params.push(...selectedTags);
      }

      query += ' ORDER BY contest_id ASC, problem_index ASC';
      const allMatchingProblems = db.prepare(query).all(...params);
      // Re-sort in JS to pick the NEWEST problems first (highest contest_id /
      // problem_index). Robust against SQLite's lexicographic string ordering.
      allMatchingProblems.sort(cfProblemCompareNewest);

      const candidateProblems = allMatchingProblems.filter(p => !solvedSet.has(p.id) && !overdueSet.has(p.id));

      // Serial selection: take the top N unsolved problems, newest first
      let selected = [];
      if (candidateProblems.length > 0) {
        const targetCount = Math.min(user.daily_target_count || 3, candidateProblems.length);
        selected = candidateProblems.slice(0, targetCount);
      }

      assignedProblemIds = selected.map(p => p.id);

      if (assignedProblemIds.length > 0) {
        db.transaction(() => {
          db.prepare('INSERT OR REPLACE INTO daily_assignments (user_id, date, problem_ids) VALUES (?, ?, ?)').run(userId, today, JSON.stringify(assignedProblemIds));
          
          const insertLogStmt = db.prepare('INSERT OR IGNORE INTO problem_solve_log (user_id, problem_id, assigned_date) VALUES (?, ?, ?)');
          for (const pid of assignedProblemIds) {
            insertLogStmt.run(userId, pid, today);
          }

          db.prepare("UPDATE users SET cursor_problem_id = ?, updated_at = datetime('now') WHERE id = ?").run(assignedProblemIds[assignedProblemIds.length - 1], userId);
        })();
      }
    }

    // Fetch details for today
    const getStatusStmt = db.prepare(`
      SELECT p.*, l.solved_at 
      FROM problems_cache p
      JOIN problem_solve_log l ON p.id = l.problem_id
      WHERE l.user_id = ? AND l.assigned_date = ? AND p.id = ?
    `);
    
    const todayProblems = assignedProblemIds.map(pid => {
      const res = getStatusStmt.get(userId, today, pid);
      if (!res) {
        const fallbackProblem = db.prepare('SELECT * FROM problems_cache WHERE id = ?').get(pid);
        return fallbackProblem ? { ...fallbackProblem, solved_at: null, tags: JSON.parse(fallbackProblem.tags || '[]') } : null;
      }
      let tags = [];
      try {
        tags = JSON.parse(res.tags || '[]');
      } catch (_) {
        tags = [];
      }
      return { ...res, tags };
    }).filter(Boolean);

    // Fetch details for overdue (deduplicated by problem_id)
    const rawOverdue = db.prepare(`
      SELECT p.*, l.solved_at, l.assigned_date
      FROM problems_cache p
      JOIN problem_solve_log l ON p.id = l.problem_id
      WHERE l.user_id = ? AND l.solved_at IS NULL AND l.assigned_date < ?
      GROUP BY p.id
      ORDER BY l.assigned_date DESC
    `).all(userId, today);

    const overdueDetails = rawOverdue.map(p => {
      let tags = [];
      try {
        tags = JSON.parse(p.tags || '[]');
      } catch (_) {
        tags = [];
      }
      return { ...p, tags };
    });

    res.json({
      today: todayProblems,
      overdue: overdueDetails,
      date: today
    });
  } catch (error) {
    console.error('Error generating daily assignment:', error);
    res.status(500).json({ error: error.message || 'Failed to generate daily assignment' });
  }
});

router.get('/:userId/history', (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 30;

    const assignments = db.prepare(`
      SELECT * FROM daily_assignments 
      WHERE user_id = ? 
      ORDER BY date DESC LIMIT ?
    `).all(userId, limit);

    const history = assignments.map(a => {
      const pids = JSON.parse(a.problem_ids);
      const problems = pids.map(pid => {
        const log = db.prepare(`
          SELECT p.*, l.solved_at 
          FROM problem_solve_log l
          JOIN problems_cache p ON l.problem_id = p.id
          WHERE l.user_id = ? AND l.problem_id = ? AND l.assigned_date = ?
        `).get(userId, pid, a.date);
        
        return log ? { ...log, tags: JSON.parse(log.tags || '[]') } : { id: pid, missing: true };
      });
      return { ...a, problem_ids: pids, problems };
    });

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

export default router;
