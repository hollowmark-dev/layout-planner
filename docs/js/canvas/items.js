/**
 * 什器の描画・選択・移動・変形。
 *
 * Konva のノードは mm 座標のまま置く。ノードの原点は什器の中心なので、
 * 回転はそのまま中心まわりの回転になる。
 * 状態（state）を正、Konva を写しとして扱い、ドラッグ中だけノードを先に動かして
 * 離した時点で状態へ書き戻す（そのタイミングで1手として履歴に積む）。
 */

import {
  state, bus, plan, items, layerById, commit, setSelection, toggleSelection, clearSelection,
} from '../state.js';
import { itemAabb, corners } from '../geom.js';
import {
  stage, mainLayer, overlayLayer, bgLayer, pxPerMmScreen, screenToMm, pointer,
  isSpaceDown,
} from './stage.js';
import { snapPosition } from './snap.js';

const nodes = new Map();     // item.id -> Konva.Group
let transformer = null;
let guideGroup = null;
let bandRect = null;
let ghostGroup = null;

/* ── 見た目 ─────────────────────────────────────────── */

const SHAPE_BUILDERS = {
  rect: (it) => [new Konva.Rect({
    x: -it.w / 2, y: -it.d / 2, width: it.w, height: it.d, name: 'body',
  })],

  ellipse: (it) => [new Konva.Ellipse({
    radiusX: it.w / 2, radiusY: it.d / 2, name: 'body',
  })],

  // L字デスク：上辺いっぱいの天板と、左へ伸びるサイド
  l: (it) => {
    const w = it.w; const d = it.d;
    const dr = d * 0.45; const wm = w * 0.55;
    return [new Konva.Line({
      points: [
        -w / 2, -d / 2, w / 2, -d / 2, w / 2, -d / 2 + dr,
        -w / 2 + wm, -d / 2 + dr, -w / 2 + wm, d / 2, -w / 2, d / 2,
      ],
      closed: true,
      name: 'body',
    })];
  },

  // 椅子：座面と背もたれ（背は -y 側 ＝ 什器の「後ろ」）
  chair: (it) => {
    const back = Math.max(it.d * 0.16, 30);
    return [
      new Konva.Rect({
        x: -it.w / 2, y: -it.d / 2 + back, width: it.w, height: it.d - back,
        cornerRadius: Math.min(it.w, it.d) * 0.14, name: 'body',
      }),
      new Konva.Rect({
        x: -it.w / 2, y: -it.d / 2, width: it.w, height: back,
        cornerRadius: back / 3, name: 'accent',
      }),
    ];
  },

  // ソファ：座面＋背＋肘
  sofa: (it) => {
    const back = Math.max(it.d * 0.22, 80);
    const arm = Math.max(it.w * 0.09, 70);
    return [
      new Konva.Rect({
        x: -it.w / 2, y: -it.d / 2, width: it.w, height: it.d,
        cornerRadius: 30, name: 'body',
      }),
      new Konva.Rect({ x: -it.w / 2, y: -it.d / 2, width: it.w, height: back, name: 'accent' }),
      new Konva.Rect({ x: -it.w / 2, y: -it.d / 2, width: arm, height: it.d, name: 'accent' }),
      new Konva.Rect({ x: it.w / 2 - arm, y: -it.d / 2, width: arm, height: it.d, name: 'accent' }),
    ];
  },

  // ボート型テーブル
  boat: (it) => [new Konva.Line({
    points: [
      -it.w / 2, 0, -it.w / 4, -it.d / 2, it.w / 4, -it.d / 2,
      it.w / 2, 0, it.w / 4, it.d / 2, -it.w / 4, it.d / 2,
    ],
    closed: true,
    tension: 0.35,
    name: 'body',
  })],
};

function shapeFor(it) {
  const build = SHAPE_BUILDERS[it.shape] || SHAPE_BUILDERS.rect;
  return build(it);
}

function colorOf(it) {
  const st = state.project.settings;
  if (st.colorByLayer) return layerById(it.layerId)?.color || it.color || '#93c5fd';
  return it.color || '#93c5fd';
}

