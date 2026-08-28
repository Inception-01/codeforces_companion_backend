export const COOKIE_UID = 'cf_uid';
export const COOKIE_HANDLE = 'cf_handle';
export const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1 year in ms

export function setUserCookie(res, user) {
  const secure = process.env.NODE_ENV === 'production';
  const sameSite = secure ? 'none' : 'lax';

  res.cookie(COOKIE_UID, String(user.id), {
    maxAge: COOKIE_MAX_AGE_MS,
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
  });
  res.cookie(COOKIE_HANDLE, user.handle, {
    maxAge: COOKIE_MAX_AGE_MS,
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
  });
}

export function clearUserCookie(res) {
  const secure = process.env.NODE_ENV === 'production';
  const sameSite = secure ? 'none' : 'lax';

  res.clearCookie(COOKIE_UID, { path: '/', secure, sameSite });
  res.clearCookie(COOKIE_HANDLE, { path: '/', secure, sameSite });
}