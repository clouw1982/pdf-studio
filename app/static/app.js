/* PDF Studio front end — vanilla JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

const S = {
  docs: [], doc: null, id: null, zoom: 1, fit: true, tool: 'select', cur: 0,
  objs: {}, pendingRedact: [], sel: null, thumbSel: new Set(),
  hits: [], hitIdx: -1, sig: null,
  props: { color: '#d93025', size: 12, family: 'sans', bold: false, italic: false, width: 2, fill: null, fieldType: 'text' },
};

/* ------------------------------------------------------------------ api */
async function api(path, opt = {}) {
  const init = { method: opt.method || (opt.json || opt.form ? 'POST' : 'GET'), headers: {} };
  if (opt.json) { init.body = JSON.stringify(opt.json); init.headers['Content-Type'] = 'application/json'; }
  if (opt.form) init.body = opt.form;
  const r = await fetch(path, init);
  if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.detail) || data.error || r.statusText);
  return data;
}
function toast(msg, kind = '', ms = 3200) {
  const t = h('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}
async function busy(msg, fn) {
  const t = toast(msg, 'busy', 0);
  try { return await fn(); }
  catch (e) { if (e.message !== 'login') toast(e.message, 'err', 6000); throw e; }
  finally { t.remove(); }
}

/* run an edit operation on the open document */
async function op(params, msg) {
  if (!S.id) return;
  const res = await busy(msg || 'Working…', () => api(`/api/docs/${S.id}/op`, { json: params }));
  if (res.doc) await applyDoc(res.doc);
  return res;
}

/* ------------------------------------------------------------------ library */
async function loadDocs() {
  S.docs = await api('/api/docs');
  const ul = $('#docList'); ul.innerHTML = '';
  for (const d of S.docs) {
    const cb = h('input', { type: 'checkbox', onclick: e => { e.stopPropagation(); bulkState(); } });
    cb.dataset.id = d.id;
    ul.append(h('li', { class: d.id === S.id ? 'cur' : '', onclick: () => openDoc(d.id) },
      cb,
      h('div', { class: 'nm' }, h('b', { title: d.name }, d.locked ? '🔒 ' + d.name : d.name),
        h('small', {}, `${fmtSize(d.size)} · ${new Date(d.modified * 1000).toLocaleString()}${d.source === 'inbox' ? ' · inbox' : ''}`)),
      h('button', { class: 'x', title: 'Delete', onclick: async e => { e.stopPropagation(); if (await confirmBox(`Delete “${d.name}”?`)) { await api(`/api/docs/${d.id}`, { method: 'DELETE' }); if (d.id === S.id) closeDoc(); loadDocs(); } } }, '✕')));
  }
  bulkState();
}
function bulkState() {
  const n = $$('#docList input:checked').length;
  $('#btnMerge').disabled = n < 2; $('#btnCompare').disabled = n !== 2; $('#btnBatch').disabled = n < 1;
}
const checkedIds = () => $$('#docList input:checked').map(c => c.dataset.id);

async function uploadFiles(files, toInbox = false) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  if (toInbox) {
    await busy(`Sending ${files.length} file(s) to inbox…`, () => api('/api/inbox/upload', { form: fd }));
    toast('Queued — PSDs will appear under Output files'); showTab('inbox'); refreshInbox();
    return;
  }
  fd.append('psd', $('#chkPsd').checked ? 'true' : 'false');
  const r = await busy(`Opening ${files.length} file(s)…`, () => api('/api/upload', { form: fd }));
  r.errors.forEach(e => toast(e, 'err', 7000));
  await loadDocs();
  if (r.created.length) openDoc(r.created[r.created.length - 1]);
  if ($('#chkPsd').checked && r.created.length) toast('Layered PSDs are being generated (see Inbox → Output files)');
}

async function openDoc(id) {
  S.id = id; S.objs = {}; S.pendingRedact = []; S.sel = null; S.thumbSel.clear(); S.hits = []; S.cur = 0;
  $('#searchBox').value = ''; $('#searchCount').textContent = '';
  const d = await api(`/api/docs/${id}`);
  if (d.locked) {
    const pw = await promptBox('This PDF is password protected', 'Password', '', 'password');
    if (pw == null) return;
    const r = await busy('Unlocking…', () => api(`/api/docs/${id}/op`, { json: { op: 'unlock', password: pw } }));
    await applyDoc(r.doc, true); loadDocs(); return;
  }
  await applyDoc(d, true);
  $$('#docList li').forEach(li => li.classList.toggle('cur', li.querySelector('input')?.dataset.id === id));
  $('#left').classList.remove('open');
}
function closeDoc() {
  S.id = null; S.doc = null;
  $('#viewer').innerHTML = ''; $('#viewer').append(emptyHero);
  $('#docTitle').textContent = ''; $('#thumbs').innerHTML = '';
}
const emptyHero = $('#empty');

async function applyDoc(d, fresh = false) {
  const keepScroll = $('#viewer').scrollTop, keepLeft = $('#viewer').scrollLeft;
  S.doc = d; S.objs = {};
  if (S.cur >= d.pages.length) S.cur = d.pages.length - 1;
  $('#docTitle').textContent = d.name;
  document.title = d.name + ' — PDF Studio';
  $('#btnUndo').disabled = d.cur === 0;
  $('#btnRedo').disabled = d.cur >= d.versions.length - 1;
  if (S.fit && fresh) fitWidth(); else renderPages();
  if (!fresh) { $('#viewer').scrollTop = keepScroll; $('#viewer').scrollLeft = keepLeft; }
  renderThumbs(); renderToc(); renderSide(); renderHistory();
  if (!fresh) loadDocs();
}
const ver = () => Math.round((S.doc.versions[S.doc.cur]?.t || 0) * 1000);

/* ------------------------------------------------------------------ viewer */
function fitWidth() {
  if (!S.doc) return;
  const avail = $('#viewer').clientWidth - 60;
  const maxW = Math.max(...S.doc.pages.map(p => p.w));
  S.zoom = Math.max(0.25, Math.min(3, avail / maxW));
  S.fit = true; renderPages();
}
function setZoom(z) { S.zoom = Math.max(0.2, Math.min(5, z)); S.fit = false; renderPages(); }

let io;
function renderPages() {
  if (!S.doc) return;
  const v = $('#viewer'); v.innerHTML = '';
  $('#zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = (S.zoom * dpr).toFixed(2);
  io?.disconnect();
  io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const pno = +e.target.dataset.p;
      if (e.isIntersecting) {
        const img = e.target.querySelector('img');
        if (!img.src) img.src = `/api/docs/${S.id}/page/${pno}.png?scale=${scale}&v=${ver()}`;
        buildLayer(pno);
      }
    }
  }, { root: v, rootMargin: '600px 0px' });
  S.doc.pages.forEach((p, i) => {
    const pg = h('div', { class: 'page', 'data-p': i, style: { width: p.w * S.zoom + 'px', height: p.h * S.zoom + 'px' } },
      h('img', { alt: '' }), h('div', { class: 'layer' }), h('span', { class: 'pnum' }, `${i + 1} / ${S.doc.pages.length}`));
    v.append(pg, h('br'));
    io.observe(pg);
    attachPointer(pg);
  });
  v.className = S.tool === 'pan' ? 'pan' : '';
}
const pageEl = pno => $(`.page[data-p="${pno}"]`);
const layerEl = pno => pageEl(pno)?.querySelector('.layer');

function scrollToPage(pno) {
  const el = pageEl(pno); if (el) $('#viewer').scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' });
  S.cur = pno; markThumbCur();
}
$('#viewer').addEventListener('scroll', () => {
  if (!S.doc) return;
  const v = $('#viewer'), mid = v.scrollTop + v.clientHeight / 3;
  let best = 0;
  $$('.page', v).forEach(p => { if (p.offsetTop <= mid) best = +p.dataset.p; });
  if (best !== S.cur) { S.cur = best; markThumbCur(); }
});

async function objects(pno) {
  const key = pno + ':' + ver();
  if (!S.objs[key]) S.objs[key] = api(`/api/docs/${S.id}/page/${pno}/objects`);
  return S.objs[key];
}

