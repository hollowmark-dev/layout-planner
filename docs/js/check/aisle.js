/**
 * 通路幅チェック。
 *
 * 素直に「全組み合わせの隙間が基準未満なら警告」にすると、オフィスの島型配置では
 * 使いものにならない。机は突き合わせ（隙間0mm）、椅子は机の下に差し込む（重なり）が
 * 普通なので、意図した配置が何百件も並んでしまう。そこで:
 *
 *   - 隙間0mm（接している）は通路ではないので警告しない
 *   - 椅子がからむ重なりは「机の下に入れている」とみなして無視する（設定で切替）
 *   - 接している什器どうしを1つの「島」とみなし、島と島の隙間だけを見る。
 *     同じ島の中の組み合わせは報告しない
 *   - めり込み（数十mm以上の重なり）は置き間違いなので別枠で全部出す
 *
 * 什器はせいぜい数百点なので総当たりで足りる。
 */

import { state, bus, items, layerById, setSelection } from '../state.js';
import {
  corners, itemAabb, polyDist, penetration, closestPoints, fmtMm,
} from '../geom.js';
import { overlayLayer, centerOn, screenToMm } from '../canvas/stage.js';
import { $, el, toast } from '../ui/dom.js';

/** これ以下の隙間は「接している」とみなす */
const CONTACT_MM = 1;
/** これを超えて食い込んでいたら置き間違い */
const OVERLAP_MM = 30;

let markerGroup = null;

function targets() {
  return items().filter((it) => {
    const l = layerById(it.layerId);
    return !l || l.visible;
  });
}

const isChair = (it) => it.shape === 'chair' || it.shape === 'sofa';

/* ── 島（接している什器のかたまり） ─────────────────── */

function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  };
  return { find, union: (a, b) => { parent[find(a)] = find(b); } };
}

/* ── 判定 ───────────────────────────────────────────── */

export function runCheck() {
  const st = state.project.settings;
  const min = Number(st.aisleMinMm) || 0;
  const ignoreChairs = st.ignoreChairOverlap !== false;

  const list = targets();
  const nodes = list.map((it) => ({ it, poly: corners(it), box: itemAabb(it) }));
  const uf = makeUnionFind(nodes.length);
  const overlaps = [];
  const gaps = [];

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      // 外接矩形で明らかに離れているものは飛ばす
      const gapX = Math.max(a.box.minX - b.box.maxX, b.box.minX - a.box.maxX);
      const gapY = Math.max(a.box.minY - b.box.maxY, b.box.minY - a.box.maxY);
      if (gapX > min || gapY > min) continue;

      const pen = penetration(a.poly, b.poly);
      if (pen > 0) {
        // 椅子は机の下に差し込むので重なりを見逃すが、壁や柱にめり込んでいるのは置き間違い
        const chairPair = (isChair(a.it) && b.it.kind !== 'obstacle')
          || (isChair(b.it) && a.it.kind !== 'obstacle');
        if (pen > OVERLAP_MM && !(ignoreChairs && chairPair)) {
          overlaps.push({ a: a.it, b: b.it, d: 0, overlap: true, pen, ...contactPoints(a, b) });
        }
        uf.union(i, j); // 接している／差し込んでいるものは同じ島
        continue;
      }

      const gap = polyDist(a.poly, b.poly);
      if (gap <= CONTACT_MM) {
        uf.union(i, j);
        continue;
      }
      if (gap < min) gaps.push({ i, j, a: a.it, b: b.it, d: gap, nodes: [a, b] });
    }
  }

  // 島どうしの隙間だけを残し、同じ島の組は捨てる。
  // さらに島の組み合わせごとに一番狭い1件にまとめる（全部出すと読めない）
  const worst = new Map();
  for (const g of gaps) {
    const ra = uf.find(g.i);
    const rb = uf.find(g.j);
    if (ra === rb) continue;
    const key = ra < rb ? `${ra}-${rb}` : `${rb}-${ra}`;
    const cur = worst.get(key);
    if (!cur || g.d < cur.d) worst.set(key, g);
  }

  const hits = [
    ...overlaps,
    ...[...worst.values()].map((g) => ({
      a: g.a, b: g.b, d: g.d, overlap: false, ...contactPoints(g.nodes[0], g.nodes[1]),
    })),
  ].sort((x, y) => (x.overlap === y.overlap ? x.d - y.d : (x.overlap ? -1 : 1)));

  state.checkHits = hits;
  state.checkCounts = { islands: countIslands(uf, nodes.length), pairs: gaps.length };
  bus.emit('check:changed');
  return hits;
}

function contactPoints(a, b) {
  const cp = closestPoints(a.poly, b.poly);
  return { p: cp.p, q: cp.q };
}

function countIslands(uf, n) {
  const roots = new Set();
  for (let i = 0; i < n; i += 1) roots.add(uf.find(i));
  return roots.size;
}

