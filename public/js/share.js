// ── 分享页：局域网同事的观影 + 评审入口 ───────────────────────────────────
import { api, setShareScope } from './api.js';
import { clear, closeAllTips, fmtAgo, fmtBytes, fmtTotalDur, h, icon, initHints, progressRing, put, qs, statusTally, toast } from './dom.js';
import { statusLabel } from './statuses.js';
import { createReview } from './review.js';
import { connectSync } from './sync.js';
import { askName, getActor, paintNameButton } from './identity.js';

const mount = (name) => qs(`[data-mount="${name}"]`);
const root = document.documentElement;
const TOKEN = decodeURIComponent((location.pathname.match(/^\/s\/([^/?#]+)/) || [])[1] || '');
setShareScope(TOKEN);
const actor = () => getActor() || '匿名同事';

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

let review = null;
let bundle = null;
let sync = null;
let liveNow = false;

function paintHead() {
  const s = bundle.stats;
  const pct = Math.round((s.reviewed / Math.max(1, s.total)) * 100);
  const noteCount = bundle.items.reduce((sum, i) => sum + i.notes.length, 0);
  clear(mount('head'));
  put(mount('head'),
    h('div', { class: 'col' },
      h('div', { class: 'cluster cluster-tight' },
        h('span', { class: 'eyebrow' }, '局域网共享中'),
        bundle.expiresAt ? h('span', { class: 'pill' }, `${fmtAgo(bundle.expiresAt)}后过期`) : null),
      h('h1', { class: 'sharehead__title' }, bundle.name),
      bundle.description ? h('p', { class: 'muted', style: 'max-width:60ch' }, bundle.description) : null),
    h('div', { class: 'sharehead__meta' },
      h('span', { class: 'livetag', 'data-live': String(liveNow) },
        h('span', { class: `dot ${liveNow ? 'dot--live' : ''}` }), liveNow ? '实时同步中' : '连接中断，正在重连'),
      h('span', { class: 'pill' }, `${s.total} 个素材`),
      s.videos ? h('span', { class: 'pill' }, `${s.videos} 视频`) : null,
      s.duration ? h('span', { class: 'pill' }, fmtTotalDur(s.duration)) : null,
      h('span', { class: 'pill', title: '源文件体积，直接从这个地址流式读取' }, fmtBytes(s.bytes)),
      h('span', { class: 'pill' }, `已评审 ${s.reviewed}/${s.total}`),
      noteCount ? h('span', { class: 'pill pill--accent', title: `${s.noted} 个素材上共 ${noteCount} 条备注` }, `${noteCount} 条备注`) : null,
      s.missing ? h('span', { class: 'pill pill--lost' }, `${s.missing} 个源文件已丢失`) : null,
      progressRing(pct, '评审完成度')),
    statusTally(s),
  );
  document.title = `${bundle.name} · LanReel 放映中`;
}

function fail(message) {
  clear(mount('head'));
  clear(mount('bar'));
  clear(mount('grid'));
  put(mount('head'),
    h('div', { class: 'empty' },
      icon('x', 30),
      h('h2', null, '这个链接打不开了'),
      h('p', null, message),
      h('a', { class: 'btn btn--primary', href: '/' }, '回到素材库')),
  );
}

/** 别人刚改了状态/备注，给一条不抢戏的提示 */
function noteActivity(payload) {
  if (!payload?.actor) return;
  if (payload.action === 'note') toast(`${payload.actor} 加了一条备注`, 'info', 2200);
  if (payload.action === 'status') toast(`${payload.actor} 把 ${payload.count || 1} 条标记为「${statusLabel(payload.status)}」`, 'info', 2200);
}

/** 素材库只在本机管理；访客页面上不该留着那扇门 */
async function hideLibraryEntry() {
  try {
    const health = await api.health();
    // 机主（本机或已输口令）保留回素材库的入口；老服务端没 owner 字段时退回 local 判断
    if (health.owner === true || health.local !== false) return;
  } catch {
    return;
  }
  for (const link of document.querySelectorAll('a[href="/"]')) {
    if (link.classList.contains('brand')) link.removeAttribute('href');
    else link.remove();
  }
}

async function refresh(changedIds = []) {
  const fresh = await api.share(TOKEN);
  bundle = fresh;
  paintHead();
  review?.setItems(fresh.items, changedIds);
}

async function boot() {
  if (!TOKEN) return fail('链接里缺少分享码，请让同事重新发一条以 /s/ 开头的地址。');
  try {
    bundle = await api.share(TOKEN);
  } catch (err) {
    return fail(err.message);
  }
  paintHead();

  review = createReview({
    host: mount('grid'),
    barHost: mount('bar'),
    dockHost: mount('dock'),
    actor,
    emptyText: '这个素材夹还是空的，等同事放点东西进来再刷新',
  });
  review.setItems(bundle.items);

  sync = connectSync({
    ref: bundle.id,
    onEvent: (payload) => {
      if (payload.type === 'keepalive') return;
      refresh(payload.itemId ? [payload.itemId] : []).then(() => noteActivity(payload));
    },
    onState: (live) => {
      liveNow = live;
      const tag = mount('live-status');
      clear(tag);
      tag.append(h('span', { class: `dot ${live ? 'dot--live' : ''}` }), live ? '同网实时同步' : '连接中断，正在重连');
      if (bundle) paintHead();
    },
  });

  if (!getActor()) askName(qs('[data-action="who"]'), true);
  hideLibraryEntry();
}

// 骨架屏：等真实数据回来
mount('grid').append(
  ...Array.from({ length: 8 }, () =>
    h('div', { class: 'card item' }, h('div', { class: 'thumb thumb--skeleton' }), h('div', { class: 'progress' }, h('i')))),
);

boot();
