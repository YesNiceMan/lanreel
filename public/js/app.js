// ── 素材库首页：入库 → 生成链接 → 进入评审 ────────────────────────────────
import { api } from './api.js';
import { clear, closeAllTips, fmtAgo, fmtBytes, fmtTotalDur, friendly, h, hint, icon, initHints, moreMenu, openScrim, progressRing, qs, statusTally, toast } from './dom.js';
import { STATUS_BY_KEY } from './statuses.js';
import { createReview } from './review.js';
import { collectDropped, planFiles, UploadJob } from './uploader.js';
import { connectSync } from './sync.js';
import { getActor, paintNameButton } from './identity.js';
import { backfillPosters, needsWork } from './backfill.js';

const mount = (name) => qs(`[data-mount="${name}"]`);
const actor = () => getActor() || '本机管理员';

let bundles = [];
let totals = { bundles: 0, items: 0, bytes: 0 };
let storage = { files: 0, onDisk: 0 };
let limits = { maxUploadBytes: 4 * 1024 ** 3, maxFilesPerBundle: 3000 };
let lan = [];
let port = location.port || '8080';
let viewers = 0;
let job = null;
let onlyOpen = false;
let query = '';
let mode = localStorage.getItem('lanreel-mode') || 'grid';
/** 机主口令：只有运行 LanReel 的这台电脑拿得到，用来在别的设备上管理素材库 */
let ownerInfo = null;
let ownerAsked = false;

// ── 主题 ──────────────────────────────────────────────────────────────────
const root = document.documentElement;
function applyTheme(theme) {
  root.dataset.theme = theme;
  localStorage.setItem('lanreel-theme', theme);
  const btn = qs('[data-action="theme"]');
  clear(btn);
  btn.append(icon(theme === 'light' ? 'moon' : 'sun'));
  btn.title = theme === 'light' ? '切到暗色' : '切到亮色';
}
qs('[data-action="theme"]').addEventListener('click', () => {
  applyTheme(root.dataset.theme === 'light' ? 'dark' : 'light');
});
applyTheme(localStorage.getItem('lanreel-theme') || 'light');
paintNameButton(qs('[data-action="who"]'));
initHints();
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tip')) closeAllTips();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.tip[data-open="true"]')) {
    e.stopPropagation();
    closeAllTips();
  }
}, true);

// ── 复制（局域网 http 环境下 clipboard API 不可用，逐级降级）───────────────
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续降级 */
  }
  const box = h('textarea', { rows: '2' });
  box.value = text;
  Object.assign(box.style, { position: 'fixed', top: '-1000px', opacity: '0' });
  document.body.append(box);
  box.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  box.remove();
  if (!ok) window.prompt('复制链接：', text);
  return ok;
}

const lanHosts = () => lan.map((l) => l.address);
/** 分享地址：优先用当前这台机器实际在用的主机名，其次第一块网卡 */
const shareHost = () => (lanHosts().includes(location.hostname) ? location.hostname : lanHosts()[0] || location.hostname);
const shareLink = (bundle) => `${location.protocol}//${shareHost()}:${port}${bundle.shareUrl}`;
/** 导出是普通链接下载：机主身份由浏览器带上的 Cookie 说明，不需要额外请求头 */
const exportHref = (bundle, fmt) => `/api/bundles/${encodeURIComponent(bundle.id)}/export?fmt=${fmt}`;
const linkNote = () =>
  lanHosts().length > 1 ? `这台机器有多块网卡：${[...new Set(lanHosts().concat(location.hostname))].join(' / ')}，同事打不开就换一个地址试试` : '';

