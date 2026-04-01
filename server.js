import express from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── In-Memory Mode ───────────────────────────────────────────────────────────
// When DATABASE_URL is not set the app runs entirely in memory.
// All CRUD works normally; data resets on server restart (ideal for demos/testing).
const USE_MEMORY = !process.env.DATABASE_URL;
if (USE_MEMORY) {
  console.warn('⚠️  DATABASE_URL not set — running in IN-MEMORY mode. Data will reset on restart.');
} 

const pool = USE_MEMORY ? null : new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// In-memory store (used only when USE_MEMORY = true)
let memIdCounter = 1;
const memStore = {
  orders: [],
  knowledge_base: [],
  knowledge_base_uploads: [],
  next_10_days_records: [],
  next_10_days_uploads: [],
  cell_comments: [],
  row_highlights: {},
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
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS row_highlights (
      order_id TEXT PRIMARY KEY,
      color TEXT
    )
  `);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS diversion_data JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS done_timestamp TEXT`).catch(() => {});
}
initTables().catch(console.error);

app.get('/api/cell-comments/presence', async (req, res) => {
  const { orderIds } = req.query;
  if (!orderIds) return res.json([]);
  const ids = orderIds.split(',').filter(Boolean);
  if (!ids.length) return res.json([]);
  if (USE_MEMORY) {
    const rows = memStore.cell_comments.filter(c => ids.includes(c.order_id));
    const seen = new Set();
    const distinct = rows.filter(c => { const k = c.order_id + '|' + c.column_name; if (seen.has(k)) return false; seen.add(k); return true; });
    return res.json(distinct.map(c => ({ order_id: c.order_id, column_name: c.column_name })));
  }
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `SELECT DISTINCT order_id, column_name FROM cell_comments WHERE order_id IN (${placeholders})`,
      ids
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cell-comments', async (req, res) => {
  const { orderId, columnName } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  if (USE_MEMORY) {
    let rows = memStore.cell_comments.filter(c => c.order_id === orderId);
    if (columnName) rows = rows.filter(c => c.column_name === columnName);
    return res.json(rows);
  }
  try {
    let result;
    if (columnName) {
      result = await pool.query(
        'SELECT * FROM cell_comments WHERE order_id = $1 AND column_name = $2 ORDER BY created_at ASC',
        [orderId, columnName]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM cell_comments WHERE order_id = $1 ORDER BY created_at ASC',
        [orderId]
      );
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cell-comments', async (req, res) => {
  const { order_id, column_name = 'row', comment_text, author = 'Planner' } = req.body;
  if (!order_id || !comment_text) return res.status(400).json({ error: 'order_id and comment_text required' });
  if (USE_MEMORY) {
    const row = memCreate('cell_comments', { order_id, column_name, comment_text, author, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return res.json(row);
  }
  try {
    const result = await pool.query(
      'INSERT INTO cell_comments (order_id, column_name, comment_text, author) VALUES ($1, $2, $3, $4) RETURNING *',
      [order_id, column_name, comment_text, author]
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
  const { orderIds } = req.query;
  if (!orderIds) return res.json([]);
  const ids = orderIds.split(',').filter(Boolean);
  if (!ids.length) return res.json([]);
  if (USE_MEMORY) {
    return res.json(ids.filter(id => memStore.row_highlights[id]).map(id => ({ order_id: id, color: memStore.row_highlights[id] })));
  }
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `SELECT * FROM row_highlights WHERE order_id IN (${placeholders})`,
      ids
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/row-highlights', async (req, res) => {
  const { order_id, color } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id required' });
  if (USE_MEMORY) {
    if (!color) { delete memStore.row_highlights[order_id]; } else { memStore.row_highlights[order_id] = color; }
    return res.json({ success: true });
  }
  try {
    if (!color) {
      await pool.query('DELETE FROM row_highlights WHERE order_id = $1', [order_id]);
    } else {
      await pool.query(
        'INSERT INTO row_highlights (order_id, color) VALUES ($1, $2) ON CONFLICT (order_id) DO UPDATE SET color = $2',
        [order_id, color]
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
  if (USE_MEMORY) {
    let rows = memGet(table);
    const sort = req.query.sort || '-created_date';
    const dir = sort.startsWith('-') ? -1 : 1;
    const col = sort.replace(/^-/, '');
    rows.sort((a, b) => { const av = a[col] || ''; const bv = b[col] || ''; return av < bv ? -dir : av > bv ? dir : 0; });
    return res.json(rows.slice(0, parseInt(req.query.limit) || 10000));
  }
  try {
    const sort = req.query.sort || '-created_date';
    const limit = parseInt(req.query.limit) || 10000;
    const dir = sort.startsWith('-') ? 'DESC' : 'ASC';
    const col = sort.replace(/^-/, '');
    const result = await pool.query(
      `SELECT * FROM ${table} ORDER BY ${col} ${dir} LIMIT $1`,
      [limit]
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

app.put('/api/entities/:entity/:id', async (req, res) => {
  const table = TABLE_MAP[req.params.entity];
  if (!table) return res.status(404).json({ error: 'Unknown entity' });
  if (USE_MEMORY) {
    const row = memUpdate(table, req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json(row);
  }
  try {
    const validCols = await getTableColumns(table);
    const data = stringifyJsonFields(filterToValidColumns({ ...req.body, updated_date: new Date() }, validCols));
    const { clause, values } = buildSetClause(data);
    const result = await pool.query(
      `UPDATE ${table} SET ${clause} WHERE id = $${values.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
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

const AZURE_OPENAI_ENDPOINT = 'https://nexfeed-ai.cognitiveservices.azure.com';
const AZURE_OPENAI_DEPLOYMENT = 'gpt-4o-mini';
const AZURE_OPENAI_API_VERSION = '2024-12-01-preview';
const AZURE_OPENAI_KEY = process.env.VITE_AZURE_OPENAI_KEY;
if (!AZURE_OPENAI_KEY) console.warn('Warning: VITE_AZURE_OPENAI_KEY not set. AI features will not work.');

async function callAzureOpenAI(messages, maxTokens = 800) {
  const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': AZURE_OPENAI_KEY,
    },
    body: JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0.7 }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Azure OpenAI error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
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
  try {
    const { systemPrompt, userPrompt, maxTokens } = req.body;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const content = await callAzureOpenAI(messages, maxTokens || 2000);
    res.json({ content });
  } catch (err) {
    console.error('AI auto-sequence error:', err.message);
    res.status(500).json({ error: 'Auto-sequence analysis unavailable.' });
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
  app.use(vite.middlewares);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}
