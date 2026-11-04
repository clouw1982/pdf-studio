'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const h = (tag, a = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(a)) { if (k === 'style') Object.assign(e.style, v); else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } kids.flat().forEach(k => k != null && e.append(k.nodeType ? k : document.createTextNode(k))); return e; };
const token = location.pathname.split('/').pop();
let INFO, sigImg = null, sigs = {}, free = [], placing = false, values = {};

function toast(m, err) { const t = $('#toast'); t.textContent = m; t.className = err ? 'err' : ''; clearTimeout(t._t); t._t = setTimeout(() => t.className = 'hidden', 3500); }
async function api(path, json) {
  const r = await fetch(path, json ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) } : {});
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.detail || 'Something went wrong'); return d;
}
function finished(title, text, download) {
  $('#doneTitle').textContent = title; $('#doneText').textContent = text;
  if (download) { $('#dl').href = download; $('#dl').classList.remove('hidden'); }
  if (title !== 'Signed') $('.tick').textContent = 'ⓘ';
  $('#done').classList.remove('hidden'); $('#foot').classList.add('hidden');
}

async function boot() {
  try { INFO = await api(`/api/sign/${token}`); } catch (e) { return finished('Link not valid', 'This signing link is invalid or has been removed. Contact the sender for a new one.'); }
  $('#docName').textContent = INFO.doc_name; $('#from').textContent = `${INFO.sender} requested your signature`;
  document.title = 'Sign: ' + INFO.doc_name;
  if (INFO.status === 'signed') return finished('Already signed', 'This document has already been signed.', `/api/sign/${token}/download`);
  if (['declined', 'cancelled', 'expired'].includes(INFO.status)) return finished(`Request ${INFO.status}`, `This signature request was ${INFO.status}. Contact ${INFO.sender} if you think this is a mistake.`);
  if (INFO.message) { $('#msg').textContent = INFO.message; $('#msg').classList.remove('hidden'); }
  $('#typedName').value = INFO.signer_name || '';
  renderPages(); $('#foot').classList.remove('hidden'); updateProgress();
}
const sigFields = () => INFO.fields.filter(f => f.type === 'Signature');