// ── 首屏统计 ──────────────────────────────────────────────────────────────
function paintTotals() {
  const sum = bundles.reduce(
    (acc, b) => ({
      items: acc.items + b.stats.total,
      bytes: acc.bytes + b.stats.bytes,
      duration: acc.duration + b.stats.duration,
      pending: acc.pending + (b.stats.total - b.stats.reviewed),
      missing: acc.missing + (b.stats.missing ?? 0),
    }),
    { items: 0, bytes: 0, duration: 0, pending: 0, missing: 0 },
  );
  const host = mount('totals');
  clear(host);
  const stat = (value, label, tip) =>
    h('div', { class: 'stat' }, h('b', null, value), h('span', null, label, tip ? hint(tip) : null));
  host.append(
    stat(String(bundles.length), '素材夹'),
    stat(String(sum.items), '素材'),
    stat(fmtBytes(sum.bytes), '素材合计', '所有素材体积相加。挂载模式的文件留在原目录，不进项目、不占 data/。'),
    stat(fmtBytes(storage.onDisk), 'data/ 实占', 'data/ 目录真实占用（按 inode 去重）：只有复制入库的字节和浏览器抓的封面。'),
    stat(sum.duration ? fmtTotalDur(sum.duration) : '—', '总时长'),
    sum.missing
      ? stat(String(sum.missing), '源文件丢失', '这些素材在源目录里已经找不到了（被移动、改名或外接盘断开）。把文件放回原位后点「重新扫描」。')
      : stat(String(sum.pending), '待评审'),
  );
}

function paintServer(state = 'ok') {
  const node = mount('server');
  clear(node);
  const addr = lan[0]?.address;
  node.append(
    h('span', { class: `dot ${state === 'ok' ? 'dot--live' : ''}`, style: `color:var(--tone-${state === 'ok' ? 'success' : 'danger'})` }),
    state === 'err'
      ? '本机服务未连接'
      : h('span', { class: 'mono', title: '连着实时同步的页面数，包括你自己开的标签页和弹层' },
          `${addr ? `局域网 ${addr}:${port}` : `localhost:${port}`} · ${viewers} 个页面在线`),
  );
}

// ── 素材夹卡片 ────────────────────────────────────────────────────────────
function mosaic(bundle) {
  const pool = (bundle.previews ?? []).slice(0, 4);
  const cells = [];
  for (let i = 0; i < 4; i += 1) {
    const src = pool[i];
    cells.push(
      src
        ? h('img', {
            src,
            alt: '',
            loading: 'lazy',
            onError: (e) => e.target.replaceWith(h('i')),
          })
        : h('i'),
    );
  }
  return h('div', { class: 'bundle__mosaic' }, cells);
}

function bundleCard(bundle) {
  const link = shareLink(bundle);
  const statusChips = ['short', 'todo', 'revise', 'drop']
    .filter((key) => bundle.stats.statuses[key])
    .map((key) => h('span', { class: `pill pill--status pill--${key}` }, `${STATUS_BY_KEY[key].label} ${bundle.stats.statuses[key]}`));

  return h(
    'article',
    { class: 'card bundle' },
    mosaic(bundle),
    h('div', { class: 'bundle__body' },
      h('div', { class: 'spread' },
        h('div', { class: 'col', gap: '1' },
          h('h3', { class: 'bundle__title clip', title: bundle.name }, bundle.name),
          h('div', { class: 'cluster cluster-tight dim', style: 'font-size:var(--text-2xs)' },
            bundle.mode === 'reference'
              ? h('span', { class: 'pill pill--accent', title: bundle.root ? `源目录：${bundle.root}\ndata/ 里只多了几张封面缩略图` : '素材留在原目录，data/ 里只多了几张封面缩略图' }, '引用原文件')
              : null,
            h('span', null, `${bundle.stats.total} 个素材`),
            bundle.stats.videos ? h('span', null, `${bundle.stats.videos} 视频`) : null,
            bundle.stats.duration ? h('span', null, fmtTotalDur(bundle.stats.duration)) : null,
            h('span', { title: bundle.mode === 'reference' ? '源文件体积，不在 data/ 里' : '已复制进 data/ 的体积' }, fmtBytes(bundle.stats.bytes)),
            h('span', null, fmtAgo(bundle.updatedAt)),
            bundle.stats.missing ? h('span', { class: 'pill pill--status pill--drop', title: `${bundle.stats.missing} 个素材在源目录里已经读不到了` }, `源文件丢失 ${bundle.stats.missing}`) : null)),
        progressRing((bundle.stats.reviewed / Math.max(1, bundle.stats.total)) * 100, '评审完成度')),
      statusTally(bundle.stats),
      statusChips.length ? h('div', { class: 'chips' }, statusChips) : null,
      bundle.description ? h('p', { class: 'muted', style: 'font-size:var(--text-sm)' }, bundle.description) : null,
      h('a', { class: 'bundle__link', href: link, target: '_blank', rel: 'noopener', title: linkNote() },
        icon('link', 14), h('span', { class: 'clip grow' }, link.replace(/^https?:\/\//, '')), icon('external', 14)),
      h('div', { class: 'bundle__foot' },
        h('button', { class: 'btn btn--primary btn--sm', type: 'button', onClick: () => openBundle(bundle.id) },
          icon('play', 14), '进入评审'),
        h('button', { class: 'btn btn--sm', type: 'button', onClick: async () => {
          if (await copyText(link)) toast('分享链接已复制，发给同事即可', 'ok');
          else toast('浏览器不允许写入剪贴板，链接已弹出，请手动复制', 'warn');
        } }, icon('copy', 14), '复制链接'),
        bundle.mode === 'reference'
          ? h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onClick: () => rescan(bundle) },
              icon('refresh', 14), '重新扫描')
          : h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onClick: () => addFilesTo(bundle) },
              icon('plus', 14), '追加'),
        moreMenu([
          { label: '重命名素材夹', ico: 'pencil', onClick: () => renameBundle(bundle) },
          { label: '导出评审表 CSV', ico: 'download', href: exportHref(bundle, 'csv') },
          { label: '导出完整记录 JSON', ico: 'doc', href: exportHref(bundle, 'json') },
          {
            label: bundle.mode === 'reference' ? '解除挂载' : '删除素材夹',
            ico: 'trash',
            danger: true,
            onClick: () => confirmDelete(bundle),
          },
        ])),
    ),
  );
}

