/* Approvals hub UI. Vanilla JS, no build step. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const KIND_LABEL = { design: 'Design', copy: 'Copy', email: 'Email', decision: 'Decision', other: 'Review' };
  const STATUS_LABEL = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', changes_requested: 'Changes requested', superseded: 'Replaced by newer version', withdrawn: 'Withdrawn' };
  const VIEW_TITLE = { pending: 'Waiting on you', changes_requested: 'Sent back for changes', decided: 'Decided', all: 'Everything' };

  const state = {
    status: 'pending', project: null, q: '',
    items: [], projects: [], counts: {},
    selId: null, item: null,
    chosen: null, editing: false, lastDecided: null,
  };
  const app = $('#app');

  // ---------- api ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { location.href = '/login'; throw new Error('signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // ---------- time ----------
  function ago(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function due(iso) {
    if (!iso) return '';
    const d = new Date(iso), days = Math.round((d - Date.now()) / 864e5);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return days < 0 ? `<span class="pri-urgent">overdue · ${label}</span>` : days <= 1 ? `<span class="pri-high">due ${label}</span>` : `due ${label}`;
  }

  // ---------- data loading ----------
  async function loadSummary() {
    const s = await api('/summary');
    state.counts = s.counts; state.projects = s.projects;
    renderRail();
  }
  async function loadList() {
    const p = new URLSearchParams({ status: state.status });
    if (state.project) p.set('project', state.project);
    if (state.q) p.set('q', state.q);
    state.items = await api('/items?' + p);
    renderList();
  }
  async function refresh() {
    await Promise.all([loadSummary(), loadList()]);
  }

  // ---------- rail ----------
  function renderRail() {
    const c = state.counts;
    $('#n-pending').textContent = c.pending || '';
    $('#n-pending').classList.toggle('hot', !!c.pending);
    $('#n-changes').textContent = c.changes_requested || '';
    $('#topCount').textContent = c.pending ? `${c.pending} waiting${c.decided_today ? ` · ${c.decided_today} done today` : ''}` : c.decided_today ? `${c.decided_today} done today` : '';
    document.title = c.pending ? `(${c.pending}) Approvals` : 'Approvals';
    $$('.rail-item[data-status]').forEach((b) => b.classList.toggle('active', b.dataset.status === state.status && !state.project));
    const pl = $('#projectList');
    pl.innerHTML = `<button class="rail-item ${!state.project ? '' : ''}" data-project="">All projects</button>` +
      state.projects.map((p) => `<button class="rail-item ${state.project === p.slug ? 'active' : ''}" data-project="${esc(p.slug)}">
        <span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}<span class="n">${p.pending || ''}</span></button>`).join('') +
      (state.projects.length ? '' : '<div class="muted" style="padding:6px 10px;font-size:12.5px">Projects appear here when an agent submits its first item.</div>');
  }

  // ---------- list ----------
  function renderList() {
    const el = $('#list');
    const proj = state.projects.find((p) => p.slug === state.project);
    const head = `<div class="list-head"><h2>${esc(proj ? proj.name : VIEW_TITLE[state.status] || 'Items')}</h2>
      <span class="muted">${proj ? esc(VIEW_TITLE[state.status]).toLowerCase() + ' · ' : ''}${state.items.length}</span></div>`;
    if (!state.items.length) {
      el.innerHTML = head + (state.status === 'pending'
        ? `<div class="empty"><div class="big">✓</div>Nothing waiting on you${proj ? ' for ' + esc(proj.name) : ''}.</div>`
        : `<div class="empty">No items here.</div>`);
      return;
    }
    el.innerHTML = head + state.items.map(cardHTML).join('');
    const sel = el.querySelector('.card.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function cardHTML(i) {
    const img = i.attachments.find((a) => a.type === 'image');
    const pri = i.priority === 'urgent' ? '<span class="pri-urgent">● urgent</span>' : i.priority === 'high' ? '<span class="pri-high">● high</span>' : '';
    const st = state.status === 'pending' ? '' : `<span class="status-pill st-${i.status}">${esc(STATUS_LABEL[i.status])}</span>`;
    return `<div class="card ${i.id === state.selId ? 'sel' : ''}" data-id="${esc(i.id)}" tabindex="-1">
      <div class="card-title">${esc(i.title)}</div>
      ${img ? `<img class="card-thumb" src="${esc(img.url)}" alt="" loading="lazy">` : ''}
      <div class="card-meta">
        <span class="chip"><span class="dot" style="background:${esc(i.project_color)}"></span>${esc(i.project_name)}</span>
        <span class="kind">${esc(KIND_LABEL[i.kind])}</span>
        ${i.version > 1 ? `<span>v${i.version}</span>` : ''}
        ${pri}${st}
        <span>${ago(i.created_at)}</span>
        ${i.due_at && i.status === 'pending' ? `<span>${due(i.due_at)}</span>` : ''}
      </div>
    </div>`;
  }

  // ---------- detail ----------
  async function select(id, { push = true } = {}) {
    state.selId = id; state.chosen = null; state.editing = false;
    $$('.card').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
    const sel = $(`.card[data-id="${CSS.escape(id || '')}"]`);
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    if (!id) { state.item = null; renderDetail(); return; }
    if (push && location.hash !== '#/item/' + id) history.replaceState(null, '', '#/item/' + id);
    app.classList.add('show-detail');
    try {
      state.item = await api('/items/' + encodeURIComponent(id));
      state.chosen = state.item.chosen_option || null;
    } catch { state.item = null; }
    renderDetail();
    $('#detail').scrollTop = 0;
  }

  function renderDetail() {
    const el = $('#detail');
    const i = state.item;
    if (!i) {
      el.innerHTML = `<div class="empty" style="margin:auto">${state.items.length ? 'Select an item to review.<br><span style="font-size:12.5px">Press <kbd>j</kbd> to start.</span>' : ''}</div>`;
      return;
    }
    const last = i.history.find((h) => h.decision_note || h.revised_content);
    el.innerHTML = `
      <div class="d-wrap">
        <button class="btn small d-back" data-act="back">‹ Back</button>
        <div class="d-crumbs">
          <span class="chip"><span class="dot" style="background:${esc(i.project_color)}"></span>${esc(i.project_name)}</span>
          <span class="kind">${esc(KIND_LABEL[i.kind])}</span>
          ${i.version > 1 ? `<span>version ${i.version}</span>` : ''}
          ${i.priority !== 'normal' ? `<span class="pri-${i.priority}">${esc(i.priority)} priority</span>` : ''}
          ${i.agent ? `<span>from ${esc(i.agent)}</span>` : ''}
          <span title="${esc(new Date(i.created_at).toLocaleString())}">${ago(i.created_at)}</span>
          ${i.due_at ? `<span>${due(i.due_at)}</span>` : ''}
          ${i.external_ref ? `<span title="Agent reference">#${esc(i.external_ref)}</span>` : ''}
        </div>
        <h1 class="d-title">${esc(i.title)}</h1>
        ${i.summary ? `<div class="ask"><b>What's needed</b>${esc(i.summary)}</div>` : ''}
        ${last ? `<div class="prev-feedback"><b>Your note on version ${last.version}:</b> ${esc(last.decision_note || 'Edited the copy')}</div>` : ''}
        ${contentHTML(i)}
        ${i.links.length ? `<div class="section-label">Links</div><div class="links">${i.links.map((l) => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">↗ ${esc(l.label)}</a>`).join('')}</div>` : ''}
        ${i.history.length ? `<div class="section-label">Earlier versions</div><div class="history">${i.history.map((h) => `<div class="h-row"><a href="#/item/${esc(h.id)}">v${h.version}</a><span class="status-pill st-${h.status}">${esc(STATUS_LABEL[h.status])}</span><span>${esc(h.decision_note || '')}</span></div>`).join('')}</div>` : ''}
      </div>
      ${decisionHTML(i)}`;
    if (i.kind === 'email' && i.body_format === 'html') {
      const f = $('iframe.email-frame', el);
      if (f) f.srcdoc = i.body;
    }
  }

  function safeUrl(u) { return /^(https?:\/\/|\/(?!\/))/i.test(u || '') ? u : '#'; }

  function renderBody(body, fmt) {
    if (!body) return '';
    if (fmt === 'text') return `<div class="doc plain">${esc(body)}</div>`;
    if (fmt === 'html') return `<div class="doc">${DOMPurify.sanitize(body)}</div>`;
    return `<div class="doc">${DOMPurify.sanitize(marked.parse(body, { breaks: true }))}</div>`;
  }

  function contentHTML(i) {
    let out = '';
    const media = i.attachments.filter((a) => a.type === 'image' || a.type === 'video');
    const audio = i.attachments.filter((a) => a.type === 'audio');
    const files = i.attachments.filter((a) => !['image', 'video', 'audio'].includes(a.type));
    let mediaOut = '';
    if (media.length) {
      mediaOut += `<div class="section-label">${media.length > 1 ? media.length + ' visuals' : 'Visual'}</div>
        <div class="gallery ${media.length === 1 ? 'single' : ''}">${media.map((a, n) => `<figure>
          ${a.type === 'image' ? `<img src="${esc(safeUrl(a.url))}" alt="${esc(a.caption || a.name)}" data-lb="${n}" loading="lazy">` : `<video src="${esc(safeUrl(a.url))}" controls preload="metadata"></video>`}
          <figcaption><span>${media.length > 1 ? `<b>${n + 1}.</b> ` : ''}${esc(a.caption || a.name || '')}</span><a href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener">Open</a></figcaption></figure>`).join('')}</div>`;
    }
    if (audio.length) mediaOut += `<div class="section-label">Audio</div>` + audio.map((a) => `<div style="margin-bottom:8px"><div class="muted" style="font-size:12.5px">${esc(a.caption || a.name)}</div><audio src="${esc(safeUrl(a.url))}" controls style="width:100%"></audio></div>`).join('');

    if (i.kind === 'email') {
      out += `<div class="section-label">Email</div><div class="email"><dl class="email-head">
        ${i.email_to ? `<dt>To</dt><dd>${esc(i.email_to)}</dd>` : ''}
        <dt>Subject</dt><dd>${esc(i.email_subject || '(no subject)')}</dd></dl>
        ${state.editing ? '' : i.body_format === 'html' ? `<iframe class="email-frame" sandbox="" title="Email preview"></iframe>` : renderBody(i.body, i.body_format)}</div>`;
    } else if (i.body && !state.editing) {
      out += `<div class="section-label">${i.kind === 'copy' ? 'Copy' : 'Details'}</div>` + renderBody(i.body, i.body_format);
    }
    if (state.editing) {
      out += `<div class="section-label">Your edited version</div><textarea class="editor" id="editor">${esc(i.revised_content || i.body || '')}</textarea>`;
    }
    // Visuals lead for design work; text leads for copy and email, with any images after it.
    out = ['design', 'decision'].includes(i.kind) ? mediaOut + out : out + mediaOut;
    const pdfs = files.filter((a) => a.type === 'pdf' && a.url.startsWith('/'));
    if (pdfs.length) out += pdfs.map((a) => `<div class="section-label">${esc(a.name)}</div><iframe class="pdf" src="${esc(a.url)}" title="${esc(a.name)}"></iframe>`).join('');
    if (files.length) out += `<div class="section-label">Files</div><div class="files">${files.map((a) => `<a class="file-row" href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener">📎 ${esc(a.caption || a.name)}<span class="muted" style="margin-left:auto">${esc(a.type)}</span></a>`).join('')}</div>`;
    if (!out) out = '<div class="muted" style="margin-top:12px">No content attached.</div>';
    return out;
  }

  function canEdit(i) { return i.body && i.body_format !== 'html' && ['copy', 'email', 'other'].includes(i.kind); }

  function decisionHTML(i) {
    if (i.status !== 'pending') {
      const tone = { approved: 'approve', rejected: 'reject', changes_requested: 'changes' }[i.status];
      const chosen = i.options.find((o) => o.id === i.chosen_option);
      const bg = tone ? `background:var(--${tone}-bg)` : 'background:var(--bg)';
      return `<div class="decide"><div class="decide-inner"><div class="decided-banner" style="${bg}">
        <span class="status-pill st-${i.status}">${esc(STATUS_LABEL[i.status])}</span>
        <div class="grow">${chosen ? `<b>Picked: ${esc(chosen.label)}</b><br>` : ''}${esc(i.decision_note || '')}${i.revised_content ? '<br><i class="muted">You edited the copy.</i>' : ''}
          <div class="muted" style="font-size:12px;margin-top:2px">${i.decided_at ? ago(i.decided_at) : ''}${i.acknowledged_at ? ' · agent picked it up' : i.decided_at ? ' · agent hasn\'t picked it up yet' : ''}</div></div>
        ${tone ? `<button class="btn small" data-act="reopen">Reopen</button>` : ''}
      </div></div></div>`;
    }
    const opts = i.options.length ? `<div class="options" role="radiogroup" aria-label="Options">${i.options.map((o, n) => `
      <label class="option ${state.chosen === o.id ? 'on' : ''}"><input type="radio" name="opt" value="${esc(o.id)}" ${state.chosen === o.id ? 'checked' : ''}>
      <span><b>${esc(o.id)}.</b> ${esc(o.label)}${o.detail ? `<small>${esc(o.detail)}</small>` : ''}</span>${n < 9 ? `<span class="k">${n + 1}</span>` : ''}</label>`).join('')}</div>` : '';
    return `<div class="decide"><div class="decide-inner">
      ${opts}
      <textarea class="note" id="note" rows="1" placeholder="Notes for the agent. Required to reject or send back.">${esc(state.draftNote || '')}</textarea>
      <div class="btn-row">
        <button class="btn approve" data-act="approved">${state.editing ? 'Approve my edits' : i.options.length ? 'Approve choice' : 'Approve'} <kbd>A</kbd></button>
        <button class="btn changes" data-act="changes_requested">Request changes <kbd>C</kbd></button>
        <button class="btn reject" data-act="rejected">Reject <kbd>R</kbd></button>
        <span class="grow"></span>
        ${canEdit(i) ? `<button class="btn small" data-act="edit">${state.editing ? 'Cancel edit' : 'Edit copy'} <kbd>E</kbd></button>` : ''}
      </div>
    </div></div>`;
  }

  // ---------- decisions ----------
  async function decide(status) {
    const i = state.item;
    if (!i || i.status !== 'pending') return;
    const noteEl = $('#note');
    const note = noteEl.value.trim();
    if (status !== 'approved' && !note) {
      noteEl.classList.add('need'); noteEl.focus();
      toast('Add a note so the agent knows what to change.');
      return;
    }
    if (status === 'approved' && i.options.length && !state.chosen) { toast('Pick an option first (1–' + Math.min(i.options.length, 9) + ').'); return; }
    const body = { status, note, chosen_option: status === 'approved' ? state.chosen : null };
    if (state.editing) {
      const v = $('#editor').value;
      if (v.trim() !== (i.body || '').trim()) body.revised_content = v;
    }
    $$('.decide .btn').forEach((b) => (b.disabled = true));
    try {
      await api(`/items/${i.id}/decision`, { method: 'POST', body });
    } catch (e) { toast(e.message); $$('.decide .btn').forEach((b) => (b.disabled = false)); return; }
    state.draftNote = '';
    state.lastDecided = i.id;
    const idx = state.items.findIndex((x) => x.id === i.id);
    const stays = state.status === 'all' || state.status === 'decided' || state.status === status;
    let next = state.items[idx + 1] || state.items[idx - 1];
    if (!stays) state.items.splice(idx, 1);
    else next = state.items[idx + 1];
    toast(`${STATUS_LABEL[status]}: ${i.title}`, true);
    renderList();
    loadSummary();
    if (next && next.id !== i.id) select(next.id);
    else if (stays) select(i.id);
    else { state.item = null; state.selId = null; history.replaceState(null, '', '#/'); app.classList.remove('show-detail'); renderDetail(); }
  }
  async function undo() {
    if (!state.lastDecided) return;
    const id = state.lastDecided;
    state.lastDecided = null;
    try { await api(`/items/${id}/reopen`, { method: 'POST' }); } catch (e) { toast(e.message); return; }
    hideToast();
    await refresh();
    select(id);
  }

  // ---------- toast ----------
  let toastT;
  function toast(msg, withUndo) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>${withUndo ? '<button data-act="undo">Undo</button>' : ''}`;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(hideToast, withUndo ? 6000 : 3500);
  }
  function hideToast() { $('#toast').hidden = true; }

  // ---------- lightbox ----------
  let lbImgs = [], lbIdx = 0;
  function openLB(n) {
    lbImgs = state.item.attachments.filter((a) => a.type === 'image' || a.type === 'video').filter((a) => a.type === 'image');
    const media = state.item.attachments.filter((a) => a.type === 'image' || a.type === 'video');
    lbIdx = lbImgs.indexOf(media[n]);
    showLB();
    $('#lightbox').hidden = false;
  }
  function showLB() {
    const a = lbImgs[lbIdx]; if (!a) return;
    $('#lightbox img').src = a.url;
    $('#lightbox figcaption').textContent = `${lbImgs.length > 1 ? `${lbIdx + 1} / ${lbImgs.length} · ` : ''}${a.caption || a.name || ''}`;
  }
  function stepLB(d) { lbIdx = (lbIdx + d + lbImgs.length) % lbImgs.length; showLB(); }

  // ---------- settings ----------
  async function openSettings() {
    const dlg = $('#settings');
    const [projects, keys] = await Promise.all([api('/projects?all=1'), api('/keys')]);
    dlg.innerHTML = `
      <h2>Settings</h2>
      <h3>Projects</h3>
      <table class="tbl"><thead><tr><th style="width:36px"></th><th>Name</th><th style="width:70px">Waiting</th><th style="width:90px"></th></tr></thead><tbody>
      ${projects.map((p) => `<tr data-slug="${esc(p.slug)}"><td><input type="color" value="${esc(p.color)}" data-f="color" aria-label="Color"></td>
        <td><input type="text" value="${esc(p.name)}" data-f="name" aria-label="Name"></td><td>${p.pending}</td>
        <td><button class="btn small" data-f="archive">${p.archived ? 'Unarchive' : 'Archive'}</button></td></tr>`).join('')}
      </tbody></table>
      <form class="inline-form" id="addProject"><input name="name" placeholder="New project name" required><button class="btn small">Add project</button></form>

      <h3>Agent keys</h3>
      <p class="muted" style="margin:0 0 8px;font-size:13px">Each agent or Claude project gets its own key. Lock a key to one project if it should only post there.</p>
      <table class="tbl"><thead><tr><th>Label</th><th>Project</th><th>Last used</th><th></th></tr></thead><tbody>
      ${keys.filter((k) => !k.revoked_at).map((k) => `<tr><td>${esc(k.label)}<div class="muted" style="font-family:var(--mono);font-size:11px">${esc(k.key_prefix)}…</div></td>
        <td>${esc(k.project || 'any')}</td><td>${k.last_used_at ? ago(k.last_used_at) : 'never'}</td>
        <td><button class="btn small reject" data-revoke="${esc(k.id)}">Revoke</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No keys yet.</td></tr>'}
      </tbody></table>
      <form class="inline-form" id="addKey">
        <input name="label" placeholder="Agent name, e.g. Website design agent" required style="flex:1;min-width:200px">
        <select name="project"><option value="">Any project</option>${projects.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('')}</select>
        <button class="btn small primary">Create key</button>
      </form>
      <div id="newKey"></div>
      <form method="dialog" style="margin-top:20px;display:flex;justify-content:space-between">
        <button class="btn" formaction="/logout" formmethod="post">Sign out</button><button class="btn">Done</button></form>`;
    if (!dlg.open) dlg.showModal();
  }

  // ---------- routing ----------
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const m = h.match(/^item\/([\w]+)/);
    if (m) { if (state.selId !== m[1]) select(m[1], { push: false }); }
    else if (!h) { app.classList.remove('show-detail'); }
  }

  function setView({ status, project }) {
    if (status !== undefined) state.status = status;
    if (project !== undefined) state.project = project || null;
    state.item = null; state.selId = null;
    app.classList.remove('nav-open', 'show-detail');
    history.replaceState(null, '', '#/');
    renderRail();
    loadList().then(() => {
      renderDetail();
      if (window.innerWidth > 760 && state.items[0]) select(state.items[0].id);
    });
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    const rail = t.closest('.rail-item');
    if (rail) return rail.dataset.status ? setView({ status: rail.dataset.status, project: null }) : setView({ project: rail.dataset.project });
    const card = t.closest('.card');
    if (card) return select(card.dataset.id);
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'approved' || act === 'rejected' || act === 'changes_requested') return decide(act);
    if (act === 'edit') { state.draftNote = $('#note')?.value; state.editing = !state.editing; renderDetail(); if (state.editing) $('#editor').focus(); return; }
    if (act === 'reopen') return api(`/items/${state.item.id}/reopen`, { method: 'POST' }).then(() => { refresh(); select(state.item.id); });
    if (act === 'undo') return undo();
    if (act === 'back') { app.classList.remove('show-detail'); history.replaceState(null, '', '#/'); return; }
    if (t.matches('[data-lb]')) return openLB(+t.dataset.lb);
    if (t.closest('.lb-close') || t.id === 'lightbox') return ($('#lightbox').hidden = true);
    if (t.closest('.lb-prev')) return stepLB(-1);
    if (t.closest('.lb-next')) return stepLB(1);
    if (t.id === 'navToggle') return app.classList.toggle('nav-open');
    if (t.id === 'settingsBtn') return openSettings();
    if (t.id === 'helpBtn') return $('#help').showModal();
    if (t.dataset.revoke && confirm('Revoke this key? Agents using it will stop working.')) return api('/keys/' + t.dataset.revoke, { method: 'DELETE' }).then(openSettings);
    if (t.dataset.f === 'archive') {
      const slug = t.closest('tr').dataset.slug;
      return api('/projects/' + slug, { method: 'PATCH', body: { archived: t.textContent === 'Archive' } }).then(() => { openSettings(); loadSummary(); });
    }
    if (app.classList.contains('nav-open') && !t.closest('.rail')) app.classList.remove('nav-open');
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'opt') { state.chosen = t.value; $$('.option').forEach((o) => o.classList.toggle('on', o.querySelector('input').checked)); }
    if (t.dataset.f === 'name' || t.dataset.f === 'color') {
      const slug = t.closest('tr').dataset.slug;
      api('/projects/' + slug, { method: 'PATCH', body: { [t.dataset.f]: t.value } }).then(() => { loadSummary(); loadList(); });
    }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'addProject') {
      e.preventDefault();
      await api('/projects', { method: 'POST', body: { name: e.target.name.value } });
      openSettings(); loadSummary();
    }
    if (e.target.id === 'addKey') {
      e.preventDefault();
      const f = e.target;
      const k = await api('/keys', { method: 'POST', body: { label: f.label.value, project: f.project.value || null } });
      await openSettings();
      $('#newKey').innerHTML = `<div class="callout"><b>Key for ${esc(k.label)}</b>. Copy it now; it won't be shown again.
        <div class="muted" style="font-size:12px;margin-top:8px">API key</div><div class="secret">${esc(k.key)}</div>
        <div class="muted" style="font-size:12px">MCP connector URL (paste into Claude → Settings → Connectors → Add custom connector)</div><div class="secret">${esc(k.mcp_url)}</div></div>`;
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'note') {
      e.target.classList.remove('need');
      e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight + 2, window.innerHeight * 0.4) + 'px';
    }
  });
  let searchT;
  $('#search').addEventListener('input', (e) => { clearTimeout(searchT); searchT = setTimeout(() => { state.q = e.target.value.trim(); loadList(); }, 250); });

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea, select');
    if (!$('#lightbox').hidden) {
      if (e.key === 'Escape') $('#lightbox').hidden = true;
      if (e.key === 'ArrowRight') stepLB(1);
      if (e.key === 'ArrowLeft') stepLB(-1);
      return;
    }
    if ($('dialog[open]')) return;
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      if (e.target.id === 'note' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); decide(e.target.value.trim() ? 'changes_requested' : 'approved'); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = state.items.findIndex((x) => x.id === state.selId);
    const k = e.key.toLowerCase();
    if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); const n = state.items[idx + 1] || (idx < 0 && state.items[0]); if (n) select(n.id); }
    else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); const n = state.items[idx - 1]; if (n) select(n.id); }
    else if (k === 'a') { e.preventDefault(); decide('approved'); }
    else if (k === 'r') { e.preventDefault(); decide('rejected'); }
    else if (k === 'c') { e.preventDefault(); decide('changes_requested'); }
    else if (k === 'n') { e.preventDefault(); $('#note')?.focus(); }
    else if (k === 'e' && state.item && canEdit(state.item) && state.item.status === 'pending') { e.preventDefault(); $('[data-act="edit"]')?.click(); }
    else if (k === 'u') undo();
    else if (k === '?') $('#help').showModal();
    else if (k === '/') { e.preventDefault(); $('#search').focus(); }
    else if (/^[1-9]$/.test(k) && state.item?.options[+k - 1] && state.item.status === 'pending') {
      state.chosen = state.item.options[+k - 1].id;
      $$('.option input').forEach((inp) => { inp.checked = inp.value === state.chosen; });
      $$('.option').forEach((o) => o.classList.toggle('on', o.querySelector('input').checked));
    }
  });
  window.addEventListener('hashchange', route);

  // Keep the queue fresh without disturbing the item being reviewed.
  setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });

  // ---------- boot ----------
  (async () => {
    await refresh();
    if (location.hash.startsWith('#/item/')) route();
    else if (window.innerWidth > 760 && state.items[0]) select(state.items[0].id);
    else renderDetail();
  })();
})();
