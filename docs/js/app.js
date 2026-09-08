/**
 * 起動と全体の配線。
 *
 * 什器レイアウト検討アプリ
 * ・PDF図面を背景に、実寸（mm）で什器を並べる
 * ・処理はすべてブラウザの中で完結し、図面を外部へ送信しない
 */

import {
  state, bus, setTool, clearSelection, undo, redo, canUndo, canRedo, hasScale, items,
} from './state.js';
import { fmtMm } from './geom.js';
import {
  initStage, stage, zoomToFit, zoomBy, pointer, redrawGrid, pxPerMmScreen, isTypingTarget,
} from './canvas/stage.js';
import { initItems, syncItems } from './canvas/items.js';
import { initAnnot, syncNotes, isPicking, cancelPicking, clearMeasure } from './canvas/annot.js';
import { initPalette, consumePending, cancelPending, hasPending } from './ui/palette.js';
import { initInspector } from './ui/inspector.js';
import { initLayers } from './ui/layers.js';
import { initCheck } from './check/aisle.js';
import { openCalibrateDialog, updateScaleIndicator } from './calibrate.js';
import { loadPdfAsBackground } from './pdfload.js';
import {
  applyPdf, openProjectFile, saveProject, initAutosave, offerRestore, renameProject,
} from './io/project.js';
import { exportPng, exportCsv, openPdfDialog, buildPdf, contentRegion } from './io/export.js';
import {
  deleteSelection, duplicateSelection, rotateSelection, nudge,
  copySelection, pasteClipboard, selectAllInPlan,
} from './actions.js';
import { $, $$, el, toast, openModal, confirmModal } from './ui/dom.js';

/* ── 起動 ───────────────────────────────────────────── */

async function main() {
  initStage($('#stage'));
  initItems();
  initAnnot();
  initInspector();
  initLayers();
  initCheck();
  await initPalette();
  initAutosave();

  bindToolbar();
  bindMenus();
  bindKeys();
  bindStatusbar();
  bindStageClick();

  bus.on('history:changed', updateHistoryButtons);
  bus.on('project:loaded', () => {
    updateHistoryButtons();
    updateScaleIndicator();
    updateTitle();
  });
  bus.on('project:dirty', updateTitle);
  bus.on('project:saved', updateTitle);
  bus.on('project:renamed', updateTitle);
  bus.on('settings:changed', redrawGrid);
  bus.on('items:changed', updateCount);
  bus.on('project:loaded', updateCount);

  syncItems();
  syncNotes();
  zoomToFit();
  updateScaleIndicator();
  updateHistoryButtons();
  updateCount();
  updateTitle();

  const restored = await offerRestore();
  if (restored) {
    $('#stage-wrap').classList.toggle('has-drawing', !!state.background.image);
  }
}

/* ── ツールバー ─────────────────────────────────────── */

function bindToolbar() {
  const openPdf = () => $('#file-pdf').click();
  $('#btn-open-pdf').addEventListener('click', openPdf);
  $('#btn-open-pdf-2').addEventListener('click', openPdf);
  $('#btn-open-project').addEventListener('click', () => $('#file-project').click());

  $('#file-pdf').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await openPdfFile(file);
  });

  $('#btn-sample').addEventListener('click', async () => {
    try {
      const res = await fetch('sample/sample-plan.pdf');
      const blob = await res.blob();
      await openPdfFile(new File([blob], 'sample-plan.pdf', { type: 'application/pdf' }));
    } catch {
      toast('サンプル図面を読み込めませんでした。', 'err');
    }
  });

  $('#file-project').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (state.dirty) {
      const ok = await confirmModal('プロジェクトを開く', '保存していない変更があります。破棄して開きますか。', '破棄して開く');
      if (!ok) return;
    }
    await openProjectFile(file);
  });

  $('#btn-calibrate').addEventListener('click', openCalibrateDialog);
  $('#btn-zoom-fit').addEventListener('click', () => zoomToFit());
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-help').addEventListener('click', showHelp);

  $$('#tools button').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });
  bus.on('tool:changed', (tool) => {
    $$('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    const wrap = $('#stage-wrap');
    wrap.className = wrap.className.replace(/\btool-\S+/g, '').trim();
    if (tool !== 'select') wrap.classList.add(`tool-${tool}`);
  });

  $('#chk-snap-grid').addEventListener('change', (e) => {
    state.project.settings.snapGrid = e.target.checked;
    redrawGrid();
  });
  $('#chk-snap-edge').addEventListener('change', (e) => {
    state.project.settings.snapEdge = e.target.checked;
  });
  bus.on('project:loaded', () => {
    $('#chk-snap-grid').checked = state.project.settings.snapGrid;
    $('#chk-snap-edge').checked = state.project.settings.snapEdge;
  });
}

function bindMenus() {
  $$('.menu').forEach((m) => {
    const btn = m.querySelector('button');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains('open');
      $$('.menu').forEach((x) => x.classList.remove('open'));
      m.classList.toggle('open', !wasOpen);
    });
  });
  document.addEventListener('click', () => $$('.menu').forEach((m) => m.classList.remove('open')));

  $$('[data-save]').forEach((b) => b.addEventListener('click', () => saveProject(b.dataset.save)));
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => {
    const kind = b.dataset.export;
    if (kind === 'png') exportPng();
    if (kind === 'csv') exportCsv();
    if (kind === 'pdf') openPdfDialog();
  }));
}

async function openPdfFile(file) {
  toast('PDFを読み込んでいます…');
  const r = await loadPdfAsBackground(file);
  if (!r) return;
  const keptScale = applyPdf(r, file.name);
  if (keptScale) {
    toast('同じ大きさの図面だったので、縮尺の設定を引き継ぎました。');
  } else {
    // 縮尺が決まっていないと什器を置けないので、そのまま較正へ誘導する
    openCalibrateDialog();
  }
}

