const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { start } = require('./helpers');

let hub, cookie, key, scopedKey;

before(async () => {
  hub = await start();
  cookie = await hub.login();
  key = hub.store.createKey('Website agent').key;
  scopedKey = hub.store.createKey('App agent', 'Mobile app').key;
});
after(() => hub.stop());

test('rejects requests without a key or session', async () => {
  const r = await hub.call('GET', '/api/items');
  assert.equal(r.status, 401);
});

test('wrong password does not sign in', async () => {
  const res = await fetch(`${hub.base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'nope' }),
  });
  assert.equal(res.headers.get('location'), '/login?e=1');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('an agent submits, the reviewer approves, the agent picks up the decision once', async () => {
  const sub = await hub.call('POST', '/api/items', { key, body: {
    project: 'Website', kind: 'copy', title: 'Hero headline', body: '# Old headline', external_ref: 'task-1',
  } });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.status, 'pending');
  assert.equal(sub.body.agent, 'Website agent');

  const pending = await hub.call('GET', '/api/items?status=pending', { cookie });
  assert.ok(pending.body.some((i) => i.id === sub.body.id));

  const dec = await hub.call('POST', `/api/items/${sub.body.id}/decision`, { cookie, body: {
    status: 'approved', revised_content: '# New headline',
  } });
  assert.equal(dec.status, 200);
  assert.equal(dec.body.status, 'approved');

  const first = await hub.call('GET', '/api/decisions?ack=1', { key });
  const mine = first.body.find((d) => d.external_ref === 'task-1');
  assert.equal(mine.status, 'approved');
  assert.equal(mine.revised_content, '# New headline');

  const second = await hub.call('GET', '/api/decisions?ack=1', { key });
  assert.equal(second.body.find((d) => d.external_ref === 'task-1'), undefined, 'acknowledged decisions are not returned again');
});

test('agents cannot decide their own items', async () => {
  const sub = await hub.call('POST', '/api/items', { key, body: { project: 'Website', title: 'Self-approve?' } });
  const r = await hub.call('POST', `/api/items/${sub.body.id}/decision`, { key, body: { status: 'approved' } });
  assert.equal(r.status, 403);
});

test('rejecting or requesting changes needs a note', async () => {
  const sub = await hub.call('POST', '/api/items', { key, body: { project: 'Website', title: 'Needs a note' } });
  const r = await hub.call('POST', `/api/items/${sub.body.id}/decision`, { cookie, body: { status: 'rejected' } });
  assert.equal(r.status, 400);
});

test('a decision with options needs one of them picked', async () => {
  const sub = await hub.call('POST', '/api/items', { key, body: {
    project: 'Website', title: 'Pick a direction', options: ['Dark', 'Light'],
  } });
  assert.equal(sub.body.kind, 'decision');
  assert.deepEqual(sub.body.options.map((o) => o.id), ['A', 'B']);
  const missing = await hub.call('POST', `/api/items/${sub.body.id}/decision`, { cookie, body: { status: 'approved' } });
  assert.equal(missing.status, 400);
  const ok = await hub.call('POST', `/api/items/${sub.body.id}/decision`, { cookie, body: { status: 'approved', chosen_option: 'B' } });
  assert.equal(ok.body.chosen_option, 'B');
  const d = (await hub.call('GET', '/api/decisions?ack=1', { key })).body.find((x) => x.id === sub.body.id);
  assert.deepEqual(d.chosen_option, { id: 'B', label: 'Light' });
});

test('a revision replaces the pending version and keeps the earlier note', async () => {
  const v1 = await hub.call('POST', '/api/items', { key, body: { project: 'Website', title: 'FAQ answer', body: 'v1' } });
  await hub.call('POST', `/api/items/${v1.body.id}/decision`, { cookie, body: { status: 'changes_requested', note: 'Shorter, please.' } });
  const v2 = await hub.call('POST', '/api/items', { key, body: { project: 'Website', title: 'FAQ answer', body: 'v2', revises: v1.body.id } });
  assert.equal(v2.body.version, 2);
  const full = await hub.call('GET', `/api/items/${v2.body.id}`, { cookie });
  assert.equal(full.body.history[0].decision_note, 'Shorter, please.');
});

test('a project-scoped key can only see and submit to its project', async () => {
  const wrong = await hub.call('POST', '/api/items', { key: scopedKey, body: { project: 'Website', title: 'Not mine' } });
  assert.equal(wrong.status, 403);
  const ok = await hub.call('POST', '/api/items', { key: scopedKey, body: { project: 'Mobile app', title: 'Mine' } });
  assert.equal(ok.status, 201);
  const list = await hub.call('GET', '/api/items', { key: scopedKey });
  assert.ok(list.body.length > 0);
  assert.ok(list.body.every((i) => i.project === 'mobile-app'));
});

test('base64 attachments are stored and only served to authorized callers', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const sub = await hub.call('POST', '/api/items', { key, body: {
    project: 'Website', kind: 'design', title: 'Tiny image',
    attachments: [{ data: 'data:image/png;base64,' + png.toString('base64'), name: 'dot.png' }],
  } });
  const url = new URL(sub.body.attachments[0].url);
  assert.equal(sub.body.attachments[0].type, 'image');
  assert.equal((await fetch(hub.base + url.pathname)).status, 401);
  const res = await fetch(hub.base + url.pathname, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
});

test('uploaded HTML downloads in a sandbox instead of running as the reviewer', async () => {
  const sub = await hub.call('POST', '/api/items', { key, body: {
    project: 'Website', title: 'Sneaky file',
    attachments: [{ data: Buffer.from('<script>fetch("/api/keys")</script>').toString('base64'), name: 'page.html', mime_type: 'text/html' }],
  } });
  const path = new URL(sub.body.attachments[0].url).pathname;
  const res = await fetch(hub.base + path, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /^attachment/);
  assert.match(res.headers.get('content-security-policy') || '', /sandbox/);
});

test('revoked keys stop working', async () => {
  const k = hub.store.createKey('Temporary agent');
  assert.equal((await hub.call('GET', '/api/items', { key: k.key })).status, 200);
  hub.store.revokeKey(k.id);
  assert.equal((await hub.call('GET', '/api/items', { key: k.key })).status, 401);
});

test('callback URLs must be http(s)', async () => {
  const r = await hub.call('POST', '/api/items', { key, body: { project: 'Website', title: 'Bad callback', callback_url: 'file:///etc/passwd' } });
  assert.equal(r.status, 400);
});

test('decision callbacks are signed over the exact body sent', async () => {
  let received;
  const sink = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { received = { raw, sig: req.headers['x-approvals-signature'] }; res.end('ok'); });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${sink.address().port}/hook`;
  const sub = await hub.call('POST', '/api/items', { key, body: { project: 'Website', title: 'With callback', callback_url: url } });
  await hub.call('POST', `/api/items/${sub.body.id}/decision`, { cookie, body: { status: 'approved' } });
  for (let i = 0; i < 50 && !received; i++) await new Promise((r) => setTimeout(r, 20));
  sink.close();
  assert.ok(received, 'callback was delivered');
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(received.raw).digest('hex');
  assert.equal(received.sig, expected);
  assert.equal(JSON.parse(received.raw).item.status, 'approved');
});
