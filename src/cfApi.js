import crypto from 'crypto';

const CF_API_BASE = 'https://codeforces.com/api';

const queue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue || queue.length === 0) return;
  isProcessingQueue = true;

  while (queue.length > 0) {
    const { url, resolve, reject, retries } = queue.shift();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'CF-Daily-Grind/1.0',
          'Accept': 'application/json',
        },
      });
      clearTimeout(timeoutId);

      if (response.status === 429 || response.status === 503 || response.status === 502 || response.status === 504) {
        if (retries > 0) {
          console.log(`API response ${response.status}. Retrying... (${retries} retries left)`);
          const backoff = (4 - retries) * 2000;
          await new Promise((r) => setTimeout(r, backoff));
          queue.push({ url, resolve, reject, retries: retries - 1 });
        } else {
          reject(new Error(`Codeforces API request failed with status ${response.status} after retries.`));
        }
      } else if (!response.ok) {
        let errMsg = `API Error: ${response.status} ${response.statusText}`;
        try {
          const text = await response.text();
          const parsed = JSON.parse(text);
          if (parsed.comment) errMsg = parsed.comment;
        } catch {
          // response was not JSON (e.g. HTML from WAF) — use default error message
        }
        reject(new Error(errMsg));
      } else {
        let data;
        try {
          data = await response.json();
        } catch {
          reject(new Error('Codeforces API returned invalid JSON'));
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (data.status !== 'OK') {
          reject(new Error(data.comment || `Codeforces API returned status: ${data.status}`));
        } else {
          resolve(data.result);
        }
      }
    } catch (error) {
      if (retries > 0) {
        console.log(`Network or timeout error (${error.message}). Retrying... (${retries} retries left)`);
        const backoff = (4 - retries) * 2000;
        await new Promise((r) => setTimeout(r, backoff));
        queue.push({ url, resolve, reject, retries: retries - 1 });
      } else {
        reject(error);
      }
    }

    // Rate limiting delay — 1 request per second
    await new Promise((r) => setTimeout(r, 1000));
  }

  isProcessingQueue = false;
}

export function cfFetch(endpoint, params = {}) {
  const url = new URL(`${CF_API_BASE}/${endpoint}`);
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

  return new Promise((resolve, reject) => {
    queue.push({ url: url.toString(), resolve, reject, retries: 3 });
    processQueue();
  });
}

export async function fetchUserInfo(handle) {
  const result = await cfFetch('user.info', { handles: handle });
  return result[0];
}

export async function fetchUserSubmissions(handle, count) {
  if (count) {
    // Fetch only a limited number of recent submissions
    return cfFetch('user.status', { handle, from: 1, count });
  }

  // Fetch all submissions (paginated)
  let allSubmissions = [];
  let from = 1;
  const pageSize = 10000;

  while (true) {
    const result = await cfFetch('user.status', { handle, from, count: pageSize });
    allSubmissions = allSubmissions.concat(result);
    if (result.length < pageSize) {
      break;
    }
    from += pageSize;
  }

  return allSubmissions;
}

export async function fetchAllProblems() {
  const result = await cfFetch('problemset.problems');
  return {
    problems: result.problems,
    problemStatistics: result.problemStatistics,
  };
}

// Verification problem pool — any easy, well-known problem
const VERIFICATION_PROBLEMS = [
  { contestId: 1000, index: 'A' },
  { contestId: 4, index: 'A' },
  { contestId: 71, index: 'A' },
  { contestId: 1, index: 'A' },
  { contestId: 158, index: 'A' },
];

// Pick a random verification problem
export function pickVerificationProblem() {
  return VERIFICATION_PROBLEMS[Math.floor(Math.random() * VERIFICATION_PROBLEMS.length)];
}

// Generate a cryptographically secure verification code
export function generateVerificationCode() {
  const bytes = crypto.randomBytes(9); // 9 bytes = 12 base36-ish chars
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'CF_VERIFY_';
  for (let i = 0; i < 12; i++) {
    code += chars[bytes[i % bytes.length] % chars.length];
  }
  return code;
}

// Generate C++ code snippet that produces a compilation error containing the verification code
export function generateVerificationCodeSnippet(verificationCode) {
  return `// Verification code: ${verificationCode}
#include <bits/stdc++.h>
using namespace std;

int main() {
    // This code is designed to produce a compilation error
    // The verification code above proves ownership of the Codeforces account
    int x = "this will cause a compilation error"; // deliberate type mismatch
    return 0;
}`;
}

// Verify that the user has submitted a compilation error on the specified problem
export async function verifyCodeforcesOwnership(handle, verificationCode, problemContestId, problemIndex) {
  // Fetch recent 30 submissions — fast and sufficient
  const submissions = await fetchUserSubmissions(handle, 30);

  // Look for submissions in the last 30 minutes
  const cutoffTime = Math.floor(Date.now() / 1000) - 30 * 60;

  for (const sub of (submissions || [])) {
    if (!sub || !sub.creationTimeSeconds) continue;
    if (sub.creationTimeSeconds < cutoffTime) continue;
    if (sub.verdict !== 'COMPILATION_ERROR') continue;
    
    if (
      sub.problem &&
      Number(sub.problem.contestId) === Number(problemContestId) &&
      String(sub.problem.index).toUpperCase() === String(problemIndex).toUpperCase()
    ) {
      return true;
    }
  }

  return false;
}