function paintBundles() {
  const host = mount('bundles');
  const empty = mount('empty');
  const list = bundles.filter((b) => {
    if (onlyOpen && b.stats.reviewed === b.stats.total) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return b.name.toLowerCase().includes(q) || (b.previewsName ?? []).some((n) => n.toLowerCase().includes(q));
  });
  mount('bundles').dataset.mode = mode;
  clear(host);
  if (!bundles.length) {
    empty.hidden = false;
    clear(empty);
    empty.append(
      icon('folder', 30),
      h('h3', null, '还没有素材夹'),
      h('p', null, '上方二选一：「上传入库」会把文件复制一份到 data/；素材本来就在这台机器上的话，用「挂载本机目录」原地放映、不占磁盘。'),
    );
  } else if (!list.length) {
    empty.hidden = false;
    clear(empty);
    empty.append(icon('search', 26), h('p', null, '没有匹配的素材夹'));
  } else {
    empty.hidden = true;
    host.append(...list.map(bundleCard));
  }
  paintTotals();
  const listMeta = mount('listmeta');
  if (listMeta) {
    const count = bundles.reduce((sum, b) => sum + b.stats.total, 0);
    const mounted = bundles.filter((b) => b.mode === 'reference').length;
    const missing = bundles.reduce((sum, b) => sum + (b.stats.missing ?? 0), 0);
    listMeta.textContent =
      `${bundles.length} 个夹子 · ${count} 个素材${mounted ? ` · ${mounted} 个为挂载` : ''}${missing ? ` · ${missing} 个源文件已丢失` : ''}`;
  }
}

// ── 数据 ──────────────────────────────────────────────────────────────────
async function load() {
  const data = await api.bundles();
  totals = data.totals;
  storage = data.storage ?? storage;
  lan = data.lan;
  port = String(data.port || port);
  bundles = data.bundles;
  // 缩略图需要 items，列表接口不含 → 并发补前 4 个封面
  await Promise.all(
    bundles.map(async (b) => {
      try {
        const full = await api.bundle(b.id);
        b.previews = full.items.slice(0, 4).map((i) => i.posterUrl || (i.kind === 'image' ? i.streamUrl : null));
        b.previewsName = full.items.map((i) => i.name);
      } catch {
        b.previews = [];
      }
    }),
  );
  paintBundles();
  paintServer('ok');
  const mountedNote = totals.mountedBytes ? `，其中 ${fmtBytes(totals.mountedBytes)} 是挂载素材、留在原目录` : '';
  const missingNote = totals.missing ? ` · ⚠ ${totals.missing} 个源文件读不到` : '';
  mount('storage').textContent =
    `数据目录 ${totals.dataDir ?? 'data/'} · ${totals.bundles} 夹 / ${totals.items} 素材 / 素材合计 ${fmtBytes(totals.bytes)}${mountedNote} · data/ 实占 ${fmtBytes(storage.onDisk)}${missingNote}`;
}

