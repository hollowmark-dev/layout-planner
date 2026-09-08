/**
 * PDF図面の読み込み。
 * pdf.js は同梱（docs/vendor/）のものだけを使う。外部CDNは参照しない。
 * 読み込んだPDFはこのブラウザの中だけで処理し、どこへも送信しない。
 */

import { el, openModal, toast } from './ui/dom.js';

/** 長辺がこのピクセル数程度になるようにレンダリングする（拡大しても粗くならない目安） */
const TARGET_LONG_SIDE = 3000;
const PT_TO_MM = 25.4 / 72;

let pdfjsLib = null;

async function lib() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('../vendor/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjsLib;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = src;
  });
}

/** File → pdf.js の document */
export async function openPdf(file) {
  const pdfjs = await lib();
  const buf = await file.arrayBuffer();
  return pdfjs.getDocument({ data: buf }).promise;
}

/**
 * 指定ページを画像化する。
 * @returns {Promise<{dataUrl:string, image:HTMLImageElement, width:number, height:number,
 *                    pageWidthMm:number, pageHeightMm:number}>}
 */
export async function renderPage(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(6, Math.max(1, TARGET_LONG_SIDE / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  // 図面は白地が前提。透明のままだとPNG化・PDF書き出しで背景が抜ける
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  // 線画は PNG のほうが線が潰れない。大きすぎるときだけ JPEG に落とす
  let dataUrl = canvas.toDataURL('image/png');
  if (dataUrl.length > 12 * 1024 * 1024) dataUrl = canvas.toDataURL('image/jpeg', 0.88);

  return {
    dataUrl,
    image: await loadImage(dataUrl),
    width: canvas.width,
    height: canvas.height,
    pageWidthMm: base.width * PT_TO_MM,
    pageHeightMm: base.height * PT_TO_MM,
  };
}

/** 複数ページのPDFはどのページを使うか選ばせる */
async function pickPage(pdf) {
  if (pdf.numPages === 1) return 1;
  return new Promise((resolve) => {
    const select = el('select', { style: 'width:150px' },
      Array.from({ length: pdf.numPages }, (_, i) => el('option', { value: i + 1, text: `${i + 1} ページ` })));
    let decided = false;
    openModal({
      title: 'ページを選択',
      lead: `このPDFは ${pdf.numPages} ページあります。背景に使うページを選んでください。`,
      body: el('div', {}, [el('label', { class: 'field' }, ['ページ', select])]),
      okLabel: '読み込む',
      onOk: () => { decided = true; resolve(Number(select.value)); },
      onClose: () => { if (!decided) resolve(null); },
    });
  });
}

/**
 * ファイル選択から背景画像までを一気に。
 * @returns {Promise<null | {pageIndex:number, ...renderPage の戻り値}>}
 */
export async function loadPdfAsBackground(file) {
  let pdf;
  try {
    pdf = await openPdf(file);
  } catch (e) {
    toast('PDFを読み込めませんでした。ファイルが壊れているか、パスワード付きの可能性があります。', 'err');
    console.error(e);
    return null;
  }
  const pageNumber = await pickPage(pdf);
  if (!pageNumber) return null;

  try {
    const rendered = await renderPage(pdf, pageNumber);
    return { pageIndex: pageNumber - 1, ...rendered };
  } catch (e) {
    toast('ページを描画できませんでした。', 'err');
    console.error(e);
    return null;
  }
}
