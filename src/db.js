import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file automatically if present
for (const envPath of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../.env'),
]) {
  if (fs.existsSync(envPath)) {
    try {
      if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envPath);
      }
    } catch (_) {}
  }
}

const { Pool } = pg;

// Determine connection URL with smart local defaults
function getInitialDbUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  // Local development default fallback
  return 'postgres://localhost:5432/learn';
}

let activeUrl = getInitialDbUrl();

function createPool(connUrl) {
  return new Pool({
    connectionString: connUrl,
    ssl: process.env.NODE_ENV === 'production' && !connUrl.includes('localhost')
      ? { rejectUnauthorized: false }
      : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

let pool = createPool(activeUrl);

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

// Ensure target database exists; if 3D000 (db not found), auto-create or fallback
async function ensureDatabaseConnection() {
  try {
    const testClient = await pool.connect();
    testClient.release();
    return pool;
  } catch (err) {
    // 3D000 = database does not exist
    if (err.code === '3D000') {
      console.warn(`Database specified in URL does not exist. Attempting auto-creation...`);
      try {
        const parsed = new URL(activeUrl);
        const targetDbName = parsed.pathname.replace(/^\//, '');
        const adminUrl = new URL(activeUrl);
        adminUrl.pathname = '/postgres';

        const adminPool = createPool(adminUrl.toString());
        await adminPool.query(`CREATE DATABASE "${targetDbName.replace(/"/g, '""')}"`);
        await adminPool.end();
        console.log(`Database "${targetDbName}" created successfully.`);

        // Reconnect with target DB
        await pool.end().catch(() => {});
        pool = createPool(activeUrl);
        return pool;
      } catch (createErr) {
        console.warn(`Could not auto-create database (${createErr.message}). Falling back to existing database...`);
        // Fall back to /learn or /postgres
        for (const fallbackName of ['/learn', '/postgres']) {
          try {
            const fallbackUrl = new URL(activeUrl);
            fallbackUrl.pathname = fallbackName;
            const fallbackPool = createPool(fallbackUrl.toString());
            const client = await fallbackPool.connect();
            client.release();

            await pool.end().catch(() => {});
            activeUrl = fallbackUrl.toString();
            pool = fallbackPool;
            console.log(`Connected to fallback database: ${fallbackName.replace('/', '')}`);
            return pool;
          } catch (_) {}
        }
      }
    }
    throw err;
  }
}

// Run migrations from the migrations/ directory
async function runMigrations() {
  await ensureDatabaseConnection();

  // Ensure schema_migrations table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.warn('No migrations directory found at', migrationsDir);
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (isNaN(version)) continue;

    const { rows } = await pool.query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [version]
    );

    let shouldRun = rows.length === 0;
    if (!shouldRun && version === 1) {
      // Safety check: ensure core table actually exists in database
      const checkTable = await pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'problems_cache'"
      );
      if (checkTable.rows.length === 0) {
        shouldRun = true;
      }
    }

    if (shouldRun) {
      console.log(`Running migration ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [version]
        );
        await client.query('COMMIT');
        console.log(`Migration ${file} applied successfully.`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Migration ${file} failed:`, err.message);
        throw err;
      } finally {
        client.release();
      }
    }
  }
}

// Helper: run a query and return all rows
async function query(text, params) {
  await dbReady;
  const result = await pool.query(text, params);
  return result.rows;
}

// Helper: run a query and return the first row or null
async function queryOne(text, params) {
  await dbReady;
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

// Helper: run a query and return the result (for INSERT/UPDATE/DELETE)
async function execute(text, params) {
  await dbReady;
  return pool.query(text, params);
}

// Helper: get a client for transactions
async function getClient() {
  await dbReady;
  return pool.connect();
}

// Graceful shutdown
async function closePool() {
  await pool.end();
}

// Initialize on import
const dbReady = runMigrations().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

export { pool, query, queryOne, execute, getClient, closePool, dbReady };
export default { pool, query, queryOne, execute, getClient, closePool, dbReady };
