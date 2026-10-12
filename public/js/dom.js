// ── DOM 原语：所有渲染走这里，用户数据只用 textContent，天然免疫 XSS ──────
// CSP 只允许 'self' 样式，因此动态样式一律走 CSSOM 而不是 style 属性
function applyStyle(el, text) {
  for (const rule of String(text).split(';')) {
    const idx = rule.indexOf(':');
    if (idx < 0) continue;
    const prop = rule.slice(0, idx).trim();
    const value = rule.slice(idx + 1).trim();
    if (prop) el.style.setProperty(prop, value);
  }
}

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'gap') el.style.setProperty('gap', `var(--space-${value})`);
    else if (key === 'style') applyStyle(el, value);
    else if (key === 'ref' && typeof value === 'function') value(el);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  add(el, children);
  return el;
}

function add(el, children) {
  for (const child of children ?? []) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) add(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

/** 带过滤的 append：条件渲染产生的 null 不会变成 "null" 文本 */
export const put = (el, ...children) => add(el, children);

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── 图标：静态字符串，只在本文件出现 ────────────────────────────────────
const PATHS = {
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2c.7 0 1.35.36 1.73.94l.87 1.31h6.2A2.5 2.5 0 0 1 20 9.75v7A2.5 2.5 0 0 1 17.5 19h-12A2.5 2.5 0 0 1 3 16.75z M6 12h12',
  upload: 'M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M9 5v14M15 5v14',
  prev: 'M15 6l-6 6 6 6',
  next: 'M9 6l6 6-6 6',
  copy: 'M9 9V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-3M5 10h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z',
  link: 'M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1',
  external: 'M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
  check: 'M5 13l4 4L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  note: 'M5 5h14v10l-4 4H5zM15 15h4M8 9h8M8 12h5',
  sun: 'M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M4 6h16M4 12h16M4 18h10',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  plus: 'M12 5v14M5 12h14',
  film: 'M3 5h18v14H3zM3 10h18M8 5v14M16 5v14',
  image: 'M4 5h16v14H4zM4 16l4.5-5 3.5 4 3-3 5 4M9 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z',
  music: 'M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  archive: 'M3 6h18v4H3zM5 10v10h14V10M10 14h4',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5',
  users: 'M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M17 14a6 6 0 0 1 5 6',
  keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 15h8',
  download: 'M12 4v10m0 0l4-4m-4 4l-4-4M4 18h16',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  pencil: 'M4 20h4l10-10-4-4L4 16zM14 6l4 4',
  expand: 'M4 9V4h5M20 15v5h-5M4 15v5h5M20 9V4h-5',
  bolt: 'M13 3L5 13h5l-1 8 8-10h-5z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 2',
  tag: 'M4 10l6-6h8v8l-6 6zM9 9h.01',
  more: 'M3.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M10.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M17.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0',
};

const FILLED = new Set(['play', 'dot', 'more']);

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const solid = FILLED.has(name);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', solid ? 'currentColor' : 'none');
  svg.setAttribute('stroke', solid ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  // 路径来自上方常量表，不含用户数据
  path.setAttribute('d', PATHS[name] ?? PATHS.doc);
  svg.append(path);
  return svg;
}

// ── 格式化 ────────────────────────────────────────────────────────────────
export function fmtBytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let num = n;
  do {
    num /= 1024;
    i += 1;
  } while (num >= 1024 && i < units.length - 1);
  return `${num.toFixed(num >= 100 || num < 10 ? 1 : 2)} ${units[i]}`;
}

export function fmtDur(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function fmtTotalDur(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}

export function fmtAgo(ts) {
  const diff = Date.now() - Number(ts);
  if (diff < 45e3) return '刚刚';
  const mins = Math.round(diff / 60e3);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 浏览器自己的网络报错是英文的，摆给用户看之前先翻译成人话 */
export function friendly(message) {
  const m = String(message ?? '');
  if (/failed to fetch|networkerror|err_network|load(ing)? (was )?cancelled|timeout/i.test(m)) {
    return '连不上本机服务（LanReel 还在运行吗？）';
  }
  return m || '未知错误';
}

// 数字自然序：1、2、10 而不是 1、10、2
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

export const initialOf = (name) => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return '?';
  const code = trimmed.codePointAt(0);
  return /[a-zA-Z]/.test(String.fromCodePoint(code)) ? String.fromCodePoint(code).toUpperCase() : trimmed.slice(0, 1);
};

/** 评审进度分段条：入选 / 待看 / 需修改 / 淘汰 / 未标记 */
export function statusTally(stats) {
  const total = Math.max(1, stats.total);
  const bar = h('div', { class: 'tally', title: '评审进度' });
  for (const key of ['short', 'todo', 'revise', 'drop']) {
    const value = stats.statuses[key] || 0;
    if (value) bar.append(h('i', { 'data-status': key, style: `width:${(value / total) * 100}%` }));
  }
  bar.append(h('i', { style: `width:${(stats.statuses.unset / total) * 100}%;background:var(--surface-3)` }));
  return bar;
}

/** ⓘ 悬浮提示：悬停/聚焦即开，触屏与键盘也能点开关 */
function bindTip(tip, btn) {
  if (btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = tip.dataset.open !== 'true';
    closeAllTips();
    tip.dataset.open = String(open);
    btn.setAttribute('aria-expanded', String(open));
  });
}

