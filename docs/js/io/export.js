/**
 * 書き出し（印刷用PDF / PNG / 什器数量表CSV）。
 *
 * PDFはページ全体を一度キャンバスに描いてから1枚の画像として貼る。
 * jsPDF の標準フォントは日本語を持っていないので、図枠の文字も
 * ブラウザのキャンバスに描いてしまうのが確実で、フォント同梱も要らない。
 * 縮尺は「用紙1mm = 実寸 S mm」で計算しているので、出てきたPDFを
 * 定規で測れば図面として成立する。
 */

import { state, plan, items, notes, layerById } from '../state.js';
import { itemAabb, fmtMm } from '../geom.js';
import { bgLayer, mainLayer } from '../canvas/stage.js';
import { el, openModal, toast } from '../ui/dom.js';

const PAPERS = {
  a3l: { name: 'A3 横', w: 420, h: 297 },
  a3p: { name: 'A3 縦', w: 297, h: 420 },
  a4l: { name: 'A4 横', w: 297, h: 210 },
  a4p: { name: 'A4 縦', w: 210, h: 297 },
};
const SCALES = [20, 30, 50, 100, 150, 200, 250, 300, 500];
const MARGIN = 10;      // 用紙の余白 mm
const TITLE_H = 16;     // 図枠（タイトル欄）の高さ mm

/* ── 描画範囲 ───────────────────────────────────────── */

/**
 * 書き出す範囲を決める。
 * @param {number} marginMm  まわりに付ける余白
 * @param {boolean} itemsOnly  true なら図面全体ではなく、置いた什器のまわりだけ
 */
export function contentRegion(marginMm = 300, itemsOnly = false) {
  const d = state.project.drawing;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;

  const take = (x1, y1, x2, y2) => {
    minX = Math.min(minX, x1); minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2); maxY = Math.max(maxY, y2);
  };

  if (!itemsOnly && d.pxPerMm && d.imgW) take(0, 0, d.imgW / d.pxPerMm, d.imgH / d.pxPerMm);
  for (const it of items()) {
    const b = itemAabb(it);
    take(b.minX, b.minY, b.maxX, b.maxY);
  }
  for (const nt of notes()) {
    if (nt.type === 'dim') take(Math.min(nt.x1, nt.x2), Math.min(nt.y1, nt.y2), Math.max(nt.x1, nt.x2), Math.max(nt.y1, nt.y2));
    else take(nt.x, nt.y, nt.x + 1000, nt.y + 300);
  }
  if (!Number.isFinite(minX)) {
    return itemsOnly ? contentRegion(marginMm, false) : { x: 0, y: 0, w: 10000, h: 7000 };
  }
  return {
    x: minX - marginMm,
    y: minY - marginMm,
    w: (maxX - minX) + marginMm * 2,
    h: (maxY - minY) + marginMm * 2,
  };
}

/**
 * 指定範囲を、指定解像度でキャンバスに描く。
 * 画面の表示状態を壊さないよう、使い捨ての Stage を作って複製したレイヤーを描く。
 */
function renderRegion(region, pxPerMmOut, { grid = false } = {}) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;';
  document.body.append(holder);

  const w = Math.max(1, Math.round(region.w * pxPerMmOut));
  const h = Math.max(1, Math.round(region.h * pxPerMmOut));
  const s = new Konva.Stage({ container: holder, width: w, height: h });
  s.scale({ x: pxPerMmOut, y: pxPerMmOut });
  s.position({ x: -region.x * pxPerMmOut, y: -region.y * pxPerMmOut });

  const bg = bgLayer.clone();
  const main = mainLayer.clone();
  if (!grid) bg.find('.grid').forEach((n) => n.destroy());
  s.add(bg, main);
  s.draw();

  const canvas = s.toCanvas({ pixelRatio: 1 });
  s.destroy();
  holder.remove();
  return canvas;
}

/* ── PNG ────────────────────────────────────────────── */

export function exportPng() {
  const region = contentRegion();
  // 長辺 4000px 前後を目安に
  const pxPerMmOut = Math.min(0.6, Math.max(0.02, 4000 / Math.max(region.w, region.h)));
  const src = renderRegion(region, pxPerMmOut);

  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);

  out.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileBase()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`PNGを書き出しました（${out.width}×${out.height}px）`);
  }, 'image/png');
}

