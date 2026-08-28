import express from 'express';
import db from '../db.js';
import { fetchUserSubmissions } from '../cfApi.js';
import { ensureProblemsCache } from '../problemCache.js';

const router = express.Router();

router.post('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const submissions = await fetchUserSubmissions(user.handle);
    const accepted = (submissions || []).filter(s => s && s.verdict === 'OK' && s.problem);

    const earliestAccepted = new Map();
    for (const sub of accepted) {
      if (!sub.problem) continue;
      const contestId = sub.problem.contestId;
      const index = sub.problem.index;
      if (!contestId || !index) continue;

      const pid = `${contestId}-${index}`;
      if (!earliestAccepted.has(pid) || sub.creationTimeSeconds < earliestAccepted.get(pid).creationTimeSeconds) {
        earliestAccepted.set(pid, sub);
      }
    }

    let syncedCount = 0;
    const newlySolved = [];

    const getLogStmt = db.prepare('SELECT id, solved_at FROM problem_solve_log WHERE user_id = ? AND problem_id = ? AND solved_at IS NULL');
    const updateLogStmt = db.prepare("UPDATE problem_solve_log SET solved_at = ?, verdict_checked_at = datetime('now') WHERE id = ?");
    const insertHistoryStmt = db.prepare(`
      INSERT OR REPLACE INTO solve_history 
      (user_id, problem_id, solved_at, contest_id, problem_index, problem_name, problem_rating, problem_tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const [pid, sub] of earliestAccepted.entries()) {
        const solvedAt = new Date(sub.creationTimeSeconds * 1000).toISOString();
        
        insertHistoryStmt.run(
          userId,
          pid,
          solvedAt,
          sub.problem.contestId || null,
          sub.problem.index || null,
          sub.problem.name || pid,
          typeof sub.problem.rating === 'number' ? sub.problem.rating : null,
          JSON.stringify(Array.isArray(sub.problem.tags) ? sub.problem.tags : [])
        );
        syncedCount++;

        const logEntries = getLogStmt.all(userId, pid);
        for (const entry of logEntries) {
          updateLogStmt.run(solvedAt, entry.id);
          newlySolved.push(pid);
        }
      }
    })();

    res.json({
      synced: syncedCount,
      newlySolved: [...new Set(newlySolved)]
    });
  } catch (error) {
    console.error('Error syncing submissions:', error);
    res.status(500).json({ error: error.message || 'Failed to sync submissions' });
  }
});

export default router;
