import { queryOne } from '../db.js';

export async function checkAutoAdvance(userId) {
  const user = await queryOne('SELECT rating_min, rating_max FROM users WHERE id = $1', [userId]);
  if (!user) return { suggest: false };

  const { rating_min, rating_max } = user;

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const result = await queryOne(`
    SELECT
      COUNT(*)::int AS total_assigned,
      COUNT(solved_at)::int AS total_solved
    FROM problem_solve_log
    WHERE user_id = $1 AND assigned_date >= $2
  `, [userId, fourteenDaysAgo.toISOString().split('T')[0]]);

  const totalAssigned = result?.total_assigned || 0;
  const totalSolved = result?.total_solved || 0;

  if (totalAssigned >= 5 && (totalSolved / totalAssigned) >= 0.8) {
    return {
      suggest: true,
      currentMin: rating_min,
      currentMax: rating_max,
      newMin: rating_min + 100,
      newMax: rating_max + 100,
    };
  }

  return { suggest: false };
}
