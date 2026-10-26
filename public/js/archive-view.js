// ── 评审档案：机主的对账视图。素材夹撤下之后，这里仍然查得到谁说过什么 ────────
import { api } from './api.js';
import { clear, closeAllTips, fmtAgo, fmtTime, friendly, h, icon, initHints, naturalCompare, put, qs, toast } from './dom.js';
import { ARCHIVE_KINDS, ARCHIVE_OPS, KIND_LABEL, OP_LABEL } from './archive-labels.js';

const mount = (name) => qs(`[data-mount="${name}"]`);
const root = document.documentElement;

let bundles = [];
let footprint = { bundles: 0, unlisted: 0, records: 0, posters: 0 };
let dir = 'data/archive/';
let current = '';
let detail = null;
let onlyArchived = false;
const filters = { who: '', op: '', q: '' };

// ── 主题 ──────────────────────────────────────────────────────────────────
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
initHints();
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tip')) closeAllTips();
});

// ── 小零件 ────────────────────────────────────────────────────────────────
const hhmm = (ts) => {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function whoBadge(actor) {
  const kind = ARCHIVE_KINDS[actor?.kind];
  const name = actor?.name || '匿名';
  const label = KIND_LABEL(actor?.kind ?? '');
  // 「机主 · 机主」这种重复不写两遍；身份只在能补充信息时才出现
  const showKind = label && label !== name;
  return h('span', { class: 'cluster cluster-tight' },
    h('b', { class: 'arch-row__who' }, name),
    showKind
      ? h('span', {
          class: `dim ${actor?.verified ? '' : 'arch-row__unverified'}`,
          style: 'font-size:var(--text-2xs)',
          title: kind?.hint ?? '',
        }, `${label}${actor?.verified ? '' : ' · 未验证'}`)
      : null);
}

function thumb(rec) {
  if (!rec.item || !current) return null;
  // 撤下归档时保下来的封面；还在映的夹子没有搬到档案里，img 自己会 404 然后被换掉
  const img = h('img', {
    class: 'arch-row__thumb',
    src: api.archivePosterHref(current, rec.item.id),
    alt: '',
    loading: 'lazy',
    onError: (e) => e.target.remove(),
  });
  return img;
}

function recordRow(rec) {
  const meta = ARCHIVE_OPS[rec.op] ?? { label: OP_LABEL(rec.op), ico: 'doc' };
  return h('div', { class: 'arch-row' },
    h('span', { class: 'mono dim arch-row__time', title: fmtTime(rec.at) }, hhmm(rec.at)),
    h('span', { class: 'arch-row__mark', 'data-op': rec.op }, icon(meta.ico, 15)),
    h('div', { class: 'col', gap: '1', style: 'min-width:0' },
      h('div', { class: 'cluster cluster-tight' },
        h('b', null, meta.label),
        whoBadge(rec.actor),
        rec.item ? h('span', { class: 'clip arch-row__item', title: rec.item.relPath || rec.item.name }, rec.item.name) : null,
        rec.data?.legacy ? h('span', { class: 'pill', title: '升级前从素材夹内部回灌出来的记录' }, '旧库') : null),
      h('p', { class: 'muted arch-row__text' }, rec.summary ?? '')),
    thumb(rec));
}

// ── 左列：夹子 ────────────────────────────────────────────────────────────
function bundleCard(item) {
  const card = h('button', {
    class: 'card arch-card',
    type: 'button',
    dataset: { pick: item.bundleId === current ? 'on' : '' },
    onClick: () => openArchive(item.bundleId),
  },
    h('div', { class: 'spread' },
      h('h3', { class: 'clip arch-card__title', title: item.name }, item.name),
      item.unlistedAt
        ? h('span', { class: 'pill pill--accent', title: `撤下于 ${fmtTime(item.unlistedAt)}，记录与封面留在档案里` }, `已撤下 ${fmtAgo(item.unlistedAt)}`)
        : h('span', { class: 'pill pill--ok' }, '在映')),
    h('div', { class: 'cluster cluster-tight dim', style: 'font-size:var(--text-2xs)' },
      h('span', null, `${item.records} 条记录`),
      item.people.length ? h('span', null, `${item.people.length} 个人`) : null,
      item.posters ? h('span', null, `${item.posters} 张封面`) : null,
      h('span', { title: item.root || '' }, item.mode === 'reference' ? '挂载' : '复制入库'),
      h('span', null, `最近 ${fmtAgo(item.lastAt)}`)),
    item.people.length
      ? h('div', { class: 'chips' }, ...item.people.slice(0, 5).map((p) => h('span', {
          class: 'pill',
          title: `${KIND_LABEL(p.kind)} · ${p.records} 条 · 最近 ${fmtAgo(p.lastAt)}${p.verified ? '' : ' · 名字未经验证'}`,
        }, p.name)))
      : null);
  return card;
}

function paintList() {
  const host = mount('list');
  clear(host);
  const list = bundles.filter((b) => !onlyArchived || b.unlistedAt);
  if (!list.length) {
    host.append(h('div', { class: 'empty' }, icon('archive', 28), h('p', null, '档案里还没有东西')));
    return;
  }
  host.append(...list.map(bundleCard));
}

function paintFootprint() {
  const stats = footprint;
  put(mount('footprint'),
    h('span', { class: 'pill' }, `${stats.bundles} 个夹子`),
    h('span', { class: 'pill pill--accent' }, `${stats.records} 条记录`),
    stats.unlisted ? h('span', { class: 'pill' }, `${stats.unlisted} 个已撤下`) : null,
    stats.posters ? h('span', { class: 'pill' }, `${stats.posters} 张封面`) : null);
  mount('storage').textContent = dir
    ? `档案目录 ${dir} · ${stats.records} 条记录只追加、不覆写`
    : `${stats.records} 条记录只追加、不覆写 · 这里只有你自己名下的档案`;
}

// ── 右列：时间线 ──────────────────────────────────────────────────────────
function paintDetail() {
  const host = mount('detail');
  clear(host);
  if (!detail) {
    host.append(h('div', { class: 'empty' }, icon('archive', 30), h('p', null, '左边挑一个素材夹，看它从头到尾的评审记录。')));
    return;
  }
  const csv = api.archiveExportHref(detail.bundleId, 'csv', filters);
  const json = api.archiveExportHref(detail.bundleId, 'json', filters);
  const filtered = detail.records.length !== (bundles.find((b) => b.bundleId === detail.bundleId)?.records ?? 0);
  host.append(
    h('div', { class: 'arch-detail__head' },
      h('div', { class: 'col', gap: '1', style: 'min-width:0' },
        h('div', { class: 'cluster cluster-tight' },
          h('span', { class: 'eyebrow' }, '评审档案'),
          detail.unlistedAt ? h('span', { class: 'pill pill--accent' }, '已撤下归档') : null,
          filtered ? h('span', { class: 'pill pill--info' }, `筛选后 ${detail.records.length} 条`) : null),
        h('h2', { class: 'panel-title clip' }, detail.name),
        detail.root ? h('p', { class: 'dim mono', style: 'font-size:var(--text-2xs)' }, detail.root) : null),
      h('div', { class: 'cluster cluster-tight' },
        h('a', { class: 'btn btn--sm', href: csv }, icon('download', 14), '档案 CSV'),
        h('a', { class: 'btn btn--sm btn--quiet', href: json, title: '含每条记录的原始字段与素材快照' }, icon('doc', 14), '完整 JSON'))),
    detail.records.length
      ? h('div', { class: 'arch-rows' }, ...detail.records.map(recordRow))
      : h('div', { class: 'empty' }, icon('search', 26), h('p', null, '这些条件下没有记录，换个筛选试试')),
  );
}

async function openArchive(ref) {
  current = ref;
  paintList();
  try {
    detail = await api.archiveRecords(ref, filters);
  } catch (err) {
    detail = null;
    toast(friendly(err.message), 'err');
    return;
  }
  paintDetail();
}

// ── 筛选控件 ──────────────────────────────────────────────────────────────
function paintSelects() {
  const whoSel = qs('[data-ref="who"]');
  const opSel = qs('[data-ref="op"]');
  const people = [...new Set(bundles.flatMap((b) => b.people.map((p) => p.name)))];
  const ops = [...new Set(bundles.flatMap((b) => Object.keys(b.counts ?? {})))].sort(naturalCompare);
  clear(whoSel).append(h('option', { value: '' }, '全部的人'), ...people.map((name) => h('option', { value: name }, name)));
  clear(opSel).append(h('option', { value: '' }, '全部操作'), ...ops.map((key) => h('option', { value: key }, OP_LABEL(key))));
  whoSel.value = filters.who;
  opSel.value = filters.op;
}

qs('[data-ref="who"]').addEventListener('change', (e) => {
  filters.who = e.target.value;
  if (current) openArchive(current);
});
qs('[data-ref="op"]').addEventListener('change', (e) => {
  filters.op = e.target.value;
  if (current) openArchive(current);
});
let searchTimer = null;
qs('[data-ref="q"]').addEventListener('input', (e) => {
  filters.q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (current) openArchive(current);
  }, 260);
});
qs('[data-action="only-archived"]').addEventListener('click', (e) => {
  onlyArchived = !onlyArchived;
  e.currentTarget.setAttribute('aria-pressed', String(onlyArchived));
  paintList();
});