/* ── 表示 ───────────────────────────────────────────── */

function drawMarkers() {
  markerGroup.destroyChildren();
  for (const h of state.checkHits) {
    const color = h.overlap ? '#b91c1c' : '#dc2626';
    markerGroup.add(new Konva.Line({
      points: [h.p.x, h.p.y, h.q.x, h.q.y],
      stroke: color,
      strokeWidth: 2,
      strokeScaleEnabled: false,
      listening: false,
    }));
    const mid = { x: (h.p.x + h.q.x) / 2, y: (h.p.y + h.q.y) / 2 };
    const label = new Konva.Label({ x: mid.x, y: mid.y, listening: false });
    label.add(
      new Konva.Tag({ fill: color, cornerRadius: screenToMm(3) }),
      new Konva.Text({
        text: h.overlap ? `重なり ${fmtMm(Math.round(h.pen))}` : `${fmtMm(Math.round(h.d))}`,
        fontSize: screenToMm(11),
        padding: screenToMm(3),
        fill: '#fff',
        fontFamily: 'Yu Gothic UI, Meiryo, sans-serif',
      }),
    );
    label.offsetX(label.width() / 2);
    label.offsetY(label.height() / 2);
    markerGroup.add(label);
  }
  overlayLayer.batchDraw();
}

export function clearMarkers() {
  state.checkHits = [];
  markerGroup?.destroyChildren();
  overlayLayer.batchDraw();
  bus.emit('check:changed');
}

function renderResult() {
  const root = $('#check-result');
  root.innerHTML = '';
  const hits = state.checkHits;

  if (!hits.length) {
    root.append(el('p', { class: 'muted', text: '「通路チェック」を押すと、隙間が基準未満の箇所を探します。' }));
    return;
  }

  const overlaps = hits.filter((h) => h.overlap).length;
  const narrow = hits.length - overlaps;
  root.append(el('p', {
    class: 'muted',
    text: `通路の狭い箇所 ${narrow}件${overlaps ? ` ／ 置き間違い（めり込み）${overlaps}件` : ''}。`
      + 'クリックするとその場所へ移動します。',
  }));

  for (const h of hits.slice(0, 60)) {
    const row = el('div', { class: 'hit' }, [
      el('span', { text: `${h.a.label || h.a.name} ↔ ${h.b.label || h.b.name}` }),
      el('b', { text: h.overlap ? `めり込み ${fmtMm(Math.round(h.pen))}` : `${fmtMm(Math.round(h.d))}mm` }),
    ]);
    row.addEventListener('click', () => {
      centerOn((h.p.x + h.q.x) / 2, (h.p.y + h.q.y) / 2);
      setSelection([h.a.id, h.b.id]);
    });
    root.append(row);
  }
  if (hits.length > 60) {
    root.append(el('p', { class: 'muted', text: `ほか ${hits.length - 60} 件` }));
  }
}

/* ── 初期化 ─────────────────────────────────────────── */

export function initCheck() {
  markerGroup = new Konva.Group({ listening: false });
  overlayLayer.add(markerGroup);

  $('#btn-aisle').addEventListener('click', () => {
    if (!items().length) { toast('什器がまだ置かれていません。', 'err'); return; }
    const hits = runCheck();
    if (!hits.length) {
      toast(`基準 ${fmtMm(state.project.settings.aisleMinMm)}mm を下回る箇所はありません。`);
    } else {
      toast(`${hits.length}件見つかりました。`, 'err');
    }
  });

  const input = $('#aisle-min');
  input.value = state.project.settings.aisleMinMm;
  input.addEventListener('change', () => {
    state.project.settings.aisleMinMm = Math.max(0, Number(input.value) || 0);
    if (state.checkHits.length) runCheck();
  });

  const chairChk = $('#chk-ignore-chairs');
  if (chairChk) {
    chairChk.checked = state.project.settings.ignoreChairOverlap !== false;
    chairChk.addEventListener('change', () => {
      state.project.settings.ignoreChairOverlap = chairChk.checked;
      if (state.checkHits.length) runCheck();
    });
  }

  bus.on('check:changed', () => { drawMarkers(); renderResult(); });
  // 配置が変わったら結果は古くなる。数が多いと再計算で固まるので、
  // 自動では測り直さず「測り直してください」とだけ伝える
  bus.on('items:changed', () => {
    if (!state.checkHits.length) return;
    clearMarkers();
    const root = $('#check-result');
    root.innerHTML = '';
    root.append(el('p', { class: 'muted', text: '配置が変わりました。もう一度「通路チェック」を押してください。' }));
  });
  bus.on('project:loaded', () => {
    input.value = state.project.settings.aisleMinMm;
    if (chairChk) chairChk.checked = state.project.settings.ignoreChairOverlap !== false;
    clearMarkers();
  });

  renderResult();
}
