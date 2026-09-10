/**
 * プロジェクトの保存・読み込みと自動保存。
 * ここでもファイルはブラウザの中だけで扱う。アップロードは一切しない。
 *
 * 保存は2種類:
 *   full … 図面画像を埋め込む。単体で開き直せる（既定）
 *   lite … 配置だけ。軽いのでメール添付向き。開くときにPDFを読み直す
 *
 * 自動保存は lite（画像なし）で localStorage に置く。画像まで入れると
 * すぐ容量制限に当たるため。復元時にPDFを開き直してもらう。
 */

import {
  state, bus, loadProject, newProject, commit, PROJECT_VERSION,
} from '../state.js';
import { loadImage } from '../pdfload.js';
import { refreshBackground, zoomToFit } from '../canvas/stage.js';
import { templateById } from '../ui/palette.js';
import { toast, confirmModal, openModal, openBusy, el } from '../ui/dom.js';

const AUTOSAVE_KEY = 'layout-planner.autosave.v1';

function safeName(s) {
  return (s || 'レイアウト').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

function download(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * 背景を保存用の画像データにする。
 * 読み込み直後はキャンバスのまま持っているので、ここで初めて画像化する
 * （読み込みのたびに数秒かかっていたのを、保存するときだけに移した）。
 */
export function backgroundDataUrl() {
  const bg = state.background;
  if (bg.dataUrl) return bg.dataUrl;
  const src = bg.image;
  if (!src || typeof src.toDataURL !== 'function') return null;
  // 線画はPNGのほうが線が潰れない。大きすぎるときだけJPEGに落とす
  let url = src.toDataURL('image/png');
  if (url.length > 12 * 1024 * 1024) url = src.toDataURL('image/jpeg', 0.88);
  bg.dataUrl = url;
  return url;
}

export function serialize(includeImage) {
  const p = JSON.parse(JSON.stringify(state.project));
  p.version = PROJECT_VERSION;
  p.savedAt = new Date().toISOString();
  if (includeImage) {
    const url = backgroundDataUrl();
    if (url) p.drawing.imageDataUrl = url;
  }
  return JSON.stringify(p);
}

export function saveProject(mode = 'full') {
  const busy = mode === 'full' && !state.background.dataUrl && state.background.image
    ? openBusy('保存の準備をしています', '図面を画像にしています…')
    : null;
  const json = serialize(mode === 'full');
  busy?.close();
  const mb = json.length / 1024 / 1024;
  const suffix = mode === 'full' ? '.layout.json' : '.layout-lite.json';
  download(json, safeName(state.project.name) + suffix);
  state.dirty = false;
  bus.emit('project:saved');
  toast(`保存しました（${mb.toFixed(1)}MB）`);
}

/* ── 読み込み ───────────────────────────────────────── */

export async function openProjectFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('ファイルを読み込めませんでした。', 'err');
    return;
  }
  await applyProject(data);
}

export async function applyProject(data) {
  if (!data || !Array.isArray(data.plans)) {
    toast('このファイルはレイアウトのプロジェクトではないようです。', 'err');
    return;
  }
  const imageDataUrl = data.drawing?.imageDataUrl || null;
  if (data.drawing) delete data.drawing.imageDataUrl;

  // 古い版に足りない項目を補う
  const base = newProject();
  data.settings = { ...base.settings, ...(data.settings || {}) };
  data.layers = data.layers?.length ? data.layers : base.layers;
  data.plans.forEach((p) => {
    p.items = p.items || [];
    p.notes = p.notes || [];
    // 線画表現より前に保存したものは shape を持たない（あっても rect のまま）。
    // テンプレートから引き直して、CADの記号で描けるようにする
    p.items.forEach((it) => {
      if (it.shape && it.shape !== 'rect') return;
      const t = templateById(it.templateId);
      if (!t) return;
      if (t.shape) it.shape = t.shape;
      if (t.n && !it.n) it.n = t.n;
      if (t.kind && !it.kind) it.kind = t.kind;
    });
  });
  if (!data.plans.some((p) => p.id === data.activePlanId)) data.activePlanId = data.plans[0].id;

  let background = { dataUrl: null, image: null };
  if (imageDataUrl) {
    try {
      background = { dataUrl: imageDataUrl, image: await loadImage(imageDataUrl) };
    } catch {
      toast('図面画像を復元できませんでした。PDFを開き直してください。', 'err');
    }
  }

  loadProject(data, background);
  refreshBackground();
  zoomToFit();
  document.getElementById('stage-wrap').classList.toggle('has-drawing', !!background.image);

  if (!background.image) {
    toast('配置を読み込みました。図面は含まれていないので「PDFを開く」で読み込んでください。');
  }
}

