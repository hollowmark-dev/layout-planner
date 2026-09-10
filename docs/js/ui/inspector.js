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
import { $, el, openModal, numberField, toast } from './dom.js';
import {
  deleteSelection, duplicateSelection, rotateSelection, alignSelection,
  distributeSelection, setLayerForSelection, arrayDuplicate, selectionBounds,
} from '../actions.js';
import { editText, pickPoints } from '../canvas/annot.js';

/**
 * 選択中のものが同じなら、パネルは作り直さず値だけ書き戻す。
 * 作り直すと、Tabで次の欄へ移った瞬間にフォーカスが消えて
 * W→D→X→Y と数値を流し込めない。
 */
let fields = [];

function track(input, get) {
  fields.push({ input, get });
  return input;
}

function syncFields() {
  for (const f of fields) {
    if (document.activeElement === f.input) continue;
    const v = String(f.get());
    if (f.input.value !== v) f.input.value = v;
  }
}

function num(label, get, unit, onChange, attrs = {}) {
  const input = el('input', { type: 'number', value: get(), ...attrs });
  track(input, get);
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

/* ── 配列複製 ───────────────────────────────────────── */

/**
 * 行×列に並べて複製する。ピッチの既定値は「選んでいるものの外形」なので、
 * そのまま押せば隙間なく並ぶ。机の島を横に並べるときはここを広げる。
 */
function openArrayDialog() {
  const b = selectionBounds();
  if (!b) { toast('什器を選んでください。', 'err'); return; }
  const cols = numberField('横に並べる数', 4, '列', { min: 1, max: 50, step: 1 });
  const rows = numberField('縦に並べる数', 2, '行', { min: 1, max: 50, step: 1 });
  const px = numberField('横のピッチ', Math.round(b.w), 'mm', { step: 50 });
  const py = numberField('縦のピッチ', Math.round(b.h), 'mm', { step: 50 });

  openModal({
    title: '配列複製',
    lead: `選択中の外形は ${Math.round(b.w)} × ${Math.round(b.h)} mm です。`
      + '<br>ピッチは中心から中心までの間隔。外形と同じなら隙間なく並びます。',
    body: el('div', {}, [cols.wrap, rows.wrap, px.wrap, py.wrap]),
    okLabel: '複製する',
    onOk: () => {
      arrayDuplicate({
        cols: Number(cols.input.value) || 1,
        rows: Number(rows.input.value) || 1,
        pitchX: Number(px.input.value) || 0,
        pitchY: Number(py.input.value) || 0,
      });
    },
  });
}

/* ── 何も選んでいないとき ───────────────────────────── */

function renderSettings(root) {
  const st = state.project.settings;
  root.append(
    el('p', { class: 'muted', text: '什器を選ぶと寸法や角度を編集できます。' }),
    num('グリッド間隔', () => st.gridMm, 'mm', (v) => {
      st.gridMm = Math.max(10, v || 100);
      touch(['settings:changed']);
    }, { min: 10, step: 10 }),
    num('注記の文字サイズ', () => st.textMm, 'mm', (v) => {
      st.textMm = Math.max(20, v || 200);
      touch(['settings:changed', 'notes:changed']);
    }, { min: 20, step: 10 }),
  );
  const toggle = (label, key, def = false) => {
    const chk = el('input', { type: 'checkbox' });
    chk.checked = st[key] === undefined ? def : !!st[key];
    chk.addEventListener('change', () => {
      st[key] = chk.checked;
      touch(['items:changed']);
    });
    return el('label', { class: 'chk', style: 'margin-top:6px' }, [chk, label]);
  };
  root.append(
    toggle('什器に寸法を表示する', 'showItemDims', true),
    toggle('レイヤーの色で表示する', 'colorByLayer'),
    toggle('什器に種別の色を薄く敷く', 'itemTint'),
  );
  // 図面を薄くする度合い（0 = そのまま、0.8 = かなり薄い）
  const fade = el('input', { type: 'range', min: 0, max: 0.8, step: 0.05 });
  fade.value = st.drawingFade ?? 0.45;
  fade.addEventListener('input', () => {
    st.drawingFade = Number(fade.value);
    touch(['settings:changed']);
  });
  root.append(el('label', { class: 'field' }, ['図面を薄く表示', fade]));

  // 什器の塗りの濃さ。0 にすると什器が透けて、下の図面を確かめられる
  const solid = el('input', { type: 'range', min: 0, max: 0.95, step: 0.05 });
  solid.value = st.itemFillOpacity ?? 0.85;
  solid.addEventListener('input', () => {
    st.itemFillOpacity = Number(solid.value);
    touch(['items:changed']);
  });
  root.append(el('label', { class: 'field' }, ['什器の塗りの濃さ', solid]));

  // グリッドの原点。図面の左上のままだと通り芯とずれる
  const org = st.gridOrigin || { x: 0, y: 0 };
  root.append(
    el('p', {
      class: 'muted',
      style: 'margin-top:8px',
      text: `グリッドの原点 X${Math.round(org.x)} / Y${Math.round(org.y)}`,
    }),
    el('div', { class: 'insp-actions' }, [
      el('button', {
        text: '原点を指定',
        title: '通り芯の交点などをクリックすると、そこを基準にグリッドが引き直されます',
        onClick: async () => {
          const pts = await pickPoints(1, { snap: false, hint: () => 'グリッドの<b>原点</b>にする位置をクリック（Escで中止）' });
          if (!pts) return;
          st.gridOrigin = { x: Math.round(pts[0].x), y: Math.round(pts[0].y) };
          touch(['settings:changed']);
          renderInspector(true);
        },
      }),
      el('button', {
        text: '左上に戻す',
        onClick: () => {
          st.gridOrigin = { x: 0, y: 0 };
          touch(['settings:changed']);
          renderInspector(true);
        },
      }),
    ]),
  );
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
    num('間口 W', () => it.w, 'mm', (v) => update({ w: Math.max(50, v) }), { min: 50, step: 10 }),
    num('奥行 D', () => it.d, 'mm', (v) => update({ d: Math.max(50, v) }), { min: 50, step: 10 }),
    num('高さ H', () => it.h || 0, 'mm', (v) => update({ h: Math.max(0, v) }), { min: 0, step: 10 }),
    num('角度', () => it.rot || 0, '°', (v) => update({ rot: ((v % 360) + 360) % 360 }), { step: 15 }),
    num('X', () => Math.round(it.x), 'mm', (v) => update({ x: v }), { step: 10 }),
    num('Y', () => Math.round(it.y), 'mm', (v) => update({ y: v }), { step: 10 }),
    el('label', { class: 'field' }, ['色', colorInput]),
    layerSelect(it.layerId, (id) => update({ layerId: id })),
    buttonRow([
      { text: '90°回転', onClick: () => rotateSelection(90) },
      { text: '複製', onClick: () => duplicateSelection() },
      { text: '削除', cls: 'danger', onClick: deleteSelection },
    ]),
    buttonRow([{ text: '配列複製（行×列）', onClick: openArrayDialog }]),
  );
}

