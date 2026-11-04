/* Image Studio — a layered image editor (vanilla JS, canvas). */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const FONTS = { sans: 'Helvetica, Arial, "Liberation Sans", sans-serif', serif: '"Times New Roman", Times, "Liberation Serif", serif', mono: '"Courier New", Courier, "Liberation Mono", monospace' };
const fontCss = f => FONTS[f] || `${f}, sans-serif`;

/* ------------------------------------------------------------------ state */
const D = { id: null, name: 'Untitled', w: 1200, h: 800, layers: [], source: null };
const V = { z: 1, px: 0, py: 0 };
const S = {
  active: -1, tool: 'move', dirty: false, sel: null, // sel = {mask: canvas, path: Path2D, inverted}
  opt: {
    autoSelect: true, size: 24, hardness: 0.8, opacity: 1, tolerance: 32, contiguous: true,
    gradType: 'linear', gradMode: 'fg-bg', selMode: 'new', shape: 'rect', shapeFill: true, shapeStroke: false,
    strokeW: 4, radius: 16, family: 'sans', fsize: 48, bold: false, italic: false, sampleAll: true, cropAspect: 'free', cloneAligned: true,
  },
  hist: [], hidx: -1, drag: null, stroke: null, crop: null, preview: null, cloneSrc: null, cloneOff: null, spaceDown: false, ants: 0,
};
const view = $('#view'), vctx = view.getContext('2d');
const comp = document.createElement('canvas'), cctx = comp.getContext('2d', { willReadFrequently: true });
const scratch = document.createElement('canvas').getContext('2d');

/* ------------------------------------------------------------------ helpers */
const newCanvas = (w, hh) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(hh)); return c; };
const cloneCanvas = c => { const n = newCanvas(c.width, c.height); n.getContext('2d').drawImage(c, 0, 0); return n; };
const ctxOf = c => c.getContext('2d', { willReadFrequently: true });
const lid = () => 'L' + Math.random().toString(36).slice(2, 10);
const act = () => D.layers[S.active];
function toast(msg, kind = '', ms = 3000) { const t = h('div', { class: 'toast ' + kind }, msg); $('#toasts').append(t); if (ms) setTimeout(() => t.remove(), ms); return t; }
async function api(path, opt = {}) {
  const init = { method: opt.method || (opt.json || opt.form ? 'POST' : 'GET'), headers: {} };
  if (opt.json) { init.body = JSON.stringify(opt.json); init.headers['Content-Type'] = 'application/json'; }
  if (opt.form) init.body = opt.form;
  const r = await fetch(path, init);
  if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(data.detail || 'Request failed');
  return data;
}
async function busy(msg, fn) { const t = toast(msg, 'busy', 0); try { return await fn(); } catch (e) { toast(e.message, 'err', 6000); throw e; } finally { t.remove(); } }
const loadImage = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
function setDirty(v = true) { S.dirty = v; $('#dirty').textContent = v ? '●' : ''; }

/* ------------------------------------------------------------------ text layers */
function textMetrics(L) {
  scratch.font = `${L.italic ? 'italic ' : ''}${L.bold ? 'bold ' : ''}${L.size}px ${fontCss(L.family)}`;
  const lines = String(L.text).split('\n');
  const natural = Math.max(1, ...lines.map(l => scratch.measureText(l).width));
  if (L.sx == null) L.sx = L.fitWidth ? clamp(L.fitWidth / natural, 0.6, 1.6) : 1;
  const w = natural * L.sx, asc = L.size * 0.8;
  return { lines, w, x0: L.x, y0: L.y - asc, x1: L.x + w, y1: L.y - asc + lines.length * L.size * 1.2 };
}
function drawText(ctx, L) {
  const m = textMetrics(L);
  ctx.font = `${L.italic ? 'italic ' : ''}${L.bold ? 'bold ' : ''}${L.size}px ${fontCss(L.family)}`;
  ctx.fillStyle = L.color; ctx.textBaseline = 'alphabetic';
  m.lines.forEach((ln, i) => {
    ctx.save(); ctx.translate(L.x, L.y + i * L.size * 1.2); ctx.scale(L.sx || 1, 1); ctx.fillText(ln, 0, 0); ctx.restore();
  });
}
function bbox(L) {
  if (L.type === 'text') { const m = textMetrics(L); return [m.x0, m.y0, m.x1, m.y1]; }
  return [L.x, L.y, L.x + L.w, L.y + L.h];
}
function rasterizeText(L) {
  const m = textMetrics(L), pad = Math.ceil(L.size * 0.3);
  const c = newCanvas(m.x1 - m.x0 + pad * 2, m.y1 - m.y0 + pad * 2), x = ctxOf(c);
  x.translate(-m.x0 + pad, -m.y0 + pad); drawText(x, L);
  return { canvas: c, x: Math.floor(m.x0 - pad), y: Math.floor(m.y0 - pad) };
}

/* ------------------------------------------------------------------ rendering */
let raf = 0;
const render = () => { if (!raf) raf = requestAnimationFrame(draw); };
function compose(ctx, opts = {}) {
  ctx.clearRect(0, 0, D.w, D.h);
  D.layers.forEach((L, i) => {
    if (!L.visible && !opts.all) return;
    if (opts.rasterOnly && L.type === 'text') return;
    ctx.save(); ctx.globalAlpha = L.opacity; ctx.globalCompositeOperation = L.blend || 'source-over';
    if (L.type === 'text') drawText(ctx, L);
    else if (S.stroke && S.stroke.layer === L) drawStrokePreview(ctx, L);
    else ctx.drawImage(L.canvas, L.x, L.y, L.w, L.h);
    ctx.restore();
  });
}
function drawStrokePreview(ctx, L) {
  const st = S.stroke, tmp = st.tmp, t = ctxOf(tmp);
  t.globalCompositeOperation = 'copy'; t.globalAlpha = 1; t.drawImage(L.canvas, 0, 0);
  t.globalCompositeOperation = st.kind === 'eraser' ? 'destination-out' : 'source-over';
  t.globalAlpha = st.opacity; t.drawImage(st.masked(), 0, 0);
  t.globalCompositeOperation = 'source-over'; t.globalAlpha = 1;
  ctx.drawImage(tmp, L.x, L.y, L.w, L.h);
}
let checker;
function draw() {
  raf = 0;
  const dpr = window.devicePixelRatio || 1, W = view.clientWidth, H = view.clientHeight;
  if (view.width !== W * dpr || view.height !== H * dpr) { view.width = W * dpr; view.height = H * dpr; }
  if (comp.width !== D.w || comp.height !== D.h) { comp.width = D.w; comp.height = D.h; }
  compose(cctx);
  const c = vctx;
  c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#17191d'; c.fillRect(0, 0, view.width, view.height);
  c.setTransform(dpr * V.z, 0, 0, dpr * V.z, V.px * dpr, V.py * dpr);
  if (!checker) { const p = newCanvas(16, 16), x = p.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 16, 16); x.fillStyle = '#d5d7dc'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8); checker = c.createPattern(p, 'repeat'); }
  c.save(); c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = 18 / V.z; c.fillStyle = '#fff'; c.fillRect(0, 0, D.w, D.h); c.restore();
  c.save(); c.setTransform(dpr, 0, 0, dpr, V.px * dpr, V.py * dpr); c.fillStyle = checker; c.fillRect(0, 0, D.w * V.z, D.h * V.z); c.restore();
  c.imageSmoothingEnabled = V.z < 2; c.imageSmoothingQuality = 'high';
  c.drawImage(comp, 0, 0);
  const lw = 1 / V.z;
  // selection marching ants
  if (S.sel) {
    c.save(); c.lineWidth = lw; c.setLineDash([5 / V.z, 4 / V.z]);
    c.strokeStyle = '#000'; c.lineDashOffset = -S.ants / V.z; c.stroke(S.sel.path);
    c.strokeStyle = '#fff'; c.lineDashOffset = -S.ants / V.z + 5 / V.z; c.stroke(S.sel.path); c.restore();
  }
  // live previews
  if (S.preview) S.preview(c, lw);
  // transform box
  const L = act();
  if (L && S.tool === 'move' && L.visible) {
    const [x0, y0, x1, y1] = bbox(L);
    c.save(); c.lineWidth = lw; c.strokeStyle = '#4a8cff'; c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    c.fillStyle = '#fff'; const hs = 7 / V.z;
    for (const [hx, hy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) { c.fillRect(hx - hs / 2, hy - hs / 2, hs, hs); c.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs); }
    c.restore();
  }
  if (S.crop) {
    const [x0, y0, x1, y1] = S.crop;
    c.save(); c.fillStyle = 'rgba(0,0,0,.55)';
    c.beginPath(); c.rect(-1e5, -1e5, 2e5, 2e5); c.rect(x0, y0, x1 - x0, y1 - y0); c.fill('evenodd');
    c.strokeStyle = '#fff'; c.lineWidth = lw; c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    c.globalAlpha = .4; for (let k = 1; k < 3; k++) { c.beginPath(); c.moveTo(x0 + (x1 - x0) * k / 3, y0); c.lineTo(x0 + (x1 - x0) * k / 3, y1); c.moveTo(x0, y0 + (y1 - y0) * k / 3); c.lineTo(x1, y0 + (y1 - y0) * k / 3); c.stroke(); }
    c.restore();
  }
  if (S.cursor && ['brush', 'eraser', 'clone', 'pencil'].includes(S.tool)) {
    c.save(); c.lineWidth = lw; c.strokeStyle = 'rgba(255,255,255,.9)'; c.beginPath(); c.arc(S.cursor[0], S.cursor[1], S.opt.size / 2, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = 'rgba(0,0,0,.6)'; c.beginPath(); c.arc(S.cursor[0], S.cursor[1], S.opt.size / 2 + lw, 0, Math.PI * 2); c.stroke();
    if (S.tool === 'clone' && S.cloneSrc) { c.strokeStyle = '#4a8cff'; const sp = S.cloneOff ? [S.cursor[0] + S.cloneOff[0], S.cursor[1] + S.cloneOff[1]] : S.cloneSrc; c.beginPath(); c.arc(sp[0], sp[1], S.opt.size / 2, 0, Math.PI * 2); c.stroke(); }
    c.restore();
  }
  $('#zoomLbl').textContent = Math.round(V.z * 100) + '%';
}
setInterval(() => { if (S.sel) { S.ants = (S.ants + 1) % 18; render(); } }, 90);
window.addEventListener('resize', render);

function zoomTo(z, cx = view.clientWidth / 2, cy = view.clientHeight / 2) {
  z = clamp(z, 0.02, 32); const dx = (cx - V.px) / V.z, dy = (cy - V.py) / V.z;
  V.z = z; V.px = cx - dx * z; V.py = cy - dy * z; render(); positionTextEditor();
}
function fit() {
  const W = view.clientWidth, H = view.clientHeight;
  V.z = Math.min((W - 60) / D.w, (H - 60) / D.h, 4); V.px = (W - D.w * V.z) / 2; V.py = (H - D.h * V.z) / 2; render(); positionTextEditor();
}
const toDoc = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left - V.px) / V.z, (e.clientY - r.top - V.py) / V.z]; };

