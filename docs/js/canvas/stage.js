/**
 * Konva ステージの土台。
 *
 * ステージの座標系はそのまま「mm」。stage.scale が「画面px / mm」になる。
 * こうしておくと、什器も注記も mm のまま置けて、ズームしても縮尺がずれない。
 * 線の太さや文字だけは画面基準にしたいので strokeScaleEnabled:false を使う。
 */

import { state, bus } from '../state.js';
import { clamp } from '../geom.js';

export let stage = null;
export let bgLayer = null;    // 図面画像とグリッド
export let mainLayer = null;  // 什器・注記
export let overlayLayer = null; // 選択枠・ガイド・チェック結果など一時的なもの

let bgImageNode = null;
let gridShape = null;
let container = null;

const MIN_SCALE = 0.002; // 1mm が 0.002px（＝図面全体を引きで見る）
const MAX_SCALE = 2;     // 1mm が 2px

export function initStage(containerEl) {
  container = containerEl;
  stage = new Konva.Stage({
    container: containerEl,
    width: containerEl.clientWidth,
    height: containerEl.clientHeight,
  });

  bgLayer = new Konva.Layer({ listening: false });
  mainLayer = new Konva.Layer();
  overlayLayer = new Konva.Layer();
  stage.add(bgLayer, mainLayer, overlayLayer);

  bgImageNode = new Konva.Image({ image: null, x: 0, y: 0, listening: false });
  gridShape = new Konva.Shape({ name: 'grid', listening: false, sceneFunc: drawGrid });
  bgLayer.add(bgImageNode, gridShape);

  stage.scale({ x: 0.05, y: 0.05 });

  bindWheel();
  bindPan();

  const ro = new ResizeObserver(() => {
    stage.size({ width: containerEl.clientWidth, height: containerEl.clientHeight });
    bgLayer.batchDraw();
  });
  ro.observe(containerEl);

  return stage;
}

/* ── 表示 ───────────────────────────────────────────── */

/** 画面px / mm */
export const pxPerMmScreen = () => stage.scaleX();

/** マウス位置を mm 座標で */
export function pointer() {
  return stage.getRelativePointerPosition();
}

/** 画面px（stageローカル）→ mm */
export function toWorld(pos) {
  const s = stage.scaleX();
  return { x: (pos.x - stage.x()) / s, y: (pos.y - stage.y()) / s };
}

/** 画面上の一定サイズを mm に換算する（線の当たり判定などに使う） */
export const screenToMm = (px) => px / stage.scaleX();

/** いま見えている範囲を mm で */
export function visibleRect() {
  const s = stage.scaleX();
  return {
    x: -stage.x() / s,
    y: -stage.y() / s,
    w: stage.width() / s,
    h: stage.height() / s,
  };
}

function applyScale(next, anchorScreen) {
  const old = stage.scaleX();
  const s = clamp(next, MIN_SCALE, MAX_SCALE);
  if (s === old) return;
  const anchor = anchorScreen || { x: stage.width() / 2, y: stage.height() / 2 };
  const world = { x: (anchor.x - stage.x()) / old, y: (anchor.y - stage.y()) / old };
  stage.scale({ x: s, y: s });
  stage.position({ x: anchor.x - world.x * s, y: anchor.y - world.y * s });
  afterViewChange();
}

export function zoomBy(factor, anchorScreen) {
  applyScale(stage.scaleX() * factor, anchorScreen);
}

export function zoomToFit(padding = 40) {
  const d = state.project.drawing;
  let w; let h;
  if (d.pxPerMm && d.imgW) {
    w = d.imgW / d.pxPerMm;
    h = d.imgH / d.pxPerMm;
  } else if (d.imgW) {
    // 縮尺未設定のときは仮に「画像1px = 1mm」として全体を映す
    w = d.imgW; h = d.imgH;
  } else {
    w = 20000; h = 14000;
  }
  const s = Math.min((stage.width() - padding * 2) / w, (stage.height() - padding * 2) / h);
  stage.scale({ x: clamp(s, MIN_SCALE, MAX_SCALE), y: clamp(s, MIN_SCALE, MAX_SCALE) });
  stage.position({
    x: (stage.width() - w * stage.scaleX()) / 2,
    y: (stage.height() - h * stage.scaleY()) / 2,
  });
  afterViewChange();
}

