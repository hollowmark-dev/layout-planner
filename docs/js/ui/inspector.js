/**
 * 右のプロパティ欄。選んでいるものによって中身が変わる。
 *   何も選んでいない → 図面全体の設定（グリッド・文字サイズ・色の付け方）
 *   什器1点          → 寸法・角度・位置・色・レイヤー
 *   什器を複数        → そろえる／等間隔／まとめて操作
 *   注記             → 文字や寸法値の上書き
 */

import {
  state, bus, commit, touch, selectedItems, selectedNotes,
} from '../state.js';
import { fmtMm } from '../geom.js';
import { $, el } from './dom.js';
import {
  deleteSelection, duplicateSelection, rotateSelection, alignSelection,
  distributeSelection, setLayerForSelection,
} from '../actions.js';
import { editText } from '../canvas/annot.js';

function num(label, value, unit, onChange, attrs = {}) {
  const input = el('input', { type: 'number', value, ...attrs });
  input.addEventListener('change', () => onChange(Number(input.value)));
  return el('label', { class: 'field' }, [
    label,
    el('span', { class: 'unit-input' }, [input, el('span', { text: unit })]),
  ]);
}

function layerSelect(currentId, onChange) {
  const sel = el('select', {}, state.project.layers.map((l) => el('option', { value: l.id, text: l.name })));
  sel.value = currentId || state.project.layers[0].id;
  sel.addEventListener('change', () => onChange(sel.value));
  return el('label', { class: 'field' }, ['レイヤー', sel]);
}

function buttonRow(defs) {
  return el('div', { class: 'insp-actions' },
    defs.map(({ text, onClick, cls }) => el('button', { class: cls || '', text, onClick })));
}

/* ── 何も選んでいないとき ───────────────────────────── */

function renderSettings(root) {
  const st = state.project.settings;
  root.append(
    el('p', { class: 'muted', text: '什器を選ぶと寸法や角度を編集できます。' }),
    num('グリッド間隔', st.gridMm, 'mm', (v) => {
      st.gridMm = Math.max(10, v || 100);
      touch(['settings:changed']);
    }, { min: 10, step: 10 }),
    num('注記の文字サイズ', st.textMm, 'mm', (v) => {
      st.textMm = Math.max(20, v || 200);
      touch(['settings:changed', 'notes:changed']);
    }, { min: 20, step: 10 }),
  );
  const chk = el('input', { type: 'checkbox' });
  chk.checked = !!st.colorByLayer;
  chk.addEventListener('change', () => {
    st.colorByLayer = chk.checked;
    touch(['items:changed']);
  });
  root.append(el('label', { class: 'chk', style: 'margin-top:6px' }, [chk, 'レイヤーの色で表示する']));
}

/* ── 什器1点 ────────────────────────────────────────── */

function renderItem(root, it) {
  const update = (patch, topics = ['items:changed']) => {
    Object.assign(it, patch);
    commit(topics);
  };

  const labelInput = el('input', { type: 'text', value: it.label || '', placeholder: it.name });
  labelInput.addEventListener('change', () => update({ label: labelInput.value.trim() }));

  const colorInput = el('input', { type: 'color', value: it.color || '#93c5fd' });
  colorInput.addEventListener('change', () => update({ color: colorInput.value }));

  root.append(
    el('div', { class: 'insp-title', text: it.name }),
    el('label', { class: 'field' }, ['表示名', labelInput]),
    num('間口 W', it.w, 'mm', (v) => update({ w: Math.max(50, v) }), { min: 50, step: 10 }),
    num('奥行 D', it.d, 'mm', (v) => update({ d: Math.max(50, v) }), { min: 50, step: 10 }),
    num('高さ H', it.h || 0, 'mm', (v) => update({ h: Math.max(0, v) }), { min: 0, step: 10 }),
    num('角度', it.rot || 0, '°', (v) => update({ rot: ((v % 360) + 360) % 360 }), { step: 15 }),
    num('X', Math.round(it.x), 'mm', (v) => update({ x: v }), { step: 10 }),
    num('Y', Math.round(it.y), 'mm', (v) => update({ y: v }), { step: 10 }),
    el('label', { class: 'field' }, ['色', colorInput]),
    layerSelect(it.layerId, (id) => update({ layerId: id })),
    buttonRow([
      { text: '90°回転', onClick: () => rotateSelection(90) },
      { text: '複製', onClick: () => duplicateSelection() },
      { text: '削除', cls: 'danger', onClick: deleteSelection },
    ]),
  );
}

/* ── 什器を複数 ─────────────────────────────────────── */

