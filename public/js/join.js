// ── 邀请落地页：确认这条 /j/<码> 还有效，填一次名字换成员 Cookie ─────────────
const form = document.querySelector('[data-ref="join-form"]');
const input = document.querySelector('[data-ref="join-name"]');
const lead = document.querySelector('[data-ref="join-lead"]');
const note = document.querySelector('[data-ref="join-note"]');
const submit = form.querySelector('button[type="submit"]');
const TOKEN = decodeURIComponent((location.pathname.match(/^\/j\/([^/?#]+)/) || [])[1] || '');

function say(text, ok = false) {
  note.textContent = text;
  note.dataset.ok = String(ok);
}

function ready(name) {
  submit.disabled = false;
  input.value = name || '';
  lead.textContent = name
    ? `机主给你写的名字是「${name}」，就这样进来？（想改就直接改）`
    : '先告诉我你是谁，之后评审记录都记这个名字。';
  input.focus();
}

async function check() {
  if (!TOKEN) {
    lead.textContent = '链接里没有邀请码';
    say('请让机主重新发一条以 /j/ 开头的链接。');
    return;
  }
  try {
    const res = await fetch(`/api/join/${encodeURIComponent(TOKEN)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      lead.textContent = '这条邀请链接用不了';
      say(data?.error || '邀请链接无效或已被机主停用');
      return;
    }
    ready(data.name);
  } catch {
    lead.textContent = '连不上 LanReel 服务';
    say('确认地址没写错，或者机主那台机器还开着。');
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = input.value.trim();
  if (!name) {
    input.focus();
    say('名字不能空着 —— 留痕要记到具体的人。');
    return;
  }
  say('正在进来…', true);
  try {
    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, name }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      say(data?.error || '邀请链接无效或已停用');
      return;
    }
    say(`你好，${data.name}，正在进入…`, true);
    location.href = '/';
  } catch {
    say('连不上 LanReel 服务，确认地址没写错。');
  }
});

check();