// ── 入库 ──────────────────────────────────────────────────────────────────
const queueHost = mount('queue');
const rows = new Map();

function queueRow(task) {
  const bar = h('i');
  const state = h('span', { class: 'queue__meta' }, h('span', { class: 'spinner' }));
  const row = h('div', { class: 'queue__row', 'data-state': 'run' },
    icon(task.kind === 'image' ? 'image' : task.kind === 'audio' ? 'music' : 'film', 16),
    h('div', { class: 'col', gap: '1' },
      h('b', { class: 'clip', title: task.relPath }, task.name),
      h('span', { class: 'clip dim', style: 'font-size:var(--text-2xs)' }, task.relPath)),
    state,
    h('div', { class: 'queue__bar' }, bar));
  row.__bar = bar;
  row.__state = state;
  rows.set(task.relPath, row);
  return row;
}

function summaryRow(label) {
  const node = h('div', { class: 'queue__row', 'data-state': 'run' },
    icon('bolt', 16), h('b', null, label), h('span', { class: 'queue__meta' }));
  return node;
}

let aggregate = null;

function onUploadEvent(evt) {
  const { task } = evt;
  if (evt.type === 'ignored' || evt.type === 'rejected' || evt.type === 'skipped') return;
  let row = rows.get(task.relPath);
  if (!row) {
    row = queueRow(task);
    queueHost.append(row);
  }
  if (evt.type === 'progress') {
    row.__bar.style.width = `${Math.round((evt.loaded / Math.max(1, evt.total)) * 100)}%`;
    row.__state.textContent = `${Math.round((evt.loaded / Math.max(1, evt.total)) * 100)}%`;
  }
  if (evt.type === 'done') {
    row.dataset.state = 'done';
    row.__bar.style.width = '100%';
    clear(row.__state);
    row.__state.append(icon('check', 14), fmtBytes(task.size));
    bumpAggregate();
  }
  if (evt.type === 'error') {
    row.dataset.state = 'error';
    row.__state.textContent = evt.reason;
    row.__state.title = evt.reason;
    bumpAggregate();
  }
  if (evt.type === 'cancelled') {
    row.dataset.state = 'error';
    row.__state.textContent = '已取消';
  }
  row.scrollIntoView({ block: 'nearest' });
}

function bumpAggregate() {
  if (!aggregate) return;
  const bar = aggregate.__bar;
  const done = job.stats.done + job.stats.failed;
  const pct = job.stats.total ? Math.round((done / job.stats.total) * 100) : 100;
  bar.style.width = `${pct}%`;
  aggregate.__state.textContent = `${done}/${job.stats.total}`;
}

function startAggregate(label) {
  const bar = h('i');
  aggregate = h('div', { class: 'queue__row', 'data-state': 'run' },
    icon('upload', 16),
    h('b', null, label),
    h('span', { class: 'queue__meta' }),
    h('div', { class: 'queue__bar' }, bar));
  aggregate.__bar = bar;
  aggregate.__state = qs('.queue__meta', aggregate);
  queueHost.append(aggregate);
}

function resetQueue() {
  rows.clear();
  aggregate = null;
  queueHost.hidden = false;
  clear(queueHost);
}

async function ingest(fileList, { bundleName, target } = {}) {
  const tasks = planFiles(fileList);
  if (!tasks.length) {
    toast('这个文件夹里没有可用文件', 'warn');
    return;
  }
  const first = [...fileList][0] ?? {};
  const name = bundleName || (first.webkitRelativePath || '').split('/')[0] || (first.name || '').replace(/\.[^.]+$/, '') || '未命名素材夹';
  resetQueue();
  startAggregate(`正在入库 ${tasks.length} 个文件 → ${name}`);

  try {
    await uploadAll(tasks, name, target);
  } catch (err) {
    // 建夹、扫描或刷新失败也要落地成一条看得见的失败，而不是让进度条永远转下去
    aggregate.dataset.state = 'error';
    aggregate.__state.textContent = friendly(err.message);
    toast(`入库失败：${friendly(err.message)}`, 'err', 5200);
  } finally {
    job = null;
  }
}

