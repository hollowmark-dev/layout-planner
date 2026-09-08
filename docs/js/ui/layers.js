/**
 * レイヤーとプラン（A案・B案）のパネル。
 * プランは items と notes をまるごと持ち替える方式。案ごとの比較はゴースト表示で行う。
 */

import {
  state, bus, uid, commit, touch, plan, items, notes, clearSelection,
} from '../state.js';
import { $, el, toast, confirmModal, openModal } from './dom.js';

/* ── レイヤー ───────────────────────────────────────── */

function renderLayers() {
  const root = $('#layer-list');
  root.innerHTML = '';

  for (const l of state.project.layers) {
    const swatch = el('input', {
      type: 'color', value: l.color, class: 'sw',
      style: 'width:14px;height:14px;padding:0;border:0;background:none;flex:none',
      title: 'レイヤーの色',
    });
    swatch.addEventListener('change', () => {
      l.color = swatch.value;
      touch(['items:changed', 'notes:changed', 'layers:changed']);
    });

    const name = el('span', { class: 'nm', text: l.name, title: 'ダブルクリックで名前を変更' });
    name.addEventListener('dblclick', () => renameLayer(l));

    const eye = el('button', {
      class: `tg${l.visible ? '' : ' off'}`, text: l.visible ? '◉' : '○', title: '表示／非表示',
    });
    eye.addEventListener('click', () => {
      l.visible = !l.visible;
      touch(['layers:changed']);
    });

    const lock = el('button', {
      class: `tg${l.locked ? '' : ' off'}`, text: l.locked ? '🔒' : '🔓', title: 'ロック（動かせなくする）',
    });
    lock.addEventListener('click', () => {
      l.locked = !l.locked;
      if (l.locked) clearSelection();
      touch(['layers:changed']);
    });

    const del = el('button', { class: 'tg', text: '×', title: 'このレイヤーを削除' });
    del.addEventListener('click', () => removeLayer(l));

    const row = el('div', {
      class: `layer-row${l.id === state.currentLayerId ? ' current' : ''}`,
      title: 'クリックすると、これから置く什器のレイヤーになります',
    }, [swatch, name, eye, lock, del]);
    row.addEventListener('click', (e) => {
      if (e.target === row || e.target === name) {
        state.currentLayerId = l.id;
        renderLayers();
      }
    });
    root.append(row);
  }
}

function renameLayer(l) {
  const input = el('input', { type: 'text', value: l.name, style: 'width:100%' });
  openModal({
    title: 'レイヤー名',
    body: el('div', {}, [input]),
    onOk: () => {
      l.name = input.value.trim() || l.name;
      touch(['layers:changed']);
    },
  });
}

function addLayer() {
  const colors = ['#2563eb', '#059669', '#b45309', '#7c3aed', '#db2777', '#0891b2'];
  const l = {
    id: uid('lay'),
    name: `レイヤー${state.project.layers.length + 1}`,
    color: colors[state.project.layers.length % colors.length],
    visible: true,
    locked: false,
  };
  state.project.layers.push(l);
  state.currentLayerId = l.id;
  commit(['layers:changed']);
  renameLayer(l);
}

async function removeLayer(l) {
  if (state.project.layers.length <= 1) {
    toast('レイヤーは1つ以上必要です。', 'err');
    return;
  }
  const used = state.project.plans.reduce(
    (n, p) => n + p.items.filter((i) => i.layerId === l.id).length
      + p.notes.filter((x) => x.layerId === l.id).length, 0,
  );
  const dest = state.project.layers.find((x) => x.id !== l.id);
  const ok = await confirmModal(
    `レイヤー「${l.name}」を削除`,
    used
      ? `このレイヤーには ${used} 点あります。削除すると「${dest.name}」へ移動します。`
      : 'このレイヤーを削除します。',
    '削除する',
  );
  if (!ok) return;

  for (const p of state.project.plans) {
    p.items.forEach((i) => { if (i.layerId === l.id) i.layerId = dest.id; });
    p.notes.forEach((n) => { if (n.layerId === l.id) n.layerId = dest.id; });
  }
  state.project.layers = state.project.layers.filter((x) => x.id !== l.id);
  if (state.currentLayerId === l.id) state.currentLayerId = dest.id;
  commit(['layers:changed', 'items:changed', 'notes:changed']);
}

