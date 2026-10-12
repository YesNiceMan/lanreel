import os from 'node:os';
import { config } from './config.js';
import { normalizePicked, pickFolder } from './native.js';
import {
  addNote,
  findCopyDuplicates,
  commitItem,
  createBundle,
  createReferenceBundle,
  discardItem,
  getBundleByRef,
  listBundles,
  markMissing,
  ownerToken,
  removeBundle,
  removeItem,
  removeNote,
  rescanBundle,
  reserveItem,
  resolveItem,
  serializeBundle,
  serializeItem,
  setPoster,
  storageReport,
  setStatuses,
  shareActive,
  totals,
  updateBundle,
  updateItem,
} from './store.js';
import { statusLabel } from '../public/js/statuses.js';
import { sendFile, sendJson } from './media.js';
import { addClient, clientCount } from './bus.js';
import { ALLOWED_EXT, cookieValue, extOf, isLocalMachine, mimeOf, readJson, safeEqual, sanitizeSegment, streamToDisk } from './util.js';

const routes = [];

function on(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern
      .split('/')
      .map((seg) => {
        if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        keys.push(seg.slice(1));
        return '([^/]+)';
      })
      .join('/')}$`,
  );
  routes.push({ method, regex, keys, handler });
}

function HttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ name, address: net.address });
    }
  }
  return out;
}

let currentPort = config.port;
export function setServerPort(port) {
  currentPort = port;
}

/** 分享链接基准地址：优先局域网 IP，而不是访客浏览器里的 localhost。 */
export function baseFromRequest(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const bare = raw.split(':')[0];
  const primary = lanAddresses()[0];
  const isLocal = !bare || bare === 'localhost' || bare.startsWith('127.') || bare === '::1';
  const host = isLocal && primary ? primary.address : bare || '127.0.0.1';
  const port = Number(raw.split(':')[1]) || currentPort;
  return `http://${host}:${port}`;
}

function bundlePayload(bundle, req, { withRoot = false } = {}) {
  const payload = serializeBundle(bundle, { withRoot });
  payload.baseUrl = baseFromRequest(req);
  payload.shareLink = `${payload.baseUrl}${payload.shareUrl}`;
  return payload;
}

// ── 导出：评审表是给甲方/剪辑看的交付物，字段与界面同一套口径 ──────────────
const KIND_LABEL = { video: '视频', image: '图片', audio: '音频', doc: '文档', archive: '压缩包', other: '其他' };

