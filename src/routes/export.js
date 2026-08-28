import express from 'express';
import db from '../db.js';

const router = express.Router();

router.get('/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const { format = 'json' } = req.query;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const history = db.prepare('SELECT * FROM solve_history WHERE user_id = ? ORDER BY solved_at ASC').all(userId);

    if (format === 'csv') {
      let csv = 'date,problem_id,name,rating,tags\n';
      for (const h of history) {
        const date = h.solved_at.split('T')[0];
        const tags = JSON.parse(h.problem_tags || '[]').join(';');
        csv += `${date},${h.problem_id},"${h.problem_name.replace(/"/g, '""')}",${h.problem_rating || ''},"${tags}"\n`;
      }
      res.header('Content-Type', 'text/csv');
      res.header('Content-Disposition', `attachment; filename="cf_grind_export_${user.handle}.csv"`);
      return res.send(csv);
    } else {
      res.header('Content-Type', 'application/json');
      res.header('Content-Disposition', `attachment; filename="cf_grind_export_${user.handle}.json"`);
      return res.json(history);
    }
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

export default router;
