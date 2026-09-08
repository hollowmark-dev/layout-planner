/**
 * 通路幅チェック。什器を「回転した矩形」として扱い、全組み合わせの最短距離を測る。
 * 基準（既定800mm）を下回る組み合わせと、重なっている組み合わせを拾う。
 *
 * 什器はせいぜい数百点なので総当たりで足りる。外接矩形で粗く弾いてから
 * 多角形どうしの距離を求めているので、実用上は一瞬で終わる。
 */

import { state, bus, items, layerById, setSelection } from '../state.js';
import { corners, itemAabb, polyDist, closestPoints, fmtMm } from '../geom.js';
import { overlayLayer, centerOn, screenToMm } from '../canvas/stage.js';
import { $, el, toast } from '../ui/dom.js';

let markerGroup = null;

function targets() {
  return items().filter((it) => {
    const l = layerById(it.layerId);
    return !l || l.visible;
  });
}

export function runCheck() {
  const min = Number(state.project.settings.aisleMinMm) || 0;
  const list = targets();
  const boxes = list.map((it) => ({ it, poly: corners(it), box: itemAabb(it) }));
  const hits = [];

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]; const b = boxes[j];
      // 外接矩形で明らかに離れているものは飛ばす
      const gapX = Math.max(a.box.minX - b.box.maxX, b.box.minX - a.box.maxX);
      const gapY = Math.max(a.box.minY - b.box.maxY, b.box.minY - a.box.maxY);
      if (gapX > min || gapY > min) continue;

      const d = polyDist(a.poly, b.poly);
      if (d < min) {
        const cp = closestPoints(a.poly, b.poly);
        hits.push({
          a: a.it, b: b.it, d, overlap: d < 1, p: cp.p, q: cp.q,
        });
      }
    }
  }
  hits.sort((x, y) => x.d - y.d);
  state.checkHits = hits;
  bus.emit('check:changed');
  return hits;
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
        text: h.overlap ? '重なり' : `${fmtMm(Math.round(h.d))}`,
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
  root.append(el('p', {
    class: 'muted',
    text: `${hits.length}件（うち重なり ${overlaps}件）。クリックするとその場所へ移動します。`,
  }));

  for (const h of hits.slice(0, 60)) {
    const row = el('div', { class: 'hit' }, [
      el('span', { text: `${h.a.label || h.a.name} ↔ ${h.b.label || h.b.name}` }),
      el('b', { text: h.overlap ? '重なり' : `${fmtMm(Math.round(h.d))}mm` }),
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

  bus.on('check:changed', () => { drawMarkers(); renderResult(); });
  // 配置が変われば結果は古くなる。消して測り直しを促す
  bus.on('items:changed', () => { if (state.checkHits.length) runCheck(); });
  bus.on('project:loaded', () => {
    input.value = state.project.settings.aisleMinMm;
    clearMarkers();
  });

  renderResult();
}

/** 数量表・PDFの注記用 */
export function checkSummary() {
  const hits = state.checkHits;
  if (!hits.length) return null;
  return `通路チェック：基準 ${state.project.settings.aisleMinMm}mm 未満 ${hits.length}件`;
}