async function uploadAll(tasks, name, target) {
  const bundle = target ?? (await api.createBundle(name, ''));
  const existing = target ? (await api.bundle(target.id)).items : [];
  job = new UploadJob({ bundleRef: bundle.id, existing, maxBytes: limits.maxUploadBytes, onEvent: onUploadEvent });
  const stats = await job.run(tasks);

  aggregate.dataset.state = stats.failed ? 'error' : 'done';
  aggregate.__bar.style.width = '100%';
  aggregate.__state.textContent = `完成 ${stats.done} · 跳过 ${stats.skipped} · 失败 ${stats.failed}`;
  await load();

  if (stats.done + stats.skipped > 0) {
    const fresh = bundles.find((b) => b.id === bundle.id) ?? bundle;
    openShareCard(fresh, { added: stats.done + stats.skipped });
  }
}

function openShareCard(bundle, { added = 0, mounted = false } = {}) {
  const link = shareLink(bundle);
  const body = h('div', { class: 'linkcard' },
    h('div', { class: 'col' },
      h('p', { class: 'eyebrow' }, added ? `${added} 个素材${mounted ? '已挂载（未复制文件）' : '已入库'}` : '分享已就绪'),
      h('h3', { class: 'panel-title' }, bundle.name)),
    h('div', { class: 'linkcard__url' }, icon('link', 16), h('span', { class: 'grow' }, link)),
    h('p', { class: 'muted', style: 'font-size:var(--text-sm)' },
      '同一局域网里的任何人打开这个链接即可观看、勾选状态、写备注；进度拖动是本地直读，不经过任何云端。'),
    h('div', { class: 'cluster' },
      h('button', { class: 'btn btn--primary', type: 'button', onClick: async () => {
        if (await copyText(link)) toast('链接已复制', 'ok');
        else toast('浏览器不允许写入剪贴板，链接已弹出，请手动复制', 'warn');
      } }, icon('copy', 16), '复制链接'),
      h('a', { class: 'btn', href: bundle.shareUrl, target: '_blank', rel: 'noopener' }, icon('external', 16), '打开分享页'),
      h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => sheet.close() }, '稍后')));
  const sheet = openScrim(h('div', { class: 'sheet sheet--sm' },
    h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow' }, 'LanReel'),
      h('button', { class: 'btn btn--icon btn--ghost', type: 'button', onClick: () => sheet.close() }, icon('x'))),
    h('div', { class: 'sheet-body' }, body)));
}

const folderInput = qs('[data-ref="folder-input"]');
const fileInput = qs('[data-ref="file-input"]');
folderInput.addEventListener('change', (e) => {
  const first = e.target.files[0]?.webkitRelativePath || '';
  ingest(e.target.files, { bundleName: first.split('/')[0] || '' });
});
fileInput.addEventListener('change', (e) => ingest(e.target.files));
qs('[data-action="pick-folder"]').addEventListener('click', () => folderInput.click());
qs('[data-action="pick-files"]').addEventListener('click', () => fileInput.click());

// 整个入库面板都能接住拖拽，高亮落在「上传入库」那一格
const dropzone = mount('dropzone');
let dragDepth = 0;
mount('intake').addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth += 1;
  dropzone.dataset.drag = 'true';
});
mount('intake').addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.dataset.drag = 'true';
});
mount('intake').addEventListener('dragleave', () => {
  if ((dragDepth -= 1) > 0) return;
  dragDepth = 0;
  dropzone.dataset.drag = 'false';
});
mount('intake').addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.dataset.drag = 'false';
  const files = await collectDropped([...e.dataTransfer.items]);
  if (files.length) ingest(files);
  else toast('没有识别到文件', 'warn');
});

let appendTarget = null;
const appendInput = qs('[data-ref="append-input"]');
appendInput.addEventListener('change', () => {
  const target = appendTarget;
  appendTarget = null;
  if (!target) return;
  ingest(appendInput.files, { target });
  appendInput.value = '';
});

function addFilesTo(bundle) {
  appendTarget = bundle;
  appendInput.click();
}