/* draw the interactive overlay for a page according to the active tool */
async function buildLayer(pno) {
  const L = layerEl(pno); if (!L) return;
  L.innerHTML = '';
  const Z = S.zoom;
  const place = (el, r) => Object.assign(el.style, { left: r[0] * Z + 'px', top: r[1] * Z + 'px', width: (r[2] - r[0]) * Z + 'px', height: (r[3] - r[1]) * Z + 'px' });
  L.append(h('svg', { xmlns: 'http://www.w3.org/2000/svg' }));
  // search hits
  S.hits.forEach((hit, i) => { if (hit.page === pno) { const b = h('div', { class: 'hit' + (i === S.hitIdx ? ' cur' : '') }); place(b, hit.rect); L.append(b); } });
  S.pendingRedact.filter(r => r.page === pno).forEach(r => { const b = h('div', { class: 'redbox' }); place(b, r.rect); L.append(b); });
  const t = S.tool;
  if (!['select', 'edittext', 'editimage', 'link'].includes(t)) return;
  const o = await objects(pno);
  if (layerEl(pno) !== L) return;
  if (t === 'edittext') {
    for (const ln of o.lines) {
      const b = h('div', { class: 'box tl', title: 'Click to edit · Del to delete' }); place(b, ln.bbox);
      b.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); startTextEdit(pno, ln, b); });
      L.append(b);
    }
  } else if (t === 'editimage') {
    for (const im of o.images) {
      const b = h('div', { class: 'box img-box' }); place(b, im.bbox); L.append(b);
      imageInteractions(pno, im, b);
    }
  } else if (t === 'link') {
    for (const lk of o.links) { const b = h('div', { class: 'linkbox' }); place(b, lk.rect); L.append(b); }
  } else if (t === 'select') {
    for (const a of o.annots) {
      if (a.type === 'Widget') continue;
      const b = h('div', { class: 'box annot-box', title: `${a.type}${a.content ? ': ' + a.content : ''} — click to select, Del to remove` }); place(b, a.rect);
      b.addEventListener('pointerdown', e => {
        e.stopPropagation(); $$('.annot-box.sel').forEach(x => x.classList.remove('sel')); b.classList.add('sel');
        S.sel = { kind: 'annot', page: pno, xref: a.xref, annot: a }; setActions();
      });
      b.addEventListener('dblclick', async () => {
        const txt = await promptBox('Comment text', 'Text', a.content, 'textarea');
        if (txt != null) op({ op: 'edit_annot', page: pno, xref: a.xref, content: txt });
      });
      L.append(b);
    }
    for (const f of o.fields) fieldInput(L, f, place);
    for (const lk of o.links) {
      const b = h('div', { class: 'box', style: { cursor: 'pointer' }, title: lk.uri || `Go to page ${lk.page + 1}` }); place(b, lk.rect);
      b.addEventListener('click', () => lk.uri ? window.open(lk.uri, '_blank') : scrollToPage(lk.page));
      L.append(b);
    }
  }
}

function fieldInput(L, f, place) {
  let el;
  if (f.type === 'CheckBox' || f.type === 'RadioButton') {
    el = h('input', { type: 'checkbox', class: 'fld' }); el.checked = f.value && f.value !== 'Off';
    el.addEventListener('change', () => op({ op: 'fill_form', values: { [f.xref]: el.checked } }, 'Saving field…'));
  } else if (f.type === 'ComboBox' || f.type === 'ListBox') {
    el = h('select', { class: 'fld' }, f.options.map(o => { const v = Array.isArray(o) ? o[1] : o; return h('option', { selected: v === f.value }, v); }));
    el.addEventListener('change', () => op({ op: 'fill_form', values: { [f.xref]: el.value } }, 'Saving field…'));
  } else if (f.type === 'Text') {
    const tall = (f.rect[3] - f.rect[1]) > 30;
    el = h(tall ? 'textarea' : 'input', { class: 'fld', placeholder: f.name }); el.value = f.value || '';
    el.style.fontSize = Math.max(8, Math.min(14, (f.rect[3] - f.rect[1]) * 0.6)) * S.zoom + 'px';
    el.addEventListener('change', () => op({ op: 'fill_form', values: { [f.xref]: el.value } }, 'Saving field…'));
  } else return;
  el.title = f.name; place(el, f.rect); el.addEventListener('pointerdown', e => e.stopPropagation()); L.append(el);
}

/* ---------- edit existing text */
function startTextEdit(pno, ln, box) {
  const L = box.parentElement, Z = S.zoom;
  const ed = h('div', { class: 'editor', contenteditable: 'true', spellcheck: 'true' });
  ed.textContent = ln.text;
  const fam = { sans: 'Helvetica, Arial, sans-serif', serif: '"Times New Roman", Times, serif', mono: '"Courier New", monospace' };
  let st = { size: ln.size, color: ln.color, family: ln.family, bold: ln.bold, italic: ln.italic };
  const style = () => Object.assign(ed.style, {
    left: ln.bbox[0] * Z - 2 + 'px', top: ln.bbox[1] * Z + 'px', minHeight: (ln.bbox[3] - ln.bbox[1]) * Z + 'px', minWidth: (ln.bbox[2] - ln.bbox[0]) * Z + 4 + 'px',
    fontSize: st.size * Z + 'px', color: st.color, fontFamily: fam[st.family], fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? 'italic' : 'normal',
    background: ln.color.toLowerCase() === '#ffffff' ? '#333' : '#fff'
  });
  style(); L.append(ed); box.style.visibility = 'hidden';
  // reflect line style into the props bar so it can be changed
  setPropsFrom(st); S.textEditStyle = s => { Object.assign(st, s); style(); };
  ed.focus(); document.getSelection().selectAllChildren(ed);
  let done = false;
  const finish = async save => {
    if (done) return; done = true; S.textEditStyle = null;
    const txt = ed.innerText.replace(/\n$/, '');
    ed.remove(); box.style.visibility = '';
    const changed = txt !== ln.text || st.size !== ln.size || st.color !== ln.color || st.family !== ln.family || st.bold !== ln.bold || st.italic !== ln.italic;
    if (save && changed) await op({ op: 'edit_text', page: pno, bbox: ln.bbox, origin: ln.origin, dir: ln.dir, text: txt, ...st }, 'Updating text…');
  };
  ed.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  ed.addEventListener('blur', () => setTimeout(() => { if (!document.activeElement?.closest('#props')) finish(true); else ed.focus(); }, 120));
  S.sel = { kind: 'text', page: pno, line: ln }; setActions();
}

/* ---------- edit images */
function imageInteractions(pno, im, b) {
  const Z = S.zoom;
  b.addEventListener('pointerdown', e => {
    e.stopPropagation(); e.preventDefault();
    $$('.img-box.sel').forEach(x => { x.classList.remove('sel'); x.innerHTML = ''; });
    b.classList.add('sel');
    S.sel = { kind: 'image', page: pno, img: im }; setActions();
    b.append(h('div', { class: 'handle' }), h('div', { class: 'floatbar' },
      h('button', { onclick: ev => { ev.stopPropagation(); replaceImage(pno, im); } }, 'Replace'),
      h('button', { onclick: ev => { ev.stopPropagation(); op({ op: 'delete_image', page: pno, bbox: im.bbox }, 'Deleting image…'); } }, 'Delete'),
      h('button', { onclick: ev => { ev.stopPropagation(); openStudio(pno); } }, '🎨 Image Studio')));
    const resize = e.target.classList.contains('handle');
    const sx = e.clientX, sy = e.clientY, r0 = [...im.bbox];
    const ratio = (r0[2] - r0[0]) / (r0[3] - r0[1]);
    let r = [...r0], moved = false;
    const move = ev => {
      const dx = (ev.clientX - sx) / Z, dy = (ev.clientY - sy) / Z;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      if (resize) { const w = Math.max(10, r0[2] - r0[0] + dx); r = [r0[0], r0[1], r0[0] + w, r0[1] + (ev.shiftKey ? (r0[3] - r0[1] + dy) : w / ratio)]; }
      else r = [r0[0] + dx, r0[1] + dy, r0[2] + dx, r0[3] + dy];
      Object.assign(b.style, { left: r[0] * Z + 'px', top: r[1] * Z + 'px', width: (r[2] - r[0]) * Z + 'px', height: (r[3] - r[1]) * Z + 'px' });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moved) op({ op: 'move_image', page: pno, xref: im.xref, bbox: im.bbox, rect: r }, resize ? 'Resizing image…' : 'Moving image…');
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
}
async function replaceImage(pno, im) {
  const data = await pickImage(); if (!data) return;
  op({ op: 'replace_image', page: pno, xref: im.xref, bbox: im.bbox, data }, 'Replacing image…');
}
function pickImage() {
  return new Promise(res => {
    const inp = $('#fileImg'); inp.value = '';
    inp.onchange = () => { const f = inp.files[0]; if (!f) return res(null); const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); };
    inp.click();
  });
}
const imgSize = src => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = src; });

