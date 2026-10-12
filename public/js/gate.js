// ── 门页：在别的设备上用机主口令解锁素材库 ────────────────────────────────
const form = document.querySelector('[data-ref="owner-form"]');
const input = document.querySelector('[data-ref="owner-token"]');
const note = document.querySelector('[data-ref="owner-note"]');

function say(text, ok = false) {
  note.textContent = text;
  note.dataset.ok = String(ok);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = input.value.trim();
  if (!token) return say('先输入口令。');
  say('正在验证…', true);
  try {
    const res = await fetch('/api/owner/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      say(data?.error || '口令不对');
      return;
    }
    say('已解锁，正在进入素材库…', true);
    location.href = '/';
  } catch {
    say('连不上 LanReel 服务，确认地址没写错。');
  }
});

input.focus();
