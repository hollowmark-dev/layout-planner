/**
 * 寸法線・文字注記と、計測ツール。
 * 「2点（＋オフセット1点）を拾う」処理は縮尺較正でも使うので pickPoints() として外へ出す。
 */

import {
  state, bus, notes, items, uid, commit, setTool, layerById, toggleSelection,
} from '../state.js';
import { fmtMm, fmtLen } from '../geom.js';
import {
  stage, mainLayer, overlayLayer, pointer, screenToMm, pxPerMmScreen,
} from './stage.js';
import { snapPoint, snapToItems } from './snap.js';
import { showHint, hideHint, openModal, el, toast } from '../ui/dom.js';

let notesGroup = null;
let pickGroup = null;
let measureGroup = null;
const noteNodes = new Map();

/* ── 点を拾う ───────────────────────────────────────── */

let picking = null;

/**
 * 図面上の点を n 個クリックで拾う。Esc で中止。
 * @returns {Promise<Array<{x,y}>|null>}
 */
export function pickPoints(n, opts = {}) {
  cancelPicking();
  return new Promise((resolve) => {
    picking = {
      n, opts, pts: [], resolve, preview: opts.preview || defaultPreview,
    };
    document.getElementById('stage-wrap').classList.add('tool-calib');
    if (opts.hint) showHint(opts.hint(0));
  });
}

export function cancelPicking() {
  if (!picking) return;
  const { resolve } = picking;
  picking = null;
  pickGroup?.destroyChildren();
  overlayLayer.batchDraw();
  hideHint();
  document.getElementById('stage-wrap').classList.remove('tool-calib');
  resolve(null);
}

function snapCursor() {
  const p = pointer();
  // 縮尺の較正では吸着させない。グリッドは縮尺が決まって初めて意味を持つので、
  // 較正の基準寸法を100mm単位に丸めてしまうと縮尺そのものが狂う
  if (picking?.opts.snap === false) return p;
  return state.project.settings.snapEdge ? snapToItems(p, items()) : snapPoint(p);
}

function onPickClick() {
  if (!picking) return;
  const p = snapCursor();
  picking.pts.push(p);
  if (picking.pts.length >= picking.n) {
    const { resolve, pts } = picking;
    picking = null;
    pickGroup.destroyChildren();
    overlayLayer.batchDraw();
    hideHint();
    document.getElementById('stage-wrap').classList.remove('tool-calib');
    resolve(pts);
  } else if (picking.opts.hint) {
    showHint(picking.opts.hint(picking.pts.length));
  }
}

function onPickMove() {
  if (!picking) return;
  pickGroup.destroyChildren();
  picking.preview(pickGroup, picking.pts, snapCursor());
  overlayLayer.batchDraw();
}

function defaultPreview(g, pts, cur) {
  const mark = (p, color = '#dc2626') => new Konva.Circle({
    x: p.x, y: p.y, radius: screenToMm(4), fill: color, listening: false,
  });
  pts.forEach((p) => g.add(mark(p)));
  g.add(mark(cur, '#2563eb'));
  if (pts.length >= 1) {
    const a = pts[0];
    g.add(new Konva.Line({
      points: [a.x, a.y, cur.x, cur.y],
      stroke: '#dc2626',
      strokeWidth: 1.5,
      dash: [10, 6],
      strokeScaleEnabled: false,
      listening: false,
    }));
    if (state.project.drawing.pxPerMm) {
      g.add(lengthTag(a, cur));
    }
  }
}

function lengthTag(a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const size = screenToMm(12);
  return new Konva.Label({
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, listening: false,
  }).add(
    new Konva.Tag({ fill: 'rgba(17,24,39,.85)', cornerRadius: screenToMm(3) }),
    new Konva.Text({
      text: fmtLen(len),
      fontSize: size,
      padding: screenToMm(4),
      fill: '#fff',
      fontFamily: 'Yu Gothic UI, Meiryo, sans-serif',
    }),
  );
}

/* ── 寸法線・文字の描画 ─────────────────────────────── */

function dimGeometry(nt) {
  const dx = nt.x2 - nt.x1;
  const dy = nt.y2 - nt.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len; const uy = dy / len;
  const nx = -uy; const ny = ux;
  const o = nt.off || 0;
  return {
    len,
    ux,
    uy,
    nx,
    ny,
    p1: { x: nt.x1 + nx * o, y: nt.y1 + ny * o },
    p2: { x: nt.x2 + nx * o, y: nt.y2 + ny * o },
  };
}

