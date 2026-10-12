// ── 放映厅：播放 + 状态标记 + 备注，一个弹层搞定 ─────────────────────────
import { api } from './api.js';
import { STATUSES } from './statuses.js';
import { clear, fmtAgo, fmtBytes, fmtDur, fmtTime, friendly, h, hint, icon, initialOf, openScrim, put, qs, qsa, toast } from './dom.js';

const TEXTUAL = new Set(['txt', 'md', 'csv', 'json', 'xml', 'vtt', 'srt', 'ass', 'lrc']);

function mediaStage(item) {
  if (item.missing) {
    return h('div', { class: 'col', style: 'align-items:center;gap:var(--space-4);max-width:44ch;text-align:center' },
      h('div', { class: 'thumb__glyph', style: 'position:static;font-size:3rem' }, icon('x', 64)),
      h('b', null, '源文件已丢失'),
      h('p', { class: 'muted', style: 'font-size:var(--text-sm)' },
        `库里登记的这个位置读不到文件了：${item.relPath}。素材被移动、改名或外接盘断开都会这样。`),
      h('p', { class: 'dim', style: 'font-size:var(--text-2xs)' }, '文件放回原位后，机主在素材夹卡片上点「重新扫描」即可恢复；已写的状态与备注不会丢。'));
  }
  if (item.kind === 'video') {
    return h('video', {
      controls: true,
      preload: 'metadata',
      playsInline: true,
      poster: item.posterUrl || undefined,
      src: item.streamUrl,
      'aria-label': item.name,
    });
  }
  if (item.kind === 'audio') {
    return h('div', { class: 'col', style: 'width:100%' },
      h('div', { class: 'thumb__glyph', style: 'position:static;height:30vh;font-size:3rem' }, icon('music', 64)),
      h('audio', { controls: true, preload: 'metadata', src: item.streamUrl, style: 'width:100%' }));
  }
  if (item.kind === 'image') {
    return h('img', { src: item.streamUrl, alt: item.name });
  }
  if (item.ext === 'pdf') {
    return h('iframe', { src: item.streamUrl, title: item.name, style: 'width:100%;height:62vh;border:0;border-radius:var(--radius-md);background:#fff' });
  }
  if (TEXTUAL.has(item.ext)) {
    const box = h('pre', {
      class: 'mono',
      style: 'width:100%;max-height:60vh;overflow:auto;margin:0;padding:var(--space-5);background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-md);white-space:pre-wrap',
      text: '正在读取…',
    });
    fetch(item.streamUrl)
      .then((r) => r.text())
      .then((t) => {
        box.textContent = t.length > 200000 ? `${t.slice(0, 200000)}\n\n… 仅显示前 200KB` : t;
      })
      .catch(() => {
        box.textContent = '无法预览该文件';
      });
    return box;
  }
  return h('div', { class: 'col', style: 'align-items:center;gap:var(--space-4)' },
    h('div', { class: 'thumb__glyph', style: 'position:static;font-size:3rem' }, icon('archive', 64)),
    h('p', { class: 'muted' }, '这类文件不支持在线预览，可直接下载到本机查看'),
    h('a', { class: 'btn btn--primary', href: `${item.streamUrl}?download=1`, download: item.name }, icon('download'), '下载文件'));
}

function statusRow(item, onSet) {
  const buttons = STATUSES.filter((s) => s.key !== 'unset').map((s) =>
    h(
      'button',
      {
        class: 'btn btn--sm pick',
        style: `--tone:var(--status-${s.key})`,
        'aria-pressed': String(item.status === s.key),
        title: s.hint,
        onClick: () => onSet(s.key),
      },
      item.status === s.key ? icon('check', 14) : null,
      s.label,
    ),
  );
  return h(
    'div',
    { class: 'col', gap: '3' },
    h('div', { class: 'spread' }, h('span', { class: 'eyebrow' }, '评审状态'),
      item.status !== 'unset'
        ? h('button', { class: 'btn btn--ghost btn--sm', onClick: () => onSet('unset') }, '清除标记')
        : null),
    h('div', { class: 'cluster cluster-tight' }, buttons),
    item.statusBy
      ? h('span', { class: 'item__who', style: '--tone:var(--ink-40)' }, icon('users', 13), `${item.statusBy} · ${fmtAgo(item.statusAt)}`)
      : null,
  );
}

