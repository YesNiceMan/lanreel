// Server-Sent Events 中心：让局域网内的每一次勾选、备注即时出现在别人的屏幕上。
const clients = new Set();
let heartbeat = null;

export function addClient(res, filter = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client = { res, bundleId: filter.bundleId ?? null, can: filter.can ?? null };
  res.write(`retry: 2000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, at: Date.now() })}\n\n`);

  res.on('close', () => {
    clients.delete(client);
    if (!clients.size) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  });
  clients.add(client);

  if (!heartbeat) {
    heartbeat = setInterval(() => {
      for (const client of clients) client.res.write(': ping\n\n');
    }, 25000);
  }
  return client;
}

export function broadcast(payload) {
  if (!clients.size) return;
  const data = `event: sync\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    // can() 是活的判定（成员刚建的夹子也算他的），订阅时算好的 id 列表会漏掉这一步
    if (client.can) {
      if (!client.can(payload)) continue;
    } else if (client.bundleId && payload.bundleId && payload.bundleId !== client.bundleId) continue;
    client.res.write(data);
  }
}

export function clientCount() {
  return clients.size;
}

export function closeAll() {
  for (const client of clients) client.res.end();
  clients.clear();
}
