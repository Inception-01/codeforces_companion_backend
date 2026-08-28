import express from 'express';
import db from '../db.js';

const COOKIE_UID = 'cf_uid';
const COOKIE_HANDLE = 'cf_handle';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export function parseCookies(header = '') {
  const cookies = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(raw);
      } catch {
        cookies[key] = raw;
      }
    }
  });
  return cookies;
}

export function setUserCookie(res, user) {
  res.cookie(COOKIE_UID, String(user.id), {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    path: '/'
  });
  res.cookie(COOKIE_HANDLE, user.handle, {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    path: '/'
  });
}

export function clearUserCookie(res) {
  res.clearCookie(COOKIE_UID, { path: '/' });
  res.clearCookie(COOKIE_HANDLE, { path: '/' });
}

export { COOKIE_UID, COOKIE_HANDLE };

const router = express.Router();

router.get('/me', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const uid = cookies[COOKIE_UID];
  if (!uid) {
    return res.json({ user: null });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) {
    clearUserCookie(res);
    return res.json({ user: null });
  }
  try {
    user.selected_tags = JSON.parse(user.selected_tags || '[]');
  } catch (_) {
    user.selected_tags = [];
  }
  res.json({ user });
});

router.post('/logout', (req, res) => {
  clearUserCookie(res);
  res.json({ ok: true });
});

export default router;
