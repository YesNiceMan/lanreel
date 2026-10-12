// ── 实时同步：一次勾选，所有人屏幕上立刻跳动 ──────────────────────────────
export function connectSync({ ref = null, onEvent, onState } = {}) {
  const url = ref ? `/api/events?bundle=${encodeURIComponent(ref)}` : '/api/events';
  let source = null;
  let closed = false;

  function open() {
    if (closed) return;
    source = new EventSource(url);
    source.onopen = () => onState?.(true);
    source.onerror = () => {
      onState?.(false);
      // EventSource 自带重连；被服务端关闭时手动重建
      if (source?.readyState === EventSource.CLOSED) setTimeout(open, 1500);
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
