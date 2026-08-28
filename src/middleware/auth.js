import { queryOne } from '../db.js';
import { COOKIE_UID } from '../utils/cookies.js';

export async function requireAuth(req, res, next) {
  try {
    const uid = req.cookies?.[COOKIE_UID] || req.headers['x-user-id'];
    if (!uid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = $1', [uid]);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // selected_tags is JSONB — already parsed by pg driver
    if (typeof user.selected_tags === 'string') {
      try {
        user.selected_tags = JSON.parse(user.selected_tags);
      } catch {
        user.selected_tags = [];
      }
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function requireOwnership(req, res, next) {
  const paramUserId = parseInt(req.params.userId || req.params.id, 10);
  if (isNaN(paramUserId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  if (req.user.id !== paramUserId) {
    return res.status(403).json({ error: 'Forbidden: cannot access another user\'s data' });
  }
  next();
}