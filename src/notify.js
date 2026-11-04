// Outbound notifications: agent callbacks on decisions, Discord pings on new items.
const crypto = require('crypto');

const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

function absolutize(item) {
  const fix = (u) => (u && u.startsWith('/') ? PUBLIC_URL + u : u);
  return {
    ...item,
    url: `${PUBLIC_URL}/#/item/${item.id}`,
    attachments: (item.attachments || []).map((a) => ({ ...a, url: fix(a.url) })),
  };
}

// The payload an agent receives, via callback, REST or MCP. Kept small and explicit.
function decisionPayload(item) {
  const a = absolutize(item);
  const chosen = (item.options || []).find((o) => o.id === item.chosen_option);
  return {
    id: a.id, project: a.project, title: a.title, status: a.status, version: a.version,
    note: a.decision_note, revised_content: a.revised_content,
    chosen_option: item.chosen_option ? { id: item.chosen_option, label: chosen?.label } : null,
    decided_at: a.decided_at, external_ref: a.external_ref, agent: a.agent, url: a.url,
  };
}

async function post(url, body, headers = {}) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw, signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch (e) {
    console.warn('notify failed', url, e.message);
    return false;
  }
}

async function sendCallback(item) {
  if (!item.callback_url) return;
  const body = { event: 'decision', item: decisionPayload(item) };
  const raw = JSON.stringify(body);
  const sig = WEBHOOK_SECRET ? crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') : undefined;
  // Send the exact bytes that were signed, so receivers can verify the HMAC.
  await post(item.callback_url, raw, sig ? { 'x-approvals-signature': 'sha256=' + sig } : {});
}

async function discordNewItem(item) {
  if (!DISCORD_WEBHOOK_URL) return;
  const pr = item.priority === 'urgent' ? '🔴 ' : item.priority === 'high' ? '🟠 ' : '';
  await post(DISCORD_WEBHOOK_URL, {
    username: 'Approvals',
    embeds: [{
      title: `${pr}${item.project_name}: ${item.title}`.slice(0, 250),
      description: (item.summary || '').slice(0, 500) || undefined,
      url: `${PUBLIC_URL}/#/item/${item.id}`,
      color: parseInt((item.project_color || '#6b7280').slice(1), 16),
      footer: { text: `${item.kind}${item.agent ? ' · from ' + item.agent : ''}${item.version > 1 ? ' · v' + item.version : ''}` },
    }],
  });
}

module.exports = { PUBLIC_URL, absolutize, decisionPayload, sendCallback, discordNewItem };
