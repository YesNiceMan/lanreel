// ── 评审网格：勾选 → 批量状态 → 点开写备注，素材库与分享页共用 ────────────
import { api } from './api.js';
import { STATUSES, STATUS_BY_KEY } from './statuses.js';
import { clear, fmtAgo, fmtBytes, fmtDur, friendly, h, hint, icon, naturalCompare, toast } from './dom.js';
import { openTheater } from './theater.js';

const KINDS = [
  { key: 'all', label: '全部' },
  { key: 'video', label: '视频' },
  { key: 'image', label: '图片' },
  { key: 'audio', label: '音频' },
  { key: 'other', label: '其他' },
];

const SORTS = [
  { key: 'name', label: '按名称', cmp: (a, b) => naturalCompare(a.relPath, b.relPath) },
  { key: 'newest', label: '最新入库', cmp: (a, b) => b.createdAt - a.createdAt || naturalCompare(a.relPath, b.relPath) },
  { key: 'size', label: '体积从大到小', cmp: (a, b) => b.size - a.size || naturalCompare(a.relPath, b.relPath) },
  { key: 'duration', label: '时长从长到短', cmp: (a, b) => (b.duration || 0) - (a.duration || 0) || naturalCompare(a.relPath, b.relPath) },
  { key: 'status', label: '按评审状态', cmp: (a, b) => rank(a.status) - rank(b.status) || naturalCompare(a.relPath, b.relPath) },
  { key: 'notes', label: '备注多的在前', cmp: (a, b) => b.notes.length - a.notes.length || naturalCompare(a.relPath, b.relPath) },
];

const ORDER = ['short', 'todo', 'revise', 'drop', 'unset'];
function rank(status) {
  const at = ORDER.indexOf(status);
  return at < 0 ? 99 : at;
}

const GLYPH = { video: 'film', image: 'image', audio: 'music', other: 'doc' };