/* ---------- pointer tools (drag rects, ink, clicks) */
function ptFrom(pg, e) {
  const b = pg.getBoundingClientRect();
  return [(e.clientX - b.left) / S.zoom, (e.clientY - b.top) / S.zoom];
}
const norm = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
const DRAG_TOOLS = ['highlight', 'underline', 'strikeout', 'freetext', 'rect', 'circle', 'line', 'arrow', 'redact', 'field', 'link', 'addtext', 'addimage'];

function attachPointer(pg) {
  pg.addEventListener('pointerdown', e => {
    const t = S.tool, pno = +pg.dataset.p;
    S.cur = pno; markThumbCur();
    if (t === 'pan') return panStart(e);
    if (t === 'select' || t === 'edittext' || t === 'editimage') {
      $$('.annot-box.sel,.img-box.sel').forEach(x => { x.classList.remove('sel'); if (x.classList.contains('img-box')) x.innerHTML = ''; });
      S.sel = null; setActions(); return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const L = pg.querySelector('.layer'), svg = L.querySelector('svg'), Z = S.zoom;
    const p0 = ptFrom(pg, e);
    if (t === 'note') return addNote(pno, p0);
    if (t === 'sign') return placeSignature(pno, p0);
    pg.setPointerCapture(e.pointerId);
    const col = S.props.color;
    let preview, pts = [p0];
    if (t === 'ink') {
      preview = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      Object.entries({ fill: 'none', stroke: col, 'stroke-width': S.props.width * Z, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }).forEach(([k, v]) => preview.setAttribute(k, v));
    } else if (t === 'line' || t === 'arrow') {
      preview = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      Object.entries({ stroke: col, 'stroke-width': S.props.width * Z }).forEach(([k, v]) => preview.setAttribute(k, v));
    } else {
      preview = document.createElementNS('http://www.w3.org/2000/svg', t === 'circle' ? 'ellipse' : 'rect');
      const fill = { highlight: 'rgba(255,220,0,.3)', redact: 'rgba(0,0,0,.4)', addimage: 'rgba(47,111,237,.1)', addtext: 'rgba(47,111,237,.06)', field: 'rgba(60,110,240,.15)' }[t] || 'none';
      const stroke = ['highlight', 'underline', 'strikeout'].includes(t) ? '#2f6fed' : t === 'redact' ? '#000' : ['rect', 'circle'].includes(t) ? col : '#2f6fed';
      Object.entries({ fill, stroke, 'stroke-width': ['rect', 'circle'].includes(t) ? S.props.width * Z : 1.5, 'stroke-dasharray': ['rect', 'circle'].includes(t) ? '' : '4 3' }).forEach(([k, v]) => preview.setAttribute(k, v));
    }
    svg.append(preview);
    const draw = p => {
      if (t === 'ink') { pts.push(p); preview.setAttribute('points', pts.map(q => `${q[0] * Z},${q[1] * Z}`).join(' ')); }
      else if (t === 'line' || t === 'arrow') { pts[1] = p; Object.entries({ x1: p0[0] * Z, y1: p0[1] * Z, x2: p[0] * Z, y2: p[1] * Z }).forEach(([k, v]) => preview.setAttribute(k, v)); }
      else {
        pts[1] = p; const r = norm(p0, p);
        if (t === 'circle') Object.entries({ cx: (r[0] + r[2]) / 2 * Z, cy: (r[1] + r[3]) / 2 * Z, rx: (r[2] - r[0]) / 2 * Z, ry: (r[3] - r[1]) / 2 * Z }).forEach(([k, v]) => preview.setAttribute(k, v));
        else Object.entries({ x: r[0] * Z, y: r[1] * Z, width: (r[2] - r[0]) * Z, height: (r[3] - r[1]) * Z }).forEach(([k, v]) => preview.setAttribute(k, v));
      }
    };
    const move = ev => draw(ptFrom(pg, ev));
    const up = async ev => {
      pg.removeEventListener('pointermove', move); pg.removeEventListener('pointerup', up);
      const p1 = ptFrom(pg, ev); draw(p1);
      const r = norm(p0, p1), tiny = (r[2] - r[0]) < 4 && (r[3] - r[1]) < 4;
      const P = S.props;
      try {
        if (t === 'ink') { if (pts.length > 1) await op({ op: 'ink', page: pno, paths: [pts], color: P.color, width: P.width }, 'Saving drawing…'); }
        else if (t === 'line' || t === 'arrow') { if (!tiny) await op({ op: 'shape', kind: t, page: pno, p1: p0, p2: p1, color: P.color, width: P.width }); }
        else if (t === 'rect' || t === 'circle') { if (!tiny) await op({ op: 'shape', kind: t, page: pno, rect: r, color: P.color, width: P.width, fill: P.fill }); }
        else if (['highlight', 'underline', 'strikeout'].includes(t)) await op({ op: 'markup', kind: t, page: pno, rect: tiny ? [r[0] - 2, r[1] - 2, r[0] + 2, r[1] + 2] : r, color: t === 'highlight' ? (P.hlColor || '#ffe600') : P.color }, 'Marking up…');
        else if (t === 'redact') { if (!tiny) { S.pendingRedact.push({ page: pno, rect: r }); setActions(); } }
        else if (t === 'freetext') {
          const rr = tiny ? [r[0], r[1], r[0] + 180, r[1] + 40] : r;
          const txt = await promptBox('Text box', 'Text', '', 'textarea');
          if (txt) await op({ op: 'freetext', page: pno, rect: rr, text: txt, size: P.size, color: P.color, fill: P.fill });
        }
        else if (t === 'addtext') { preview.remove(); return addTextBox(pno, tiny ? [r[0], r[1] - P.size, r[0] + 260, r[1] + P.size * 2] : r); }
        else if (t === 'addimage') {
          const data = await pickImage();
          if (data) {
            let rr = r;
            if (tiny) { const [w, hh] = await imgSize(data); const W = Math.min(220, w * 0.75); rr = [r[0], r[1], r[0] + W, r[1] + W * hh / w]; }
            await op({ op: 'add_image', page: pno, rect: rr, data, keep: true }, 'Placing image…');
          }
        }
        else if (t === 'field') {
          const ft = P.fieldType; const rr = tiny ? [r[0], r[1], r[0] + (ft === 'checkbox' ? 14 : 180), r[1] + (ft === 'checkbox' ? 14 : 22)] : r;
          const name = await promptBox('New form field', 'Field name', ''); if (name == null) throw 0;
          let options;
          if (ft === 'combobox' || ft === 'listbox') { const o = await promptBox('Options', 'Comma-separated choices', 'Yes, No'); options = (o || '').split(',').map(s => s.trim()).filter(Boolean); }
          await op({ op: 'add_field', page: pno, rect: rr, type: ft, name, options });
        }
        else if (t === 'link') {
          if (!tiny) {
            const target = await promptBox('Add link', 'Web address (https://…) or page number', 'https://');
            if (target) await op(/^\d+$/.test(target.trim()) ? { op: 'add_link', page: pno, rect: r, target: +target - 1 } : { op: 'add_link', page: pno, rect: r, uri: target.trim() });
          }
        }
      } catch (err) { if (err) console.error(err); }
      preview.remove();
      if (t === 'redact') buildLayer(pno);
    };
    pg.addEventListener('pointermove', move); pg.addEventListener('pointerup', up);
  });
}

function panStart(e) {
  const v = $('#viewer'), sx = e.clientX, sy = e.clientY, st = v.scrollTop, sl = v.scrollLeft;
  const move = ev => { v.scrollTop = st - (ev.clientY - sy); v.scrollLeft = sl - (ev.clientX - sx); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function addTextBox(pno, r) {
  const L = layerEl(pno), Z = S.zoom, P = S.props;
  const fam = { sans: 'Helvetica, Arial, sans-serif', serif: '"Times New Roman", serif', mono: '"Courier New", monospace' };
  const ta = h('textarea', { class: 'editor', placeholder: 'Type here…' });
  Object.assign(ta.style, { left: r[0] * Z + 'px', top: r[1] * Z + 'px', width: Math.max(80, (r[2] - r[0])) * Z + 'px', height: Math.max(P.size * 1.6, r[3] - r[1]) * Z + 'px', fontSize: P.size * Z + 'px', color: P.color, fontFamily: fam[P.family], fontWeight: P.bold ? 700 : 400, fontStyle: P.italic ? 'italic' : 'normal' });
  L.append(ta); ta.focus(); setTimeout(() => { if (document.activeElement !== ta) ta.focus(); }, 60);
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const txt = ta.value; const w = ta.offsetWidth / Z, hh = ta.offsetHeight / Z; ta.remove();
    if (save && txt.trim()) await op({ op: 'add_text', page: pno, rect: [r[0], r[1], r[0] + w, r[1] + hh], text: txt, size: S.props.size, color: S.props.color, family: S.props.family, bold: S.props.bold, italic: S.props.italic }, 'Adding text…');
  };
  ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') finish(false); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true); });
  ta.addEventListener('blur', () => setTimeout(() => {
    if (done || document.activeElement === ta) return;
    if (document.activeElement?.closest('#props')) return ta.focus();
    if (ta.value.trim()) finish(true); else finish(false);
  }, 150));
  S.cancelAddText = () => finish(false);
  ta.addEventListener('pointerdown', e => e.stopPropagation());
}

async function addNote(pno, p) {
  const txt = await promptBox('Sticky note', 'Note', '', 'textarea');
  if (txt != null) op({ op: 'note', page: pno, point: p, text: txt, color: S.props.color });
}

/* ---------- signatures */
async function placeSignature(pno, p) {
  if (!S.sig) { S.sig = await signatureDialog(); if (!S.sig) return; }
  const [w, hh] = await imgSize(S.sig);
  const W = 160, H = W * hh / w;
  await op({ op: 'add_image', page: pno, rect: [p[0] - W / 2, p[1] - H / 2, p[0] + W / 2, p[1] + H / 2], data: S.sig, keep: true }, 'Signing…');
}
function savedSigs() { try { return JSON.parse(localStorage.getItem('pdfstudio.sigs') || '[]'); } catch { return []; } }
function signatureDialog() {
  return new Promise(resolve => {
    const body = h('div');
    const tabs = h('div', { class: 'sigtabs' });
    const pad = h('canvas', { class: 'sigpad', width: 900, height: 340 });
    const ctx = pad.getContext('2d'); ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let mode = 'draw', drawing = false, inked = false;
    const typed = h('input', { type: 'text', placeholder: 'Type your name', style: { fontSize: '20px' } });
    const font = h('select', {}, ['"Brush Script MT", cursive', '"Segoe Script", cursive', '"Snell Roundhand", cursive', 'cursive', 'serif'].map(f => h('option', { value: f }, f.split(',')[0].replace(/"/g, ''))));
    const colorSel = h('input', { type: 'color', value: '#0b2a6f' });
    const typedBox = h('div', { class: 'hidden' }, typed, h('div', { class: 'row' }, 'Style ', font));
    const upBox = h('div', { class: 'hidden' }, h('p', {}, 'Upload a photo or scan of your signature (transparent PNG works best).'));
    const pos = e => { const b = pad.getBoundingClientRect(); return [(e.clientX - b.left) * pad.width / b.width, (e.clientY - b.top) * pad.height / b.height]; };
    pad.addEventListener('pointerdown', e => { drawing = true; pad.setPointerCapture(e.pointerId); ctx.strokeStyle = colorSel.value; ctx.beginPath(); ctx.moveTo(...pos(e)); });
    pad.addEventListener('pointermove', e => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); inked = true; });
    pad.addEventListener('pointerup', () => drawing = false);
    const renderTyped = () => {
      ctx.clearRect(0, 0, pad.width, pad.height); ctx.fillStyle = colorSel.value;
      ctx.font = `110px ${font.value}`; ctx.textBaseline = 'middle'; ctx.fillText(typed.value, 30, pad.height / 2); inked = !!typed.value.trim();
    };
    typed.oninput = renderTyped; font.onchange = renderTyped;
    const setMode = m => { mode = m; $$('button', tabs).forEach(b => b.classList.toggle('on', b.dataset.m === m)); typedBox.classList.toggle('hidden', m !== 'type'); upBox.classList.toggle('hidden', m !== 'upload'); pad.classList.toggle('hidden', m === 'upload'); };
    ['draw', 'type', 'upload'].forEach(m => tabs.append(h('button', { 'data-m': m, onclick: () => setMode(m) }, m[0].toUpperCase() + m.slice(1))));
    const trim = () => { // crop transparent margins
      const d = ctx.getImageData(0, 0, pad.width, pad.height).data; let x0 = pad.width, y0 = pad.height, x1 = 0, y1 = 0;
      for (let y = 0; y < pad.height; y += 2) for (let x = 0; x < pad.width; x += 2) if (d[(y * pad.width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      if (x1 <= x0) return null;
      const c = h('canvas', { width: x1 - x0 + 20, height: y1 - y0 + 20 }); c.getContext('2d').drawImage(pad, x0 - 10, y0 - 10, c.width, c.height, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    };
    const saved = h('div', { class: 'saved-sigs' }, savedSigs().map(s => h('img', { src: s, title: 'Use this signature', onclick: () => { closeModal(); resolve(s); } })));
    body.append(tabs, pad, typedBox, upBox, h('div', { class: 'row' }, 'Ink ', colorSel, h('button', { onclick: () => { ctx.clearRect(0, 0, pad.width, pad.height); inked = false; } }, 'Clear')),
      savedSigs().length ? h('h4', {}, 'Saved signatures') : '', saved);
    setMode('draw');
    openModal('Create signature', body, [
      ['Cancel', () => { closeModal(); resolve(null); }],
      ['Use signature', async () => {
        let data = null;
        if (mode === 'upload') data = await pickImage(); else if (inked) data = trim();
        if (!data) return toast('Draw, type or upload a signature first', 'err');
        const list = [data, ...savedSigs().filter(s => s !== data)].slice(0, 6);
        try { localStorage.setItem('pdfstudio.sigs', JSON.stringify(list)); } catch { }
        closeModal(); resolve(data); toast('Signature placed — click again to sign elsewhere, or drag it with Edit image');
      }, 'primary']]);
  });
}

/* ------------------------------------------------------------------ tool & props bar */
const TOOL_PROPS = {
  select: [], pan: [], edittext: ['color', 'size', 'family', 'style'], editimage: [], addtext: ['color', 'size', 'family', 'style'],
  addimage: [], sign: [], highlight: ['color'], underline: ['color'], strikeout: ['color'], note: ['color'], freetext: ['color', 'size', 'fill'],
  ink: ['color', 'width'], rect: ['color', 'width', 'fill'], circle: ['color', 'width', 'fill'], line: ['color', 'width'], arrow: ['color', 'width'],
  redact: [], field: ['field'], link: [],
};
const HINTS = {
  select: 'Fill form fields directly · click a comment to select it (Del removes, double-click edits)',
  pan: 'Drag to move around the document',
  edittext: 'Click any line of text to edit it in place · Enter saves · Shift+Enter adds a line · Esc cancels',
  editimage: 'Drag an image to move it · drag the corner to resize · use Replace / Delete',
  addtext: 'Click or drag a box where the new text goes · Ctrl+Enter saves',
  addimage: 'Click (or drag a box) where the image goes', sign: 'Click where to place your signature',
  highlight: 'Drag across text to highlight', underline: 'Drag across text to underline', strikeout: 'Drag across text to strike through',
  note: 'Click to drop a sticky note', freetext: 'Drag a box for a text comment', ink: 'Draw freehand', rect: 'Drag to draw', circle: 'Drag to draw', line: 'Drag to draw', arrow: 'Drag from tail to head',
  redact: 'Drag boxes over content to remove, then Apply — redaction permanently deletes the text, images and graphics underneath',
  field: 'Drag to create a form field', link: 'Drag over an area to make it a link',
};
function setTool(t) {
  S.tool = t; S.sel = null;
  $$('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  const show = TOOL_PROPS[t] || [];
  ['color', 'size', 'family', 'style', 'width', 'fill', 'field'].forEach(k => $('.p-' + k).classList.toggle('hidden', !show.includes(k)));
  $('#propsHint').textContent = HINTS[t] || '';
  if (t === 'highlight') $('#pColor').value = S.props.hlColor || '#ffe600'; else $('#pColor').value = S.props.color;
  $('#viewer').className = t === 'pan' ? 'pan' : '';
  if (t === 'sign') S.sig = null;
  setActions();
  if (S.doc) $$('.page').forEach(pg => { const r = pg.getBoundingClientRect(); if (r.bottom > -600 && r.top < innerHeight + 600) buildLayer(+pg.dataset.p); });
}
function setActions() {
  const a = $('#propsActions'); a.innerHTML = '';
  if (S.tool === 'redact' && S.pendingRedact.length) {
    a.append(h('button', { onclick: () => { S.pendingRedact = []; setActions(); setTool('redact'); } }, 'Clear marks'),
      h('button', { class: 'primary', onclick: applyRedactions }, `Apply ${S.pendingRedact.length} redaction${S.pendingRedact.length > 1 ? 's' : ''}`));
  }
  if (S.sel?.kind === 'annot') a.append(h('button', { class: 'danger', onclick: deleteSelection }, 'Delete comment'));
  if (S.sel?.kind === 'text') a.append(h('button', { class: 'danger', onmousedown: e => e.preventDefault(), onclick: deleteSelection }, 'Delete line'));
  if (S.tool === 'sign') a.append(h('button', { onclick: async () => { S.sig = await signatureDialog(); } }, S.sig ? 'Change signature' : 'Create signature'));
}
async function applyRedactions() {
  if (!await confirmBox(`Permanently remove everything under ${S.pendingRedact.length} marked area(s)? (You can still undo.)`)) return;
  const areas = S.pendingRedact; S.pendingRedact = [];
  await op({ op: 'redact', areas }, 'Redacting…'); setActions();
}
async function deleteSelection() {
  const s = S.sel; if (!s) return; S.sel = null;
  if (s.kind === 'annot') await op({ op: 'delete_annot', page: s.page, xref: s.xref });
  if (s.kind === 'image') await op({ op: 'delete_image', page: s.page, bbox: s.img.bbox });
  if (s.kind === 'text') { $$('.editor').forEach(e => e.remove()); await op({ op: 'delete_text', page: s.page, bbox: s.line.bbox }, 'Deleting text…'); }
  setActions();
}
function setPropsFrom(st) {
  $('#pColor').value = st.color; $('#pSize').value = st.size; $('#pFamily').value = st.family;
  $('#pBold').classList.toggle('on', st.bold); $('#pItalic').classList.toggle('on', st.italic);
}
function readProps() {
  const P = S.props;
  if (S.tool === 'highlight') P.hlColor = $('#pColor').value; else P.color = $('#pColor').value;
  P.size = +$('#pSize').value || 12; P.family = $('#pFamily').value; P.width = +$('#pWidth').value;
  P.bold = $('#pBold').classList.contains('on'); P.italic = $('#pItalic').classList.contains('on');
  P.fill = $('#pFillOn').checked ? $('#pFill').value : null; P.fieldType = $('#pFieldType').value;
  S.textEditStyle?.({ color: $('#pColor').value, size: P.size, family: P.family, bold: P.bold, italic: P.italic });
}
$$('#props input,#props select').forEach(el => el.addEventListener('input', readProps));
['#pBold', '#pItalic'].forEach(s => $(s).addEventListener('mousedown', e => { e.preventDefault(); $(s).classList.toggle('on'); readProps(); }));
$$('#tools button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

/* ------------------------------------------------------------------ thumbnails */
function renderThumbs() {
  const box = $('#thumbs'); box.innerHTML = '';
  if (!S.doc) return;
  let dragFrom = null;
  S.doc.pages.forEach((p, i) => {
    const t = h('div', { class: 'thumb' + (i === S.cur ? ' cur' : '') + (S.thumbSel.has(i) ? ' sel' : ''), draggable: 'true', 'data-p': i },
      h('img', { loading: 'lazy', src: `/api/docs/${S.id}/page/${i}.png?scale=0.22&v=${ver()}` }), h('span', {}, i + 1));
    t.addEventListener('click', e => {
      if (e.shiftKey && S.thumbSel.size) { const a = Math.min(...S.thumbSel, i), b = Math.max(...S.thumbSel, i); for (let k = a; k <= b; k++) S.thumbSel.add(k); }
      else if (e.ctrlKey || e.metaKey) S.thumbSel.has(i) ? S.thumbSel.delete(i) : S.thumbSel.add(i);
      else { S.thumbSel.clear(); S.thumbSel.add(i); scrollToPage(i); }
      $$('.thumb').forEach(x => x.classList.toggle('sel', S.thumbSel.has(+x.dataset.p)));
    });
    t.addEventListener('dragstart', e => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; });
    t.addEventListener('dragover', e => { e.preventDefault(); t.classList.add('dragover'); });
    t.addEventListener('dragleave', () => t.classList.remove('dragover'));
    t.addEventListener('drop', e => {
      e.preventDefault(); t.classList.remove('dragover');
      if (dragFrom == null || dragFrom === i) return;
      const moving = S.thumbSel.has(dragFrom) && S.thumbSel.size > 1 ? [...S.thumbSel].sort((a, b) => a - b) : [dragFrom];
      const rest = S.doc.pages.map((_, k) => k).filter(k => !moving.includes(k));
      let at = rest.indexOf(i); if (at < 0) at = rest.length;
      const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
      S.thumbSel.clear();
      op({ op: 'reorder', order }, 'Reordering pages…');
    });
    box.append(t);
  });
}
function markThumbCur() { $$('.thumb').forEach(x => x.classList.toggle('cur', +x.dataset.p === S.cur)); }
const selPages = () => S.thumbSel.size ? [...S.thumbSel].sort((a, b) => a - b) : [S.cur];

$('#pgRotL').onclick = () => op({ op: 'rotate', pages: selPages(), angle: -90 });
$('#pgRotR').onclick = () => op({ op: 'rotate', pages: selPages(), angle: 90 });
$('#pgDup').onclick = () => op({ op: 'duplicate_page', page: S.cur });
$('#pgDel').onclick = async () => { const p = selPages(); if (await confirmBox(`Delete ${p.length} page(s)?`)) { S.thumbSel.clear(); op({ op: 'delete_pages', pages: p }); } };
$('#pgBlank').onclick = () => op({ op: 'insert_blank', at: S.cur + 1 });
$('#pgExtract').onclick = async () => {
  const pages = selPages().map(p => p + 1).join(',');
  const f = await formBox('Extract pages', [['pages', 'Pages (e.g. 1-3,5)', pages], ['del', 'Remove them from this document', false, 'checkbox']]);
  if (!f) return;
  const r = await op({ op: 'extract', pages: f.pages, delete_from_source: f.del });
  if (r?.created?.length) { await loadDocs(); toast('Created a new file with the extracted pages'); }
};
$('#pgSplit').onclick = async () => {
  const f = await formBox('Split document', [['mode', 'Split by', 'every', 'select', [['every', 'Every N pages'], ['ranges', 'Custom ranges']]], ['every', 'N (pages per file)', '1', 'number'], ['ranges', 'Ranges, separated by ; (e.g. 1-3;4-8;9-)', '']]);
  if (!f) return;
  const r = await op(f.mode === 'every' ? { op: 'split', every: +f.every } : { op: 'split', ranges: f.ranges }, 'Splitting…');
  if (r?.created) { await loadDocs(); toast(`Created ${r.created.length} files`); showTab('library'); }
};
$('#pgInsert').onclick = () => {
  const inp = $('#fileAny'); inp.value = '';
  inp.onchange = async () => {
    for (const f of inp.files) {
      const fd = new FormData(); fd.append('file', f); fd.append('at', S.cur + 1);
      const r = await busy(`Inserting ${f.name}…`, () => api(`/api/docs/${S.id}/insert-file`, { form: fd }));
      await applyDoc(r.doc);
    }
  };
  inp.click();
};

/* ------------------------------------------------------------------ outline, side panel */
function renderToc() {
  const ul = $('#tocList'); ul.innerHTML = '';
  (S.doc?.toc || []).forEach(([lvl, title, page]) => ul.append(h('li', { style: { paddingLeft: 8 + (lvl - 1) * 14 + 'px' }, onclick: () => scrollToPage(page - 1) }, title, h('span', { class: 'small', style: { marginLeft: 'auto' } }, page))));
  if (!ul.children.length) ul.append(h('li', { class: 'small' }, 'No bookmarks'));
  const al = $('#attList'); al.innerHTML = '';
  (S.doc?.attachments || []).forEach(n => al.append(h('li', { onclick: () => location.href = `/api/docs/${S.id}/attachment/${encodeURIComponent(n)}` }, '📎 ' + n)));
}
$('#btnAddBm').onclick = async () => { const t = await promptBox('Bookmark', 'Title', `Page ${S.cur + 1}`); if (t) op({ op: 'add_bookmark', title: t, page: S.cur }); };
$('#btnAttach').onclick = () => {
  const inp = $('#fileAny'); inp.value = '';
  inp.onchange = () => { const f = inp.files[0]; if (!f) return; const fr = new FileReader(); fr.onload = () => op({ op: 'attach_file', filename: f.name, data: fr.result }); fr.readAsDataURL(f); };
  inp.click();
};

async function renderSide() {
  if (!S.doc) return;
  if (window.renderSigs) renderSigs();
  $('#protState').textContent = S.doc.protect ? '🔒 Password protection will be applied when you export the PDF.' : '';
  $('#docStats').textContent = `${S.doc.pages.length} pages · ${fmtSize(S.doc.size)} · ${S.doc.versions.length} versions`;
  // forms
  const fields = await api(`/api/docs/${S.id}/fields`);
  const fl = $('#formList'); fl.innerHTML = '';
  if (!fields.length) fl.textContent = 'No form fields. Use the Field tool to create some.';
  fields.forEach(f => fl.append(h('div', { class: 'row', style: { cursor: 'pointer' }, onclick: () => { scrollToPage(f.page); setTool('select'); } },
    h('b', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, f.name), h('span', {}, String(f.value ?? '').slice(0, 18) || '—'),
    h('button', { class: 'x', title: 'Delete field', onclick: e => { e.stopPropagation(); op({ op: 'delete_field', xref: f.xref }); } }, '✕'))));
  // annotations
  const al = $('#annotList'); al.innerHTML = '';
  const pages = S.doc.pages.length > 60 ? [] : S.doc.pages.map((_, i) => i);
  const all = (await Promise.all(pages.map(i => objects(i).then(o => o.annots.filter(a => a.type !== 'Widget' && a.type !== 'Link').map(a => ({ ...a, page: i })))))).flat();
  if (!all.length) al.append(h('li', { class: 'small' }, pages.length ? 'No comments' : 'Large file — open pages to see comments'));
  all.forEach(a => al.append(h('li', { onclick: () => { scrollToPage(a.page); setTool('select'); } },
    h('span', { class: 'sw', style: { background: a.color || '#ccc' } }), h('span', { class: 't' }, `p${a.page + 1} · ${a.type}${a.content ? ' — ' + a.content : ''}`),
    h('button', { class: 'x', onclick: e => { e.stopPropagation(); op({ op: 'delete_annot', page: a.page, xref: a.xref }); } }, '✕'))));
}

function renderHistory() {
  const m = $('#historyMenu'); m.innerHTML = '';
  S.doc.versions.map((v, i) => [v, i]).reverse().forEach(([v, i]) => m.append(h('button', {
    class: i === S.doc.cur ? 'cur' : '', onclick: async () => { m.classList.remove('open'); applyDoc(await api(`/api/docs/${S.id}/restore/${i}`, { method: 'POST' })); }
  }, `${v.label}`, h('span', { class: 'small', style: { float: 'right' } }, new Date(v.t * 1000).toLocaleTimeString()))));
}

/* ------------------------------------------------------------------ right panel actions */
const ACTIONS = {
  async flattenForms() { if (await confirmBox('Flatten form fields into the page? They will no longer be editable.')) op({ op: 'flatten', annots: false, widgets: true }); },
  async flattenAnnots() { if (await confirmBox('Burn all comments and markup into the page content?')) op({ op: 'flatten', annots: true, widgets: false }); },
  async protect() {
    const f = await formBox('Password protect', [['user_pw', 'Password to open (leave empty for none)', '', 'password'], ['owner_pw', 'Permissions password', '', 'password'],
    ['print', 'Allow printing', true, 'checkbox'], ['copy', 'Allow copying text', true, 'checkbox'], ['edit', 'Allow editing', false, 'checkbox']],
      S.doc.protect ? [['Remove protection', () => { closeModal(); op({ op: 'unprotect' }); }]] : []);
    if (f) { await op({ op: 'protect', ...f }); toast('Protection (AES-256) applies to PDFs you export'); }
  },
  async redactSearch() {
    const f = await formBox('Find & redact', [['mode', 'Find', 'text', 'select', [['text', 'Exact text'], ['ssn', 'US Social Security numbers'], ['email', 'Email addresses'], ['phone', 'Phone numbers'], ['card', 'Card numbers'], ['regex', 'Custom pattern (regex)']]], ['q', 'Text or pattern', ''], ['label', 'Overlay label (optional)', '']]);
    if (!f) return;
    const pats = { ssn: String.raw`\b\d{3}-\d{2}-\d{4}\b`, email: String.raw`[\w.+-]+@[\w-]+\.[\w.]+`, phone: String.raw`\(?\b\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b`, card: String.raw`\b(?:\d[ -]?){13,16}\b` };
    const p = f.mode === 'text' ? { query: f.q } : { pattern: f.mode === 'regex' ? f.q : pats[f.mode] };
    const r = await op({ op: 'redact', ...p, label: f.label }, 'Redacting…');
    if (r) toast(`Redacted ${r.result.redacted} occurrence(s)`);
  },
  async sanitize() { if (await confirmBox('Remove metadata, hidden text, JavaScript, embedded files and other hidden information?')) op({ op: 'sanitize' }, 'Sanitizing…'); },
  async ocr() {
    const f = await formBox('OCR — recognise text', [['lang', 'Language', 'eng', 'select', [['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'], ['eng+spa', 'English + Spanish']]], ['force', 'Re-OCR pages that already have text (rasterises them)', false, 'checkbox']]);
    if (f) { await op({ op: 'ocr', ...f }, 'Running OCR — this can take a while…'); toast('Text is now searchable and selectable'); }
  },
  async compress() {
    const f = await formBox('Compress', [['level', 'Level', 'medium', 'select', [['low', 'Lossless clean-up'], ['medium', 'Medium — 150 dpi images'], ['high', 'High — 110 dpi images'], ['extreme', 'Extreme — 72 dpi images']]]]);
    if (!f) return;
    const r = await op({ op: 'compress', level: f.level }, 'Compressing…');
    if (r) toast(`${fmtSize(r.result.before)} → ${fmtSize(r.result.after)} (${Math.round(100 - r.result.after / r.result.before * 100)}% smaller)`, '', 6000);
  },
  async grayscale() { if (await confirmBox('Convert every page to grayscale? Pages are rasterised at 150 dpi.')) op({ op: 'grayscale' }, 'Converting…'); },
  async watermark() {
    const f = await formBox('Watermark', [['text', 'Text', 'CONFIDENTIAL'], ['size', 'Font size', '60', 'number'], ['angle', 'Angle', '45', 'number'], ['opacity', 'Opacity (0-1)', '0.18', 'number'], ['color', 'Colour', '#cc2222', 'color'], ['front', 'In front of content', true, 'checkbox'], ['pages', 'Pages (all, or e.g. 1-3)', 'all'], ['image', 'Use an image instead', false, 'checkbox']]);
    if (!f) return;
    if (f.image) { f.image = await pickImage(); if (!f.image) return; } else delete f.image;
    op({ op: 'watermark', ...f, size: +f.size, angle: +f.angle, opacity: +f.opacity }, 'Adding watermark…');
  },
  async pagenums() {
    const f = await formBox('Page numbers', [['format', 'Format ({n}, {total})', 'Page {n} of {total}'], ['position', 'Position', 'bottom-center', 'select', posOpts], ['size', 'Font size', '10', 'number'], ['start', 'Start at', '1', 'number'], ['pages', 'Pages', 'all']]);
    if (f) op({ op: 'page_numbers', ...f });
  },
  async headerfooter() {
    const f = await formBox('Header & footer', [['top-left', 'Header left', ''], ['top-center', 'Header centre', ''], ['top-right', 'Header right', '{date}'], ['bottom-left', 'Footer left', '{name}'], ['bottom-center', 'Footer centre', ''], ['bottom-right', 'Footer right', 'Page {n} of {total}'], ['size', 'Font size', '9', 'number']]);
    if (f) op({ op: 'header_footer', ...f });
  },
  async bates() {
    const f = await formBox('Bates numbering', [['prefix', 'Prefix', 'ABC'], ['start', 'Start number', '1', 'number'], ['digits', 'Digits', '6', 'number'], ['suffix', 'Suffix', ''], ['position', 'Position', 'bottom-right', 'select', posOpts]]);
    if (f) { const r = await op({ op: 'bates', ...f }); if (r) toast('Last number: ' + r.result.last); }
  },
  async crop() {
    const f = await formBox('Crop margins (points, 72 = 1 inch)', [['t', 'Top', '36', 'number'], ['r', 'Right', '36', 'number'], ['b', 'Bottom', '36', 'number'], ['l', 'Left', '36', 'number'], ['pages', 'Pages', 'all']]);
    if (f) op({ op: 'crop', margins: [f.t, f.r, f.b, f.l], pages: f.pages });
  },
  async resize() {
    const f = await formBox('Resize pages', [['size', 'Paper size', 'letter', 'select', [['letter', 'US Letter'], ['legal', 'US Legal'], ['a4', 'A4'], ['a3', 'A3'], ['a5', 'A5'], ['tabloid', 'Tabloid']]], ['pages', 'Pages', 'all']]);
    if (f) op({ op: 'resize_pages', ...f }, 'Resizing…');
  },
  async background() {
    const f = await formBox('Background colour', [['color', 'Colour', '#fffbe6', 'color'], ['pages', 'Pages', 'all']]);
    if (f) op({ op: 'background', ...f });
  },
  async metadata() {
    const m = S.doc.metadata || {};
    const f = await formBox('Document properties', [['name', 'File name', S.doc.name], ['title', 'Title', m.title || ''], ['author', 'Author', m.author || ''], ['subject', 'Subject', m.subject || ''], ['keywords', 'Keywords', m.keywords || '']]);
    if (!f) return;
    if (f.name !== S.doc.name) await op({ op: 'rename', name: f.name });
    const { name, ...rest } = f; await op({ op: 'metadata', ...rest });
  },
  async readtext() {
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    const t = await api(`/api/docs/${S.id}/text`);
    const u = new SpeechSynthesisUtterance(t.pages.slice(S.cur).join('\n')); speechSynthesis.speak(u);
    toast('Reading from current page — click Read aloud again to stop');
  },
  async wordcount() {
    const t = await api(`/api/docs/${S.id}/text`); const all = t.pages.join(' ');
    const words = (all.match(/\S+/g) || []).length;
    openModal('Word count', h('p', {}, `${words.toLocaleString()} words · ${all.replace(/\s/g, '').length.toLocaleString()} characters · ${t.pages.length} pages`), [['Close', closeModal, 'primary']]);
  },
  async delete() { if (await confirmBox(`Delete “${S.doc.name}” from the library?`)) { await api(`/api/docs/${S.id}`, { method: 'DELETE' }); closeDoc(); loadDocs(); } },
};
const posOpts = [['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-center', 'Top centre'], ['top-right', 'Top right'], ['top-left', 'Top left']];
$$('#right [data-act]').forEach(b => b.addEventListener('click', () => { if (!S.id) return toast('Open a document first', 'err'); ACTIONS[b.dataset.act](); }));

/* ------------------------------------------------------------------ modals */
function openModal(title, body, buttons) {
  $('#mTitle').textContent = title; const mb = $('#mBody'); mb.innerHTML = ''; mb.append(body);
  const bb = $('#mBtns'); bb.innerHTML = '';
  buttons.forEach(([label, fn, cls]) => bb.append(h('button', { class: cls || '', onclick: fn }, label)));
  $('#modal').classList.remove('hidden');
  setTimeout(() => mb.querySelector('input,textarea,select')?.focus(), 30);
}
function closeModal() { $('#modal').classList.add('hidden'); }
function formBox(title, fields, extraButtons = []) {
  return new Promise(res => {
    const body = h('div'); const inputs = {};
    for (const [key, label, val, type = 'text', opts] of fields) {
      let el;
      if (type === 'checkbox') { el = h('input', { type: 'checkbox' }); el.checked = !!val; body.append(h('label', { class: 'inl' }, el, label)); }
      else {
        if (type === 'select') el = h('select', {}, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
        else if (type === 'textarea') el = h('textarea', { rows: 4 });
        else el = h('input', { type, step: type === 'number' ? 'any' : undefined });
        if (type !== 'select') el.value = val ?? '';
        body.append(h('label', {}, label), el);
      }
      inputs[key] = el;
    }
    const submit = () => { const out = {}; for (const [k, el] of Object.entries(inputs)) out[k] = el.type === 'checkbox' ? el.checked : el.value; closeModal(); res(out); };
    body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); submit(); } });
    openModal(title, body, [...extraButtons, ['Cancel', () => { closeModal(); res(null); }], ['OK', submit, 'primary']]);
  });
}
async function promptBox(title, label, val = '', type = 'text') { const f = await formBox(title, [['v', label, val, type]]); return f ? f.v : null; }
function confirmBox(msg) {
  return new Promise(res => openModal('Please confirm', h('p', {}, msg), [['Cancel', () => { closeModal(); res(false); }], ['OK', () => { closeModal(); res(true); }, 'primary']]));
}
$('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') $('#mBtns button')?.click(); });

/* ------------------------------------------------------------------ header controls */
$('#btnUndo').onclick = async () => { if (S.id) applyDoc(await api(`/api/docs/${S.id}/undo`, { method: 'POST' })); };
$('#btnRedo').onclick = async () => { if (S.id) applyDoc(await api(`/api/docs/${S.id}/redo`, { method: 'POST' })); };
$('#zoomIn').onclick = () => setZoom(S.zoom * 1.2);
$('#zoomOut').onclick = () => setZoom(S.zoom / 1.2);
$('#zoomLabel').onclick = fitWidth;
const toggleMenu = (btn, menu) => { $(btn).onclick = e => { e.stopPropagation(); $$('.menu.open').forEach(m => m !== $(menu) && m.classList.remove('open')); $(menu).classList.toggle('open'); }; };
toggleMenu('#btnDownload', '#exportMenu'); toggleMenu('#btnHistory', '#historyMenu');
document.addEventListener('click', e => { if (!e.target.closest('.menu')) $$('.menu.open').forEach(m => m.classList.remove('open')); });
$$('#exportMenu [data-fmt]').forEach(b => b.onclick = () => {
  if (!S.id) return toast('Open a document first', 'err');
  $('#exportMenu').classList.remove('open');
  const fmt = b.dataset.fmt, dpi = $('#exportDpi').value;
  const t = toast(`Preparing ${b.textContent}…`, 'busy', 0);
  fetch(`/api/docs/${S.id}/download?fmt=${fmt}&dpi=${dpi}`).then(async r => {
    t.remove();
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.detail || 'Export failed'); }
    const cd = r.headers.get('content-disposition') || ''; const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd);
    const blob = await r.blob(); const a = h('a', { href: URL.createObjectURL(blob), download: m ? decodeURIComponent(m[1]) : `export.${fmt}` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }).catch(e => { t.remove(); toast(e.message, 'err', 6000); });
});
$('#docTitle').onclick = async () => { if (!S.id) return; const n = await promptBox('Rename', 'File name', S.doc.name); if (n) op({ op: 'rename', name: n }); };

// search
let searchTimer;
$('#searchBox').addEventListener('keydown', async e => {
  if (e.key !== 'Enter' || !S.id) return;
  const q = e.target.value.trim();
  if (S.hits.length && S._q === q) { S.hitIdx = (S.hitIdx + (e.shiftKey ? -1 : 1) + S.hits.length) % S.hits.length; }
  else { S._q = q; S.hits = q ? await api(`/api/docs/${S.id}/search?q=${encodeURIComponent(q)}`) : []; S.hitIdx = S.hits.length ? 0 : -1; }
  $('#searchCount').textContent = S.hits.length ? `${S.hitIdx + 1}/${S.hits.length}` : (q ? '0' : '');
  if (S.hitIdx >= 0) {
    const hit = S.hits[S.hitIdx], pg = pageEl(hit.page);
    $('#viewer').scrollTo({ top: pg.offsetTop + hit.rect[1] * S.zoom - 140, behavior: 'smooth' });
  }
  $$('.page').forEach(pg => buildLayer(+pg.dataset.p));
});

// tabs
function showTab(name) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('#left section').forEach(s => s.classList.toggle('on', s.dataset.pane === name));
  if (name === 'inbox') refreshInbox();
}
$$('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
$('#btnLeft').onclick = () => { $('#left').classList.toggle('open'); $('#right').classList.remove('open'); };
$('#btnRight').onclick = () => { $('#right').classList.toggle('open'); $('#left').classList.remove('open'); };

// uploads
const pickAny = toInbox => { const inp = $('#fileAny'); inp.value = ''; inp.onchange = () => uploadFiles([...inp.files], toInbox); inp.click(); };
$('#btnUpload').onclick = () => pickAny(false); $('#btnUpload2').onclick = () => pickAny(false);
$('#btnInboxUpload').onclick = () => pickAny(true);
$('#btnBlank').onclick = async () => {
  const f = await formBox('New blank document', [['name', 'Name', 'Untitled'], ['size', 'Paper', 'letter', 'select', [['letter', 'US Letter'], ['a4', 'A4'], ['legal', 'US Legal']]], ['pages', 'Pages', '1', 'number']]);
  if (f) { const r = await api('/api/blank', { json: { ...f, pages: +f.pages } }); await loadDocs(); openDoc(r.id); }
};
$('#btnMerge').onclick = async () => {
  const ids = checkedIds(); const name = await promptBox('Merge files', 'Name for the merged file', 'Merged');
  if (name == null) return; const r = await busy('Merging…', () => api('/api/merge', { json: { ids, name } })); await loadDocs(); openDoc(r.id);
};
$('#btnCompare').onclick = async () => {
  const [a, b] = checkedIds();
  const r = await busy('Comparing…', () => api('/api/compare', { json: { a, b } }));
  const na = S.docs.find(d => d.id === a)?.name, nb = S.docs.find(d => d.id === b)?.name;
  const box = h('div', { class: 'diff' });
  if (!r.changes.length) box.append(h('div', {}, 'No text differences.'));
  r.changes.forEach(c => {
    box.append(h('div', { class: 'sep' }, `${c.type} · ${na} p${(c.a[0]?.page ?? '-') === '-' ? '-' : c.a[0].page + 1} ↔ ${nb} p${c.b[0] ? c.b[0].page + 1 : '-'}`));
    c.a.forEach(l => box.append(h('div', { class: 'del' }, '− ' + l.text))); c.b.forEach(l => box.append(h('div', { class: 'ins' }, '+ ' + l.text)));
  });
  openModal(`Compare: ${r.similarity}% similar`, h('div', {}, h('p', { class: 'small' }, `− ${na} (${r.pages[0]} pages)   + ${nb} (${r.pages[1]} pages)`), box), [['Close', closeModal, 'primary']]);
};
function dropZone(el, toInbox) {
  el.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); el.classList.add('over'); } });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); e.stopPropagation(); el.classList.remove('over'); uploadFiles([...e.dataTransfer.files], toInbox); });
}
dropZone($('#dropLib'), false); dropZone($('#dropInbox'), true);
const V = $('#viewer');
V.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); V.classList.add('dragging'); } });
V.addEventListener('dragleave', e => { if (e.target === V) V.classList.remove('dragging'); });
V.addEventListener('drop', e => { V.classList.remove('dragging'); if (e.dataTransfer.files.length) { e.preventDefault(); uploadFiles([...e.dataTransfer.files]); } });