/* ------------------------------------------------------------------ history */
function snapshot() { return { w: D.w, h: D.h, active: S.active, layers: D.layers.map(L => ({ ...L })) }; }
function pushHistory(label, editLayer) {
  // editLayer: layer whose pixels are about to change -> live layer gets a private copy
  S.hist = S.hist.slice(0, S.hidx + 1);
  S.hist.push({ label, state: snapshot() });
  if (S.hist.length > 50) S.hist.shift();
  S.hidx = S.hist.length - 1;
  if (editLayer && editLayer.type === 'raster') { editLayer.canvas = cloneCanvas(editLayer.canvas); editLayer.dirty = true; }
  setDirty(); renderHistory();
}
function restore(state) {
  D.w = state.w; D.h = state.h; D.layers = state.layers.map(L => ({ ...L })); S.active = clamp(state.active, 0, D.layers.length - 1);
  D.layers.forEach(L => L.dirty = true);
  render(); renderLayers(); renderProps();
}
function undo() {
  if (S.hidx < 0) return;
  const cur = snapshot(), e = S.hist[S.hidx];
  restore(e.state); e.redo = cur; S.hidx--; renderHistory(); setDirty();
}
function redo() {
  const e = S.hist[S.hidx + 1]; if (!e || !e.redo) return;
  const cur = snapshot(); restore(e.redo); e.state = cur; S.hidx++; renderHistory(); setDirty();
}
function renderHistory() {
  const ul = $('#history'); ul.innerHTML = '';
  ul.append(h('li', { class: S.hidx === -1 ? 'cur' : '', onclick: () => { while (S.hidx >= 0) undo(); } }, 'Open'));
  S.hist.forEach((e, i) => ul.append(h('li', { class: i === S.hidx ? 'cur' : i > S.hidx ? 'future' : '', onclick: () => { while (S.hidx > i) undo(); while (S.hidx < i) redo(); } }, e.label)));
  ul.scrollTop = ul.scrollHeight;
}

/* ------------------------------------------------------------------ layers panel */
function addLayer(L, at = S.active + 1) {
  L = { id: lid(), visible: true, opacity: 1, blend: 'source-over', locked: false, dirty: true, ...L };
  D.layers.splice(at, 0, L); S.active = at; renderLayers(); renderProps(); render(); return L;
}
function blankRaster(name = 'Layer') { return { type: 'raster', name, canvas: newCanvas(D.w, D.h), x: 0, y: 0, w: D.w, h: D.h }; }
function thumbOf(L) {
  if (L.type === 'text') return h('div', { class: 'th t' }, 'T');
  const c = newCanvas(38, 30), x = c.getContext('2d'); const k = Math.min(38 / D.w, 30 / D.h);
  x.drawImage(L.canvas, (L.x * k) + (38 - D.w * k) / 2, (L.y * k) + (30 - D.h * k) / 2, L.w * k, L.h * k);
  return h('div', { class: 'th' }, c);
}
let dragFrom = null;
function renderLayers() {
  const ul = $('#layers'); ul.innerHTML = '';
  for (let i = D.layers.length - 1; i >= 0; i--) {
    const L = D.layers[i];
    const li = h('li', { class: i === S.active ? 'on' : '', draggable: 'true' },
      h('button', { class: 'eye' + (L.visible ? '' : ' off'), title: 'Show / hide', onclick: e => { e.stopPropagation(); pushHistory(L.visible ? 'Hide layer' : 'Show layer'); L.visible = !L.visible; renderLayers(); render(); } }, '👁'),
      thumbOf(L),
      h('span', { class: 'nm', title: 'Double-click to rename' }, L.name),
      h('button', { class: 'lock' + (L.locked ? ' on' : ''), title: 'Lock', onclick: e => { e.stopPropagation(); L.locked = !L.locked; renderLayers(); } }, L.locked ? '🔒' : '🔓'));
    li.addEventListener('click', () => { S.active = i; commitTextEdit(); renderLayers(); renderProps(); render(); });
    li.querySelector('.nm').addEventListener('dblclick', e => {
      const inp = h('input', { value: L.name }); e.target.replaceChildren(inp); inp.focus(); inp.select();
      const done = () => { if (inp.value.trim() && inp.value !== L.name) { pushHistory('Rename layer'); L.name = inp.value.trim(); } renderLayers(); };
      inp.addEventListener('blur', done); inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = L.name; inp.blur(); } });
    });
    li.addEventListener('dragstart', () => { dragFrom = i; });
    li.addEventListener('dragover', e => { e.preventDefault(); li.classList.add('drag'); });
    li.addEventListener('dragleave', () => li.classList.remove('drag'));
    li.addEventListener('drop', e => {
      e.preventDefault(); li.classList.remove('drag'); if (dragFrom == null || dragFrom === i) return;
      pushHistory('Reorder layers'); const [m] = D.layers.splice(dragFrom, 1); D.layers.splice(i, 0, m); S.active = i; dragFrom = null; renderLayers(); render();
    });
    ul.append(li);
  }
  const L = act();
  $('#lBlend').value = L?.blend || 'source-over';
  $('#lOpacity').value = Math.round((L?.opacity ?? 1) * 100); $('#lOpVal').textContent = $('#lOpacity').value + '%';
}
let opHistPushed = false;
$('#lOpacity').addEventListener('input', e => { const L = act(); if (!L) return; if (!opHistPushed) { pushHistory('Layer opacity'); opHistPushed = true; } L.opacity = e.target.value / 100; $('#lOpVal').textContent = e.target.value + '%'; render(); });
$('#lOpacity').addEventListener('change', () => { opHistPushed = false; });
$('#lBlend').addEventListener('change', e => { const L = act(); if (!L) return; pushHistory('Blend mode'); L.blend = e.target.value; render(); });

/* ------------------------------------------------------------------ properties panel */
function renderProps() {
  const P = $('#props'); P.innerHTML = ''; const L = act();
  if (!L) { P.append(h('span', { class: 'muted' }, 'No layer selected')); return; }
  if (L.type === 'text') {
    const ta = h('textarea', {}); ta.value = L.text;
    let pushed = false;
    ta.addEventListener('input', () => { if (!pushed) { pushHistory('Edit text'); pushed = true; } L.text = ta.value; L.name = ta.value.split('\n')[0].slice(0, 48) || 'Text'; render(); renderLayersLite(); });
    ta.addEventListener('keydown', e => e.stopPropagation());
    const fam = h('select', {}, [['sans', 'Sans (Helvetica)'], ['serif', 'Serif (Times)'], ['mono', 'Mono (Courier)'], ['Georgia', 'Georgia'], ['Impact', 'Impact'], ['"Arial Black"', 'Arial Black'], ['"Brush Script MT"', 'Brush Script'], ['Verdana', 'Verdana']].map(([v, l]) => h('option', { value: v, selected: v === L.family }, l)));
    fam.onchange = () => { pushHistory('Font'); L.family = fam.value; render(); };
    const size = h('input', { type: 'number', min: 1, max: 2000, step: 0.5, value: +L.size.toFixed(1) });
    size.onchange = () => { pushHistory('Font size'); L.size = +size.value || L.size; render(); };
    const col = h('input', { type: 'color', value: L.color });
    col.oninput = () => { if (!col._p) { pushHistory('Text colour'); col._p = 1; } L.color = col.value; render(); }; col.onchange = () => col._p = 0;
    const b = h('button', { class: L.bold ? 'on' : '', onclick: () => { pushHistory('Bold'); L.bold = !L.bold; renderProps(); render(); } }, h('b', {}, 'B'));
    const it = h('button', { class: L.italic ? 'on' : '', onclick: () => { pushHistory('Italic'); L.italic = !L.italic; renderProps(); render(); } }, h('i', {}, 'I'));
    const sx = h('input', { type: 'number', min: 30, max: 300, step: 1, value: Math.round((L.sx || 1) * 100), title: 'Horizontal scale %' });
    sx.onchange = () => { pushHistory('Text width'); L.sx = (+sx.value || 100) / 100; render(); };
    P.append(ta, h('div', { class: 'r' }, fam, size, col), h('div', { class: 'r' }, b, it, h('span', { class: 'muted' }, 'Width'), sx, '%', h('button', { onclick: () => cmd('rasterize') }, 'Rasterize')));
  } else {
    P.append(h('div', { class: 'r muted' }, `${L.name} · ${Math.round(L.w)}×${Math.round(L.h)} px at ${Math.round(L.x)}, ${Math.round(L.y)}`));
    P.append(h('div', { class: 'r' },
      h('button', { onclick: () => cmd('flipLayerH') }, '⇋ Flip'), h('button', { onclick: () => cmd('flipLayerV') }, '⇵ Flip'),
      h('button', { onclick: () => cmd('rotLayer') }, '⟳ Rotate'), h('button', { onclick: () => cmd('removeBg') }, '✨ Remove BG')));
  }
  P.append(h('div', { class: 'r muted', style: { fontSize: '11px' } }, `Canvas ${D.w}×${D.h}`));
}
function renderLayersLite() { const li = $$('#layers li')[D.layers.length - 1 - S.active]; if (li) li.querySelector('.nm').textContent = act().name; }