/** 指定した mm 座標を画面中央へ */
export function centerOn(x, y) {
  const s = stage.scaleX();
  stage.position({ x: stage.width() / 2 - x * s, y: stage.height() / 2 - y * s });
  afterViewChange();
}

function afterViewChange() {
  bgLayer.batchDraw();
  overlayLayer.batchDraw();
  bus.emit('view:changed');
}

/* ── 背景 ───────────────────────────────────────────── */

/** 図面画像を差し替える。pxPerMm が決まると mm 空間に正しく載る */
export function refreshBackground() {
  const d = state.project.drawing;
  const img = state.background.image;
  bgImageNode.image(img || null);
  if (img) {
    // 画像1px を 1/pxPerMm mm として配置する。未較正なら 1px=1mm の仮置き
    const k = d.pxPerMm ? 1 / d.pxPerMm : 1;
    bgImageNode.scale({ x: k, y: k });
    bgImageNode.size({ width: img.naturalWidth, height: img.naturalHeight });
  }
  bgLayer.batchDraw();
}

/* ── グリッド ───────────────────────────────────────── */

function drawGrid(ctx, shape) {
  const st = state.project.settings;
  if (!st.snapGrid && !state.project.drawing.pxPerMm) return;
  const step = st.gridMm;
  if (!step) return;

  const s = stage.scaleX();
  // 画面上で細かすぎるグリッドは描かない（見えないうえに重い）
  let stepMm = step;
  while (stepMm * s < 7) stepMm *= 5;
  if (stepMm * s > 400) return;

  const v = visibleRect();
  const x0 = Math.floor(v.x / stepMm) * stepMm;
  const y0 = Math.floor(v.y / stepMm) * stepMm;
  const majorEvery = 10; // 太線の間隔

  ctx.save();
  for (let x = x0; x <= v.x + v.w; x += stepMm) {
    const major = Math.round(x / stepMm) % majorEvery === 0;
    ctx.beginPath();
    ctx.moveTo(x, v.y);
    ctx.lineTo(x, v.y + v.h);
    ctx.strokeStyle = major ? 'rgba(37,99,235,.18)' : 'rgba(37,99,235,.08)';
    ctx.lineWidth = (major ? 1.2 : 0.8) / s;
    ctx.stroke();
  }
  for (let y = y0; y <= v.y + v.h; y += stepMm) {
    const major = Math.round(y / stepMm) % majorEvery === 0;
    ctx.beginPath();
    ctx.moveTo(v.x, y);
    ctx.lineTo(v.x + v.w, y);
    ctx.strokeStyle = major ? 'rgba(37,99,235,.18)' : 'rgba(37,99,235,.08)';
    ctx.lineWidth = (major ? 1.2 : 0.8) / s;
    ctx.stroke();
  }
  ctx.restore();
  shape.getLayer(); // Konva の型合わせ（未使用）
}

export function redrawGrid() {
  bgLayer.batchDraw();
}

/* ── ホイールズーム・パン ───────────────────────────── */

function bindWheel() {
  stage.on('wheel', (e) => {
    e.evt.preventDefault();
    const factor = e.evt.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomBy(factor, stage.getPointerPosition());
  });
}

let panning = false;
let panStart = null;
let spaceDown = false;

function bindPan() {
  const wrap = () => container.parentElement;

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTypingTarget(e.target)) {
      spaceDown = true;
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceDown = false;
  });

  stage.on('mousedown', (e) => {
    const middle = e.evt.button === 1;
    const rightDrag = e.evt.button === 2;
    if (!(middle || rightDrag || (spaceDown && e.evt.button === 0))) return;
    e.evt.preventDefault();
    panning = true;
    panStart = { pointer: stage.getPointerPosition(), pos: stage.position() };
    wrap()?.classList.add('panning');
  });

  stage.on('mousemove', () => {
    if (!panning) return;
    const p = stage.getPointerPosition();
    stage.position({
      x: panStart.pos.x + (p.x - panStart.pointer.x),
      y: panStart.pos.y + (p.y - panStart.pointer.y),
    });
    afterViewChange();
  });

  const stop = () => {
    if (!panning) return;
    panning = false;
    wrap()?.classList.remove('panning');
  };
  stage.on('mouseup', stop);
  stage.on('mouseleave', stop);
  container.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function isPanning() { return panning; }
export function isSpaceDown() { return spaceDown; }

export function isTypingTarget(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