function notesPanel(item, { actor, onAdd, onDelete, onSeek, getPlayhead, timeable }) {
  const input = h('textarea', {
    class: 'textarea',
    placeholder: '写下这条的问题、替换建议或剪辑说明…（Ctrl/⌘ + Enter 提交）',
    onKeydown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    },
  });

  // undefined = 跟随播放头；number = 手动钉住；null = 明确不带时间点
  let pinned;
  const chipLabel = h('span');
  const chip = h('button', {
    class: 'tc',
    type: 'button',
    title: '点击改为当前播放位置',
    onClick: () => {
      pinned = getPlayhead();
      syncChip();
    },
  }, icon('clock', 12), chipLabel);
  const chipClear = h('button', {
    class: 'btn btn--icon btn--ghost btn--sm',
    type: 'button',
    title: '这条备注不关联时间点',
    onClick: () => {
      pinned = null;
      syncChip();
      input.focus();
    },
  }, icon('x', 12));

  function syncChip() {
    if (!timeable) return;
    const at = pinned === undefined ? getPlayhead() : pinned;
    const live = pinned === undefined;
    chip.classList.toggle('tc--live', live);
    chipLabel.textContent = at ? `@ ${fmtDur(at)}` : '@ 0:00';
    chip.title = live ? '将记录当前播放位置，点击可重新取点' : '已钉住该时间点，点击改为当前播放位置';
    chipClear.hidden = at === null;
  }

  const list = h('div', { class: 'col', gap: '3' });

  const render = (notes) => {
    clear(list);
    if (!notes.length) {
      list.append(h('p', { class: 'dim', style: 'font-size:var(--text-sm)' }, '还没有备注'));
      return;
    }
    notes
      .slice()
      .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || a.createdAt - b.createdAt)
      .forEach((note, i) => {
        list.append(
          h(
            'div',
            { class: 'note', 'data-note': note.id, style: `animation-delay:calc(var(--stagger) * ${Math.min(i, 6)})` },
            h('span', { class: 'avatar avatar--sm', title: note.author }, initialOf(note.author)),
            h(
              'div',
              { class: 'col' },
              h('div', { class: 'spread' },
                note.t == null
                  ? h('span', { class: 'dim', style: 'font-size:var(--text-2xs)' }, '整体备注')
                  : h('button', {
                      class: 'pill pill--time mono',
                      type: 'button',
                      title: '跳到该时间点并暂停',
                      onClick: () => onSeek(note.t, note.id),
                    }, icon('play', 10), fmtDur(note.t)),
                h('span', { class: 'dim mono', title: fmtTime(note.createdAt) }, fmtAgo(note.createdAt))),
              h('p', {
                onClick: note.t == null ? null : () => onSeek(note.t, note.id),
                title: note.t == null ? null : '跳到该时间点',
                style: note.t == null ? null : 'cursor:pointer',
              }, note.text),
              note.author === actor
                ? h('div', {}, h('button', { class: 'btn btn--danger btn--sm', onClick: () => onDelete(note) }, '删除'))
                : null,
            ),
          ),
        );
      });
  };

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    const at = pinned === undefined ? getPlayhead() : pinned;
    const ok = await onAdd(text, timeable && at ? Math.round(at * 10) / 10 : null);
    // 保存成功才清空，失败时把话留在框里，别让人白打一遍
    if (ok !== false) {
      input.value = '';
      pinned = undefined;
      syncChip();
    }
  };

  const composer = h('div', { class: 'col', gap: '2' },
    timeable ? h('div', { class: 'cluster cluster-tight' }, chip, chipClear) : null,
    input,
    h('div', { class: 'cluster' },
      h('button', { class: 'btn btn--primary btn--sm', onClick: submit }, icon('plus', 14), '提交备注'),
      h('span', { class: 'dim', style: 'font-size:var(--text-2xs)' }, '以', h('b', null, actor), '的身份记录')));

  syncChip();

  return {
    node: h('div', { class: 'col', gap: '4' },
      h('div', { class: 'spread' }, h('span', { class: 'eyebrow' }, `备注 · ${item.notes.length}`),
        h('span', { class: 'dim', style: 'font-size:var(--text-2xs)' }, '同网可见')),
      list,
      composer),
    render,
    syncChip,
  };
}