function renderPages() {
  const main = $('#pages'); main.innerHTML = '';
  const W = Math.min(main.clientWidth - 20, 940);
  INFO.pages.forEach((p, i) => {
    const k = W / p.w;
    const el = h('div', { class: 'page', 'data-p': i, style: { width: W + 'px', height: p.h * k + 'px' } },
      h('img', { src: `/api/sign/${token}/page/${i}.png?scale=${Math.min(2.5, (W / p.w) * (devicePixelRatio || 1)).toFixed(2)}`, loading: 'lazy', alt: '' }),
      h('span', { class: 'pn' }, `Page ${i + 1} of ${INFO.pages.length}`));
    const place = (node, r) => Object.assign(node.style, { left: r[0] * k + 'px', top: r[1] * k + 'px', width: (r[2] - r[0]) * k + 'px', height: (r[3] - r[1]) * k + 'px' });
    INFO.fields.filter(f => f.page === i).forEach(f => {
      let n;
      if (f.type === 'Signature') {
        n = h('div', { class: 'f sig' + (sigs[f.xref] ? ' done' : ''), 'data-x': f.xref }, sigs[f.xref] ? h('img', { src: sigs[f.xref] }) : '✍ Sign here');
        n.onclick = async () => { if (!sigImg) sigImg = await getSignature(); if (!sigImg) return; sigs[f.xref] = sigs[f.xref] ? null : sigImg; if (!sigs[f.xref]) delete sigs[f.xref]; renderPages(); updateProgress(); };
      } else if (f.type === 'CheckBox') {
        n = h('input', { type: 'checkbox', class: 'f', title: f.name }); n.checked = values[f.xref] ?? (f.value && f.value !== 'Off');
        n.onchange = () => values[f.xref] = n.checked;
      } else if (f.type === 'Text' || f.type === 'ComboBox') {
        n = h('input', { class: 'f', placeholder: f.name, title: f.name }); n.value = values[f.xref] ?? f.value ?? '';
        n.style.fontSize = Math.max(10, Math.min(16, (f.rect[3] - f.rect[1]) * k * 0.6)) + 'px';
        n.oninput = () => values[f.xref] = n.value;
      } else return;
      place(n, f.rect); el.append(n);
    });
    free.filter(s => s.page === i).forEach((s, j) => {
      const n = h('div', { class: 'free', title: 'Tap to remove' }, h('img', { src: s.data })); place(n, s.rect);
      n.onclick = e => { e.stopPropagation(); free = free.filter(x => x !== s); renderPages(); updateProgress(); }; el.append(n);
    });
    if (placing) {
      const ph = h('div', { class: 'placehint' });
      ph.onclick = e => {
        const b = el.getBoundingClientRect(), x = (e.clientX - b.left) / k, y = (e.clientY - b.top) / k, w = 150, hh = 55;
        free.push({ page: i, rect: [x - w / 2, y - hh / 2, x + w / 2, y + hh / 2], data: sigImg }); placing = false; renderPages(); updateProgress();
      };
      el.append(ph);
    }
    main.append(el);
  });
}
function updateProgress() {
  const need = sigFields().length, have = Object.keys(sigs).length;
  if (need) { $('#progTxt').textContent = `${have} of ${need} signature field${need > 1 ? 's' : ''} signed`; $('#btnNext').textContent = have < need ? 'Next field ↓' : 'All signed ✓'; }
  else { $('#progTxt').textContent = free.length ? `${free.length} signature${free.length > 1 ? 's' : ''} placed` : 'Tap “Add signature”, then tap where you want to sign.'; $('#btnNext').textContent = placing ? 'Tap the page…' : '+ Add signature'; }
}
$('#btnNext').onclick = async () => {
  const fs = sigFields();
  if (!fs.length) { if (!sigImg) sigImg = await getSignature(); if (!sigImg) return; placing = true; renderPages(); updateProgress(); toast('Tap where your signature should go'); return; }
  const next = fs.find(f => !sigs[f.xref]) || fs[0];
  const el = document.querySelector(`.f.sig[data-x="${next.xref}"]`);
  $$('.f.sig.cur').forEach(x => x.classList.remove('cur')); el?.classList.add('cur'); el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

/* signature pad */
function getSignature() {
  return new Promise(resolve => {
    const pad = $('#pad'), ctx = pad.getContext('2d'); let mode = 'draw', inked = false, drawing = false, upImg = null;
    ctx.clearRect(0, 0, pad.width, pad.height); ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b2a6f';
    const pos = e => { const b = pad.getBoundingClientRect(); return [(e.clientX - b.left) * pad.width / b.width, (e.clientY - b.top) * pad.height / b.height]; };
    pad.onpointerdown = e => { if (mode !== 'draw') return; drawing = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
    pad.onpointermove = e => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); inked = true; };
    pad.onpointerup = () => drawing = false;
    const typeRender = () => { ctx.clearRect(0, 0, pad.width, pad.height); ctx.fillStyle = '#0b2a6f'; ctx.font = `110px ${$('#font').value}`; ctx.textBaseline = 'middle'; ctx.fillText($('#typed').value, 30, pad.height / 2); inked = !!$('#typed').value.trim(); };
    $('#typed').oninput = typeRender; $('#font').onchange = typeRender;
    $('#upFile').onchange = () => { const f = $('#upFile').files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { upImg = r.result; const im = new Image(); im.onload = () => { ctx.clearRect(0, 0, pad.width, pad.height); const k = Math.min(pad.width / im.width, pad.height / im.height); ctx.drawImage(im, 0, 0, im.width * k, im.height * k); inked = true; }; im.src = upImg; }; r.readAsDataURL(f); };
    $$('.tabs button').forEach(b => b.onclick = () => {
      mode = b.dataset.m; $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
      $('#typeBox').classList.toggle('hidden', mode !== 'type'); $('#upBox').classList.toggle('hidden', mode !== 'upload');
      ctx.clearRect(0, 0, pad.width, pad.height); inked = false;
      if (mode === 'type') { if (!$('#typed').value) $('#typed').value = $('#typedName').value; typeRender(); }
    });
    $('#padClear').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); inked = false; };
    const close = v => { $('#modal').classList.add('hidden'); resolve(v); };
    $('#padCancel').onclick = () => close(null);
    $('#padOk').onclick = () => {
      if (!inked) return toast('Please sign in the box first', true);
      const d = ctx.getImageData(0, 0, pad.width, pad.height).data; let x0 = pad.width, y0 = pad.height, x1 = 0, y1 = 0;
      for (let y = 0; y < pad.height; y += 2) for (let x = 0; x < pad.width; x += 2) if (d[(y * pad.width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const c = document.createElement('canvas'); c.width = x1 - x0 + 20; c.height = y1 - y0 + 20; c.getContext('2d').drawImage(pad, x0 - 10, y0 - 10, c.width, c.height, 0, 0, c.width, c.height);
      close(c.toDataURL('image/png'));
    };
    $('#modal').classList.remove('hidden');
  });
}

$('#btnFinish').onclick = async () => {
  const name = $('#typedName').value.trim();
  if (!name) return toast('Please type your full name', true);
  if (!$('#agree').checked) return toast('Please tick “I agree to sign electronically”', true);
  const fs = sigFields();
  if (fs.length && Object.keys(sigs).length < fs.length) { $('#btnNext').click(); return toast(`Please sign all ${fs.length} signature fields`, true); }
  const signatures = fs.length ? fs.map(f => ({ xref: f.xref, page: f.page, rect: f.rect, data: sigs[f.xref] })) : free.map(s => ({ page: s.page, rect: s.rect, data: s.data }));
  if (!signatures.length) { $('#btnNext').click(); return toast('Add your signature first', true); }
  $('#btnFinish').disabled = true; $('#btnFinish').textContent = 'Signing…';
  try {
    const r = await api(`/api/sign/${token}/complete`, { agree: true, typed_name: name, values, signatures });
    finished('Signed', `Thanks, ${name}. The document is signed and sealed. ${INFO.sender} has been notified.`, r.download);
  } catch (e) { toast(e.message, true); $('#btnFinish').disabled = false; $('#btnFinish').textContent = 'Finish & sign'; }
};
$('#btnDecline').onclick = async () => {
  const reason = prompt('Why are you declining? (optional)'); if (reason === null) return;
  try { await api(`/api/sign/${token}/decline`, { reason }); finished('Declined', `You declined to sign. ${INFO.sender} has been told.`); } catch (e) { toast(e.message, true); }
};
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => INFO && renderPages(), 200); });
boot();
