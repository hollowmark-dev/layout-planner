/**
 * 縮尺の較正。ここが決まらないと什器の実寸が意味を持たないので、
 * 図面を読み込んだ直後に必ず1回通す。
 *
 * pxPerMm = 「図面画像の1mmあたりのピクセル数」。
 * 図面画像は 1/pxPerMm を掛けて mm 空間に置いている（canvas/stage.js）。
 */

import { state, bus, commit, plan } from './state.js';
import { fmtMm } from './geom.js';
import { pickPoints } from './canvas/annot.js';
import { refreshBackground, zoomToFit } from './canvas/stage.js';
import { el, openModal, toast, numberField } from './ui/dom.js';

/** 較正のやり直しに備えて、既存の配置を図面に追従させる */
function rescaleExisting(oldPxPerMm, newPxPerMm) {
  const ratio = (oldPxPerMm || 1) / newPxPerMm;
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-9) return;
  for (const p of state.project.plans) {
    for (const it of p.items) {
      it.x = Math.round(it.x * ratio * 10) / 10;
      it.y = Math.round(it.y * ratio * 10) / 10;
      // 寸法（w,d）は実寸なので変えない
    }
    for (const nt of p.notes) {
      if (nt.type === 'dim') {
        nt.x1 *= ratio; nt.y1 *= ratio; nt.x2 *= ratio; nt.y2 *= ratio; nt.off *= ratio;
      } else {
        nt.x *= ratio; nt.y *= ratio;
      }
    }
  }
}

function apply(newPxPerMm, how) {
  if (!Number.isFinite(newPxPerMm) || newPxPerMm <= 0) {
    toast('縮尺を計算できませんでした。入力値を確認してください。', 'err');
    return;
  }
  const d = state.project.drawing;
  rescaleExisting(d.pxPerMm, newPxPerMm);
  d.pxPerMm = newPxPerMm;
  d.calibratedBy = how;
  refreshBackground();
  commit(['items:changed', 'notes:changed', 'drawing:changed']);
  zoomToFit();
  const wMm = d.imgW / newPxPerMm;
  toast(`縮尺を設定しました（図面の横幅 ≒ ${fmtMm(Math.round(wMm))}mm）`);
}

/* ── ① 図面上の既知寸法から ────────────────────────── */

export async function calibrateByPoints() {
  const d = state.project.drawing;
  if (!state.background.image) { toast('先にPDFを読み込んでください。', 'err'); return; }

  const pts = await pickPoints(2, {
    snap: false,
    hint: (i) => (i === 0
      ? '長さが分かっている箇所の<b>1点目</b>をクリック（Escで中止）'
      : '<b>2点目</b>をクリック'),
  });
  if (!pts) return;

  // いま拾った2点は「現在のワールド座標」。画像ピクセルでの距離に戻す
  const k = d.pxPerMm || 1;           // ワールドmm → 画像px の係数
  const distPx = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) * k;
  if (distPx < 3) { toast('2点が近すぎます。もっと離れた既知寸法を使ってください。', 'err'); return; }

  const { wrap, input } = numberField('実際の長さ', 6400, 'mm', { min: 1, step: 10 });
  openModal({
    title: '実際の長さを入力',
    lead: '通り芯間隔や、図面に書かれている寸法を入れてください。<br>ここで入れた値がこの図面の基準になります。',
    body: el('div', {}, [wrap]),
    okLabel: '設定する',
    onOk: () => {
      const mm = Number(input.value);
      if (!(mm > 0)) { toast('0より大きい値を入れてください。', 'err'); return false; }
      apply(distPx / mm, 'points');
      return true;
    },
  });
}

/* ── ② 図面の縮尺から ──────────────────────────────── */

const PRESETS = [30, 50, 100, 150, 200, 250, 500];

