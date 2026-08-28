import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ensureProblemsCache } from './problemCache.js';
import { closePool, dbReady } from './db.js';

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

// Trust reverse proxies (Render, Vercel, Cloudflare) for HTTPS & cookies
app.set('trust proxy', 1);

// CORS — allow all vercel.app domains, localhost, and configured CORS_ORIGIN
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return callback(null, true);
    if (origin.endsWith('.vercel.app') || origin === 'https://vercel.app') return callback(null, true);
    if (corsOrigin) {
      const allowed = corsOrigin.split(',').map(s => s.trim()).filter(Boolean);
      if (allowed.includes(origin)) return callback(null, true);
    }
    callback(null, true);
  },
  credentials: true,
}));

// Parse cookies (replaces manual cookie parsing)
app.use(cookieParser());
app.use(express.json());

// Health check endpoint (for Docker/Render health probes)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

// Unmatched API routes return a clean 404 JSON.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Wait for DB migrations before starting
dbReady.then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log('Pre-warming problems cache in background...');
    ensureProblemsCache().catch(err => console.error('Failed to pre-warm cache:', err));
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`${signal} received. Shutting down gracefully...`);
    server.close(async () => {
      await closePool();
      console.log('Server closed.');
      process.exit(0);
    });
    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
