// ── 实时同步：一次勾选，所有人屏幕上立刻跳动 ──────────────────────────────
export function connectSync({ ref = null, onEvent, onState } = {}) {
  const url = ref ? `/api/events?bundle=${encodeURIComponent(ref)}` : '/api/events';
  let source = null;
  let closed = false;
  let fails = 0;

  function open() {
    if (closed) return;
    source = new EventSource(url);
    source.onopen = () => {
      fails = 0;
      onState?.(true);
    };
    source.onerror = () => {
      onState?.(false);
      // 被服务端关闭时手动重建。链接失效时服务端会一直回 4xx，
      // 固定 1.5s 重试等于让每台同事的浏览器长期打这台机器，所以逐次退避到 30s 封顶。
      if (source?.readyState === EventSource.CLOSED) {
        const wait = Math.min(30000, 1500 * 2 ** Math.min(5, fails));
        fails += 1;
        setTimeout(open, wait);
      }
    };
    source.addEventListener('sync', (e) => {
      onState?.(true);
      try {
        onEvent?.(JSON.parse(e.data));
      } catch {
        /* 忽略畸形事件 */
      }
    });
  }

  open();

  return {
    close() {
      closed = true;
      source?.close();
    },
  };
}
