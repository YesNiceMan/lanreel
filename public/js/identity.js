// ── 署名：状态和备注都要知道是谁做的，名字默认只存在本机浏览器 ──────────────
import { api } from './api.js';
import { clear, h, openScrim, toast } from './dom.js';

const KEY = 'lanreel-me';

export const getActor = () => localStorage.getItem(KEY) || '';
export const setActor = (name) => localStorage.setItem(KEY, name || '匿名');

/**
 * 服务端盖章的名字（邀请制成员）。
 * 一旦设了，署名就不给改：留痕里的那个名字必须是机主认得的人，
 * 否则「谁把这条标成淘汰的」还是可以对不上人。
 */
let lockedName = '';
export const setLockedName = (name) => {
  lockedName = String(name ?? '').trim();
  if (lockedName) setActor(lockedName);
};
export const nameIsLocked = () => Boolean(lockedName);

export function paintNameButton(btn) {
  const name = getActor();
  clear(btn);
  btn.dataset.action = 'who';
  btn.append(
    h('span', { class: 'avatar avatar--sm' }, name ? [...name][0] : '?'),
    h('span', { class: 'clip' }, name || '点我署名'),
  );
  btn.onclick = () => (lockedName ? showLocked(btn) : askName(btn));
}

/** 成员点自己的名字：只告诉他这枚署名是盖过章的，外加一个退出 */
function showLocked(btn) {
  const sheet = openScrim(
    h('div', { class: 'sheet sheet--sm' },
      h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow' }, '你是受邀成员')),
      h('div', { class: 'sheet-body' },
        h('div', { class: 'col', gap: '3' },
          h('p', null, `署名：${lockedName}`),
          h('p', { class: 'muted' }, '这个名字由机主的邀请链接定下来，评审档案里记的就是它，改不了 —— 要换人请用另一条邀请链接。'),
          h('p', { class: 'dim', style: 'font-size:var(--text-2xs)' }, '你只能看到自己建的素材夹；别人的项目、机主口令都与你无关。'))),
      h('div', { class: 'sheet-foot' },
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => sheet.close() }, '知道了'),
        h('button', {
          class: 'btn',
          type: 'button',
          onClick: async () => {
            await api.leaveMember().catch(() => null);
            sheet.close();
            toast('已退出，刷新后按访客处理', 'info');
            setTimeout(() => location.reload(), 900);
          },
        }, '退出这台设备'))));
  return sheet;
}

export function askName(btn, force = false) {
  const input = h('input', {
    class: 'input',
    value: getActor(),
    placeholder: '例如：小李 / 剪辑组-阿哲',
    maxlength: '24',
    onKeydown: (e) => {
      if (e.key === 'Enter') commit();
    },
  });
  const sheet = openScrim(
    h('div', { class: 'sheet sheet--sm' },
      h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow' }, '署名')),
      h('div', { class: 'sheet-body' },
        h('div', { class: 'col', gap: '3' },
          h('p', { class: 'muted' }, '你的名字会标在勾选的状态与备注上，同一个局域网里的其他人都看得到。'),
          input),
        h('p', { class: 'dim', style: 'font-size:var(--text-2xs);margin-top:var(--space-3)' }, '只保存在这台设备的浏览器里，不会上传到任何地方。')),
      h('div', { class: 'sheet-foot' },
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          onClick: commit,
        }, '就这样'))),
  );

  function commit() {
    const value = input.value.trim();
    if (!value && force) {
      input.focus();
      return;
    }
    setActor(value || '匿名');
    paintNameButton(btn);
    sheet.close();
    toast(force ? `你好，${getActor()}，开始看吧` : `已改名为 ${getActor()}`, 'ok');
  }

  setTimeout(() => input.focus(), 80);
  return sheet;
}
