// SQLite storage and all item logic shared by the REST API, the MCP endpoint and the UI.
require('./env');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22+, no native build step
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'approvals.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  project TEXT,               -- optional: restrict key to one project
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(slug),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',       -- design | copy | email | decision | other
  summary TEXT,                             -- one-line "what I need from you"
  body TEXT,                                -- the content under review
  body_format TEXT NOT NULL DEFAULT 'markdown', -- markdown | text | html
  email_to TEXT,
  email_subject TEXT,
  options TEXT,                             -- JSON [{id,label,detail}]
  attachments TEXT,                         -- JSON [{url,name,type}]
  links TEXT,                               -- JSON [{url,label}]
  agent TEXT,                               -- who submitted it
  priority TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high | urgent
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | changes_requested | superseded | withdrawn
  decision_note TEXT,
  revised_content TEXT,                     -- the reviewer's edited version of the copy, if they rewrote it
  chosen_option TEXT,
  decided_at TEXT,
  acknowledged_at TEXT,                     -- agent has picked up the decision
  callback_url TEXT,
  external_ref TEXT,                        -- agent's own id (task id, PR, ticket)
  parent_id TEXT REFERENCES items(id),      -- earlier version this revises
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_status ON items(status, project);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  data TEXT,
  at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();
const newId = (n = 8) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const KINDS = ['design', 'copy', 'email', 'decision', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const DECISIONS = ['approved', 'rejected', 'changes_requested'];
const PALETTE = ['#e4572e', '#2e86ab', '#8e44ad', '#17a589', '#d68910', '#c0392b', '#2874a6', '#7d8b2a'];

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// ---------- projects ----------
function listProjects({ includeArchived = false } = {}) {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM items i WHERE i.project = p.slug AND i.status = 'pending') AS pending
    FROM projects p ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name`).all();
  return rows;
}
function ensureProject(nameOrSlug, color) {
  const slug = slugify(nameOrSlug);
  if (!slug) throw new Error('project is required');
  let p = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
  if (!p) {
    const count = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
    const name = /[A-Z ]/.test(nameOrSlug) ? String(nameOrSlug).trim() : slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    db.prepare('INSERT INTO projects (slug,name,color,created_at) VALUES (?,?,?,?)').run(slug, name, color || PALETTE[count % PALETTE.length], now());
    p = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
  }
  return p;
}
function updateProject(slug, { name, color, archived }) {
  const p = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
  if (!p) throw httpErr(404, 'project not found');
  db.prepare('UPDATE projects SET name=?, color=?, archived=? WHERE slug=?').run(
    name ?? p.name, color ?? p.color, archived === undefined ? p.archived : archived ? 1 : 0, slug);
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
}

// ---------- api keys ----------
function createKey(label, project) {
  const raw = 'apk_' + crypto.randomBytes(24).toString('base64url');
  const id = newId(10);
  if (project) ensureProject(project);
  db.prepare('INSERT INTO api_keys (id,label,key_hash,key_prefix,project,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, label || 'agent', sha(raw), raw.slice(0, 10), project ? slugify(project) : null, now());
  return { id, label, project: project ? slugify(project) : null, key: raw };
}
function listKeys() {
  return db.prepare('SELECT id,label,key_prefix,project,created_at,last_used_at,revoked_at FROM api_keys ORDER BY created_at DESC').all();
}
function revokeKey(id) {
  db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(), id);
}
function verifyKey(raw) {
  if (!raw) return null;
  const k = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha(raw));
  if (k) db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), k.id);
  return k || null;
}

// ---------- items ----------
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
const J = (v) => (v == null ? null : JSON.stringify(v));
function hydrate(r) {
  if (!r) return r;
  const p = db.prepare('SELECT name,color FROM projects WHERE slug=?').get(r.project) || {};
  return {
    ...r,
    project_name: p.name, project_color: p.color,
    options: r.options ? JSON.parse(r.options) : [],
    attachments: r.attachments ? JSON.parse(r.attachments) : [],
    links: r.links ? JSON.parse(r.links) : [],
  };
}
function logEvent(item_id, type, actor, data) {
  db.prepare('INSERT INTO events (item_id,type,actor,data,at) VALUES (?,?,?,?,?)').run(item_id, type, actor || null, J(data), now());
}

function normalizeList(v, map) {
  if (v == null || v === '') return [];
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  if (!Array.isArray(v)) v = [v];
  return v.map(map).filter(Boolean);
}

function createItem(input, { agentKey, actor } = {}) {
  const project = input.project || agentKey?.project;
  if (!project) throw httpErr(400, 'project is required');
  if (agentKey?.project && slugify(project) !== agentKey.project) throw httpErr(403, `this key can only submit to project "${agentKey.project}"`);
  if (!input.title) throw httpErr(400, 'title is required');
  if (input.callback_url && !/^https?:\/\//i.test(String(input.callback_url))) throw httpErr(400, 'callback_url must be an http(s) URL');
  const p = ensureProject(project);
  const kind = KINDS.includes(input.kind) ? input.kind : (input.email_subject ? 'email' : (input.options?.length ? 'decision' : 'other'));
  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal';

  const options = normalizeList(input.options, (o, i) => typeof o === 'string'
    ? { id: String.fromCharCode(65 + i), label: o }
    : o && o.label ? { id: String(o.id || String.fromCharCode(65 + i)), label: String(o.label), detail: o.detail ? String(o.detail) : undefined } : null);
  const attachments = normalizeList(input.attachments, (a) => typeof a === 'string'
    ? { url: a, name: a.split('/').pop(), type: guessType(a) }
    : a && a.url ? { url: String(a.url), name: a.name || String(a.url).split('/').pop(), type: a.type || guessType(a.url), caption: a.caption } : null);
  const links = normalizeList(input.links, (l) => typeof l === 'string' ? { url: l, label: l } : l && l.url ? { url: l.url, label: l.label || l.url } : null);

  let parent = null, version = 1;
  if (input.parent_id || input.revises) {
    parent = db.prepare('SELECT * FROM items WHERE id=?').get(input.parent_id || input.revises);
    if (!parent) throw httpErr(400, 'parent_id not found');
    version = parent.version + 1;
  }
  const id = newId(8);
  const t = now();
  db.prepare(`INSERT INTO items (id,project,title,kind,summary,body,body_format,email_to,email_subject,options,attachments,links,agent,priority,due_at,callback_url,external_ref,parent_id,version,created_at,updated_at)
    VALUES (@id,@project,@title,@kind,@summary,@body,@body_format,@email_to,@email_subject,@options,@attachments,@links,@agent,@priority,@due_at,@callback_url,@external_ref,@parent_id,@version,@t,@t)`).run({
    id, project: p.slug, title: String(input.title).slice(0, 300), kind,
    summary: input.summary || input.question || null,
    body: input.body ?? input.content ?? null,
    body_format: ['markdown', 'text', 'html'].includes(input.body_format) ? input.body_format : 'markdown',
    email_to: input.email_to || null, email_subject: input.email_subject || null,
    options: options.length ? J(options) : null, attachments: attachments.length ? J(attachments) : null, links: links.length ? J(links) : null,
    agent: input.agent || agentKey?.label || actor || null, priority, due_at: input.due_at || null,
    callback_url: input.callback_url || null, external_ref: input.external_ref || null,
    parent_id: parent?.id || null, version, t,
  });
  if (parent && parent.status === 'pending') {
    db.prepare("UPDATE items SET status='superseded', updated_at=? WHERE id=?").run(t, parent.id);
    logEvent(parent.id, 'superseded', input.agent, { by: id });
  }
  logEvent(id, 'created', input.agent || agentKey?.label, null);
  return getItem(id);
}

function guessType(url) {
  const u = String(url).toLowerCase().split('?')[0];
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(u)) return 'image';
  if (/\.(mp4|mov|webm|m4v)$/.test(u)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg)$/.test(u)) return 'audio';
  if (/\.pdf$/.test(u)) return 'pdf';
  return 'file';
}

function getItem(id) {
  const r = hydrate(db.prepare('SELECT * FROM items WHERE id=?').get(id));
  if (!r) return null;
  // history of earlier versions, newest first, so the reviewer sees what was asked last time
  const history = [];
  let pid = r.parent_id;
  while (pid && history.length < 10) {
    const p = db.prepare('SELECT id,version,status,decision_note,revised_content,chosen_option,decided_at,created_at,parent_id FROM items WHERE id=?').get(pid);
    if (!p) break;
    history.push(p); pid = p.parent_id;
  }
  r.history = history;
  r.events = db.prepare('SELECT type,actor,data,at FROM events WHERE item_id=? ORDER BY id').all(id);
  return r;
}

function listItems({ status, project, since, agent, unacknowledged, limit = 200, q } = {}) {
  const where = [], args = {};
  if (status && status !== 'all') {
    if (status === 'decided') where.push("status IN ('approved','rejected','changes_requested')");
    else { where.push('status = @status'); args.status = status; }
  }
  if (project) { where.push('project = @project'); args.project = slugify(project); }
  if (agent) { where.push('agent = @agent'); args.agent = agent; }
  if (since) { where.push('updated_at > @since'); args.since = since; }
  if (unacknowledged) where.push('acknowledged_at IS NULL');
  if (q) { where.push('(title LIKE @q OR summary LIKE @q OR body LIKE @q)'); args.q = `%${q}%`; }
  const order = status === 'pending'
    ? "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, COALESCE(due_at,'9999'), created_at"
    : 'updated_at DESC';
  const rows = db.prepare(`SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${Math.min(+limit || 200, 500)}`).all(args);
  return rows.map(hydrate);
}

function counts() {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM items GROUP BY status').all();
  const o = { pending: 0, approved: 0, rejected: 0, changes_requested: 0 };
  rows.forEach((r) => (o[r.status] = r.c));
  o.decided_today = db.prepare("SELECT COUNT(*) c FROM items WHERE decided_at >= date('now')").get().c;
  return o;
}

function decide(id, { status, note, revised_content, chosen_option }, actor = 'reviewer') {
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!it) throw httpErr(404, 'item not found');
  if (!DECISIONS.includes(status)) throw httpErr(400, 'status must be approved, rejected or changes_requested');
  if (status !== 'approved' && !String(note || '').trim()) throw httpErr(400, 'a note is required when rejecting or requesting changes');
  const opts = it.options ? JSON.parse(it.options) : [];
  if (status === 'approved' && opts.length && !chosen_option) throw httpErr(400, 'pick one of the options to approve');
  const t = now();
  db.prepare(`UPDATE items SET status=?, decision_note=?, revised_content=?, chosen_option=?, decided_at=?, acknowledged_at=NULL, updated_at=? WHERE id=?`)
    .run(status, note?.trim() || null, revised_content?.trim() || null, chosen_option || null, t, t, id);
  logEvent(id, status, actor, { note, chosen_option, edited: !!revised_content });
  return getItem(id);
}

function reopen(id, actor = 'reviewer') {
  const t = now();
  const r = db.prepare("UPDATE items SET status='pending', decided_at=NULL, acknowledged_at=NULL, updated_at=? WHERE id=? AND status IN ('approved','rejected','changes_requested')").run(t, id);
  if (!r.changes) throw httpErr(400, 'only decided items can be reopened');
  logEvent(id, 'reopened', actor, null);
  return getItem(id);
}

function withdraw(id, actor, agentKey) {
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!it) throw httpErr(404, 'item not found');
  if (agentKey?.project && it.project !== agentKey.project) throw httpErr(403, 'not your project');
  if (it.status !== 'pending') throw httpErr(400, 'only pending items can be withdrawn');
  db.prepare("UPDATE items SET status='withdrawn', updated_at=? WHERE id=?").run(now(), id);
  logEvent(id, 'withdrawn', actor, null);
  return getItem(id);
}

function acknowledge(ids, actor, agentKey) {
  const t = now();
  const stmt = db.prepare(`UPDATE items SET acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL AND status IN ('approved','rejected','changes_requested') ${agentKey?.project ? 'AND project = ?' : ''}`);
  let n = 0;
  for (const id of ids) {
    const r = agentKey?.project ? stmt.run(t, id, agentKey.project) : stmt.run(t, id);
    if (r.changes) { n++; logEvent(id, 'acknowledged', actor, null); }
  }
  return n;
}

function saveUpload(buffer, originalName, mime) {
  const ext = (path.extname(originalName || '') || mimeExt(mime) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const name = newId(12) + ext;
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buffer);
  return { file: name, name: originalName || name, type: guessType(name) };
}
function mimeExt(m) {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'application/pdf': '.pdf', 'video/mp4': '.mp4' })[m];
}

module.exports = {
  db, DATA_DIR, KINDS, PRIORITIES, DECISIONS, slugify, httpErr,
  listProjects, ensureProject, updateProject,
  createKey, listKeys, revokeKey, verifyKey,
  createItem, getItem, listItems, counts, decide, reopen, withdraw, acknowledge, saveUpload,
};
