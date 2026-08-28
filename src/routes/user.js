import express from 'express';
import db from '../db.js';
import { fetchUserInfo } from '../cfApi.js';
import { setUserCookie } from './auth.js';

const router = express.Router();

const formatUser = (user) => {
  if (!user) return null;
  let parsedTags = [];
  try {
    parsedTags = typeof user.selected_tags === 'string' ? JSON.parse(user.selected_tags || '[]') : (user.selected_tags || []);
  } catch (_) {
    parsedTags = [];
  }
  return {
    ...user,
    selected_tags: parsedTags
  };
};

router.post('/', async (req, res) => {
  try {
    const { handle } = req.body;
    if (!handle || typeof handle !== 'string' || !handle.trim()) {
      return res.status(400).json({ error: 'Valid Codeforces handle is required' });
    }

    const trimmedHandle = handle.trim();

    // Validate handle with Codeforces
    try {
      await fetchUserInfo(trimmedHandle);
    } catch (cfErr) {
      console.warn(`Handle validation failed for ${trimmedHandle}:`, cfErr.message);
      return res.status(400).json({ error: `Codeforces handle "${trimmedHandle}" was not found or could not be verified.` });
    }

    db.prepare('INSERT OR IGNORE INTO users (handle) VALUES (?)').run(trimmedHandle);
    const user = db.prepare('SELECT * FROM users WHERE handle = ?').get(trimmedHandle);

    setUserCookie(res, user);

    res.json(formatUser(user));
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: error.message || 'Failed to create user' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(formatUser(user));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { daily_target_count, rating_min, rating_max, selected_tags, handle } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (handle && handle !== user.handle) {
      try {
        await fetchUserInfo(handle.trim());
      } catch (cfErr) {
        return res.status(400).json({ error: `Codeforces handle "${handle}" was not found or could not be verified.` });
      }
    }

    const updates = [];
    const params = [];

    if (daily_target_count !== undefined) {
      updates.push('daily_target_count = ?');
      params.push(Math.max(1, Math.min(20, parseInt(daily_target_count) || 3)));
    }
    if (rating_min !== undefined) {
      updates.push('rating_min = ?');
      params.push(parseInt(rating_min) || 0);
    }
    if (rating_max !== undefined) {
      updates.push('rating_max = ?');
      params.push(parseInt(rating_max) || 0);
    }
    if (selected_tags !== undefined) {
      updates.push('selected_tags = ?');
      params.push(typeof selected_tags === 'string' ? selected_tags : JSON.stringify(selected_tags));
    }
    if (handle !== undefined) {
      updates.push('handle = ?');
      params.push(handle.trim());
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.json(formatUser(updatedUser));
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: error.message || 'Failed to update user' });
  }
});

export default router;
