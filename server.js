import express from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── Database Connection ───────────────────────────────────────────────────────
// Priority: AZURE_DATABASE_URL (user-provided) → DATABASE_URL (Replit-managed)
// When neither is set the app runs entirely in memory (data resets on restart).
const _dbUrl = process.env.AZURE_DATABASE_URL || process.env.DATABASE_URL || null;
if (process.env.AZURE_DATABASE_URL) {
  console.log('🔗 Using AZURE_DATABASE_URL for database connection.');
} else if (process.env.DATABASE_URL) {
  console.log('🔗 Using Replit-managed DATABASE_URL for database connection.');
}
const USE_MEMORY = !_dbUrl;
if (USE_MEMORY) {
  console.warn('⚠️  No database URL set — running in IN-MEMORY mode. Data will reset on restart.');
}

const pool = USE_MEMORY ? null : new Pool({
  connectionString: _dbUrl,
  ssl: { rejectUnauthorized: false },
});

// In-memory store (used only when USE_MEMORY = true)
let memIdCounter = 1;

const POWERMIX_SEED_RULES = [
  { fg_code: '1000000000039', fg_description: 'Gallimax 2 plus',                                        sfg_material_code: '3000000000246', sfg1_material_code: '3000000000248', sfg_description: 'Gallimax 2 plus SFG',                             source_line: 'Line 5', target_line: 'Line 2', percentage: 85, batch_size: 4, is_active: true },
  { fg_code: '1000000000041', fg_description: 'Salto Stag Developer',                                   sfg_material_code: '3000000000078', sfg1_material_code: '3000000000033', sfg_description: 'Salto Stag Developer SFG',                        source_line: 'Line 5', target_line: 'Line 2', percentage: 80, batch_size: 4, is_active: true },
  { fg_code: '1000000000543', fg_description: 'Salto Stag Developer (alt)',                             sfg_material_code: '3000000000078', sfg1_material_code: '3000000000033', sfg_description: 'Salto Stag Developer SFG',                        source_line: 'Line 5', target_line: 'Line 2', percentage: 80, batch_size: 4, is_active: true },
  { fg_code: '1000000001387', fg_description: 'Gallimax 2 Plus red',                                   sfg_material_code: '3000000000482', sfg1_material_code: '3000000000480', sfg_description: 'Gallimax 2 Plus red SFG',                         source_line: 'Line 5', target_line: 'Line 2', percentage: 85, batch_size: 4, is_active: true },
  { fg_code: '1000000000565', fg_description: 'Gallimax PMP',                                          sfg_material_code: '3000000000053', sfg1_material_code: '3000000000057', sfg_description: 'Gallimax PMP SFG',                                 source_line: 'Line 5', target_line: 'Line 2', percentage: 40, batch_size: 4, is_active: true },
  { fg_code: '1000000001121', fg_description: 'Pork Solution Booster Plus (Cooked Mash)-1st pass',     sfg_material_code: '3000000000162', sfg1_material_code: '3000000001289', sfg_description: 'Pork Solution Booster Plus SFG',                  source_line: 'Line 7', target_line: 'Line 6', percentage: 81, batch_size: 2, is_active: true },
];

const memStore = {
  orders: [],
  knowledge_base: [],
  knowledge_base_uploads: [],
  next_10_days_records: [],
  next_10_days_uploads: [],
  demo_orders: [],
  demo_next_10_days_records: [],
  demo_next_10_days_uploads: [],
  cell_comments: [],
  row_highlights: {},
  powermix_split_rules: POWERMIX_SEED_RULES.map((r, i) => ({
    id: String(i + 1),
    ...r,
    remarks: '',
    created_date: new Date().toISOString(),
    updated_date: new Date().toISOString(),
  })),
};

function memGet(table) { return [...(memStore[table] || [])]; }
function memCreate(table, data) {
  const row = { id: String(memIdCounter++), created_date: new Date().toISOString(), updated_date: new Date().toISOString(), ...data };
  memStore[table].push(row);
  return row;
}
function memUpdate(table, id, data) {
  const idx = memStore[table].findIndex(r => String(r.id) === String(id));
  if (idx === -1) return null;
  memStore[table][idx] = { ...memStore[table][idx], ...data, updated_date: new Date().toISOString() };
  return memStore[table][idx];
}
function memDelete(table, id) {
  const before = memStore[table].length;
  memStore[table] = memStore[table].filter(r => String(r.id) !== String(id));
  return memStore[table].length < before;
}
function memDeleteAll(table) { memStore[table] = []; }

app.get('/api/health', async (req, res) => {
  if (USE_MEMORY) return res.json({ status: 'ok', database: 'in-memory' });
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected', message: err.message });
  }
});

const TABLE_MAP = {
  Order: 'orders',
  KnowledgeBase: 'knowledge_base',
  KnowledgeBaseUpload: 'knowledge_base_uploads',
  Next10DaysRecord: 'next_10_days_records',
  Next10DaysUpload: 'next_10_days_uploads',
  // Fulfillment (Demo) workspace — isolated clones of the live tables.
  DemoOrder: 'demo_orders',
  DemoNext10DaysRecord: 'demo_next_10_days_records',
  DemoNext10DaysUpload: 'demo_next_10_days_uploads',
};

const TABLE_COLUMNS = {};
async function getTableColumns(table) {
  if (TABLE_COLUMNS[table]) return TABLE_COLUMNS[table];
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  TABLE_COLUMNS[table] = new Set(res.rows.map(r => r.column_name));
  return TABLE_COLUMNS[table];
}

function filterToValidColumns(data, validColumns) {
  const filtered = {};
  for (const [k, v] of Object.entries(data)) {
    if (validColumns.has(k)) filtered[k] = v;
  }
  return filtered;
}

function toSnakeCase(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    const snakeKey = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    result[snakeKey] = v;
  }
  return result;
}

function stringifyJsonFields(data) {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      data[k] = JSON.stringify(v);
    }
  }
  return data;
}

function buildSetClause(data, startIdx = 1) {
  const fields = Object.keys(data);
  const clause = fields.map((f, i) => `${f} = $${i + startIdx}`).join(', ');
  const values = Object.values(data);
  return { clause, values };
}

async function initTables() {
  if (USE_MEMORY) return; // no tables needed in memory mode
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cell_comments (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      column_name TEXT NOT NULL DEFAULT 'row',
      comment_text TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'Planner',
      workspace TEXT NOT NULL DEFAULT 'live',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Annotations (highlights/comments) are keyed by order_id, but the demo
  // workspace reuses live order IDs, so they must also be scoped by workspace
  // ('live' | 'demo') to keep demo annotations from bleeding into live data.
  await pool.query(`ALTER TABLE cell_comments ADD COLUMN IF NOT EXISTS workspace TEXT NOT NULL DEFAULT 'live'`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS row_highlights (
      order_id TEXT,
      color TEXT,
      workspace TEXT NOT NULL DEFAULT 'live'
    )
  `);
  await pool.query(`ALTER TABLE row_highlights ADD COLUMN IF NOT EXISTS workspace TEXT NOT NULL DEFAULT 'live'`).catch(() => {});
  // Replace the legacy single-column (order_id) primary key with a composite
  // (order_id, workspace) uniqueness so the same order can be highlighted
  // independently in live and demo.
  await pool.query(`ALTER TABLE row_highlights DROP CONSTRAINT IF EXISTS row_highlights_pkey`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS row_highlights_order_workspace ON row_highlights(order_id, workspace)`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS diversion_data JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS done_timestamp TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS color TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS diameter NUMERIC(10,3)`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pre_combine_status TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pre_combine_line TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pre_combine_prio INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pre_combine_partner_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pre_combine_original_volume NUMERIC(10,3)`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS date_source TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS inferred_target_date TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS inferred_target_label TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS has_manual_override BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_edit_date TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_n10d_update TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS n10d_update_available BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS n10d_update_new_date TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS frozen_changeover NUMERIC(10,3)`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS changeover_frozen_at TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS frozen_changeover_breakdown TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS start_date_manual BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS start_time_manual BOOLEAN DEFAULT FALSE`).catch(() => {});
  // Corrective migration: undo the previous back-fill that incorrectly set frozen_changeover = changeover_time (base only).
  // Orders where frozen_changeover == changeover_time were incorrectly back-filled; reset so enrichment computes them dynamically.
  await pool.query(`
    UPDATE orders
    SET frozen_changeover = NULL,
        changeover_frozen_at = NULL
    WHERE status = 'completed'
      AND frozen_changeover IS NOT NULL
      AND frozen_changeover_breakdown IS NULL
      AND ABS(frozen_changeover - COALESCE(changeover_time, 0.17)) < 0.001
  `).catch(() => {});
  await pool.query(`ALTER TABLE knowledge_base_uploads ADD COLUMN IF NOT EXISTS snapshot_json TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS category TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS color TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS changeover NUMERIC(10,3)`).catch(() => {});
  await pool.query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS pricing_php NUMERIC(12,2)`).catch(() => {});
  await pool.query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS margin NUMERIC(8,4)`).catch(() => {});

  // Powermix Split Rules table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS powermix_split_rules (
      id SERIAL PRIMARY KEY,
      fg_code TEXT NOT NULL,
      fg_description TEXT,
      sfg_material_code TEXT NOT NULL,
      sfg_description TEXT,
      source_line TEXT NOT NULL DEFAULT 'Line 5',
      target_line TEXT NOT NULL,
      percentage NUMERIC(5,2) NOT NULL,
      batch_size INTEGER NOT NULL DEFAULT 4,
      is_active BOOLEAN DEFAULT TRUE,
      remarks TEXT,
      created_date TIMESTAMP DEFAULT NOW(),
      updated_date TIMESTAMP DEFAULT NOW()
    )
  `);

  // Seed initial rules if empty
  const ruleCount = await pool.query('SELECT COUNT(*) FROM powermix_split_rules');
  if (parseInt(ruleCount.rows[0].count) === 0) {
    for (const r of POWERMIX_SEED_RULES) {
      await pool.query(
        `INSERT INTO powermix_split_rules (fg_code, fg_description, sfg_material_code, sfg_description, source_line, target_line, percentage, batch_size, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.fg_code, r.fg_description, r.sfg_material_code, r.sfg_description, r.source_line || 'Line 5', r.target_line, r.percentage, r.batch_size, r.is_active]
      );
    }
    console.log('[Powermix] Seeded 6 default split rules.');
  }

  // New columns on orders for powermix traceability
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_powermix_generated BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS powermix_source_order_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS powermix_rule_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS powermix_split_subtext TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS prod_remarks TEXT`).catch(() => {});

  // Ensure batch_size and source_line columns exist (backfill if table pre-dates these columns)
  await pool.query(`ALTER TABLE powermix_split_rules ADD COLUMN IF NOT EXISTS batch_size INTEGER DEFAULT 4`).catch(() => {});
  await pool.query(`ALTER TABLE powermix_split_rules ADD COLUMN IF NOT EXISTS source_line TEXT DEFAULT 'Line 5'`).catch(() => {});
  await pool.query(`ALTER TABLE powermix_split_rules ADD COLUMN IF NOT EXISTS sfg1_material_code TEXT`).catch(() => {});
  // Backfill source_line for the known Line 7 rule
  await pool.query(`UPDATE powermix_split_rules SET source_line='Line 7' WHERE fg_code='1000000001121' AND (source_line IS NULL OR source_line='Line 5')`).catch(() => {});
  // Correct any rows that still have NULL or wrong batch_size from old schema
  const BATCH_CORRECTIONS = [
    { fg_code: '1000000000039', batch_size: 4 },
    { fg_code: '1000000000041', batch_size: 4 },
    { fg_code: '1000000000543', batch_size: 4 },
    { fg_code: '1000000001387', batch_size: 4 },
    { fg_code: '1000000000565', batch_size: 4 },
    { fg_code: '1000000001121', batch_size: 2 },
  ];
  for (const r of BATCH_CORRECTIONS) {
    await pool.query(
      `UPDATE powermix_split_rules SET batch_size=$1 WHERE fg_code=$2 AND (batch_size IS NULL OR batch_size NOT IN (2,4))`,
      [r.batch_size, r.fg_code]
    ).catch(() => {});
  }

  // Smart Demand cache table (persists AI-generated forecasts across sessions)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smart_demand_cache (
      cache_key TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      value NUMERIC(12,3) NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (cache_key, input_hash)
    )
  `);

  // ── Fulfillment (Demo) workspace tables ──────────────────────────────────
  // Isolated clones of the live tables. Created via LIKE so they mirror the
  // current live schema, then extended with demo-only fulfillment columns.
  await pool.query(`CREATE TABLE IF NOT EXISTS demo_orders (LIKE orders INCLUDING ALL)`).catch((e) => console.warn('[Fulfillment Demo Workspace] demo_orders create failed:', e.message));
  await pool.query(`CREATE TABLE IF NOT EXISTS demo_next_10_days_records (LIKE next_10_days_records INCLUDING ALL)`).catch((e) => console.warn('[Fulfillment Demo Workspace] demo_next_10_days_records create failed:', e.message));
  await pool.query(`CREATE TABLE IF NOT EXISTS demo_next_10_days_uploads (LIKE next_10_days_uploads INCLUDING ALL)`).catch((e) => console.warn('[Fulfillment Demo Workspace] demo_next_10_days_uploads create failed:', e.message));
  // Demo-only fulfillment columns on demo_orders
  await pool.query(`ALTER TABLE demo_orders ADD COLUMN IF NOT EXISTS fulfilled_from_inventory BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE demo_orders ADD COLUMN IF NOT EXISTS is_preorder BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE demo_orders ADD COLUMN IF NOT EXISTS preorder_for_order_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE demo_orders ADD COLUMN IF NOT EXISTS preorder_satisfied_volume NUMERIC(10,3)`).catch(() => {});
  delete TABLE_COLUMNS['demo_orders'];

  // Invalidate cached columns so new fields are picked up
  delete TABLE_COLUMNS['orders'];

  // ── Scalability indexes ─────────────────────────────────────────────────
  // Every list load sorts by created_date and the client filters heavily by
  // status. As the orders/next_10_days tables accumulate history they would
  // otherwise force a full-table sort on every fetch. These indexes keep the
  // ORDER BY ... LIMIT and status-filtered queries fast as the data grows.
  // (demo_* clones inherit indexes via LIKE ... INCLUDING ALL when first
  //  created, but we add them explicitly with IF NOT EXISTS so existing clones
  //  are upgraded too.)
  const _indexStmts = [
    `CREATE INDEX IF NOT EXISTS idx_orders_created_date ON orders (created_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders (status, created_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_demo_orders_created_date ON demo_orders (created_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_demo_orders_status ON demo_orders (status)`,
    `CREATE INDEX IF NOT EXISTS idx_n10d_created_date ON next_10_days_records (created_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_demo_n10d_created_date ON demo_next_10_days_records (created_date DESC)`,
  ];
  for (const stmt of _indexStmts) {
    await pool.query(stmt).catch((e) => console.warn('[Scalability index] create skipped:', e.message));
  }
}

// ── Fulfillment (Demo) seed / reset ────────────────────────────────────────
// One-time copy of live orders + active future dispatches into the demo tables.
// Idempotent: only seeds when demo_orders is empty (unless force=true).
async function getSharedColumns(srcTable, destTable) {
  const src = await getTableColumns(srcTable);
  const dest = await getTableColumns(destTable);
  return [...src].filter((c) => dest.has(c));
}

