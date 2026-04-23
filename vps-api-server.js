/**
 * Shit Claude Says — VPS API Server
 * Deploy alongside your existing WebSocket/LiveKit server on vpsmikewolf.duckdns.org
 *
 * Usage:
 *   npm install express better-sqlite3 cors
 *   node vps-api-server.js
 *   # or add to pm2: pm2 start vps-api-server.js --name scs-api
 *
 * Listens on port 4242 by default (proxy via nginx to /api/scs)
 */

const express    = require('express');
const Database   = require('better-sqlite3');
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');
const { execSync } = require('child_process');

const PORT    = process.env.SCS_PORT || 4242;
const DB_PATH = process.env.SCS_DB   || path.join(__dirname, 'scs.db');
// Shared secret with cc hud-ask moderation script
const MOD_TOKEN = process.env.SCS_MOD_TOKEN || 'change-me-in-production';

// ── database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS quotes (
    id          TEXT PRIMARY KEY,
    prompt      TEXT,
    response    TEXT NOT NULL,
    context     TEXT,
    submitter   TEXT DEFAULT 'anonymous',
    tags        TEXT DEFAULT '[]',
    votes       INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'pending',  -- pending | approved | rejected
    created_at  INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_status ON quotes(status);
  CREATE INDEX IF NOT EXISTS idx_votes  ON quotes(votes DESC);
`);

// ── express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));   // tighten to your Netlify domain after launch
app.use(express.json());

// ── public endpoints ──────────────────────────────────────────────────────────

// GET /api/scs/quotes  — approved quotes, sorted by votes desc
app.get('/api/scs/quotes', (req, res) => {
  const rows = db.prepare(
    `SELECT id,prompt,response,context,submitter,tags,votes,created_at
     FROM quotes WHERE status='approved' ORDER BY votes DESC, created_at DESC LIMIT 200`
  ).all();
  rows.forEach(r => r.tags = JSON.parse(r.tags || '[]'));
  res.json(rows);
});

// POST /api/scs/quotes  — submit new quote (goes to pending)
app.post('/api/scs/quotes', (req, res) => {
  const { prompt, response, context, submitter, tags } = req.body;
  if (!response || response.trim().length < 4) {
    return res.status(400).json({ error: 'response required' });
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO quotes (id,prompt,response,context,submitter,tags)
     VALUES (?,?,?,?,?,?)`
  ).run(id, prompt||null, response.trim(), context||null,
        (submitter||'anonymous').slice(0,40), JSON.stringify(tags||[]));

  // Notify Mac moderator via cc hud-ask (fire and forget)
  notifyModerator(id, response.trim(), prompt);

  res.status(201).json({ id, status: 'pending' });
});

// POST /api/scs/quotes/:id/vote
app.post('/api/scs/quotes/:id/vote', (req, res) => {
  db.prepare(`UPDATE quotes SET votes=votes+1 WHERE id=? AND status='approved'`).run(req.params.id);
  res.json({ ok: true });
});

// ── moderation endpoints (token-protected) ────────────────────────────────────

function authMod(req, res) {
  const tok = req.headers['x-mod-token'] || req.query.token;
  if (tok !== MOD_TOKEN) { res.status(403).json({ error: 'forbidden' }); return false; }
  return true;
}

// GET /api/scs/mod/pending
app.get('/api/scs/mod/pending', (req, res) => {
  if (!authMod(req, res)) return;
  const rows = db.prepare(
    `SELECT * FROM quotes WHERE status='pending' ORDER BY created_at ASC LIMIT 50`
  ).all();
  rows.forEach(r => r.tags = JSON.parse(r.tags || '[]'));
  res.json(rows);
});

// POST /api/scs/mod/:id  — body: {action: 'approve'|'reject'}
app.post('/api/scs/mod/:id', (req, res) => {
  if (!authMod(req, res)) return;
  const { action } = req.body;
  if (!['approve','reject'].includes(action)) return res.status(400).json({ error: 'bad action' });
  const status = action === 'approve' ? 'approved' : 'rejected';
  db.prepare(`UPDATE quotes SET status=? WHERE id=?`).run(status, req.params.id);
  res.json({ ok: true, status });
});

// ── Mac moderation bridge ─────────────────────────────────────────────────────
// When a new quote arrives, this POSTs to the cc-bridge relay on the Mac
// so cc hud-ask pops up with Confirm/Reject/Partial buttons.
// The Mac-side moderator script (scs-moderator.sh) polls /api/scs/mod/pending
// and calls: cc hud-ask "Approve? [quote]" then POSTs result back.

const CC_BRIDGE_RELAY = process.env.CC_BRIDGE_RELAY || null;  // e.g. ws://mac-ip:3333

function notifyModerator(id, response, prompt) {
  if (!CC_BRIDGE_RELAY) return;
  // Fire off a webhook to the relay — the relay forwards to cc hud-ask on the Mac
  const msg = prompt
    ? `New SCS submission:\n"${prompt.slice(0,80)}"\n→ "${response.slice(0,120)}"`
    : `New SCS submission:\n"${response.slice(0,160)}"`;
  try {
    // Use curl so we don't need an http client dep
    execSync(
      `curl -s -X POST ${CC_BRIDGE_RELAY}/notify -H 'Content-Type: application/json' ` +
      `-d '{"title":"SCS Moderation","message":${JSON.stringify(msg)},"id":${JSON.stringify(id)}}'`,
      { timeout: 3000 }
    );
  } catch (_) {}
}

// ── start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`SCS API listening on :${PORT}`));