async function rescan(bundle) {
  try {
    const result = await api.rescan(bundle.id);
    await load();
    const parts = [`新增 ${result.added}`, `移除 ${result.removed}`, `共 ${result.total} 个素材`];
    if (result.revived) parts.push(`找回 ${result.revived} 个源文件`);
    toast(`扫描完成：${parts.join(' · ')}`, result.added || result.revived ? 'ok' : 'info');
  } catch (err) {
    toast(friendly(err.message), 'err');
  }
}

const mountInput = qs('[data-ref="mount-path"]');

/** 挂载之后如果发现内容几乎重合的「复制入库」素材夹，提示可以删掉副本腾磁盘 */
function reclaimPrompt(duplicates) {
  const bytes = duplicates.reduce((sum, d) => sum + d.bytes, 0);
  const sheet = openScrim(h('div', { class: 'sheet sheet--sm' },
    h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow' }, '可以释放的空间')),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'col', gap: '4' },
        h('p', { class: 'muted' }, `下面这些素材夹里的文件与刚挂载的目录基本重合。挂载版只在 data/ 里多几张封面，删掉副本可回收约 ${fmtBytes(bytes)}：`),
        ...duplicates.map((d) => h('div', { class: 'spread' },
          h('div', { class: 'col', gap: '1' },
            h('b', null, d.name),
            h('span', { class: 'dim', style: 'font-size:var(--text-2xs)' }, `${d.items} 个素材 · ${fmtBytes(d.bytes)}`)),
          h('button', {
            class: 'btn btn--danger btn--sm',
            type: 'button',
            onClick: async () => {
              try {
                await api.deleteBundle(d.id);
                sheet.close();
                toast(`已删除副本「${d.name}」，释放 ${fmtBytes(d.bytes)}`, 'ok');
                await load();
              } catch (err) {
                toast(friendly(err.message), 'err');
              }
            },
          }, '删除副本'))))),
    h('div', { class: 'sheet-foot' },
      h('span', { class: 'dim', style: 'font-size:var(--text-2xs)' }, '只删这些素材夹自己的副本，不会碰挂载目录里的原始文件'),
      h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => sheet.close() }, '先不删'))));
}

/** 挂载进来的视频/音频没有封面与时长，交给浏览器抓帧补齐 */
async function backfillMount(bundleId, { quiet = false } = {}) {
  let full;
  try {
    full = await api.bundle(bundleId);
  } catch {
    return;
  }
  const todo = full.items.filter(needsWork).length;
  if (!todo) return;
  if (!quiet) toast(`正在为 ${todo} 个挂载素材读时长/尺寸、抓封面…`, 'info', 2800);
  const stats = await backfillPosters(bundleId, full.items);
  const parts = [];
  if (stats.posters) parts.push(`${stats.posters} 张封面`);
  if (stats.meta) parts.push(`${stats.meta} 个时长/分辨率`);
  if (stats.failed) parts.push(`${stats.failed} 个浏览器解不了（只有占位图，可转成 H.264 再入库）`);
  if (!quiet && parts.length) toast(`已补齐 ${parts.join('，')}`, stats.failed ? 'warn' : 'ok', 4200);
  if (stats.posters || stats.meta) await load();
}

async function mountFolder(pathValue) {
  const value = String(pathValue ?? mountInput.value ?? '').trim();
  if (!value) {
    toast('先填一个本机目录的绝对路径', 'warn');
    mountInput.focus();
    return;
  }
  try {
    const bundle = await api.mount(value, '');
    mountInput.value = value;
    await load();
    openShareCard(bundle, { added: bundle.stats.total, mounted: true });
    if (bundle.duplicates?.length) setTimeout(() => reclaimPrompt(bundle.duplicates), 500);
    backfillMount(bundle.id);
  } catch (err) {
    toast(friendly(err.message), 'err');
  }
}

async function browseMount() {
  toast('正在打开系统文件夹选择器…', 'info', 1800);
  try {
    const result = await api.pickFolder();
    if (result.cancelled) return;
    await mountFolder(result.path);
  } catch (err) {
    toast(friendly(err.message), 'err');
  }
}

qs('[data-action="mount"]').addEventListener('click', () => mountFolder());
qs('[data-action="pick-mount"]').addEventListener('click', browseMount);
mountInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') mountFolder();
});

