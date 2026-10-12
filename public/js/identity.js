// ── 署名：状态和备注都要知道是谁做的，名字只存在本机浏览器 ─────────────────
import { clear, h, openScrim, toast } from './dom.js';

const KEY = 'lanreel-me';

export const getActor = () => localStorage.getItem(KEY) || '';
export const setActor = (name) => localStorage.setItem(KEY, name || '匿名');

export function paintNameButton(btn) {
  const name = getActor();
  clear(btn);
  btn.dataset.action = 'who';
  btn.append(
    h('span', { class: 'avatar avatar--sm' }, name ? [...name][0] : '?'),
    h('span', { class: 'clip' }, name || '点我署名'),
  );
  btn.onclick = () => askName(btn);
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
