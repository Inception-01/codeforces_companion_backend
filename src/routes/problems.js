import express from 'express';
import { query, queryOne, execute } from '../db.js';
import { ensureProblemsCache } from '../problemCache.js';
import { requireAuth, requireOwnership } from '../middleware/auth.js';

const router = express.Router();

const MAX_LIMIT = 200;

router.get('/', async (req, res) => {
  try {
    await ensureProblemsCache();

    let { ratingMin, ratingMax, tags, page, limit, order, userId } = req.query;

    page = parseInt(page) || 1;
    limit = Math.min(parseInt(limit) || 50, MAX_LIMIT);
    order = order === 'desc' ? 'DESC' : 'ASC';
    const offset = (page - 1) * limit;

    const userIdParam = userId ? parseInt(userId) : null;

    let selectCols = 'p.*';
    let fromClause = 'FROM problems_cache p';
    let whereConditions = ['1=1'];
    let countWhereConditions = ['1=1'];
    const params = [];
    const countParams = [];
    let paramIdx = 1;
    let countParamIdx = 1;

    if (userIdParam) {
      selectCols += ', CASE WHEN sh.id IS NULL THEN 0 ELSE 1 END AS solved';
      fromClause += ` LEFT JOIN solve_history sh ON sh.problem_id = p.id AND sh.user_id = $${paramIdx}`;
      params.push(userIdParam);
      paramIdx++;
    }

    if (ratingMin) {
      whereConditions.push(`p.rating >= $${paramIdx}`);
      countWhereConditions.push(`rating >= $${countParamIdx}`);
      params.push(parseInt(ratingMin));
      countParams.push(parseInt(ratingMin));
      paramIdx++;
      countParamIdx++;
    }

    if (ratingMax) {
      whereConditions.push(`p.rating <= $${paramIdx}`);
      countWhereConditions.push(`rating <= $${countParamIdx}`);
      params.push(parseInt(ratingMax));
      countParams.push(parseInt(ratingMax));
      paramIdx++;
      countParamIdx++;
    }

    if (tags) {
      const tagsArray = Array.isArray(tags)
        ? tags.flatMap(t => String(t).split(',')).map(t => t.trim()).filter(Boolean)
        : String(tags).split(',').map(t => t.trim()).filter(Boolean);

      if (tagsArray.length > 0) {
        // Use JSONB containment: check if p.tags contains ANY of the requested tags
        const tagConditions = tagsArray.map(t => {
          params.push(JSON.stringify([t]));
          countParams.push(JSON.stringify([t]));
          const pIdx = paramIdx++;
          countParamIdx++;
          return `p.tags @> $${pIdx}::jsonb`;
        });
        const countTagConditions = tagsArray.map((t, i) => {
          return `tags @> $${countParamIdx - tagsArray.length + i}::jsonb`;
        });
        whereConditions.push(`(${tagConditions.join(' OR ')})`);
        countWhereConditions.push(`(${countTagConditions.join(' OR ')})`);
      }
    }

    const whereClause = whereConditions.join(' AND ');
    const countWhereClause = countWhereConditions.join(' AND ');

    const dataQuery = `SELECT ${selectCols} ${fromClause} WHERE ${whereClause} ORDER BY p.contest_id ${order}, p.problem_index ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(limit, offset);

    const countQuery = `SELECT COUNT(*)::int AS total FROM problems_cache WHERE ${countWhereClause}`;

    const [problems, countResult] = await Promise.all([
      query(dataQuery, params),
      queryOne(countQuery, countParams),
    ]);

    res.json({
      problems: problems.map(p => ({
        ...p,
        tags: typeof p.tags === 'string' ? JSON.parse(p.tags) : (p.tags || []),
      })),
      total: countResult?.total || 0,
      page,
      limit,
    });
  } catch (error) {
    console.error('Error fetching problems:', error);
    res.status(500).json({ error: 'Failed to fetch problems' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const count = await ensureProblemsCache(true);
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to refresh problems' });
  }
});

router.post('/:id/status', requireAuth, requireOwnership, async (req, res) => {
  try {
    const { id } = req.params;
    const { solved } = req.body;
    const user = req.user;

    if (solved) {
      const problem = await queryOne('SELECT * FROM problems_cache WHERE id = $1', [id]);
      if (!problem) {
        return res.status(404).json({ error: 'Problem not found' });
      }
      await execute(
        `INSERT INTO solve_history
         (user_id, problem_id, solved_at, contest_id, problem_index, problem_name, problem_rating, problem_tags)
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, problem_id) DO UPDATE SET solved_at = NOW()`,
        [
          user.id,
          id,
          problem.contest_id || null,
          problem.problem_index || null,
          problem.name || id,
          typeof problem.rating === 'number' ? problem.rating : null,
          JSON.stringify(typeof problem.tags === 'string' ? JSON.parse(problem.tags) : (problem.tags || [])),
        ]
      );
    } else {
      await execute('DELETE FROM solve_history WHERE user_id = $1 AND problem_id = $2', [user.id, id]);
    }

    res.json({ id, solved: solved ? 1 : 0 });
  } catch (error) {
    console.error('Error updating problem status:', error);
    res.status(500).json({ error: 'Failed to update problem status' });
  }
});

export default router;