export function createReview({ host, barHost, dockHost, actor, emptyText = '还没有素材' }) {
  const who = () => (typeof actor === 'function' ? actor() : actor) || '匿名';
  let items = [];
  let sortKey = 'name';
  let kind = 'all';
  let status = 'all';
  let query = '';
  let theater = null;
  let anchor = null;
  const selected = new Set();
  const nodes = new Map();

  // ── 工具栏 ────────────────────────────────────────────────────────────
  const chip = (label, isActive, onClick, extra) =>
    h('button', { class: 'filter', 'aria-pressed': String(isActive), onClick, type: 'button', ...extra }, label);

  const counter = h('span', { class: 'pill mono' });
  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: '搜索文件名…',
    'aria-label': '搜索素材',
    onInput: (e) => {
      query = e.target.value.trim().toLowerCase();
      render();
    },
  });

  const sortSelect = h(
    'select',
    {
      class: 'input',
      'aria-label': '排序方式',
      style: 'width:auto;padding-right:var(--space-6)',
      onChange: (e) => {
        sortKey = e.target.value;
        render();
      },
    },
    SORTS.map((s) => h('option', { value: s.key, selected: s.key === sortKey }, s.label)),
  );

  const kindRow = h('div', { class: 'filters' });
  const statusRow = h('div', { class: 'filters' });
  const countNodes = new Map();
  const selectAll = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, icon('check', 14), '全选可见');

  function paintCounts() {
    for (const [key, node] of countNodes) {
      node.textContent = String(items.filter((i) => i.status === key).length);
    }
  }

  function paintBar() {
    clear(kindRow);
    KINDS.forEach((k) => kindRow.append(chip(k.label, kind === k.key, () => {
      kind = k.key;
      paintBar();
      render();
    })));
    clear(statusRow);
    statusRow.append(chip('全部状态', status === 'all', () => {
      status = 'all';
      paintBar();
      render();
    }));
    STATUSES.filter((s) => s.key !== 'unset').concat(STATUS_BY_KEY.unset).forEach((s) => {
      const count = h('b', { class: 'mono', style: 'margin-left:.4em;color:var(--ink-40)' }, String(items.filter((i) => i.status === s.key).length));
      countNodes.set(s.key, count);
      statusRow.append(
        h('button', { class: 'filter', 'aria-pressed': String(status === s.key), type: 'button', onClick: () => {
          status = s.key;
          paintBar();
          render();
        } }, s.label, count),
      );
    });
  }

  barHost.append(
    h('div', { class: 'toolbar' },
      h('label', { class: 'search' }, icon('search', 16), searchInput),
      kindRow,
      statusRow,
      h('span', { class: 'grow' }),
      hint('点卡片左上角方框勾选；按住 Shift 再点可整段连选；⌘ / Ctrl + A 全选当前筛选结果；Esc 取消选择。批量状态在屏幕下方的操作坞里点。'),
      sortSelect,
      selectAll,
      counter),
  );

  selectAll.addEventListener('click', () => {
    const visible = filtered();
    const allOn = visible.length && visible.every((i) => selected.has(i.id));
    visible.forEach((i) => (allOn ? selected.delete(i.id) : selected.add(i.id)));
    anchor = allOn ? null : visible.at(-1)?.id ?? null;
    paintSelection();
  });

  /** 勾选状态统一回写：卡片复用 DOM 后必须靠它清掉残留的勾选 */
  function paintSelection() {
    for (const [id, node] of nodes) {
      const on = selected.has(id);
      node.dataset.pick = on ? 'on' : 'off';
      node.querySelector('.check')?.setAttribute('aria-checked', String(on));
    }
    paintDock();
    const visible = filtered();
    const allOn = visible.length > 0 && visible.every((i) => selected.has(i.id));
    selectAll.setAttribute('aria-pressed', String(allOn));
    clear(selectAll);
    selectAll.append(icon(allOn ? 'x' : 'check', 14), allOn ? '取消全选' : `全选可见 (${visible.length})`);
  }

  // ── 批量操作坞 ─────────────────────────────────────────────────────────
  const dockCount = h('span', { class: 'dock__count' }, '0');
  const dockStatuses = h('div', { class: 'cluster cluster-tight' });
  const dockClose = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, '取消选择');
  dockClose.addEventListener('click', () => {
    selected.clear();
    anchor = null;
    paintSelection();
  });

  STATUSES.filter((s) => s.key !== 'unset').concat(STATUS_BY_KEY.unset).forEach((s) => {
    dockStatuses.append(
      h('button', {
        class: 'btn btn--sm pick',
        type: 'button',
        style: `--tone:var(--status-${s.key})`,
        title: s.hint,
        onClick: () => applyStatus([...selected], s.key),
      }, s.label),
    );
  });

  dockHost.append(
    h('div', { class: 'cluster cluster-tight' }, dockCount, '条已选'),
    dockStatuses,
    dockClose,
  );

  function paintDock() {
    dockCount.textContent = String(selected.size);
    dockHost.dataset.open = selected.size > 0 ? 'true' : 'false';
  }

  async function applyStatus(ids, key) {
    if (!ids.length) return;
    const label = STATUS_BY_KEY[key]?.label ?? key;
    try {
      await api.setStatus(ids, key, who());
      const stamp = Date.now();
      const map = new Map(ids.map((id) => [id, true]));
      items = items.map((i) => (map.has(i.id) ? { ...i, status: key, statusBy: who(), statusAt: stamp } : i));
      if (key !== 'unset') {
        selected.clear();
        anchor = null;
      }
      render(key !== 'unset' ? [] : ids, { flashAll: true });
      paintSelection();
      toast(`已把 ${ids.length} 条标记为「${label}」，同网的人同步看到了`, 'ok');
    } catch (err) {
      toast(`状态没保存：${friendly(err.message)}`, 'err');
    }
  }

  // ── 卡片 ───────────────────────────────────────────────────────────────
  function filtered() {
    const sortCmp = SORTS.find((s) => s.key === sortKey)?.cmp ?? SORTS[0].cmp;
    return items
      .filter((item) => {
        if (kind !== 'all' && item.kind !== kind) return false;
        if (status !== 'all' && item.status !== status) return false;
        if (query && !`${item.relPath} ${item.name}`.toLowerCase().includes(query)) return false;
        return true;
      })
      .sort(sortCmp);
  }

  function thumbFor(item) {
    const glyph = h('span', { class: 'thumb__glyph' }, icon(GLYPH[item.kind] ?? 'doc', 30));
    if (item.missing) {
      return h('div', { class: 'thumb thumb--missing' },
        h('span', { class: 'thumb__glyph' }, icon('x', 30)),
        h('span', { class: 'thumb__lost' }, '源文件已丢失'));
    }
    const useImage = item.kind === 'image' || item.hasPoster;
    const inner = useImage
      ? h('img', {
          src: item.posterUrl || item.streamUrl,
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          onError: (e) => {
            e.target.replaceWith(glyph);
          },
        })
      : glyph;
    return h('div', { class: 'thumb' },
      inner,
      item.duration ? h('span', { class: 'thumb__dur' }, fmtDur(item.duration)) : null,
      h('span', { class: 'thumb__scan' }));
  }

  function card(item, index) {
    const checkbox = h(
      'button',
      {
        class: 'check',
        role: 'checkbox',
        type: 'button',
        'aria-checked': String(selected.has(item.id)),
        'aria-label': `选择 ${item.name}`,
        onClick: (e) => {
          e.stopPropagation();
          const visible = filtered();
          const at = visible.findIndex((i) => i.id === item.id);
          const from = anchor ? visible.findIndex((i) => i.id === anchor) : -1;
          if (e.shiftKey && from >= 0 && at >= 0) {
            // 连选：把锚点到当前之间全部选中（再按一次同区间则取消）
            const [a, b] = from <= at ? [from, at] : [at, from];
            const turnOn = !selected.has(item.id);
            for (let i = a; i <= b; i += 1) {
              if (turnOn) selected.add(visible[i].id);
              else selected.delete(visible[i].id);
            }
            paintSelection();
            return;
          }
          if (selected.has(item.id)) selected.delete(item.id);
          else selected.add(item.id);
          anchor = item.id;
          paintSelection();
        },
      },
      h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, h('path', { d: 'M5 13l4 4L19 7' })),
    );

    const pill = h('span', { class: `pill pill--status pill--${item.status}` }, STATUS_BY_KEY[item.status]?.label ?? '未标记');
    const node = h(
      'article',
      {
        class: 'card item',
        'data-id': item.id,
        role: 'button',
        tabindex: '0',
        'aria-label': `打开 ${item.name}`,
        style: `--tone:var(--status-${item.status});animation-delay:calc(var(--stagger) * ${Math.min(index, 11)})`,
        onClick: () => openAt(item.id),
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openAt(item.id);
          }
        },
      },
      h('span', { class: 'statusrail' }),
      h('div', { class: 'item__top' },
        checkbox,
        h('div', { class: 'item__badges' },
          pill,
          item.missing ? h('span', { class: 'pill pill--lost', title: '源目录里这个路径已经读不到了；文件放回原位后点「重新扫描」' }, '已丢失') : null)),
      thumbFor(item),
      h('div', { class: 'col', gap: '1' },
        h('h3', { class: 'item__name clip', title: item.relPath }, item.name),
        h('div', { class: 'item__row' },
          h('span', { class: 'mono' }, fmtBytes(item.size)),
          h('span', { class: 'grow clip dim' }, item.relPath.includes('/') ? item.relPath.split('/').slice(0, -1).join('/') : ''),
          item.notes.length
            ? h('span', { class: 'item__notes' }, icon('note', 13), String(item.notes.length))
            : null)),
      item.statusBy
        ? h('span', { class: 'item__who' }, icon('users', 12), `${item.statusBy} · ${fmtAgo(item.statusAt)}`)
        : null,
    );
    node.dataset.pick = selected.has(item.id) ? 'on' : 'off';
    return node;
  }

  function openAt(itemId) {
    const visible = filtered();
    const index = Math.max(0, visible.findIndex((i) => i.id === itemId));
    theater = openTheater({
      items: visible,
      index,
      actor: who(),
      onChange: (next) => applyPatch(next),
      onClose: () => {
        theater = null;
      },
    });
  }

  /** 增量更新：保留已有 DOM，动画只落在真正变化的卡片上 */
  function render(changedIds = [], { flashAll = false } = {}) {
    const visible = filtered();
    const seen = new Set();
    const fragment = document.createDocumentFragment();

    visible.forEach((item, index) => {
      seen.add(item.id);
      let node = nodes.get(item.id);
      const changed = flashAll || changedIds.includes(item.id);
      if (!node) {
        node = card(item, index);
        node.classList.add('anim-fade-up');
        nodes.set(item.id, node);
        fragment.append(node);
      } else {
        if (changed) {
          const fresh = card(item, index);
          node.replaceWith(fresh);
          nodes.set(item.id, fresh);
          fresh.classList.add('card--sync');
          setTimeout(() => fresh.classList.remove('card--sync'), 640);
        } else {
          nodes.get(item.id).style.animationDelay = `calc(var(--stagger) * ${Math.min(index, 11)})`;
        }
        fragment.append(nodes.get(item.id));
      }
    });

    for (const [id, node] of nodes) {
      if (!seen.has(id)) {
        node.remove();
        nodes.delete(id);
      }
    }

    clear(host);
    if (!visible.length) {
      host.append(h('div', { class: 'empty' }, icon('film', 28), h('p', null, items.length ? '没有符合筛选条件的素材' : emptyText)));
    } else {
      host.classList.add('grid', 'grid--tight');
      host.append(fragment);
    }

    counter.textContent = `${visible.length} / ${items.length}`;
    paintCounts();
    paintSelection();
    return visible;
  }

  function applyItems(next, changedIds = []) {
    items = next;
    for (const id of [...selected]) if (!next.some((i) => i.id === id)) selected.delete(id);
    paintDock();
    const visible = render(changedIds);
    if (theater) theater.refresh(visible, theater.currentId);
    return visible;
  }

  /** 单条补丁：本地或远端改了一条就重画那张卡（备注角标要跟着变），并同步放映厅 */
  function applyPatch(next) {
    const at = items.findIndex((i) => i.id === next.id);
    if (at < 0) return;
    items[at] = { ...items[at], ...next };
    const visible = render([next.id]);
    if (theater) theater.refresh(visible, next.id);
  }

  // 键盘：⌘/Ctrl+A 全选可见，Esc 取消选择；面板关掉后自动解绑
  const onKey = (e) => {
    if (!host.isConnected) {
      document.removeEventListener('keydown', onKey, true);
      return;
    }
    // 只有当网格处在最上层时才接管按键（放映厅盖在上面就让给它）
    const scrims = document.querySelectorAll('.scrim');
    const top = scrims[scrims.length - 1];
    if (top && !top.contains(host)) return;
    if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return;
    const visible = filtered();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && visible.length) {
      e.preventDefault();
      visible.forEach((i) => selected.add(i.id));
      anchor = visible.at(-1)?.id ?? null;
      paintSelection();
    }
    if (e.key === 'Escape' && selected.size) {
      selected.clear();
      anchor = null;
      paintSelection();
    }
  };
  document.addEventListener('keydown', onKey, true);

  // 在弹层里时，Esc 先清空选择，再按一次才关面板
  host.closest('.sheet')?.addEventListener('escape', (e) => {
    if (!selected.size) return;
    e.preventDefault();
    selected.clear();
    anchor = null;
    paintSelection();
  });

  paintBar();
  paintDock();

  return {
    setItems: applyItems,
    patch: applyPatch,
  };
}
