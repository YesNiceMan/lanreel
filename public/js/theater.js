// ── 放映厅：播放 + 状态标记 + 备注，一个弹层搞定 ─────────────────────────
import { api } from './api.js';
import { STATUSES } from './statuses.js';
import { clear, fmtAgo, fmtBytes, fmtDur, fmtTime, friendly, h, hint, icon, initialOf, openScrim, put, qs, qsa, toast } from './dom.js';

const TEXTUAL = new Set(['txt', 'md', 'csv', 'json', 'xml', 'vtt', 'srt', 'ass', 'lrc']);

/** 访客拿到的地址已经带 ?t=<分享码>，追加参数得改用 & */
const withParam = (url, kv) => `${url}${String(url).includes('?') ? '&' : '?'}${kv}`;

// ── 播放条参数 ────────────────────────────────────────────────────────────
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8];
/** J / L 连按时的倍速阶梯，跟 NLE 习惯一致：一倍 → 二倍 → 四倍 → 八倍 */
const RAMP = [1, 2, 4, 8];
const DEFAULT_FPS = 25;
/** 吸附阈值按像素换算成秒，轨道越长吸附越紧 */
const SNAP_PX = 8;
const VOL_KEY = 'lr_volume';
/** itemId → 实测帧率；库里没存 fps，只能播起来用 requestVideoFrameCallback 测 */
const fpsCache = new Map();

function fmtCode(seconds, fps) {
  const t = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(t);
  const frames = Math.min(Math.max(fps, 1) - 1, Math.max(0, Math.floor((t - whole) * fps + 0.01)));
  return `${fmtDur(whole)}:${String(Math.round(frames)).padStart(2, '0')}`;
}

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
    // 不用原生 controls：播放条由 buildTransport 自绘，时间点刻度要跟备注/标记同一条轨道
    return h('video', {
      controls: false,
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
      h('audio', { controls: false, preload: 'metadata', src: item.streamUrl, style: 'width:100%' }));
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
    h('a', { class: 'btn btn--primary', href: withParam(item.streamUrl, 'download=1'), download: item.name }, icon('download'), '下载文件'));
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

