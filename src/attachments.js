// Attachments arrive as URLs, as base64 (`data`, optionally a data: URL) or as multipart files.
// URLs are kept as they are; the other two are stored locally and served from /files/.
const store = require('./db');

function parseList(v) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  return Array.isArray(v) ? v : v ? [v] : [];
}

function fromBase64(a) {
  let b64 = String(a.data), mime = a.mime_type || a.type;
  const m = b64.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) { mime = m[1]; b64 = m[2]; }
  const saved = store.saveUpload(Buffer.from(b64, 'base64'), a.name, mime);
  return { url: `/files/${saved.file}`, name: a.name || saved.name, type: saved.type, caption: a.caption };
}

function resolveAttachments(input = {}, files = []) {
  const out = [];
  for (const a of parseList(input.attachments)) {
    if (a && typeof a === 'object' && a.data && !a.url) out.push(fromBase64(a));
    else if (a) out.push(a);
  }
  for (const f of files) {
    const saved = store.saveUpload(f.buffer, f.originalname, f.mimetype);
    out.push({ url: `/files/${saved.file}`, name: f.originalname, type: saved.type });
  }
  return out;
}

module.exports = { resolveAttachments };
