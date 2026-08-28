import express from 'express';
import { query, queryOne } from '../db.js';
import { calculateStreaks } from '../utils/streaks.js';
import { checkAutoAdvance } from '../utils/autoAdvance.js';
import { requireAuth, requireOwnership } from '../middleware/auth.js';

const router = express.Router();

function formatLocalDate(dateVal, tz) {
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  if (isNaN(d.getTime())) return null;

  if (tz) {
    try {
      // en-CA formats as YYYY-MM-DD
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return formatter.format(d);
    } catch (_) {}
  }
  return d.toISOString().split('T')[0];
}

router.get('/:userId', requireAuth, requireOwnership, async (req, res) => {
  try {
    const userId = req.user.id;
    const tz = req.query.tz || null;

    const history = await query('SELECT * FROM solve_history WHERE user_id = $1 ORDER BY solved_at ASC', [userId]);

    // 1. Heatmap — format dates with timezone awareness
    const heatmap = {};
    const dates = [];
    for (const h of history) {
      const d = formatLocalDate(h.solved_at, tz);
      if (d) {
        heatmap[d] = (heatmap[d] || 0) + 1;
        dates.push(d);
      }
    }

    // 2. Streaks
    const rawStreaks = calculateStreaks(dates);
    const totalSolves = history.length;
    const streaks = {
      current: rawStreaks.currentStreak,
      longest: rawStreaks.longestStreak,
      average: rawStreaks.totalActiveDays > 0 ? +(totalSolves / rawStreaks.totalActiveDays).toFixed(1) : 0,
      currentStreak: rawStreaks.currentStreak,
      longestStreak: rawStreaks.longestStreak,
      totalActiveDays: rawStreaks.totalActiveDays,
    };

    // 3. Daily Completion
    const assignments = await query('SELECT * FROM daily_assignments WHERE user_id = $1', [userId]);
    let days_fully_met = 0;
    let days_partially_met = 0;
    let days_missed = 0;

    for (const a of assignments) {
      const pids = typeof a.problem_ids === 'string'
        ? JSON.parse(a.problem_ids)
        : (a.problem_ids || []);
      if (pids.length === 0) continue;

      const logs = await query(
        'SELECT solved_at FROM problem_solve_log WHERE user_id = $1 AND assigned_date = $2',
        [userId, a.date]
      );

      const solvedCount = logs.filter(l => l.solved_at !== null).length;
      if (solvedCount === 0) {
        days_missed++;
      } else if (solvedCount === logs.length && logs.length > 0) {
        days_fully_met++;
      } else {
        days_partially_met++;
      }
    }

    const dailyCompletion = {
      met: days_fully_met,
      partial: days_partially_met,
      missed: days_missed,
      days_fully_met,
      days_partially_met,
      days_missed,
    };

    // 4. Rating Distribution
    const ratingDistribution = {
      '<1200': 0, '1200-1399': 0, '1400-1599': 0, '1600-1899': 0,
      '1900-2099': 0, '2100-2399': 0, '2400+': 0, 'unrated': 0,
    };
    for (const h of history) {
      const r = h.problem_rating;
      if (r === null || r === undefined) ratingDistribution['unrated']++;
      else if (r < 1200) ratingDistribution['<1200']++;
      else if (r < 1400) ratingDistribution['1200-1399']++;
      else if (r < 1600) ratingDistribution['1400-1599']++;
      else if (r < 1900) ratingDistribution['1600-1899']++;
      else if (r < 2100) ratingDistribution['1900-2099']++;
      else if (r < 2400) ratingDistribution['2100-2399']++;
      else ratingDistribution['2400+']++;
    }

    // 5. Tag Breakdown
    const tagBreakdown = {};
    for (const h of history) {
      const tags = typeof h.problem_tags === 'string'
        ? JSON.parse(h.problem_tags)
        : (h.problem_tags || []);
      for (const t of tags) {
        tagBreakdown[t] = (tagBreakdown[t] || 0) + 1;
      }
    }

    // 6. Auto Advance
    const rawAutoAdvance = await checkAutoAdvance(userId);
    const autoAdvance = rawAutoAdvance.suggest ? {
      suggest: true,
      min: rawAutoAdvance.newMin,
      max: rawAutoAdvance.newMax,
      currentMin: rawAutoAdvance.currentMin,
      currentMax: rawAutoAdvance.currentMax,
      newMin: rawAutoAdvance.newMin,
      newMax: rawAutoAdvance.newMax,
    } : null;

    res.json({
      heatmap,
      streaks,
      dailyCompletion,
      ratingDistribution,
      tagBreakdown,
      autoAdvance,
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