/* ------------------------------------------------------------------ tools & options bar */
const TOOL_OPTS = {
  move: ['autoSelect', 'align'], marquee: ['selMode', 'selActions'], ellipseSel: ['selMode', 'selActions'], lasso: ['selMode', 'selActions'],
  crop: ['cropAspect', 'cropActions'], brush: ['size', 'hardness', 'opacity'], pencil: ['size', 'opacity'], eraser: ['size', 'hardness', 'opacity'],
  fill: ['tolerance', 'contiguous', 'opacity'], gradient: ['gradType', 'gradMode', 'opacity'], clone: ['size', 'hardness', 'opacity', 'cloneAligned'],
  text: ['family', 'fsize', 'bold', 'italic'], shape: ['shape', 'shapeFill', 'shapeStroke', 'strokeW', 'radius'], eyedropper: ['sampleAll'],
  hand: [], zoom: ['zoomActions'],
};
const TOOL_NAMES = { move: 'Move', marquee: 'Rectangle select', ellipseSel: 'Ellipse select', lasso: 'Lasso', crop: 'Crop', brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser', fill: 'Paint bucket', gradient: 'Gradient', clone: 'Clone stamp', text: 'Text', shape: 'Shape', eyedropper: 'Eyedropper', hand: 'Hand', zoom: 'Zoom' };
const HINTS = {
  move: 'Drag to move · drag a corner to resize (Shift = free) · arrows nudge', marquee: 'Drag to select · Shift add · Alt subtract', ellipseSel: 'Drag to select an ellipse',
  lasso: 'Draw around an area to select it', crop: 'Drag the crop box, then Enter to apply', brush: '[ and ] change size', pencil: 'Hard-edged drawing', eraser: '[ and ] change size',
  fill: 'Click to fill similar colours', gradient: 'Drag to draw a gradient', clone: 'Alt-click to set the source, then paint', text: 'Click to add text, or click existing text to edit',
  shape: 'Drag to draw a shape on a new layer', eyedropper: 'Click to pick the foreground colour (Alt = background)', hand: 'Drag to pan', zoom: 'Click to zoom in · Alt-click to zoom out',
};
function setTool(t) {
  commitTextEdit(); if (S.tool === 'crop' && t !== 'crop') S.crop = null;
  S.tool = t; $$('#tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  if (t === 'crop' && !S.crop) S.crop = [0, 0, D.w, D.h];
  renderOpts(); $('#hint').textContent = HINTS[t] || ''; view.style.cursor = { hand: 'grab', zoom: 'zoom-in', text: 'text', eyedropper: 'crosshair', move: 'default' }[t] || 'crosshair'; render();
}
function renderOpts() {
  const O = $('#opts'), o = S.opt; O.innerHTML = ''; O.append(h('span', { class: 'tname' }, TOOL_NAMES[S.tool]));
  const num = (k, label, min, max, step = 1, scale = 1, suffix = '') => { const i = h('input', { type: 'number', min, max, step, value: Math.round(o[k] * scale * 100) / 100 }); i.oninput = () => { o[k] = (+i.value) / scale; render(); }; return h('label', {}, label, i, suffix); };
  const rng = (k, label, min, max, scale) => { const out = h('span', {}, Math.round(o[k] * scale) + '%'); const i = h('input', { type: 'range', min, max, value: Math.round(o[k] * scale) }); i.oninput = () => { o[k] = i.value / scale; out.textContent = i.value + '%'; }; return h('label', {}, label, i, out); };
  const chk = (k, label) => { const i = h('input', { type: 'checkbox' }); i.checked = o[k]; i.onchange = () => o[k] = i.checked; return h('label', {}, i, label); };
  const sel = (k, label, opts) => { const s = h('select', {}, opts.map(([v, l]) => h('option', { value: v, selected: v === o[k] }, l))); s.onchange = () => { o[k] = s.value; render(); }; return h('label', {}, label, s); };
  const btn = (label, fn, cls = '') => h('button', { class: cls, onclick: fn }, label);
  for (const k of TOOL_OPTS[S.tool] || []) {
    if (k === 'size') O.append(num('size', 'Size', 1, 2000, 1, 1, 'px'));
    if (k === 'hardness') O.append(rng('hardness', 'Hardness', 0, 100, 100));
    if (k === 'opacity') O.append(rng('opacity', 'Opacity', 1, 100, 100));
    if (k === 'tolerance') O.append(num('tolerance', 'Tolerance', 0, 255));
    if (k === 'contiguous') O.append(chk('contiguous', 'Contiguous'));
    if (k === 'autoSelect') O.append(chk('autoSelect', 'Auto-select layer'));
    if (k === 'align') O.append(h('label', {}, 'Align', btn('⇤', () => align('l')), btn('↔', () => align('c')), btn('⇥', () => align('r')), btn('⤒', () => align('t')), btn('↕', () => align('m')), btn('⤓', () => align('b'))));
    if (k === 'selMode') O.append(h('label', {}, 'Mode', ...[['new', 'New'], ['add', 'Add'], ['sub', 'Subtract']].map(([v, l]) => btn(l, () => { o.selMode = v; renderOpts(); }, o.selMode === v ? 'on' : ''))));
    if (k === 'selActions') O.append(btn('Select all', () => cmd('selectAll')), btn('Deselect', () => cmd('deselect')), btn('Invert', () => cmd('invertSel')), btn('Crop to selection', () => cmd('cropToSel')), btn('Copy to layer', () => cmd('copyLayerSel')));
    if (k === 'cropAspect') O.append(sel('cropAspect', 'Ratio', [['free', 'Free'], ['1', '1:1'], ['1.3333', '4:3'], ['0.75', '3:4'], ['1.7778', '16:9'], ['0.5625', '9:16'], ['orig', 'Original']]));
    if (k === 'cropActions') O.append(btn('Apply crop ⏎', applyCrop, 'go'), btn('Reset', () => { S.crop = [0, 0, D.w, D.h]; render(); }));
    if (k === 'gradType') O.append(sel('gradType', 'Type', [['linear', 'Linear'], ['radial', 'Radial']]));
    if (k === 'gradMode') O.append(sel('gradMode', 'Colours', [['fg-bg', 'Foreground → background'], ['fg-clear', 'Foreground → transparent']]));
    if (k === 'cloneAligned') O.append(chk('cloneAligned', 'Aligned'));
    if (k === 'family') O.append(sel('family', 'Font', [['sans', 'Sans (Helvetica)'], ['serif', 'Serif (Times)'], ['mono', 'Mono'], ['Georgia', 'Georgia'], ['Impact', 'Impact'], ['"Arial Black"', 'Arial Black'], ['"Brush Script MT"', 'Brush Script'], ['Verdana', 'Verdana']]));
    if (k === 'fsize') O.append(num('fsize', 'Size', 4, 2000, 1, 1, 'px'));
    if (k === 'bold') O.append(btn(h('b', {}, 'B'), () => { o.bold = !o.bold; renderOpts(); }, o.bold ? 'on' : ''));
    if (k === 'italic') O.append(btn(h('i', {}, 'I'), () => { o.italic = !o.italic; renderOpts(); }, o.italic ? 'on' : ''));
    if (k === 'shape') O.append(sel('shape', 'Shape', [['rect', 'Rectangle'], ['round', 'Rounded rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['arrow', 'Arrow']]));
    if (k === 'shapeFill') O.append(chk('shapeFill', 'Fill (foreground)'));
    if (k === 'shapeStroke') O.append(chk('shapeStroke', 'Stroke (background)'));
    if (k === 'strokeW') O.append(num('strokeW', 'Stroke', 1, 200, 1, 1, 'px'));
    if (k === 'radius') O.append(num('radius', 'Radius', 0, 1000, 1, 1, 'px'));
    if (k === 'sampleAll') O.append(chk('sampleAll', 'Sample all layers'));
    if (k === 'zoomActions') O.append(btn('Fit', fit), btn('100%', () => zoomTo(1)), btn('200%', () => zoomTo(2)));
  }
}
$$('#tools [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#swap').onclick = () => { const a = $('#fg').value; $('#fg').value = $('#bg').value; $('#bg').value = a; };
$('#resetC').onclick = () => { $('#fg').value = '#000000'; $('#bg').value = '#ffffff'; };
const fg = () => $('#fg').value, bgc = () => $('#bg').value;

function align(where) {
  const L = act(); if (!L || L.locked) return; pushHistory('Align');
  const [x0, y0, x1, y1] = bbox(L), w = x1 - x0, hh = y1 - y0;
  let dx = 0, dy = 0;
  if (where === 'l') dx = -x0; if (where === 'r') dx = D.w - x1; if (where === 'c') dx = (D.w - w) / 2 - x0;
  if (where === 't') dy = -y0; if (where === 'b') dy = D.h - y1; if (where === 'm') dy = (D.h - hh) / 2 - y0;
  L.x += dx; L.y += dy; render(); renderProps();
}

/* ------------------------------------------------------------------ selection */
function setSelection(pathFn, mode = S.opt.selMode) {
  const mask = S.sel && mode !== 'new' ? S.sel.mask : newCanvas(D.w, D.h);
  const m = mask.getContext('2d');
  const p = new Path2D(); pathFn(p);
  m.globalCompositeOperation = mode === 'sub' ? 'destination-out' : 'source-over';
  m.fillStyle = '#000'; m.fill(p); m.globalCompositeOperation = 'source-over';
  const path = new Path2D(); if (S.sel && mode !== 'new') path.addPath(S.sel.path); path.addPath(p);
  S.sel = { mask, path }; if (isMaskEmpty(mask)) S.sel = null; render();
}
function isMaskEmpty(mask) { const d = ctxOf(mask).getImageData(0, 0, mask.width, mask.height).data; for (let i = 3; i < d.length; i += 64) if (d[i]) return false; return true; }
function selBounds() {
  if (!S.sel) return null; const d = ctxOf(S.sel.mask).getImageData(0, 0, D.w, D.h).data;
  let x0 = D.w, y0 = D.h, x1 = -1, y1 = -1;
  for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) if (d[(y * D.w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}
/* mask resampled into a layer's own pixel grid */
function maskForLayer(L) {
  if (!S.sel) return null;
  const c = newCanvas(L.canvas.width, L.canvas.height), x = c.getContext('2d'), sx = L.canvas.width / L.w, sy = L.canvas.height / L.h;
  x.drawImage(S.sel.mask, -L.x * sx, -L.y * sy, D.w * sx, D.h * sy); return c;
}
/* make a raster layer cover the whole canvas 1:1 so painting anywhere works */
function normalize(L) {
  if (L.x === 0 && L.y === 0 && L.w === D.w && L.h === D.h && L.canvas.width === D.w && L.canvas.height === D.h) return;
  const c = newCanvas(D.w, D.h); c.getContext('2d').drawImage(L.canvas, L.x, L.y, L.w, L.h);
  L.canvas = c; L.x = 0; L.y = 0; L.w = D.w; L.h = D.h; L.dirty = true;
}
function requireRaster(label = 'This') {
  const L = act(); if (!L) { toast('Select a layer first', 'err'); return null; }
  if (L.locked) { toast('Layer is locked', 'err'); return null; }
  if (L.type === 'text') { toast(`${label} works on image layers — rasterize the text layer first (Layer → Rasterize)`, 'err', 4500); return null; }
  return L;
}

/* ------------------------------------------------------------------ pointer handling */
view.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { const r = view.getBoundingClientRect(); zoomTo(V.z * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top); }
  else { V.px -= e.deltaX; V.py -= e.deltaY; render(); positionTextEditor(); }
}, { passive: false });
view.addEventListener('pointermove', e => { S.cursor = toDoc(e); if (['brush', 'eraser', 'clone', 'pencil'].includes(S.tool)) render(); });
view.addEventListener('pointerleave', () => { S.cursor = null; render(); });

view.addEventListener('pointerdown', e => {
  const tool = S.spaceDown || e.button === 1 ? 'hand' : S.tool;
  view.setPointerCapture(e.pointerId);
  const p0 = toDoc(e); let last = p0;
  const handlers = TOOLS[tool]?.(e, p0);
  if (!handlers) return;
  const move = ev => { const p = toDoc(ev); handlers.move?.(p, ev, last); last = p; render(); };
  const up = ev => { view.removeEventListener('pointermove', move); view.removeEventListener('pointerup', up); handlers.up?.(toDoc(ev), ev); S.preview = null; render(); };
  view.addEventListener('pointermove', move); view.addEventListener('pointerup', up);
});

function hitHandle(L, p) {
  const [x0, y0, x1, y1] = bbox(L), r = 9 / V.z;
  for (const [k, hx, hy] of [['tl', x0, y0], ['tr', x1, y0], ['bl', x0, y1], ['br', x1, y1]]) if (Math.abs(p[0] - hx) < r && Math.abs(p[1] - hy) < r) return k;
  return null;
}
function pickLayer(p) {
  for (let i = D.layers.length - 1; i >= 0; i--) {
    const L = D.layers[i]; if (!L.visible || L.locked) continue;
    const [x0, y0, x1, y1] = bbox(L); if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
    if (L.type === 'text') return i;
    const px = Math.floor((p[0] - L.x) * L.canvas.width / L.w), py = Math.floor((p[1] - L.y) * L.canvas.height / L.h);
    if (ctxOf(L.canvas).getImageData(px, py, 1, 1).data[3] > 10) return i;
  }
  return -1;
}

const TOOLS = {
  hand(e) { const sx = e.clientX, sy = e.clientY, px = V.px, py = V.py; view.style.cursor = 'grabbing'; return { move: (p, ev) => { V.px = px + ev.clientX - sx; V.py = py + ev.clientY - sy; positionTextEditor(); }, up: () => view.style.cursor = S.tool === 'hand' ? 'grab' : 'crosshair' }; },
  zoom(e, p) { const r = view.getBoundingClientRect(); zoomTo(V.z * (e.altKey ? 1 / 1.5 : 1.5), e.clientX - r.left, e.clientY - r.top); return null; },
  move(e, p0) {
    let L = act(); let handle = L && S.tool === 'move' ? hitHandle(L, p0) : null;
    if (!handle && S.opt.autoSelect) { const i = pickLayer(p0); if (i >= 0 && i !== S.active) { S.active = i; renderLayers(); renderProps(); } L = act(); }
    if (!L || L.locked) return null;
    const start = { ...L, bb: bbox(L) }; let pushed = false;
    const ensure = () => { if (!pushed) { pushHistory(handle ? 'Transform' : 'Move'); pushed = true; } };
    return {
      move(p, ev) {
        ensure(); const dx = p[0] - p0[0], dy = p[1] - p0[1];
        if (!handle) { L.x = start.x + dx; L.y = start.y + dy; return; }
        const [x0, y0, x1, y1] = start.bb, w0 = x1 - x0, h0 = y1 - y0;
        let nx0 = x0, ny0 = y0, nx1 = x1, ny1 = y1;
        if (handle.includes('l')) nx0 = x0 + dx; else nx1 = x1 + dx;
        if (handle.includes('t')) ny0 = y0 + dy; else ny1 = y1 + dy;
        let nw = Math.max(2, nx1 - nx0), nh = Math.max(2, ny1 - ny0);
        if (!ev.shiftKey || L.type === 'text') { const k = Math.max(nw / w0, nh / h0); nw = w0 * k; nh = h0 * k; }
        if (handle.includes('l')) nx0 = x1 - nw; else nx0 = x0;
        if (handle.includes('t')) ny0 = y1 - nh; else ny0 = y0;
        if (L.type === 'text') { const k = nw / w0; L.size = start.size * k; L.x = nx0 + (start.x - x0) * k; L.y = ny0 + (start.y - y0) * k; }
        else { L.x = nx0; L.y = ny0; L.w = nw; L.h = nh; }
      },
      up() { if (pushed) { L.dirty = true; renderProps(); renderLayers(); } },
    };
  },
  marquee(e, p0) { return selDrag(e, p0, (path, r) => path.rect(r[0], r[1], r[2] - r[0], r[3] - r[1])); },
  ellipseSel(e, p0) { return selDrag(e, p0, (path, r) => path.ellipse((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, (r[2] - r[0]) / 2, (r[3] - r[1]) / 2, 0, 0, Math.PI * 2)); },
  lasso(e, p0) {
    const pts = [p0], mode = e.shiftKey ? 'add' : e.altKey ? 'sub' : S.opt.selMode;
    S.preview = c => { c.save(); c.lineWidth = 1 / V.z; c.strokeStyle = '#fff'; c.setLineDash([4 / V.z, 3 / V.z]); c.beginPath(); pts.forEach((q, i) => i ? c.lineTo(...q) : c.moveTo(...q)); c.stroke(); c.restore(); };
    return { move: p => pts.push(p), up: () => { if (pts.length > 3) setSelection(path => { pts.forEach((q, i) => i ? path.lineTo(...q) : path.moveTo(...q)); path.closePath(); }, mode); else if (mode === 'new') { S.sel = null; } } };
  },
  crop(e, p0) {
    let mode = 'new', start = S.crop ? [...S.crop] : null;
    if (S.crop) {
      const [x0, y0, x1, y1] = S.crop, r = 10 / V.z;
      if (Math.abs(p0[0] - x0) < r) mode = 'l'; else if (Math.abs(p0[0] - x1) < r) mode = 'r';
      if (Math.abs(p0[1] - y0) < r) mode = mode === 'new' ? 't' : mode + 't'; else if (Math.abs(p0[1] - y1) < r) mode = mode === 'new' ? 'b' : mode + 'b';
      if (mode === 'new' && p0[0] > x0 && p0[0] < x1 && p0[1] > y0 && p0[1] < y1) mode = 'move';
    }
    const ratio = () => S.opt.cropAspect === 'free' ? null : S.opt.cropAspect === 'orig' ? D.w / D.h : +S.opt.cropAspect;
    return {
      move(p) {
        const dx = p[0] - p0[0], dy = p[1] - p0[1];
        if (mode === 'new') { const r = [Math.min(p0[0], p[0]), Math.min(p0[1], p[1]), Math.max(p0[0], p[0]), Math.max(p0[1], p[1])]; const k = ratio(); if (k) { const w = r[2] - r[0]; const hh = w / k; if (p[1] < p0[1]) r[1] = r[3] - hh; else r[3] = r[1] + hh; } S.crop = r; return; }
        let [x0, y0, x1, y1] = start;
        if (mode === 'move') { S.crop = [x0 + dx, y0 + dy, x1 + dx, y1 + dy]; return; }
        if (mode.includes('l')) x0 += dx; if (mode.includes('r')) x1 += dx; if (mode.includes('t')) y0 += dy; if (mode.includes('b')) y1 += dy;
        const k = ratio(); if (k) { const w = x1 - x0; if (mode.includes('t')) y0 = y1 - w / k; else y1 = y0 + w / k; }
        S.crop = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      },
    };
  },
  brush(e, p0) { return paintStroke(p0, 'brush'); },
  pencil(e, p0) { return paintStroke(p0, 'pencil'); },
  eraser(e, p0) { return paintStroke(p0, 'eraser'); },
  clone(e, p0) {
    if (e.altKey) { S.cloneSrc = p0; S.cloneOff = null; toast('Clone source set — now paint'); return null; }
    if (!S.cloneSrc) { toast('Alt-click to set the clone source first', 'err'); return null; }
    if (!S.cloneOff || !S.opt.cloneAligned) S.cloneOff = [S.cloneSrc[0] - p0[0], S.cloneSrc[1] - p0[1]];
    return paintStroke(p0, 'clone');
  },
  fill(e, p0) {
    const L = requireRaster('Fill'); if (!L) return null;
    pushHistory('Paint bucket', L); normalize(L);
    floodFill(L, Math.floor(p0[0]), Math.floor(p0[1]), fg(), S.opt.tolerance, S.opt.contiguous, S.opt.opacity);
    afterPixels(L); return null;
  },
  gradient(e, p0) {
    const L = requireRaster('Gradient'); if (!L) return null;
    let p1 = p0;
    S.preview = (c, lw) => { c.save(); c.lineWidth = 2 * lw; c.strokeStyle = '#fff'; c.beginPath(); c.moveTo(...p0); c.lineTo(...p1); c.stroke(); c.restore(); };
    return {
      move: p => { p1 = p; },
      up: () => {
        if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 2) return;
        pushHistory('Gradient', L); normalize(L);
        const g = newCanvas(D.w, D.h), x = g.getContext('2d');
        const gr = S.opt.gradType === 'radial' ? x.createRadialGradient(p0[0], p0[1], 0, p0[0], p0[1], Math.hypot(p1[0] - p0[0], p1[1] - p0[1])) : x.createLinearGradient(p0[0], p0[1], p1[0], p1[1]);
        gr.addColorStop(0, fg()); gr.addColorStop(1, S.opt.gradMode === 'fg-clear' ? hexA(fg(), 0) : bgc());
        x.fillStyle = gr; x.fillRect(0, 0, D.w, D.h); applyMask(g);
        const lc = L.canvas.getContext('2d'); lc.globalAlpha = S.opt.opacity; lc.drawImage(g, 0, 0); lc.globalAlpha = 1; afterPixels(L);
      },
    };
  },
  shape(e, p0) {
    let p1 = p0; const o = S.opt;
    const paint = (x, off, a, b) => {
      x.save(); x.translate(-off[0], -off[1]); x.fillStyle = fg(); x.strokeStyle = bgc(); x.lineWidth = o.strokeW; x.lineJoin = 'round'; x.lineCap = 'round';
      const r = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
      x.beginPath();
      if (o.shape === 'rect') x.rect(...r);
      else if (o.shape === 'round') x.roundRect(...r, Math.min(o.radius, r[2] / 2, r[3] / 2));
      else if (o.shape === 'ellipse') x.ellipse(r[0] + r[2] / 2, r[1] + r[3] / 2, r[2] / 2, r[3] / 2, 0, 0, Math.PI * 2);
      if (o.shape === 'line' || o.shape === 'arrow') {
        x.strokeStyle = fg(); x.lineWidth = o.strokeW; x.moveTo(...a); x.lineTo(...b); x.stroke();
        if (o.shape === 'arrow') { const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = Math.max(12, o.strokeW * 4); x.beginPath(); x.moveTo(...b); x.lineTo(b[0] - hl * Math.cos(ang - 0.45), b[1] - hl * Math.sin(ang - 0.45)); x.lineTo(b[0] - hl * Math.cos(ang + 0.45), b[1] - hl * Math.sin(ang + 0.45)); x.closePath(); x.fillStyle = fg(); x.fill(); }
      } else { if (o.shapeFill) x.fill(); if (o.shapeStroke) x.stroke(); }
      x.restore();
    };
    S.preview = c => paint(c, [0, 0], p0, p1);
    return {
      move: (p, ev) => { p1 = ev.shiftKey && !['line', 'arrow'].includes(o.shape) ? [p0[0] + Math.sign(p[0] - p0[0]) * Math.max(Math.abs(p[0] - p0[0]), Math.abs(p[1] - p0[1])), p0[1] + Math.sign(p[1] - p0[1]) * Math.max(Math.abs(p[0] - p0[0]), Math.abs(p[1] - p0[1]))] : p; },
      up: () => {
        if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 3) return;
        const pad = o.strokeW * 2 + 20, x0 = Math.floor(Math.min(p0[0], p1[0]) - pad), y0 = Math.floor(Math.min(p0[1], p1[1]) - pad);
        const c = newCanvas(Math.abs(p1[0] - p0[0]) + pad * 2, Math.abs(p1[1] - p0[1]) + pad * 2);
        paint(c.getContext('2d'), [x0, y0], p0, p1);
        pushHistory('Shape'); addLayer({ type: 'raster', name: { rect: 'Rectangle', round: 'Rounded rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' }[o.shape], canvas: c, x: x0, y: y0, w: c.width, h: c.height });
      },
    };
  },
  eyedropper(e, p0) {
    const pick = p => {
      let d;
      if (S.opt.sampleAll) d = cctx.getImageData(clamp(Math.floor(p[0]), 0, D.w - 1), clamp(Math.floor(p[1]), 0, D.h - 1), 1, 1).data;
      else { const L = act(); if (!L || L.type !== 'raster') return; d = ctxOf(L.canvas).getImageData(Math.floor((p[0] - L.x) * L.canvas.width / L.w), Math.floor((p[1] - L.y) * L.canvas.height / L.h), 1, 1).data; }
      const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      (e.altKey ? $('#bg') : $('#fg')).value = hex;
    };
    pick(p0); return { move: pick };
  },
  text(e, p0) {
    // click on existing text layer -> edit it
    for (let i = D.layers.length - 1; i >= 0; i--) {
      const L = D.layers[i]; if (L.type !== 'text' || !L.visible || L.locked) continue;
      const [x0, y0, x1, y1] = bbox(L);
      if (p0[0] >= x0 && p0[0] <= x1 && p0[1] >= y0 && p0[1] <= y1) { S.active = i; renderLayers(); renderProps(); startTextEdit(L); return null; }
    }
    const o = S.opt;
    pushHistory('New text');
    const L = addLayer({ type: 'text', name: 'Text', text: '', x: p0[0], y: p0[1] + o.fsize * 0.35, size: o.fsize, color: fg(), family: o.family, bold: o.bold, italic: o.italic, sx: 1 }, D.layers.length);
    startTextEdit(L, true); return null;
  },
};
function selDrag(e, p0, shapeFn) {
  const mode = e.shiftKey ? 'add' : e.altKey ? 'sub' : S.opt.selMode; let r = [p0[0], p0[1], p0[0], p0[1]];
  S.preview = c => { c.save(); c.lineWidth = 1 / V.z; c.strokeStyle = '#fff'; c.setLineDash([4 / V.z, 3 / V.z]); const p = new Path2D(); shapeFn(p, r); c.stroke(p); c.restore(); };
  return {
    move: (p, ev) => { r = [Math.min(p0[0], p[0]), Math.min(p0[1], p[1]), Math.max(p0[0], p[0]), Math.max(p0[1], p[1])]; if (ev.shiftKey && mode === 'new') { const s = Math.max(r[2] - r[0], r[3] - r[1]); r[2] = r[0] + s; r[3] = r[1] + s; } },
    up: () => { if (r[2] - r[0] < 2 && r[3] - r[1] < 2) { if (mode === 'new') { S.sel = null; } return; } setSelection(p => shapeFn(p, r), mode); },
  };
}

/* ---------- painting */
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function applyMask(canvas, L) {
  if (!S.sel) return canvas;
  const m = L ? maskForLayer(L) : S.sel.mask, x = canvas.getContext('2d');
  x.globalCompositeOperation = 'destination-in'; x.drawImage(m, 0, 0); x.globalCompositeOperation = 'source-over'; return canvas;
}
function paintStroke(p0, kind) {
  const L = requireRaster(kind === 'eraser' ? 'The eraser' : 'Painting'); if (!L) return null;
  pushHistory({ brush: 'Brush stroke', pencil: 'Pencil', eraser: 'Eraser', clone: 'Clone stamp' }[kind], L);
  normalize(L);
  const buf = newCanvas(D.w, D.h), bx = buf.getContext('2d'), size = S.opt.size, hard = kind === 'pencil' ? 1 : S.opt.hardness;
  const src = kind === 'clone' ? cloneCanvas(L.canvas) : null;
  const masked = newCanvas(D.w, D.h);
  const st = S.stroke = {
    layer: L, kind, opacity: S.opt.opacity, tmp: newCanvas(D.w, D.h),
    masked: () => { if (!S.sel) return buf; const m = masked.getContext('2d'); m.globalCompositeOperation = 'copy'; m.drawImage(buf, 0, 0); m.globalCompositeOperation = 'destination-in'; m.drawImage(S.sel.mask, 0, 0); m.globalCompositeOperation = 'source-over'; return masked; },
  };
  const color = kind === 'eraser' ? '#000' : fg();
  const dab = (x, y) => {
    if (kind === 'clone') {
      bx.save(); bx.beginPath(); bx.arc(x, y, size / 2, 0, Math.PI * 2); bx.clip();
      if (hard < 1) { // soft edge via gradient mask
        const t = newCanvas(size + 2, size + 2), tx = t.getContext('2d');
        tx.drawImage(src, -(x + S.cloneOff[0] - size / 2 - 1), -(y + S.cloneOff[1] - size / 2 - 1));
        tx.globalCompositeOperation = 'destination-in'; const g = tx.createRadialGradient(size / 2 + 1, size / 2 + 1, size / 2 * hard, size / 2 + 1, size / 2 + 1, size / 2);
        g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)'); tx.fillStyle = g; tx.fillRect(0, 0, t.width, t.height);
        bx.drawImage(t, x - size / 2 - 1, y - size / 2 - 1);
      } else bx.drawImage(src, -S.cloneOff[0], -S.cloneOff[1]);
      bx.restore(); return;
    }
    if (hard >= 0.99) { bx.fillStyle = color; bx.beginPath(); bx.arc(x, y, size / 2, 0, Math.PI * 2); bx.fill(); return; }
    const g = bx.createRadialGradient(x, y, size / 2 * hard, x, y, size / 2);
    g.addColorStop(0, color); g.addColorStop(1, hexA(color, 0)); bx.fillStyle = g; bx.fillRect(x - size / 2, y - size / 2, size, size);
  };
  const seg = (a, b) => {
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1]), step = Math.max(1, size * (kind === 'pencil' ? 0.1 : 0.15));
    for (let t = 0; t <= dist; t += step) dab(a[0] + (b[0] - a[0]) * t / dist || a[0], a[1] + (b[1] - a[1]) * t / dist || a[1]);
  };
  dab(...p0);
  return {
    move: (p, ev, last) => seg(last, p),
    up: () => {
      const lc = L.canvas.getContext('2d');
      lc.globalAlpha = st.opacity; lc.globalCompositeOperation = kind === 'eraser' ? 'destination-out' : 'source-over';
      lc.drawImage(st.masked(), 0, 0); lc.globalAlpha = 1; lc.globalCompositeOperation = 'source-over';
      S.stroke = null; afterPixels(L);
    },
  };
}
function afterPixels(L) { L.dirty = true; setDirty(); renderLayers(); render(); }

function floodFill(L, x, y, hex, tol, contiguous, opacity) {
  const W = L.canvas.width, H = L.canvas.height; if (x < 0 || y < 0 || x >= W || y >= H) return;
  const c = ctxOf(L.canvas), id = c.getImageData(0, 0, W, H), d = id.data;
  const n = parseInt(hex.slice(1), 16), fr = n >> 16, fgc = (n >> 8) & 255, fb = n & 255;
  const i0 = (y * W + x) * 4, sr = d[i0], sg = d[i0 + 1], sb = d[i0 + 2], sa = d[i0 + 3];
  const match = i => Math.abs(d[i] - sr) <= tol && Math.abs(d[i + 1] - sg) <= tol && Math.abs(d[i + 2] - sb) <= tol && Math.abs(d[i + 3] - sa) <= tol;
  const hit = new Uint8Array(W * H);
  if (contiguous) {
    const stack = [[x, y]];
    while (stack.length) {
      let [cx, cy] = stack.pop(); let i = cy * W + cx;
      while (cx >= 0 && !hit[i] && match(i * 4)) { cx--; i--; } cx++; i++;
      let up = false, dn = false;
      while (cx < W && !hit[i] && match(i * 4)) {
        hit[i] = 1;
        if (cy > 0) { const u = i - W; if (!hit[u] && match(u * 4)) { if (!up) { stack.push([cx, cy - 1]); up = true; } } else up = false; }
        if (cy < H - 1) { const v = i + W; if (!hit[v] && match(v * 4)) { if (!dn) { stack.push([cx, cy + 1]); dn = true; } } else dn = false; }
        cx++; i++;
      }
    }
  } else for (let i = 0; i < W * H; i++) if (match(i * 4)) hit[i] = 1;
  const mask = S.sel ? ctxOf(maskForLayer(L)).getImageData(0, 0, W, H).data : null;
  for (let i = 0; i < W * H; i++) if (hit[i]) {
    const a = opacity * (mask ? mask[i * 4 + 3] / 255 : 1); if (!a) continue; const j = i * 4;
    d[j] = d[j] + (fr - d[j]) * a; d[j + 1] = d[j + 1] + (fgc - d[j + 1]) * a; d[j + 2] = d[j + 2] + (fb - d[j + 2]) * a; d[j + 3] = Math.max(d[j + 3], 255 * a);
  }
  c.putImageData(id, 0, 0);
}

/* ---------- crop */
function applyCrop() {
  if (!S.crop) return;
  let [x0, y0, x1, y1] = S.crop.map(Math.round); if (x1 - x0 < 1 || y1 - y0 < 1) return;
  pushHistory('Crop'); cropCanvas(x0, y0, x1 - x0, y1 - y0); S.crop = [0, 0, D.w, D.h]; render();
}
function cropCanvas(x0, y0, w, hh) {
  D.layers.forEach(L => { L.x -= x0; L.y -= y0; L.dirty = true; });
  D.w = w; D.h = hh; S.sel = null; fit(); renderLayers(); renderProps();
}

/* ---------- inline text editing */
let TE = null;
function startTextEdit(L, isNew = false) {
  commitTextEdit();
  const ta = h('textarea', { class: 'textedit', spellcheck: 'false' }); ta.value = L.text;
  $('#overlay').append(ta); TE = { L, ta, before: L.text, isNew };
  ta.addEventListener('input', () => { L.text = ta.value; L.name = ta.value.split('\n')[0].slice(0, 48) || 'Text'; positionTextEditor(); render(); renderLayersLite(); });
  ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { commitTextEdit(); } });
  positionTextEditor(); setTimeout(() => { ta.focus(); ta.select(); }, 20);
}
function positionTextEditor() {
  if (!TE) return; const { L, ta } = TE, m = textMetrics(L);
  Object.assign(ta.style, {
    left: V.px + m.x0 * V.z + 'px', top: V.py + (L.y - L.size * 0.98) * V.z + 'px',
    width: Math.max(40, (m.x1 - m.x0) / (L.sx || 1) * V.z + 30) + 'px', height: (m.lines.length * L.size * 1.2 + L.size * 0.2) * V.z + 'px',
    fontSize: L.size * V.z + 'px', fontFamily: fontCss(L.family), fontWeight: L.bold ? 700 : 400, fontStyle: L.italic ? 'italic' : 'normal',
    color: 'transparent', caretColor: '#4a8cff', transform: `scaleX(${L.sx || 1})`,
  });
}
function commitTextEdit() {
  if (!TE) return; const { L, ta, before, isNew } = TE; TE = null; ta.remove();
  if (!L.text.trim()) { const i = D.layers.indexOf(L); if (i >= 0) { D.layers.splice(i, 1); S.active = Math.min(S.active, D.layers.length - 1); } if (isNew) { S.hist.pop(); S.hidx = S.hist.length - 1; renderHistory(); } }
  else if (!isNew && L.text !== before) { const cur = L.text; L.text = before; pushHistory('Edit text'); L.text = cur; }
  renderLayers(); renderProps(); render();
}

