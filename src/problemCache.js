import { query, queryOne, execute, getClient } from './db.js';
import { fetchAllProblems } from './cfApi.js';

export async function ensureProblemsCache(forceRefresh = false) {
  const CACHE_TTL_HOURS = parseFloat(process.env.CACHE_TTL_HOURS || '6');

  const countRow = await queryOne('SELECT COUNT(*)::int AS count FROM problems_cache');
  const existingCount = countRow ? countRow.count : 0;

  if (!forceRefresh && existingCount > 0) {
    const row = await queryOne(
      "SELECT value, updated_at FROM cache_meta WHERE key = 'problems_last_fetched'"
    );
    if (row && row.updated_at) {
      const lastFetched = new Date(row.updated_at);
      const hoursSinceFetch = (Date.now() - lastFetched.getTime()) / (1000 * 60 * 60);
      if (!isNaN(hoursSinceFetch) && hoursSinceFetch < CACHE_TTL_HOURS) {
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

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM problems_cache');

    // Batch insert for performance
    const BATCH_SIZE = 500;
    for (let i = 0; i < problems.length; i += BATCH_SIZE) {
      const batch = problems.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      let paramIndex = 1;

      for (const p of batch) {
        if (!p || p.contestId === undefined || p.contestId === null || !p.index) continue;
        const id = `${p.contestId}-${p.index}`;
        const solvedCount = statsMap.get(id) || 0;
        values.push(
          `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6})`
        );
        params.push(
          id,
          p.contestId,
          String(p.index),
          p.name || id,
          typeof p.rating === 'number' ? p.rating : null,
          JSON.stringify(Array.isArray(p.tags) ? p.tags : []),
          solvedCount,
        );
        paramIndex += 7;
      }

      if (values.length > 0) {
        await client.query(
          `INSERT INTO problems_cache (id, contest_id, problem_index, name, rating, tags, solved_count)
           VALUES ${values.join(', ')}
           ON CONFLICT (id) DO UPDATE SET
             contest_id = EXCLUDED.contest_id,
             problem_index = EXCLUDED.problem_index,
             name = EXCLUDED.name,
             rating = EXCLUDED.rating,
             tags = EXCLUDED.tags,
             solved_count = EXCLUDED.solved_count,
             fetched_at = NOW()`,
          params
        );
      }
    }

    await client.query(
      `INSERT INTO cache_meta (key, value, updated_at)
       VALUES ('problems_last_fetched', 'true', NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const finalRow = await queryOne('SELECT COUNT(*)::int AS count FROM problems_cache');
  const finalCount = finalRow ? finalRow.count : 0;
  console.log(`Successfully cached ${finalCount} problems.`);
  return finalCount;
}
