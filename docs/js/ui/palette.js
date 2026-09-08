/**
 * 左の什器パレット。テンプレートの一覧・検索・ドラッグ配置・自社什器の登録。
 * 自社什器はこのブラウザの localStorage に持つ（JSONで書き出して配れる）。
 */

import {
  state, uid, items, commit, setSelection, hasScale,
} from '../state.js';
import { $, el, openModal, toast, numberField, textField, showHint, hideHint } from './dom.js';
import { baseName } from '../geom.js';
import { stage } from '../canvas/stage.js';
import { snapPosition } from '../canvas/snap.js';
import { pickPoints } from '../canvas/annot.js';

const STORE_KEY = 'layout-planner.templates.v1';
const MY_CAT = 'マイ什器';

let catalog = [];       // [{name, color, items:[...]}]
let filter = '';
let pending = null;     // クリック配置の待機中テンプレート

/* ── 読み込み ───────────────────────────────────────── */

export async function loadCatalog() {
  const res = await fetch('data/furniture.json');
  const data = await res.json();
  catalog = data.categories.map((c) => ({
    ...c,
    items: c.items.map((i) => ({ shape: 'rect', color: c.color, cat: c.name, ...i })),
  }));
  renderPalette();
}

function myTemplates() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveMyTemplates(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}

function allCategories() {
  const mine = myTemplates();
  const base = catalog;
  if (!mine.length) return base;
  return [{ name: MY_CAT, color: '#f0abfc', items: mine }, ...base];
}

/* ── 描画 ───────────────────────────────────────────── */

export function renderPalette() {
  const root = $('#palette-list');
  root.innerHTML = '';
  const q = filter.trim().toLowerCase();

  for (const cat of allCategories()) {
    const list = cat.items.filter((t) => !q || `${t.name} ${cat.name}`.toLowerCase().includes(q));
    if (!list.length) continue;

    const details = el('details', { class: 'cat', open: true }, [
      el('summary', { text: `${cat.name}（${list.length}）` }),
    ]);
    for (const t of list) {
      const swatch = el('span', {
        class: `sw${t.shape === 'ellipse' ? ' round' : ''}`,
        style: `background:${t.color || cat.color}`,
      });
      const row = el('div', {
        class: 'tpl',
        draggable: true,
        title: `${t.name}\nW${t.w} × D${t.d}${t.h ? ` × H${t.h}` : ''} mm\nドラッグして図面に置く`,
      }, [
        swatch,
        el('span', { class: 'body' }, [
          el('span', { class: 'nm', text: baseName(t.name) }),
          // W×D だけだと、高さ違い（書庫のH1050とH1752など）が見分けられない
          el('span', { class: 'dim', text: `${t.w}×${t.d}${t.h ? ` H${t.h}` : ''}` }),
        ]),
        cat.name === MY_CAT
          ? el('button', { class: 'del', title: '削除', text: '×', onClick: (e) => { e.stopPropagation(); removeMyTemplate(t.id); } })
          : null,
      ]);
      if (t.tool === 'wall') {
        row.setAttribute('draggable', 'false');
        row.addEventListener('click', () => startWallTool());
      } else {
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', JSON.stringify(t));
          e.dataTransfer.effectAllowed = 'copy';
        });
        row.addEventListener('click', () => startClickPlace(t));
      }
      details.append(row);
    }
    root.append(details);
  }

  if (!root.children.length) {
    root.append(el('p', { class: 'muted', style: 'padding:10px', text: '該当する什器がありません。' }));
  }
}

/* ── 配置 ───────────────────────────────────────────── */

function templateToItem(t, x, y) {
  return {
    id: uid('it'),
    templateId: t.id,
    name: t.name,
    label: '',
    w: t.w,
    d: t.d,
    h: t.h || 0,
    shape: t.shape || 'rect',
    color: t.color || '#93c5fd',
    // 障害物（壁・柱）は数量表と面積の集計に入れない
    kind: t.kind || 'furniture',
    x: Math.round(x),
    y: Math.round(y),
    rot: 0,
    layerId: state.currentLayerId,
  };
}

export function placeTemplate(t, x, y) {
  if (!hasScale()) {
    toast('先に「縮尺較正」で図面の縮尺を決めてください。', 'err');
    return null;
  }
  const draft = templateToItem(t, x, y);
  const snapped = snapPosition(draft, items());
  draft.x = Math.round(snapped.x);
  draft.y = Math.round(snapped.y);
  items().push(draft);
  commit(['items:changed']);
  setSelection([draft.id]);
  return draft;
}

function startClickPlace(t) {
  if (!hasScale()) {
    toast('先に「縮尺較正」で図面の縮尺を決めてください。', 'err');
    return;
  }
  pending = t;
  state.pendingTemplate = t;
  showHint(`<b>${t.name}</b> を置く位置をクリック（Escで中止）`);
}

export function consumePending(x, y) {
  if (!pending) return false;
  const t = pending;
  pending = null;
  state.pendingTemplate = null;
  hideHint();
  placeTemplate(t, x, y);
  return true;
}

export function cancelPending() {
  if (!pending) return false;
  pending = null;
  state.pendingTemplate = null;
  hideHint();
  return true;
}

export function hasPending() { return !!pending; }