/** 塗りは薄く、輪郭ははっきり。図面が透けて見えるのが大事 */
function paint(node, it, selected) {
  const base = colorOf(it);
  const body = node.findOne('.body');
  const accents = node.find('.accent');
  if (body) {
    body.fill(withAlpha(base, 0.42));
    body.stroke(selected ? '#1d4ed8' : shade(base, -0.35));
    body.strokeWidth(selected ? 2.2 : 1.2);
    body.strokeScaleEnabled(false);
  }
  accents.forEach((a) => {
    a.fill(withAlpha(base, 0.75));
    a.stroke(shade(base, -0.35));
    a.strokeWidth(1);
    a.strokeScaleEnabled(false);
  });
  const label = node.findOne('.label');
  if (label) label.fill(shade(base, -0.62));
}

function withAlpha(hex, a) {
  const { r, g, b } = hex2rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function shade(hex, amt) {
  const { r, g, b } = hex2rgb(hex);
  const f = (v) => Math.round(Math.min(255, Math.max(0, amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
function hex2rgb(hex) {
  let h = String(hex || '#93c5fd').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* ── ノードの生成と更新 ─────────────────────────────── */

function buildNode(it) {
  const g = new Konva.Group({
    x: it.x, y: it.y, rotation: it.rot || 0, name: 'item', id: it.id, draggable: true,
  });
  rebuildChildren(g, it);
  bindNodeEvents(g);
  return g;
}

function rebuildChildren(g, it) {
  g.destroyChildren();
  shapeFor(it).forEach((s) => g.add(s));
  const text = it.label || it.name;
  const size = Math.max(90, Math.min(it.d * 0.26, 220));
  g.add(new Konva.Text({
    name: 'label',
    text,
    fontSize: size,
    fontFamily: 'Yu Gothic UI, Meiryo, sans-serif',
    align: 'center',
    verticalAlign: 'middle',
    width: it.w * 0.94,
    height: it.d,
    x: -it.w * 0.47,
    y: -it.d / 2,
    listening: false,
    wrap: 'char',
    ellipsis: true,
  }));
  paint(g, it, state.selection.has(it.id));
  updateLabelVisibility(g, it);
}

function updateNode(g, it) {
  g.position({ x: it.x, y: it.y });
  g.rotation(it.rot || 0);
  const layer = layerById(it.layerId);
  const visible = layer ? layer.visible : true;
  const locked = layer ? layer.locked : false;
  g.visible(visible);
  g.listening(visible && !locked);
  g.draggable(visible && !locked && state.tool === 'select');
  rebuildChildren(g, it);
}

function updateLabelVisibility(g, it) {
  const label = g.findOne('.label');
  if (!label) return;
  // 画面上で 7px 未満になる文字は読めないので消す（引きで見たとき図が汚れる）
  label.visible(label.fontSize() * pxPerMmScreen() >= 7);
}

/* ── 同期 ───────────────────────────────────────────── */

export function syncItems() {
  const list = items();
  const seen = new Set();
  for (const it of list) {
    seen.add(it.id);
    let g = nodes.get(it.id);
    if (!g) {
      g = buildNode(it);
      nodes.set(it.id, g);
      mainLayer.add(g);
    }
    updateNode(g, it);
  }
  for (const [id, g] of nodes) {
    if (!seen.has(id)) { g.destroy(); nodes.delete(id); }
  }
  syncGhost();
  refreshTransformer();
  mainLayer.batchDraw();
  bus.emit('items:rendered');
}

/** 他プランを薄く重ねて表示する（A案とB案のずれを見る用） */
function syncGhost() {
  ghostGroup.destroyChildren();
  if (!state.project.settings.showGhost) { bgLayer.batchDraw(); return; }
  const cur = plan();
  for (const p of state.project.plans) {
    if (p.id === cur.id) continue;
    for (const it of p.items) {
      const g = new Konva.Group({ x: it.x, y: it.y, rotation: it.rot || 0, opacity: 0.3 });
      shapeFor(it).forEach((s) => {
        s.fill('rgba(107,114,128,.25)');
        s.stroke('#6b7280');
        s.strokeWidth(1);
        s.dash([6, 4]);
        s.strokeScaleEnabled(false);
        g.add(s);
      });
      ghostGroup.add(g);
    }
  }
  bgLayer.batchDraw();
}

/* ── 選択 ───────────────────────────────────────────── */

function refreshTransformer() {
  const sel = [...state.selection]
    .map((id) => nodes.get(id))
    .filter((n) => n && n.isVisible() && n.listening());
  transformer.nodes(sel);
  transformer.moveToTop();
  // 複数選択のときは回転だけ許す（個別の寸法をまとめて変えると事故になる）
  transformer.resizeEnabled(sel.length === 1);
  overlayLayer.batchDraw();
}

function repaintSelection() {
  for (const [id, g] of nodes) {
    const it = items().find((i) => i.id === id);
    if (it) paint(g, it, state.selection.has(id));
  }
  refreshTransformer();
  mainLayer.batchDraw();
}

/* ── ドラッグ ───────────────────────────────────────── */

let dragCtx = null;

function bindNodeEvents(g) {
  g.on('mousedown', (e) => {
    if (state.tool !== 'select') return;
    if (e.evt.button !== 0) return;
    const id = g.id();
    if (!state.selection.has(id)) {
      toggleSelection(id, e.evt.shiftKey || e.evt.ctrlKey);
    } else if (e.evt.shiftKey || e.evt.ctrlKey) {
      toggleSelection(id, true);
    }
  });

  g.on('dragstart', () => {
    const sel = new Set(state.selection.has(g.id()) ? state.selection : [g.id()]);
    if (!state.selection.has(g.id())) setSelection([...sel]);
    dragCtx = {
      lead: g,
      start: new Map([...sel].map((id) => {
        const n = nodes.get(id);
        return [id, { x: n.x(), y: n.y() }];
      })),
    };
  });

  g.on('dragmove', () => {
    if (!dragCtx) return;
    const it = items().find((i) => i.id === g.id());
    if (!it) return;
    const others = items().filter((o) => !dragCtx.start.has(o.id));
    const snapped = snapPosition({ ...it, x: g.x(), y: g.y() }, others);
    g.position({ x: snapped.x, y: snapped.y });
    drawGuides(snapped.guides);

    const s0 = dragCtx.start.get(g.id());
    const dx = g.x() - s0.x;
    const dy = g.y() - s0.y;
    for (const [id, p] of dragCtx.start) {
      if (id === g.id()) continue;
      nodes.get(id)?.position({ x: p.x + dx, y: p.y + dy });
    }
    mainLayer.batchDraw();
    bus.emit('drag:moving');
  });

  g.on('dragend', () => {
    clearGuides();
    if (!dragCtx) return;
    let moved = false;
    for (const [id] of dragCtx.start) {
      const n = nodes.get(id);
      const it = items().find((i) => i.id === id);
      if (!n || !it) continue;
      if (it.x !== n.x() || it.y !== n.y()) moved = true;
      it.x = round1(n.x());
      it.y = round1(n.y());
    }
    dragCtx = null;
    if (moved) commit(['items:changed']);
  });
}

const round1 = (v) => Math.round(v * 10) / 10;

/* ── ガイド線 ───────────────────────────────────────── */

function drawGuides(guides) {
  guideGroup.destroyChildren();
  for (const g of guides) {
    const pts = g.o === 'v'
      ? [g.pos, g.from - 400, g.pos, g.to + 400]
      : [g.from - 400, g.pos, g.to + 400, g.pos];
    guideGroup.add(new Konva.Line({
      points: pts, stroke: '#ec4899', strokeWidth: 1, dash: [8, 5], strokeScaleEnabled: false,
    }));
  }
  overlayLayer.batchDraw();
}
function clearGuides() {
  guideGroup.destroyChildren();
  overlayLayer.batchDraw();
}

/* ── 範囲選択（ラバーバンド） ───────────────────────── */

let band = null;

function bindStageSelection() {
  stage.on('mousedown', (e) => {
    if (state.tool !== 'select' || e.evt.button !== 0) return;
    const onEmpty = e.target === stage || e.target.getLayer() === bgLayer;
    if (!onEmpty) return;
    if (isSpaceDown()) return;
    // テンプレートのクリック配置待ちのときは範囲選択を始めない
    // （範囲選択の後始末で、置いたばかりの什器の選択が外れてしまう）
    if (state.pendingTemplate) return;
    const p = pointer();
    band = { x0: p.x, y0: p.y, additive: e.evt.shiftKey || e.evt.ctrlKey };
    bandRect.setAttrs({ x: p.x, y: p.y, width: 0, height: 0, visible: true });
    overlayLayer.batchDraw();
  });

  stage.on('mousemove', () => {
    if (!band) return;
    const p = pointer();
    bandRect.setAttrs({
      x: Math.min(band.x0, p.x),
      y: Math.min(band.y0, p.y),
      width: Math.abs(p.x - band.x0),
      height: Math.abs(p.y - band.y0),
    });
    overlayLayer.batchDraw();
  });

  stage.on('mouseup', () => {
    if (!band) return;
    const r = {
      minX: bandRect.x(), minY: bandRect.y(),
      maxX: bandRect.x() + bandRect.width(), maxY: bandRect.y() + bandRect.height(),
    };
    bandRect.visible(false);
    const tiny = bandRect.width() < screenToMm(3) && bandRect.height() < screenToMm(3);
    const hit = tiny ? [] : items().filter((it) => {
      const layer = layerById(it.layerId);
      if (layer && (!layer.visible || layer.locked)) return false;
      const b = itemAabb(it);
      return b.minX < r.maxX && b.maxX > r.minX && b.minY < r.maxY && b.maxY > r.minY;
    }).map((it) => it.id);

    if (tiny) {
      if (!band.additive) clearSelection();
    } else {
      setSelection(band.additive ? [...state.selection, ...hit] : hit);
    }
    band = null;
    overlayLayer.batchDraw();
  });
}

/* ── 変形（回転・寸法変更） ─────────────────────────── */

function bindTransform() {
  transformer.on('transformend', () => {
    let changed = false;
    for (const n of transformer.nodes()) {
      const it = items().find((i) => i.id === n.id());
      if (!it) continue;
      const sx = n.scaleX(); const sy = n.scaleY();
      if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) {
        it.w = Math.max(50, Math.round(it.w * Math.abs(sx)));
        it.d = Math.max(50, Math.round(it.d * Math.abs(sy)));
      }
      it.rot = round1(((n.rotation() % 360) + 360) % 360);
      it.x = round1(n.x());
      it.y = round1(n.y());
      n.scale({ x: 1, y: 1 });
      changed = true;
    }
    if (changed) commit(['items:changed']);
  });
}

/* ── 初期化 ─────────────────────────────────────────── */

export function initItems() {
  ghostGroup = new Konva.Group({ listening: false });
  bgLayer.add(ghostGroup);

  guideGroup = new Konva.Group({ listening: false });
  bandRect = new Konva.Rect({
    fill: 'rgba(37,99,235,.12)', stroke: '#2563eb', strokeWidth: 1,
    strokeScaleEnabled: false, visible: false, listening: false,
  });
  transformer = new Konva.Transformer({
    rotationSnaps: [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165,
      180, 195, 210, 225, 240, 255, 270, 285, 300, 315, 330, 345],
    rotationSnapTolerance: 7,
    keepRatio: false,
    ignoreStroke: true,
    anchorSize: 8,
    anchorStroke: '#1d4ed8',
    anchorFill: '#fff',
    borderStroke: '#1d4ed8',
    borderStrokeWidth: 1.5,
    rotateAnchorOffset: 24,
    boundBoxFunc: (oldBox, newBox) => ((newBox.width < 4 || newBox.height < 4) ? oldBox : newBox),
  });
  overlayLayer.add(guideGroup, bandRect, transformer);

  bindStageSelection();
  bindTransform();

  bus.on('selection:changed', repaintSelection);
  bus.on('project:loaded', syncItems);
  bus.on('items:changed', syncItems);
  bus.on('plan:changed', syncItems);
  bus.on('layers:changed', syncItems);
  bus.on('view:changed', () => {
    for (const [id, g] of nodes) {
      const it = items().find((i) => i.id === id);
      if (it) updateLabelVisibility(g, it);
    }
    mainLayer.batchDraw();
  });
  bus.on('tool:changed', () => {
    for (const [id, g] of nodes) {
      const it = items().find((i) => i.id === id);
      const layer = it ? layerById(it.layerId) : null;
      g.draggable(state.tool === 'select' && !(layer && layer.locked));
    }
    transformer.visible(state.tool === 'select');
    overlayLayer.batchDraw();
  });
}
