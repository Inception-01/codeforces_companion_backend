import express from 'express';
import db from '../db.js';
import { cfFetch, fetchUserInfo } from '../cfApi.js';

const router = express.Router();

async function fetchRatingChanges(handle) {
  const result = await cfFetch('user.rating', { handle });
  return Array.isArray(result) ? result : [];
}

router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const totalSolved = db.prepare('SELECT COUNT(*) as c FROM solve_history WHERE user_id = ?').get(userId).c;

    let info = null;
    let ratingHistory = [];
    try {
      info = await fetchUserInfo(user.handle);
    } catch (err) {
      console.warn(`Failed to fetch user info for ${user.handle}:`, err.message);
    }

    let rating = null;
    let maxRating = null;
    if (info) {
      rating = info.rating ?? null;
      maxRating = info.maxRating ?? null;
    }

    try {
      const changes = await fetchRatingChanges(user.handle);
      ratingHistory = changes.map(c => ({
        rating: c.newRating,
        oldRating: c.oldRating,
        contestName: c.contestName,
        rank: c.rank,
        time: c.ratingUpdateTimeSeconds * 1000
      }));
    } catch (err) {
      console.warn(`Failed to fetch rating changes for ${user.handle}:`, err.message);
    }

    res.json({
      handle: user.handle,
      totalSolved,
      rating,
      maxRating,
      ratingHistory
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

export default router;
