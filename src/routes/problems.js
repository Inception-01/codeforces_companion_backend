import express from 'express';
import db from '../db.js';
import { ensureProblemsCache } from '../problemCache.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    await ensureProblemsCache();

    let { ratingMin, ratingMax, tags, page, limit, order, userId } = req.query;
    
    page = parseInt(page) || 1;
    limit = parseInt(limit) || 50;
    order = order === 'desc' ? 'DESC' : 'ASC';
    const offset = (page - 1) * limit;

    const userIdParam = userId ? parseInt(userId) : null;

    let query = 'SELECT p.*, CASE WHEN sh.id IS NULL THEN 0 ELSE 1 END as solved FROM problems_cache p';
    let countQuery = 'SELECT COUNT(*) as total FROM problems_cache WHERE 1=1';

    if (userIdParam) {
      query += ' LEFT JOIN solve_history sh ON sh.problem_id = p.id AND sh.user_id = ?';
    }
    query += ' WHERE 1=1';

    const params = [];
    const countParams = [];
    if (userIdParam) params.push(userIdParam);

    if (ratingMin) {
      query += ' AND p.rating >= ?';
      countQuery += ' AND rating >= ?';
      params.push(parseInt(ratingMin));
      countParams.push(parseInt(ratingMin));
    }
    
    if (ratingMax) {
      query += ' AND p.rating <= ?';
      countQuery += ' AND rating <= ?';
      params.push(parseInt(ratingMax));
      countParams.push(parseInt(ratingMax));
    }
    
    if (tags) {
      const tagsArray = Array.isArray(tags) 
        ? tags.flatMap(t => String(t).split(',')).map(t => t.trim()).filter(Boolean)
        : String(tags).split(',').map(t => t.trim()).filter(Boolean);
      
      if (tagsArray.length > 0) {
        const tagPlaceholders = tagsArray.map(() => '?').join(',');
        query += ` AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value IN (${tagPlaceholders}))`;
        countQuery += ` AND EXISTS (SELECT 1 FROM json_each(problems_cache.tags) WHERE value IN (${tagPlaceholders}))`;
        params.push(...tagsArray);
        countParams.push(...tagsArray);
      }
    }

    query += ` ORDER BY p.contest_id ${order}, p.problem_index ASC LIMIT ? OFFSET ?`;
    const dataParams = [...params, limit, offset];

    const problems = db.prepare(query).all(...dataParams);
    const { total } = db.prepare(countQuery).get(...countParams);

    res.json({
      problems: problems.map(p => ({ ...p, tags: JSON.parse(p.tags) })),
      total,
      page,
      limit
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

router.post('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, solved } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (solved) {
      const problem = db.prepare('SELECT * FROM problems_cache WHERE id = ?').get(id);
      if (!problem) {
        return res.status(404).json({ error: 'Problem not found' });
      }
      db.prepare(`
        INSERT OR REPLACE INTO solve_history
        (user_id, problem_id, solved_at, contest_id, problem_index, problem_name, problem_rating, problem_tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        id,
        new Date().toISOString(),
        problem.contest_id || null,
        problem.problem_index || null,
        problem.name || id,
        typeof problem.rating === 'number' ? problem.rating : null,
        problem.tags || '[]'
      );
    } else {
      db.prepare('DELETE FROM solve_history WHERE user_id = ? AND problem_id = ?').run(userId, id);
    }

    res.json({ id, solved: !!solved ? 1 : 0 });
  } catch (error) {
    console.error('Error updating problem status:', error);
    res.status(500).json({ error: 'Failed to update problem status' });
  }
});

export default router;