async function renameBundle(bundle) {
  const input = h('input', { class: 'input', value: bundle.name });
  const sheet = openScrim(h('div', { class: 'sheet sheet--sm' },
    h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow' }, '重命名')),
    h('div', { class: 'sheet-body' }, h('div', { class: 'field' }, h('label', { class: 'muted' }, '素材夹名称'), input)),
    h('div', { class: 'sheet-foot' },
      h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => sheet.close() }, '取消'),
      h('button', { class: 'btn btn--primary', type: 'button', onClick: async () => {
        try {
          await api.updateBundle(bundle.id, { name: input.value.trim() || bundle.name });
          sheet.close();
          toast('已更新', 'ok');
          await load();
        } catch (err) {
          toast(friendly(err.message), 'err');
        }
      } }, '保存'))));
  setTimeout(() => input.select(), 60);
}

function confirmDelete(bundle) {
  const mounted = bundle.mode === 'reference';
  const detail = mounted
    ? `这个夹子只是挂载了「${bundle.root || '源目录'}」里的 ${bundle.stats.total} 个素材，删除只是解除分享：你的原始文件一个字节都不会动，data/ 里由我们生成的封面会一并清掉。`
    : `这个夹子里的 ${bundle.stats.total} 个素材是复制进 data/ 的副本，删除会把这份副本移除（你当初上传的那份源文件不受影响）。`;
  const sheet = openScrim(h('div', { class: 'sheet sheet--sm' },
    h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow', style: 'color:var(--tone-danger)' }, mounted ? '解除挂载' : '删除素材夹')),
    h('div', { class: 'sheet-body' },
      h('p', null, `确定删除「${bundle.name}」吗？`),
      h('p', { class: 'muted', style: 'font-size:var(--text-sm)' }, detail),
      h('p', { class: 'dim', style: 'font-size:var(--text-sm)' }, '分享链接同时失效，里面的评审状态与备注一并作废，此操作不可撤销。')),
    h('div', { class: 'sheet-foot' },
      h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => sheet.close() }, '取消'),
      h('button', { class: 'btn btn--danger', type: 'button', onClick: async () => {
        try {
          await api.deleteBundle(bundle.id);
          sheet.close();
          toast('已删除', 'ok');
          await load();
        } catch (err) {
          toast(friendly(err.message), 'err');
        }
      } }, '确认删除'))));
}

// ── 评审面板 ──────────────────────────────────────────────────────────────
async function openBundle(ref) {
  const bundle = await api.bundle(ref);
  const grid = h('div', { class: 'grid grid--tight' });
  const bar = h('div');
  const dock = h('div', { class: 'dock', 'data-mount': 'sheet-dock' });
  const sheet = openScrim(
    h('div', { class: 'sheet', style: 'width:min(100%,80rem);height:min(100%,52rem)' },
      h('div', { class: 'sheet-head' },
        h('div', { class: 'col', gap: '1' },
          h('span', { class: 'eyebrow' }, '评审面板'),
          h('h3', { class: 'clip' }, bundle.name)),
        h('div', { class: 'cluster cluster-tight' },
          h('a', { class: 'btn btn--sm', href: bundle.shareUrl, target: '_blank', rel: 'noopener' }, icon('external', 14), '分享页'),
          h('button', { class: 'btn btn--icon btn--ghost', type: 'button', onClick: () => sheet.close() }, icon('x')))),
      h('div', { class: 'sheet-body' }, bar, grid),
      dock),
  );

  const review = createReview({
    host: grid,
    barHost: bar,
    dockHost: dock,
    actor,
    emptyText: '这个素材夹还是空的，点「追加」放点东西进来',
  });
  review.setItems(bundle.items);
  backfillPosters(bundle.id, bundle.items, { onItem: (item) => review.patch(item) });

  const sync = connectSync({
    ref: bundle.id,
    onEvent: async (payload) => {
      if (payload?.type === 'keepalive') return;
      const fresh = await api.bundle(bundle.id);
      review.setItems(fresh.items, payload?.itemId ? [payload.itemId] : []);
    },
  });
  sheet.scrim.addEventListener('pointerdown', () => {});
  const origClose = sheet.close;
  sheet.close = () => {
    sync.close();
    origClose();
  };
}

