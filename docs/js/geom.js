/**
 * 幾何まわりの共通処理。単位はすべて mm。
 * 什器は「回転した矩形（OBB）」として扱う。通路チェックとスナップがこれに依存する。
 */

export const rad = (deg) => (deg * Math.PI) / 180;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 什器の4隅を返す。順に 左上→右上→右下→左下（回転後） */
export function corners(item) {
  const hw = item.w / 2;
  const hd = item.d / 2;
  const c = Math.cos(rad(item.rot || 0));
  const s = Math.sin(rad(item.rot || 0));
  return [
    [-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd],
  ].map(([x, y]) => ({
    x: item.x + x * c - y * s,
    y: item.y + x * s + y * c,
  }));
}

/** 軸並行の外接矩形 */
export function aabb(pts) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function itemAabb(item) {
  return aabb(corners(item));
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 点と線分の距離 */
export function pointSegDist(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

function segIntersect(a, b, c, d) {
  const s = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const d1 = s(a, b, c); const d2 = s(a, b, d);
  const d3 = s(c, d, a); const d4 = s(c, d, b);
  return d1 !== d2 && d3 !== d4;
}

/** 線分同士の距離（交差していれば0） */
export function segSegDist(a, b, c, d) {
  if (segIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegDist(a, c, d), pointSegDist(b, c, d),
    pointSegDist(c, a, b), pointSegDist(d, a, b),
  );
}

/** 凸多角形の内部に点があるか */
export function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i]; const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * 凸多角形どうしの最短距離。重なっていれば 0。
 * 什器は最大でも数百点なので総当たりで問題ない。
 */
export function polyDist(A, B) {
  if (pointInPoly(A[0], B) || pointInPoly(B[0], A)) return 0;
  let min = Infinity;
  for (let i = 0; i < A.length; i += 1) {
    const a1 = A[i]; const a2 = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j += 1) {
      const b1 = B[j]; const b2 = B[(j + 1) % B.length];
      const d = segSegDist(a1, a2, b1, b2);
      if (d < min) min = d;
      if (min === 0) return 0;
    }
  }
  return min;
}

/** 2つの多角形の、最短距離を与える点の組（チェック結果の表示に使う） */
export function closestPoints(A, B) {
  let best = { d: Infinity, p: A[0], q: B[0] };
  for (const p of A) {
    for (let j = 0; j < B.length; j += 1) {
      const b1 = B[j]; const b2 = B[(j + 1) % B.length];
      const q = projectOnSeg(p, b1, b2);
      const d = dist(p, q);
      if (d < best.d) best = { d, p, q };
    }
  }
  for (const q of B) {
    for (let i = 0; i < A.length; i += 1) {
      const a1 = A[i]; const a2 = A[(i + 1) % A.length];
      const p = projectOnSeg(q, a1, a2);
      const d = dist(p, q);
      if (d < best.d) best = { d, p, q };
    }
  }
  return best;
}

function projectOnSeg(p, a, b) {
  const vx = b.x - a.x; const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { x: a.x, y: a.y };
  const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / len2, 0, 1);
  return { x: a.x + t * vx, y: a.y + t * vy };
}

/* ── 表示用の書式 ───────────────────────────────────── */

/** 1400 → "1,400" */
export function fmtMm(v, digits = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('ja-JP', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** mm を状況に応じて m 表記にする（2500 → "2,500mm" / 12000 → "12.00m"） */
export function fmtLen(mm) {
  if (Math.abs(mm) >= 10000) return `${(mm / 1000).toFixed(2)}m`;
  return `${fmtMm(mm)}mm`;
}

export function snapTo(v, step) {
  if (!step) return v;
  return Math.round(v / step) * step;
}
