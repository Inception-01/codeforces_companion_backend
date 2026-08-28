import express from 'express';
import { cfFetch } from '../cfApi.js';

const router = express.Router();

function mapContest(c) {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    phase: c.phase,
    durationSeconds: c.durationSeconds,
    startTimeSeconds: c.startTimeSeconds,
    relativeTimeSeconds: c.relativeTimeSeconds,
    url: `https://codeforces.com/contest/${c.id}`,
  };
}

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 300);
    const result = await cfFetch('contest.list', { gym: false });

    const now = Math.floor(Date.now() / 1000);
    const all = (Array.isArray(result) ? result : []).map(mapContest);

    const upcoming = all
      .filter(c => c.phase === 'BEFORE')
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)
      .slice(0, limit);

    const past = all
      .filter(c => c.phase === 'FINISHED')
      .sort((a, b) => b.startTimeSeconds - a.startTimeSeconds)
      .slice(0, limit);

    res.json({ upcoming, past, serverTime: now * 1000 });
  } catch (error) {
    console.error('Error fetching contests:', error.message);
    res.status(500).json({ error: 'Failed to fetch contests' });
  }
});

export default router;
