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
import { itemAabb, corners, baseName, clamp } from '../geom.js';
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

/* ── 見た目（CAD風の線画） ────────────────────────────
 *
 * 什器1点 = Konva.Shape 1個（sceneFunc で輪郭・内部の細線をまとめて描く）＋ ラベル。
 * 線の太さは「紙の上の mm」で決め、画面では 96dpi 換算（下限つき）、
 * 書き出しでは Stage の pxPerPaperMm 属性から算出する。
 */

const PX_PER_PAPER_MM_SCREEN = 96 / 25.4;
/** 紙の上の線の太さ（mm）。JIS の細線/太線の比にならって 1 : 2 程度 */
const LW_MM = { outline: 0.25, detail: 0.13, thin: 0.09 };
/** 画面での下限（px）。これより細いとアンチエイリアスで消える */
const LW_FLOOR_PX = { outline: 1.0, detail: 0.6, thin: 0.5 };

function lineWidthPx(cls, stg) {
  const k = stg && stg.getAttr('pxPerPaperMm');
  if (k) return LW_MM[cls] * k;
  return Math.max(LW_FLOOR_PX[cls], LW_MM[cls] * PX_PER_PAPER_MM_SCREEN);
}

/* パスの部品。ctx は Konva.Context。beginPath は呼び出し側 */
const P = {
  rect: (x, y, w, h) => (c) => c.rect(x, y, w, h),
  rrect: (x, y, w, h, r0) => (c) => {
    const r = Math.min(r0, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  },
  line: (x1, y1, x2, y2) => (c) => { c.moveTo(x1, y1); c.lineTo(x2, y2); },
  poly: (pts) => (c) => {
    c.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    c.closePath();
  },
  ellipse: (cx, cy, rx, ry) => (c) => { c.moveTo(cx + rx, cy); c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); },
  arc: (cx, cy, r, a0, a1) => (c) => {
    c.moveTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
    c.arc(cx, cy, r, a0, a1);
  },
  all: (...fns) => (c) => fns.forEach((f) => f(c)),
};

const D = (cls, path, extra = {}) => ({ cls, path, ...extra });
const deskBack = (d) => Math.min(60, d * 0.1);

function deskWithPedestals(it, sides) {
  const { w, d } = it;
  const bk = deskBack(d);
  const pw = clamp(w * 0.3, 350, 450);
  const g = 20;
  const details = [D('detail', P.line(-w / 2, -d / 2 + bk, w / 2, -d / 2 + bk))];
  for (const s of sides) {
    const x = s === 'r' ? w / 2 - g - pw : -w / 2 + g;
    details.push(D('detail', P.rect(x, -d / 2 + bk, pw, d - bk - g)));
  }
  return { body: P.rect(-w / 2, -d / 2, w, d), details };
}

function lockerCount(it) {
  if (it.n) return it.n;
  const m = /(\d+)\s*人/.exec(it.name || '');
  if (m) return Number(m[1]);
  return Math.max(1, Math.round(it.w / 300));
}

/**
 * 記号の定義。ローカル座標は什器の中心が原点、+y が「前」（椅子の背は -y）。
 *   body    … 塗りと輪郭（太線）。当たり判定はこれとは別に外形矩形
 *   details … 内部の細線。lod:false 以外は小さく表示しているとき省く
 */