app.post('/api/demo/seed', async (req, res) => {
  const force = req.query.force === 'true' || req.body?.force === true;
  try {
    if (USE_MEMORY) {
      if (force) { memStore.demo_orders = []; memStore.demo_next_10_days_records = []; memStore.demo_next_10_days_uploads = []; }
      if (memStore.demo_orders.length === 0) {
        const deepClone = (x) => JSON.parse(JSON.stringify(x));
        memStore.demo_orders = memStore.orders.map(deepClone);
        // Only copy the active future-dispatch dataset (latest upload session).
        const latestUp = [...memStore.next_10_days_uploads].sort((a, b) =>
          String(b.created_date || '').localeCompare(String(a.created_date || ''))
        )[0];
        const activeSession = latestUp?.upload_session_id || null;
        if (activeSession) {
          memStore.demo_next_10_days_uploads = memStore.next_10_days_uploads
            .filter((u) => u.upload_session_id === activeSession)
            .map(deepClone);
          memStore.demo_next_10_days_records = memStore.next_10_days_records
            .filter((r) => r.upload_session_id === activeSession)
            .map(deepClone);
        } else {
          memStore.demo_next_10_days_uploads = memStore.next_10_days_uploads.map(deepClone);
          memStore.demo_next_10_days_records = memStore.next_10_days_records.map(deepClone);
        }
        console.log('[Fulfillment Demo Workspace] Seeded demo tables (memory):', { orders: memStore.demo_orders.length, n10d: memStore.demo_next_10_days_records.length });
        return res.json({ seeded: true, orders: memStore.demo_orders.length, n10dRecords: memStore.demo_next_10_days_records.length, n10dUploads: memStore.demo_next_10_days_uploads.length });
      }
      return res.json({ seeded: false, reason: 'already_seeded', orders: memStore.demo_orders.length });
    }

    if (force) {
      await pool.query('TRUNCATE demo_orders');
      await pool.query('TRUNCATE demo_next_10_days_records');
      await pool.query('TRUNCATE demo_next_10_days_uploads');
    }
    const existing = await pool.query('SELECT COUNT(*) FROM demo_orders');
    if (parseInt(existing.rows[0].count) > 0) {
      return res.json({ seeded: false, reason: 'already_seeded', orders: parseInt(existing.rows[0].count) });
    }

    const orderCols = await getSharedColumns('orders', 'demo_orders');
    const recCols = await getSharedColumns('next_10_days_records', 'demo_next_10_days_records');
    const upCols = await getSharedColumns('next_10_days_uploads', 'demo_next_10_days_uploads');

    const q = (cols, src, dest) => {
      if (!cols.length) return Promise.resolve({ rowCount: 0 });
      const list = cols.map((c) => `"${c}"`).join(', ');
      return pool.query(`INSERT INTO ${dest} (${list}) SELECT ${list} FROM ${src}`);
    };

    const oRes = await q(orderCols, 'orders', 'demo_orders');

    // Only copy the ACTIVE future-dispatch dataset (latest upload session),
    // mirroring how the live UI reads future dispatches. Falls back to copying
    // all rows when session columns are unavailable.
    let rRes = { rowCount: 0 };
    let uRes = { rowCount: 0 };
    const hasSession =
      upCols.includes('upload_session_id') && recCols.includes('upload_session_id');
    let activeSession = null;
    if (hasSession) {
      const latestUp = await pool.query(
        'SELECT upload_session_id FROM next_10_days_uploads ORDER BY created_date DESC LIMIT 1'
      );
      activeSession = latestUp.rows[0]?.upload_session_id || null;
    }
    if (hasSession && activeSession) {
      const ul = upCols.map((c) => `"${c}"`).join(', ');
      const rl = recCols.map((c) => `"${c}"`).join(', ');
      uRes = await pool.query(
        `INSERT INTO demo_next_10_days_uploads (${ul}) SELECT ${ul} FROM next_10_days_uploads WHERE upload_session_id = $1`,
        [activeSession]
      );
      rRes = await pool.query(
        `INSERT INTO demo_next_10_days_records (${rl}) SELECT ${rl} FROM next_10_days_records WHERE upload_session_id = $1`,
        [activeSession]
      );
    } else {
      uRes = await q(upCols, 'next_10_days_uploads', 'demo_next_10_days_uploads');
      rRes = await q(recCols, 'next_10_days_records', 'demo_next_10_days_records');
    }

    console.log('[Fulfillment Demo Workspace] Seeded demo tables:', { orders: oRes.rowCount, n10dRecords: rRes.rowCount, n10dUploads: uRes.rowCount, activeSession });
    res.json({ seeded: true, orders: oRes.rowCount, n10dRecords: rRes.rowCount, n10dUploads: uRes.rowCount });
  } catch (err) {
    console.error('[Fulfillment Demo Workspace] Seed failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/demo/reset', async (req, res) => {
  try {
    if (USE_MEMORY) {
      memStore.demo_orders = [];
      memStore.demo_next_10_days_records = [];
      memStore.demo_next_10_days_uploads = [];
    } else {
      await pool.query('TRUNCATE demo_orders');
      await pool.query('TRUNCATE demo_next_10_days_records');
      await pool.query('TRUNCATE demo_next_10_days_uploads');
    }
    console.log('[Fulfillment Demo Workspace] Demo tables reset (emptied).');
    res.json({ reset: true });
  } catch (err) {
    console.error('[Fulfillment Demo Workspace] Reset failed:', err);
    res.status(500).json({ error: err.message });
  }
});
initTables()
  .then(() => applyPowermixSplitRulesLogic().then(s => console.log('[Powermix] Startup apply-all:', s)).catch(e => console.warn('[Powermix] Startup apply-all failed:', e.message)))
  .catch(console.error);

app.get('/api/cell-comments/presence', async (req, res) => {
  const { orderIds, workspace = 'live' } = req.query;
  if (!orderIds) return res.json([]);
  const ids = orderIds.split(',').filter(Boolean);
  if (!ids.length) return res.json([]);
  if (USE_MEMORY) {
    const rows = memStore.cell_comments.filter(c => ids.includes(c.order_id) && (c.workspace || 'live') === workspace);
    const seen = new Set();
    const distinct = rows.filter(c => { const k = c.order_id + '|' + c.column_name; if (seen.has(k)) return false; seen.add(k); return true; });
    return res.json(distinct.map(c => ({ order_id: c.order_id, column_name: c.column_name })));
  }
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `SELECT DISTINCT order_id, column_name FROM cell_comments WHERE workspace = $${ids.length + 1} AND order_id IN (${placeholders})`,
      [...ids, workspace]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cell-comments', async (req, res) => {
  const { orderId, columnName, workspace = 'live' } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  if (USE_MEMORY) {
    let rows = memStore.cell_comments.filter(c => c.order_id === orderId && (c.workspace || 'live') === workspace);
    if (columnName) rows = rows.filter(c => c.column_name === columnName);
    return res.json(rows);
  }
  try {
    let result;
    if (columnName) {
      result = await pool.query(
        'SELECT * FROM cell_comments WHERE order_id = $1 AND column_name = $2 AND workspace = $3 ORDER BY created_at ASC',
        [orderId, columnName, workspace]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM cell_comments WHERE order_id = $1 AND workspace = $2 ORDER BY created_at ASC',
        [orderId, workspace]
      );
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cell-comments', async (req, res) => {
  const { order_id, column_name = 'row', comment_text, author = 'Planner', workspace = 'live' } = req.body;
  if (!order_id || !comment_text) return res.status(400).json({ error: 'order_id and comment_text required' });
  if (USE_MEMORY) {
    const row = memCreate('cell_comments', { order_id, column_name, comment_text, author, workspace, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return res.json(row);
  }
  try {
    const result = await pool.query(
      'INSERT INTO cell_comments (order_id, column_name, comment_text, author, workspace) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [order_id, column_name, comment_text, author, workspace]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cell-comments/:id', async (req, res) => {
  const { comment_text } = req.body;
  if (!comment_text) return res.status(400).json({ error: 'comment_text required' });
  if (USE_MEMORY) {
    const row = memUpdate('cell_comments', req.params.id, { comment_text, updated_at: new Date().toISOString() });
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json(row);
  }
  try {
    const result = await pool.query(
      'UPDATE cell_comments SET comment_text = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [comment_text, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cell-comments/:id', async (req, res) => {
  if (USE_MEMORY) { memDelete('cell_comments', req.params.id); return res.json({ success: true }); }
  try {
    await pool.query('DELETE FROM cell_comments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/row-highlights', async (req, res) => {
  const { orderIds, workspace = 'live' } = req.query;
  if (!orderIds) return res.json([]);
  const ids = orderIds.split(',').filter(Boolean);
  if (!ids.length) return res.json([]);
  if (USE_MEMORY) {
    return res.json(ids.filter(id => memStore.row_highlights[`${workspace}::${id}`]).map(id => ({ order_id: id, color: memStore.row_highlights[`${workspace}::${id}`] })));
  }
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `SELECT order_id, color FROM row_highlights WHERE workspace = $${ids.length + 1} AND order_id IN (${placeholders})`,
      [...ids, workspace]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/row-highlights', async (req, res) => {
  const { order_id, color, workspace = 'live' } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id required' });
  if (USE_MEMORY) {
    if (!color) { delete memStore.row_highlights[`${workspace}::${order_id}`]; } else { memStore.row_highlights[`${workspace}::${order_id}`] = color; }
    return res.json({ success: true });
  }
  try {
    if (!color) {
      await pool.query('DELETE FROM row_highlights WHERE order_id = $1 AND workspace = $2', [order_id, workspace]);
    } else {
      await pool.query(
        'INSERT INTO row_highlights (order_id, color, workspace) VALUES ($1, $2, $3) ON CONFLICT (order_id, workspace) DO UPDATE SET color = $2',
        [order_id, color, workspace]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/entities/:entity', async (req, res) => {
  const table = TABLE_MAP[req.params.entity];
  if (!table) return res.status(404).json({ error: 'Unknown entity' });
  // Opt-in, backward-compatible filtering/pagination. When none of these query
  // params are supplied the response is identical to before. They let callers
  // that don't need the full table (e.g. a paginated history browse) scope the
  // load server-side as the data grows, instead of pulling everything.
  const statusIn = String(req.query.status_in || '').split(',').map((s) => s.trim()).filter(Boolean);
  const statusNotIn = String(req.query.status_not_in || '').split(',').map((s) => s.trim()).filter(Boolean);
  const offset = parseInt(req.query.offset) || 0;
  if (USE_MEMORY) {
    let rows = memGet(table);
    if (statusIn.length) rows = rows.filter((r) => statusIn.includes(r.status));
    if (statusNotIn.length) rows = rows.filter((r) => !statusNotIn.includes(r.status));
    const sort = req.query.sort || '-created_date';
    const dir = sort.startsWith('-') ? -1 : 1;
    const col = sort.replace(/^-/, '');
    rows.sort((a, b) => { const av = a[col] || ''; const bv = b[col] || ''; return av < bv ? -dir : av > bv ? dir : 0; });
    const lim = parseInt(req.query.limit) || 10000;
    return res.json(rows.slice(offset, offset + lim));
  }
  try {
    const sort = req.query.sort || '-created_date';
    const limit = parseInt(req.query.limit) || 10000;
    const dir = sort.startsWith('-') ? 'DESC' : 'ASC';
    const rawCol = sort.replace(/^-/, '');
    // Allowlist the sort column against the table's real columns — the column
    // name is interpolated into the SQL (it can't be parameterized), so an
    // unknown value falls back to created_date instead of being trusted.
    const validCols = await getTableColumns(table);
    const col = validCols.has(rawCol) ? rawCol : 'created_date';
    const where = [];
    const params = [];
    if (statusIn.length) {
      where.push(`status IN (${statusIn.map((_, i) => `$${params.length + i + 1}`).join(', ')})`);
      params.push(...statusIn);
    }
    if (statusNotIn.length) {
      where.push(`status NOT IN (${statusNotIn.map((_, i) => `$${params.length + i + 1}`).join(', ')})`);
      params.push(...statusNotIn);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;
    const result = await pool.query(
      `SELECT * FROM ${table} ${whereSql} ORDER BY ${col} ${dir} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/entities/:entity', async (req, res) => {
  const table = TABLE_MAP[req.params.entity];
  if (!table) return res.status(404).json({ error: 'Unknown entity' });
  if (USE_MEMORY) {
    const row = memCreate(table, req.body);
    return res.json(row);
  }
  try {
    const validCols = await getTableColumns(table);
    let data = stringifyJsonFields(filterToValidColumns(req.body, validCols));
    const fields = Object.keys(data);
    if (fields.length === 0) return res.status(400).json({ error: 'No valid fields' });
    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const values = Object.values(data);
    const result = await pool.query(
      `INSERT INTO ${table} (${fields.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/entities/:entity/bulk', async (req, res) => {
  const table = TABLE_MAP[req.params.entity];
  if (!table) return res.status(404).json({ error: 'Unknown entity' });
  if (USE_MEMORY) {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0) return res.json([]);
    const results = rows.map(row => memCreate(table, row));
    return res.json(results);
  }
  try {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0) return res.json([]);
    const validCols = await getTableColumns(table);
    const results = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const rawRow of rows) {
        const row = stringifyJsonFields(filterToValidColumns(rawRow, validCols));
        const fields = Object.keys(row);
        if (fields.length === 0) continue;
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
        const values = Object.values(row);
        const r = await client.query(
          `INSERT INTO ${table} (${fields.join(', ')}) VALUES (${placeholders}) RETURNING *`,
          values
        );
        results.push(r.rows[0]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Batch update: PUT /api/entities/:entity/batch
// Body: [{id, data}, ...]  → returns [{...updatedRow}, ...]
// All updates applied in a single transaction — one round-trip for cascade saves.
app.put('/api/entities/:entity/batch', async (req, res) => {
  const table = TABLE_MAP[req.params.entity];
  if (!table) return res.status(404).json({ error: 'Unknown entity' });
  const updates = req.body;
  if (!Array.isArray(updates) || updates.length === 0) return res.json([]);
  if (USE_MEMORY) {
    const results = updates.map(({ id, data }) => memUpdate(table, id, data)).filter(Boolean);
    return res.json(results);
  }
  try {
    const validCols = await getTableColumns(table);
    const results = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { id, data } of updates) {
        if (!id || !data) continue;
        const row = stringifyJsonFields(
          filterToValidColumns({ ...data, updated_date: new Date() }, validCols)
        );
        const { clause, values } = buildSetClause(row);
        if (!clause) continue;
        const r = await client.query(
          `UPDATE ${table} SET ${clause} WHERE id=$${values.length + 1} RETURNING *`,
          [...values, id]
        );
        if (r.rows.length > 0) results.push(r.rows[0]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json(results);
  } catch (err) {
    console.error('[batch-update error]', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/entities/:entity/:id', async (req, res) => {
  const table = TABLE_MAP[req.params.entity];
  if (!table) return res.status(404).json({ error: 'Unknown entity' });

  // ── Inline batch handler ──────────────────────────────────────────────────
  // The /batch sub-route can lose to /:id in Express route matching when both
  // patterns are registered under the same app.put prefix. Guard here so that
  // PUT /api/entities/:entity/batch always works regardless of order.
  if (req.params.id === 'batch') {
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) return res.json([]);
    if (USE_MEMORY) {
      const results = updates.map(({ id, data }) => memUpdate(table, id, data)).filter(Boolean);
      return res.json(results);
    }
    try {
      const validCols = await getTableColumns(table);
      const results = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const { id, data } of updates) {
          if (!id || !data) continue;
          const row = stringifyJsonFields(
            filterToValidColumns({ ...data, updated_date: new Date() }, validCols)
          );
          const { clause, values } = buildSetClause(row);
          if (!clause) continue;
          const r = await client.query(
            `UPDATE ${table} SET ${clause} WHERE id=$${values.length + 1} RETURNING *`,
            [...values, id]
          );
          if (r.rows.length > 0) results.push(r.rows[0]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      console.log(`[PUT] ${table}/batch — OK. ${results.length}/${updates.length} rows updated`);
      return res.json(results);
    } catch (err) {
      console.error('[batch-update error]', err);
      return res.status(500).json({ error: err.message });
    }
  }
  // ── End inline batch handler ──────────────────────────────────────────────

  if (USE_MEMORY) {
    const row = memUpdate(table, req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json(row);
  }
  try {
    const validCols = await getTableColumns(table);
    const data = stringifyJsonFields(filterToValidColumns({ ...req.body, updated_date: new Date() }, validCols));
    const { clause, values } = buildSetClause(data);
    if (!clause) {
      console.error(`[PUT] ${table}/${req.params.id} — empty SET clause! body keys: ${Object.keys(req.body).join(',')}`);
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // === HA Prep Cancellation Guard (server-side safety net) ===
    // Reject cancel_po if the order's ha_prep_form_issuance is 'On Going' or 'Done'.
    if (table === 'orders' && req.body.status === 'cancel_po') {
      const _haRow = await pool.query('SELECT ha_prep_form_issuance FROM orders WHERE id=$1', [req.params.id]);
      if (_haRow.rows.length > 0) {
        const _haPrep = _haRow.rows[0].ha_prep_form_issuance || '';
        const _blocked = ['On Going', 'Done'].includes(_haPrep);
        console.debug('[Cancel PO Blocked - HA Prep]', {
          orderId: req.params.id,
          haPrepStatus: _haPrep,
          attemptedStatus: 'cancel_po',
          blocked: _blocked,
        });
        if (_blocked) {
          return res.status(422).json({
            error: `This order cannot be cancelled because HA Prep is already ${_haPrep}. Cancel PO is not allowed once Hand-Additives preparation has started or been completed.`,
          });
        }
      }
    }

    // === Order Flow Sequence Guard (server-side safety net) ===
    // Reject status downgrades to not-yet-started (plotted/planned) when a
    // following INDEPENDENT order on the same line is already on-going.
    // Sub-orders (parent_id IS NOT NULL) are excluded — they are not independent flow steps.
    if (table === 'orders' && 'status' in req.body && ['plotted', 'planned'].includes(req.body.status)) {
      const _FLOW_ONGOING = ['ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging', 'in_production'];
      const orderRow = await pool.query(
        'SELECT feedmill_line, priority_seq, parent_id, original_order_ids FROM orders WHERE id=$1',
        [req.params.id]
      );
      if (orderRow.rows.length > 0) {
        const { feedmill_line, priority_seq, parent_id, original_order_ids } = orderRow.rows[0];
        const pSeq = priority_seq ?? 999999;
        const isLeadOrder = !parent_id && Array.isArray(original_order_ids) && original_order_ids.length > 0;
        // Count sub-orders on the same line for debug logging
        const subRes = await pool.query(
          `SELECT COUNT(*) FROM orders WHERE feedmill_line=$1 AND parent_id IS NOT NULL`,
          [feedmill_line]
        );
        const subOrdersIgnored = parseInt(subRes.rows[0].count, 10);
        console.debug('[Combined Group Flow Validation]', {
          orderId: req.params.id,
          combinedGroupId: parent_id || (isLeadOrder ? req.params.id : null),
          isLeadOrder,
          subOrdersDetected: subOrdersIgnored,
          subOrdersIgnoredForFlowRestriction: true,
        });
        // Only check independent lead/standalone orders (parent_id IS NULL)
        const followRes = await pool.query(
          `SELECT id FROM orders WHERE feedmill_line=$1 AND status=ANY($2::text[]) AND COALESCE(priority_seq, 999999) > $3 AND id != $4 AND status != 'cancel_po' AND parent_id IS NULL LIMIT 1`,
          [feedmill_line, _FLOW_ONGOING, pSeq, req.params.id]
        );
        const hasTrueFollowingOngoing = followRes.rows.length > 0;
        console.debug('[Not-Yet-Started Restriction Check]', {
          orderId: req.params.id,
          requestedStatus: req.body.status,
          followingSubOrdersIgnored: subOrdersIgnored,
          hasTrueFollowingOngoingOrder: hasTrueFollowingOngoing,
        });
        if (hasTrueFollowingOngoing) {
          console.debug('[Not-Yet-Started Warning Trigger]', {
            orderId: req.params.id,
            requestedStatus: req.body.status,
            warningShown: true,
            triggeredByTrueFollowingOngoingOrder: true,
          });
          return res.status(422).json({ error: 'Cannot move this order back to a not-yet-started status while a following order is on-going.' });
        }
        console.debug('[Not-Yet-Started Warning Trigger]', {
          orderId: req.params.id,
          requestedStatus: req.body.status,
          warningShown: false,
          triggeredByTrueFollowingOngoingOrder: false,
        });
      }
    }

    const result = await pool.query(
      `UPDATE ${table} SET ${clause} WHERE id = $${values.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (result.rows.length === 0) {
      console.error(`[PUT] ${table}/${req.params.id} — NOT FOUND (0 rows). Keys: ${Object.keys(req.body).join(',')}`);
      return res.status(404).json({ error: 'Not found' });
    }
    const updatedRow = result.rows[0];
    console.log(`[PUT] ${table}/${req.params.id} — OK. Keys: ${Object.keys(req.body).join(',')}`);

    // ── Inline Powermix sync ──────────────────────────────────────────────────
    // When a Line 5 source order's fg, sfg, or total_volume_mt changes, update
    // the linked generated order in the same handler so the GET /api/orders that
    // follows will already see the new values — no separate round-trip needed.
    let pmxGenFields = null; // returned to client for optimistic cache patch
    if (table === 'orders') {
      const hasPlannedFields = 'fg' in req.body || 'sfg' in req.body || 'pmx' in req.body;
      const hasVolume        = 'total_volume_mt' in req.body || 'volume_override' in req.body;
      const hasAvailDate     = 'target_avail_date' in req.body || 'original_avail_date' in req.body;
      const isGenerated      = updatedRow.is_powermix_generated === true ||
                               updatedRow.is_powermix_generated === 'true';
      const sourceDisplayLine = toDisplayLine(updatedRow.feedmill_line);
      const isSourceLine     =
        (sourceDisplayLine === 'Line 5' || sourceDisplayLine === 'Line 7') &&
        !isGenerated &&
        (hasPlannedFields || hasVolume || hasAvailDate);

      if (isSourceLine) {
        try {
          const genRes = await pool.query(
            'SELECT id, feedmill_line, target_avail_date FROM orders WHERE powermix_source_order_id=$1 AND is_powermix_generated=true LIMIT 1',
            [req.params.id]
          );
          if (genRes.rows.length > 0) {
            const genId = genRes.rows[0].id;
            const genFields = {};

            if ('fg'  in req.body) genFields.fg  = req.body.fg;
            // Line 5 mapping: generated SFG = source PMX (the "SFG1" column).
            // Source SFG (2nd column) is intentionally NOT copied to generated SFG.
            // Line 7 keeps the legacy SFG → SFG mapping.
            if (sourceDisplayLine === 'Line 5') {
              if ('pmx' in req.body) genFields.sfg = req.body.pmx;
            } else {
              if ('sfg' in req.body) genFields.sfg = req.body.sfg;
            }

            // Avail date is INTENTIONALLY NOT synced source → generated.
            // Generated orders keep their OWN (preview / AI-assigned) avail date and
            // must never inherit the source order's date. Source and generated avail
            // dates are independent — they only match if the preview assigned the same date.
            if (hasAvailDate) {
              console.debug('[Generated Order Avail Date Preservation]', {
                sourceOrderId: req.params.id,
                generatedOrderId: genId,
                sourceLine: sourceDisplayLine,
                sourceNewAvailDate: req.body.target_avail_date ?? null,
                generatedAvailDatePreserved: genRes.rows[0].target_avail_date || null,
                copiedSourceDateToGenerated: false,
              });
            }

            if (hasVolume) {
              const ruleRes = await pool.query(
                'SELECT * FROM powermix_split_rules WHERE fg_code=$1 AND source_line=$2 AND is_active=true LIMIT 1',
                [updatedRow.material_code, sourceDisplayLine]
              );
              if (ruleRes.rows.length > 0) {
                const rule          = ruleRes.rows[0];
                const pct           = parseFloat(rule.percentage) || 85;
                const batchSize     = parseFloat(rule.batch_size) > 0 ? parseFloat(rule.batch_size) : 4;
                // Effective volume: prefer the field the user just set, fall back to DB value
                const rawSourceQty  = parseFloat(
                  req.body.volume_override ?? req.body.total_volume_mt ??
                  updatedRow.volume_override ?? updatedRow.total_volume_mt
                ) || 0;
                const effectiveSrc  = batchSize > 1 ? Math.ceil(rawSourceQty / batchSize) * batchSize : rawSourceQty;
                const rawSplit      = effectiveSrc * pct / 100;
                const rawSplitFloor = Math.floor(rawSplit * 100) / 100;
                const generatedQty  = batchSize > 1
                  ? Math.ceil(rawSplit / batchSize) * batchSize
                  : Math.round(rawSplit * 100) / 100;
                const wasAdjusted   = batchSize > 1 && Math.abs(rawSplitFloor - generatedQty) > 0.005;
                const srcName       = updatedRow.item_description || updatedRow.material_code;

                genFields.total_volume_mt        = generatedQty;
                genFields.powermix_split_subtext = wasAdjusted ? String(rawSplitFloor) : null;
                genFields.prod_remarks           = `Created from ${sourceDisplayLine} order, producing ${pct}% of ${srcName} from ${effectiveSrc} MT source volume.`;
                genFields.remarks                = wasAdjusted
                  ? `Powermix split: ${pct}% of ${effectiveSrc} MT → ${rawSplitFloor} MT, ceil-aligned to ${generatedQty} MT (batch ${batchSize})`
                  : `Powermix split: ${pct}% of ${effectiveSrc} MT = ${generatedQty} MT`;
              }
            }

            if (Object.keys(genFields).length > 0) {
              const setClauses = Object.keys(genFields).map((k, i) => `${k}=$${i + 1}`).join(', ');
              const vals = [...Object.values(genFields), genId];
              await pool.query(
                `UPDATE orders SET ${setClauses}, updated_date=NOW() WHERE id=$${vals.length}`,
                vals
              );
              console.log(`[Powermix Inline Sync] ${req.params.id} → ${genId}:`, genFields);
              pmxGenFields = { id: genId, ...genFields };
            }
          }
        } catch (syncErr) {
          console.warn('[Powermix Inline Sync] Error:', syncErr.message);
        }
      }

      // Reverse avail date sync (generated → source) is INTENTIONALLY removed.
      // Generated and source avail dates are independent — editing a generated
      // order's date must NOT overwrite the source order's own date, and vice versa.
      if (isGenerated && hasAvailDate && updatedRow.powermix_source_order_id) {
        console.debug('[Generated vs Source Date Independence]', {
          generatedOrderId: req.params.id,
          sourceOrderId: String(updatedRow.powermix_source_order_id),
          generatedNewAvailDate: req.body.target_avail_date ?? null,
          propagatedToSource: false,
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Include synced generated-order fields so the client can patch its cache
    // immediately without waiting for the invalidateQueries refetch.
    res.json(pmxGenFields ? { ...updatedRow, _pmxGenFields: pmxGenFields } : updatedRow);
  } catch (err) {
    console.error(`[PUT] ${table}/${req.params.id} — ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/entities/:entity/:id', async (req, res) => {
  const table = TABLE_MAP[req.params.entity];
  if (!table) return res.status(404).json({ error: 'Unknown entity' });
  if (USE_MEMORY) { memDelete(table, req.params.id); return res.json({ success: true }); }
  try {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/entities/:entity', async (req, res) => {
  const table = TABLE_MAP[req.params.entity];
  if (!table) return res.status(404).json({ error: 'Unknown entity' });
  if (USE_MEMORY) { memDeleteAll(table); return res.json({ success: true }); }
  try {
    await pool.query(`DELETE FROM ${table}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/integrations/core/extract-data', async (req, res) => {
  res.json({ status: 'success', output: [], details: 'File parsing not available — please use the CSV upload endpoint.' });
});

// ─── Powermix Split Rules CRUD ────────────────────────────────────────────────

app.get('/api/powermix-split-rules', async (req, res) => {
  if (USE_MEMORY) return res.json(memGet('powermix_split_rules'));
  try {
    const result = await pool.query('SELECT * FROM powermix_split_rules ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/powermix-split-rules', async (req, res) => {
  const { fg_code, fg_description, sfg_material_code, sfg1_material_code, sfg_description, source_line = 'Line 5', target_line, percentage, batch_size, is_active = true, remarks = '' } = req.body;
  if (!fg_code || !sfg_material_code || !target_line || percentage == null) {
    return res.status(400).json({ error: 'fg_code, sfg_material_code, target_line, and percentage are required' });
  }
  if (USE_MEMORY) {
    const row = memCreate('powermix_split_rules', { fg_code, fg_description, sfg_material_code, sfg1_material_code, sfg_description, source_line, target_line, percentage, batch_size: batch_size ?? 4, is_active, remarks });
    return res.json(row);
  }
  try {
    const result = await pool.query(
      `INSERT INTO powermix_split_rules (fg_code, fg_description, sfg_material_code, sfg1_material_code, sfg_description, source_line, target_line, percentage, batch_size, is_active, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [fg_code, fg_description, sfg_material_code, sfg1_material_code ?? null, sfg_description, source_line, target_line, percentage, batch_size ?? 4, is_active, remarks]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/powermix-split-rules/:id', async (req, res) => {
  const { fg_code, fg_description, sfg_material_code, sfg1_material_code, sfg_description, source_line = 'Line 5', target_line, percentage, batch_size, is_active, remarks } = req.body;
  if (USE_MEMORY) {
    const row = memUpdate('powermix_split_rules', req.params.id, { fg_code, fg_description, sfg_material_code, sfg1_material_code, sfg_description, source_line, target_line, percentage, batch_size, is_active, remarks });
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json(row);
  }
  try {
    const result = await pool.query(
      `UPDATE powermix_split_rules
       SET fg_code=$1, fg_description=$2, sfg_material_code=$3, sfg1_material_code=$4, sfg_description=$5,
           source_line=$6, target_line=$7, percentage=$8, batch_size=$9, is_active=$10, remarks=$11, updated_date=NOW()
       WHERE id=$12 RETURNING *`,
      [fg_code, fg_description, sfg_material_code, sfg1_material_code ?? null, sfg_description, source_line, target_line, percentage, batch_size, is_active, remarks, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/powermix-split-rules/:id', async (req, res) => {
  if (USE_MEMORY) { memDelete('powermix_split_rules', req.params.id); return res.json({ success: true }); }
  try {
    await pool.query('DELETE FROM powermix_split_rules WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Powermix Apply Logic ─────────────────────────────────────────────────────

const LINE_TO_RR_KEY = {
  'Line 1': 'line_1_run_rate', 'Line 2': 'line_2_run_rate',
  'Line 3': 'line_3_run_rate', 'Line 4': 'line_4_run_rate',
  'Line 5': 'line_5_run_rate', 'Line 6': 'line_6_run_rate',
  'Line 7': 'line_7_run_rate',
};

// DB stores feedmill_line as snake_case (e.g. 'line_7'); rules store source_line as display name ('Line 7').
// This map normalises DB values → display names for rule lookups.
const LINE_DB_TO_DISPLAY = {
  'line_1': 'Line 1', 'line_2': 'Line 2', 'line_3': 'Line 3', 'line_4': 'Line 4',
  'line_5': 'Line 5', 'line_6': 'Line 6', 'line_7': 'Line 7',
};
const toDisplayLine = (dbKey) => LINE_DB_TO_DISPLAY[dbKey] || dbKey;

// True when a value is a real avail date (not null/undefined/blank string).
const _hasDate = (v) => v != null && String(v).trim() !== '';

async function applyPowermixSplitRulesLogic(tableName = 'orders') {
  const stats = { created: 0, updated: 0, cancelled: 0, skipped: 0 };

  let rules, allOrders, kbRecords;
  if (USE_MEMORY) {
    rules = memStore.powermix_split_rules.filter(r => r.is_active === true || r.is_active === 'true');
    allOrders = [...(memStore[tableName] || [])];
    kbRecords = [...(memStore.knowledge_base || [])];
  } else {
    rules = (await pool.query('SELECT * FROM powermix_split_rules WHERE is_active = true')).rows;
    allOrders = (await pool.query(
      `SELECT id, feedmill_line, material_code, item_description, total_volume_mt, status,
              fpr, fg, sfg, pmx, priority_seq, is_powermix_generated, powermix_source_order_id, powermix_rule_id,
              target_avail_date, original_avail_date, sap_sfg1, sfg1, sfgpmx, fg1, run_rate, production_hours, batch_size
       FROM ${tableName}`
    )).rows;
    kbRecords = (await pool.query('SELECT * FROM knowledge_base')).rows;
  }

  // Build KB map: fg_material_code → record
  const kbMap = {};
  for (const r of kbRecords) {
    if (r.fg_material_code) kbMap[String(r.fg_material_code).trim()] = r;
  }

  // Build rule map: "fg_code__source_line" → rule (supports same FG on different source lines)
  const ruleMap = {};
  for (const rule of rules) {
    const srcLine = rule.source_line || 'Line 5';
    ruleMap[`${String(rule.fg_code).trim()}__${srcLine}`] = rule;
  }

  // Source orders: Line 5 or Line 7 (DB stores feedmill_line as 'line_5'/'line_7', normalised via toDisplayLine)
  const sourceOrders = allOrders.filter(o => {
    const displayLine = toDisplayLine(o.feedmill_line);
    return (displayLine === 'Line 5' || displayLine === 'Line 7') &&
      !o.parent_id &&
      !(o.is_powermix_generated === true || o.is_powermix_generated === 'true') &&
      o.status !== 'completed' && o.status !== 'cancel_po';
  });

  // All currently generated orders
  const generatedOrders = allOrders.filter(o =>
    o.is_powermix_generated === true || o.is_powermix_generated === 'true'
  );

  const keepIds = new Set();

  for (const src of sourceOrders) {
    const fgCode = String(src.material_code || '').trim();
    const rule = ruleMap[`${fgCode}__${toDisplayLine(src.feedmill_line)}`];
    if (!rule) continue;

    const srcId = String(src.id);
    const ruleId = String(rule.id);
    const rawSourceQty = parseFloat(src.total_volume_mt || 0);
    const pct = parseFloat(rule.percentage);

    // Batch size MUST come from the Powermix Split rule config — never fallback to 1
    const configuredBatch = parseFloat(rule.batch_size);
    const batchSize = configuredBatch > 0 ? configuredBatch : 4;

    // Batch source resolution debug — compare Powermix Split vs KB Master Data
    const kbEntryForSrc = kbMap[fgCode] || null;
    const masterDataBatchSize = kbEntryForSrc && kbEntryForSrc.batch_size_pmx != null
      ? parseFloat(kbEntryForSrc.batch_size_pmx) : null;
    console.debug('[Powermix Batch Source Resolution]', {
      sourceOrderId: srcId,
      materialCodeUsedForLookup: fgCode,
      matchedRuleId: ruleId,
      masterDataBatchSize,
      powermixSplitBatchSize: batchSize,
      appliedBatchSize: batchSize,
      batchSourceUsed: 'powermix_split',
    });

    console.debug('[Powermix Batch Lookup]', {
      sourceOrderId: srcId,
      sourceFgCode: fgCode,
      matchedRuleId: ruleId,
      configuredBatch,
      appliedBatch: batchSize,
      fellBackToDefault: !(configuredBatch > 0),
    });

    console.debug('[Powermix Batch Lookup Critical Check]', {
      sourceOrderId: srcId,
      materialCodeUsedForLookup: fgCode,
      matchedPowermixRuleId: ruleId,
      matchedPowermixBatch: configuredBatch,
      masterDataBatch: masterDataBatchSize,
      appliedBatch: batchSize,
      isUsingPowermixBatch: configuredBatch > 0,
    });

    // Step 1: effective source quantity — use Powermix Split batch_size to compute what the
    // Line 5 order actually displays (same as getSuggestedVolume in the frontend).
    // This is the EXACT quantity basis used for the split calculation.
    const effectiveSourceQty = batchSize > 1
      ? Math.ceil(rawSourceQty / batchSize) * batchSize
      : rawSourceQty;

    // Step 2: raw split from percentage of effective (displayed) source quantity
    const rawSplit = effectiveSourceQty * pct / 100;

    // Step 3: batch-align the result upward (ceil) — matches frontend getSuggestedVolume logic
    const generatedQty = batchSize > 1
      ? Math.ceil(rawSplit / batchSize) * batchSize
      : Math.round(rawSplit * 100) / 100;

    // "Original" is the floor of the raw split (what you'd get without rounding up)
    const rawSplitFloor = Math.floor(rawSplit * 100) / 100;
    const wasAdjusted = batchSize > 1 && Math.abs(rawSplitFloor - generatedQty) > 0.005;

    // powermix_split_subtext stores the raw (pre-adjustment) split qty only when the
    // batch alignment actually changed the value — the frontend uses this to render
    // "Original: X MT" beneath the displayed volume for generated orders.
    const splitSubtextValue = wasAdjusted ? String(rawSplitFloor) : null;

    console.debug('[Powermix Generated MT Adjustment]', {
      sourceOrderId: srcId,
      sourceVolume: effectiveSourceQty,
      percentage: pct,
      rawSplitQty: rawSplitFloor,
      appliedBatch: batchSize,
      adjustedFinalQty: generatedQty,
      shouldRenderOriginal: wasAdjusted,
    });

    console.debug('[Powermix Split Quantity Basis]', {
      sourceOrderId: srcId,
      rawSourceQty,
      appAdjustedQty: effectiveSourceQty,
      exactQtyBasisUsedForSplit: effectiveSourceQty,
      percentage: pct,
      generatedQty,
    });

    // Source / target line for this generation pass (normalise DB key → display name)
    const sourceLine = toDisplayLine(src.feedmill_line);
    const targetLine = rule.target_line;

    // FPR Note — goes in FPR Notes column (prod_remarks) for generated orders
    const srcName = src.item_description || fgCode;
    const fprNote = `Created from ${sourceLine} order, producing ${pct}% of ${srcName} from ${effectiveSourceQty} MT source volume.`;

    // Verbose volume note stored in remarks (internal/technical)
    const volumeNote = wasAdjusted
      ? `Powermix split: ${pct}% of ${effectiveSourceQty} MT → ${rawSplitFloor} MT, ceil-aligned to ${generatedQty} MT (batch ${batchSize})`
      : `Powermix split: ${pct}% of ${effectiveSourceQty} MT = ${generatedQty} MT`;

    // Run-rate resolution: prefer target-line KB run_rate; fall back to source-line KB run_rate
    const kbEntry = kbMap[fgCode] || null;
    const targetRRKey = LINE_TO_RR_KEY[targetLine];
    const sourceRRKey = LINE_TO_RR_KEY[sourceLine] || 'line_5_run_rate';
    const targetLineRunRate = kbEntry && kbEntry[targetRRKey] != null && kbEntry[targetRRKey] !== ''
      ? parseFloat(kbEntry[targetRRKey]) : null;
    const sourceLineRunRate = kbEntry && kbEntry[sourceRRKey] != null && kbEntry[sourceRRKey] !== ''
      ? parseFloat(kbEntry[sourceRRKey])
      : (parseFloat(src.run_rate) > 0 ? parseFloat(src.run_rate) : null);
    const resolvedRunRate = (targetLineRunRate && targetLineRunRate > 0)
      ? targetLineRunRate
      : (sourceLineRunRate && sourceLineRunRate > 0 ? sourceLineRunRate : null);
    const usedSourceLineFallback = !(targetLineRunRate && targetLineRunRate > 0) && !!(resolvedRunRate);
    const production_hours = resolvedRunRate && resolvedRunRate > 0
      ? parseFloat((generatedQty / resolvedRunRate).toFixed(2))
      : null;

    // Planned Order FG/SFG mapping (client rule):
    //   Generated FG  = blank / null  (do NOT copy source FG into generated FG)
    //   Generated SFG = source SFG1 planned order value
    //     Line 5 → source `pmx` (3rd planned order value, labelled "SFG1" on Line 5)
    //     Line 7 → source `sfg` (2nd planned order value)
    const sourcePlannedFg   = src.fg  || null;  // kept for debug logging only
    const sourcePlannedSfg  = sourceLine === 'Line 5' ? (src.pmx || null) : (src.sfg || null);
    const sourceSFG1PlannedOrder  = sourcePlannedSfg;
    const sourceSFG1MaterialCode  = rule.sfg1_material_code || rule.sfg_material_code || null;
    // Generated order uses null FG and SFG1-derived SFG
    const generatedFgValue  = null;
    const generatedSfgValue = sourceSFG1PlannedOrder;

    console.debug('[Powermix Split Routing]', {
      sourceMaterialCode: fgCode,
      sourceLine,
      targetLine,
      matchedRule: true,
    });
    console.debug('[Generated Order Copy Mapping]', {
      sourceFGPlannedOrder: sourcePlannedFg,
      sourceSFGPlannedOrder: src.sfg || null,
      sourceSFG1PlannedOrder,
      sourceSFG1MaterialCode,
      generatedFGPlannedOrder: '-----',
      generatedSFGPlannedOrder: sourceSFG1PlannedOrder,
      generatedSFGMaterialCode: sourceSFG1MaterialCode,
    });
    console.debug('[Powermix Planned Order Mapping]', {
      sourceLine,
      sourceFG: src.fg || null,
      sourceSFG: src.sfg || null,
      sourceSFG1: src.pmx || src.sfg1 || null,
      generatedFG: '-----',
      generatedSFG: generatedSfgValue,
      mappingRule: sourceLine === 'Line 5' ? 'SFG1 only' : sourceLine === 'Line 7' ? 'SFG only' : 'UNKNOWN',
    });

    console.debug('[Powermix Split Rule Evaluation]', {
      sourceOrderId: srcId,
      sourceLine,
      sourceFgCode: fgCode,
      rawSourceQty,
      effectiveSourceQty,
      matchedRule: { id: ruleId, target_line: rule.target_line, percentage: pct },
    });

    console.debug('[Powermix Volume Calculation]', {
      sourceOrderId: srcId,
      rawSourceQty,
      effectiveSourceQty,
      percentage: pct,
      rawSplit,
      rawSplitFloor,
      batchSize,
      generatedQty,
      fprNote,
    });

    const existing = generatedOrders.find(o =>
      String(o.powermix_source_order_id) === srcId &&
      String(o.powermix_rule_id) === ruleId
    );

    // Always write the Powermix Split batch_size back to the Line 5 source order so the
    // frontend always reads the correct value directly from the DB without depending on the
    // pmxSplitRules query loading first.
    if (USE_MEMORY) {
      memUpdate(tableName, srcId, { batch_size: batchSize });
    } else {
      await pool.query(`UPDATE ${tableName} SET batch_size=$1 WHERE id=$2`, [batchSize, srcId]);
    }

    if (existing) {
      keepIds.add(String(existing.id));
      const curQty = parseFloat(existing.total_volume_mt || 0);
      const fgNeedsCorrection = existing.material_code !== null && existing.material_code !== undefined && String(existing.material_code || '').trim() !== '';
      const sfgNeedsCorrection = String(existing.kb_sfg_material_code || '').trim() !== String(sourceSFG1MaterialCode || '').trim();
      const qtyChanged = Math.abs(curQty - generatedQty) > 0.005;

      const updateFields = {
        material_code: null,
        kb_sfg_material_code: sourceSFG1MaterialCode,
        item_description: rule.fg_description || `Split from ${fgCode}`,
        total_volume_mt: generatedQty,
        batch_size: batchSize,
        // Preserve the current status — never reset a manually-changed status
        // back to 'plotted'. Only brand-new generated orders start as 'plotted'.
        status: existing.status || 'plotted',
        remarks: volumeNote,
        prod_remarks: fprNote,
        powermix_split_subtext: splitSubtextValue,
        // Avail date INDEPENDENCE: preserve the generated order's OWN existing date
        // (set by preview / AI apply). Only fall back to the source date when the
        // generated order has none. apply-all must never reset a generated order's
        // avail date back to the source's date. Treat null/undefined/blank as "no date".
        target_avail_date: _hasDate(existing.target_avail_date)
          ? existing.target_avail_date
          : (src.target_avail_date || null),
        original_avail_date: _hasDate(existing.original_avail_date)
          ? existing.original_avail_date
          : (src.original_avail_date || null),
        fpr: src.fpr || null,
        fg: generatedFgValue,
        sfg: generatedSfgValue,
        sap_sfg1: src.sap_sfg1 || null,
        sfg1: src.sfg1 || null,
        run_rate: resolvedRunRate,
        production_hours,
      };
      console.debug('[Generated Order Avail Date Preservation]', {
        sourceOrderId: srcId,
        generatedOrderId: existing.id,
        sourceAvailDate: src.target_avail_date || null,
        generatedExistingAvailDate: existing.target_avail_date || null,
        finalAppliedGeneratedAvailDate: updateFields.target_avail_date,
        preservedExistingGeneratedDate: _hasDate(existing.target_avail_date),
        copiedSourceDateToGenerated:
          !_hasDate(existing.target_avail_date) && (src.target_avail_date || null) != null,
      });
      if (USE_MEMORY) {
        memUpdate(tableName, existing.id, updateFields);
      } else {
        await pool.query(
          `UPDATE ${tableName} SET
             material_code=$1, kb_sfg_material_code=$2, item_description=$3,
             total_volume_mt=$4, batch_size=$5, status=$6, remarks=$7,
             prod_remarks=$8, powermix_split_subtext=$9,
             target_avail_date=$10, original_avail_date=$11,
             fpr=$12, fg=$13, sfg=$14, sap_sfg1=$15, sfg1=$16,
             run_rate=$17, production_hours=$18, updated_date=NOW()
           WHERE id=$19`,
          [null, sourceSFG1MaterialCode,
           rule.fg_description || `Split from ${fgCode}`,
           generatedQty, batchSize, existing.status || 'plotted', volumeNote,
           fprNote, splitSubtextValue,
           updateFields.target_avail_date, updateFields.original_avail_date,
           src.fpr || null, generatedFgValue, generatedSfgValue,
           src.sap_sfg1 || null, src.sfg1 || null,
           resolvedRunRate, production_hours,
           existing.id]
        );
        delete TABLE_COLUMNS[tableName];
      }
      const actionTaken = (fgNeedsCorrection || sfgNeedsCorrection || qtyChanged) ? 'corrected' : 'refreshed';
      stats.updated++;

      console.debug('[Generated Order Field Population]', {
        generatedOrderId: existing.id,
        fgDisplayValue: '-----',
        sfgPlannedOrder: generatedSfgValue,
        sfgMaterialCode: sourceSFG1MaterialCode,
      });
      console.debug('[Powermix FG/SFG Mapping Check]', {
        sourceOrderId: srcId,
        sourceFgCode: fgCode,
        mappedSfgCode: sourceSFG1MaterialCode,
        generatedMaterialCodeFg: null,
        generatedMaterialCodeSfg: sourceSFG1MaterialCode,
        isFgCorrect: true,
        isSfgCorrect: true,
      });
      console.debug('[Powermix Planned Order Copy]', {
        sourceOrderId: srcId,
        sourcePlannedOrderFg: sourcePlannedFg,
        sourcePlannedOrderSfg: sourcePlannedSfg,
        generatedOrderId: existing.id,
        copiedPlannedOrderFg: '-----',
        copiedPlannedOrderSfg: generatedSfgValue,
      });
      console.debug('[Powermix Run Rate Resolution]', {
        sourceOrderId: srcId,
        generatedOrderId: existing.id,
        targetLine,
        targetLineRunRate,
        sourceLineRunRate,
        finalAppliedRunRate: resolvedRunRate,
        usedSourceLineFallback,
      });
      console.debug('[Powermix Linked Order Created]', {
        sourceMaterialCode: fgCode,
        sourceLine,
        targetLine,
        generatedFG: sourcePlannedFg,
        generatedSFG: sourcePlannedSfg,
        splitPercent: pct,
        batchSize,
      });
      console.debug('[Powermix FPR Note Generation]', {
        sourceOrderId: srcId,
        generatedOrderId: existing.id,
        productName: srcName,
        percentage: pct,
        exactQtyBasisUsedForSplit: effectiveSourceQty,
        renderedFprNote: fprNote,
      });
      console.debug('[Powermix Duplicate Check]', {
        sourceOrderId: srcId, ruleId, existingGeneratedOrderId: existing.id,
        actionTaken, fgNeedsCorrection, sfgNeedsCorrection, qtyChanged,
      });
    } else {
      // FG/SFG mapping (client rule):
      //   material_code          = null  (do NOT copy source FG material code into generated FG)
      //   kb_sfg_material_code   = rule's SFG1 material code (SFG placement for generated order)
      //   fg                     = null  (generated FG planned order is blank / -----)
      //   sfg                    = source SFG1 planned order value
      const newOrder = {
        feedmill_line: rule.target_line,
        material_code: null,
        kb_sfg_material_code: sourceSFG1MaterialCode,
        item_description: rule.fg_description || `Split from ${fgCode}`,
        total_volume_mt: generatedQty,
        batch_size: batchSize,
        status: 'plotted',
        is_powermix_generated: true,
        powermix_source_order_id: srcId,
        powermix_rule_id: ruleId,
        remarks: volumeNote,
        prod_remarks: fprNote,
        powermix_split_subtext: splitSubtextValue,
        // Planned Order: FG = blank, SFG = source SFG1 planned order value
        fpr: src.fpr || null,
        fg: generatedFgValue,
        sfg: generatedSfgValue,
        sap_sfg1: src.sap_sfg1 || null,
        sfg1: src.sfg1 || null,
        // Copy date metadata from source
        target_avail_date: src.target_avail_date || null,
        original_avail_date: src.original_avail_date || null,
        // Run-rate: target line from KB, fall back to Line 5 KB/source run_rate
        run_rate: resolvedRunRate,
        production_hours,
      };

      console.debug('[Generated Order Field Population]', {
        generatedOrderId: '(pending)',
        fgDisplayValue: '-----',
        sfgPlannedOrder: generatedSfgValue,
        sfgMaterialCode: sourceSFG1MaterialCode,
      });
      console.debug('[Powermix FG/SFG Mapping Check]', {
        sourceOrderId: srcId,
        sourceFgCode: fgCode,
        mappedSfgCode: sourceSFG1MaterialCode,
        generatedMaterialCodeFg: null,
        generatedMaterialCodeSfg: newOrder.kb_sfg_material_code,
        isFgCorrect: true,
        isSfgCorrect: newOrder.kb_sfg_material_code === sourceSFG1MaterialCode,
      });
      console.debug('[Powermix Planned Order Copy]', {
        sourceOrderId: srcId,
        sourcePlannedOrderFg: sourcePlannedFg,
        sourcePlannedOrderSfg: sourcePlannedSfg,
        generatedOrderId: '(pending)',
        copiedPlannedOrderFg: '-----',
        copiedPlannedOrderSfg: generatedSfgValue,
      });
      console.debug('[Powermix Run Rate Resolution]', {
        sourceOrderId: srcId,
        generatedOrderId: '(pending)',
        targetLine,
        targetLineRunRate,
        sourceLineRunRate,
        finalAppliedRunRate: resolvedRunRate,
        usedSourceLineFallback,
      });
      console.debug('[Powermix Linked Order Created]', {
        sourceMaterialCode: fgCode,
        sourceLine,
        targetLine,
        generatedFG: sourcePlannedFg,
        generatedSFG: sourcePlannedSfg,
        splitPercent: pct,
        batchSize,
      });
      console.debug('[Powermix FPR Note Generation]', {
        sourceOrderId: srcId,
        generatedOrderId: '(pending)',
        productName: srcName,
        percentage: pct,
        exactQtyBasisUsedForSplit: effectiveSourceQty,
        renderedFprNote: fprNote,
      });

      if (USE_MEMORY) {
        const created = memCreate(tableName, newOrder);
        keepIds.add(String(created.id));
        console.debug('[Powermix Generated Order UI Flags]', {
          generatedOrderId: created.id,
          status: newOrder.status,
          isPurpleHighlighted: true,
          line5CreatedLabelVisible: true,
          fprNotePopulated: !!fprNote,
        });
      } else {
        const fields = Object.keys(newOrder).filter(k => newOrder[k] !== null && newOrder[k] !== undefined);
        const vals = fields.map(k => newOrder[k]);
        const ph = fields.map((_, i) => `$${i + 1}`).join(', ');
        const r = await pool.query(`INSERT INTO ${tableName} (${fields.join(', ')}) VALUES (${ph}) RETURNING id`, vals);
        keepIds.add(String(r.rows[0].id));
        delete TABLE_COLUMNS[tableName];
        console.debug('[Powermix Generated Order UI Flags]', {
          generatedOrderId: r.rows[0].id,
          status: newOrder.status,
          isPurpleHighlighted: true,
          line5CreatedLabelVisible: true,
          fprNotePopulated: !!fprNote,
        });
      }
      stats.created++;
    }
  }

  // Cancel orphaned generated orders (source deleted / moved off Line 5 / rule deactivated)
  for (const gen of generatedOrders) {
    if (!keepIds.has(String(gen.id)) && gen.status !== 'completed' && gen.status !== 'cancel_po') {
      if (USE_MEMORY) {
        memUpdate(tableName, gen.id, { status: 'cancel_po' });
      } else {
        await pool.query(`UPDATE ${tableName} SET status='cancel_po', updated_date=NOW() WHERE id=$1`, [gen.id]);
      }
      stats.cancelled++;
    }
  }

  return stats;
}

app.post('/api/powermix/apply-all', async (req, res) => {
  try {
    // Demo workspace runs the SAME Powermix split logic against demo_orders only,
    // so demo uploads get live-equivalent generated Powermix orders without ever
    // touching the live orders table.
    const workspace = req.query.workspace === 'demo' ? 'demo' : 'live';
    const tableName = workspace === 'demo' ? 'demo_orders' : 'orders';
    const stats = await applyPowermixSplitRulesLogic(tableName);
    console.log(`[Powermix] apply-all (${workspace}):`, stats);
    res.json({ success: true, stats });
  } catch (err) {
    console.error('[Powermix] apply-all error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Powermix: sync a single source order's generated partner ─────────────────
// Called automatically when the user edits volume, fg, or sfg on a Line 5 source order.
app.post('/api/powermix/sync-source/:sourceId', async (req, res) => {
  try {
    const { sourceId } = req.params;
    const { newVolume, newFg, newSfg } = req.body;

    let src, rules;
    if (USE_MEMORY) {
      src = memStore.orders.find(o => String(o.id) === String(sourceId));
      rules = memStore.powermix_split_rules.filter(r => r.is_active === true || r.is_active === 'true');
    } else {
      const srcRes = await pool.query('SELECT * FROM orders WHERE id = $1', [sourceId]);
      src = srcRes.rows[0];
      rules = (await pool.query('SELECT * FROM powermix_split_rules WHERE is_active = true')).rows;
    }
    if (!src) return res.status(404).json({ error: 'Source order not found' });

    const fgCode = String(src.material_code || '').trim();
    const rule = rules.find(r => String(r.fg_code).trim() === fgCode);
    if (!rule) return res.json({ skipped: true, reason: 'No matching Powermix Split rule' });

    let genOrder;
    if (USE_MEMORY) {
      genOrder = memStore.orders.find(o =>
        String(o.powermix_source_order_id) === String(sourceId) &&
        (o.is_powermix_generated === true || o.is_powermix_generated === 'true')
      );
    } else {
      const genRes = await pool.query(
        'SELECT * FROM orders WHERE powermix_source_order_id=$1 AND is_powermix_generated=true LIMIT 1',
        [sourceId]
      );
      genOrder = genRes.rows[0];
    }
    if (!genOrder) return res.json({ skipped: true, reason: 'No generated order found' });

    const batchSize = parseFloat(rule.batch_size) > 0 ? parseFloat(rule.batch_size) : 4;
    const pct = parseFloat(rule.percentage);

    const updateFields = {};

    // Volume recalculation
    if (newVolume !== undefined) {
      const rawSourceQty = parseFloat(newVolume) || 0;
      const effectiveSourceQty = batchSize > 1 ? Math.ceil(rawSourceQty / batchSize) * batchSize : rawSourceQty;
      const rawSplit = effectiveSourceQty * pct / 100;
      const generatedQty = batchSize > 1 ? Math.ceil(rawSplit / batchSize) * batchSize : Math.round(rawSplit * 100) / 100;
      const rawSplitFloor = Math.floor(rawSplit * 100) / 100;
      const wasAdjusted = batchSize > 1 && Math.abs(rawSplitFloor - generatedQty) > 0.005;
      const splitSubtextValue = wasAdjusted ? String(rawSplitFloor) : null;
      const srcName = src.item_description || fgCode;
      const fprNote = `Created from Line 5 order, producing ${pct}% of ${srcName} from ${effectiveSourceQty} MT source volume.`;
      const volumeNote = wasAdjusted
        ? `Powermix split: ${pct}% of ${effectiveSourceQty} MT → ${rawSplitFloor} MT, ceil-aligned to ${generatedQty} MT (batch ${batchSize})`
        : `Powermix split: ${pct}% of ${effectiveSourceQty} MT = ${generatedQty} MT`;

      updateFields.total_volume_mt = generatedQty;
      updateFields.remarks = volumeNote;
      updateFields.prod_remarks = fprNote;
      updateFields.powermix_split_subtext = splitSubtextValue;

      console.debug('[Powermix Source Sync]', {
        sourceOrderId: sourceId,
        sourceVolumeBefore: parseFloat(src.total_volume_mt || 0),
        sourceVolumeAfter: rawSourceQty,
        percentage: pct,
        batchSizeFromPowermixSplit: batchSize,
        exactQtyBasisUsedForSplit: effectiveSourceQty,
        rawSplitQty: rawSplitFloor,
        adjustedGeneratedQty: generatedQty,
        generatedOrderId: genOrder.id,
      });
    }

    // Planned Order FG/SFG direct copy
    if (newFg !== undefined) updateFields.fg = newFg;
    if (newSfg !== undefined) updateFields.sfg = newSfg;

    if (Object.keys(updateFields).length === 0) return res.json({ skipped: true, reason: 'No fields to sync' });

    if (USE_MEMORY) {
      memUpdate('orders', genOrder.id, updateFields);
    } else {
      const setClauses = Object.keys(updateFields).map((k, i) => `${k}=$${i + 1}`).join(', ');
      const values = [...Object.values(updateFields), genOrder.id];
      await pool.query(`UPDATE orders SET ${setClauses}, updated_date=NOW() WHERE id=$${values.length}`, values);
      delete TABLE_COLUMNS['orders'];
    }

    if ((newFg !== undefined || newSfg !== undefined) && newVolume === undefined) {
      console.debug('[Powermix Source Sync]', {
        sourceOrderId: sourceId,
        sourcePlannedOrderFgBefore: genOrder.fg,
        sourcePlannedOrderFgAfter: newFg ?? genOrder.fg,
        sourcePlannedOrderSfgBefore: genOrder.sfg,
        sourcePlannedOrderSfgAfter: newSfg ?? genOrder.sfg,
        generatedOrderId: genOrder.id,
      });
    }

    res.json({ success: true, generatedOrderId: genOrder.id, updatedData: updateFields });
  } catch (err) {
    console.error('[Powermix] sync-source error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const AZURE_OPENAI_ENDPOINT = 'https://nexfeed-ai.cognitiveservices.azure.com';
const AZURE_OPENAI_DEPLOYMENT = 'gpt-4.1-mini';
const AZURE_OPENAI_API_VERSION = '2024-12-01-preview';
const AZURE_OPENAI_KEY = process.env.VITE_AZURE_OPENAI_KEY;
if (!AZURE_OPENAI_KEY) console.warn('Warning: VITE_AZURE_OPENAI_KEY not set. AI features will not work.');
console.log(`AI model: ${AZURE_OPENAI_DEPLOYMENT} (${AZURE_OPENAI_ENDPOINT})`)

// Wraps a fetch with an AbortController-based timeout. Rejects with an error
// whose message starts with "Timeout:" if the fetch doesn't settle in time.
function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...options, signal: ctrl.signal })
    .catch(err => {
      if (err.name === 'AbortError') throw new Error(`Timeout: Azure OpenAI did not respond within ${timeoutMs}ms`);
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

// Retry wrapper: attempts the async fn up to maxAttempts times with exponential
// back-off (baseDelay, baseDelay*2, baseDelay*4, …). Retries on 429/5xx and
// network errors. Re-throws after maxAttempts exhausted.
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1500, retryOnTimeout = true, deadlineAt = null } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      // Don't retry client errors (4xx except 429) or timeout exceeded on last attempt
      const is429 = msg.includes('429');
      const is5xx = /Azure OpenAI error 5\d\d/.test(msg);
      const isTimeout = msg.startsWith('Timeout:');
      const isNet = isTimeout || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      // Timeouts are expensive: a retry after a full-length timeout would blow
      // past Replit's 60 s proxy budget, so the client connection is already
      // dead. Callers on the interactive path pass retryOnTimeout=false.
      if (isTimeout && !retryOnTimeout) throw err;
      if (!is429 && !is5xx && !isNet) throw err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      // Respect an overall deadline so total time stays under the proxy budget.
      if (deadlineAt && Date.now() + delay >= deadlineAt) break;
      console.warn(`[Azure OpenAI] Attempt ${attempt} failed (${msg.substring(0, 80)}). Retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function callAzureOpenAI(messages, maxTokens = 800, opts = {}) {
  const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  const body = JSON.stringify({ messages, max_tokens: maxTokens, temperature: opts.temperature ?? 0.7 });
  const headers = { 'Content-Type': 'application/json', 'api-key': AZURE_OPENAI_KEY };
  // Default 55 s timeout keeps us safely under Replit's 60 s proxy limit.
  const TIMEOUT_MS = opts.timeoutMs ?? 55_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryOnTimeout = opts.retryOnTimeout ?? true;
  // Overall deadline guards the proxy budget when retries are allowed.
  const deadlineAt = opts.deadlineMs ? Date.now() + opts.deadlineMs : null;
  return withRetry(async () => {
    // HARD budget enforcement: each attempt's timeout is capped to whatever
    // time is left before the overall deadline (minus a small guard), so a
    // late-failing first attempt can never let a second attempt run past the
    // proxy budget. If there's not enough time left, fail fast.
    let attemptTimeout = TIMEOUT_MS;
    if (deadlineAt) {
      const remaining = deadlineAt - Date.now() - 500;
      if (remaining <= 0) throw new Error('Timeout: deadline budget exhausted before attempt');
      attemptTimeout = Math.min(TIMEOUT_MS, remaining);
    }
    const response = await fetchWithTimeout(url, { method: 'POST', headers, body }, attemptTimeout);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Azure OpenAI error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }, { maxAttempts, retryOnTimeout, deadlineAt });
}

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { messages, maxTokens } = req.body;
    const content = await callAzureOpenAI(messages, maxTokens || 600);
    res.json({ content });
  } catch (err) {
    console.error('AI chat error:', err.message);
    res.status(500).json({ error: 'Smart Assistant is temporarily unavailable.' });
  }
});

app.post('/api/ai/recommendations', async (req, res) => {
  try {
    const { systemPrompt, userPrompt, maxTokens } = req.body;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const content = await callAzureOpenAI(messages, maxTokens || 400);
    res.json({ content });
  } catch (err) {
    console.error('AI recommendations error:', err.message);
    res.status(500).json({ error: 'Smart recommendations unavailable.' });
  }
});

app.post('/api/ai/alerts', async (req, res) => {
  try {
    const { systemPrompt, userPrompt, maxTokens } = req.body;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const content = await callAzureOpenAI(messages, maxTokens || 400);
    res.json({ content });
  } catch (err) {
    console.error('AI alerts error:', err.message);
    res.status(500).json({ error: 'Smart alerts unavailable.' });
  }
});

app.post('/api/ai/overview', async (req, res) => {
  try {
    const { systemPrompt, userPrompt, maxTokens } = req.body;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const content = await callAzureOpenAI(messages, maxTokens || 400);
    res.json({ content });
  } catch (err) {
    console.error('AI overview error:', err.message);
    res.status(500).json({ error: 'Smart summary unavailable.' });
  }
});

app.post('/api/ai/analytics', async (req, res) => {
  try {
    const { systemPrompt, userPrompt, maxTokens } = req.body;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const content = await callAzureOpenAI(messages, maxTokens || 400);
    res.json({ content });
  } catch (err) {
    console.error('AI analytics error:', err.message);
    res.status(500).json({ error: 'Smart insights unavailable.' });
  }
});

app.post('/api/ai/report_insight', async (req, res) => {
  try {
    const { systemPrompt, userPrompt, maxTokens } = req.body;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const content = await callAzureOpenAI(messages, maxTokens || 700);
    res.json({ content });
  } catch (err) {
    console.error('AI report insight error:', err.message);
    res.status(500).json({ error: 'Report insight unavailable.' });
  }
});

app.post('/api/ai/auto-sequence', async (req, res) => {
  const { systemPrompt, userPrompt, maxTokens, line } = req.body;
  const tag = line ? `[${line}]` : '';
  console.log(`AI auto-sequence${tag}: request received (maxTokens=${maxTokens || 2000})`);
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    // Interactive path: EXACTLY ONE bounded Azure attempt per HTTP request,
    // capped well under Replit's 60 s proxy limit. The client (limiter +
    // single graceful retry in callSequenceStrategyAI) is the sole retry owner,
    // so each retry is a fresh request with a fresh proxy budget — this avoids
    // stacking server retries on top of client retries (which previously made
    // a single line cost up to ~165 s and orphan the connection).
    const content = await callAzureOpenAI(messages, maxTokens || 2000, {
      timeoutMs: 50_000,
      maxAttempts: 1,
      retryOnTimeout: false,
    });
    console.log(`AI auto-sequence${tag}: OK (${content.length} chars)`);
    res.json({ content });
  } catch (err) {
    console.error(`AI auto-sequence${tag} error:`, err.message);
    res.status(500).json({ error: 'Auto-sequence analysis unavailable.', detail: err.message });
  }
});

// ── Stage 5.5: Plant-wide AI load rebalance ──────────────────────────────
// Called between the deterministic combine+placement step and the per-line AI
// sequencing. Receives a compact plant-wide snapshot and returns up to 5 cross-
// line order diversions aimed at MTO deadline protection and queue balancing.
// Same Azure model + one-bounded-attempt pattern as /api/ai/auto-sequence.
app.post('/api/ai/plant-rebalance', async (req, res) => {
  try {
    const { systemPrompt, userPrompt, maxTokens } = req.body;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const content = await callAzureOpenAI(messages, maxTokens || 300, {
      timeoutMs: 50_000,
      maxAttempts: 1,
      retryOnTimeout: false,
    });
    console.log(`[plant-rebalance] OK (${content.length} chars)`);
    res.json({ content });
  } catch (err) {
    console.error('[plant-rebalance] error:', err.message);
    res.status(500).json({ error: 'Plant rebalance unavailable.', detail: err.message });
  }
});

app.post('/api/ai/suggest-start', async (req, res) => {
  try {
    const { systemPrompt, userPrompt, maxTokens } = req.body;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const content = await callAzureOpenAI(messages, maxTokens || 200);
    res.json({ content });
  } catch (err) {
    console.error('AI suggest-start error:', err.message);
    res.status(500).json({ error: 'Smart date suggestion unavailable.' });
  }
});

// ── Fulfillment (Demo): AI re-order placement (date + insertion position) ──
app.post('/api/ai/reorder-placement', async (req, res) => {
  try {
    const { systemPrompt, userPrompt, maxTokens } = req.body;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const content = await callAzureOpenAI(messages, maxTokens || 700);
    res.json({ content });
  } catch (err) {
    console.error('AI reorder-placement error:', err.message);
    res.status(500).json({ error: 'Re-order placement analysis unavailable.', detail: err.message });
  }
});

// ── Smart Demand AI: batch forecast per SKU ──────────────────────────────
function hashHistoricalRecords(records) {
  const sorted = [...records].sort((a, b) => (a.period < b.period ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

async function callSmartDemandAI(skus) {
  const systemPrompt = `You are a demand analyst for a feed manufacturing plant.
For each SKU you will receive actual historical demand records for the same calendar month across multiple years.
Your task: analyse those records and return one AI-assessed Smart Demand value per SKU (in metric tons).
Rules:
- The records provided are already filtered to the relevant month — analyse them for trend, recency bias, and year-over-year pattern
- Weight more recent years more heavily; account for any clear upward or downward trend
- Produce exactly one numeric value per SKU — your AI-assessed demand for that focus month
- Return ONLY valid JSON: {"key1": 1234.5, "key2": 678.9} — no markdown, no explanation, no prose
- All values must be positive numbers; never return null, NaN, or negative values
- If only one record exists, return that value as-is
- If no records exist, return 0
- IMPORTANT: use only the provided historical records as input — do not invent or reference any other data`;

  const userPrompt = `Analyse the same-month historical demand for each SKU and return one AI-assessed Smart Demand (MT) value per SKU.
Return JSON only: {"key1": 1234.5, "key2": 678.9, ...}

${skus.map(s => {
  const histLines = s.historicalRecords.map(r => `${r.period}: ${Number(r.demandMT).toFixed(1)} MT`).join(', ');
  return `key="${s.key}" sku="${s.sku}" desc="${s.description}" focusMonth="${s.focusMonth || ''}" history=[${histLines || 'no records'}]`;
}).join('\n')}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const raw = await callAzureOpenAI(messages, Math.min(400 + skus.length * 20, 1500));
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON object found in AI response');
  return JSON.parse(jsonMatch[0]);
}

app.post('/api/ai/smart-demand', async (req, res) => {
  try {
    const { skus, force } = req.body;
    if (!Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'skus array required' });
    }
    console.log(`[Smart Demand AI] Received batch of ${skus.length} SKU(s), force=${!!force}`);

    // Attach input hashes to each SKU entry
    const skusWithHash = skus.map(s => ({
      ...s,
      inputHash: hashHistoricalRecords(s.historicalRecords || []),
    }));

    // ── DB cache lookup (skipped when force=true or in memory mode) ──────────
    const cachedResults = {};
    let uncached = skusWithHash;

    if (!force && !USE_MEMORY && pool) {
      const keys = skusWithHash.map(s => s.key);
      const dbRes = await pool.query(
        `SELECT cache_key, input_hash, value FROM smart_demand_cache WHERE cache_key = ANY($1)`,
        [keys]
      );
      const dbMap = new Map(dbRes.rows.map(r => [`${r.cache_key}:${r.input_hash}`, parseFloat(r.value)]));

      uncached = skusWithHash.filter(s => !dbMap.has(`${s.key}:${s.inputHash}`));
      for (const s of skusWithHash) {
        const val = dbMap.get(`${s.key}:${s.inputHash}`);
        if (val !== undefined) cachedResults[s.key] = val;
      }
      console.log(`[Smart Demand Cache] ${Object.keys(cachedResults).length} hit(s), ${uncached.length} miss(es)`);
    }

    // All results served from cache — return immediately
    if (uncached.length === 0) {
      return res.json({ results: cachedResults, fromCache: true });
    }

    // ── Call AI for uncached items ────────────────────────────────────────────
    const aiResults = await callSmartDemandAI(uncached);
    console.log(`[Smart Demand AI] Returned ${Object.keys(aiResults).length} forecast(s)`);

    // ── Persist new results to DB ─────────────────────────────────────────────
    if (!USE_MEMORY && pool) {
      for (const s of uncached) {
        const val = aiResults[s.key];
        if (val !== undefined && !isNaN(parseFloat(val))) {
          await pool.query(
            `INSERT INTO smart_demand_cache (cache_key, input_hash, value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (cache_key, input_hash) DO UPDATE SET value = $3, updated_at = NOW()`,
            [s.key, s.inputHash, parseFloat(val)]
          ).catch(e => console.warn('[Smart Demand Cache] write error:', e.message));
        }
      }
    }

    res.json({ results: { ...cachedResults, ...aiResults } });
  } catch (err) {
    console.error('[Smart Demand AI] error:', err.message);
    res.status(500).json({ error: 'Smart Demand AI unavailable.', detail: err.message });
  }
});

app.get('/api/apps/public/prod/public-settings/by-id/:appId', (req, res) => {
  res.json({ id: req.params.appId, public_settings: { auth_required: false } });
});

const PORT = parseInt(process.env.PORT || "5000");

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running in production on port ${PORT}`);
  });
} else {
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: true,
      allowedHosts: true,
    },
    appType: 'spa',
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Pipeline Inspector HTML page — serves a readable stage trace right in the
  // browser without needing JupyterLab. GET /pipeline-inspector
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/pipeline-inspector', async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.write(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pipeline Inspector — NexFeed</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;line-height:1.5}
  h1{font-size:1.4rem;color:#7dd3fc;margin-bottom:4px}
  .sub{color:#94a3b8;font-size:.85rem;margin-bottom:24px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;margin-bottom:16px}
  .stage-hdr{display:flex;align-items:center;gap:10px;margin-bottom:12px}
  .badge{background:#0f172a;border:1px solid #475569;border-radius:6px;padding:2px 10px;font-size:.78rem;color:#7dd3fc;font-weight:600}
  .ok{color:#4ade80}.warn{color:#fbbf24}.err{color:#f87171}
  .label{font-size:.75rem;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
  .val{font-size:.95rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:14px}
  .stat{background:#0f172a;border-radius:8px;padding:12px}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155;font-weight:500}
  td{padding:8px 12px;border-bottom:1px solid #1e293b;vertical-align:top}
  tr:last-child td{border-bottom:none}
  pre{background:#0f172a;padding:14px;border-radius:8px;font-size:.78rem;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;border:1px solid #1e293b;color:#94a3b8}
  .chip{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.75rem;font-weight:600}
  .chip-ok{background:#052e16;color:#4ade80;border:1px solid #166534}
  .chip-warn{background:#422006;color:#fbbf24;border:1px solid #92400e}
  .chip-err{background:#300;color:#f87171;border:1px solid #7f1d1d}
  .spinner{display:inline-block;width:16px;height:16px;border:2px solid #334155;border-top-color:#7dd3fc;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .running{color:#7dd3fc;margin-bottom:20px;font-size:.95rem}
  details summary{cursor:pointer;color:#94a3b8;font-size:.8rem;margin-bottom:6px}
  details[open] summary{color:#7dd3fc}
</style></head><body>
<h1>🔍 Pipeline Inspector</h1>
<p class="sub">Plant-Wide Auto-Sequence Trace — NexFeed (read-only)</p>
<p class="running" id="status"><span class="spinner"></span>Running pipeline trace (Stages 1 + 2 + 5.5)…</p>
<div id="out"></div>
<script>
async function run(){
  const status=document.getElementById('status');
  const out=document.getElementById('out');
  try{
    const r=await fetch('/api/ai/auto-sequence/trace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'plant',stage55Only:true})});
    const d=await r.json();
    if(!d.ok){status.innerHTML='<span class="err">✘ Trace failed: '+d.error+'</span>';return;}
    status.innerHTML='<span class="ok">✔ Trace complete</span>';
    const stages=d.stages||[];
    const byNo={};stages.forEach(s=>{const k=String(s.stageNo);(byNo[k]||(byNo[k]=[])).push(s);});
    const meta=d.meta||{};
    const rb=d.plantRebalance||{};
    let html='';

    // ── Meta summary
    html+=\`<div class="card"><div class="stage-hdr"><span class="badge">Overview</span></div>
    <div class="grid">
      <div class="stat"><div class="label">Orders</div><div class="val">\${meta.ordersTotal||'—'}</div></div>
      <div class="stat"><div class="label">Lines</div><div class="val">\${(meta.lines||[]).length}</div></div>
      <div class="stat"><div class="label">Total time</div><div class="val">\${meta.totalMs?meta.totalMs+'ms':'—'}</div></div>
      <div class="stat"><div class="label">Read-only</div><div class="val ok">\${d.readOnly?'✔ Yes':'No'}</div></div>
    </div></div>\`;

    // ── Stage 1
    const s1=(byNo['1']||[])[0];
    if(s1){
      const sd=s1.data||{};
      html+=\`<div class="card"><div class="stage-hdr"><span class="badge">Stage 1</span><strong>Data Gathering</strong><small style="color:#64748b">\${s1.elapsedMs||0}ms</small></div>
      <div class="grid">
        <div class="stat"><div class="label">Orders</div><div class="val">\${sd.ordersTotal}</div></div>
        <div class="stat"><div class="label">KB records</div><div class="val">\${sd.kbRecords}</div></div>
        <div class="stat"><div class="label">N10D records</div><div class="val">\${sd.n10dRecords}</div></div>
        <div class="stat"><div class="label">Inferred targets</div><div class="val">\${sd.inferredTargets}</div></div>
      </div>
      <div class="label" style="margin-bottom:6px">Orders by line</div>
      <table><tr>\${Object.keys(sd.ordersByLine||{}).map(l=>'<th>'+l+'</th>').join('')}</tr>
      <tr>\${Object.values(sd.ordersByLine||{}).map(v=>'<td>'+v+'</td>').join('')}</tr></table>
      </div>\`;
    }

    // ── Stage 2
    const s2=(byNo['2']||[])[0];
    if(s2){
      const sd=s2.data||{};const ss=sd.summaryStats||{};
      html+=\`<div class="card"><div class="stage-hdr"><span class="badge">Stage 2</span><strong>Combine + Line-Balance (pre-AI)</strong><small style="color:#64748b">\${s2.elapsedMs||0}ms</small></div>
      <div class="grid">
        <div class="stat"><div class="label">Orders before</div><div class="val">\${ss.totalOrdersBefore||'—'}</div></div>
        <div class="stat"><div class="label">Orders after</div><div class="val">\${ss.totalOrdersAfter||'—'}</div></div>
        <div class="stat"><div class="label">Combined</div><div class="val">\${ss.ordersCombined||0}</div></div>
        <div class="stat"><div class="label">Moved between lines</div><div class="val">\${ss.ordersMovedBetweenLines||0}</div></div>
        <div class="stat"><div class="label">Lines affected</div><div class="val">\${ss.linesAffected||0}</div></div>
      </div>
      \${(ss.perLineSummary||[]).length?'<div class="label" style="margin-bottom:6px">Per-line summary</div><table><tr><th>Line</th><th>Before</th><th>After</th><th>Before MT</th><th>After MT</th><th>Δ Hours</th></tr>'+(ss.perLineSummary||[]).map(l=>'<tr><td>'+l.line+'</td><td>'+l.beforeCount+'</td><td>'+l.afterCount+'</td><td>'+l.beforeMT+'</td><td>'+l.afterMT+'</td><td>'+(l.hoursDiff>0?'<span class="ok">+':'<span class="warn">')+l.hoursDiff.toFixed(1)+'h</span></td></tr>').join('')+'</table>':''}
      </div>\`;
    }

    // ── Stage 5.5
    const rb55=(byNo['5.5']||[])[0];
    const rbData=rb||((rb55||{}).data)||{};
    const skipped=rbData.skipped;const rbErr=rbData.error;const divs=rbData.diversions||[];const rejected=rbData.skippedDiversions||[];
    const statusChip=skipped?'<span class="chip chip-warn">SKIPPED</span>':rbErr?'<span class="chip chip-err">ERROR</span>':'<span class="chip chip-ok">OK</span>';
    html+=\`<div class="card"><div class="stage-hdr"><span class="badge">Stage 5.5</span><strong>Plant-Wide AI Load Rebalance</strong>\${statusChip}<small style="color:#64748b">\${rbData.elapsedMs?rbData.elapsedMs+'ms':'—'}</small></div>
    <div class="grid">
      <div class="stat"><div class="label">Diversions</div><div class="val">\${rbData.diversionsApplied||divs.length}</div></div>
      <div class="stat"><div class="label">Prompt tokens</div><div class="val">~\${rbData.promptTokenEst||0}</div></div>
      \${skipped?'<div class="stat"><div class="label">Skip reason</div><div class="val warn">'+rbData.skipReason+'</div></div>':''}
      \${rbErr?'<div class="stat"><div class="label">Error</div><div class="val err">'+rbErr+'</div></div>':''}
    </div>
    \${divs.length?'<div class="label" style="margin-bottom:6px">Diversions applied</div><table><tr><th>#</th><th>Order</th><th>From</th><th>To</th><th>AI Reason</th></tr>'+divs.map((dv,i)=>'<tr><td>'+(i+1)+'</td><td>'+dv.orderName+'</td><td>'+dv.fromLine+'</td><td><strong class="ok">'+dv.toLine+'</strong></td><td style="color:#94a3b8">'+dv.reason+'</td></tr>').join('')+'</table>':'<p style="color:#64748b;font-size:.85rem">No diversions — AI determined load is already balanced.</p>'}
    \${rejected.length?'<div class="label" style="margin:12px 0 6px">Rejected by no-regression guard ('+rejected.length+')</div><table><tr><th>#</th><th>Order</th><th>From → To</th><th>Peak before → after (h)</th><th>AI Reason</th></tr>'+rejected.map((dv,i)=>'<tr><td>'+(i+1)+'</td><td>'+dv.orderName+'</td><td>'+dv.fromLine+' → '+dv.toLine+'</td><td><span class="warn">'+dv.beforeMaxHours+' → '+dv.afterMaxHours+'</span></td><td style="color:#94a3b8">'+dv.reason+'</td></tr>').join('')+'</table>':''}
    </div>\`;

    // ── Validation box
    html+=\`<div class="card"><div class="stage-hdr"><span class="badge">Validation</span><strong>Stage 5.5 Checks</strong></div>\`;
    if(!rb55&&!rb){html+='<p class="err">✘ Stage 5.5 not found in trace</p>';}
    else if(skipped){html+='<p class="warn">⚠ Stage 5.5 was skipped: '+rbData.skipReason+'</p>';}
    else if(rbErr){html+='<p class="err">✘ Stage 5.5 error: '+rbErr+'</p>';}
    else{html+='<p class="ok">✔ Stage 5.5 ran successfully (\${rbData.elapsedMs||0}ms, ~\${rbData.promptTokenEst||0} tokens)</p>';}
    html+='<br><p class="'+(d.readOnly?'ok':'warn')+'">'+(d.readOnly?'✔':'⚠')+' Read-only: '+d.readOnly+'</p></div>';

    out.innerHTML=html;
  }catch(e){document.getElementById('status').innerHTML='<span class="err">✘ Error: '+e.message+'</span>';}
}
run();
</script></body></html>`);
    res.end();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Instrumented, STRICTLY READ-ONLY plant-wide auto-sequence trace endpoint.
  //
  // This drives the REAL JS pipeline modules (the same code the browser runs)
  // end-to-end and returns a stage-by-stage trace. It NEVER writes, persists,
  // or mutates any data — it only SELECTs from the DB and runs pure compute.
  //
  // Stages:
  //   1 Data Gathering       (this handler)
  //   2 Combine + Line-Balance (pre-AI)  → plantCombinePlace factory
  //   3 Per-line Pre-Sort    ┐
  //   4 Prompt Construction  │
  //   5 Azure OpenAI Call    ├ generateSequenceStrategies(...) trace hooks
  //   6 Parse + Post-Process │
  //   7 Metrics / Simulation ┘
  //   8 Result               (this handler)
  //
  // Dev-only: it lives inside the Vite (non-production) branch and uses
  // vite.ssrLoadModule to load the real ESM pipeline modules in Node.
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/ai/auto-sequence/trace', async (req, res) => {
    const T0 = Date.now();
    const stages = [];
    const pushStage = (entry) => { stages.push({ ts: Date.now(), ...entry }); return entry; };
    const prevAiBase = globalThis.__AI_BASE_URL__;
    // ── Config (from request body) ───────────────────────────────────────────
    // demo=true reads the isolated Fulfillment (Demo) dataset (demo_orders /
    // demo_next_10_days_*). The demo reuses the LIVE knowledge_base and
    // powermix_split_rules (there are no demo_* equivalents), mirroring the app.
    const useDemo = req.body?.demo === true || req.body?.scope === 'demo';
    const ORDERS_TABLE = useDemo ? 'demo_orders' : 'orders';
    const N10D_TABLE = useDemo ? 'demo_next_10_days_records' : 'next_10_days_records';
    const N10D_UPLOADS_TABLE = useDemo ? 'demo_next_10_days_uploads' : 'next_10_days_uploads';
    try {
      // ─── Stage 1: Data Gathering (READ-ONLY) ──────────────────────────────
      const s1 = Date.now();
      const orders = (await pool.query(`SELECT * FROM ${ORDERS_TABLE}`)).rows;

      const kbSession = (await pool.query(
        'SELECT upload_session_id FROM knowledge_base_uploads ORDER BY created_date DESC LIMIT 1'
      )).rows[0]?.upload_session_id || null;
      const kbRecords = kbSession
        ? (await pool.query('SELECT * FROM knowledge_base WHERE upload_session_id = $1', [kbSession])).rows
        : (await pool.query('SELECT * FROM knowledge_base')).rows;

      const n10dSession = (await pool.query(
        `SELECT upload_session_id FROM ${N10D_UPLOADS_TABLE} ORDER BY created_date DESC LIMIT 1`
      )).rows[0]?.upload_session_id || null;
      const n10dRecords = n10dSession
        ? (await pool.query(`SELECT * FROM ${N10D_TABLE} WHERE upload_session_id = $1`, [n10dSession])).rows
        : (await pool.query(`SELECT * FROM ${N10D_TABLE}`)).rows;

      let pmxSplitRules = [];
      try { pmxSplitRules = (await pool.query('SELECT * FROM powermix_split_rules ORDER BY id ASC')).rows; } catch { pmxSplitRules = []; }

      // Load REAL pipeline modules via Vite SSR (no logic re-implemented here).
      const { makePlantLevelCombineAndPlace } = await vite.ssrLoadModule('/src/services/plantCombinePlace.js');
      const aiMod = await vite.ssrLoadModule('/src/services/aiSequenceStrategies.js');
      const coMod = await vite.ssrLoadModule('/src/utils/changeoverCalc.js');
      const statusMod = await vite.ssrLoadModule('/src/utils/statusUtils.js');
      const { getProductStatus } = statusMod;
      const { calculateAdditionalChangeover, getFallbackChangeoverRules } = coMod;
      // Load the SAME changeover-rules source the Dashboard uses. In Node
      // (no localStorage) getDefaultChangeoverRules() returns the dashboard's
      // built-in default set — identical to what the live UI starts with —
      // not the leaner getFallbackChangeoverRules() shape.
      let getDefaultChangeoverRules = null;
      try {
        ({ getDefaultChangeoverRules } = await vite.ssrLoadModule('/src/pages/ChangeoverRulesPage.jsx'));
      } catch (e) {
        console.warn('[auto-sequence/trace] ChangeoverRulesPage SSR load failed, falling back:', e?.message);
      }

      // ── Server-side deps for the factory ──────────────────────────────────
      // These are the SAME small pure helpers Dashboard.jsx injects (volume
      // parsing, ceiling rounding, line run-rates). The substantive combine/
      // place + AI logic is the real module code, not re-implemented here.
      const PLANT_ALL_LINES = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5', 'Line 6', 'Line 7'];
      const PLANT_LINE_TO_FM_LABEL = {
        'Line 1': 'Feedmill 1', 'Line 2': 'Feedmill 1',
        'Line 3': 'Feedmill 2', 'Line 4': 'Feedmill 2',
        'Line 5': 'Powermix',
        'Line 6': 'Feedmill 3', 'Line 7': 'Feedmill 3',
      };
      const PLANT_RUN_RATE_COL = {
        'Line 1': 'line_1_run_rate', 'Line 2': 'line_2_run_rate',
        'Line 3': 'line_3_run_rate', 'Line 4': 'line_4_run_rate',
        'Line 5': 'line_5_run_rate',
        'Line 6': 'line_6_run_rate', 'Line 7': 'line_7_run_rate',
      };
      const BATCH_SIZE_COL = {
        'Line 1': 'batch_size_fm1', 'Line 2': 'batch_size_fm1',
        'Line 3': 'batch_size_fm2', 'Line 4': 'batch_size_fm2',
        'Line 5': 'batch_size_pmx',
        'Line 6': 'batch_size_fm3', 'Line 7': 'batch_size_fm3',
      };
      const PLANT_MAX_COMBINE_MT = 200;
      const LINE_RUN_RATES = { 'Line 1': 20, 'Line 2': 20, 'Line 3': 10, 'Line 4': 10, 'Line 5': 10, 'Line 6': 10, 'Line 7': 10 };
      const getLineRunRate = (line) => LINE_RUN_RATES[line] || 10;
      const normalizeLine = (line) => {
        if (!line) return '';
        const s = String(line).trim();
        const m1 = s.match(/^line\s*(\d+)$/i); if (m1) return `Line ${m1[1]}`;
        const m2 = s.match(/^l(\d+)$/i); if (m2) return `Line ${m2[1]}`;
        return s;
      };
      const getOrderVolumeMT = (order) => {
        for (const v of [order.volume_override, order.volume, order.total_volume_mt, order.volume_mt]) {
          const p = parseFloat(v);
          if (!Number.isNaN(p) && p > 0) return p;
        }
        return 0;
      };
      const getEffectiveDisplayVolumeMT = (order) => {
        if (order.volume_override != null && order.volume_override !== '') {
          const ov = parseFloat(order.volume_override);
          if (!Number.isNaN(ov)) return Number(ov.toFixed(2));
        }
        const rawVol = parseFloat(order.total_volume_mt ?? 0) || 0;
        const bs = parseFloat(order.batch_size ?? 0) || 0;
        if (bs > 0) return Number((Math.ceil(rawVol / bs) * bs).toFixed(2));
        return Number(rawVol.toFixed(2));
      };
      const calculateEffectiveLineTotalMT = (lineOrders) =>
        Number(((lineOrders || []).reduce((s, o) => s + getEffectiveDisplayVolumeMT(o), 0)).toFixed(2));
      // Mirror the UI's "Total Hrs" basis exactly: recompute production hours per order
      // (effVol ÷ own run rate, Mash → 0) via the shared @/utils/lineHours helper rather
      // than summing the stale stored production_hours, so this trace replica stays in
      // lockstep with calculateLineHoursBreakdown in Dashboard.jsx.
      const { orderProductionHours: _traceProdHrs, orderChangeoverHours: _traceCoHrs, rebuildSummaryAfterFields: _traceRebuildSummary } =
        await vite.ssrLoadModule('/src/utils/lineHours.js');
      const calculateLineHoursBreakdown = (ordersArr) => {
        const prod = Number(((ordersArr || []).reduce((s, o) => s + _traceProdHrs(o), 0)).toFixed(2));
        const co = Number(((ordersArr || []).reduce((s, o) => s + _traceCoHrs(o), 0)).toFixed(2));
        return { productionHours: prod, changeoverHours: co, totalHours: Number((prod + co).toFixed(2)) };
      };
      const calculateQueueTimeHours = (totalMT, runRate) => {
        const mt = parseFloat(totalMT) || 0; const rr = parseFloat(runRate) || 0;
        if (rr <= 0) return 0;
        return Number((mt / rr).toFixed(2));
      };
      const getCombinationBasisVolume = (order) => {
        const rawVolume = parseFloat(order.total_volume_mt ?? order.volume ?? 0) || 0;
        const batchSize = parseFloat(order.batch_size ?? 0) || 0;
        const overrideVolume = parseFloat(order.volume_override);
        if (!Number.isNaN(overrideVolume) && overrideVolume > 0)
          return { basisVolume: overrideVolume, basisType: 'user_override', rawVolume, batchSize };
        if (batchSize > 0 && Math.abs(rawVolume % batchSize) >= 0.001)
          return { basisVolume: rawVolume, basisType: 'app_adjusted_use_raw', rawVolume, batchSize };
        return { basisVolume: rawVolume, basisType: 'raw_divisible', rawVolume, batchSize };
      };
      const adjustVolumeToBatchCeiling = (volume, batchSize) => {
        const v = parseFloat(volume || 0) || 0; const b = parseFloat(batchSize || 0) || 0;
        if (b <= 0) return Number(v.toFixed(2));
        return Number((Math.ceil(v / b) * b).toFixed(2));
      };
      const getEffVolume = (order) => {
        if (order.volume_override != null && order.volume_override !== '') return parseFloat(order.volume_override);
        const orig = parseFloat(order.total_volume_mt) || 0;
        const bs = parseFloat(order.batch_size) || 4;
        if (bs <= 0) return orig;
        return Math.ceil(orig / bs) * bs;
      };
      const calcProductionHours = (order) => {
        if (!order || order.form === 'M') return null;
        const rr = parseFloat(order.run_rate);
        const vol = getEffVolume(order);
        if (!rr || rr <= 0 || !vol || vol <= 0) return null;
        return parseFloat((vol / rr).toFixed(2));
      };
      const previewGetBaseChangeover = (form) => ((form || '').trim().toUpperCase() === 'C' ? 0.33 : 0.17);
      const applyPreviewChangeovers = (rows, changeoverRules) => {
        if (!rows || !rows.length) return rows;
        rows.forEach((order, index) => {
          const st = (order.status || '').toLowerCase();
          if (st === 'completed' || st === 'done' || st === 'cancel_po') {
            const isFrozen = order.frozen_changeover != null;
            const retained = isFrozen ? parseFloat(order.frozen_changeover) : parseFloat(order.changeover_time ?? 0);
            order._effectiveChangeover = retained; order._changeoverTotal = retained;
            order._changeoverBase = retained; order._changeoverAdditional = 0;
            order._changeoverCalculated = false; order._isFrozen = isFrozen;
            return;
          }
          const base = parseFloat(order.changeover_time ?? previewGetBaseChangeover(order.form)) || previewGetBaseChangeover(order.form);
          let following = null;
          for (let j = index + 1; j < rows.length; j++) {
            const s = (rows[j].status || '').toLowerCase();
            if (s !== 'done' && s !== 'completed' && s !== 'cancel_po') { following = rows[j]; break; }
          }
          let changeoverTotal = 0;
          let additionalInfo = { total: 0, breakdown: [], usedBaseOnly: true };
          if (following) {
            additionalInfo = calculateAdditionalChangeover(order, following, changeoverRules || []);
            changeoverTotal = additionalInfo.usedBaseOnly ? base : additionalInfo.total;
          }
          order._effectiveChangeover = changeoverTotal; order._changeoverTotal = changeoverTotal;
          order._changeoverBase = base; order._changeoverAdditional = additionalInfo.usedBaseOnly ? 0 : additionalInfo.total;
          order._changeoverUsedBaseOnly = additionalInfo.usedBaseOnly;
          order._changeoverBreakdown = additionalInfo.breakdown || [];
          order._changeoverCalculated = true;
        });
        return rows;
      };
      // Shutdown state isn't persisted; the trace assumes no line shutdowns.
      const isLineShutdown = () => false;
      const getShutdownReason = () => null;

      // ── inferredTargetMap from latest N10D (same formula as Dashboard) ─────
      const inferredTargetMap = {};
      for (const rec of n10dRecords) {
        if (!rec.material_code) continue;
        const dfl = parseFloat(rec.due_for_loading ?? 0);
        const inv = parseFloat(rec.inventory ?? 0);
        inferredTargetMap[rec.material_code] = {
          targetDate: rec.target_date || null,
          needsProduction: rec.needs_production !== false,
          dueForLoading: rec.due_for_loading ?? null,
          inventory: rec.inventory ?? null,
          note: rec.note || null,
          status: getProductStatus(dfl, inv, rec.daily_values),
        };
      }

      // ── Minimal KB enrichment (batch_size + run_rate) the factory consumes ─
      const kbMap = {};
      for (const r of kbRecords) if (r.fg_material_code) kbMap[String(r.fg_material_code).trim()] = r;
      const pmxBatchMap = {};
      for (const r of pmxSplitRules) if (r.fg_code) pmxBatchMap[String(r.fg_code).trim()] = r;
      const enrichedOrders = orders.map((order) => {
        const fgKey = String(order.material_code || '').trim();
        const entry = kbMap[fgKey];
        const out = { ...order };
        if (entry) {
          const bsKey = BATCH_SIZE_COL[order.feedmill_line];
          const rrKey = PLANT_RUN_RATE_COL[order.feedmill_line];
          if (bsKey && entry[bsKey] != null && entry[bsKey] !== '') out.batch_size = parseFloat(entry[bsKey]);
          if (rrKey && entry[rrKey] != null && entry[rrKey] !== '') out.run_rate = parseFloat(entry[rrKey]);
        }
        const pmxRule = pmxBatchMap[fgKey];
        if (pmxRule && pmxRule.batch_size != null && (order.feedmill_line === 'Line 5' || order.feedmill_line === 'Line 7'))
          out.batch_size = parseFloat(pmxRule.batch_size);
        return out;
      });

      const changeoverRules = (typeof getDefaultChangeoverRules === 'function')
        ? getDefaultChangeoverRules()
        : getFallbackChangeoverRules();
      const changeoverRulesSource = (typeof getDefaultChangeoverRules === 'function')
        ? 'dashboard_default' : 'fallback';

      // Per-line / per-status breakdown for the pipeline inspector notebook.
      const _EXCLUDED_STATUSES_TRACE = new Set([
        'Done', 'Cancel PO', 'In Production', 'On-going',
        'completed', 'cancel_po', 'in_production',
        'ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging',
      ]);
      const _ordersByLine = {}, _ordersByStatus = {};
      let _excludedCount = 0;
      for (const o of enrichedOrders) {
        const ln = o.feedmill_line || 'Unassigned';
        const st = o.status || 'Unknown';
        _ordersByLine[ln] = (_ordersByLine[ln] || 0) + 1;
        _ordersByStatus[st] = (_ordersByStatus[st] || 0) + 1;
        if (_EXCLUDED_STATUSES_TRACE.has(st)) _excludedCount++;
      }

      pushStage({
        stage: 'data_gathering', stageNo: 1, elapsedMs: Date.now() - s1,
        data: {
          scope: useDemo ? 'demo' : 'live',
          ordersTable: ORDERS_TABLE,
          ordersTotal: orders.length,
          ordersByLine: _ordersByLine,
          ordersByStatus: _ordersByStatus,
          excludedCount: _excludedCount,
          kbSession, kbRecords: kbRecords.length,
          n10dSession, n10dRecords: n10dRecords.length,
          pmxSplitRules: pmxSplitRules.length,
          inferredTargets: Object.keys(inferredTargetMap).length,
          inferredTargetMap,
          changeoverRulesSource,
          changeoverRules,
        },
      });

      // ─── Stage 2: Combine + Line-Balance (pre-AI) — REAL factory ──────────
      const s2 = Date.now();
      const plantLevelCombineAndPlace = makePlantLevelCombineAndPlace({
        PLANT_ALL_LINES, PLANT_RUN_RATE_COL, PLANT_LINE_TO_FM_LABEL, PLANT_MAX_COMBINE_MT,
        getLineRunRate, normalizeLine, isLineShutdown, getShutdownReason, inferredTargetMap,
        getOrderVolumeMT, calculateEffectiveLineTotalMT, calculateLineHoursBreakdown,
        calculateQueueTimeHours, getCombinationBasisVolume, adjustVolumeToBatchCeiling,
        calcProductionHours, applyPreviewChangeovers, pmxSplitRules,
      });
      const result = plantLevelCombineAndPlace(enrichedOrders, kbRecords, changeoverRules);
      const sequencedByLine = result.sequencedByLine || {};
      // Pre-combine queue-time snapshot per line (for inspector notebook stage 3).
      const _queueTimeByLine = {};
      for (const [ln, ords] of Object.entries(result.originalByLine || {})) {
        const rr = LINE_RUN_RATES[ln] || 10;
        const totalMT = (ords || []).reduce((s, o) => s + getEffectiveDisplayVolumeMT(o), 0);
        _queueTimeByLine[ln] = {
          totalMT: +totalMT.toFixed(2),
          runRateMtHr: rr,
          queueHours: rr > 0 ? +(totalMT / rr).toFixed(2) : 0,
        };
      }
      pushStage({
        stage: 'combine_line_balance', stageNo: 2, elapsedMs: Date.now() - s2,
        data: {
          summaryStats: result.summaryStats || null,
          placementLog: result.placementLog || null,
          queueTimeByLine: _queueTimeByLine,
          lines: Object.fromEntries(
            Object.entries(sequencedByLine).map(([ln, ords]) => [ln, (ords || []).length])
          ),
        },
      });
      // ─── Stage 5.5: Plant-wide AI load rebalance ─────────────────────────
      // Runs between the deterministic combine+placement step and per-line AI
      // sequencing. Moves orders across lines to protect MTO deadlines and
      // balance queue loads. Line 5 (Powermix) is excluded.
      const rb55 = { diversions: [], skippedDiversions: [], elapsedMs: 0, promptTokenEst: 0, skipped: false };
      if (req.body?.skipAI === true) {
        rb55.skipped = true;
        rb55.skipReason = 'skipAI flag';
      } else {
        try {
          const rbMod = await vite.ssrLoadModule('/src/services/plantRebalanceAI.js');
          const shutdownLines55 = PLANT_ALL_LINES.filter(l => isLineShutdown(l));
          const { systemPrompt: rb55Sys, userPrompt: rb55User } = rbMod.buildRebalancePrompt(
            sequencedByLine, kbRecords, inferredTargetMap, shutdownLines55,
          );
          rb55.promptTokenEst = Math.round((rb55Sys.length + rb55User.length) / 4);
          const rb55T0 = Date.now();
          const rb55Content = await callAzureOpenAI(
            [{ role: 'system', content: rb55Sys }, { role: 'user', content: rb55User }],
            300,
            { timeoutMs: 50_000, maxAttempts: 1, retryOnTimeout: false },
          );
          rb55.elapsedMs = Date.now() - rb55T0;
          const rb55Parsed = rbMod.parseRebalanceResponse(rb55Content);
          if (rb55Parsed.length > 0) {
            const { sequencedByLine: rebalanced, diversionLog, skippedDiversions } = rbMod.applyDiversions(sequencedByLine, rb55Parsed);
            Object.assign(sequencedByLine, rebalanced);
            rb55.diversions = diversionLog;
            rb55.skippedDiversions = skippedDiversions || [];
            // Mirror Dashboard: rebuild perLineSummary "after" fields over the
            // post-diversion lineup so the trace's summary column matches the rows.
            if (result.summaryStats?.perLineSummary) {
              result.summaryStats.perLineSummary = _traceRebuildSummary(
                result.summaryStats.perLineSummary,
                sequencedByLine,
                calculateEffectiveLineTotalMT,
              );
            }
          }
        } catch (rbErr) {
          rb55.error = rbErr?.message || String(rbErr);
          console.warn('[trace Stage 5.5] rebalance failed, continuing:', rb55.error);
        }
      }
      pushStage({
        stage: 'plant_rebalance', stageNo: '5.5', elapsedMs: rb55.elapsedMs,
        data: {
          skipped: rb55.skipped,
          skipReason: rb55.skipReason || null,
          error: rb55.error || null,
          diversionsApplied: rb55.diversions.length,
          diversions: rb55.diversions,
          diversionsRejected: rb55.skippedDiversions.length,
          skippedDiversions: rb55.skippedDiversions,
          promptTokenEst: rb55.promptTokenEst,
        },
      });

      // ── Early-exit for Stage 5.5-only inspection ─────────────────────────────
      // Pass { "stage55Only": true } to run just Stage 5.5 (real AI) and return
      // immediately — skips the slower per-line AI sequencing (Stages 3-7).
      if (req.body?.stage55Only === true || req.body?.skipAI === true) {
        return res.json({
          ok: true,
          readOnly: true,
          skippedAI: true,
          meta: {
            generatedAt: new Date().toISOString(),
            totalMs: Date.now() - T0,
            scope: useDemo ? 'demo' : 'live',
            ordersTotal: orders.length,
            lines: Object.keys(sequencedByLine),
          },
          stages,
          plantRebalance: rb55,
          combinePlace: {
            summaryStats: result.summaryStats || null,
            sequencedByLine,
            originalByLine: result.originalByLine || {},
          },
        });
      }

      // ─── Stages 3-7: per-line AI sequencing — REAL pipeline w/ trace hooks ─
      const trace = { entries: [], add(e) { this.entries.push({ ts: Date.now(), ...e }); } };
      globalThis.__AI_BASE_URL__ = `http://127.0.0.1:${PORT}`;
      const s3 = Date.now();
      const strategies = await aiMod.generateSequenceStrategies(
        sequencedByLine, kbRecords, inferredTargetMap, changeoverRules, undefined, trace
      );
      const aiElapsed = Date.now() - s3;
      // Map the per-line trace.add() entries onto stage numbers for the notebook.
      const STAGE_NO = { pre_sort: 3, prompt_construction: 4, azure_call: 5, parse: 6, post_process: 6, metrics: 7 };
      for (const e of trace.entries) pushStage({ ...e, stageNo: STAGE_NO[e.stage] ?? null });

      // ─── Stage 8: Result ──────────────────────────────────────────────────
      const byLine = strategies?.byLine || {};
      const lineSummaries = {};
      for (const [ln, payload] of Object.entries(byLine)) {
        const opt1 = payload?.ai_option_1 || payload?.rule_based || null;
        lineSummaries[ln] = {
          hasResult: !!payload,
          recommended: payload?.recommended ?? null,
          aiFailed: opt1?.aiFailed ?? null,
          optionCount: ['rule_based', 'ai_option_1', 'ai_option_2'].filter((k) => payload?.[k]).length,
          ai1Orders: (payload?.ai_option_1?.orders || []).length,
          ai2Orders: (payload?.ai_option_2?.orders || []).length,
          ruleBasedOrders: (payload?.rule_based?.orders || []).length,
        };
      }
      pushStage({
        stage: 'result', stageNo: 8, elapsedMs: aiElapsed,
        data: { runDate: strategies?._runDate ?? null, lines: lineSummaries },
      });

      return res.json({
        ok: true,
        readOnly: true,
        meta: {
          generatedAt: new Date().toISOString(),
          totalMs: Date.now() - T0,
          aiBaseUrl: globalThis.__AI_BASE_URL__,
          ordersTotal: orders.length,
          lines: Object.keys(sequencedByLine),
        },
        stages,
        perLineResult: strategies || {},
        combinePlace: { summaryStats: result.summaryStats || null, sequencedByLine, originalByLine: result.originalByLine || {} },
      });
    } catch (err) {
      console.error('[auto-sequence/trace] error:', err);
      return res.status(500).json({ ok: false, error: err?.message || String(err), stages });
    } finally {
      // Restore the AI base override so nothing else is affected.
      if (prevAiBase === undefined) delete globalThis.__AI_BASE_URL__;
      else globalThis.__AI_BASE_URL__ = prevAiBase;
    }
  });

  app.use(vite.middlewares);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}
