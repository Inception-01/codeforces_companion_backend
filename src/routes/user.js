import express from 'express';
import { queryOne, execute } from '../db.js';
import { fetchUserInfo } from '../cfApi.js';
import { setUserCookie } from '../utils/cookies.js';
import { requireAuth, requireOwnership } from '../middleware/auth.js';

const router = express.Router();

const formatUser = (user) => {
  if (!user) return null;
  let parsedTags = user.selected_tags || [];
  if (typeof parsedTags === 'string') {
    try { parsedTags = JSON.parse(parsedTags); } catch { parsedTags = []; }
  }
  return { ...user, selected_tags: parsedTags };
};

router.post('/', async (req, res) => {
  try {
    const { handle } = req.body;
    if (!handle || typeof handle !== 'string' || !handle.trim()) {
      return res.status(400).json({ error: 'Valid Codeforces handle is required' });
    }

    const trimmedHandle = handle.trim();

    try {
      await fetchUserInfo(trimmedHandle);
    } catch (cfErr) {
      console.warn(`Handle validation failed for ${trimmedHandle}:`, cfErr.message);
      return res.status(400).json({ error: `Codeforces handle "${trimmedHandle}" was not found or could not be verified.` });
    }

    await execute('INSERT INTO users (handle) VALUES ($1) ON CONFLICT (handle) DO NOTHING', [trimmedHandle]);
    const user = await queryOne('SELECT * FROM users WHERE handle = $1', [trimmedHandle]);

    setUserCookie(res, user);

    res.json(formatUser(user));
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: error.message || 'Failed to create user' });
  }
});

router.get('/:id', requireAuth, requireOwnership, (req, res) => {
  try {
    res.json(formatUser(req.user));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.patch('/:id', requireAuth, requireOwnership, async (req, res) => {
  try {
    const { daily_target_count, rating_min, rating_max, selected_tags, handle } = req.body;
    const userId = req.user.id;

    if (handle && handle !== req.user.handle) {
      try {
        await fetchUserInfo(handle.trim());
      } catch (cfErr) {
        return res.status(400).json({ error: `Codeforces handle "${handle}" was not found or could not be verified.` });
      }
    }

    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (daily_target_count !== undefined) {
      updates.push(`daily_target_count = $${paramIdx++}`);
      params.push(Math.max(1, Math.min(20, parseInt(daily_target_count) || 3)));
    }
    if (rating_min !== undefined) {
      const minVal = parseInt(rating_min) || 0;
      updates.push(`rating_min = $${paramIdx++}`);
      params.push(minVal);
    }
    if (rating_max !== undefined) {
      const maxVal = parseInt(rating_max) || 0;
      updates.push(`rating_max = $${paramIdx++}`);
      params.push(maxVal);
    }
    if (selected_tags !== undefined) {
      updates.push(`selected_tags = $${paramIdx++}`);
      params.push(JSON.stringify(Array.isArray(selected_tags) ? selected_tags : []));
    }
    if (handle !== undefined) {
      updates.push(`handle = $${paramIdx++}`);
      params.push(handle.trim());
    }

    if (updates.length > 0) {
      // Validate rating_min <= rating_max after collecting all updates
      const newMin = rating_min !== undefined ? (parseInt(rating_min) || 0) : req.user.rating_min;
      const newMax = rating_max !== undefined ? (parseInt(rating_max) || 0) : req.user.rating_max;
      if (newMin > newMax) {
        return res.status(400).json({ error: 'rating_min must be <= rating_max' });
      }

      updates.push(`updated_at = NOW()`);
      params.push(userId);
      await execute(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
        params
      );
    }

    const updatedUser = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
    res.json(formatUser(updatedUser));
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: error.message || 'Failed to update user' });
  }
});

export default router;