export function calibrateByScale() {
  const d = state.project.drawing;
  if (!d.imgW) { toast('先にPDFを読み込んでください。', 'err'); return; }
  if (!d.pageWidthMm) { toast('この図面は用紙サイズが取れませんでした。既知寸法で較正してください。', 'err'); return; }

  const select = el('select', {},
    PRESETS.map((n) => el('option', { value: n, text: `1 : ${n}` })));
  select.value = '100';
  const { wrap: customWrap, input: customInput } = numberField('（その他）1 :', '', '', { min: 1, step: 1, placeholder: '例 300' });

  openModal({
    title: '図面の縮尺から決める',
    lead: `この図面の用紙は ${Math.round(d.pageWidthMm)} × ${Math.round(d.pageHeightMm)} mm です。`
      + '<br>印刷時に縮小されたPDFではずれることがあるので、可能なら既知寸法での較正をおすすめします。',
    body: el('div', {}, [
      el('label', { class: 'field' }, ['縮尺', select]),
      customWrap,
    ]),
    okLabel: '設定する',
    onOk: () => {
      const denom = Number(customInput.value) || Number(select.value);
      if (!(denom > 0)) return false;
      const realWidthMm = d.pageWidthMm * denom;
      apply(d.imgW / realWidthMm, 'scale');
      return true;
    },
  });
}

/* ── 入口 ───────────────────────────────────────────── */

export function openCalibrateDialog() {
  const d = state.project.drawing;
  if (!state.background.image) { toast('先にPDFを読み込んでください。', 'err'); return; }

  const current = d.pxPerMm
    ? `現在：図面の横幅 ≒ ${fmtMm(Math.round(d.imgW / d.pxPerMm))}mm`
    : '現在：未設定';

  const btnPoints = el('button', { class: 'primary', style: 'width:100%;height:34px;border:0;border-radius:6px' },
    ['図面上の2点を指定する']);
  const btnScale = el('button', { style: 'width:100%;height:32px;border:1px solid var(--line);border-radius:6px;background:#fff' },
    ['縮尺（1:100 など）から決める']);

  const usedItems = state.project.plans.reduce((n, p) => n + p.items.length, 0);
  const warn = (d.pxPerMm && usedItems)
    ? el('p', { class: 'note', style: 'color:var(--warn)' },
      [`※ すでに ${usedItems} 点の什器が置かれています。縮尺を変えると、配置は図面に合わせて移動しますが寸法は変わりません。`])
    : null;

  const modal = openModal({
    title: '縮尺の較正',
    lead: current,
    hideCancel: false,
    okLabel: '閉じる',
    body: el('div', {}, [
      el('fieldset', {}, [
        el('legend', { text: 'おすすめ' }),
        el('p', { class: 'note' }, ['図面に書かれている寸法（通り芯間隔など）を2点クリックし、その実寸を入力します。印刷や縮小の影響を受けないので確実です。'
          + 'クリックの精度がそのまま縮尺の精度になるので、ホイールで拡大してから、なるべく離れた2点を取ってください。']),
        btnPoints,
      ]),
      el('fieldset', {}, [
        el('legend', { text: '記載寸法が読めないとき' }),
        el('p', { class: 'note' }, ['PDFの用紙サイズと縮尺から計算します。原寸で出力されたPDFであれば合います。']),
        btnScale,
      ]),
      warn,
    ]),
  });

  btnPoints.addEventListener('click', () => { modal.close(); calibrateByPoints(); });
  btnScale.addEventListener('click', () => { modal.close(); calibrateByScale(); });
}

/* ── 表示 ───────────────────────────────────────────── */

export function updateScaleIndicator() {
  const pill = document.getElementById('scale-indicator');
  const d = state.project.drawing;
  if (!d.pxPerMm) {
    pill.textContent = '縮尺 未設定';
    pill.className = 'pill pill-warn';
  } else {
    const widthM = d.imgW / d.pxPerMm / 1000;
    pill.textContent = `縮尺 設定済（図面幅 ${widthM.toFixed(1)}m）`;
    pill.className = 'pill pill-ok';
  }
}

bus.on('drawing:changed', updateScaleIndicator);
bus.on('project:loaded', updateScaleIndicator);