export function openTheater({ items, index = 0, actor, onChange, onClose }) {
  const state = { items, index };
  let autoplay = false;
  let video = null;
  let panel = null;

  const shell = h('div', { class: 'sheet', style: 'width:min(100%,78rem)' });
  const media = h('div', { class: 'stage__media' });
  const timeline = h('div', { class: 'timeline', hidden: true });
  const side = h('div', { class: 'stage__side' });
  const titleEl = h('h3', { class: 'clip', style: 'max-width:46ch' });
  const metaEl = h('div', { class: 'cluster cluster-tight dim', style: 'font-size:var(--text-2xs)' });
  const footEl = h('div', { class: 'sheet-foot' });

  const current = () => state.items[state.index];
  const durationOf = () => Number(current()?.duration) || (video && Number.isFinite(video.duration) ? video.duration : 0);
  const timeable = () => current()?.kind === 'video' || current()?.kind === 'audio';
  const getPlayhead = () => (video && Number.isFinite(video.currentTime) ? video.currentTime : 0);

  /** 跳到备注时间点并暂停，方便边看备注边核对画面 */
  function seekTo(seconds, noteId) {
    const at = Number(seconds) || 0;
    if (video) {
      video.pause();
      video.currentTime = at;
    }
    if (noteId) {
      qsa('.note--active', side).forEach((n) => n.classList.remove('note--active'));
      qsa(`[data-note="${noteId}"]`, side).forEach((n) => {
        n.classList.add('note--active');
        n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }

  const setStatus = async (key) => {
    const item = current();
    try {
      await api.setStatus([item.id], key, actor);
      onChange?.({ ...item, status: key, statusBy: actor, statusAt: Date.now() });
    } catch (err) {
      toast(`状态没保存：${friendly(err.message)}`, 'err');
    }
  };

  const add = async (text, seconds = null) => {
    const item = current();
    try {
      const note = await api.addNote(item.id, text, actor, seconds);
      const next = { ...item, notes: [...item.notes, note] };
      panel?.render(next.notes);
      renderTimeline(next);
      onChange?.(next);
      toast(`备注已记录${note.t != null ? ` @ ${fmtDur(note.t)}` : ''}，同网的人同步看到了`, 'ok');
      return true;
    } catch (err) {
      toast(`备注没保存：${friendly(err.message)}（内容还留在输入框里）`, 'err', 5200);
      return false;
    }
  };

  const drop = async (note) => {
    const item = current();
    try {
      await api.deleteNote(item.id, note.id, actor);
      const next = { ...item, notes: item.notes.filter((n) => n.id !== note.id) };
      panel?.render(next.notes);
      renderTimeline(next);
      onChange?.(next);
    } catch (err) {
      toast(`备注没删除：${friendly(err.message)}`, 'err');
    }
  };

  /** 进度条下方的一条备注刻度：点一下跳到那个时间点 */
  function renderTimeline(item) {
    clear(timeline);
    const duration = durationOf();
    const marks = (item.notes ?? []).filter((n) => n.t != null && duration > 0);
    timeline.hidden = !marks.length;
    if (!marks.length) return;
    timeline.title = '备注时间点';
    marks.forEach((note) => {
      timeline.append(
        h('button', {
          class: 'timeline__tick',
          type: 'button',
          style: `left:${Math.min(100, (note.t / duration) * 100)}%`,
          title: `${fmtDur(note.t)} · ${note.author}：${note.text.slice(0, 40)}`,
          'aria-label': `跳到 ${fmtDur(note.t)} 的备注`,
          onClick: () => seekTo(note.t, note.id),
        }),
      );
    });
  }

  function paintMedia(item) {
    clear(media);
    media.append(h('div', { class: 'anim-fade-up', style: 'width:100%;display:grid;place-items:center;gap:var(--space-3)' }, mediaStage(item), timeline));
    video = qs('video, audio', media);
    if (video) {
      video.addEventListener('ended', () => {
        if (autoplay && state.index < state.items.length - 1) go(1);
      });
      video.addEventListener('timeupdate', () => panel?.syncChip());
      video.addEventListener('loadedmetadata', () => renderTimeline(item));
    }
    renderTimeline(item);
  }

  function go(delta) {
    const next = state.index + delta;
    if (next < 0 || next >= state.items.length) return;
    state.index = next;
    render();
  }

  function renderHead(item) {
    titleEl.textContent = item.relPath || item.name;
    titleEl.title = item.name;
    clear(metaEl);
    put(
      metaEl,
      h('span', { class: 'pill' }, item.ext.toUpperCase() || item.kind),
      h('span', { class: 'pill' }, fmtBytes(item.size)),
      item.duration ? h('span', { class: 'pill' }, fmtDur(item.duration)) : null,
      item.width ? h('span', { class: 'pill' }, `${item.width}×${item.height}`) : null,
      h('span', { class: 'pill' }, `${state.index + 1}/${state.items.length}`),
    );
  }

  /** 侧栏整块重绘，但保住正在写的草稿与焦点（别人的备注随时可能推过来） */
  function renderSide(item) {
    const box = qs('textarea', side);
    const draft = box?.value ?? '';
    const hadFocus = Boolean(box) && box === document.activeElement;
    clear(side);
    panel = notesPanel(item, {
      actor,
      onAdd: add,
      onDelete: drop,
      onSeek: seekTo,
      getPlayhead,
      timeable: timeable(),
    });
    panel.render(item.notes);
    side.append(
      h('div', { class: 'col', gap: '2' },
        h('div', { class: 'spread' },
          h('span', { class: 'eyebrow' }, '正在放映'),
          h('div', { class: 'cluster cluster-tight' },
            h('button', { class: 'btn btn--icon btn--ghost', title: '上一条 (←)', onClick: () => go(-1) }, icon('prev')),
            h('button', { class: 'btn btn--icon btn--ghost', title: '下一条 (→)', onClick: () => go(1) }, icon('next')),
            item.missing ? null : h('a', { class: 'btn btn--icon btn--ghost', href: `${item.streamUrl}?download=1`, download: item.name, title: '下载' }, icon('download')),
          )),
        titleEl,
        metaEl),
      statusRow(item, setStatus),
      panel.node,
    );
    if (draft) {
      const next = qs('textarea', side);
      next.value = draft;
      if (hadFocus) next.focus();
    }
  }

  let shownId = null;

  function render({ forceMedia = false } = {}) {
    const item = current();
    if (!item) return controller.close();
    // 同一条素材只是改了状态/备注时不重建播放器，否则正看着的画面会被打断
    const sameItem = shownId === item.id && !forceMedia;
    shownId = item.id;
    renderHead(item);
    renderSide(item);
    if (sameItem) renderTimeline(item);
    else paintMedia(item);
    renderFoot(item);
  }

  function renderFoot(item) {
    clear(footEl);
    const toggle = h('button', {
      class: 'switch',
      role: 'switch',
      'aria-checked': String(autoplay),
      onClick: () => {
        autoplay = !autoplay;
        toggle.setAttribute('aria-checked', String(autoplay));
      },
    }, '连续播放');
    put(
      footEl,
      toggle,
      hint('← / → 切换素材 · Space 播放暂停 · 1-4 打状态 · 0 清除 · N 写备注（备注自动带上当前时间点）'),
      h('span', { class: 'grow' }),
      item.notes.length ? h('span', { class: 'pill pill--accent' }, `${item.notes.length} 条备注`) : null,
    );
  }

  shell.append(
    h('div', { class: 'sheet-head' },
      h('div', { class: 'cluster cluster-tight' }, icon('film', 18), h('b', { class: 'eyebrow' }, '放映厅')),
      h('button', { class: 'btn btn--icon btn--ghost', title: '关闭 (Esc)', onClick: () => controller.close() }, icon('x'))),
    h('div', { class: 'stage' }, media, side),
    footEl,
  );

  const controller = openScrim(shell, {
    onClose,
  });

  const onKey = (e) => {
    if (e.target instanceof HTMLElement && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
    if (e.key === ' ' && video) {
      e.preventDefault();
      video.paused ? video.play() : video.pause();
    }
    if (e.key.toLowerCase() === 'n') {
      e.preventDefault();
      qs('textarea', side)?.focus();
    }
    const num = Number(e.key);
    if (num >= 1 && num <= 4) setStatus(STATUSES[num].key);
    if (e.key === '0') setStatus('unset');
  };
  document.addEventListener('keydown', onKey);
  const origClose = controller.close;
  controller.close = () => {
    document.removeEventListener('keydown', onKey);
    origClose();
  };

  render();

  return {
    ...controller,
    get currentId() {
      return current()?.id;
    },
    /** 外部（SSE）更新后刷新：还是同一条素材就只重画侧栏，播放器不动 */
    refresh(nextItems, keepId) {
      state.items = nextItems;
      const at = nextItems.findIndex((i) => i.id === keepId);
      if (at >= 0) state.index = at;
      else if (state.index >= nextItems.length) state.index = Math.max(0, nextItems.length - 1);
      render();
    },
  };
}