function hhmmss(seconds) {
  const s = Math.round(Number(seconds) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** 一行一条素材，纯表格：表头之外不塞说明行，免得 Excel 里筛选要手动删 */
function reviewCsv(data) {
  const head = ['序号', '文件名', '相对路径', '类型', '时长', '体积(字节)', '状态', '标注人', '标注时间', '备注', '源文件'];
  const rows = data.items.map((item, i) => [
    i + 1,
    item.name,
    item.relPath,
    KIND_LABEL[item.kind] ?? item.kind,
    item.duration ? hhmmss(item.duration) : '',
    item.size,
    statusLabel(item.status),
    item.statusBy,
    item.statusAt ? new Date(item.statusAt).toLocaleString('zh-CN', { hour12: false }) : '',
    item.notes.map((n) => `${n.t != null ? `[${hhmmss(n.t)}] ` : ''}${n.author}：${n.text}`).join(' ｜ '),
    item.missing ? '已丢失' : '',
  ]);
  const table = [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  // Excel 打不开无 BOM 的 UTF-8 CSV：中文会按本地代码页解成乱码
  return `\uFEFF${table}\r\n`;
}

function sendDownload(res, filename, contentType, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="lanreel-review"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

// ── 元数据 ──────────────────────────────────────────────────────────────
on('GET', '/api/health', async ({ res, req }) => {
  sendJson(res, 200, {
    ok: true,
    name: config.appName,
    version: config.version,
    uptime: Math.round(process.uptime()),
    viewers: clientCount(),
    local: config.libraryFromLan || isLocalMachine(req.socket?.remoteAddress),
    owner: isOwner(req),
    totals: totals(),
    storage: await storageReport(),
    baseUrl: baseFromRequest(req),
    lan: lanAddresses(),
    limits: { maxUploadBytes: config.maxUploadBytes, maxFilesPerBundle: config.maxFilesPerBundle },
  });
});

on('GET', '/api/bundles', async ({ res, req }) => {
  requireOwner(req);
  sendJson(res, 200, {
    bundles: listBundles({ withRoot: true }),
    totals: totals(),
    storage: await storageReport(),
    lan: lanAddresses(),
    port: currentPort,
  });
});

on('POST', '/api/bundles', async ({ res, req }) => {
  requireOwner(req);
  const body = await readJson(req);
  const bundle = createBundle({ name: body.name ?? '未命名素材夹', description: body.description });
  sendJson(res, 201, serializeBundle(bundle, { withItems: false }));
});

on('GET', '/api/bundles/:ref', ({ res, req, params }) => {
  requireOwner(req);
  const bundle = getBundleByRef(params.ref);
  if (!bundle) throw HttpError(404, '素材夹不存在');
  sendJson(res, 200, bundlePayload(bundle, req, { withRoot: true }));
});

on('PATCH', '/api/bundles/:ref', async ({ res, req, params }) => {
  requireOwner(req);
  const body = await readJson(req);
  const bundle = updateBundle(params.ref, body);
  if (!bundle) throw HttpError(404, '素材夹不存在');
  sendJson(res, 200, serializeBundle(bundle, { withItems: false }));
});

on('DELETE', '/api/bundles/:ref', async ({ res, req, params }) => {
  requireOwner(req);
  const ok = await removeBundle(params.ref);
  if (!ok) throw HttpError(404, '素材夹不存在');
  sendJson(res, 200, { removed: true });
});

on('GET', '/api/bundles/:ref/export', ({ res, req, params, query }) => {
  requireOwner(req);
  const bundle = getBundleByRef(params.ref);
  if (!bundle) throw HttpError(404, '素材夹不存在');
  const data = serializeBundle(bundle, { withLog: true });
  const name = sanitizeSegment(bundle.name, '素材夹');
  const stamp = new Date().toISOString().slice(0, 10);
  if (query.fmt === 'json') {
    const body = JSON.stringify({ ...data, exportedAt: Date.now(), version: config.version }, null, 2);
    sendDownload(res, `${name}-完整记录-${stamp}.json`, 'application/json; charset=utf-8', body);
    return;
  }
  sendDownload(res, `${name}-评审表-${stamp}.csv`, 'text/csv; charset=utf-8', `${reviewCsv(data)}`);
});

// ── 入库：请求体原样落盘，无 multipart 解析、无云端中转 ──────────────────
on('POST', '/api/bundles/:ref/items', async ({ res, req, query, params }) => {
  requireOwner(req);
  const bundle = getBundleByRef(params.ref);
  if (!bundle) throw HttpError(404, '素材夹不存在');
  if (bundle.mode === 'reference') throw HttpError(409, '挂载目录不接收上传，请把文件放进源目录后点「重新扫描」');

  const name = sanitizeSegment(query.name ?? '', 'untitled');
  const ext = extOf(name);
  if (!ALLOWED_EXT.has(ext)) throw HttpError(415, `暂不支持 .${ext || '?'} 类型`);

  const claimed = Number(query.size) || 0;
  const reserved = reserveItem(bundle, {
    name,
    relPath: query.path ?? name,
    mime: mimeOf(ext),
    size: claimed,
    duration: Number(query.duration) || 0,
  });

  if (reserved.duplicate) {
    for await (const _chunk of req) {
      /* 客户端本地去重没命中时，这里丢弃重复字节 */
    }
    sendJson(res, 200, { item: serializeItem(reserved.item), duplicate: true });
    return;
  }

  try {
    const { bytes, digest } = await streamToDisk(req, reserved.temp, config.maxUploadBytes);
    if (bytes === 0) throw HttpError(400, '文件为空');
    const item = await commitItem(reserved.item, {
      size: bytes,
      digest,
      temp: reserved.temp,
      duration: Number(query.duration) || 0,
      width: Number(query.width) || 0,
      height: Number(query.height) || 0,
    });
    sendJson(res, 201, { item: serializeItem(item) });
  } catch (err) {
    await discardItem(bundle, reserved.item);
    throw err;
  }
});

on('POST', '/api/items/:id/poster', async ({ res, req, params }) => {
  requireOwner(req);
  const found = resolveItem(params.id);
  if (!found) throw HttpError(404, '素材不存在');
  const { bytes } = await streamToDisk(req, found.poster, config.maxPosterBytes);
  const item = setPoster(params.id, bytes);
  if (!item) {
    await removeItem(params.id);
    throw HttpError(404, '素材不存在');
  }
  sendJson(res, bytes ? 201 : 200, { bytes, itemId: params.id });
});

/** 只有运行 LanReel 的这台电脑：会读目录、弹原生对话框的动作不给远程口令放行 */
function requireLocal(req) {
  if (!isLocalMachine(req.socket?.remoteAddress)) {
    throw HttpError(403, '挂载本机目录、选择器、重新扫描只允许运行 LanReel 的这台电脑操作');
  }
}

/** 机主：本机、LIBRARY_FROM_LAN=1，或带着正确口令（Cookie 或 x-owner-token 头） */
export function isOwner(req) {
  if (config.libraryFromLan || isLocalMachine(req.socket?.remoteAddress)) return true;
  const expected = ownerToken();
  if (!expected) return false;
  const given = String(req.headers['x-owner-token'] ?? '').trim() || cookieValue(req.headers.cookie, config.ownerCookie);
  return safeEqual(expected, given);
}

/** 素材库（含上传入库、删除、改名、导出）默认只对本机开放；其他设备要么拿口令，要么走分享链接 */
function requireOwner(req) {
  if (isOwner(req)) return;
  throw HttpError(403, '素材库只在运行 LanReel 的这台电脑上管理；其他设备请先输入机主口令，同事请用 /s/ 分享链接');
}

/**
 * 评审写操作（状态、备注）的作用域。
 * 返回 null 表示机主，不限夹子；返回夹子表示「只能动这个夹子里的素材」。
 * 没有这一步，任何拿到一条分享链接的人都能凭素材 ID 改全站。
 */
function reviewScope(req) {
  if (isOwner(req)) return null;
  const token = String(req.headers['x-share-token'] ?? '').trim();
  const bundle = token ? getBundleByRef(token) : null;
  if (!bundle || !shareActive(bundle)) {
    throw HttpError(403, '请先通过分享链接打开这个素材夹再评审（缺少有效分享码）');
  }
  return bundle;
}

function requireScopedItem(scope, itemId) {
  const found = resolveItem(itemId);
  if (scope && (!found || found.bundle.id !== scope.id)) {
    throw HttpError(403, '这条素材不属于当前分享链接');
  }
  return found;
}

function requireScopedIds(scope, ids) {
  if (!scope) return ids;
  const outside = ids.filter((itemId) => {
    const found = resolveItem(itemId);
    return !found || found.bundle.id !== scope.id;
  });
  if (outside.length) throw HttpError(403, `有 ${outside.length} 条素材不属于当前分享链接`);
  return ids;
}

// ── 机主口令：让机主在局域网里的其他设备上也能管理素材库 ──────────────────
// 口令是首启随机生成的 12 位（或 OWNER_TOKEN 指定），等价于「我是这台机器的管理员」
on('POST', '/api/owner/unlock', async ({ res, req }) => {
  const body = await readJson(req);
  const expected = ownerToken();
  if (!expected || !safeEqual(expected, String(body.token ?? '').trim())) {
    throw HttpError(401, '口令不对');
  }
  res.setHeader('Set-Cookie', `${config.ownerCookie}=${encodeURIComponent(expected)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
  sendJson(res, 200, { ok: true });
});

on('POST', '/api/owner/lock', ({ res }) => {
  res.setHeader('Set-Cookie', `${config.ownerCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  sendJson(res, 200, { ok: true });
});

/** 明文口令只在这台电脑上回显；从别的设备来只能知道「是不是机主」 */
on('GET', '/api/owner', ({ res, req }) => {
  requireLocal(req);
  sendJson(res, 200, { token: ownerToken(), fromEnv: Boolean(config.ownerToken) });
});

// ── 零拷贝挂载：素材留在原目录，不复制进 data/ ───────────────────────────
on('POST', '/api/mounts', async ({ res, req }) => {
  requireLocal(req);
  const body = await readJson(req);
  const bundle = await createReferenceBundle(normalizePicked(body.path), body.name);
  const payload = serializeBundle(bundle, { withItems: false, withRoot: true });
  payload.duplicates = findCopyDuplicates(bundle);
  sendJson(res, 201, payload);
});

// 让本机弹出系统文件夹选择器，拿回绝对路径（浏览器自己做不到这一点）
on('POST', '/api/pick-folder', async ({ res, req }) => {
  requireLocal(req);
  const result = await pickFolder();
  if (result.error) throw HttpError(501, result.error);
  sendJson(res, 200, result.cancelled ? { cancelled: true } : { path: result.path });
});

on('POST', '/api/bundles/:ref/rescan', async ({ res, req, params }) => {
  requireLocal(req);
  const result = await rescanBundle(params.ref);
  if (!result) throw HttpError(409, '只有挂载目录需要重新扫描');
  sendJson(res, 200, result);
});

// ── 评审：状态 + 备注 ────────────────────────────────────────────────────
// 改名与删除是管理动作：只有机主（本机或带口令）能做
on('PATCH', '/api/items/:id', async ({ res, req, params }) => {
  requireOwner(req);
  const body = await readJson(req);
  const item = updateItem(params.id, body);
  if (!item) throw HttpError(404, '素材不存在');
  sendJson(res, 200, serializeItem(item));
});

on('DELETE', '/api/items/:id', async ({ res, req, params, query }) => {
  requireOwner(req);
  const ok = await removeItem(params.id, String(query.by ?? '').slice(0, 40));
  if (!ok) throw HttpError(404, '素材不存在');
  sendJson(res, 200, { removed: true });
});

// 打状态、写备注：同网同事都可以，但只能动自己那条分享链接里的素材
on('POST', '/api/items/status', async ({ res, req }) => {
  const scope = reviewScope(req);
  const body = await readJson(req);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 2000) : [];
  if (!ids.length) throw HttpError(400, '未选择素材');
  requireScopedIds(scope, ids);
  const changed = setStatuses(ids, String(body.status ?? 'unset'), String(body.by ?? ''));
  sendJson(res, 200, { changed: changed.length, status: body.status });
});

on('POST', '/api/items/:id/notes', async ({ res, req, params }) => {
  const scope = reviewScope(req);
  requireScopedItem(scope, params.id);
  const body = await readJson(req);
  const note = addNote(params.id, { text: body.text, author: body.author, t: body.t });
  if (!note) throw HttpError(404, '素材不存在');
  sendJson(res, 201, note);
});

on('DELETE', '/api/items/:id/notes/:noteId', ({ res, req, params, query }) => {
  requireScopedItem(reviewScope(req), params.id);
  const by = query.by ? sanitizeSegment(query.by, '') : '';
  const note = removeNote(params.id, params.noteId, by);
  if (!note) throw HttpError(404, '备注不存在');
  sendJson(res, 200, { removed: true });
});

// ── 分享视图 ─────────────────────────────────────────────────────────────
on('GET', '/api/share/:token', ({ res, req, params }) => {
  const bundle = getBundleByRef(params.token);
  if (!bundle) throw HttpError(404, '分享链接不存在或已删除');
  if (!shareActive(bundle)) throw HttpError(410, '分享链接已过期');
  sendJson(res, 200, bundlePayload(bundle, req));
});

// ── 流媒体：Range 支持 = 秒开 + 任意拖拽 ─────────────────────────────────
on('GET', '/api/stream/:id', async ({ res, req, params, query }) => {
  const found = resolveItem(params.id);
  if (!found) throw HttpError(404, '素材不存在');
  await sendFile(req, res, found.file, {
    contentType: found.item.mime || mimeOf(found.item.ext),
    disposition: query.download === '1' ? 'attachment' : 'inline',
    filename: found.item.name,
    cache: 'public, max-age=604800, immutable',
    onMissing: () => markMissing(params.id),
  });
});

on('GET', '/api/poster/:id', async ({ res, req, params }) => {
  const found = resolveItem(params.id);
  if (!found) throw HttpError(404, '素材不存在');
  if (found.item.kind === 'image') {
    await sendFile(req, res, found.file, {
      contentType: found.item.mime,
      disposition: null,
      cache: 'public, max-age=604800, immutable',
      onMissing: () => markMissing(params.id),
    });
    return;
  }
  if (!found.item.hasPoster) throw HttpError(404, '没有封面');
  await sendFile(req, res, found.poster, {
    contentType: 'image/jpeg',
    disposition: null,
    cache: 'public, max-age=604800, immutable',
  });
});

on('GET', '/api/events', ({ res, query }) => {
  let bundleId = null;
  const ref = query.bundle || query.token;
  if (ref) {
    const bundle = getBundleByRef(ref);
    if (!bundle) throw HttpError(404, '素材夹不存在');
    bundleId = bundle.id;
  }
  addClient(res, { bundleId });
});

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    route.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1]);
    });
    return { handler: route.handler, params };
  }
  return null;
}

export async function handleApi(req, res, url) {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const match = matchRoute(method, url.pathname);
  if (!match) return false;
  const query = Object.fromEntries(url.searchParams.entries());
  await match.handler({ req, res, url, params: match.params, query });
  return true;
}
