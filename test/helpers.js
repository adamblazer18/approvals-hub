// Starts the hub in-process on a random port with a throwaway data directory.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ENV_FILE = path.join(os.tmpdir(), 'approvals-hub-no-env-file');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-hub-test-'));
process.env.ADMIN_PASSWORD = 'test-password-123';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.WEBHOOK_SECRET = 'test-webhook-secret';

async function start() {
  const app = require('../src/server');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = base;
  const store = require('../src/db');

  // Signs in as the reviewer and returns the session cookie.
  async function login() {
    const res = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD }),
    });
    return res.headers.get('set-cookie').split(';')[0];
  }

  async function call(method, url, { key, cookie, body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  }

  const stop = () => new Promise((r) => server.close(r));
  return { base, store, login, call, stop };
}

module.exports = { start };
