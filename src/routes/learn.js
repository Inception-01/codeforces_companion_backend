import express from 'express';
import db from '../db.js';

const router = express.Router();

const NAV_URL = 'https://raw.githubusercontent.com/cp-algorithms/cp-algorithms/main/src/navigation.md';
const CURRICULUM_TTL_MS = 60 * 60 * 1000; // re-fetch every hour

let curriculumCache = { at: 0, data: null };

function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function articleUrl(path) {
  const p = String(path || '').replace(/\.md$/, '');
  return `https://cp-algorithms.com/${p}.html`;
}

// Parse navigation.md (cp-algorithms literate-nav) into modules.
// Format:
//   - Module                      (indent 0, heading)
//       - Submodule               (indent >0, heading, not an article)
//           - [Title](x.md)       (indent >0, article) -> current submodule
//       - [Direct Title](x.md)    (indent >0, article, before any submodule) -> module.articles
function parseNavigation(text) {
  const modules = [];
  let module = null;        // current module
  let submodule = null;     // current submodule (null = articles belong to module)

  const isArticle = (line) => /\[[^\]]*\]\([^)]*\.md\)/.test(line);

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('---')) continue;
    if (!line.startsWith('- ')) continue;

    const indent = raw.match(/^\s*/)[0].length;
    const content = line.slice(2).trim();

    if (indent === 0) {
      module = { name: content, submodules: [], articles: [] };
      modules.push(module);
      submodule = null;
    } else if (isArticle(content)) {
      if (!module) continue;
      const m = content.match(/\[([^\]]*)\]\(([^)]*\.md)\)/);
      if (!m) continue;
      const article = { title: m[1].trim(), key: m[2].replace(/\.md$/, ''), url: articleUrl(m[2]) };
      (submodule ? submodule.articles : module.articles).push(article);
    } else {
      if (!module) continue;
      submodule = { name: content, articles: [] };
      module.submodules.push(submodule);
    }
  }

  const EXCLUDE = new Set(['home']);
  return modules
    .map((m, mi) => ({
      id: slugify(m.name) || `module-${mi}`,
      name: m.name,
      articles: m.articles,
      submodules: m.submodules
        .filter(s => s.articles.length > 0)
        .map(s => ({ id: slugify(m.name) + '-' + slugify(s.name), name: s.name, articles: s.articles })),
    }))
    .filter(m => !EXCLUDE.has(m.id) && (m.articles.length > 0 || m.submodules.length > 0));
}

async function getCurriculum() {
  if (curriculumCache.data && Date.now() - curriculumCache.at < CURRICULUM_TTL_MS) {
    return curriculumCache.data;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(NAV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const text = await res.text();
    const data = parseNavigation(text);
    curriculumCache = { at: Date.now(), data };
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

function allArticleKeys(modules) {
  const keys = new Set();
  for (const m of modules) {
    for (const a of m.articles || []) keys.add(a.key);
    for (const s of m.submodules) {
      for (const a of s.articles) keys.add(a.key);
    }
  }
  return keys;
}

function buildSummary(modules, completed) {
  let totalArticles = 0;
  let totalDone = 0;
  const moduleSummary = modules.map((m) => {
    let mCount = 0;
    let mDone = 0;
    const submodules = m.submodules.map((s) => {
      let count = 0;
      let done = 0;
      for (const a of s.articles) {
        count++;
        if (completed.has(a.key)) done++;
      }
      mCount += count;
      mDone += done;
      return { id: s.id, name: s.name, total: count, completed: done, percent: count ? Math.round((done / count) * 100) : 0 };
    });
    for (const a of m.articles || []) {
      mCount++;
      if (completed.has(a.key)) mDone++;
    }
    totalArticles += mCount;
    totalDone += mDone;
    return { id: m.id, name: m.name, submodules, total: mCount, completed: mDone, percent: mCount ? Math.round((mDone / mCount) * 100) : 0 };
  });
  return {
    modules: moduleSummary,
    totalArticles,
    totalCompleted: totalDone,
    overallPercent: totalArticles ? Math.round((totalDone / totalArticles) * 100) : 0,
  };
}

router.get('/curriculum', async (req, res) => {
  try {
    const modules = await getCurriculum();
    res.json({ modules });
  } catch (error) {
    console.error('Error fetching curriculum:', error.message);
    res.status(500).json({ error: 'Failed to fetch curriculum' });
  }
});

router.get('/progress/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const modules = await getCurriculum();
    const rows = db.prepare('SELECT article_key FROM learning_progress WHERE user_id = ?').all(userId);
    const completed = new Set(rows.map(r => r.article_key));
    res.json({
      modules,
      completedKeys: [...completed],
      summary: buildSummary(modules, completed),
    });
  } catch (error) {
    console.error('Error loading progress:', error.message);
    res.status(500).json({ error: 'Failed to load progress' });
  }
});

router.patch('/progress/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { articleKey, completed } = req.body || {};
    if (!articleKey) return res.status(400).json({ error: 'articleKey is required' });

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const modules = await getCurriculum();
    if (!allArticleKeys(modules).has(articleKey)) {
      return res.status(400).json({ error: 'Unknown article key' });
    }

    if (completed) {
      db.prepare('INSERT OR IGNORE INTO learning_progress (user_id, article_key) VALUES (?, ?)').run(userId, articleKey);
    } else {
      db.prepare('DELETE FROM learning_progress WHERE user_id = ? AND article_key = ?').run(userId, articleKey);
    }

    const rows = db.prepare('SELECT article_key FROM learning_progress WHERE user_id = ?').all(userId);
    const completedSet = new Set(rows.map(r => r.article_key));
    res.json({ completedKeys: [...completedSet], summary: buildSummary(modules, completedSet) });
  } catch (error) {
    console.error('Error updating progress:', error.message);
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    curriculumCache = { at: 0, data: null };
    const modules = await getCurriculum();
    res.json({ modules });
  } catch (error) {
    console.error('Error refreshing curriculum:', error.message);
    res.status(500).json({ error: 'Failed to refresh curriculum' });
  }
});

export default router;