function renderMulti(root, sel) {
  const total = sel.reduce((s, i) => s + (i.w * i.d) / 1e6, 0);
  root.append(
    el('div', { class: 'insp-title', text: `${sel.length}点を選択中` }),
    el('p', { class: 'muted', text: `専有面積の合計 ${total.toFixed(2)} m²（外形寸法による概算）` }),
    el('p', { class: 'muted', style: 'margin-top:8px', text: '面をそろえる' }),
    buttonRow([
      { text: '左', onClick: () => alignSelection('left') },
      { text: '右', onClick: () => alignSelection('right') },
      { text: '上', onClick: () => alignSelection('top') },
      { text: '下', onClick: () => alignSelection('bottom') },
    ]),
    buttonRow([
      { text: '左右中央', onClick: () => alignSelection('centerX') },
      { text: '上下中央', onClick: () => alignSelection('centerY') },
    ]),
    el('p', { class: 'muted', style: 'margin-top:8px', text: '等間隔にならべる' }),
    buttonRow([
      { text: '横に均等', onClick: () => distributeSelection('x') },
      { text: '縦に均等', onClick: () => distributeSelection('y') },
    ]),
  );

  const gapInput = el('input', { type: 'number', value: 0, step: 50, min: 0 });
  const gapRow = el('label', { class: 'field' }, [
    '隙間をそろえる',
    el('span', { class: 'unit-input' }, [gapInput, el('span', { text: 'mm' })]),
  ]);
  root.append(gapRow, buttonRow([
    { text: '横に適用', onClick: () => distributeSelection('x', Number(gapInput.value) || 0) },
    { text: '縦に適用', onClick: () => distributeSelection('y', Number(gapInput.value) || 0) },
  ]));

  root.append(
    layerSelect(sel[0].layerId, (id) => setLayerForSelection(id)),
    buttonRow([
      { text: '90°回転', onClick: () => rotateSelection(90) },
      { text: '複製', onClick: () => duplicateSelection() },
      { text: '削除', cls: 'danger', onClick: deleteSelection },
    ]),
  );
}

/* ── 注記 ───────────────────────────────────────────── */

function renderNote(root, nt) {
  const update = (patch) => {
    Object.assign(nt, patch);
    commit(['notes:changed']);
  };

  if (nt.type === 'dim') {
    const len = Math.hypot(nt.x2 - nt.x1, nt.y2 - nt.y1);
    const overrideInput = el('input', { type: 'text', value: nt.text || '', placeholder: fmtMm(len) });
    overrideInput.addEventListener('change', () => update({ text: overrideInput.value.trim() || null }));
    root.append(
      el('div', { class: 'insp-title', text: '寸法線' }),
      el('p', { class: 'muted', text: `実測 ${fmtMm(len)} mm` }),
      el('label', { class: 'field' }, ['表示を上書き', overrideInput]),
      num('引き出し量', nt.off || 0, 'mm', (v) => update({ off: v }), { step: 50 }),
      num('文字サイズ', nt.sizeMm || state.project.settings.textMm, 'mm', (v) => update({ sizeMm: Math.max(20, v) }), { min: 20, step: 10 }),
    );
  } else {
    root.append(
      el('div', { class: 'insp-title', text: '文字' }),
      el('p', { class: 'muted', text: nt.text }),
      num('文字サイズ', nt.sizeMm || state.project.settings.textMm, 'mm', (v) => update({ sizeMm: Math.max(20, v) }), { min: 20, step: 10 }),
      num('角度', nt.rot || 0, '°', (v) => update({ rot: v }), { step: 15 }),
      buttonRow([{ text: '文字を編集', onClick: () => editText(nt) }]),
    );
  }
  root.append(
    layerSelect(nt.layerId, (id) => update({ layerId: id })),
    buttonRow([{ text: '削除', cls: 'danger', onClick: deleteSelection }]),
  );
}

/* ── 入口 ───────────────────────────────────────────── */

export function renderInspector() {
  const root = $('#inspector');
  root.innerHTML = '';
  const its = selectedItems();
  const nts = selectedNotes();

  if (its.length === 0 && nts.length === 0) renderSettings(root);
  else if (its.length === 1 && nts.length === 0) renderItem(root, its[0]);
  else if (its.length === 0 && nts.length === 1) renderNote(root, nts[0]);
  else if (its.length >= 2 && nts.length === 0) renderMulti(root, its);
  else {
    root.append(
      el('div', { class: 'insp-title', text: `${its.length + nts.length}点を選択中` }),
      el('p', { class: 'muted', text: '什器と注記が混ざっています。まとめて削除・移動はできます。' }),
      buttonRow([{ text: '削除', cls: 'danger', onClick: deleteSelection }]),
    );
  }
}

export function initInspector() {
  bus.on('selection:changed', renderInspector);
  bus.on('items:changed', renderInspector);
  bus.on('notes:changed', renderInspector);
  bus.on('project:loaded', renderInspector);
  bus.on('layers:changed', renderInspector);
  renderInspector();
}