/* ------------------------------------------------------------------ pixel adjustments */
function boxBlur(src, W, H, r) {
  // 3-pass box blur on RGBA Float32 approximating a gaussian (premultiplied alpha)
  if (r < 1) return src;
  const n = W * H * 4, a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i += 4) { const al = src[i + 3] / 255; a[i] = src[i] * al; a[i + 1] = src[i + 1] * al; a[i + 2] = src[i + 2] * al; a[i + 3] = src[i + 3]; }
  const pass = (inp, out, rad, horiz) => {
    const len = horiz ? W : H, lines = horiz ? H : W, stride = horiz ? 4 : W * 4, k = 1 / (rad * 2 + 1);
    for (let l = 0; l < lines; l++) {
      const base = horiz ? l * W * 4 : l * 4;
      for (let ch = 0; ch < 4; ch++) {
        let acc = 0;
        for (let t = -rad; t <= rad; t++) acc += inp[base + clamp(t, 0, len - 1) * stride + ch];
        for (let t = 0; t < len; t++) {
          out[base + t * stride + ch] = acc * k;
          acc += inp[base + Math.min(t + rad + 1, len - 1) * stride + ch] - inp[base + Math.max(t - rad, 0) * stride + ch];
        }
      }
    }
  };
  const rad = Math.max(1, Math.round(r / 1.7));
  for (let p = 0; p < 3; p++) { pass(a, b, rad, true); pass(b, a, rad, false); }
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i += 4) { const al = a[i + 3] / 255 || 1; out[i] = a[i] / al; out[i + 1] = a[i + 1] / al; out[i + 2] = a[i + 2] / al; out[i + 3] = a[i + 3]; }
  return out;
}
function rgb2hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let hh = 0, s = 0; const l = (mx + mn) / 2; if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh /= 6; } return [hh, s, l]; }
function hsl2rgb(hh, s, l) { if (!s) return [l * 255, l * 255, l * 255]; const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255]; }
const ADJ = {
  brightness: { title: 'Brightness / Contrast', params: [['b', 'Brightness', -100, 100, 0], ['c', 'Contrast', -100, 100, 0]],
    fn(d, p) { const c = p.c * 2.55, f = (259 * (c + 255)) / (255 * (259 - c)), b = p.b * 1.5; for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = f * (d[i + k] - 128) + 128 + b; } },
  hsl: { title: 'Hue / Saturation', params: [['h', 'Hue', -180, 180, 0], ['s', 'Saturation', -100, 100, 0], ['l', 'Lightness', -100, 100, 0]],
    fn(d, p) { for (let i = 0; i < d.length; i += 4) { let [hh, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]); hh = (hh + p.h / 360 + 1) % 1; s = clamp(p.s >= 0 ? s + (1 - s) * p.s / 100 * s * 1.2 + s * p.s / 200 : s * (1 + p.s / 100), 0, 1); l = clamp(p.l >= 0 ? l + (1 - l) * p.l / 100 : l * (1 + p.l / 100), 0, 1); const [r, g, b] = hsl2rgb(hh, s, l); d[i] = r; d[i + 1] = g; d[i + 2] = b; } } },
  levels: { title: 'Levels', params: [['ib', 'Input black', 0, 254, 0], ['iw', 'Input white', 1, 255, 255], ['g', 'Midtones (gamma ×100)', 10, 300, 100], ['ob', 'Output black', 0, 255, 0], ['ow', 'Output white', 0, 255, 255]],
    fn(d, p) { const lut = new Uint8ClampedArray(256), ga = p.g / 100; for (let v = 0; v < 256; v++) { let t = clamp((v - p.ib) / Math.max(1, p.iw - p.ib), 0, 1); t = Math.pow(t, 1 / ga); lut[v] = p.ob + t * (p.ow - p.ob); } for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; } } },
  temperature: { title: 'Temperature / Tint', params: [['t', 'Temperature (cool ↔ warm)', -100, 100, 0], ['g', 'Tint (green ↔ magenta)', -100, 100, 0]],
    fn(d, p) { for (let i = 0; i < d.length; i += 4) { d[i] += p.t * 0.6; d[i + 2] -= p.t * 0.6; d[i + 1] -= p.g * 0.5; } } },
  exposure: { title: 'Exposure / Vibrance', params: [['e', 'Exposure (stops ×100)', -300, 300, 0], ['v', 'Vibrance', -100, 100, 0]],
    fn(d, p) { const m = Math.pow(2, p.e / 100), vb = p.v / 100; for (let i = 0; i < d.length; i += 4) { let r = d[i] * m, g = d[i + 1] * m, b = d[i + 2] * m; if (vb) { const mx = Math.max(r, g, b), avg = (r + g + b) / 3, amt = (Math.abs(mx - avg) * 2 / 255) * -vb * 3 + vb; r += (mx - r) * -amt * 0.5; g += (mx - g) * -amt * 0.5; b += (mx - b) * -amt * 0.5; } d[i] = r; d[i + 1] = g; d[i + 2] = b; } } },
  threshold: { title: 'Threshold', params: [['t', 'Threshold', 1, 255, 128]], fn(d, p) { for (let i = 0; i < d.length; i += 4) { const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) >= p.t ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; } } },
  posterize: { title: 'Posterize', params: [['n', 'Levels', 2, 32, 5]], fn(d, p) { const s = 255 / (p.n - 1); for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] / s) * s; } },
  invert: { instant: true, title: 'Invert', fn(d) { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } } },
  grayscale: { instant: true, title: 'Black & white', fn(d) { for (let i = 0; i < d.length; i += 4) { const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = v; } } },
  sepia: { instant: true, title: 'Sepia', fn(d) { for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; d[i] = r * .393 + g * .769 + b * .189; d[i + 1] = r * .349 + g * .686 + b * .168; d[i + 2] = r * .272 + g * .534 + b * .131; } } },
  autolevels: { instant: true, title: 'Auto levels', fn(d) {
    for (let k = 0; k < 3; k++) { const hist = new Uint32Array(256); let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { hist[d[i + k]]++; n++; }
      let lo = 0, hi = 255, acc = 0; while (lo < 255 && (acc += hist[lo]) < n * 0.005) lo++; acc = 0; while (hi > 0 && (acc += hist[hi]) < n * 0.005) hi--;
      if (hi <= lo) continue; for (let i = 0; i < d.length; i += 4) d[i + k] = (d[i + k] - lo) * 255 / (hi - lo); } } },
  blur: { title: 'Gaussian blur', params: [['r', 'Radius (px)', 0, 100, 4]], slow: true, fn(d, p, W, H) { if (p.r > 0) d.set(boxBlur(d, W, H, p.r)); } },
  sharpen: { title: 'Sharpen (unsharp mask)', params: [['a', 'Amount %', 0, 300, 80], ['r', 'Radius (px)', 1, 20, 2]], slow: true,
    fn(d, p, W, H) { const bl = boxBlur(d, W, H, p.r), a = p.a / 100; for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = d[i + k] + (d[i + k] - bl[i + k]) * a; } },
  noise: { title: 'Add noise', params: [['a', 'Amount', 0, 100, 12], ['m', 'Monochrome (0/1)', 0, 1, 1]],
    fn(d, p) { let seed = 1234567; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5; for (let i = 0; i < d.length; i += 4) { if (p.m) { const n = rnd() * p.a * 2.55 * 2; d[i] += n; d[i + 1] += n; d[i + 2] += n; } else { d[i] += rnd() * p.a * 5.1; d[i + 1] += rnd() * p.a * 5.1; d[i + 2] += rnd() * p.a * 5.1; } } } },
  pixelate: { title: 'Pixelate', params: [['s', 'Cell size (px)', 2, 100, 10]],
    fn(d, p, W, H) { const s = p.s; for (let y = 0; y < H; y += s) for (let x = 0; x < W; x += s) { let r = 0, g = 0, b = 0, a = 0, n = 0; for (let yy = y; yy < Math.min(y + s, H); yy++) for (let xx = x; xx < Math.min(x + s, W); xx++) { const i = (yy * W + xx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++; } for (let yy = y; yy < Math.min(y + s, H); yy++) for (let xx = x; xx < Math.min(x + s, W); xx++) { const i = (yy * W + xx) * 4; d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n; d[i + 3] = a / n; } } } },
  vignette: { title: 'Vignette', params: [['a', 'Amount', 0, 100, 45], ['s', 'Size', 10, 100, 60]],
    fn(d, p, W, H) { const cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy), inner = R * p.s / 100; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dist = Math.hypot(x - cx, y - cy); if (dist <= inner) continue; const f = 1 - clamp((dist - inner) / (R - inner), 0, 1) * p.a / 100; const i = (y * W + x) * 4; d[i] *= f; d[i + 1] *= f; d[i + 2] *= f; } } },
};
function adjust(key) {
  const def = ADJ[key]; const L = requireRaster(def.title); if (!L) return;
  const W = L.canvas.width, H = L.canvas.height, c = ctxOf(L.canvas);
  const orig = c.getImageData(0, 0, W, H);
  const mask = S.sel ? ctxOf(maskForLayer(L)).getImageData(0, 0, W, H).data : null;
  const compute = p => {
    const out = new ImageData(new Uint8ClampedArray(orig.data), W, H);
    def.fn(out.data, p, W, H);
    if (mask) for (let i = 0; i < out.data.length; i += 4) { const a = mask[i + 3] / 255; if (a < 1) for (let k = 0; k < 4; k++) out.data[i + k] = orig.data[i + k] + (out.data[i + k] - orig.data[i + k]) * a; }
    return out;
  };
  if (def.instant) { pushHistory(def.title, L); ctxOf(L.canvas).putImageData(compute({}), 0, 0); afterPixels(L); return; }
  const vals = Object.fromEntries(def.params.map(p => [p[0], p[4]]));
  const preview = newCanvas(W, H); const px = ctxOf(preview); px.putImageData(orig, 0, 0);
  const realCanvas = L.canvas; L.canvas = preview; render();
  let timer;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { px.putImageData(compute(vals), 0, 0); render(); }, def.slow ? 120 : 16); };
  const body = h('div', {}, def.params.map(([k, label, min, max, v]) => {
    const out = h('output', {}, v); const r = h('input', { type: 'range', min, max, value: v });
    r.oninput = () => { vals[k] = +r.value; out.textContent = r.value; refresh(); };
    return h('div', {}, h('label', {}, label), h('div', { class: 'sl' }, r, out));
  }));
  modal(def.title, body, [
    ['Cancel', () => { L.canvas = realCanvas; closeModal(); render(); }],
    ['OK', () => { clearTimeout(timer); L.canvas = realCanvas; pushHistory(def.title, L); ctxOf(L.canvas).putImageData(compute(vals), 0, 0); closeModal(); afterPixels(L); }, 'primary'],
  ], true);
}

