import express from 'express';
import { query, queryOne, execute, getClient } from '../db.js';
import { fetchUserSubmissions } from '../cfApi.js';
import { requireAuth, requireOwnership } from '../middleware/auth.js';

const router = express.Router();

router.post('/:userId', requireAuth, requireOwnership, async (req, res) => {
  try {
    const user = req.user;
    const userId = user.id;

    // Fetch submissions from Codeforces API
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

    const client = await getClient();
    try {
      await client.query('BEGIN');

      for (const [pid, sub] of earliestAccepted.entries()) {
        const solvedAt = new Date(sub.creationTimeSeconds * 1000).toISOString();

        let rating = typeof sub.problem.rating === 'number' ? sub.problem.rating : null;
        let tags = Array.isArray(sub.problem.tags) ? sub.problem.tags : [];
        let name = sub.problem.name || pid;

        // If rating or tags are missing on the submission, enrich from local problem catalog
        const cached = await client.query(
          'SELECT name, rating, tags FROM problems_cache WHERE id = $1',
          [pid]
        );
        if (cached.rows.length > 0) {
          const cp = cached.rows[0];
          if (rating === null && typeof cp.rating === 'number') rating = cp.rating;
          if (tags.length === 0 && cp.tags) {
            tags = typeof cp.tags === 'string' ? JSON.parse(cp.tags) : cp.tags;
          }
          if (name === pid && cp.name) name = cp.name;
        }

        await client.query(
          `INSERT INTO solve_history
           (user_id, problem_id, solved_at, contest_id, problem_index, problem_name, problem_rating, problem_tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (user_id, problem_id) DO UPDATE SET
             solved_at = LEAST(solve_history.solved_at, EXCLUDED.solved_at),
             problem_rating = COALESCE(solve_history.problem_rating, EXCLUDED.problem_rating),
             problem_tags = CASE WHEN solve_history.problem_tags = '[]'::jsonb THEN EXCLUDED.problem_tags ELSE solve_history.problem_tags END,
             problem_name = COALESCE(solve_history.problem_name, EXCLUDED.problem_name)`,
          [
            userId,
            pid,
            solvedAt,
            sub.problem.contestId || null,
            sub.problem.index || null,
            name,
            rating,
            JSON.stringify(tags),
          ]
        );
        syncedCount++;

        // Update unsolved log entries
        const logEntries = await client.query(
          'SELECT id FROM problem_solve_log WHERE user_id = $1 AND problem_id = $2 AND solved_at IS NULL',
          [userId, pid]
        );
        for (const entry of logEntries.rows) {
          await client.query(
            'UPDATE problem_solve_log SET solved_at = $1, verdict_checked_at = NOW() WHERE id = $2',
            [solvedAt, entry.id]
          );
          newlySolved.push(pid);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({
      synced: syncedCount,
      newlySolved: [...new Set(newlySolved)],
    });
  } catch (error) {
    console.error('Error syncing submissions:', error);
    res.status(500).json({ error: error.message || 'Failed to sync submissions' });
  }
});

export default router;