function notesPanel(item, { actor, onAdd, onDelete, onDeleteMark, onPlay, getPlayhead, timeable }) {
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

  /** 从时间轴上定点过来：钉住这个秒、让输入框接手 */
  const pinAt = (seconds) => {
    pinned = seconds;
    syncChip();
    input.focus();
  };

  const list = h('div', { class: 'col', gap: '3' });

  /** 备注和标记合成一条时间线：都按时间点排序，标记就是「还没写正文的那个点」 */
  const render = (notes, marks = []) => {
    clear(list);
    const rows = [
      ...notes.map((note) => ({ at: note.t ?? Infinity, created: note.createdAt, note })),
      ...marks.map((mark) => ({ at: mark.t, created: mark.createdAt, mark })),
    ].sort((a, b) => a.at - b.at || a.created - b.created);
    if (!rows.length) {
      list.append(h('p', { class: 'dim', style: 'font-size:var(--text-sm)' }, '还没有备注或标记'));
      return;
    }
    rows.forEach(({ note, mark }, i) => {
      if (mark) {
        // 标记行压成一行：它只是「这里有个点」，不该比写了字的备注还占地方
        list.append(
          h(
            'div',
            { class: 'note note--mark', 'data-mark': mark.id, style: `animation-delay:calc(var(--stagger) * ${Math.min(i, 6)})` },
            h('button', {
              class: 'pill pill--time pill--mark mono',
              type: 'button',
              title: '从这个时间点开始播放',
              onClick: () => onPlay(mark.t),
            }, icon('play', 10), fmtDur(mark.t)),
            h('span', { class: 'clip dim', title: `${mark.author} · ${fmtTime(mark.createdAt)}` }, `${mark.author} · 待补备注`),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn--sm', type: 'button', title: '把备注钉在这个点', onClick: () => pinAt(mark.t) }, '补一句'),
            mark.author === actor
              ? h('button', { class: 'btn btn--danger btn--sm', type: 'button', onClick: () => onDeleteMark(mark) }, '删除')
              : null,
          ),
        );
        return;
      }
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
                    title: '从这个时间点开始播放',
                    onClick: () => onPlay(note.t, note.id),
                  }, icon('play', 10), fmtDur(note.t)),
              h('span', { class: 'dim mono', title: fmtTime(note.createdAt) }, fmtAgo(note.createdAt))),
            h('p', {
              onClick: note.t == null ? null : () => onPlay(note.t, note.id),
              title: note.t == null ? null : '从这个时间点开始播放',
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

  const marks = item.marks ?? [];

  return {
    node: h('div', { class: 'col', gap: '4' },
      h('div', { class: 'spread' }, h('span', { class: 'eyebrow' }, `时间点 · ${item.notes.length + marks.length}`),
        h('span', { class: 'dim', style: 'font-size:var(--text-2xs)' },
          `备注 ${item.notes.length} · 标记 ${marks.length}`)),
      list,
      composer),
    render,
    syncChip,
    pinAt,
  };
}

export function openTheater({ items, index = 0, actor, onChange, onClose }) {
  const state = { items, index };
  // 连续播放默认开着：评审是一集一集顺下去看，切条还要手动点播放很挡手
  let autoplay = true;
  let video = null;
  let panel = null;
  // go() 之后要不要接着播：只有主动切条（上下键、上一条/下一条、看完自动下一条）才置真
  let pendingPlay = false;

  const shell = h('div', { class: 'sheet', style: 'width:min(100%,78rem)' });
  const media = h('div', { class: 'stage__media' });
  const side = h('div', { class: 'stage__side' });
  const titleEl = h('h3', { class: 'clip', style: 'max-width:46ch' });
  const metaEl = h('div', { class: 'cluster cluster-tight dim', style: 'font-size:var(--text-2xs)' });
  const footEl = h('div', { class: 'sheet-foot' });

  const current = () => state.items[state.index];
  const durationOf = () => Number(current()?.duration) || (video && Number.isFinite(video.duration) ? video.duration : 0);
  const timeable = () => current()?.kind === 'video' || current()?.kind === 'audio';
  const getPlayhead = () => (video && Number.isFinite(video.currentTime) ? video.currentTime : 0);

  /**
   * play() 被随后的 pause/seek 打断（AbortError）是正常竞态；被浏览器 autoplay 策略挡掉
   * （NotAllowedError）也不是文件的问题 —— 这两种都不能报「编码不支持」，那是把用户往错方向赶。
   */
  const playMedia = (el) =>
    el.play().catch((err) => {
      if (err?.name === 'AbortError' || err?.name === 'NotAllowedError') return;
      toast('这个文件浏览器放不出来（编码不支持），可以下载后看', 'err', 5200);
    });

  /**
   * 把当前这一路媒体彻底停下来并断开取流。
   * 以前换片子/关面板只是 clear() 掉 DOM 节点，元素没被 pause：
   * 浏览器照旧播下去、照旧按 Range 拉后面的字节，于是开第 N 个片子就有 N 路声音叠在一起。
   */
  function stopMedia() {
    if (!video) return;
    transport?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
    video = null;
  }

  /** 跳到备注时间点并暂停，方便边看备注边核对画面（轨道上的刻度用这个） */
  function seekTo(seconds, noteId) {
    const at = Number(seconds) || 0;
    if (video) {
      transport?.hardStop();
      video.currentTime = at;
    }
    highlightNote(noteId);
  }

  /** 列表里点时间码 = 从这个点开始看，所以直接播 */
  function playFrom(seconds, noteId) {
    const at = Number(seconds) || 0;
    if (video) {
      transport?.hardStop();
      video.currentTime = at;
      playMedia(video);
      transport?.sync();
    }
    highlightNote(noteId);
  }

  function highlightNote(noteId) {
    if (!noteId) return;
    qsa('.note--active', side).forEach((n) => n.classList.remove('note--active'));
    qsa(`[data-note="${noteId}"]`, side).forEach((n) => {
      n.classList.add('note--active');
      n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
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
      panel?.render(next.notes, next.marks);
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
      panel?.render(next.notes, next.marks);
      onChange?.(next);
    } catch (err) {
      toast(`备注没删除：${friendly(err.message)}`, 'err');
    }
  };

  // ── 自绘播放条：一条轨道同时是进度条、备注刻度和打点条 ────────────────
  let transport = null;
  let playerEl = null;
  let cinema = false;
  let reverseSupport = null;

  const fpsOf = () => fpsCache.get(current()?.id) || DEFAULT_FPS;
  const marksOf = () => current()?.marks ?? [];

  const patchMarks = (next) => {
    const item = current();
    if (item) onChange?.({ ...item, marks: next.slice().sort((a, b) => a.t - b.t) });
  };

  async function createMark(seconds) {
    const item = current();
    try {
      const mark = await api.addMark(item.id, Math.round(seconds * 1000) / 1000, actor);
      patchMarks([...marksOf(), mark]);
      toast(`已打点 @ ${fmtCode(mark.t, fpsOf())} · 在时间轴上拖动可微调`, 'ok');
    } catch (err) {
      toast(`打点没保存：${friendly(err.message)}`, 'err');
    }
  }

  async function saveMarkMove(mark, seconds) {
    const at = Math.round(seconds * 1000) / 1000;
    if (at === mark.t) return;
    try {
      const next = await api.moveMark(current().id, mark.id, at, actor);
      patchMarks(marksOf().map((m) => (m.id === next.id ? next : m)));
    } catch (err) {
      toast(`标记没挪动：${friendly(err.message)}（时间点已还原）`, 'err');
      transport?.renderTicks();
    }
  }

  async function eraseMark(mark) {
    try {
      await api.deleteMark(current().id, mark.id, actor);
      patchMarks(marksOf().filter((m) => m.id !== mark.id));
    } catch (err) {
      toast(`标记没删除：${friendly(err.message)}`, 'err');
    }
  }

  /** 定点写备注：全屏时先退出全屏，否则输入框在屏幕外 */
  function openNoteAt(seconds) {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    panel?.pinAt(seconds);
  }

  const setCinema = (on) => {
    cinema = on;
    shell.classList.toggle('sheet--theater', on);
    shell.style.width = on ? '100%' : 'min(100%,78rem)';
    transport?.syncFsState();
  };

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen?.().catch(() => {});
      return;
    }
    if (playerEl?.requestFullscreen) {
      try {
        await playerEl.requestFullscreen();
        return;
      } catch {
        // 被拒绝就继续往下走兜底
      }
    }
    // iOS / iPadOS 只允许 video 元素自己全屏
    if (video?.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
      return;
    }
    setCinema(!cinema);
  };

  function buildTransport() {
    let raf = 0;
    let drag = null;
    let reverseRaf = 0;
    let rateDir = 1;
    let rateMag = 1;
    let wanted = 0;
    let lastSeekAt = 0;
    let lastStepAt = 0;
    let ramping = false;

    const playBtn = h('button', { class: 'btn btn--icon transport__btn', type: 'button', title: '播放 / 暂停 (Space)' }, icon('play', 16));
    const curEl = h('span', { class: 'transport__code' }, fmtCode(0, fpsOf()));
    const totEl = h('span', { class: 'transport__code transport__code--total' }, fmtCode(durationOf(), fpsOf()));
    const fill = h('i', { class: 'track__fill' });
    const ticks = h('div', { class: 'track__ticks' });
    const snapLine = h('i', { class: 'track__snap', hidden: true });
    const head = h('i', { class: 'track__head' });
    const peekEl = h('span', { class: 'track__peek', hidden: true });
    const track = h('div', {
      class: 'track',
      role: 'slider',
      tabindex: '0',
      'aria-label': '时间轴：拖动播放头，靠近备注点或标记点会自动吸附，Shift 点击在该处写备注',
      'aria-valuemin': '0',
      'aria-valuemax': String(Math.round(durationOf() * 100) / 100),
      'aria-valuenow': '0',
    }, fill, ticks, snapLine, head, peekEl);
    const speedBtn = h('button', { class: 'btn btn--sm transport__speed', type: 'button', title: '倍速（点一下切换，或用 J / L 连按加速）' }, '1×');
    const markBtn = h('button', { class: 'btn btn--sm transport__mark', type: 'button', title: '在当前时间点打标记 (M)' }, icon('tag', 13), h('span', { class: 'transport__wide' }, '打点'));
    const muteBtn = h('button', { class: 'btn btn--icon transport__btn', type: 'button', title: '静音' }, icon('sound', 15));
    const vol = h('input', { class: 'transport__vol', type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': '音量' });
    const cinemaBtn = h('button', { class: 'btn btn--icon transport__btn', type: 'button', title: '影院模式：铺满窗口' }, icon('film', 15));
    const fsBtn = h('button', { class: 'btn btn--icon transport__btn', type: 'button', title: '全屏 (F)' }, icon('expand', 15));

    // 轨道独占一行拉满宽度，控件收到第二行：片子越长越看得清落点
    const node = h('div', { class: 'transport' },
      track,
      h('div', { class: 'transport__row' },
        playBtn,
        h('span', { class: 'transport__times' }, curEl, h('i', { class: 'transport__sep' }, '/'), totEl),
        speedBtn,
        h('span', { class: 'grow' }),
        markBtn,
        h('span', { class: 'transport__volwrap' }, muteBtn, vol),
        cinemaBtn,
        fsBtn));

    const shownTime = () => (drag?.kind === 'track' ? wanted : getPlayhead());
    const duration = () => durationOf() || (Number.isFinite(video.duration) ? video.duration : 0);

    function timeAt(clientX) {
      const rect = track.getBoundingClientRect();
      if (!rect.width) return 0;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * duration();
    }

    function snapPoints() {
      const d = duration();
      const cur = current();
      const list = [0];
      if (d) list.push(d);
      (cur?.notes ?? []).forEach((n) => n.t != null && list.push(n.t));
      (cur?.marks ?? []).forEach((m) => list.push(m.t));
      return list;
    }

    /** 落在吸附阈值内就返回吸附点，否则原样返回 */
    function snapTime(t) {
      const rect = track.getBoundingClientRect();
      const d = duration();
      if (!rect.width || !d) return { t, at: null };
      const tol = (SNAP_PX / rect.width) * d;
      let best = null;
      let bestGap = tol;
      snapPoints().forEach((p) => {
        const gap = Math.abs(p - t);
        if (gap <= bestGap) {
          bestGap = gap;
          best = p;
        }
      });
      return best === null ? { t, at: null } : { t: best, at: best };
    }

    function showSnap(at) {
      if (at === null || !duration()) {
        snapLine.hidden = true;
        return;
      }
      snapLine.hidden = false;
      snapLine.style.left = `${Math.min(100, Math.max(0, (at / duration()) * 100))}%`;
    }

    function applyTime(t) {
      const d = duration();
      const at = Math.min(Math.max(0, t), d || t);
      video.currentTime = at;
      wanted = at;
      sync();
      panel?.syncChip();
    }

    /** 快速拖动时丢掉中间位置，最多约 30 次/秒 seek，松手一定落一次 */
    function seekPosition(t, force = false) {
      wanted = t;
      const now = performance.now();
      if (!force && now - lastSeekAt < 33) {
        sync();
        return;
      }
      lastSeekAt = now;
      applyTime(t);
    }

    /** 每帧重画进度；按钮只在状态真变了才重建图标，其余时候只是几个比较 */
    function sync() {
      const d = duration();
      const t = shownTime();
      const pct = d ? Math.min(100, Math.max(0, (t / d) * 100)) : 0;
      fill.style.width = `${pct}%`;
      head.style.left = `${pct}%`;
      curEl.textContent = fmtCode(t, fpsOf());
      totEl.textContent = fmtCode(d, fpsOf());
      track.setAttribute('aria-valuenow', String(Math.round(t * 100) / 100));
      track.setAttribute('aria-valuetext', `${fmtCode(t, fpsOf())} / ${fmtCode(d, fpsOf())}`);
      if (document.activeElement !== vol) vol.value = video.muted ? '0' : String(video.volume);

      const reversing = Boolean(reverseRaf);
      const paused = !reversing && video.paused;
      if (playBtn.dataset.paused !== String(paused)) {
        playBtn.dataset.paused = String(paused);
        clear(playBtn);
        playBtn.append(icon(paused ? 'play' : 'pause', 16));
      }
      const label = reversing ? `◀ ${rateMag}×` : `${video.playbackRate || 1}×`;
      if (speedBtn.textContent !== label) speedBtn.textContent = label;
      speedBtn.classList.toggle('transport__speed--odd', reversing || (video.playbackRate || 1) !== 1);
      const muted = video.muted || Number(video.volume) === 0;
      if (muteBtn.dataset.muted !== String(muted)) {
        muteBtn.dataset.muted = String(muted);
        clear(muteBtn);
        muteBtn.append(icon(muted ? 'mute' : 'sound', 15));
        muteBtn.title = muted ? '取消静音' : '静音';
      }
      cinemaBtn.setAttribute('aria-pressed', String(cinema));
      fsBtn.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
    }

    function loop() {
      raf = 0;
      sync();
      if ((video && !video.paused) || drag?.kind === 'track' || reverseRaf) raf = requestAnimationFrame(loop);
    }

    function kickLoop() {
      if (!raf) raf = requestAnimationFrame(loop);
    }

    function stopReverse() {
      if (reverseRaf) cancelAnimationFrame(reverseRaf);
      reverseRaf = 0;
    }

    /** WebKit 不接受负 playbackRate，倒放就靠这个循环一帧帧往回 seek */
    function startReverse(mag) {
      stopReverse();
      video.pause();
      let last = performance.now();
      let acc = 0;
      const tick = (now) => {
        acc += (now - last) / 1000;
        last = now;
        if (acc >= 1 / 12) {
          const at = video.currentTime - acc * mag;
          acc = 0;
          if (at <= 0) {
            video.currentTime = 0;
            stopReverse();
            rateDir = 1;
            rateMag = 1;
            sync();
            return;
          }
          video.currentTime = at;
          sync();
          panel?.syncChip();
        }
        reverseRaf = requestAnimationFrame(tick);
      };
      reverseRaf = requestAnimationFrame(tick);
    }

    function supportsReverse() {
      if (reverseSupport !== null) return reverseSupport;
      const prev = video.playbackRate;
      try {
        video.playbackRate = -0.5;
        reverseSupport = video.playbackRate === -0.5;
      } catch {
        reverseSupport = false;
      }
      video.playbackRate = prev < 0 ? 1 : prev;
      return reverseSupport;
    }

    function hardStop() {
      stopReverse();
      video.pause();
      video.playbackRate = 1;
      rateDir = 1;
      rateMag = 1;
      ramping = false;
      sync();
    }

    function togglePlay() {
      if (reverseRaf || video.paused) {
        stopReverse();
        video.playbackRate = rateDir > 0 ? rateMag || 1 : 1;
        playMedia(video);
      } else {
        video.pause();
        // 手动暂停后再接 J/L，从常速重新开始，不要沿用刚才的倍速
        ramping = false;
      }
      sync();
    }

    function ramp(dir) {
      // 第一次按 J/L 是常速播放，连按才逐级加速
      if (ramping && rateDir === dir) rateMag = RAMP[(RAMP.indexOf(rateMag) + 1) % RAMP.length];
      else {
        rateDir = dir;
        rateMag = 1;
      }
      ramping = true;
      stopReverse();
      if (dir < 0) {
        if (supportsReverse()) {
          video.playbackRate = -rateMag;
          video.play().catch(() => startReverse(rateMag));
        } else {
          startReverse(rateMag);
        }
      } else {
        video.playbackRate = rateMag;
        playMedia(video);
      }
      kickLoop();
      sync();
    }

    function stepFrame(dir, repeat = false) {
      if (repeat) {
        if (performance.now() - lastStepAt < 80) return;
      }
      lastStepAt = performance.now();
      stopReverse();
      video.pause();
      rateDir = 1;
      rateMag = 1;
      video.playbackRate = 1;
      seekPosition(getPlayhead() + dir / fpsOf(), true);
    }

    function markNow() {
      createMark(getPlayhead());
    }

    // ── 轨道交互 ────────────────────────────────────────────────────────
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const at = timeAt(e.clientX);
      if (e.shiftKey || e.altKey) {
        e.preventDefault();
        hardStop();
        seekPosition(at, true);
        showSnap(snapTime(at).at);
        setTimeout(() => showSnap(null), 400);
        openNoteAt(snapTime(at).t);
        return;
      }
      e.preventDefault();
      // 指针可能在事件到达前就抬起了，捕获失败仍然照常拖
      try {
        track.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      stopReverse();
      drag = { id: e.pointerId, kind: 'track', startX: e.clientX, resume: !video.paused };
      video.pause();
      seekPosition(snapTime(at).t, true);
      kickLoop();
    });

    track.addEventListener('pointermove', (e) => {
      if (drag?.kind !== 'track' || drag.id !== e.pointerId) return;
      const snapped = snapTime(timeAt(e.clientX));
      seekPosition(snapped.t);
      showSnap(snapped.at);
    });

    /** 悬停时先报一下会落到哪一秒（含吸附后的值），不抽帧所以没有额外解码开销 */
    const peekAt = (e) => {
      if (drag || !duration()) {
        peekEl.hidden = true;
        return;
      }
      const snapped = snapTime(timeAt(e.clientX));
      peekEl.hidden = false;
      peekEl.textContent = `${fmtCode(snapped.t, fpsOf())}${snapped.at === null ? '' : ' ⌁'}`;
      peekEl.style.left = `${Math.min(100, Math.max(0, (snapped.t / duration()) * 100))}%`;
    };
    track.addEventListener('pointermove', peekAt);
    track.addEventListener('pointerleave', () => {
      peekEl.hidden = true;
    });

    const endDrag = (e) => {
      if (drag?.kind !== 'track' || drag.id !== e.pointerId) return;
      const { resume } = drag;
      drag = null;
      showSnap(null);
      seekPosition(wanted, true);
      if (resume) playMedia(video);
      sync();
    };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', () => {
      drag = null;
      showSnap(null);
      sync();
    });

    playBtn.onclick = togglePlay;
    speedBtn.onclick = () => {
      // 倒放中没有真正的 playbackRate 可读，按 1× 起步
      const wasReversing = Boolean(reverseRaf);
      const at = SPEEDS.indexOf(wasReversing ? 1 : video.playbackRate);
      const next = at < 0 ? 1 : SPEEDS[(at + 1) % SPEEDS.length];
      stopReverse();
      rateDir = 1;
      rateMag = next;
      video.playbackRate = next;
      if (wasReversing || !video.paused) playMedia(video);
      sync();
    };
    markBtn.onclick = markNow;
    fsBtn.onclick = toggleFullscreen;
    cinemaBtn.onclick = () => setCinema(!cinema);
    muteBtn.onclick = () => {
      video.muted = !video.muted;
      sync();
    };
    vol.oninput = () => {
      video.volume = Number(vol.value);
      video.muted = Number(vol.value) === 0;
      try {
        localStorage.setItem(VOL_KEY, vol.value);
      } catch {
        // 隐私模式下写不了 localStorage，不影响播放
      }
      sync();
    };

    // ── 轨道刻度：备注点与标记点画在同一条轨上 ──────────────────────────
    function renderTicks() {
      const cur = current();
      const d = duration();
      clear(ticks);
      if (!cur || d <= 0) return;
      const pct = (t) => `${Math.min(100, Math.max(0, (t / d) * 100))}%`;
      (cur.notes ?? [])
        .filter((n) => n.t != null)
        .forEach((note) => {
          ticks.append(
            h('button', {
              class: 'tick tick--note',
              type: 'button',
              style: `left:${pct(note.t)}`,
              title: `备注 ${fmtDur(note.t)} · ${note.author}：${String(note.text).slice(0, 40)}`,
              'aria-label': `跳到 ${fmtDur(note.t)} 的备注`,
              onClick: () => {
                hardStop();
                seekTo(note.t, note.id);
                sync();
              },
            }),
          );
        });

      const list = (cur.marks ?? []).slice().sort((a, b) => a.t - b.t);
      list.forEach((mark) => {
        const tick = h('button', {
          class: 'tick tick--mark',
          type: 'button',
          style: `left:${pct(mark.t)}`,
          title: `标记 ${fmtCode(mark.t, fpsOf())} · ${mark.author}（在轨道上拖动可改时间点）`,
          'aria-label': `跳到 ${fmtCode(mark.t, fpsOf())} 的标记`,
        });
        tick.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          try {
            tick.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
          drag = { id: e.pointerId, kind: 'mark', mark, startX: e.clientX, moved: false, at: mark.t };
        });
        tick.addEventListener('pointermove', (e) => {
          if (drag?.kind !== 'mark' || drag.id !== e.pointerId) return;
          if (Math.abs(e.clientX - drag.startX) > 3) drag.moved = true;
          if (!drag.moved) return;
          const snapped = snapTime(timeAt(e.clientX));
          drag.at = snapped.t;
          tick.style.left = pct(snapped.t);
          showSnap(snapped.at);
        });
        const finish = (e) => {
          if (drag?.kind !== 'mark' || drag.id !== e.pointerId) return;
          const { moved, at } = drag;
          drag = null;
          showSnap(null);
          if (moved) saveMarkMove(mark, at);
          else {
            hardStop();
            seekTo(mark.t);
            sync();
          }
        };
        tick.addEventListener('pointerup', finish);
        tick.addEventListener('pointercancel', () => {
          drag = null;
          showSnap(null);
          renderTicks();
        });
        ticks.append(tick);
      });
      sync();
    }

    // ── 素材事件 ────────────────────────────────────────────────────────
    video.addEventListener('play', () => {
      kickLoop();
      sync();
    });
    video.addEventListener('playing', () => {
      probeFps();
      sync();
    });
    ['pause', 'seeked', 'durationchange', 'ratechange'].forEach((name) => video.addEventListener(name, () => sync()));
    video.addEventListener('timeupdate', () => {
      if (!raf) sync();
    });
    video.addEventListener('click', togglePlay);
    video.addEventListener('dblclick', () => toggleFullscreen());

    /** 库里没存 fps，播起来时按帧间隔实测一次，逐帧步进才准 */
    function probeFps() {
      const key = current()?.id;
      if (!key || fpsCache.has(key) || !('requestVideoFrameCallback' in video)) return;
      let prev = 0;
      const deltas = [];
      const step = (_now, meta) => {
        if (current()?.id !== key || video.paused) return;
        if (prev) {
          deltas.push(meta.mediaTime - prev);
          if (deltas.length >= 10) {
            const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
            const fps = avg > 0 ? Math.round(1 / avg) : 0;
            if (fps >= 12 && fps <= 120) fpsCache.set(key, fps);
            return;
          }
        }
        prev = meta.mediaTime;
        video.requestVideoFrameCallback(step);
      };
      video.requestVideoFrameCallback(step);
    }

    try {
      const saved = Number(localStorage.getItem(VOL_KEY));
      if (Number.isFinite(saved) && saved > 0) video.volume = Math.min(1, saved);
    } catch {
      // 读不到就用浏览器默认音量
    }

    renderTicks();
    sync();

    return {
      node,
      sync,
      renderTicks,
      togglePlay,
      hardStop,
      stepFrame,
      ramp,
      markNow,
      syncFsState: sync,
      destroy() {
        if (raf) cancelAnimationFrame(raf);
        stopReverse();
      },
    };
  }

  function paintMedia(item) {
    stopMedia();
    transport = null;
    clear(media);
    const stage = mediaStage(item);
    playerEl = h('div', { class: 'player anim-fade-up' }, stage);
    media.append(playerEl);
    video = qs('video, audio', media);
    if (video) {
      video.addEventListener('ended', () => {
        if (autoplay && state.index < state.items.length - 1) go(1);
      });
      video.addEventListener('timeupdate', () => panel?.syncChip());
      video.addEventListener('loadedmetadata', () => transport?.renderTicks());
      transport = buildTransport();
      playerEl.append(transport.node);
      if (pendingPlay) playMedia(video);
    }
    pendingPlay = false;
    if (!video) playerEl.classList.add('player--static');
  }

  function go(delta) {
    const next = state.index + delta;
    if (next < 0 || next >= state.items.length) return;
    state.index = next;
    // 连续播放开着时，切条就顺手播下一条（首次进放映厅不自动播，尊重浏览器策略也别抢人耳）
    pendingPlay = autoplay;
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
      onDeleteMark: eraseMark,
      onPlay: playFrom,
      getPlayhead,
      timeable: timeable(),
    });
    panel.render(item.notes, item.marks);
    side.append(
      h('div', { class: 'col', gap: '2' },
        h('div', { class: 'spread' },
          h('span', { class: 'eyebrow' }, '正在放映'),
          h('div', { class: 'cluster cluster-tight' },
            h('button', { class: 'btn btn--icon btn--ghost', title: '上一条 (↑)', onClick: () => go(-1) }, icon('prev')),
            h('button', { class: 'btn btn--icon btn--ghost', title: '下一条 (↓)', onClick: () => go(1) }, icon('next')),
            item.missing ? null : h('a', { class: 'btn btn--icon btn--ghost', href: withParam(item.streamUrl, 'download=1'), download: item.name, title: '下载' }, icon('download')),
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
    // 同一条素材只是改了状态/备注/标记时不重建播放器，否则正看着的画面会被打断
    const sameItem = shownId === item.id && !forceMedia;
    shownId = item.id;
    renderHead(item);
    renderSide(item);
    if (sameItem) transport?.renderTicks();
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
      // 底栏贴着弹层下沿：气泡得朝上开、朝右长，否则左半边被 .sheet 的 overflow 裁掉
      hint('↑ / ↓ 切换素材 · ← / → 前后一帧 · Space 播放暂停 · J 倒放、L 正放（连按加速，K 停）· M 打时间点 · F 全屏 · 1-4 打状态 · 0 清除 · N 写备注 · Shift+点时间轴在该点写备注', { side: 'bottom right' }),
      h('span', { class: 'grow' }),
      item.notes.length ? h('span', { class: 'pill pill--accent' }, `${item.notes.length} 条备注`) : null,
      (item.marks ?? []).length ? h('span', { class: 'pill' }, `${item.marks.length} 个标记`) : null,
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

  // 弹层要把键盘拿走：不夺焦点的话焦点还留在背景那张卡片上，
  // 按一次空格 = 卡片的 Enter/Space 处理 = 再多开一间放映厅
  const opener = document.activeElement;
  shell.tabIndex = -1;
  shell.focus({ preventScroll: true });

  const onKey = (e) => {
    if (e.target instanceof HTMLElement && /input|textarea/i.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      go(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      transport?.stepFrame(e.key === 'ArrowLeft' ? -1 : 1, e.repeat);
      return;
    }
    const key = e.key.toLowerCase();
    if (e.key === ' ') {
      e.preventDefault();
      transport?.togglePlay();
      return;
    }
    if (key === 'j' || key === 'l') {
      if (!transport || e.repeat) return;
      e.preventDefault();
      transport.ramp(key === 'j' ? -1 : 1);
      return;
    }
    if (key === 'k') {
      transport?.hardStop();
      return;
    }
    if (key === 'm') {
      if (!transport) return;
      e.preventDefault();
      transport.markNow();
      return;
    }
    if (key === 'f') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }
    if (key === 'n') {
      e.preventDefault();
      qs('textarea', side)?.focus();
      return;
    }
    const num = Number(e.key);
    if (num >= 1 && num <= 4) setStatus(STATUSES[num].key);
    if (e.key === '0') setStatus('unset');
  };
  document.addEventListener('keydown', onKey);

  const onFsChange = () => transport?.syncFsState();
  document.addEventListener('fullscreenchange', onFsChange);

  const origClose = controller.close;
  controller.close = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFsChange);
    stopMedia();
    transport = null;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    origClose();
    // 焦点还给打开它的那张卡片，关掉后继续用键盘顺下去看
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
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
