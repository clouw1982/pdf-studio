/* PDF Studio — Image Studio hand-off, batch actions, send for signature, visual compare. */

/* ------------------------------------------------------------------ Image Studio */
function openStudio(pno = S.cur) {
  if (!S.id) return toast('Open a document first', 'err');
  location.href = `/studio?doc=${S.id}&page=${pno}`;
}
$('#pgStudio').onclick = () => openStudio(S.cur);
ACTIONS.studioPage = () => openStudio(S.cur);

/* ------------------------------------------------------------------ batch actions */
const BATCH_STEPS = [
  { op: 'ocr', label: 'OCR — make searchable', fields: [['lang', 'select', 'eng', [['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese']]]] },
  { op: 'compress', label: 'Compress', fields: [['level', 'select', 'medium', [['low', 'Lossless'], ['medium', 'Medium'], ['high', 'High'], ['extreme', 'Extreme']]]] },
  { op: 'redact', label: 'Redact pattern', fields: [['preset', 'select', 'ssn', [['ssn', 'SSNs'], ['email', 'Emails'], ['phone', 'Phone numbers'], ['card', 'Card numbers']]]] },
  { op: 'watermark', label: 'Watermark', fields: [['text', 'text', 'CONFIDENTIAL'], ['opacity', 'number', '0.18']] },
  { op: 'header_footer', label: 'Header / footer', fields: [['top-right', 'text', '{date}', 'Header right'], ['bottom-left', 'text', '{name}', 'Footer left']] },
  { op: 'page_numbers', label: 'Page numbers', fields: [['format', 'text', 'Page {n} of {total}']] },
  { op: 'bates', label: 'Bates numbering (continues across files)', fields: [['prefix', 'text', 'ABC'], ['start', 'number', '1']] },
  { op: 'rotate', label: 'Rotate all pages', fields: [['angle', 'select', '90', [['90', '90° clockwise'], ['-90', '90° counter-clockwise'], ['180', '180°']]]] },
  { op: 'grayscale', label: 'Convert to grayscale', fields: [] },
  { op: 'flatten', label: 'Flatten forms & comments', fields: [] },
  { op: 'sanitize', label: 'Remove hidden information', fields: [] },
  { op: 'metadata', label: 'Set author', fields: [['author', 'text', 'Chris']] },
  { op: 'protect', label: 'Password protect on export', fields: [['user_pw', 'text', '', 'Password']] },
];
const REDACT_PRESETS = { ssn: String.raw`\b\d{3}-\d{2}-\d{4}\b`, email: String.raw`[\w.+-]+@[\w-]+\.[\w.]+`, phone: String.raw`\(?\b\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b`, card: String.raw`\b(?:\d[ -]?){13,16}\b` };