/* ── PDFを背景に設定する ───────────────────────────── */

/**
 * @param {object} r pdfload.loadPdfAsBackground の戻り値
 */
export function applyPdf(r, fileName) {
  const d = state.project.drawing;
  const sameSize = d.imgW === r.width && d.imgH === r.height;
  const keepScale = !!d.pxPerMm && sameSize;

  state.background = { dataUrl: r.dataUrl, image: r.image };
  d.pdfName = fileName;
  d.pageIndex = r.pageIndex;
  d.imgW = r.width;
  d.imgH = r.height;
  d.pageWidthMm = r.pageWidthMm;
  d.pageHeightMm = r.pageHeightMm;
  if (!keepScale) {
    d.pxPerMm = null;
    d.calibratedBy = null;
  }

  refreshBackground();
  zoomToFit();
  document.getElementById('stage-wrap').classList.add('has-drawing');
  // 履歴に積んでおかないと、読み込み直後のUndoで図面情報だけが消え、
  // 背景は前の縮尺のまま残って較正がずれる
  commit(['drawing:changed']);
  return keepScale;
}

/* ── 自動保存 ───────────────────────────────────────── */

let timer = null;

function autosave() {
  try {
    const p = JSON.parse(JSON.stringify(state.project));
    delete p.drawing.imageDataUrl;
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
      at: Date.now(),
      hasDrawing: !!state.background.image,
      project: p,
    }));
  } catch (e) {
    // 容量オーバーなどは黙って諦める（保存はユーザーの明示操作が本命）
    console.warn('自動保存に失敗しました', e);
  }
}

export function initAutosave() {
  bus.on('project:dirty', () => {
    clearTimeout(timer);
    timer = setTimeout(autosave, 1200);
  });
  window.addEventListener('beforeunload', (e) => {
    autosave();
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

export async function offerRestore() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null');
  } catch {
    return false;
  }
  if (!saved?.project) return false;
  const count = saved.project.plans?.reduce((n, p) => n + (p.items?.length || 0), 0) || 0;
  if (!count) return false;

  const when = new Date(saved.at).toLocaleString('ja-JP');
  const ok = await confirmModal(
    '前回の作業を復元しますか',
    `${when} の状態（${count}点）が残っています。`
    + '<br>※ 自動保存には図面画像は含まれません。復元後に同じPDFを開き直してください。',
    '復元する',
  );
  if (!ok) return false;
  await applyProject(saved.project);
  return true;
}

export function clearAutosave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}

/* ── 新規 ───────────────────────────────────────────── */

export async function newProjectFlow() {
  if (state.dirty) {
    const ok = await confirmModal('新規作成', '保存していない変更があります。破棄して新規作成しますか。', '破棄して新規');
    if (!ok) return;
  }
  loadProject(newProject());
  state.background = { dataUrl: null, image: null };
  refreshBackground();
  document.getElementById('stage-wrap').classList.remove('has-drawing');
}

/** プロジェクト名の変更 */
export function renameProject() {
  const input = el('input', { type: 'text', value: state.project.name, style: 'width:100%' });
  openModal({
    title: 'プロジェクト名',
    lead: '保存するファイル名と、印刷用PDFの図枠に使われます。',
    body: el('div', {}, [input]),
    onOk: () => {
      state.project.name = input.value.trim() || state.project.name;
      bus.emit('project:dirty');
      bus.emit('project:renamed');
    },
  });
}
