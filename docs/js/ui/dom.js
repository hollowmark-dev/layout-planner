/** DOM まわりの小道具。モーダル・トースト・操作ヒント。 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ── トースト ───────────────────────────────────────── */

export function toast(message, kind = '') {
  const root = $('#toast-root');
  const node = el('div', { class: `toast ${kind}`, text: message });
  root.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 250);
  }, kind === 'err' ? 4200 : 2400);
}

/* ── 操作ヒント（キャンバス上部の帯） ───────────────── */

export function showHint(html) {
  const h = $('#hint');
  h.innerHTML = html;
  h.classList.add('show');
}
export function hideHint() {
  $('#hint').classList.remove('show');
}

/* ── モーダル ───────────────────────────────────────── */

let closeCurrent = null;

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.lead]      見出し下の説明
 * @param {Node}   [opts.body]      本体
 * @param {string} [opts.okLabel]
 * @param {Function} [opts.onOk]    false を返すと閉じない
 * @param {boolean} [opts.hideCancel]
 */
export function openModal(opts) {
  closeModal();
  const body = opts.body || el('div');
  const okBtn = el('button', { class: 'primary', text: opts.okLabel || 'OK' });
  const cancelBtn = el('button', { text: 'キャンセル' });
  const box = el('div', { class: 'modal' }, [
    el('h2', { text: opts.title }),
    opts.lead ? el('p', { class: 'lead', html: opts.lead }) : null,
    body,
    el('div', { class: 'actions' }, opts.hideCancel ? [okBtn] : [cancelBtn, okBtn]),
  ]);
  const bg = el('div', { class: 'modal-bg' }, [box]);

  const close = () => {
    bg.remove();
    document.removeEventListener('keydown', onKey);
    closeCurrent = null;
    opts.onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); okBtn.click(); }
  };

  okBtn.addEventListener('click', () => {
    if (opts.onOk?.(body) === false) return;
    close();
  });
  cancelBtn.addEventListener('click', close);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.addEventListener('keydown', onKey);

  $('#modal-root').append(bg);
  closeCurrent = close;
  // 最初の入力欄にフォーカス
  setTimeout(() => body.querySelector('input,select,textarea')?.focus(), 0);
  return { close, body };
}

export function closeModal() {
  closeCurrent?.();
}

export function confirmModal(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    openModal({
      title,
      lead: message,
      okLabel,
      onOk: () => { resolve(true); },
      onClose: () => resolve(false),
    });
  });
}

/** ラベル＋数値入力（単位つき） */
export function numberField(label, value, unit = 'mm', attrs = {}) {
  const input = el('input', { type: 'number', value, ...attrs });
  const wrap = el('label', { class: 'field' }, [
    label,
    el('span', { class: 'unit-input' }, [input, el('span', { text: unit })]),
  ]);
  return { wrap, input };
}

export function textField(label, value, attrs = {}) {
  const input = el('input', { type: 'text', value, ...attrs });
  return { wrap: el('label', { class: 'field' }, [label, input]), input };
}