/* ------------------------------------------------------------------ commands */
const CMD = {
  undo, redo, zoomIn: () => zoomTo(V.z * 1.25), zoomOut: () => zoomTo(V.z / 1.25), zoomFit: fit, zoom100: () => zoomTo(1),
  save: () => save(), saveCopy: async () => { await save(); const p = await api(`/api/studio/projects/${D.id}/duplicate`, { method: 'POST' }); location.href = '/studio?p=' + p.id; },
  new: newDialog, open: openDialog,
  importFile: () => pickFile('.psd,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.pdf,.docx,.pptx', async f => { const fd = new FormData(); fd.append('file', f); const p = await busy('Opening…', () => api('/api/studio/from-file', { form: fd })); if (await confirmLeave()) location.href = '/studio?p=' + p.id; }),
  importLayer: () => pickFile('image/*', async f => { const img = await loadImage(URL.createObjectURL(f)); const c = newCanvas(img.naturalWidth, img.naturalHeight); c.getContext('2d').drawImage(img, 0, 0); const k = Math.min(1, D.w / c.width, D.h / c.height); pushHistory('Place image'); addLayer({ type: 'raster', name: f.name.replace(/\.[^.]+$/, ''), canvas: c, x: (D.w - c.width * k) / 2, y: (D.h - c.height * k) / 2, w: c.width * k, h: c.height * k }); setTool('move'); }),
  exportPNG: () => exportImage('png'), exportJPG: () => exportImage('jpeg'), exportWEBP: () => exportImage('webp'),
  exportPSD: async () => { await save(); location.href = `/api/studio/projects/${D.id}/psd`; },
  placeReplace: () => place('replace'), placeInsert: () => place('insert'), placeNew: () => place('new'),
  selectAll: () => setSelection(p => p.rect(0, 0, D.w, D.h), 'new'),
  deselect: () => { S.sel = null; render(); },
  invertSel: () => {
    if (!S.sel) return CMD.selectAll();
    const m = newCanvas(D.w, D.h), x = m.getContext('2d'); x.fillRect(0, 0, D.w, D.h); x.globalCompositeOperation = 'destination-out'; x.drawImage(S.sel.mask, 0, 0);
    const path = new Path2D(); path.rect(0, 0, D.w, D.h); path.addPath(S.sel.path); S.sel = { mask: m, path }; render();
  },
  clearSel: () => {
    const L = requireRaster('Clearing'); if (!L) return;
    if (!S.sel) { if (L && confirm('Delete this layer?')) CMD.delLayer(); return; }
    pushHistory('Clear', L); const x = L.canvas.getContext('2d'); x.globalCompositeOperation = 'destination-out'; x.drawImage(maskForLayer(L), 0, 0); x.globalCompositeOperation = 'source-over'; afterPixels(L);
  },
  fillSel: () => {
    const L = requireRaster('Fill'); if (!L) return; pushHistory('Fill', L);
    const f = newCanvas(L.canvas.width, L.canvas.height), x = f.getContext('2d'); x.fillStyle = fg(); x.fillRect(0, 0, f.width, f.height); applyMask(f, L);
    L.canvas.getContext('2d').drawImage(f, 0, 0); afterPixels(L);
  },
  copyLayerSel: () => {
    const L = act(); if (!L) return;
    if (L.type === 'text') { pushHistory('Duplicate layer'); addLayer({ ...L, id: lid(), name: L.name + ' copy' }); return; }
    const c = newCanvas(D.w, D.h); c.getContext('2d').drawImage(L.canvas, L.x, L.y, L.w, L.h); if (S.sel) applyMask(c);
    pushHistory('Layer via copy'); addLayer({ type: 'raster', name: L.name + (S.sel ? ' (selection)' : ' copy'), canvas: c, x: 0, y: 0, w: D.w, h: D.h, opacity: L.opacity, blend: L.blend });
  },
  canvasSize: async () => {
    const f = await form('Canvas size', [['w', 'Width (px)', D.w], ['h', 'Height (px)', D.h], ['anchor', 'Anchor', 'c', 'select', [['c', 'Centre'], ['tl', 'Top left'], ['t', 'Top'], ['tr', 'Top right'], ['l', 'Left'], ['r', 'Right'], ['bl', 'Bottom left'], ['b', 'Bottom'], ['br', 'Bottom right']]]]);
    if (!f) return; const w = Math.round(+f.w), hh = Math.round(+f.h); if (!(w > 0 && hh > 0)) return;
    const ax = f.anchor.includes('l') ? 0 : f.anchor.includes('r') ? 1 : 0.5, ay = f.anchor.includes('t') ? 0 : f.anchor.includes('b') ? 1 : 0.5;
    pushHistory('Canvas size'); cropCanvas(Math.round((D.w - w) * ax), Math.round((D.h - hh) * ay), w, hh);
  },
  imageSize: async () => {
    const f = await form('Image size', [['w', 'Width (px)', D.w], ['h', 'Height (px) — leave blank to keep proportions', '']]);
    if (!f) return; const w = Math.round(+f.w); const hh = f.h ? Math.round(+f.h) : Math.round(D.h * w / D.w); if (!(w > 0 && hh > 0)) return;
    pushHistory('Image size'); const kx = w / D.w, ky = hh / D.h;
    D.layers.forEach(L => { L.x *= kx; L.y *= ky; L.dirty = true; if (L.type === 'text') { L.size *= ky; L.sx = (L.sx || 1) * kx / ky; } else { L.w *= kx; L.h *= ky; } });
    D.w = w; D.h = hh; S.sel = null; fit(); renderLayers(); renderProps();
  },
  cropToSel: () => { const b = selBounds(); if (!b) return toast('Make a selection first', 'err'); pushHistory('Crop to selection'); cropCanvas(b[0], b[1], b[2] - b[0], b[3] - b[1]); },
  trim: () => {
    compose(cctx); const d = cctx.getImageData(0, 0, D.w, D.h).data; let x0 = D.w, y0 = D.h, x1 = -1, y1 = -1;
    for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) if (d[(y * D.w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return; pushHistory('Trim'); cropCanvas(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  },
  rotCW: () => rotateCanvas(1), rotCCW: () => rotateCanvas(-1), flipCanvasH: () => flipCanvas(true), flipCanvasV: () => flipCanvas(false),
  newLayer: () => { pushHistory('New layer'); addLayer(blankRaster('Layer ' + (D.layers.length + 1))); },
  dupLayer: () => { const L = act(); if (!L) return; pushHistory('Duplicate layer'); addLayer({ ...L, id: lid(), name: L.name + ' copy', canvas: L.canvas ? cloneCanvas(L.canvas) : undefined }); },
  delLayer: () => { if (D.layers.length <= 1) return toast('An image needs at least one layer', 'err'); pushHistory('Delete layer'); D.layers.splice(S.active, 1); S.active = Math.max(0, S.active - 1); renderLayers(); renderProps(); render(); },
  layerUp: () => { if (S.active >= D.layers.length - 1) return; pushHistory('Bring forward'); const [m] = D.layers.splice(S.active, 1); D.layers.splice(++S.active, 0, m); renderLayers(); render(); },
  layerDown: () => { if (S.active <= 0) return; pushHistory('Send backward'); const [m] = D.layers.splice(S.active, 1); D.layers.splice(--S.active, 0, m); renderLayers(); render(); },
  rasterize: () => { const L = act(); if (!L || L.type !== 'text') return toast('Select a text layer', 'err'); pushHistory('Rasterize text'); Object.assign(L, toRaster(L)); renderLayers(); renderProps(); render(); },
  mergeDown: () => {
    if (S.active <= 0) return toast('Nothing below to merge into', 'err');
    const top = act(), low = D.layers[S.active - 1]; pushHistory('Merge down');
    const c = newCanvas(D.w, D.h), x = c.getContext('2d');
    drawLayerFlat(x, low, true); x.globalAlpha = top.opacity; x.globalCompositeOperation = top.blend; drawLayerFlat(x, top, true);
    Object.assign(low, { type: 'raster', canvas: c, x: 0, y: 0, w: D.w, h: D.h, dirty: true }); delete low.text;
    D.layers.splice(S.active, 1); S.active--; renderLayers(); renderProps(); render();
  },
  mergeVisible: () => { pushHistory('Merge visible'); const c = newCanvas(D.w, D.h); compose(c.getContext('2d')); D.layers = D.layers.filter(L => !L.visible); addLayer({ type: 'raster', name: 'Merged', canvas: c, x: 0, y: 0, w: D.w, h: D.h }, D.layers.length); },
  flatten: () => { pushHistory('Flatten'); const c = newCanvas(D.w, D.h), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, D.w, D.h); const t = newCanvas(D.w, D.h); compose(t.getContext('2d')); x.drawImage(t, 0, 0); D.layers = []; addLayer({ type: 'raster', name: 'Background', canvas: c, x: 0, y: 0, w: D.w, h: D.h }, 0); },
  flipLayerH: () => flipLayer(true), flipLayerV: () => flipLayer(false),
  rotLayer: async () => {
    const L = requireRaster('Rotate'); if (!L) return; const f = await form('Rotate layer', [['deg', 'Degrees (clockwise)', 15]]); if (!f) return;
    const a = (+f.deg || 0) * Math.PI / 180, cw = L.canvas.width, ch = L.canvas.height, nw = Math.abs(cw * Math.cos(a)) + Math.abs(ch * Math.sin(a)), nh = Math.abs(cw * Math.sin(a)) + Math.abs(ch * Math.cos(a));
    pushHistory('Rotate layer'); const c = newCanvas(nw, nh), x = c.getContext('2d'); x.translate(nw / 2, nh / 2); x.rotate(a); x.drawImage(L.canvas, -cw / 2, -ch / 2);
    const kx = L.w / cw, ky = L.h / ch, cx = L.x + L.w / 2, cy = L.y + L.h / 2; L.canvas = c; L.w = nw * kx; L.h = nh * ky; L.x = cx - L.w / 2; L.y = cy - L.h / 2; L.dirty = true; renderLayers(); render();
  },
  removeBg: async () => {
    const L = requireRaster('Background removal'); if (!L) return;
    const res = await busy('Removing background with AI… (first run downloads the model)', () => api('/api/studio/remove-bg', { json: { data: L.canvas.toDataURL('image/png') } }));
    const img = await loadImage(res.data); pushHistory('Remove background', L);
    const x = L.canvas.getContext('2d'); x.clearRect(0, 0, L.canvas.width, L.canvas.height); x.drawImage(img, 0, 0, L.canvas.width, L.canvas.height); afterPixels(L);
  },
};
function drawLayerFlat(x, L, ignoreVisibility) { if (!L.visible && !ignoreVisibility) return; if (L.type === 'text') drawText(x, L); else x.drawImage(L.canvas, L.x, L.y, L.w, L.h); }
function toRaster(L) { const r = rasterizeText(L); return { type: 'raster', canvas: r.canvas, x: r.x, y: r.y, w: r.canvas.width, h: r.canvas.height, dirty: true, text: undefined }; }
function flipLayer(horiz) {
  const L = requireRaster('Flip'); if (!L) return; pushHistory(horiz ? 'Flip horizontal' : 'Flip vertical');
  const c = newCanvas(L.canvas.width, L.canvas.height), x = c.getContext('2d'); x.translate(horiz ? c.width : 0, horiz ? 0 : c.height); x.scale(horiz ? -1 : 1, horiz ? 1 : -1); x.drawImage(L.canvas, 0, 0); L.canvas = c; afterPixels(L);
}
function rasterizeAllText() { D.layers.forEach(L => { if (L.type === 'text') Object.assign(L, toRaster(L)); }); }
function rotateCanvas(dir) {
  if (D.layers.some(L => L.type === 'text') && !confirm('Rotating the canvas rasterizes text layers. Continue?')) return;
  pushHistory(dir > 0 ? 'Rotate 90° CW' : 'Rotate 90° CCW'); rasterizeAllText();
  D.layers.forEach(L => {
    const c = newCanvas(L.canvas.height, L.canvas.width), x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(dir * Math.PI / 2); x.drawImage(L.canvas, -L.canvas.width / 2, -L.canvas.height / 2);
    const nx = dir > 0 ? D.h - (L.y + L.h) : L.y, ny = dir > 0 ? L.x : D.w - (L.x + L.w); [L.w, L.h] = [L.h, L.w]; L.x = nx; L.y = ny; L.canvas = c; L.dirty = true;
  });
  [D.w, D.h] = [D.h, D.w]; S.sel = null; fit(); renderLayers(); renderProps();
}
function flipCanvas(horiz) {
  if (D.layers.some(L => L.type === 'text') && !confirm('Flipping the canvas rasterizes text layers. Continue?')) return;
  pushHistory(horiz ? 'Flip canvas horizontal' : 'Flip canvas vertical'); rasterizeAllText();
  D.layers.forEach(L => {
    const c = newCanvas(L.canvas.width, L.canvas.height), x = c.getContext('2d'); x.translate(horiz ? c.width : 0, horiz ? 0 : c.height); x.scale(horiz ? -1 : 1, horiz ? 1 : -1); x.drawImage(L.canvas, 0, 0); L.canvas = c; L.dirty = true;
    if (horiz) L.x = D.w - (L.x + L.w); else L.y = D.h - (L.y + L.h);
  });
  S.sel = null; render(); renderLayers();
}
function cmd(name) {
  closeMenus();
  if (name.startsWith('adj:')) return adjust(name.slice(4));
  const fn = CMD[name]; if (fn) { commitTextEdit(); fn(); } else toast('Not available: ' + name, 'err');
}
$$('[data-cmd]').forEach(b => b.addEventListener('click', () => cmd(b.dataset.cmd)));

/* ------------------------------------------------------------------ menus */
function closeMenus() { $$('.m.open').forEach(m => m.classList.remove('open')); }
$$('.m>button').forEach(b => {
  b.addEventListener('click', e => { e.stopPropagation(); const m = b.parentElement, open = m.classList.contains('open'); closeMenus(); if (!open) m.classList.add('open'); });
  b.addEventListener('mouseenter', () => { if ($('.m.open') && !b.parentElement.classList.contains('open')) { closeMenus(); b.parentElement.classList.add('open'); } });
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('.m')) closeMenus(); });

/* ------------------------------------------------------------------ modals */
function modal(title, body, buttons, nodim = false) {
  $('#mTitle').textContent = title; $('#mBody').replaceChildren(body);
  $('#mBtns').replaceChildren(...buttons.map(([l, fn, cls]) => h('button', { class: cls || '', onclick: fn }, l)));
  $('#modal').classList.toggle('nodim', nodim); $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
function form(title, fields) {
  return new Promise(res => {
    const inputs = {}; const body = h('div');
    for (const [k, label, v, type = 'text', opts] of fields) {
      const el = type === 'select' ? h('select', {}, opts.map(([ov, ol]) => h('option', { value: ov, selected: ov === v }, ol))) : h('input', { type: type === 'number' ? 'number' : 'text', value: v });
      inputs[k] = el; body.append(h('label', {}, label), el);
    }
    const ok = () => { closeModal(); res(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))); };
    body.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') { closeModal(); res(null); } });
    modal(title, body, [['Cancel', () => { closeModal(); res(null); }], ['OK', ok, 'primary']]);
    setTimeout(() => body.querySelector('input,select')?.focus(), 30);
  });
}
function pickFile(accept, fn) { const i = $('#fileIn'); i.accept = accept; i.value = ''; i.onchange = () => i.files[0] && fn(i.files[0]); i.click(); }
async function confirmLeave() { return !S.dirty || confirm('Discard unsaved changes?'); }
async function newDialog() {
  const f = await form('New image', [['name', 'Name', 'Untitled'], ['preset', 'Size', 'custom', 'select', [['custom', 'Custom (below)'], ['1920x1080', 'HD 1920×1080'], ['1080x1080', 'Square 1080×1080'], ['1080x1920', 'Story 1080×1920'], ['2550x3300', 'US Letter @300dpi'], ['2480x3508', 'A4 @300dpi'], ['1200x628', 'Social banner 1200×628']]], ['w', 'Width (px)', 1600], ['h', 'Height (px)', 1000], ['bg', 'Background', '#ffffff', 'select', [['#ffffff', 'White'], ['transparent', 'Transparent'], ['#000000', 'Black']]]]);
  if (!f) return; let [w, hh] = f.preset !== 'custom' ? f.preset.split('x').map(Number) : [+f.w, +f.h];
  if (!(await confirmLeave())) return;
  const p = await api('/api/studio/new', { json: { name: f.name, w, h: hh, bg: f.bg } }); location.href = '/studio?p=' + p.id;
}
async function openDialog() {
  const list = await api('/api/studio/projects');
  const grid = h('div', { class: 'projgrid' }, list.length ? list.map(p => h('div', { class: 'proj', onclick: async () => { if (await confirmLeave()) location.href = '/studio?p=' + p.id; } },
    h('img', { src: `/api/studio/projects/${p.id}/thumb.png?${Math.round(p.modified)}`, loading: 'lazy' }), h('b', { title: p.name }, p.name), h('small', {}, `${p.w}×${p.h} · ${new Date(p.modified * 1000).toLocaleDateString()}`),
    h('button', { class: 'x', title: 'Delete', onclick: async e => { e.stopPropagation(); if (confirm(`Delete “${p.name}”?`)) { await api(`/api/studio/projects/${p.id}`, { method: 'DELETE' }); e.target.closest('.proj').remove(); } } }, '✕'))) : h('p', {}, 'No saved projects yet.'));
  modal('Open project', grid, [['Close', closeModal]]);
}