const SYMBOLS = {
  rect: ({ w, d }) => ({ body: P.rect(-w / 2, -d / 2, w, d), details: [] }),
  ellipse: ({ w, d }) => ({ body: P.ellipse(0, 0, w / 2, d / 2), details: [] }),

  // 平机：背側（-y）に幕板／配線ダクトの線。向きが分かる
  desk: ({ w, d }) => ({
    body: P.rect(-w / 2, -d / 2, w, d),
    details: [D('detail', P.line(-w / 2, -d / 2 + deskBack(d), w / 2, -d / 2 + deskBack(d)))],
  }),
  desk_side: (it) => deskWithPedestals(it, ['r']),
  desk_both: (it) => deskWithPedestals(it, ['l', 'r']),

  // テーブル類：天板の縁を二重線で
  table: ({ w, d }) => ({
    body: P.rect(-w / 2, -d / 2, w, d),
    details: [D('detail', P.rect(-w / 2 + 40, -d / 2 + 40, w - 80, d - 80))],
  }),
  round_table: ({ w, d }) => ({
    body: P.ellipse(0, 0, w / 2, d / 2),
    details: [D('detail', P.ellipse(0, 0, w / 2 - 40, d / 2 - 40))],
  }),

  l: ({ w, d }) => {
    const dr = d * 0.45; const wm = w * 0.55; const bk = deskBack(dr);
    return {
      body: P.poly([-w / 2, -d / 2, w / 2, -d / 2, w / 2, -d / 2 + dr,
        -w / 2 + wm, -d / 2 + dr, -w / 2 + wm, d / 2, -w / 2, d / 2]),
      details: [
        D('detail', P.line(-w / 2, -d / 2 + bk, w / 2, -d / 2 + bk)),
        D('detail', P.line(-w / 2 + bk, -d / 2 + bk, -w / 2 + bk, d / 2)),
      ],
    };
  },

  boat: ({ w, d }) => ({
    body: (c) => {
      c.moveTo(-w / 2, -d * 0.3);
      c.quadraticCurveTo(0, -d * 0.7, w / 2, -d * 0.3);
      c.lineTo(w / 2, d * 0.3);
      c.quadraticCurveTo(0, d * 0.7, -w / 2, d * 0.3);
      c.closePath();
    },
    details: [],
  }),

  // 椅子：座面＋背もたれ＋肘
  chair: ({ w, d }) => {
    const bk = Math.max(d * 0.18, 60);
    const sw = w * 0.84;
    const r = Math.min(w, d) * 0.12;
    return {
      body: P.rrect(-sw / 2, -d / 2 + bk, sw, d - bk, r),
      details: [
        D('outline', P.rrect(-sw * 0.475, -d / 2, sw * 0.95, bk * 0.6, bk * 0.3), { lod: false, fill: true }),
        D('detail', P.all(
          P.rect(-w / 2, -d / 2 + bk + d * 0.1, w * 0.08, d * 0.55),
          P.rect(w / 2 - w * 0.08, -d / 2 + bk + d * 0.1, w * 0.08, d * 0.55),
        )),
      ],
    };
  },

  // ソファ：外形＋背・肘の線＋座クッションの分割
  sofa: ({ w, d }) => {
    const back = Math.max(d * 0.22, 80);
    const arm = Math.max(w * 0.09, 70);
    const inner = w - arm * 2;
    const n = Math.max(1, Math.round(inner / 650));
    const details = [
      D('detail', P.line(-w / 2 + arm, -d / 2 + back, w / 2 - arm, -d / 2 + back)),
      D('detail', P.line(-w / 2 + arm, -d / 2, -w / 2 + arm, d / 2)),
      D('detail', P.line(w / 2 - arm, -d / 2, w / 2 - arm, d / 2)),
    ];
    for (let i = 1; i < n; i += 1) {
      const x = -w / 2 + arm + (inner * i) / n;
      details.push(D('thin', P.line(x, -d / 2 + back, x, d / 2)));
    }
    return { body: P.rrect(-w / 2, -d / 2, w, d, 40), details };
  },

  // 収納：前面の線（ラテラル・ワゴンなど閉じた箱）
  cabinet: ({ w, d }) => ({
    body: P.rect(-w / 2, -d / 2, w, d),
    details: [D('detail', P.line(-w / 2, d / 2 - 30, w / 2, d / 2 - 30))],
  }),
  // 両開き：扉の軌跡（開き勝手と必要スペースが分かる）
  cabinet_swing: ({ w, d }) => ({
    body: P.rect(-w / 2, -d / 2, w, d),
    details: [
      D('detail', P.line(-w / 2, d / 2, -w / 2, d / 2 + w / 2)),
      D('thin', P.arc(-w / 2, d / 2, w / 2, 0, Math.PI / 2)),
      D('detail', P.line(w / 2, d / 2, w / 2, d / 2 + w / 2)),
      D('thin', P.arc(w / 2, d / 2, w / 2, Math.PI / 2, Math.PI)),
    ],
  }),
  // 引違い：前後2枚の戸をずらした2本線
  cabinet_slide: ({ w, d }) => ({
    body: P.rect(-w / 2, -d / 2, w, d),
    details: [
      D('detail', P.line(-w / 2, d / 2 - 35, w * 0.04, d / 2 - 35)),
      D('detail', P.line(-w * 0.04, d / 2 - 70, w / 2, d / 2 - 70)),
    ],
  }),
  // オープン棚：背板の線＋対角線（棚の慣用表現）
  shelf_open: ({ w, d }) => ({
    body: P.rect(-w / 2, -d / 2, w, d),
    details: [
      D('detail', P.line(-w / 2, -d / 2 + 25, w / 2, -d / 2 + 25)),
      D('thin', P.line(-w / 2, d / 2, w / 2, -d / 2)),
    ],
  }),
  // ロッカー：人数分の区画
  locker: (it) => {
    const { w, d } = it;
    const n = lockerCount(it);
    const details = [];
    for (let i = 1; i < n; i += 1) {
      const x = -w / 2 + (w * i) / n;
      details.push(D('detail', P.line(x, -d / 2, x, d / 2)));
    }
    return { body: P.rect(-w / 2, -d / 2, w, d), details };
  },

  // 扉の開き（障害物）：吊元は左下、扇形が軌跡
  door: ({ w, d }) => ({
    body: (c) => {
      c.moveTo(-w / 2, d / 2);
      c.lineTo(-w / 2, d / 2 - w);
      c.arc(-w / 2, d / 2, w, -Math.PI / 2, 0);
      c.closePath();
    },
    outlineCls: 'detail',
    details: [],
  }),
};