$('#btnBatch').onclick = () => {
  const ids = checkedIds(); if (!ids.length) return;
  const names = ids.map(i => S.docs.find(d => d.id === i)?.name).filter(Boolean);
  const rows = BATCH_STEPS.map(st => {
    const cb = h('input', { type: 'checkbox' }); const inputs = {};
    const row = h('div', { class: 'step' }, h('label', { class: 'inl', style: { margin: 0, fontWeight: 600, minWidth: '170px' } }, cb, st.label));
    for (const [k, type, val, opts] of st.fields) {
      let el;
      if (type === 'select') el = h('select', {}, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
      else { el = h('input', { type, placeholder: typeof opts === 'string' ? opts : k }); el.value = val; }
      inputs[k] = el; row.append(el);
    }
    cb.onchange = () => row.classList.toggle('on', cb.checked);
    return { st, cb, inputs, row };
  });
  const exp = h('select', {}, [['', 'Keep in library only'], ['pdf', 'PDF'], ['docx', 'Word'], ['xlsx', 'Excel'], ['png', 'PNG images'], ['psd', 'Layered PSD'], ['txt', 'Text'], ['pdfa', 'PDF/A']].map(([v, l]) => h('option', { value: v }, l)));
  const body = h('div', {}, h('p', { class: 'small' }, `${names.length} file(s): ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}`),
    h('div', { class: 'small' }, 'Steps run top to bottom on every file. Each step is saved as a version, so you can undo per file.'),
    h('div', { class: 'steps' }, rows.map(r => r.row)), h('label', {}, 'Then export as'), exp);
  openModal('Batch actions', body, [['Cancel', closeModal], ['Run batch', async () => {
    const steps = [];
    for (const r of rows) {
      if (!r.cb.checked) continue;
      const p = { op: r.st.op }; for (const [k, el] of Object.entries(r.inputs)) p[k] = el.value;
      if (p.op === 'redact') { p.pattern = REDACT_PRESETS[p.preset]; delete p.preset; }
      if (p.op === 'rotate') p.angle = +p.angle;
      if (p.op === 'watermark') p.opacity = +p.opacity || 0.18;
      steps.push(p);
    }
    if (!steps.length && !exp.value) return toast('Tick at least one step or choose an export', 'err');
    closeModal();
    const job = await api('/api/batch', { json: { ids, steps, export: exp.value || null, dpi: +$('#exportDpi').value } });
    watchBatch(job.id, names.length);
  }, 'primary']]);
};
function watchBatch(jid, total) {
  const bar = h('div'), txt = h('p', {}, 'Starting…'), list = h('ul', { class: 'small', style: { paddingLeft: '18px' } });
  openModal('Batch running', h('div', {}, txt, h('div', { class: 'progress' }, bar), list), [['Run in background', closeModal]]);
  const tick = async () => {
    const j = await api(`/api/batch/${jid}`);
    bar.style.width = (j.done / j.total * 100) + '%';
    txt.textContent = j.status === 'running' ? `Processing ${j.done + 1} of ${j.total}: ${j.current || ''}` : `Finished ${j.done} of ${j.total}` + (j.status === 'done_with_errors' ? ' — some files had errors' : '');
    list.replaceChildren(...j.results.map(r => h('li', {}, (r.ok ? '✓ ' : '✗ ') + r.name + (r.error ? ' — ' + r.error : '') + (r.notes?.length ? ' (' + r.notes.join(', ') + ')' : ''))));
    if (j.status === 'running') return setTimeout(tick, 1000);
    loadDocs(); if (S.id) applyDoc(await api(`/api/docs/${S.id}`));
    const btns = [['Close', closeModal, 'primary']];
    if (j.zip) btns.unshift([`Download ${j.zip.split('/').pop()}`, () => { location.href = '/api/output/' + j.zip.split('/').map(encodeURIComponent).join('/'); }]);
    if (!$('#modal').classList.contains('hidden')) openModal('Batch complete', h('div', {}, txt, h('div', { class: 'progress' }, bar), list, j.zip ? h('p', { class: 'small' }, 'Exports are also in Inbox → Output files.') : ''), btns);
    else toast('Batch finished', '', 6000);
  };
  tick();
}

/* ------------------------------------------------------------------ signatures */
ACTIONS.sigField = () => { setTool('field'); $('#pFieldType').value = 'signature'; readProps(); toast('Drag a box where the signer should sign'); };
ACTIONS.requestSign = async () => {
  const f = await formBox('Request a signature', [['signer_name', 'Signer’s name', ''], ['signer_email', 'Signer’s email (optional)', ''], ['message', 'Message', 'Please review and sign.', 'textarea'], ['sender', 'Your name (shown to the signer)', localStorage.getItem('pdfstudio.sender') || ''], ['expires_days', 'Link expires after (days)', '30', 'number']]);
  if (!f) return;
  if (!f.signer_name.trim()) return toast('Signer’s name is required', 'err');
  try { localStorage.setItem('pdfstudio.sender', f.sender); } catch { }
  const r = await busy('Creating signing link…', () => api(`/api/docs/${S.id}/sign-request`, { json: { ...f, expires_days: +f.expires_days || 30 } }));
  const inp = h('input', { type: 'text', readonly: true, value: r.url });
  const mail = `mailto:${encodeURIComponent(f.signer_email)}?subject=${encodeURIComponent('Please sign: ' + S.doc.name)}&body=${encodeURIComponent(`Hi ${f.signer_name},\n\n${f.message}\n\nReview and sign here:\n${r.url}\n`)}`;
  const body = h('div', {},
    h('p', {}, r.emailed ? `Emailed to ${f.signer_email}. You can also share this private link:` : 'Send this private link to the signer:'),
    h('div', { class: 'linkbox2' }, inp, h('button', { onclick: () => { inp.select(); navigator.clipboard?.writeText(r.url); toast('Link copied'); } }, 'Copy')),
    h('div', { class: 'row' }, h('a', { href: mail, class: 'txtbtn' }, h('button', {}, '✉ Open in email')), navigator.share ? h('button', { onclick: () => navigator.share({ title: 'Please sign', url: r.url }) }, 'Share…') : ''),
    h('p', { class: 'small' }, (S.doc.fields ? 'The signer will be guided to the signature fields in this document.' : 'No signature fields — the signer will click where they want to sign. Tip: use “Add signature field” to place them yourself.') +
      ' When they finish you get a signed copy with an audit-trail page, sealed against tampering.'),
    r.smtp ? '' : h('p', { class: 'small' }, 'To send emails automatically, add SMTP settings to the server’s .env (see README).'));
  openModal('Signature requested', body, [['Done', closeModal, 'primary']]);
  renderSigs();
};
async function renderSigs() {
  const ul = $('#sigList'); if (!ul || !S.id) return;
  let data; try { data = await api('/api/sign-requests'); } catch { return; }
  const mine = data.requests.filter(r => r.doc_id === S.id || r.signed_doc_id === S.id);
  ul.replaceChildren(...mine.map(r => h('li', {},
    h('div', { class: 'top' }, h('span', { class: 'st ' + r.status }, r.status), h('b', {}, r.signer_name), h('span', { class: 'small', style: { marginLeft: 'auto' } }, new Date((r.last?.t || r.created) * 1000).toLocaleDateString())),
    h('div', { class: 'acts' },
      r.signed_doc_id ? h('button', { onclick: () => openDoc(r.signed_doc_id) }, 'Open signed copy') : '',
      ['pending', 'viewed'].includes(r.status) ? h('button', { onclick: () => { navigator.clipboard?.writeText(r.url); toast('Link copied'); } }, 'Copy link') : '',
      ['pending', 'viewed'].includes(r.status) ? h('button', { onclick: async () => { if (await confirmBox('Cancel this signature request? The link will stop working.')) { await api(`/api/sign-requests/${r.token}`, { method: 'DELETE' }); renderSigs(); } } }, 'Cancel') : ''))));
  if (!mine.length) ul.append(h('li', { class: 'small' }, 'No signature requests for this file.'));
}
setInterval(() => { if (S.id && !document.hidden) renderSigs(); }, 20000);

/* ------------------------------------------------------------------ visual compare */
const CMP = { a: null, b: null, pa: 0, pb: 0, mode: 'diff', data: null, summary: [], text: null, na: '', nb: '' };
$('#btnCompare').onclick = async () => {
  const ids = checkedIds(); if (ids.length !== 2) return;
  const created = id => S.docs.find(d => d.id === id)?.created || 0;
  const [a, b] = ids.sort((x, y) => created(x) - created(y)); // older file = before
  Object.assign(CMP, { a, b, pa: 0, pb: 0, mode: 'diff', text: null, na: S.docs.find(d => d.id === a)?.name, nb: S.docs.find(d => d.id === b)?.name });
  $('#cmpTitle').textContent = `${CMP.na}  ↔  ${CMP.nb}`;
  $('#cmpView').classList.remove('hidden');
  CMP.summary = await busy('Scanning pages…', () => api(`/api/vcompare/summary?a=${a}&b=${b}`));
  $('#cmpPage').replaceChildren(...CMP.summary.map(s => h('option', { value: s.page }, `${s.page + 1}${s.missing ? (s.missing === 'a' ? ' (only in 2nd)' : ' (only in 1st)') : s.pct > 0.01 ? ` — ${s.pct < 0.1 ? '<0.1' : s.pct.toFixed(1)}% changed` : ' — no change'}`)));
  const firstChanged = CMP.summary.find(s => s.pct > 0.01 || s.missing);
  CMP.pa = CMP.pb = firstChanged ? firstChanged.page : 0; $('#cmpPage').value = CMP.pa;
  setCmpMode('diff');
};
function setCmpMode(m) {
  CMP.mode = m; $$('#cmpModes button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('#cmpSlideWrap').classList.toggle('hidden', m !== 'overlay'); $('#cmpLegend').classList.toggle('hidden', m !== 'diff');
  $('#cmpSensWrap').classList.toggle('hidden', m === 'text');
  cmpRender();
}
$$('#cmpModes button').forEach(b => b.onclick = () => setCmpMode(b.dataset.m));
$('#cmpPage').onchange = () => { CMP.pa = CMP.pb = +$('#cmpPage').value; cmpRender(); };
$('#cmpPrev').onclick = () => { if (CMP.pa > 0) { CMP.pa = CMP.pb = CMP.pa - 1; $('#cmpPage').value = CMP.pa; cmpRender(); } };
$('#cmpNext').onclick = () => { if (CMP.pa < CMP.summary.length - 1) { CMP.pa = CMP.pb = CMP.pa + 1; $('#cmpPage').value = CMP.pa; cmpRender(); } };
$('#cmpSens').onchange = () => cmpRender();
$('#cmpSlide').oninput = () => { const top = $('#cmpStage .ov img.top'); if (top) top.style.opacity = $('#cmpSlide').value / 100; };
$('#cmpClose').onclick = () => $('#cmpView').classList.add('hidden');
document.addEventListener('keydown', e => {
  if ($('#cmpView').classList.contains('hidden')) return;
  if (e.key === 'Escape') $('#cmpClose').click(); if (e.key === 'ArrowRight') $('#cmpNext').click(); if (e.key === 'ArrowLeft') $('#cmpPrev').click();
});

async function cmpRender() {
  const stage = $('#cmpStage'), list = $('#cmpList'); stage.innerHTML = ''; list.innerHTML = '';
  const maxW = Math.max(300, stage.clientWidth - 60), scale = 1.5;
  const sum = CMP.summary[CMP.pa] || {};
  if (CMP.mode === 'text') {
    if (!CMP.text) CMP.text = await busy('Comparing text…', () => api('/api/compare', { json: { a: CMP.a, b: CMP.b } }));
    const r = CMP.text, box = h('div', { class: 'diff', style: { maxHeight: 'none', background: '#fff', width: 'min(900px,100%)' } });
    if (!r.changes.length) box.append(h('div', {}, 'No text differences.'));
    r.changes.forEach(c => {
      box.append(h('div', { class: 'sep' }, `${c.type} · p${c.a[0] ? c.a[0].page + 1 : '–'} ↔ p${c.b[0] ? c.b[0].page + 1 : '–'}`));
      c.a.forEach(l => box.append(h('div', { class: 'del' }, '− ' + l.text))); c.b.forEach(l => box.append(h('div', { class: 'ins' }, '+ ' + l.text)));
    });
    stage.append(h('div', { style: { width: '100%' } }, h('p', { class: 'small' }, `${r.similarity}% similar · ${r.changes.length} change block(s)`), box));
    list.append(h('li', { class: 'small' }, 'Text view compares the whole document.'));
    return;
  }
  if (sum.missing) { stage.append(h('p', {}, `Page ${CMP.pa + 1} exists only in the ${sum.missing === 'a' ? 'second' : 'first'} document.`)); return; }
  const imgA = `/api/docs/${CMP.a}/page/${CMP.pa}.png?scale=${scale}&v=${Date.now()}`, imgB = `/api/docs/${CMP.b}/page/${CMP.pb}.png?scale=${scale}&v=${Date.now()}`;
  CMP.data = await busy('Comparing page…', () => api(`/api/vcompare?a=${CMP.a}&b=${CMP.b}&pa=${CMP.pa}&pb=${CMP.pb}&scale=${scale}&threshold=${$('#cmpSens').value}`));
  const d = CMP.data, ptW = d.w, ptH = d.h;
  const pane = (src, cap, w, boxes) => {
    const el = h('div', { class: 'pane', style: { width: w + 'px', height: w * ptH / ptW + 'px' } }, h('span', { class: 'cap' }, cap), h('img', { src, style: { width: '100%' } }));
    if (boxes) d.boxes.forEach((bx, i) => { const k = w / ptW, r = bx.rect; el.append(h('div', { class: 'bx', 'data-i': i, title: bx.kind, style: { left: r[0] * k - 3 + 'px', top: r[1] * k - 3 + 'px', width: (r[2] - r[0]) * k + 6 + 'px', height: (r[3] - r[1]) * k + 6 + 'px', borderColor: bx.kind === 'added' ? '#16a34a' : bx.kind === 'removed' ? '#dc2626' : '#f59e0b' } })); });
    return el;
  };
  if (CMP.mode === 'diff') stage.append(pane(d.image, `Changes on page ${CMP.pa + 1}`, Math.min(maxW, 900), true));
  else if (CMP.mode === 'side') { const w = Math.min((maxW - 20) / 2, 620); stage.append(pane(imgA, CMP.na, w, true), pane(imgB, CMP.nb, w, true)); }
  else {
    const w = Math.min(maxW, 900), hh = w * ptH / ptW;
    const ov = h('div', { class: 'pane ov', style: { width: w + 'px', height: hh + 'px' } }, h('span', { class: 'cap' }, `${CMP.na}  ⟷  ${CMP.nb} (slide to blend)`),
      h('img', { src: imgA, style: { width: '100%' } }), h('img', { class: 'top', src: imgB, style: { width: '100%', opacity: $('#cmpSlide').value / 100 } }));
    stage.append(ov);
  }
  if (!d.boxes.length) list.append(h('li', { class: 'small' }, 'No visual differences on this page.'));
  d.boxes.forEach((bx, i) => list.append(h('li', {
    onmouseenter: () => $$(`#cmpStage .bx[data-i="${i}"]`).forEach(x => x.classList.add('hl')), onmouseleave: () => $$('#cmpStage .bx.hl').forEach(x => x.classList.remove('hl')),
    onclick: () => $(`#cmpStage .bx[data-i="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
  }, h('span', { class: 'k ' + bx.kind }, bx.kind), `Area ${i + 1} · y ${Math.round(bx.rect[1])}pt`)));
  list.prepend(h('li', { class: 'small' }, `${d.boxes.length} changed area(s) · ${d.changed_pct < 0.1 && d.changed_pct > 0 ? '<0.1' : d.changed_pct.toFixed(2)}% of the page`));
}
