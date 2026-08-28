import express from 'express';
import { query } from '../db.js';
import { requireAuth, requireOwnership } from '../middleware/auth.js';

const router = express.Router();

// Sanitize handle for Content-Disposition header
function sanitizeFilename(str) {
  return String(str).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
}

router.get('/:userId', requireAuth, requireOwnership, async (req, res) => {
  try {
    const userId = req.user.id;
    const { format = 'json' } = req.query;

    const history = await query(
      'SELECT * FROM solve_history WHERE user_id = $1 ORDER BY solved_at ASC',
      [userId]
    );

    const safeHandle = sanitizeFilename(req.user.handle);

    if (format === 'csv') {
      let csv = 'date,problem_id,name,rating,tags\n';
      for (const h of history) {
        const date = h.solved_at instanceof Date
          ? h.solved_at.toISOString().split('T')[0]
          : String(h.solved_at).split('T')[0];
        const tags = (typeof h.problem_tags === 'string'
          ? JSON.parse(h.problem_tags)
          : (h.problem_tags || [])
        ).join(';');
        const name = String(h.problem_name || '').replace(/"/g, '""');
        csv += `${date},${h.problem_id},"${name}",${h.problem_rating || ''},"${tags}"\n`;
      }
      res.header('Content-Type', 'text/csv');
      res.header('Content-Disposition', `attachment; filename="cf_grind_export_${safeHandle}.csv"`);
      return res.send(csv);
    } else {
      res.header('Content-Type', 'application/json');
      res.header('Content-Disposition', `attachment; filename="cf_grind_export_${safeHandle}.json"`);
      return res.json(history);
    }
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

export default router;