function symbolFor(it) {
  const build = SYMBOLS[it.shape] || SYMBOLS.rect;
  return build(it);
}

function drawSymbol(c, shape) {
  const it = shape.getAttr('item');
  const sym = shape.getAttr('sym');
  const s = shape.getAttr('style');
  const stg = shape.getStage();
  const k = shape.getAbsoluteScale().x || 1;   // キャンバスpx / mm

  const outlinePx = lineWidthPx(sym.outlineCls || 'outline', stg);
  c.setAttr('lineJoin', 'miter');
  c.setAttr('lineCap', 'butt');
  c.beginPath();
  sym.body(c);
  c.setAttr('fillStyle', s.fill);
  c.fill();
  c.setAttr('strokeStyle', s.ink);
  c.setAttr('lineWidth', outlinePx / k);
  c.setLineDash(s.dash ? [8 / k, 5 / k] : []);
  c.stroke();
  c.setLineDash([]);

  // 小さく表示しているときは細部を省く（ノイズになるうえ、線が潰れる）
  const px = Math.min(it.w, it.d) * k;
  const tooSmall = px < 12 * Math.max(1, outlinePx);
  for (const dt of sym.details) {
    if (tooSmall && dt.lod !== false) continue;
    c.beginPath();
    dt.path(c);
    if (dt.fill) { c.setAttr('fillStyle', s.fill); c.fill(); }
    c.setAttr('lineWidth', lineWidthPx(dt.cls, stg) / k);
    c.setAttr('strokeStyle', s.ink);
    c.stroke();
  }
}

/** 当たり判定は外形矩形。細い線だけだと掴めない */
function hitSymbol(c, shape) {
  const it = shape.getAttr('item');
  c.beginPath();
  c.rect(-it.w / 2, -it.d / 2, it.w, it.d);
  c.fillStrokeShape(shape);
}

/**
 * 記号が什器の外形からはみ出す量（mm）。両開き書庫の扉の軌跡など。
 * 書き出し範囲の計算で、端が切れないようにするために使う。
 */
export function symbolPadMm(it) {
  if (it.shape === 'cabinet_swing') return it.w / 2;
  return 0;
}

function isZone(it) {
  return it.kind === 'zone' || String(it.templateId || '').startsWith('shape-');
}

function colorOf(it) {
  const st = state.project.settings;
  if (st.colorByLayer) return layerById(it.layerId)?.color || it.color || '#93c5fd';
  return it.color || '#93c5fd';
}

/** 線の色（ink）と塗り（fill）。塗りは白の半透明が基本で、下地の図面がうっすら透ける */
function styleOf(it, selected) {
  const st = state.project.settings;
  let ink; let fill; let dash = false;
  if (it.kind === 'obstacle') {
    ink = '#4b5563';
    fill = it.shape === 'door' ? 'rgba(156,163,175,.22)' : 'rgba(156,163,175,.6)';
  } else if (isZone(it)) {
    const base = colorOf(it);
    ink = shade(base, -0.35);
    fill = withAlpha(base, 0.28);
    dash = true;
  } else {
    ink = st.colorByLayer ? (layerById(it.layerId)?.color || '#111827') : '#111827';
    // 塗りは既定で白85%（CADの什器ブロックと同じで下地を隠す）。
    // 0 にすると完全に透過し、什器の下の図面を確かめられる
    const a = st.itemFillOpacity ?? 0.85;
    fill = st.itemTint
      ? withAlpha(mix(it.color || '#93c5fd', '#ffffff', 0.85), a)
      : `rgba(255,255,255,${a})`;
  }
  if (selected) { ink = '#1d4ed8'; fill = 'rgba(191,219,254,.8)'; }
  return { ink, fill, dash };
}