function buildDim(nt) {
  const color = layerById(nt.layerId)?.color || '#b45309';
  const size = nt.sizeMm || state.project.settings.textMm;
  const arrow = size * 0.55;
  const { len, ux, uy, nx, ny, p1, p2 } = dimGeometry(nt);
  const g = new Konva.Group({ name: 'note', id: nt.id });

  const line = (pts, w = 1) => new Konva.Line({
    points: pts, stroke: color, strokeWidth: w, strokeScaleEnabled: false, listening: false,
  });

  // 補助線（実測点から寸法線まで）
  const ext = size * 0.35;
  g.add(line([nt.x1 + nx * ext * Math.sign(nt.off || 1) * 0.3, nt.y1 + ny * ext * Math.sign(nt.off || 1) * 0.3,
    p1.x + nx * ext, p1.y + ny * ext], 0.8));
  g.add(line([nt.x2 + nx * ext * Math.sign(nt.off || 1) * 0.3, nt.y2 + ny * ext * Math.sign(nt.off || 1) * 0.3,
    p2.x + nx * ext, p2.y + ny * ext], 0.8));

  // 寸法線本体
  g.add(line([p1.x, p1.y, p2.x, p2.y], 1.2));

  // 矢印（内向き）
  const head = (p, dir) => new Konva.Line({
    points: [
      p.x, p.y,
      p.x + (ux * dir * arrow) + nx * arrow * 0.3, p.y + (uy * dir * arrow) + ny * arrow * 0.3,
      p.x + (ux * dir * arrow) - nx * arrow * 0.3, p.y + (uy * dir * arrow) - ny * arrow * 0.3,
    ],
    closed: true,
    fill: color,
    listening: false,
  });
  g.add(head(p1, 1), head(p2, -1));

  // 寸法値（線の上側に、読める向きで）
  let deg = (Math.atan2(uy, ux) * 180) / Math.PI;
  let flip = 1;
  if (deg > 90 || deg < -90) { deg += 180; flip = -1; }
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const lift = size * 0.35;
  const text = new Konva.Text({
    name: 'dimtext',
    text: nt.text || fmtMm(len),
    fontSize: size,
    fontFamily: 'Yu Gothic UI, Meiryo, sans-serif',
    fill: color,
    align: 'center',
    width: Math.max(len, size * 4),
    x: mid.x - (Math.max(len, size * 4) / 2) * (flip > 0 ? 1 : 1),
    y: mid.y,
    offsetY: size + lift,
    rotation: deg,
    listening: false,
  });
  // 回転の中心を線の中点に合わせる
  text.offsetX(Math.max(len, size * 4) / 2);
  text.x(mid.x);
  g.add(text);

  // 当たり判定（細い線は掴みにくい）
  g.add(new Konva.Line({
    points: [p1.x, p1.y, p2.x, p2.y],
    stroke: 'transparent',
    strokeWidth: Math.max(size * 0.8, 100),
    strokeScaleEnabled: false,
    hitStrokeWidth: 20,
  }));
  return g;
}

function buildText(nt) {
  const color = layerById(nt.layerId)?.color || '#b45309';
  const size = nt.sizeMm || state.project.settings.textMm;
  const g = new Konva.Group({
    name: 'note', id: nt.id, x: nt.x, y: nt.y, rotation: nt.rot || 0, draggable: true,
  });
  g.add(new Konva.Text({
    name: 'body',
    text: nt.text || '',
    fontSize: size,
    fontFamily: 'Yu Gothic UI, Meiryo, sans-serif',
    fill: color,
    lineHeight: 1.25,
  }));
  const t = g.findOne('.body');
  g.add(new Konva.Rect({
    x: -size * 0.15, y: -size * 0.1,
    width: t.width() + size * 0.3, height: t.height() + size * 0.2,
    fill: 'rgba(255,255,255,.55)',
  }));
  g.findOne('Rect').moveToBottom();
  return g;
}

export function syncNotes() {
  const list = notes();
  const seen = new Set();
  for (const nt of list) {
    seen.add(nt.id);
    const old = noteNodes.get(nt.id);
    if (old) old.destroy();
    const g = nt.type === 'dim' ? buildDim(nt) : buildText(nt);
    const layer = layerById(nt.layerId);
    g.visible(layer ? layer.visible : true);
    g.listening(layer ? layer.visible && !layer.locked : true);
    if (nt.type === 'text') g.draggable(state.tool === 'select' && !(layer && layer.locked));
    if (state.selection.has(nt.id)) {
      g.add(new Konva.Rect({
        ...g.getClientRect({ relativeTo: g }),
        stroke: '#1d4ed8', strokeWidth: 1.5, dash: [6, 4], strokeScaleEnabled: false, listening: false,
      }));
    }
    bindNoteEvents(g, nt);
    notesGroup.add(g);
    noteNodes.set(nt.id, g);
  }
  for (const [id, g] of noteNodes) {
    if (!seen.has(id)) { g.destroy(); noteNodes.delete(id); }
  }
  mainLayer.batchDraw();
}

function bindNoteEvents(g, nt) {
  g.on('mousedown', (e) => {
    if (state.tool !== 'select' || e.evt.button !== 0) return;
    e.cancelBubble = true;
    toggleSelection(nt.id, e.evt.shiftKey || e.evt.ctrlKey);
  });
  if (nt.type === 'text') {
    g.on('dragend', () => {
      nt.x = Math.round(g.x() * 10) / 10;
      nt.y = Math.round(g.y() * 10) / 10;
      commit(['notes:changed']);
    });
    g.on('dblclick', () => editText(nt));
  }
}