/* ------------------------------------------------------------------ load / save / export */
async function load(pid) {
  const p = await api(`/api/studio/projects/${pid}`);
  D.id = p.id; D.name = p.name; D.w = p.w; D.h = p.h; D.source = p.source;
  D.layers = await Promise.all(p.layers.map(async L => {
    L = { visible: true, opacity: 1, blend: 'source-over', locked: false, ...L, dirty: false };
    if (L.type === 'raster') {
      const img = await loadImage(`/api/studio/projects/${pid}/layer/${L.id}.png?${Date.now()}`);
      L.canvas = newCanvas(img.naturalWidth, img.naturalHeight); L.canvas.getContext('2d').drawImage(img, 0, 0);
      L.w = L.w || img.naturalWidth; L.h = L.h || img.naturalHeight;
    }
    return L;
  }));
  S.active = Math.max(0, D.layers.findIndex(L => L.type === 'text') - 1); if (S.active < 0) S.active = 0;
  $('#title').textContent = D.name; document.title = D.name + ' — Image Studio';
  $$('.src-only').forEach(el => el.classList.toggle('hidden', !D.source));
  S.hist = []; S.hidx = -1; renderHistory(); setDirty(false); fit(); renderLayers(); renderProps();
  history.replaceState(null, '', '/studio?p=' + pid);
}
async function save(quiet = false) {
  commitTextEdit(); if (!D.id) return;
  const layers = D.layers.map(L => {
    const o = { id: L.id, type: L.type, name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend, locked: L.locked, x: L.x, y: L.y };
    if (L.type === 'raster') { o.w = L.w; o.h = L.h; if (L.dirty) o.data = L.canvas.toDataURL('image/png'); }
    else { Object.assign(o, { text: L.text, size: L.size, color: L.color, family: L.family, bold: L.bold, italic: L.italic, sx: L.sx, fitWidth: L.fitWidth }); const r = rasterizeText(L); o.raster = r.canvas.toDataURL('image/png'); o.rx = r.x; o.ry = r.y; }
    return o;
  });
  const t = newCanvas(Math.min(480, D.w), Math.min(480, D.w) * D.h / D.w); compose(cctx); t.getContext('2d').drawImage(comp, 0, 0, t.width, t.height);
  await busy('Saving…', () => api(`/api/studio/projects/${D.id}`, { method: 'PUT', json: { name: D.name, w: D.w, h: D.h, layers, thumb: t.toDataURL('image/png') } }));
  D.layers.forEach(L => L.dirty = false); setDirty(false); if (!quiet) toast('Saved');
}
function exportImage(type) {
  const c = newCanvas(D.w, D.h), x = c.getContext('2d');
  if (type === 'jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, D.w, D.h); }
  const t = newCanvas(D.w, D.h); compose(t.getContext('2d')); x.drawImage(t, 0, 0);
  c.toBlob(b => { const a = h('a', { href: URL.createObjectURL(b), download: `${D.name}.${type === 'jpeg' ? 'jpg' : type}` }); document.body.append(a); a.click(); a.remove(); }, 'image/' + type, 0.92);
}
async function place(mode) {
  await save(true);
  const r = newCanvas(D.w, D.h), x = r.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, D.w, D.h);
  const t = newCanvas(D.w, D.h); compose(t.getContext('2d'), { rasterOnly: true }); x.drawImage(t, 0, 0);
  const texts = D.layers.filter(L => L.type === 'text' && L.visible).map(L => ({ text: L.text, x: L.x, y: L.y, size: L.size, color: L.color, family: L.family, bold: L.bold, italic: L.italic, sx: L.sx, opacity: L.opacity, visible: true }));
  const res = await busy(mode === 'new' ? 'Creating PDF…' : 'Saving into the PDF…', () => api(`/api/studio/projects/${D.id}/place`, { json: { raster: r.toDataURL('image/jpeg', 0.92), texts, mode } }));
  const t2 = toast(h('span', {}, mode === 'new' ? 'PDF created. ' : 'PDF page updated (you can undo it in PDF Studio). ', h('a', { href: `/?doc=${res.doc_id}`, style: { color: '#9cc0ff' } }, 'Open in PDF Studio →')), '', 9000);
}