/* ------------------------------------------------------------------ inbox */
let inboxTimer;
async function refreshInbox() {
  clearTimeout(inboxTimer);
  try {
    const r = await api('/api/inbox');
    $('#inboxPaths').innerHTML = `Server folders — drop in: <code>${esc(r.inbox_path)}</code><br>PSDs land in: <code>${esc(r.output_path)}</code>`;
    const jl = $('#jobList'); jl.innerHTML = '';
    r.pending.filter(n => !n.endsWith('.part')).forEach(n => jl.append(h('li', {}, h('span', { class: 'st processing' }, 'queued'), n)));
    r.jobs.slice(0, 30).forEach(j => jl.append(h('li', { title: j.error || '' }, h('span', { class: 'st ' + j.status }, j.status),
      h('span', { style: { flex: 1 } }, j.file, j.error ? h('div', { class: 'small' }, j.error) : ''),
      j.doc_id ? h('button', { onclick: () => openDoc(j.doc_id) }, 'Open') : '')));
    if (!jl.children.length) jl.append(h('li', { class: 'small' }, 'Nothing processed yet'));
    const ol = $('#outList'); ol.innerHTML = '';
    r.outputs.slice(0, 200).forEach(o => ol.append(h('li', {}, h('a', { href: '/api/output/' + o.path.split('/').map(encodeURIComponent).join('/') }, o.path), h('span', { class: 'small' }, fmtSize(o.size)),
      h('button', { class: 'x', title: 'Delete', onclick: async () => { await api('/api/output/' + o.path.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE' }); refreshInbox(); } }, '✕'))));
    if (!ol.children.length) ol.append(h('li', { class: 'small' }, 'No output files yet'));
    const active = r.pending.length + r.jobs.filter(j => j.status === 'processing').length;
    $('#inboxBadge').textContent = active || '';
    if (active) loadDocs();
    if ($('[data-pane=inbox]').classList.contains('on') || active) inboxTimer = setTimeout(refreshInbox, active ? 2500 : 8000);
  } catch (_) { }
}

/* ------------------------------------------------------------------ keyboard */
document.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea,select,[contenteditable]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? $('#btnRedo') : $('#btnUndo')).click(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); $('#btnRedo').click(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#searchBox').focus(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(S.zoom * 1.2); return; }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(S.zoom / 1.2); return; }
  if (mod && e.key === '0') { e.preventDefault(); fitWidth(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Escape') { $$('.menu.open').forEach(m => m.classList.remove('open')); setTool('select'); return; }
  if (mod) return;
  const k = { v: 'select', h: 'pan', t: 'edittext', i: 'editimage', a: 'addtext', s: 'sign', u: 'highlight', n: 'note', d: 'ink', r: 'rect', x: 'redact' }[e.key.toLowerCase()];
  if (k && S.id) setTool(k);
  if (e.key === 'PageDown' || e.key === 'ArrowRight' && !S.sel) { /* natural scroll */ }
});
window.addEventListener('resize', () => { if (S.fit) fitWidth(); });

/* ------------------------------------------------------------------ boot */
(async () => {
  setTool('select');
  await loadDocs();
  refreshInbox();
  const last = new URLSearchParams(location.search).get('doc');
  if (last) openDoc(last);
})();