function fileBase() {
  const nm = `${state.project.name}_${plan().name}`;
  return nm.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

/* ── 印刷用PDF ──────────────────────────────────────── */

export function openPdfDialog() {
  if (!state.project.drawing.pxPerMm) {
    toast('縮尺が未設定です。先に「縮尺較正」をしてください。', 'err');
    return;
  }
  const paperSel = el('select', {}, Object.entries(PAPERS)
    .map(([k, p]) => el('option', { value: k, text: `${p.name}（${p.w}×${p.h}mm）` })));
  paperSel.value = 'a3l';

  const scaleSel = el('select', {}, [
    el('option', { value: 'auto', text: '用紙に合わせる（推奨）' }),
    ...SCALES.map((s) => el('option', { value: s, text: `1 : ${s}` })),
  ]);

  const dpiSel = el('select', {}, [
    el('option', { value: 200, text: '200 dpi（軽い）' }),
    el('option', { value: 300, text: '300 dpi（きれい）' }),
  ]);
  dpiSel.value = '300';

  const rangeSel = el('select', {}, [
    el('option', { value: 'all', text: '図面全体' }),
    el('option', { value: 'items', text: '置いた什器のまわりだけ' }),
  ]);

  const gridChk = el('input', { type: 'checkbox' });
  const info = el('p', { class: 'note' });
  const regionOf = () => contentRegion(300, rangeSel.value === 'items');

  const updateInfo = () => {
    const paper = PAPERS[paperSel.value];
    const area = drawArea(paper);
    const region = regionOf();
    const s = resolveScale(scaleSel.value, region, area);
    const usedW = region.w / s;
    const usedH = region.h / s;
    const fits = usedW <= area.w + 0.5 && usedH <= area.h + 0.5;
    info.innerHTML = `縮尺 <b>1 : ${s}</b> で出力します。`
      + `<br>図面は用紙上で ${usedW.toFixed(0)} × ${usedH.toFixed(0)} mm。`
      + `作図範囲は ${area.w.toFixed(0)} × ${area.h.toFixed(0)} mm。`
      + (fits ? '' : '<br><span style="color:var(--danger)">この縮尺では用紙に収まりません。</span>');
  };
  [paperSel, scaleSel, rangeSel].forEach((s) => s.addEventListener('change', updateInfo));
  updateInfo();

  openModal({
    title: '印刷用PDFを書き出す',
    lead: '用紙と縮尺を指定して出力します。図枠に縮尺・スケールバー・日付が入ります。',
    body: el('div', {}, [
      el('label', { class: 'field' }, ['用紙', paperSel]),
      el('label', { class: 'field' }, ['出力範囲', rangeSel]),
      el('label', { class: 'field' }, ['縮尺', scaleSel]),
      el('label', { class: 'field' }, ['解像度', dpiSel]),
      el('label', { class: 'chk', style: 'margin:6px 0' }, [gridChk, 'グリッドも印刷する']),
      info,
    ]),
    okLabel: '書き出す',
    onOk: () => {
      const built = buildPdf({
        paper: PAPERS[paperSel.value],
        scaleInput: scaleSel.value,
        dpi: Number(dpiSel.value),
        grid: gridChk.checked,
        region: regionOf(),
      });
      built.pdf.save(`${fileBase()}_1-${built.scale}.pdf`);
      toast(`PDFを書き出しました（${built.paper.name} / 1:${built.scale}）`);
    },
  });
}

function drawArea(paper) {
  return { w: paper.w - MARGIN * 2, h: paper.h - MARGIN * 2 - TITLE_H };
}

function resolveScale(input, region, area) {
  if (input !== 'auto') return Number(input);
  const need = Math.max(region.w / area.w, region.h / area.h);
  return SCALES.find((s) => s >= need) || Math.ceil(need / 100) * 100;
}

/**
 * PDFを組み立てて返す（保存はしない）。
 * 返り値の pdf.save() で保存する。分けてあるのは、寸法の検算をしたいため。
 */
export function buildPdf({ paper, scaleInput, dpi = 300, grid = false, region = contentRegion() }) {
  const area = drawArea(paper);
  const S = resolveScale(scaleInput, region, area);
  const pxPerPaperMm = dpi / 25.4;
  const pxPerRealMm = pxPerPaperMm / S;

  const W = Math.round(paper.w * pxPerPaperMm);
  const H = Math.round(paper.h * pxPerPaperMm);
  const page = document.createElement('canvas');
  page.width = W;
  page.height = H;
  const ctx = page.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // 図面
  const src = renderRegion(region, pxPerRealMm, { grid });
  const drawW = region.w / S;   // 用紙上のmm
  const drawH = region.h / S;
  const offX = (MARGIN + Math.max(0, (area.w - drawW) / 2)) * pxPerPaperMm;
  const offY = (MARGIN + Math.max(0, (area.h - drawH) / 2)) * pxPerPaperMm;
  ctx.drawImage(src, offX, offY, Math.min(drawW, area.w) * pxPerPaperMm, Math.min(drawH, area.h) * pxPerPaperMm);

  drawFrame(ctx, paper, pxPerPaperMm, S);

  const jsPDFCtor = window.jspdf.jsPDF;
  const pdf = new jsPDFCtor({
    orientation: paper.w >= paper.h ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [paper.w, paper.h],
    compress: true,
  });
  const dataUrl = page.toDataURL('image/jpeg', 0.93);
  pdf.addImage(dataUrl, 'JPEG', 0, 0, paper.w, paper.h, undefined, 'FAST');
  return { pdf, page, scale: S, paper, region, drawnMm: { w: drawW, h: drawH } };
}

export { PAPERS };

/** 図枠・タイトル欄・スケールバー。日本語を出すのでキャンバスに描く */
function drawFrame(ctx, paper, k, S) {
  const line = (x1, y1, x2, y2, w = 0.3) => {
    ctx.beginPath();
    ctx.lineWidth = Math.max(1, w * k);
    ctx.strokeStyle = '#111827';
    ctx.moveTo(x1 * k, y1 * k);
    ctx.lineTo(x2 * k, y2 * k);
    ctx.stroke();
  };
  const text = (s, x, y, size, opts = {}) => {
    ctx.fillStyle = opts.color || '#111827';
    ctx.font = `${opts.bold ? 'bold ' : ''}${size * k}px "Yu Gothic UI","Meiryo",sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = opts.align || 'left';
    ctx.fillText(s, x * k, y * k);
  };

  // 外枠
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = Math.max(1, 0.5 * k);
  ctx.strokeRect(MARGIN * k, MARGIN * k, (paper.w - MARGIN * 2) * k, (paper.h - MARGIN * 2) * k);

  // タイトル欄
  const top = paper.h - MARGIN - TITLE_H;
  line(MARGIN, top, paper.w - MARGIN, top, 0.5);

  const p = state.project;
  const cy = top + TITLE_H / 2;
  text(p.name, MARGIN + 4, cy - 3.2, 4.2, { bold: true });
  const sub = `${plan().name}　／　什器 ${items().length}点`;
  text(sub, MARGIN + 4, cy + 3.4, 3);

  const dateStr = new Date().toLocaleDateString('ja-JP');
  text(`縮尺 1:${S}`, paper.w - MARGIN - 4, cy - 3.2, 4, { align: 'right', bold: true });
  text(`作成 ${dateStr}`, paper.w - MARGIN - 4, cy + 3.4, 3, { align: 'right' });

  drawScaleBar(ctx, k, S, paper.w / 2 - 25, cy);

  // 図面が原寸ではないことの但し書き
  text('※ この図はレイアウト検討用です。施工・発注前に実測で確認してください。',
    MARGIN + 4, paper.h - MARGIN + 3.5, 2.6, { color: '#6b7280' });
}

/** スケールバー：実寸で切りのよい長さを用紙上に描く */
function drawScaleBar(ctx, k, S, x, y) {
  // 用紙上で 30〜60mm に収まる、実寸で切りのよい長さを選ぶ
  const candidates = [1000, 2000, 5000, 10000, 20000, 50000];
  const realLen = candidates.find((c) => c / S >= 30 && c / S <= 70) || candidates.find((c) => c / S >= 20) || 5000;
  const barMm = realLen / S;
  const h = 2.2;
  const segs = 4;

  for (let i = 0; i < segs; i += 1) {
    ctx.fillStyle = i % 2 ? '#ffffff' : '#111827';
    ctx.fillRect((x + (barMm / segs) * i) * k, (y - h) * k, (barMm / segs) * k, h * k);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = Math.max(1, 0.25 * k);
    ctx.strokeRect((x + (barMm / segs) * i) * k, (y - h) * k, (barMm / segs) * k, h * k);
  }
  ctx.fillStyle = '#111827';
  ctx.font = `${2.6 * k}px "Yu Gothic UI","Meiryo",sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('0', x * k, (y + 0.6) * k);
  ctx.textAlign = 'right';
  ctx.fillText(`${realLen / 1000}m`, (x + barMm) * k, (y + 0.6) * k);
}

/* ── 什器数量表（CSV） ─────────────────────────────── */

export function exportCsv() {
  const rows = [];
  const map = new Map();
  for (const it of items()) {
    const key = `${it.name}|${it.w}|${it.d}|${it.h}|${it.layerId}`;
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { it, count: 1 });
  }

  rows.push(['プロジェクト', state.project.name]);
  rows.push(['プラン', plan().name]);
  rows.push(['作成日', new Date().toLocaleDateString('ja-JP')]);
  rows.push([]);
  rows.push(['品名', '間口W(mm)', '奥行D(mm)', '高さH(mm)', '数量', '専有面積(m2)', 'レイヤー', '備考']);

  const sorted = [...map.values()].sort((a, b) => (
    a.it.layerId === b.it.layerId
      ? a.it.name.localeCompare(b.it.name, 'ja')
      : String(a.it.layerId).localeCompare(String(b.it.layerId))
  ));

  let total = 0;
  let area = 0;
  for (const { it, count } of sorted) {
    const m2 = (it.w * it.d) / 1e6 * count;
    total += count;
    area += m2;
    rows.push([
      it.name, it.w, it.d, it.h || '', count, m2.toFixed(2),
      layerById(it.layerId)?.name || '', it.label || '',
    ]);
  }
  rows.push([]);
  rows.push(['合計', '', '', '', total, area.toFixed(2), '', '']);

  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  // Excel で開いたときに文字化けしないよう BOM を付ける
  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${fileBase()}_数量表.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`数量表を書き出しました（${sorted.length}品目／${total}点）`);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