export function closeAllTips() {
  for (const tip of qsa('.tip[data-open="true"]')) {
    tip.removeAttribute('data-open');
    tip.querySelector('.tip__btn')?.setAttribute('aria-expanded', 'false');
  }
}

export function initHints(root = document) {
  for (const tip of qsa('.tip', root)) bindTip(tip, tip.querySelector('.tip__btn'));
}

export function hint(text, { label = '说明', side = 'top' } = {}) {
  const id = `tip-${Math.random().toString(36).slice(2, 8)}`;
  const btn = h('button', { class: 'tip__btn', type: 'button', 'aria-label': label, 'aria-describedby': id }, '?');
  const tip = h('span', { class: `tip tip--${side}` }, btn, h('span', { class: 'tip__bubble', id, role: 'tooltip' }, text));
  bindTip(tip, btn);
  return tip;
}

export function progressRing(pct, label) {
  const value = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('aria-hidden', 'true');
  const circle = (cls) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', '18');
    c.setAttribute('cy', '18');
    c.setAttribute('r', '15.9155'); // 周长恰为 100，dasharray 直接等于百分比
    c.setAttribute('class', cls);
    return c;
  };
  const bar = circle('ring__bar');
  bar.setAttribute('stroke-dasharray', `${value} ${100 - value}`);
  svg.append(circle('ring__track'), bar);
  return h('span', { class: 'ring', role: 'img', 'aria-label': label }, svg, h('span', null, `${value}%`));
}

// ── 「更多」菜单：一排按钮放不下的动作收在这里 ────────────────────────────
const openMenus = new Set();

function closeMenus(except) {
  for (const menu of openMenus) if (menu !== except) menu.close();
}

document.addEventListener('click', () => closeMenus());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
});

/** items: [{ label, ico, href?, download?, danger?, onClick? }] */
export function moreMenu(items) {
  const list = h('div', { class: 'menu__list', role: 'menu', hidden: true });
  const menu = {
    close() {
      list.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      openMenus.delete(menu);
    },
    open() {
      closeMenus(menu);
      list.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      openMenus.add(menu);
    },
  };
  for (const item of items) {
    list.append(
      h(item.href ? 'a' : 'button', {
        class: 'menu__item',
        type: item.href ? null : 'button',
        role: 'menuitem',
        href: item.href,
        download: item.download === false ? null : item.download,
        dataset: item.danger ? { tone: 'danger' } : null,
        onClick: (e) => {
          item.onClick?.(e);
          menu.close();
        },
      }, icon(item.ico, 15), h('span', null, item.label)),
    );
  }
  const btn = h('button', {
    class: 'btn btn--ghost btn--sm btn--icon',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': '更多操作',
    onClick: (e) => {
      e.stopPropagation();
      if (list.hidden) menu.open();
      else menu.close();
    },
  }, icon('more', 16));
  return h('div', { class: 'menu' }, btn, list);
}

// ── 轻提示 ────────────────────────────────────────────────────────────────
let toastHost = null;

export function toast(message, kind = 'info', ms = 2600) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = h('div', { class: `toast toast--${kind}` }, message);
  toastHost.append(node);
  const kill = () => {
    node.classList.add('toast--out');
    setTimeout(() => node.remove(), 420);
  };
  const timer = setTimeout(kill, ms);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    kill();
  });
  return node;
}

// ── 弹层 ──────────────────────────────────────────────────────────────────
// 弹层可以叠着开（评审面板 → 放映厅 → 二次确认），锁滚动要按层数计数，
// 否则关掉里层就把外层的滚动锁也解了。
let scrimDepth = 0;

export function openScrim(content, { onClose, cls = '' } = {}) {
  const scrim = h('div', { class: `scrim ${cls}`.trim() });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    scrimDepth = Math.max(0, scrimDepth - 1);
    if (!scrimDepth) document.body.style.overflow = '';
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    // 先让弹层内容消费 Esc（例如清空选择），没人拦截才关闭
    if (!content.dispatchEvent(new CustomEvent('escape', { cancelable: true }))) return;
    close();
  };
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) close();
  });
  document.addEventListener('keydown', onKey, true);
  scrim.append(content);
  scrimDepth += 1;
  document.body.style.overflow = 'hidden';
  document.body.append(scrim);
  return { scrim, close, content };
}
