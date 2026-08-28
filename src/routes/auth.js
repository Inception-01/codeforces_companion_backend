import express from 'express';
import { queryOne, execute } from '../db.js';
import {
  fetchUserInfo,
  verifyCodeforcesOwnership,
  generateVerificationCode,
  generateVerificationCodeSnippet,
  pickVerificationProblem,
} from '../cfApi.js';
import { setUserCookie, clearUserCookie, COOKIE_UID } from '../utils/cookies.js';

const router = express.Router();

const formatUser = (user) => {
  if (!user) return null;
  let parsedTags = user.selected_tags || [];
  if (typeof parsedTags === 'string') {
    try { parsedTags = JSON.parse(parsedTags); } catch { parsedTags = []; }
  }
  return { ...user, selected_tags: parsedTags };
};

// Step 1: Request verification code for signup/login
router.post('/request-verification', async (req, res) => {
  try {
    const { handle } = req.body;
    if (!handle || typeof handle !== 'string' || !handle.trim()) {
      return res.status(400).json({ error: 'Valid Codeforces handle is required' });
    }

    const trimmedHandle = handle.trim();

    // Validate handle exists on Codeforces
    try {
      await fetchUserInfo(trimmedHandle);
    } catch (cfErr) {
      return res.status(400).json({ error: `Codeforces handle "${trimmedHandle}" was not found.` });
    }

    // Generate verification code and pick a random problem
    const verificationCode = generateVerificationCode();
    const problem = pickVerificationProblem();
    const codeSnippet = generateVerificationCodeSnippet(verificationCode);

    // Store verification code (upsert)
    await execute(
      `INSERT INTO verification_codes (handle, code, problem_contest_id, problem_index, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (handle) DO UPDATE SET
         code = $2,
         problem_contest_id = $3,
         problem_index = $4,
         created_at = NOW(),
         verified_at = NULL`,
      [trimmedHandle, verificationCode, problem.contestId, problem.index]
    );

    const problemUrl = `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`;

    res.json({
      handle: trimmedHandle,
      verificationCode,
      codeSnippet,
      problemUrl,
      problemContestId: problem.contestId,
      problemIndex: problem.index,
      instructions: `Submit this code to Codeforces problem ${problem.contestId}${problem.index} using C++ (GNU G++17 or similar). It will produce a compilation error. Then click "I've Submitted" to verify.`,
    });
  } catch (error) {
    console.error('Error requesting verification:', error);
    res.status(500).json({ error: error.message || 'Failed to request verification' });
  }
});

// Step 2: Verify the submission
router.post('/verify', async (req, res) => {
  try {
    const { handle } = req.body;
    if (!handle || typeof handle !== 'string' || !handle.trim()) {
      return res.status(400).json({ error: 'Handle is required' });
    }

    const trimmedHandle = handle.trim();

    // Get stored verification code
    const record = await queryOne('SELECT * FROM verification_codes WHERE handle = $1', [trimmedHandle]);
    if (!record) {
      return res.status(400).json({ error: 'No verification code requested for this handle. Call /request-verification first.' });
    }

    // Check if code is not too old (30 minutes)
    const createdAt = new Date(record.created_at).getTime();
    if (Date.now() - createdAt > 30 * 60 * 1000) {
      return res.status(400).json({ error: 'Verification code expired. Request a new one.' });
    }

    // Verify ownership by checking for compilation error on the assigned problem
    const problemContestId = record.problem_contest_id || 1000;
    const problemIndex = record.problem_index || 'A';
    const verified = await verifyCodeforcesOwnership(trimmedHandle, record.code, problemContestId, problemIndex);

    if (!verified) {
      const problemUrl = `https://codeforces.com/problemset/problem/${problemContestId}/${problemIndex}`;
      return res.status(400).json({
        error: `No recent C++ compilation error submission found on problem ${problemContestId}${problemIndex}. Please submit the verification code snippet and try again.`,
        codeSnippet: generateVerificationCodeSnippet(record.code),
        problemUrl,
      });
    }

    // Mark verification as complete
    await execute('UPDATE verification_codes SET verified_at = NOW() WHERE handle = $1', [trimmedHandle]);

    // Create or get user
    await execute('INSERT INTO users (handle) VALUES ($1) ON CONFLICT (handle) DO NOTHING', [trimmedHandle]);
    const user = await queryOne('SELECT * FROM users WHERE handle = $1', [trimmedHandle]);

    setUserCookie(res, user);

    res.json({
      user: formatUser(user),
      message: 'Successfully verified and logged in!',
    });
  } catch (error) {
    console.error('Error verifying:', error);
    res.status(500).json({ error: error.message || 'Failed to verify' });
  }
});

// Login for existing registered users
router.post('/login', async (req, res) => {
  try {
    const { handle } = req.body;
    if (!handle || typeof handle !== 'string' || !handle.trim()) {
      return res.status(400).json({ error: 'Codeforces handle is required' });
    }

    const trimmedHandle = handle.trim();
    const user = await queryOne('SELECT * FROM users WHERE LOWER(handle) = LOWER($1)', [trimmedHandle]);

    if (!user) {
      return res.status(404).json({
        error: `Handle "${trimmedHandle}" is not registered yet. Please switch to the Sign Up tab to verify account ownership.`,
        notRegistered: true,
      });
    }

    setUserCookie(res, user);

    res.json({
      user: formatUser(user),
      message: 'Successfully logged in!',
    });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: error.message || 'Failed to log in' });
  }
});

// Get current user from cookie or header
router.get('/me', async (req, res) => {
  try {
    const uid = req.cookies?.[COOKIE_UID] || req.headers['x-user-id'];
    if (!uid) {
      return res.json({ user: null });
    }
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [uid]);
    if (!user) {
      clearUserCookie(res);
      return res.json({ user: null });
    }
    res.json({ user: formatUser(user) });
  } catch (error) {
    console.error('Error fetching current user:', error);
    res.json({ user: null });
  }
});

// Logout
router.post('/logout', (req, res) => {
  clearUserCookie(res);
  res.json({ ok: true });
});

// Get verification status (for polling)
router.get('/verification-status/:handle', async (req, res) => {
  try {
    const { handle } = req.params;
    const record = await queryOne('SELECT * FROM verification_codes WHERE handle = $1', [handle]);
    if (!record) {
      return res.json({ status: 'not_started' });
    }

    const createdAt = new Date(record.created_at).getTime();
    const isExpired = Date.now() - createdAt > 30 * 60 * 1000;

    if (record.verified_at) {
      return res.json({ status: 'verified' });
    }
    if (isExpired) {
      return res.json({ status: 'expired' });
    }
    res.json({ status: 'pending', code: record.code });
  } catch (error) {
    console.error('Error checking verification status:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

export default router;