// ── 装载 ──────────────────────────────────────────────────────────────────
async function load() {
  const data = await api.archiveBundles();
  bundles = data.bundles;
  footprint = data.footprint ?? footprint;
  dir = data.dir ?? dir;
  paintFootprint();
  paintSelects();
  paintList();
  // 首页「看评审档案」带 ?bundle= 跳过来，直接展开那一个夹子
  const wanted = new URLSearchParams(location.search).get('bundle');
  const target = current || (bundles.some((b) => b.bundleId === wanted) ? wanted : bundles[0]?.bundleId) || '';
  if (!target) return paintDetail();
  await openArchive(target);
}

async function ping() {
  try {
    const health = await api.health();
    mount('version').textContent = `LanReel v${health.version}`;
    if (!health.owner && !health.member) {
      put(mount('scope'), h('span', { class: 'pill pill--drop' }, '档案只对机主与建下夹子的人开放'));
    } else if (health.member) {
      put(mount('scope'), h('span', { class: 'pill pill--accent' }, `以 ${health.member.name || '成员'} 的身份 · 只看自己的档案`));
    }
  } catch {
    /* 服务没起来时下面 load() 会报错，不必重复提醒 */
  }
}

ping();
load().catch((err) => {
  mount('list').append(h('div', { class: 'empty' }, icon('x', 28), h('p', null, friendly(err.message))));
});