/* ── キャンバスのクリック（テンプレートのクリック配置） ── */

function bindStageClick() {
  stage.on('click', (e) => {
    if (e.evt.button !== 0) return;
    if (isPicking()) return;
    const p = pointer();
    if (consumePending(p.x, p.y)) return;
  });
}

/* ── キーボード ─────────────────────────────────────── */

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey;

    if (e.key === 'Escape') {
      if (cancelPending()) return;
      if (isPicking()) { cancelPicking(); setTool('select'); return; }
      if (state.tool !== 'select') { setTool('select'); return; }
      clearSelection();
      clearMeasure();
      return;
    }

    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
    if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
    if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
    if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAllInPlan(); return; }
    if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveProject('full');
      return;
    }
    if (ctrl) return;

    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }

    const step = e.shiftKey ? 100 : (state.project.settings.gridMm || 10);
    const moves = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (moves[e.key]) { e.preventDefault(); nudge(...moves[e.key]); return; }

    const keyTools = { v: 'select', m: 'measure', d: 'dim', t: 'text' };
    const k = e.key.toLowerCase();
    if (keyTools[k]) { setTool(keyTools[k]); return; }
    if (k === 'r') { rotateSelection(e.shiftKey ? -90 : 90); return; }
    if (k === 'f') { zoomToFit(); return; }
    if (e.key === '+' || e.key === ';' || e.key === '=') { zoomBy(1.2); return; }
    if (e.key === '-') { zoomBy(1 / 1.2); }
  });
}

/* ── ステータスバー ─────────────────────────────────── */

function bindStatusbar() {
  const coord = $('#st-coord');
  stage.on('mousemove', () => {
    if (!hasScale()) { coord.textContent = '縮尺 未設定'; return; }
    const p = pointer();
    coord.textContent = `X ${fmtMm(Math.round(p.x))} / Y ${fmtMm(Math.round(p.y))} mm`;
  });
  bus.on('view:changed', updateZoom);
  updateZoom();
}

function updateZoom() {
  // 画面上の見かけの縮尺（96dpi と仮定した概算）
  const mmPerScreenPx = 25.4 / 96;
  const s = pxPerMmScreen();
  const denom = 1 / (s * mmPerScreenPx);
  // 縮尺が決まるまでは倍率に意味がないので出さない
  $('#st-zoom').textContent = hasScale() ? `画面 約1:${Math.round(denom)}` : '—';
}

function updateCount() {
  $('#st-count').textContent = `${items().length}点`;
}

function updateHistoryButtons() {
  $('#btn-undo').disabled = !canUndo();
  $('#btn-redo').disabled = !canRedo();
}

function updateTitle() {
  document.title = `${state.dirty ? '● ' : ''}${state.project.name} — 什器レイアウト検討`;
}

/* ── ヘルプ ─────────────────────────────────────────── */

function showHelp() {
  const rows = [
    ['はじめに', 'PDFを開く → 縮尺較正 → 什器をドラッグ、の順です。縮尺が決まるまで什器は置けません。'],
    ['配置', 'パレットから図面へドラッグ。クリックしてから図面をクリックでも置けます。'],
    ['移動・回転', 'ドラッグで移動、上のハンドルで回転（15度きざみ、Shiftで自由）。'],
    ['複数選択', '何もない所からドラッグで範囲選択。Shift＋クリックで追加。'],
    ['そろえる', '複数選んで右のパネルから「面をそろえる」「等間隔にならべる」。'],
    ['拡大縮小', 'ホイール。スペース＋ドラッグ、中ボタン、右ドラッグで移動。'],
  ];
  const keys = [
    ['V / M / D / T', '選択／計測／寸法線／文字'],
    ['R', '90度回転（Shift＋Rで逆回り）'],
    ['方向キー', 'グリッド1目盛ずつ移動（Shiftで100mm）'],
    ['Ctrl+Z / Ctrl+Y', '元に戻す／やり直し'],
    ['Ctrl+C / Ctrl+V', 'コピー／貼り付け'],
    ['Ctrl+D', '複製'],
    ['Ctrl+A', 'すべて選択'],
    ['Ctrl+S', '保存'],
    ['Delete', '削除'],
    ['F', '全体表示'],
    ['Esc', '中止・選択解除'],
  ];
  const table = (data) => el('table', { class: 'help-table' },
    data.map(([a, b]) => el('tr', {}, [el('td', {}, [el('kbd', { text: a })]), el('td', { text: b })])));

  openModal({
    title: '使い方',
    hideCancel: true,
    okLabel: '閉じる',
    body: el('div', {}, [
      el('p', { class: 'note', style: 'margin-bottom:10px' },
        ['読み込んだPDFも配置データも、この端末のブラウザの中だけで処理されます。サーバーへは送信されません。']),
      el('fieldset', {}, [el('legend', { text: '操作' }), table(rows)]),
      el('fieldset', {}, [el('legend', { text: 'ショートカット' }), table(keys)]),
      el('p', { class: 'note' }, ['プロジェクト名は画面上部の名前をクリックすると変更できます。']),
    ]),
  });
}

$('.brand')?.addEventListener('click', renameProject);

/**
 * 不具合調査・動作確認用の入口。
 * ブラウザのコンソールから layoutPlanner.state などで中身を確認できる。
 */
window.layoutPlanner = {
  state, bus, buildPdf, contentRegion, exportPng, exportCsv,
};

main().catch((e) => {
  console.error(e);
  toast('起動に失敗しました。ブラウザのコンソールを確認してください。', 'err');
});