function labelInk(it) {
  if (it.kind === 'obstacle') return '#374151';
  if (isZone(it)) return shade(colorOf(it), -0.62);
  return state.project.settings.colorByLayer ? shade(layerById(it.layerId)?.color || '#111827', -0.3) : '#111827';
}

function paint(node, it, selected) {
  const body = node.findOne('.body');
  if (body) {
    const normal = styleOf(it, false);
    body.setAttr('normalStyle', normal);
    body.setAttr('style', selected ? styleOf(it, true) : normal);
  }
  const ink = labelInk(it);
  node.find('.label').forEach((t) => t.fill(ink));
  node.find('.labeldim').forEach((t) => t.fill(ink));
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
function mix(hexA, hexB, t) {
  const a = hex2rgb(hexA); const b = hex2rgb(hexB);
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `#${[m(a.r, b.r), m(a.g, b.g), m(a.b, b.b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function hex2rgb(hex) {
  let h = String(hex || '#93c5fd').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 什器本体のノード。書き出し時の複製でも attrs（item/sym/style）はそのまま写る */
function bodyNode(it) {
  return new Konva.Shape({
    name: 'body',
    // 図形は中心原点で描くので、外接矩形だけ Transformer 用に申告する
    x: -it.w / 2, y: -it.d / 2, width: it.w, height: it.d,
    offsetX: -it.w / 2, offsetY: -it.d / 2,
    item: { w: it.w, d: it.d, name: it.name, shape: it.shape, kind: it.kind, n: it.n },
    sym: symbolFor(it),
    style: styleOf(it, false),
    sceneFunc: drawSymbol,
    hitFunc: hitSymbol,
  });
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

const FONT = '"Yu Gothic UI","Meiryo",sans-serif';
const measureCtx = document.createElement('canvas').getContext('2d');

function textWidth(text, size) {
  measureCtx.font = size + 'px ' + FONT;
  return measureCtx.measureText(text).width;
}

/**
 * 名前と寸法を2行に分けて置く。
 * 枠に収まるところまで文字を小さくし、それでも入らなければ寸法の行を落とす。
 * 1行に詰め込んで折り返すと「平机 1000×」「700」のように読めなくなるため。
 */
/** 什器と一緒に回ると文字が逆さになる。90〜270度のときは文字だけ180度戻す */
function labelFlipped(it) {
  const r = ((it.rot || 0) % 360 + 360) % 360;
  return r > 90 && r < 270;
}

function labelNodes(it) {
  // 椅子に品名は付けない。CADの椅子記号に文字は入らないし、
  // 650角に省略された名前が乗るとかえって読みにくい
  if (it.shape === 'chair' && !it.label) return [];
  const main = it.label || baseName(it.name);
  const dim = it.w + '×' + it.d;
  const boxW = it.w * 0.9;
  const boxH = it.d * 0.86;
  const LH = 1.15;

  // 文字の大きさは什器の寸法だけで決める。名前の長さで変えると、
  // 同じ大きさの書庫が隣り合ったときに文字サイズがばらついて落ち着かない。
  // 幅に入りきらない名前は縮めずに省略する（縮めると読めなくなって消える）
  let size = clamp(Math.min(it.w, it.d) * 0.22, 90, 200);
  if (size * LH > boxH) size = boxH / LH;

  const dimSize = size * 0.78;
  const showDim = state.project.settings.showItemDims !== false
    && size * LH + dimSize * LH <= boxH
    && textWidth(dim, dimSize) <= boxW;

  const totalH = showDim ? size * LH + dimSize * LH : size * LH;
  let y = -totalH / 2;
  const flip = labelFlipped(it);

  const line = (name, text, fs, opacity) => {
    const node = new Konva.Text({
      name,
      text,
      fontSize: fs,
      fontFamily: FONT,
      align: 'center',
      verticalAlign: 'middle',
      width: it.w,
      height: fs * LH,
      x: 0,
      y: y + (fs * LH) / 2,
      offsetX: it.w / 2,
      offsetY: (fs * LH) / 2,
      rotation: flip ? 180 : 0,
      opacity,
      listening: false,
      wrap: 'none',
      ellipsis: true,
    });
    y += fs * LH;
    return node;
  };

  const halo = (name, text, fs, yy) => {
    const bw = Math.min(it.w, textWidth(text, fs) + fs * 0.4);
    return new Konva.Rect({
      name: 'labelbg',
      for: name,
      x: 0,
      y: yy + (fs * LH) / 2,
      width: bw,
      height: fs * LH,
      offsetX: bw / 2,
      offsetY: (fs * LH) / 2,
      rotation: flip ? 180 : 0,
      fill: 'rgba(255,255,255,.82)',
      listening: false,
    });
  };
  // 什器が180度回っていると、グループの回転で上下が入れ替わる。
  // 名前が常に上に来るよう、反転時は並べる順を先に入れ替えておく
  const rows = showDim
    ? (flip
      ? [['labeldim', dim, dimSize, 0.72], ['label', main, size, 1]]
      : [['label', main, size, 1], ['labeldim', dim, dimSize, 0.72]])
    : [['label', main, size, 1]];
  const nodes = [];
  for (const [nm, text, fs, op] of rows) {
    nodes.push(halo(nm, text, fs, y), line(nm, text, fs, op));
  }
  return nodes;
}

function rebuildChildren(g, it) {
  g.destroyChildren();
  g.add(bodyNode(it));
  labelNodes(it).forEach((n) => g.add(n));
  paint(g, it, state.selection.has(it.id));
  updateLabelVisibility(g);
}

/**
 * 見た目に関わる値をまとめたもの。これが変わっていなければ、
 * 子ノードは作り直さず位置と角度だけ直す。
 * 全部作り直すと、数百点置いたときに1操作ごとに固まる。
 */
function visualKey(it) {
  const st = state.project.settings;
  return [it.w, it.d, it.shape, it.kind, it.n, it.label, it.name,
    labelFlipped(it), st.showItemDims !== false].join('|');
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

  const key = visualKey(it);
  if (g.getAttr('vkey') !== key) {
    rebuildChildren(g, it);
    g.setAttr('vkey', key);
  } else {
    paint(g, it, state.selection.has(it.id));
    updateLabelVisibility(g);
  }
}

function updateLabelVisibility(g) {
  // 画面上で小さすぎる文字は読めないうえに図を汚すので消す。
  // 引いていくと、まず寸法の行が消え、次に名前が消える
  const s = pxPerMmScreen();
  g.find('.label').forEach((t) => t.visible(t.fontSize() * s >= 7));
  g.find('.labeldim').forEach((t) => t.visible(t.fontSize() * s >= 8));
  g.find('.labelbg').forEach((r) => r.visible(g.findOne('.' + r.getAttr('for'))?.visible() ?? false));
}

/* ── 同期 ───────────────────────────────────────────── */

/** id から什器を引く表。毎回 find で探すと点数の2乗で効いてくる */
const byId = new Map();

export function syncItems() {
  const list = items();
  const seen = new Set();
  byId.clear();
  for (const it of list) byId.set(it.id, it);
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
      const b = bodyNode(it);
      b.setAttr('style', { ink: '#6b7280', fill: 'rgba(107,114,128,.15)', dash: true });
      b.listening(false);
      g.add(b);
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
    const it = byId.get(id);
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
    const it = byId.get(g.id());
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
      const it = byId.get(id);
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

/** Shiftを押している間は角度の刻みを外す（ヘルプにそう書いてあるのに効いていなかった） */
const ROT_SNAPS = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165,
  180, 195, 210, 225, 240, 255, 270, 285, 300, 315, 330, 345];
let shiftDown = false;

function bindTransform() {
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftDown = true; });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftDown = false; });
  window.addEventListener('blur', () => { shiftDown = false; });

  const applySnaps = (evt) => {
    const free = (evt && evt.shiftKey) || shiftDown;
    transformer.rotationSnaps(free ? [] : ROT_SNAPS);
  };
  transformer.on('transformstart', (e) => applySnaps(e.evt));
  transformer.on('transform', (e) => applySnaps(e.evt));

  transformer.on('transformend', () => {
    transformer.rotationSnaps(ROT_SNAPS);
    let changed = false;
    for (const n of transformer.nodes()) {
      const it = byId.get(n.id());
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
  ghostGroup = new Konva.Group({ name: 'ghost', listening: false });
  bgLayer.add(ghostGroup);

  guideGroup = new Konva.Group({ listening: false });
  bandRect = new Konva.Rect({
    fill: 'rgba(37,99,235,.12)', stroke: '#2563eb', strokeWidth: 1,
    strokeScaleEnabled: false, visible: false, listening: false,
  });
  transformer = new Konva.Transformer({
    rotationSnaps: ROT_SNAPS,
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
    for (const [, g] of nodes) updateLabelVisibility(g);
    mainLayer.batchDraw();
  });
  bus.on('tool:changed', () => {
    for (const [id, g] of nodes) {
      const it = byId.get(id);
      const layer = it ? layerById(it.layerId) : null;
      g.draggable(state.tool === 'select' && !(layer && layer.locked));
    }
    transformer.visible(state.tool === 'select');
    overlayLayer.batchDraw();
  });
}