$('#btnSave').onclick = () => save();
$('#btnPlace').onclick = () => place('replace');
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#title').onclick = async () => { const f = await form('Rename', [['n', 'Name', D.name]]); if (f && f.n.trim()) { D.name = f.n.trim(); $('#title').textContent = D.name; setDirty(); } };
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ------------------------------------------------------------------ keyboard */
document.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea,select')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.code === 'Space' && !S.spaceDown) { S.spaceDown = true; view.style.cursor = 'grab'; e.preventDefault(); return; }
  if (mod) {
    const map = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', o: 'open', a: 'selectAll', d: 'deselect', j: 'copyLayerSel', e: 'mergeDown', ']': 'layerUp', '[': 'layerDown', '0': 'zoomFit', '1': 'zoom100', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut' };
    if (e.shiftKey && k === 'n') { e.preventDefault(); return cmd('newLayer'); }
    if (e.shiftKey && k === 'i') { e.preventDefault(); return cmd('invertSel'); }
    if (k === 'n') { e.preventDefault(); return cmd('new'); }
    if (map[k]) { e.preventDefault(); cmd(map[k]); }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return e.altKey ? cmd('fillSel') : cmd('clearSel'); }
  if (e.key === 'Enter' && S.tool === 'crop') return applyCrop();
  if (e.key === 'Escape') { if (S.tool === 'crop') { S.crop = [0, 0, D.w, D.h]; render(); } else { S.sel = null; render(); } closeModal(); return; }
  if (e.key === '[') { S.opt.size = Math.max(1, Math.round(S.opt.size / 1.2)); renderOpts(); render(); return; }
  if (e.key === ']') { S.opt.size = Math.round(S.opt.size * 1.2) + 1; renderOpts(); render(); return; }
  if (e.key.startsWith('Arrow') && S.tool === 'move') {
    const L = act(); if (!L || L.locked) return; e.preventDefault(); pushHistory('Nudge'); const s = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') L.x -= s; if (e.key === 'ArrowRight') L.x += s; if (e.key === 'ArrowUp') L.y -= s; if (e.key === 'ArrowDown') L.y += s; render(); return;
  }
  const tools = { v: 'move', m: 'marquee', l: 'lasso', c: 'crop', b: 'brush', n: 'pencil', e: 'eraser', g: 'fill', s: 'clone', t: 'text', u: 'shape', i: 'eyedropper', h: 'hand', z: 'zoom' };
  if (tools[k]) return setTool(tools[k]);
  if (k === 'x') return $('#swap').click();
  if (k === 'd') return $('#resetC').click();
});
document.addEventListener('keyup', e => { if (e.code === 'Space' && S.spaceDown) { S.spaceDown = false; view.style.cursor = { hand: 'grab', zoom: 'zoom-in', text: 'text', eyedropper: 'crosshair', move: 'default' }[S.tool] || 'crosshair'; } });

/* ------------------------------------------------------------------ boot */
(async () => {
  setTool('move');
  const q = new URLSearchParams(location.search);
  try {
    if (q.get('p')) await load(q.get('p'));
    else if (q.get('doc')) { const p = await busy('Splitting the page into layers…', () => api('/api/studio/from-page', { json: { doc_id: q.get('doc'), page: +(q.get('page') || 0) } })); await load(p.id); }
    else { const list = await api('/api/studio/projects'); if (list.length) await load(list[0].id); else { const p = await api('/api/studio/new', { json: { name: 'Untitled', w: 1600, h: 1000, bg: '#ffffff' } }); await load(p.id); } }
  } catch (e) { if (e.message !== 'login') toast('Could not open: ' + e.message, 'err', 8000); }
})();
