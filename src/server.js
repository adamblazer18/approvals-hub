// Approvals hub: one queue for every decision agents are waiting on.
require('./env');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const store = require('./db');
const notify = require('./notify');
const { mountMcp } = require('./mcp');
const { resolveAttachments } = require('./attachments');

const PORT = +process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_UPLOAD_MB = +process.env.MAX_UPLOAD_MB || 50;
if (!ADMIN_PASSWORD) { console.error('ADMIN_PASSWORD is not set. Copy .env.example to .env and fill it in.'); process.exit(1); }
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET not set: sessions will reset on restart.');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: `${MAX_UPLOAD_MB * 1.4}mb` }));
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); next(); });

// ---------- auth ----------
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function makeSession() {
  const exp = Date.now() + 30 * 864e5;
  const v = `admin.${exp}`;
  return `${v}.${sign(v)}`;
}
function validSession(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf('.');
  const v = tok.slice(0, i), s = tok.slice(i + 1);
  const good = sign(v);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return false;
  return +v.split('.')[1] > Date.now();
}
function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : req.get('x-api-key') || null;
}
function auth(req, res, next) {
  if (validSession(req.cookies.sess)) { req.actor = 'reviewer'; req.isAdmin = true; return next(); }
  const key = store.verifyKey(bearer(req));
  if (key) { req.agentKey = key; req.actor = key.label; return next(); }
  res.status(401).json({ error: 'unauthorized' });
}
const adminOnly = (req, res, next) => (req.isAdmin ? next() : res.status(403).json({ error: 'admin only' }));

// Failed sign-ins slow down per client address, so one attacker can't lock the reviewer out.
const failures = new Map();
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  const pw = String(req.body.password || '');
  const ok = crypto.timingSafeEqual(digest(pw), digest(ADMIN_PASSWORD));
  if (!ok) {
    const n = (failures.get(req.ip) || 0) + 1;
    failures.set(req.ip, n);
    if (failures.size > 10000) failures.clear();
    await new Promise((r) => setTimeout(r, Math.min(n, 10) * 400));
    return res.redirect('/login?e=1');
  }
  failures.delete(req.ip);
  res.cookie('sess', makeSession(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 864e5 });
  res.redirect('/');
});
app.post('/logout', (req, res) => { res.clearCookie('sess'); res.redirect('/login'); });
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- helpers ----------
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20 } });

// ---------- API ----------
const api = express.Router();
api.use(auth);

api.get('/me', (req, res) => res.json({ actor: req.actor, admin: !!req.isAdmin, project: req.agentKey?.project || null }));
api.get('/summary', wrap((req, res) => res.json({ counts: store.counts(), projects: store.listProjects() })));
api.get('/projects', wrap((req, res) => res.json(store.listProjects({ includeArchived: req.query.all === '1' }))));
api.post('/projects', adminOnly, wrap((req, res) => res.json(store.ensureProject(req.body.name, req.body.color))));
api.patch('/projects/:slug', adminOnly, wrap((req, res) => res.json(store.updateProject(req.params.slug, req.body))));

api.get('/items', wrap((req, res) => {
  const q = { ...req.query };
  if (req.agentKey?.project) q.project = req.agentKey.project;
  res.json(store.listItems(q).map(notify.absolutize));
}));
api.get('/items/:id', wrap((req, res) => {
  const it = store.getItem(req.params.id);
  if (!it || (req.agentKey?.project && it.project !== req.agentKey.project)) return res.status(404).json({ error: 'not found' });
  res.json(notify.absolutize(it));
}));
api.post('/items', upload.array('files'), wrap(async (req, res) => {
  const input = { ...req.body };
  for (const k of ['options', 'links']) if (typeof input[k] === 'string' && input[k].trim().startsWith('[')) input[k] = JSON.parse(input[k]);
  input.attachments = resolveAttachments(input, req.files);
  const it = store.createItem(input, { agentKey: req.agentKey, actor: req.actor });
  notify.discordNewItem(it);
  res.status(201).json(notify.absolutize(it));
}));
api.post('/items/:id/decision', adminOnly, wrap(async (req, res) => {
  const it = store.decide(req.params.id, req.body, req.actor);
  notify.sendCallback(it);
  res.json(it);
}));
api.post('/items/:id/reopen', adminOnly, wrap((req, res) => res.json(store.reopen(req.params.id, req.actor))));
api.post('/items/:id/withdraw', wrap((req, res) => res.json(store.withdraw(req.params.id, req.actor, req.agentKey))));

// Agents poll this: decisions they haven't picked up yet. `ack=1` marks them picked up in the same call.
api.get('/decisions', wrap((req, res) => {
  const items = store.listItems({
    status: 'decided', unacknowledged: req.query.all !== '1',
    project: req.agentKey?.project || req.query.project, agent: req.query.agent, since: req.query.since,
  });
  if (req.query.ack === '1') store.acknowledge(items.map((i) => i.id), req.actor, req.agentKey);
  res.json(items.map(notify.decisionPayload));
}));
api.post('/decisions/ack', wrap((req, res) => res.json({ acknowledged: store.acknowledge([].concat(req.body.ids || []), req.actor, req.agentKey) })));

api.post('/uploads', upload.array('files'), wrap((req, res) => {
  res.json(resolveAttachments({ attachments: req.body.attachments }, req.files).map((a) => ({ ...a, absolute_url: notify.PUBLIC_URL + a.url })));
}));

api.get('/keys', adminOnly, wrap((req, res) => res.json(store.listKeys())));
api.post('/keys', adminOnly, wrap((req, res) => {
  const k = store.createKey(req.body.label, req.body.project || null);
  res.json({ ...k, mcp_url: `${notify.PUBLIC_URL}/mcp/${k.key}` });
}));
api.delete('/keys/:id', adminOnly, wrap((req, res) => { store.revokeKey(req.params.id); res.json({ ok: true }); }));

app.use('/api', api);

// Uploaded files: only for the reviewer's session or a valid agent key.
const INLINE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.mp4', '.mov', '.webm', '.m4v', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.pdf']);
app.get('/files/:name', auth, (req, res) => {
  const name = path.basename(req.params.name);
  const p = path.join(store.DATA_DIR, 'uploads', name);
  if (!fs.existsSync(p)) return res.status(404).end();
  // Images, audio, video and PDFs display inline. Anything else (HTML, scripts, unknown types) downloads,
  // and is sandboxed in case a browser renders it anyway, so an uploaded file can't act as the reviewer.
  const ext = path.extname(name).toLowerCase();
  if (ext === '.svg') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  else if (!INLINE_TYPES.has(ext)) {
    res.set('Content-Security-Policy', 'sandbox; default-src \'none\'');
    res.attachment(name);
  }
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(p);
});

mountMcp(app);

// ---------- UI ----------
const pub = path.join(__dirname, '..', 'public');
const NM = path.join(__dirname, '..', 'node_modules');
app.get('/vendor/marked.js', (req, res) => res.type('js').sendFile(path.join(NM, 'marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (req, res) => res.type('js').sendFile(path.join(NM, 'dompurify/dist/purify.min.js')));
app.get('/', (req, res) => (validSession(req.cookies.sess) ? res.sendFile(path.join(pub, 'index.html')) : res.redirect('/login')));
app.use(express.static(pub, { index: false }));

if (require.main === module) app.listen(PORT, () => console.log(`Approvals hub on :${PORT} (${notify.PUBLIC_URL})`));
module.exports = app;