/* ── プラン ─────────────────────────────────────────── */

function renderPlans() {
  const root = $('#plan-tabs');
  root.innerHTML = '';
  for (const p of state.project.plans) {
    const active = p.id === state.project.activePlanId;
    const tab = el('button', {
      class: `plan-tab${active ? ' active' : ''}`,
      title: `${p.items.length}点 ／ ダブルクリックで名前を変更`,
    }, [
      el('span', { text: `${p.name}（${p.items.length}）` }),
      state.project.plans.length > 1
        ? el('span', { class: 'x', text: '×', onClick: (e) => { e.stopPropagation(); removePlan(p); } })
        : null,
    ]);
    tab.addEventListener('click', () => switchPlan(p.id));
    tab.addEventListener('dblclick', () => renamePlan(p));
    root.append(tab);
  }
  $('#chk-ghost').checked = !!state.project.settings.showGhost;
}

function switchPlan(id) {
  if (state.project.activePlanId === id) return;
  state.project.activePlanId = id;
  clearSelection();
  touch(['plan:changed', 'items:changed', 'notes:changed']);
  renderPlans();
}

function renamePlan(p) {
  const input = el('input', { type: 'text', value: p.name, style: 'width:100%' });
  openModal({
    title: 'プラン名',
    body: el('div', {}, [input]),
    onOk: () => {
      p.name = input.value.trim() || p.name;
      commit(['plan:changed']);
      renderPlans();
    },
  });
}

function nextPlanName() {
  const used = new Set(state.project.plans.map((p) => p.name));
  for (const c of 'ABCDEFGH') {
    if (!used.has(`${c}案`)) return `${c}案`;
  }
  return `案${state.project.plans.length + 1}`;
}

function duplicatePlan() {
  const src = plan();
  const copy = {
    id: uid('p'),
    name: nextPlanName(),
    items: src.items.map((i) => ({ ...i, id: uid('it') })),
    notes: src.notes.map((n) => ({ ...n, id: uid('n') })),
  };
  state.project.plans.push(copy);
  state.project.activePlanId = copy.id;
  clearSelection();
  commit(['plan:changed', 'items:changed', 'notes:changed']);
  renderPlans();
  toast(`「${copy.name}」を作りました（${copy.items.length}点をコピー）`);
}

async function removePlan(p) {
  if (state.project.plans.length <= 1) return;
  const ok = await confirmModal(
    `プラン「${p.name}」を削除`,
    `${p.items.length}点の配置が消えます。よろしいですか。`,
    '削除する',
  );
  if (!ok) return;
  state.project.plans = state.project.plans.filter((x) => x.id !== p.id);
  if (state.project.activePlanId === p.id) state.project.activePlanId = state.project.plans[0].id;
  clearSelection();
  commit(['plan:changed', 'items:changed', 'notes:changed']);
  renderPlans();
}

/* ── 初期化 ─────────────────────────────────────────── */

export function initLayers() {
  $('#btn-add-layer').addEventListener('click', addLayer);
  $('#btn-add-plan').addEventListener('click', duplicatePlan);
  $('#chk-ghost').addEventListener('change', (e) => {
    state.project.settings.showGhost = e.target.checked;
    touch(['items:changed']);
  });

  bus.on('layers:changed', renderLayers);
  bus.on('project:loaded', () => { renderLayers(); renderPlans(); });
  bus.on('items:changed', renderPlans);
  bus.on('plan:changed', renderPlans);

  renderLayers();
  renderPlans();
}
