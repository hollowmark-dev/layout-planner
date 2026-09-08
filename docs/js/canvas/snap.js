/**
 * 移動中の吸着（スナップ）と整列ガイド。
 *
 * 2種類ある:
 *   グリッド吸着 … 設定した間隔（既定100mm）の格子に合わせる
 *   辺の吸着     … 他の什器の辺・中心に合わせる（並べたときに面がそろう）
 * どちらも「画面上で8px以内なら吸い付く」という判定にしている。
 * mm でしきい値を決めると、引きで見ているときに効きすぎて操作しづらいため。
 */

import { state } from '../state.js';
import { itemAabb, snapTo } from '../geom.js';

import { screenToMm } from './stage.js';

const THRESHOLD_PX = 8;

/** グリッドは図面の左上ではなく、指定した原点（通り芯など）を基準にする */
function gridSnap(v, step) {
  const org = state.project.settings.gridOrigin || { x: 0, y: 0 };
  return snapTo(v - org.x, step) + org.x;
}
function gridSnapY(v, step) {
  const org = state.project.settings.gridOrigin || { x: 0, y: 0 };
  return snapTo(v - org.y, step) + org.y;
}

/**
 * @param {object} moving  動かしている什器（x,y は移動後の候補値）
 * @param {Array}  others  他の什器
 * @returns {{x:number, y:number, guides:Array}}
 */
export function snapPosition(moving, others) {
  const st = state.project.settings;
  const tol = screenToMm(THRESHOLD_PX);
  const box = itemAabb(moving);
  const guides = [];

  let dx = null;
  let dy = null;

  // ── 他の什器の辺・中心に合わせる
  if (st.snapEdge) {
    const xLines = [];
    const yLines = [];
    for (const o of others) {
      const b = itemAabb(o);
      xLines.push({ v: b.minX, b }, { v: (b.minX + b.maxX) / 2, b }, { v: b.maxX, b });
      yLines.push({ v: b.minY, b }, { v: (b.minY + b.maxY) / 2, b }, { v: b.maxY, b });
    }
    const myX = [box.minX, (box.minX + box.maxX) / 2, box.maxX];
    const myY = [box.minY, (box.minY + box.maxY) / 2, box.maxY];

    let bestX = { d: tol, delta: null, line: null };
    for (const mine of myX) {
      for (const l of xLines) {
        const d = Math.abs(l.v - mine);
        if (d < bestX.d) bestX = { d, delta: l.v - mine, line: l };
      }
    }
    let bestY = { d: tol, delta: null, line: null };
    for (const mine of myY) {
      for (const l of yLines) {
        const d = Math.abs(l.v - mine);
        if (d < bestY.d) bestY = { d, delta: l.v - mine, line: l };
      }
    }
    if (bestX.delta !== null) {
      dx = bestX.delta;
      const b = bestX.line.b;
      guides.push({
        o: 'v',
        pos: bestX.line.v,
        from: Math.min(b.minY, box.minY + dx * 0),
        to: Math.max(b.maxY, box.maxY),
      });
    }
    if (bestY.delta !== null) {
      dy = bestY.delta;
      const b = bestY.line.b;
      guides.push({
        o: 'h',
        pos: bestY.line.v,
        from: Math.min(b.minX, box.minX),
        to: Math.max(b.maxX, box.maxX),
      });
    }
  }

  // ── グリッドに合わせる（辺の吸着が効かなかった軸だけ）
  if (st.snapGrid && st.gridMm) {
    if (dx === null) {
      const cands = [box.minX, box.maxX, (box.minX + box.maxX) / 2];
      let best = { d: tol, delta: null };
      for (const c of cands) {
        const t = gridSnap(c, st.gridMm);
        const d = Math.abs(t - c);
        if (d < best.d) best = { d, delta: t - c };
      }
      if (best.delta !== null) dx = best.delta;
    }
    if (dy === null) {
      const cands = [box.minY, box.maxY, (box.minY + box.maxY) / 2];
      let best = { d: tol, delta: null };
      for (const c of cands) {
        const t = gridSnapY(c, st.gridMm);
        const d = Math.abs(t - c);
        if (d < best.d) best = { d, delta: t - c };
      }
      if (best.delta !== null) dy = best.delta;
    }
  }

  return { x: moving.x + (dx || 0), y: moving.y + (dy || 0), guides };
}

/** 単独の点（寸法線の端点など）をグリッドに合わせる */
export function snapPoint(p) {
  const st = state.project.settings;
  if (!st.snapGrid || !st.gridMm) return p;
  const tol = screenToMm(THRESHOLD_PX);
  const sx = gridSnap(p.x, st.gridMm);
  const sy = gridSnapY(p.y, st.gridMm);
  return {
    x: Math.abs(sx - p.x) < tol ? sx : p.x,
    y: Math.abs(sy - p.y) < tol ? sy : p.y,
  };
}

/** 什器の角・辺の中点に吸着する（寸法線を什器に合わせて引くとき） */
export function snapToItems(p, items) {
  const tol = screenToMm(10);
  let best = { d: tol, p: null };
  for (const it of items) {
    const b = itemAabb(it);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const cands = [
      { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY },
      { x: cx, y: b.minY }, { x: cx, y: b.maxY },
      { x: b.minX, y: cy }, { x: b.maxX, y: cy },
    ];
    for (const c of cands) {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < best.d) best = { d, p: c };
    }
  }
  return best.p || snapPoint(p);
}