/* ── 壁を引く ───────────────────────────────────────── */

/**
 * 2点をクリックして壁を1枚置く。図面の壁をなぞっておくと、
 * 「什器と壁の隙間」を通路チェックで見られるようになる。
 */
async function startWallTool() {
  if (!hasScale()) {
    toast('先に「縮尺較正」で図面の縮尺を決めてください。', 'err');
    return;
  }
  const th = state.project.settings.wallThicknessMm || 100;
  const pts = await pickPoints(2, {
    hint: (i) => (i === 0 ? '壁の<b>始点</b>をクリック（Escで中止）' : '壁の<b>終点</b>をクリック'),
  });
  if (!pts) return;
  const [a, b] = pts;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < th) { toast('短すぎます。', 'err'); return; }
  const item = {
    id: uid('it'),
    templateId: 'obs-wall',
    name: `壁 ${Math.round(len)}`,
    label: '',
    w: Math.round(len),
    d: th,
    h: 0,
    shape: 'rect',
    color: '#9ca3af',
    kind: 'obstacle',
    x: Math.round((a.x + b.x) / 2),
    y: Math.round((a.y + b.y) / 2),
    rot: Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI * 10) / 10,
    layerId: state.currentLayerId,
  };
  items().push(item);
  commit(['items:changed']);
  setSelection([item.id]);
  startWallTool(); // 続けて引けるようにする
}

/* ── 自社什器 ───────────────────────────────────────── */

function openTemplateEditor() {
  const name = textField('名称', '', { placeholder: '例：役員机 1800×900' });
  const w = numberField('間口 W', 1200, 'mm', { min: 50, step: 10 });
  const d = numberField('奥行 D', 700, 'mm', { min: 50, step: 10 });
  const h = numberField('高さ H', 700, 'mm', { min: 0, step: 10 });
  const shape = el('select', {}, [
    el('option', { value: 'rect', text: '矩形' }),
    el('option', { value: 'ellipse', text: '円・楕円' }),
    el('option', { value: 'l', text: 'L字' }),
    el('option', { value: 'chair', text: '椅子' }),
    el('option', { value: 'sofa', text: 'ソファ' }),
    el('option', { value: 'boat', text: 'ボート型' }),
  ]);
  const color = el('input', { type: 'color', value: '#93c5fd' });

  openModal({
    title: '自社什器を登録',
    lead: 'よく使う什器の寸法を登録しておくと、次からドラッグだけで置けます。<br>この端末のブラウザに保存されます（書き出して同僚に配れます）。',
    body: el('div', {}, [
      name.wrap, w.wrap, d.wrap, h.wrap,
      el('label', { class: 'field' }, ['形', shape]),
      el('label', { class: 'field' }, ['色', color]),
    ]),
    okLabel: '登録',
    onOk: () => {
      const nm = name.input.value.trim();
      if (!nm) { toast('名称を入れてください。', 'err'); return false; }
      const list = myTemplates();
      list.push({
        id: `my-${uid('t')}`,
        name: nm,
        w: Number(w.input.value) || 600,
        d: Number(d.input.value) || 600,
        h: Number(h.input.value) || 0,
        shape: shape.value,
        color: color.value,
        cat: MY_CAT,
      });
      saveMyTemplates(list);
      renderPalette();
      toast(`「${nm}」を登録しました。`);
      return true;
    },
  });
}

function removeMyTemplate(id) {
  saveMyTemplates(myTemplates().filter((t) => t.id !== id));
  renderPalette();
}

function exportMyTemplates() {
  const list = myTemplates();
  if (!list.length) { toast('登録された自社什器がありません。', 'err'); return; }
  const blob = new Blob([JSON.stringify({ version: 1, templates: list }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'my-furniture.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importMyTemplates(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.templates;
    if (!Array.isArray(incoming)) throw new Error('形式が違います');
    const cur = myTemplates();
    const ids = new Set(cur.map((t) => t.id));
    let added = 0;
    for (const t of incoming) {
      if (!t.name || !t.w || !t.d) continue;
      const id = ids.has(t.id) ? `my-${uid('t')}` : (t.id || `my-${uid('t')}`);
      cur.push({ ...t, id, cat: MY_CAT });
      ids.add(id);
      added += 1;
    }
    saveMyTemplates(cur);
    renderPalette();
    toast(`${added}件の什器を読み込みました。`);
  } catch (e) {
    toast('ファイルを読み込めませんでした。', 'err');
    console.error(e);
  }
}

/* ── 初期化 ─────────────────────────────────────────── */

export function initPalette() {
  $('#palette-search').addEventListener('input', (e) => {
    filter = e.target.value;
    renderPalette();
  });
  $('#btn-add-template').addEventListener('click', openTemplateEditor);
  $('#btn-export-templates').addEventListener('click', exportMyTemplates);
  $('#btn-import-templates').addEventListener('click', () => $('#file-templates').click());
  $('#file-templates').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importMyTemplates(f);
    e.target.value = '';
  });

  // ドラッグ＆ドロップで配置
  const wrap = $('#stage-wrap');
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    let t;
    try { t = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    if (!t || !t.w) return;
    stage.setPointersPositions(e);
    const p = stage.getRelativePointerPosition();
    placeTemplate(t, p.x, p.y);
  });

  return loadCatalog();
}
