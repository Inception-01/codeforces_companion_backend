export function checkAutoAdvance(db, userId) {
  const user = db.prepare('SELECT rating_min, rating_max FROM users WHERE id = ?').get(userId);
  if (!user) return { suggest: false };

  const { rating_min, rating_max } = user;

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const dateStr = fourteenDaysAgo.toISOString().split('T')[0];

  const assignments = db.prepare(`
    SELECT count(*) as total_assigned,
           sum(case when solved_at is not null then 1 else 0 end) as total_solved
    FROM problem_solve_log
    WHERE user_id = ? AND assigned_date >= ?
  `).get(userId, dateStr);

  const totalAssigned = assignments.total_assigned || 0;
  const totalSolved = assignments.total_solved || 0;

  if (totalAssigned >= 5 && (totalSolved / totalAssigned) >= 0.8) {
    return {
      suggest: true,
      currentMin: rating_min,
      currentMax: rating_max,
      newMin: rating_min + 100,
      newMax: rating_max + 100
    };
  }

  return { suggest: false };
}
