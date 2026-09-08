/**
 * 選択中のものに対する操作。プロパティ欄のボタンとキーボードから共通で呼ぶ。
 */

import {
  state, items, notes, uid, commit, setSelection, selectedItems, selectedNotes, layerById,
} from './state.js';
import { itemAabb } from './geom.js';
import { toast } from './ui/dom.js';

const round1 = (v) => Math.round(v * 10) / 10;

function editable(el) {
  const layer = layerById(el.layerId);
  return !layer || (!layer.locked && layer.visible);
}

export function selectedAll() {
  return [...selectedItems(), ...selectedNotes()].filter(editable);
}

export function deleteSelection() {
  const ids = new Set(selectedAll().map((e) => e.id));
  if (!ids.size) return;
  const plan0 = state.project.plans.find((p) => p.id === state.project.activePlanId);
  plan0.items = plan0.items.filter((i) => !ids.has(i.id));
  plan0.notes = plan0.notes.filter((n) => !ids.has(n.id));
  state.selection.clear();
  commit(['items:changed', 'notes:changed', 'selection:changed']);
}

/** 選択している要素をまとめた外形（配列複製のピッチの既定値に使う） */
export function selectionBounds() {
  const its = selectedItems().filter(editable);
  if (!its.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const it of its) {
    const b = itemAabb(it);
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function offsetCopy(e, dx, dy) {
  const copy = { ...e, id: uid(e.type ? 'n' : 'it') };
  if (e.type === 'dim') {
    copy.x1 += dx; copy.y1 += dy; copy.x2 += dx; copy.y2 += dy;
    notes().push(copy);
  } else if (e.type === 'text') {
    copy.x += dx; copy.y += dy;
    notes().push(copy);
  } else {
    copy.x += dx; copy.y += dy;
    items().push(copy);
  }
  return copy.id;
}

/**
 * 選んだものを行×列に並べて複製する。机を何十台も置くときに、
 * 複製とドラッグを繰り返さずに済むようにするためのもの。
 */
export function arrayDuplicate({ cols, rows, pitchX, pitchY }) {
  const sel = selectedAll();
  if (!sel.length) return;
  const nc = Math.max(1, Math.round(cols));
  const nr = Math.max(1, Math.round(rows));
  if (nc * nr <= 1) return;
  if (nc * nr * sel.length > 2000) {
    toast('一度に作る数が多すぎます。2,000点以内にしてください。', 'err');
    return;
  }
  const ids = sel.map((e) => e.id);
  for (let r = 0; r < nr; r += 1) {
    for (let c = 0; c < nc; c += 1) {
      if (r === 0 && c === 0) continue;
      for (const e of sel) ids.push(offsetCopy(e, c * pitchX, r * pitchY));
    }
  }
  commit(['items:changed', 'notes:changed']);
  setSelection(ids);
  toast(`${nc} × ${nr} に複製しました（${ids.length}点）`);
}

export function duplicateSelection(offset = null) {
  const sel = selectedAll();
  if (!sel.length) return;
  // 既定は「選択している幅のぶんだけ右へ」。Ctrl+D を続けて押すと横一列になる
  const b = selectionBounds();
  const dx = offset !== null ? offset : (b ? b.w : 300);
  const dy = offset !== null ? offset : 0;
  const newIds = sel.map((e) => offsetCopy(e, dx, dy));
  commit(['items:changed', 'notes:changed']);
  setSelection(newIds);
}

export function rotateSelection(deg) {
  const sel = selectedItems().filter(editable);
  if (!sel.length) return;
  for (const it of sel) it.rot = round1((((it.rot || 0) + deg) % 360 + 360) % 360);
  commit(['items:changed']);
}

export function nudge(dx, dy) {
  const sel = selectedAll();
  if (!sel.length) return;
  for (const e of sel) {
    if (e.type === 'dim') {
      e.x1 += dx; e.y1 += dy; e.x2 += dx; e.y2 += dy;
    } else {
      e.x = round1(e.x + dx);
      e.y = round1(e.y + dy);
    }
  }
  commit(['items:changed', 'notes:changed']);
}

/** 面をそろえる */
export function alignSelection(mode) {
  const sel = selectedItems().filter(editable);
  if (sel.length < 2) { toast('2点以上選んでください。', 'err'); return; }
  const boxes = sel.map((it) => ({ it, b: itemAabb(it) }));
  const minX = Math.min(...boxes.map((x) => x.b.minX));
  const maxX = Math.max(...boxes.map((x) => x.b.maxX));
  const minY = Math.min(...boxes.map((x) => x.b.minY));
  const maxY = Math.max(...boxes.map((x) => x.b.maxY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  for (const { it, b } of boxes) {
    if (mode === 'left') it.x += minX - b.minX;
    if (mode === 'right') it.x += maxX - b.maxX;
    if (mode === 'top') it.y += minY - b.minY;
    if (mode === 'bottom') it.y += maxY - b.maxY;
    if (mode === 'centerX') it.x += cx - (b.minX + b.maxX) / 2;
    if (mode === 'centerY') it.y += cy - (b.minY + b.maxY) / 2;
    it.x = round1(it.x);
    it.y = round1(it.y);
  }
  commit(['items:changed']);
}

/** 等間隔に並べる（隙間を一定にする） */
export function distributeSelection(axis, gapMm = null) {
  const sel = selectedItems().filter(editable);
  if (sel.length < 3 && gapMm === null) { toast('3点以上選んでください。', 'err'); return; }
  const key = axis === 'x' ? 'minX' : 'minY';
  const sorted = sel.map((it) => ({ it, b: itemAabb(it) })).sort((a, b) => a.b[key] - b.b[key]);

  if (gapMm !== null) {
    // 隙間を指定値でそろえる
    let cursor = axis === 'x' ? sorted[0].b.maxX : sorted[0].b.maxY;
    for (let i = 1; i < sorted.length; i += 1) {
      const { it, b } = sorted[i];
      const target = cursor + gapMm;
      if (axis === 'x') it.x = round1(it.x + (target - b.minX));
      else it.y = round1(it.y + (target - b.minY));
      cursor = target + (axis === 'x' ? b.w : b.h);
    }
  } else {
    const first = sorted[0].b;
    const last = sorted[sorted.length - 1].b;
    const total = axis === 'x' ? last.maxX - first.minX : last.maxY - first.minY;
    const used = sorted.reduce((s, x) => s + (axis === 'x' ? x.b.w : x.b.h), 0);
    const gap = (total - used) / (sorted.length - 1);
    let cursor = axis === 'x' ? first.maxX : first.maxY;
    for (let i = 1; i < sorted.length - 1; i += 1) {
      const { it, b } = sorted[i];
      const target = cursor + gap;
      if (axis === 'x') it.x = round1(it.x + (target - b.minX));
      else it.y = round1(it.y + (target - b.minY));
      cursor = target + (axis === 'x' ? b.w : b.h);
    }
  }
  commit(['items:changed']);
}

export function setLayerForSelection(layerId) {
  const sel = selectedAll();
  if (!sel.length) return;
  for (const e of sel) e.layerId = layerId;
  commit(['items:changed', 'notes:changed']);
}

export function selectAllInPlan() {
  const ids = [
    ...items().filter(editable).map((i) => i.id),
    ...notes().filter(editable).map((n) => n.id),
  ];
  setSelection(ids);
}

/* ── クリップボード（このアプリ内だけ） ─────────────── */

let clipboard = [];

export function copySelection() {
  clipboard = selectedAll().map((e) => JSON.parse(JSON.stringify(e)));
  if (clipboard.length) toast(`${clipboard.length}点をコピーしました。`);
}

export function pasteClipboard(offset = 300) {
  if (!clipboard.length) return;
  const newIds = [];
  for (const e of clipboard) {
    const copy = { ...e, id: uid(e.type ? 'n' : 'it'), layerId: state.currentLayerId };
    if (e.type === 'dim') {
      copy.x1 += offset; copy.y1 += offset; copy.x2 += offset; copy.y2 += offset;
      notes().push(copy);
    } else if (e.type === 'text') {
      copy.x += offset; copy.y += offset;
      notes().push(copy);
    } else {
      copy.x += offset; copy.y += offset;
      items().push(copy);
    }
    newIds.push(copy.id);
  }
  commit(['items:changed', 'notes:changed']);
  setSelection(newIds);
}
