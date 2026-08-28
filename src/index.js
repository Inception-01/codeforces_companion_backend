import express from 'express';
import cors from 'cors';
import { ensureProblemsCache } from './problemCache.js';

import userRoutes from './routes/user.js';
import authRoutes from './routes/auth.js';
import problemsRoutes from './routes/problems.js';
import dailyRoutes from './routes/daily.js';
import syncRoutes from './routes/sync.js';
import statsRoutes from './routes/stats.js';
import profileRoutes from './routes/profile.js';
import exportRoutes from './routes/export.js';
import contestsRoutes from './routes/contests.js';
import learnRoutes from './routes/learn.js';
import arenaRoutes from './routes/arena.js';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — allow the frontend origin(s) to call this API.
//
// Production (Render): read the allowed origin(s) from CORS_ORIGIN (comma-separated),
// e.g. CORS_ORIGIN=https://cf-companion.vercel.app,https://localhost:5173
// Development (Vite proxy): allow any origin.
const corsOrigin = process.env.CORS_ORIGIN;
if (corsOrigin) {
  app.use(cors({
    origin: corsOrigin.split(',').map(s => s.trim()).filter(Boolean),
    credentials: true,
  }));
} else {
  app.use(cors({ origin: true, credentials: true }));
}

app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/problems', problemsRoutes);
app.use('/api/daily', dailyRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/contests', contestsRoutes);
app.use('/api/learn', learnRoutes);
app.use('/api/arena', arenaRoutes);

// Unmatched API routes return a clean 404 JSON (never the SPA).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Pre-warming problems cache in background...');
  ensureProblemsCache().catch(err => console.error('Failed to pre-warm cache:', err));
});