/* ── 什器を複数 ─────────────────────────────────────── */

function renderMulti(root, sel) {
  const total = sel.filter((i) => i.kind !== 'obstacle')
    .reduce((s, i) => s + (i.w * i.d) / 1e6, 0);
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
    buttonRow([{ text: '配列複製（行×列）', onClick: openArrayDialog }]),
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
      num('引き出し量', () => Math.round(nt.off || 0), 'mm', (v) => update({ off: v }), { step: 50 }),
      num('文字サイズ', () => nt.sizeMm || state.project.settings.textMm, 'mm', (v) => update({ sizeMm: Math.max(20, v) }), { min: 20, step: 10 }),
    );
  } else {
    root.append(
      el('div', { class: 'insp-title', text: '文字' }),
      el('p', { class: 'muted', text: nt.text }),
      num('文字サイズ', () => nt.sizeMm || state.project.settings.textMm, 'mm', (v) => update({ sizeMm: Math.max(20, v) }), { min: 20, step: 10 }),
      num('角度', () => nt.rot || 0, '°', (v) => update({ rot: v }), { step: 15 }),
      buttonRow([{ text: '文字を編集', onClick: () => editText(nt) }]),
    );
  }
  root.append(
    layerSelect(nt.layerId, (id) => update({ layerId: id })),
    buttonRow([{ text: '削除', cls: 'danger', onClick: deleteSelection }]),
  );
}

/* ── 入口 ───────────────────────────────────────────── */

function selectionKey() {
  return [...state.selection].sort().join(',');
}

let lastKey = null;

export function renderInspector(force = false) {
  const key = selectionKey();
  if (!force && key === lastKey) {
    // 中身は同じなので、値だけ書き戻す
    syncFields();
    return;
  }
  lastKey = key;
  fields = [];
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
  bus.on('selection:changed', () => renderInspector(true));
  bus.on('project:loaded', () => renderInspector(true));
  bus.on('layers:changed', () => renderInspector(true));
  // 値が変わっただけのときは作り直さない
  bus.on('items:changed', () => renderInspector());
  bus.on('notes:changed', () => renderInspector());
  bus.on('drag:moving', () => syncFields());
  renderInspector(true);
}