// ── 工具栏 / 快捷键 ───────────────────────────────────────────────────────
const viewseg = mount('viewseg');
function paintSeg() {
  clear(viewseg);
  [
    { key: 'grid', label: '卡片', ico: 'grid' },
    { key: 'list', label: '列表', ico: 'list' },
  ].forEach((v) => {
    viewseg.append(h('button', { type: 'button', 'aria-pressed': String(mode === v.key), onClick: () => {
      mode = v.key;
      localStorage.setItem('lanreel-mode', mode);
      paintSeg();
      paintBundles();
    } }, icon(v.ico, 14), v.label));
  });
}
paintSeg();

mount('search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  paintBundles();
});
qs('[data-action="only-open"]').addEventListener('click', (e) => {
  onlyOpen = !onlyOpen;
  e.currentTarget.setAttribute('aria-pressed', String(onlyOpen));
  paintBundles();
});

function shortcuts() {
  const rows = [
    ['U', '选择本地文件夹入库'],
    ['/', '搜索素材夹'],
    ['1 – 4', '给选中的素材打状态（评审面板内）'],
    ['← →', '放映厅内切换素材'],
    ['Space', '播放 / 暂停'],
    ['N', '在放映厅写备注'],
    ['Esc', '关闭弹层'],
  ];
  const owner = ownerInfo
    ? h('div', { class: 'col', gap: '2', style: 'margin-top:var(--space-4)' },
        h('p', { class: 'eyebrow' }, '机主口令'),
        h('div', { class: 'spread' },
          h('code', { class: 'mono' }, ownerInfo.token),
          h('button', { class: 'btn btn--sm', type: 'button', onClick: async () => {
            if (await copyText(ownerInfo.token)) toast('机主口令已复制', 'ok');
          } }, icon('copy', 14), '复制')),
        h('p', { class: 'dim', style: 'font-size:var(--text-2xs)' },
          `在手机或第二台电脑上打开 http://${lanHosts()[0] || '这台机器的IP'}:${port} 时输它，就能在外面照样管理素材库；评审同事不需要口令。` +
            (ownerInfo.fromEnv ? ' 现在用的是环境变量 OWNER_TOKEN 指定的口令。' : ' 想固定：启动前设 OWNER_TOKEN=你的口令。')))
    : null;
  openScrim(h('div', { class: 'sheet sheet--sm' },
    h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow' }, '快捷键')),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'col', gap: '3' },
        rows.map(([key, label]) => h('div', { class: 'spread' }, h('kbd', null, key), h('span', { class: 'muted' }, label))),
        owner))));
}
qs('[data-action="help"]').addEventListener('click', shortcuts);

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return;
  if (e.key === '/') {
    e.preventDefault();
    mount('search').focus();
  }
  if (e.key.toLowerCase() === 'u') {
    e.preventDefault();
    folderInput.click();
  }
  if (e.key === '?') shortcuts();
});

// ── 实时：别人改了状态，卡片立刻刷新 ───────────────────────────────────────
let syncTimer = null;
connectSync({
  onEvent: (payload) => {
    if (payload.type === 'keepalive') return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => load().catch(() => paintServer('err')), 260);
  },
  onState: (live) => {
    const tag = mount('live');
    clear(tag);
    tag.append(h('span', { class: `dot ${live ? 'dot--live' : ''}` }), live ? '实时同步中' : '连接中断，正在重连');
    // 连上之后重新取一次在线页面数，别让顶栏停在首帧的 0
    if (live) ping();
  },
});

// 轮询一次健康检查，把服务信息摆到顶栏
async function ping() {
  try {
    const health = await api.health();
    lan = health.lan;
    viewers = health.viewers ?? 0;
    limits = health.limits ?? limits;
    mount('version').textContent = `LanReel v${health.version}`;
    if (health.local && !ownerAsked) {
      ownerAsked = true;
      ownerInfo = await api.owner().catch(() => null);
    }
    paintServer('ok');
  } catch {
    paintServer('err');
  }
}
ping();
setInterval(ping, 20000);

load().catch((err) => {
  toast(friendly(err.message), 'err');
  paintServer('err');
});
