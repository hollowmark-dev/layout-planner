/**
 * アプリ全体の状態と、変更の通知・Undo/Redo。
 *
 * 座標の約束ごと（このアプリ全体で共通）:
 *   - 保存する座標・寸法はすべて実寸ミリメートル（mm）。
 *   - 原点は図面画像の左上。x は右、y は下が正。
 *   - 什器の x,y は「什器の中心」の位置。rot は度（時計回り）。
 *   - 画面表示のときだけ view.scale（画面px / mm）を掛ける。
 *
 * 背景画像（数MBになる）は project の外に置く。Undo のスナップショットに
 * 巻き込むとメモリを食いつぶすため。保存時にだけ project へ合流させる。
 */

export const PROJECT_VERSION = 1;

let seq = 0;
export function uid(prefix = 'i') {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

/* ── 通知 ───────────────────────────────────────────── */

const handlers = new Map();

export const bus = {
  on(topic, fn) {
    if (!handlers.has(topic)) handlers.set(topic, new Set());
    handlers.get(topic).add(fn);
    return () => bus.off(topic, fn);
  },
  off(topic, fn) {
    handlers.get(topic)?.delete(fn);
  },
  emit(topic, payload) {
    handlers.get(topic)?.forEach((fn) => fn(payload));
  },
};

/* ── 初期プロジェクト ───────────────────────────────── */

export function defaultLayers() {
  return [
    { id: 'lay-furniture', name: '什器', color: '#2563eb', visible: true, locked: false },
    { id: 'lay-note', name: '注記', color: '#b45309', visible: true, locked: false },
  ];
}

export function newProject(name = '無題のレイアウト') {
  const planId = uid('p');
  return {
    version: PROJECT_VERSION,
    name,
    unit: 'mm',
    createdAt: new Date().toISOString(),
    drawing: {
      pdfName: null,
      pageIndex: 0,
      pxPerMm: null,   // 図面画像1mmあたりの画像ピクセル数。null は縮尺未設定
      imgW: 0,
      imgH: 0,
      calibratedBy: null, // 'points' | 'scale'
    },
    layers: defaultLayers(),
    plans: [{ id: planId, name: 'A案', items: [], notes: [] }],
    activePlanId: planId,
    settings: {
      gridMm: 100,
      snapGrid: true,
      snapEdge: true,
      aisleMinMm: 800,
      textMm: 200,
      showGhost: false,
    },
  };
}

/* ── 状態 ───────────────────────────────────────────── */

export const state = {
  project: newProject(),
  /** 背景（実行時のみ。保存時に project へ埋め込む） */
  background: { dataUrl: null, image: null },
  /** 選択中の要素 id（什器・注記の両方） */
  selection: new Set(),
  tool: 'select',
  currentLayerId: 'lay-furniture',
  /** パレットでクリック選択され、配置待ちのテンプレート */
  pendingTemplate: null,
  /** 通路チェックの結果 */
  checkHits: [],
  /** 保存していない変更があるか */
  dirty: false,
};

export function plan() {
  const p = state.project;
  return p.plans.find((x) => x.id === p.activePlanId) || p.plans[0];
}
export function items() {
  return plan().items;
}
export function notes() {
  return plan().notes;
}
export function layerById(id) {
  return state.project.layers.find((l) => l.id === id) || null;
}
export function findElement(id) {
  return items().find((i) => i.id === id) || notes().find((n) => n.id === id) || null;
}
export function selectedItems() {
  return items().filter((i) => state.selection.has(i.id));
}
export function selectedNotes() {
  return notes().filter((n) => state.selection.has(n.id));
}
export function hasScale() {
  return !!state.project.drawing.pxPerMm;
}

/* ── 選択 ───────────────────────────────────────────── */

export function setSelection(ids) {
  state.selection = new Set(ids);
  bus.emit('selection:changed');
}
export function toggleSelection(id, additive) {
  if (!additive) {
    state.selection = new Set([id]);
  } else if (state.selection.has(id)) {
    state.selection.delete(id);
  } else {
    state.selection.add(id);
  }
  bus.emit('selection:changed');
}
export function clearSelection() {
  if (state.selection.size === 0) return;
  state.selection.clear();
  bus.emit('selection:changed');
}

export function setTool(tool) {
  if (state.tool === tool) return;
  state.tool = tool;
  bus.emit('tool:changed', tool);
}

/* ── Undo / Redo ────────────────────────────────────── */

const LIMIT = 50;
let past = [];
let future = [];
let baseline = snapshot();

function snapshot() {
  return JSON.stringify(state.project);
}
function restore(json) {
  state.project = JSON.parse(json);
  state.selection.clear();
  bus.emit('project:loaded');
  bus.emit('history:changed');
}

/**
 * 変更を1手として確定する。什器を動かした・追加した等のあとに呼ぶ。
 * ドラッグ中は呼ばない（動かし終わったときに1回だけ）。
 */
export function commit(topics = ['items:changed']) {
  past.push(baseline);
  if (past.length > LIMIT) past.shift();
  future = [];
  baseline = snapshot();
  state.dirty = true;
  (Array.isArray(topics) ? topics : [topics]).forEach((t) => bus.emit(t));
  bus.emit('history:changed');
  bus.emit('project:dirty');
}

/** 状態は変えたが履歴に残したくないとき（表示設定など） */
export function touch(topics = []) {
  baseline = snapshot();
  state.dirty = true;
  (Array.isArray(topics) ? topics : [topics]).forEach((t) => bus.emit(t));
  bus.emit('project:dirty');
}

export function undo() {
  if (!past.length) return;
  future.push(baseline);
  const prev = past.pop();
  baseline = prev;
  restore(prev);
}
export function redo() {
  if (!future.length) return;
  past.push(baseline);
  const next = future.pop();
  baseline = next;
  restore(next);
}
export function canUndo() { return past.length > 0; }
export function canRedo() { return future.length > 0; }

/** プロジェクトを差し替える（読み込み・新規作成） */
export function loadProject(project, background = { dataUrl: null, image: null }) {
  state.project = project;
  state.background = background;
  state.selection.clear();
  state.checkHits = [];
  state.currentLayerId = project.layers[0]?.id || 'lay-furniture';
  past = [];
  future = [];
  baseline = snapshot();
  state.dirty = false;
  bus.emit('project:loaded');
  bus.emit('history:changed');
}
