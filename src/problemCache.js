import db from './db.js';
import { fetchAllProblems } from './cfApi.js';

export async function ensureProblemsCache(forceRefresh = false) {
  const CACHE_TTL_HOURS = parseFloat(process.env.CACHE_TTL_HOURS || '6');

  const countRow = db.prepare('SELECT COUNT(*) as count FROM problems_cache').get();
  const existingCount = countRow ? countRow.count : 0;

  if (!forceRefresh && existingCount > 0) {
    const row = db.prepare(`SELECT value, updated_at FROM cache_meta WHERE key = 'problems_last_fetched'`).get();
    if (row && row.updated_at) {
      const lastFetched = new Date(row.updated_at.replace(' ', 'T') + 'Z');
      const hoursSinceFetch = (Date.now() - (isNaN(lastFetched.getTime()) ? 0 : lastFetched.getTime())) / (1000 * 60 * 60);
      if (hoursSinceFetch < CACHE_TTL_HOURS) {
        return existingCount;
      }
    }
  }

  console.log('Fetching problems from Codeforces...');
  let problemsData;
  try {
    problemsData = await fetchAllProblems();
  } catch (err) {
    console.error('Failed to fetch problems from Codeforces API:', err.message);
    if (existingCount > 0) {
      console.log(`Using existing cached problems (${existingCount} problems in DB)`);
      return existingCount;
    }
    throw err;
  }

  const { problems, problemStatistics } = problemsData;
  if (!problems || !Array.isArray(problems)) {
    if (existingCount > 0) return existingCount;
    throw new Error('Invalid problem data received from Codeforces');
  }

  const statsMap = new Map();
  if (Array.isArray(problemStatistics)) {
    for (const stat of problemStatistics) {
      if (stat && stat.contestId !== undefined && stat.index) {
        statsMap.set(`${stat.contestId}-${stat.index}`, stat.solvedCount || 0);
      }
    }
  }

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO problems_cache (id, contest_id, problem_index, name, rating, tags, solved_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM problems_cache').run();

    for (const p of problems) {
      if (!p || p.contestId === undefined || p.contestId === null || !p.index) continue;
      const id = `${p.contestId}-${p.index}`;
      const solvedCount = statsMap.get(id) || 0;
      insertStmt.run(
        id,
        p.contestId,
        String(p.index),
        p.name || id,
        typeof p.rating === 'number' ? p.rating : null,
        JSON.stringify(Array.isArray(p.tags) ? p.tags : []),
        solvedCount
      );
    }

    db.prepare(`
      INSERT OR REPLACE INTO cache_meta (key, value, updated_at) 
      VALUES ('problems_last_fetched', 'true', datetime('now'))
    `).run();
  });

  tx();

  const finalCount = db.prepare('SELECT COUNT(*) as count FROM problems_cache').get().count;
  console.log(`Successfully cached ${finalCount} problems.`);
  return finalCount;
}