/* ── ツール ─────────────────────────────────────────── */

async function runDimTool() {
  const pts = await pickPoints(3, {
    hint: (i) => [
      '寸法をとる<b>1点目</b>をクリック（Escで中止）',
      '<b>2点目</b>をクリック',
      '寸法線を置く<b>位置</b>をクリック',
    ][i],
    preview: (g, pts0, cur) => {
      defaultPreview(g, pts0.slice(0, 2), cur);
      if (pts0.length === 2) {
        g.destroyChildren();
        const tmp = { ...tmpDim(pts0, cur), id: 'preview' };
        g.add(buildDim(tmp));
      }
    },
  });
  if (!pts) { setTool('select'); return; }
  const nt = { id: uid('n'), ...tmpDim(pts.slice(0, 2), pts[2]) };
  notes().push(nt);
  commit(['notes:changed']);
  setTool('select');
}

function tmpDim([a, b], c) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; const ny = dx / len;
  const off = c ? (c.x - a.x) * nx + (c.y - a.y) * ny : 0;
  return {
    type: 'dim',
    x1: a.x, y1: a.y, x2: b.x, y2: b.y,
    off: Math.round(off),
    text: null,
    sizeMm: state.project.settings.textMm,
    layerId: noteLayerId(),
  };
}

function noteLayerId() {
  return state.project.layers.find((l) => l.name === '注記')?.id
    || state.project.layers[state.project.layers.length - 1].id;
}

async function runTextTool() {
  const pts = await pickPoints(1, { hint: () => '文字を置く<b>位置</b>をクリック（Escで中止）' });
  if (!pts) { setTool('select'); return; }
  const input = el('input', { type: 'text', placeholder: '例：通路 1,200 確保', style: 'width:100%' });
  openModal({
    title: '文字を記入',
    body: el('div', {}, [input]),
    okLabel: '記入',
    onOk: () => {
      const text = input.value.trim();
      if (!text) return false;
      notes().push({
        id: uid('n'),
        type: 'text',
        x: Math.round(pts[0].x),
        y: Math.round(pts[0].y),
        rot: 0,
        text,
        sizeMm: state.project.settings.textMm,
        layerId: noteLayerId(),
      });
      commit(['notes:changed']);
      return true;
    },
    onClose: () => setTool('select'),
  });
}

export function editText(nt) {
  const input = el('input', { type: 'text', value: nt.text, style: 'width:100%' });
  openModal({
    title: '文字を編集',
    body: el('div', {}, [input]),
    onOk: () => {
      nt.text = input.value;
      commit(['notes:changed']);
    },
  });
}

async function runMeasureTool() {
  measureGroup.destroyChildren();
  const pts = await pickPoints(2, {
    hint: (i) => (i === 0 ? '距離をはかる<b>1点目</b>をクリック（Escで終了）' : '<b>2点目</b>をクリック'),
  });
  if (!pts) { setTool('select'); return; }
  const [a, b] = pts;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  measureGroup.add(new Konva.Line({
    points: [a.x, a.y, b.x, b.y], stroke: '#dc2626', strokeWidth: 1.5,
    dash: [10, 6], strokeScaleEnabled: false, listening: false,
  }));
  measureGroup.add(lengthTag(a, b));
  overlayLayer.batchDraw();
  toast(`${fmtLen(len)}（X ${fmtMm(Math.abs(b.x - a.x))} / Y ${fmtMm(Math.abs(b.y - a.y))}）`);
  // 続けて測れるようにツールは戻さない
  runMeasureTool();
}

export function clearMeasure() {
  measureGroup?.destroyChildren();
  overlayLayer.batchDraw();
}

/* ── 初期化 ─────────────────────────────────────────── */

export function initAnnot() {
  notesGroup = new Konva.Group({ name: 'notes' });
  mainLayer.add(notesGroup);
  pickGroup = new Konva.Group({ listening: false });
  measureGroup = new Konva.Group({ listening: false });
  overlayLayer.add(measureGroup, pickGroup);

  stage.on('click', (e) => { if (picking && e.evt.button === 0) onPickClick(); });
  stage.on('mousemove', onPickMove);

  bus.on('project:loaded', syncNotes);
  bus.on('notes:changed', syncNotes);
  bus.on('items:changed', syncNotes);
  bus.on('selection:changed', syncNotes);
  bus.on('layers:changed', syncNotes);
  bus.on('plan:changed', syncNotes);

  bus.on('tool:changed', (tool) => {
    cancelPicking();
    if (tool !== 'measure') clearMeasure();
    if (tool === 'dim') runDimTool();
    if (tool === 'text') runTextTool();
    if (tool === 'measure') runMeasureTool();
    noteNodes.forEach((g, id) => {
      const nt = notes().find((n) => n.id === id);
      if (nt?.type === 'text') g.draggable(tool === 'select');
    });
  });
}

export function isPicking() { return !!picking; }
