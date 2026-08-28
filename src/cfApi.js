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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        }
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
        const text = await response.text().catch(() => '');
        let errMsg = `API Error: ${response.status} ${response.statusText}`;
        try {
          const parsed = JSON.parse(text);
          if (parsed.comment) errMsg = parsed.comment;
        } catch (_) {}
        reject(new Error(errMsg));
      } else {
        const data = await response.json();
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

    // Rate limiting delay
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

export async function fetchUserSubmissions(handle) {
  let allSubmissions = [];
  let from = 1;
  const count = 10000;

  while (true) {
    const result = await cfFetch('user.status', { handle, from, count });
    allSubmissions = allSubmissions.concat(result);
    if (result.length < count) {
      break;
    }
    from += count;
  }

  return allSubmissions;
}

export async function fetchAllProblems() {
  const result = await cfFetch('problemset.problems');
  return {
    problems: result.problems,
    problemStatistics: result.problemStatistics
  };
}
