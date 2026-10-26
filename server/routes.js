import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { normalizePicked, pickFolder } from './native.js';
import {
  addMark,
  addNote,
  createMember,
  findCopyDuplicates,
  commitItem,
  createBundle,
  createReferenceBundle,
  discardItem,
  getBundleByRef,
  listBundles,
  markMissing,
  memberById,
  memberByToken,
  members as listMembers,
  moveMark,
  nameMember,
  ownerToken,
  purgeBundle,
  removeItem,
  removeMark,
  removeNote,
  rescanBundle,
  restoreMember,
  revokeMember,
  reserveItem,
  resolveItem,
  serializeBundle,
  serializeItem,
  setPoster,
  storageReport,
  setStatuses,
  shareActive,
  totals,
  unlistBundle,
  updateBundle,
  updateItem,
} from './store.js';
import {
  append as archiveAppend,
  findPriorByRoot,
  footprint as archiveFootprint,
  posterPath as archivePosterPath,
  read as readArchive,
  summaries as archiveSummaries,
} from './archive.js';
import { ARCHIVE_KINDS, OP_LABEL } from '../public/js/archive-labels.js';
import { statusLabel } from '../public/js/statuses.js';
import { sendFile, sendJson } from './media.js';
import { addClient, clientCount } from './bus.js';
import { ALLOWED_EXT, SKIP_DIR, cookieValue, extOf, isLocalMachine, mimeOf, readJson, safeEqual, sanitizeSegment, streamToDisk } from './util.js';

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

function bundlePayload(bundle, req, { withRoot = false, scope = '' } = {}) {
  const payload = serializeBundle(bundle, { withRoot, scope });
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
  const head = ['序号', '文件名', '相对路径', '类型', '时长', '体积(字节)', '状态', '标注人', '标注时间', '标记', '备注', '源文件'];
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
    (item.marks ?? []).map((m) => `[${hhmmss(m.t)}]`).join(' ｜ '),
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
  const owner = isOwner(req);
  const member = memberOf(req);
  sendJson(res, 200, {
    ok: true,
    name: config.appName,
    version: config.version,
    uptime: Math.round(process.uptime()),
    viewers: clientCount(),
    local: config.libraryFromLan || isLocalMachine(req.socket?.remoteAddress),
    owner,
    member: member ? { id: member.id, name: member.name } : null,
    // 库的规模与磁盘占用只给管得着库的人；访客只要知道服务在不在线
    totals: owner || member ? totals(owner ? {} : { ownerId: member.id }) : null,
    storage: owner ? await storageReport() : null,
    baseUrl: baseFromRequest(req),
    lan: lanAddresses(),
    limits: { maxUploadBytes: config.maxUploadBytes, maxFilesPerBundle: config.maxFilesPerBundle },
  });
});

on('GET', '/api/bundles', async ({ res, req }) => {
  const member = requireLibrary(req);
  const ownerId = member ? member.id : null;
  sendJson(res, 200, {
    bundles: listBundles({ withRoot: true, ownerId }),
    totals: totals({ ownerId }),
    storage: member ? null : await storageReport(),
    archive: await archiveFootprint({ ownerId }),
    members: member ? null : listMembers(),
    me: member ? { id: member.id, name: member.name } : null,
    mount: await mountCapability(req),
    lan: lanAddresses(),
    port: currentPort,
  });
});

on('POST', '/api/bundles', async ({ res, req }) => {
  const member = requireLibrary(req);
  const body = await readJson(req);
  const bundle = createBundle({
    name: body.name ?? '未命名素材夹',
    description: body.description,
    by: actorName(req, '机主'),
    kind: actorKind(req),
    ownerId: member ? member.id : 'machine',
  });
  sendJson(res, 201, serializeBundle(bundle, { withItems: false }));
});

on('GET', '/api/bundles/:ref', ({ res, req, params }) => {
  const bundle = requireBundleAccess(req, params.ref);
  sendJson(res, 200, bundlePayload(bundle, req, { withRoot: true }));
});

on('PATCH', '/api/bundles/:ref', async ({ res, req, params }) => {
  requireBundleAccess(req, params.ref);
  const body = await readJson(req);
  const bundle = updateBundle(params.ref, body, actorName(req, '机主'), actorKind(req));
  if (!bundle) throw HttpError(404, '素材夹不存在');
  sendJson(res, 200, serializeBundle(bundle, { withItems: false }));
});

on('DELETE', '/api/bundles/:ref', async ({ res, req, params, query }) => {
  requireBundleAccess(req, params.ref);
  const purge = query.purge === '1';
  // 连档案一起抹掉是全站级的破坏动作，成员只能撤下自己名下的夹子，记录仍然留着
  if (purge) requireOwner(req);
  const by = actorName(req, '机主');
  const kind = actorKind(req);
  const result = purge ? await purgeBundle(params.ref, { by, kind }) : await unlistBundle(params.ref, { by, kind });
  if (!result) throw HttpError(404, '素材夹不存在');
  sendJson(res, 200, { removed: true, archived: !purge, ...result });
});

on('GET', '/api/bundles/:ref/export', ({ res, req, params, query }) => {
  const bundle = requireBundleAccess(req, params.ref);
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

// ── 评审档案：素材夹撤下之后仍然看得见的东西 ──────────────────────────────
const at = (rec) => (rec.at ? new Date(rec.at).toLocaleString('zh-CN', { hour12: false }) : '');
const when = (t) => (t === null || t === undefined ? '' : `[${hhmmss(t)}]`);

/** 把一条记录摊成一句人话，导出表和研究档案的人看同一份口径 */
function describeRecord(rec) {
  const d = rec.data ?? {};
  switch (rec.op) {
    case 'status':
      return d.from && d.from !== d.status ? `${statusLabel(d.from)} → ${statusLabel(d.status)}` : statusLabel(d.status);
    case 'note':
      return d.text ?? '';
    case 'note:remove':
      return `删掉 ${d.noteBy ?? '匿名'} 的备注：${d.text ?? ''}`;
    case 'mark':
      return when(d.t);
    case 'mark:move':
      return `${when(d.from)} → ${when(d.to)}`;
    case 'mark:remove':
      return `删掉 ${d.markBy ?? '匿名'} 的时间点 ${when(d.t)}`;
    case 'bundle:create':
      return `新建素材夹（${d.snapshot?.itemCount ?? 0} 个素材）`;
    case 'bundle:mount':
      return `挂载 ${d.snapshot?.root ?? ''} · ${d.count ?? 0} 个素材`;
    case 'bundle:rename':
      return `「${d.from}」→「${d.to}」`;
    case 'bundle:expire':
      return `有效期至 ${d.to ? new Date(d.to).toLocaleString('zh-CN', { hour12: false }) : '永久'}`;
    case 'bundle:rescan':
      return `新增 ${d.added ?? 0} · 移除 ${d.removed ?? 0}${d.revived ? ` · 找回 ${d.revived}` : ''} · 共 ${d.total ?? 0}`;
    case 'bundle:reopen':
      return `接上上一次挂载的记录「${d.previousName}」（${d.previousRecords ?? 0} 条）`;
    case 'item:add':
      return `${rec.item?.name ?? ''} · ${rec.item?.size ?? 0} 字节`;
    case 'item:rename':
      return `「${d.from}」→「${d.to}」`;
    case 'item:remove':
      return `${rec.item?.name ?? ''}（带走 ${d.notes ?? 0} 条备注、${d.marks ?? 0} 个时间点，记录留下）`;
    case 'item:missing':
      return `源文件读不到：${rec.item?.relPath ?? ''}`;
    case 'unlist':
      return `撤下归档：${d.snapshot?.itemCount ?? 0} 个素材 · ${d.notes ?? 0} 条备注 · ${d.posters ?? 0} 张封面已存入档案`;
    case 'legacy:log':
      return `${d.action ?? ''} ${d.item ?? ''}${d.count ? ` ×${d.count}` : ''}${d.status ? ` → ${statusLabel(d.status)}` : ''}`;
    default:
      return JSON.stringify(d);
  }
}

function archiveCsv(bundleName, recs) {
  const head = ['时间', '素材夹', '操作', '署名', '身份', '服务端验证过', '素材', '相对路径', '时间点', '状态', '详情'];
  const rows = recs.map((rec) => [
    at(rec),
    bundleName,
    OP_LABEL(rec.op),
    rec.actor?.name ?? '',
    ARCHIVE_KINDS[rec.actor?.kind]?.label ?? rec.actor?.kind ?? '',
    rec.actor?.verified ? '是' : '否',
    rec.item?.name ?? '',
    rec.item?.relPath ?? '',
    rec.data?.t !== undefined && rec.data?.t !== null ? hhmmss(rec.data.t) : '',
    rec.data?.status ? statusLabel(rec.data.status) : '',
    describeRecord(rec),
  ]);
  const table = [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  return `﻿${table}\r\n`;
}

/**
 * 档案的归属。还在 db 里的按夹子算；已经撤下的只能看档案快照里记着的 ownerId ——
 * 没有这一步，成员就能凭一个 bundleId 读到别人项目的备注原文。
 */
async function archiveOwnerOf(ref) {
  const live = getBundleByRef(ref);
  if (live) return live.ownerId;
  const summary = (await archiveSummaries()).find((b) => b.bundleId === ref);
  return summary?.ownerId ?? '';
}

async function requireArchiveAccess(req, ref) {
  if (isOwner(req)) return null;
  const member = memberOf(req);
  if (!member) throw HttpError(403, '评审档案只对机主与建下这个夹子的人开放');
  if ((await archiveOwnerOf(ref)) !== member.id) throw HttpError(403, '这个素材夹的档案不属于你');
  return member;
}

/** 档案列表：已撤下的和还在映的都列出来，标清哪种是哪种 */
on('GET', '/api/archive', async ({ res, req }) => {
  const member = requireLibrary(req);
  const list = await archiveSummaries();
  const bundles = list
    .filter((item) => !member || item.ownerId === member.id)
    .map((item) => {
      const live = getBundleByRef(item.bundleId);
      return live ? { ...item, name: live.name, live: true, unlistedAt: 0 } : { ...item, live: false };
    });
  sendJson(res, 200, {
    bundles,
    footprint: await archiveFootprint({ ownerId: member ? member.id : null }),
    dir: member ? '' : config.archiveDir,
    baseUrl: baseFromRequest(req),
  });
});

on('GET', '/api/archive/:ref', async ({ res, req, params }) => {
  await requireArchiveAccess(req, params.ref);
  const records = await readArchive(params.ref);
  if (!records.length) throw HttpError(404, '这个素材夹没有档案记录');
  const summary = (await archiveSummaries()).find((b) => b.bundleId === params.ref) ?? null;
  const live = getBundleByRef(params.ref);
  sendJson(res, 200, {
    bundleId: params.ref,
    name: live?.name ?? summary?.name ?? '（已撤下的素材夹）',
    live: Boolean(live),
    unlistedAt: summary?.unlistedAt ?? 0,
    posters: summary?.posters ?? 0,
    root: live?.root ?? summary?.root ?? '',
    people: summary?.people ?? [],
    records: records.map((rec) => ({ ...rec, summary: describeRecord(rec) })),
  });
});

on('GET', '/api/archive/:ref/export', async ({ res, req, params, query }) => {
  await requireArchiveAccess(req, params.ref);
  const records = await readArchive(params.ref, { actor: query.who ?? '', op: query.op ?? '', since: Number(query.since) || 0, q: query.q ?? '' });
  if (!records.length) throw HttpError(404, '没有符合条件的档案记录');
  // 撤下的夹子已经不在 db 里，名字只能从档案自身的快照取，否则会导出成一片 ID
  const summary = (await archiveSummaries()).find((b) => b.bundleId === params.ref) ?? null;
  const name = sanitizeSegment(getBundleByRef(params.ref)?.name ?? summary?.name ?? params.ref, '素材夹');
  const stamp = new Date().toISOString().slice(0, 10);
  if (query.fmt === 'json') {
    const body = JSON.stringify(
      { bundleId: params.ref, name, exportedAt: Date.now(), version: config.version, records },
      null,
      2,
    );
    sendDownload(res, `${name}-评审档案-${stamp}.json`, 'application/json; charset=utf-8', body);
    return;
  }
  sendDownload(res, `${name}-评审档案-${stamp}.csv`, 'text/csv; charset=utf-8', archiveCsv(name, records));
});

/** 撤下归档时保下来的封面：素材夹没了，这几张图是当时画面的唯一残留 */
on('GET', '/api/archive/:ref/posters/:itemId', async ({ res, req, params, query }) => {
  await requireArchiveAccess(req, params.ref);
  await sendFile(req, res, archivePosterPath(params.ref, params.itemId), {
    contentType: 'image/jpeg',
    disposition: query.download === '1' ? 'attachment' : 'inline',
    filename: `${params.itemId}.jpg`,
    cache: 'public, max-age=604800',
  });
});

// ── 入库：请求体原样落盘，无 multipart 解析、无云端中转 ──────────────────
on('POST', '/api/bundles/:ref/items', async ({ res, req, query, params }) => {
  const bundle = requireBundleAccess(req, params.ref);
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
      by: actorName(req, '机主'),
      kind: actorKind(req),
    });
    sendJson(res, 201, { item: serializeItem(item) });
  } catch (err) {
    await discardItem(bundle, reserved.item);
    throw err;
  }
});

on('POST', '/api/items/:id/poster', async ({ res, req, params }) => {
  requireItemAccess(req, params.id);
  const found = resolveItem(params.id);
  const { bytes } = await streamToDisk(req, found.poster, config.maxPosterBytes);
  const item = setPoster(params.id, bytes);
  if (!item) {
    await removeItem(params.id, actorName(req, '机主'), actorKind(req));
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
 * 成员：拿邀请链接换来的 Cookie（或 x-member-token 头）。
 * 机主请求一律返回 null —— 两枚凭证都在时机主说话，不让成员身份把全站权限降级。
 */
export function memberOf(req) {
  if (isOwner(req)) return null;
  const given = String(req.headers['x-member-token'] ?? '').trim() || cookieValue(req.headers.cookie, config.memberCookie);
  return given ? memberByToken(given) : null;
}

/** 素材库入口：机主或成员。返回成员对象（机主返回 null），具体到每个路由再按归属收。 */
function requireLibrary(req) {
  if (isOwner(req)) return null;
  const member = memberOf(req);
  if (!member) throw HttpError(403, '素材库只对运行 LanReel 的这台电脑开放；同事请用 /s/ 分享链接，或者让机主发一条邀请链接');
  return member;
}

/**
 * 档案里盖章用的身份与名字。
 * 机主与成员的署名由服务端说了算（verified=true）——成员的名字是加入那一步定下来的，
 * 浏览器再传什么作者名都不采信。只有从分享链接进来的同事是自报的（verified=false）。
 */
const actorKind = (req) => (isOwner(req) ? 'owner' : memberOf(req) ? 'member' : 'guest');

function actorName(req, fallback = '') {
  if (isOwner(req)) return String(fallback ?? '').trim() || '机主';
  const member = memberOf(req);
  if (member) return member.name || '同事';
  return String(fallback ?? '').trim();
}

/** 这个夹子你能不能管：机主不限，成员只能管自己名下的 */
function requireBundleAccess(req, ref) {
  const bundle = getBundleByRef(ref);
  if (!bundle) throw HttpError(404, '素材夹不存在');
  if (isOwner(req)) return bundle;
  const member = memberOf(req);
  if (member && bundle.ownerId === member.id) return bundle;
  throw HttpError(403, member ? '这个素材夹不是你建的' : '请先用邀请链接登录，或走 /s/ 分享链接');
}

/** 单条素材的管理动作：先认出它属于哪个夹子，再按夹子归属放行 */
function requireItemAccess(req, itemId) {
  const found = resolveItem(itemId);
  if (!found) throw HttpError(404, '素材不存在');
  requireBundleAccess(req, found.bundle.id);
  return found;
}

/**
 * 评审写操作（状态、备注、打点）的作用域。
 * null = 机主，不限夹子；否则是一个 {member, bundle} —— 成员名下的夹子随便动，
 * 别人的（以及访客的）只能动分享码指到的那一个。没有这一步，拿到一条链接的人就能凭素材 ID 改全站。
 */
function reviewScope(req) {
  if (isOwner(req)) return null;
  const member = memberOf(req);
  const token = String(req.headers['x-share-token'] ?? '').trim();
  const shared = token ? getBundleByRef(token) : null;
  if (shared && !shareActive(shared)) throw HttpError(410, '分享链接已过期');
  const scope = { member, bundle: shared && shared.token === token ? shared : null };
  if (!member && !scope.bundle) {
    throw HttpError(403, '请先通过分享链接打开这个素材夹再评审（缺少有效分享码）');
  }
  return scope;
}

function scopeAllows(scope, bundle) {
  if (!scope) return true;
  if (scope.member && bundle && bundle.ownerId === scope.member.id) return true;
  return Boolean(scope.bundle && bundle && scope.bundle.id === bundle.id);
}

function requireScopedItem(scope, itemId) {
  const found = resolveItem(itemId);
  if (!found) throw HttpError(404, '素材不存在');
  if (!scopeAllows(scope, found.bundle)) throw HttpError(403, '这条素材不属于你能评审的范围');
  return found;
}

function requireScopedIds(scope, ids) {
  if (!scope) return ids;
  const outside = ids.filter((itemId) => {
    const found = resolveItem(itemId);
    return !found || !scopeAllows(scope, found.bundle);
  });
  if (outside.length) throw HttpError(403, `有 ${outside.length} 条素材不属于你能评审的范围`);
  return ids;
}

/**
 * 供片作用域：机主不限；成员能读自己名下的夹子；其他人只能读自己那条分享链接里的素材。
 * `<img>` / `<video>` 带不上自定义头，所以访客的媒体地址由服务端写好 `?t=<分享码>`（见 store.js）。
 * 少了这一步，任何同网设备拿一个 itemId 就能读走从未分享过的素材。
 */
function requireMediaAccess(req, found, query = {}) {
  if (isOwner(req)) return;
  const member = memberOf(req);
  if (member && found.bundle.ownerId === member.id) return;
  const token = String(query.t ?? '').trim() || String(req.headers['x-share-token'] ?? '').trim();
  const bundle = token ? getBundleByRef(token) : null;
  if (!bundle || bundle.token !== token) throw HttpError(403, '缺少有效的分享码，请从分享链接打开');
  if (!shareActive(bundle)) throw HttpError(410, '分享链接已过期');
  if (found.bundle.id !== bundle.id) throw HttpError(403, '这条素材不属于当前分享链接');
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

// ── 成员：机主发邀请链接，同事点开换一枚 Cookie ───────────────────────────
// 不是账号体系：没有密码、没有注册。邀请码本身就是凭证（和分享码一个道理），
// 差别在于它换到的是「能建自己夹子的人」，而不是一条只读链接。
on('GET', '/api/members', ({ res, req }) => {
  requireOwner(req);
  sendJson(res, 200, { members: listMembers() });
});

on('POST', '/api/members', async ({ res, req }) => {
  requireOwner(req);
  const body = await readJson(req);
  const member = createMember({ name: body.name, by: actorName(req, '机主') });
  const [view] = listMembers().filter((m) => m.id === member.id);
  sendJson(res, 201, {
    member: view,
    // 邀请码只在这一次回给机主，之后任何接口都不再吐它
    invite: { token: member.token, url: `/j/${member.token}`, link: `${baseFromRequest(req)}/j/${member.token}` },
  });
});

/** 停用只作废凭证：他名下的夹子与已经留下的记录都还在，由机主收尾 */
on('POST', '/api/members/:ref/revoke', ({ res, req, params }) => {
  requireOwner(req);
  const member = revokeMember(params.ref);
  if (!member) throw HttpError(404, '成员不存在');
  sendJson(res, 200, { member: listMembers().find((m) => m.id === member.id) });
});

on('POST', '/api/members/:ref/restore', ({ res, req, params }) => {
  requireOwner(req);
  const member = restoreMember(params.ref);
  if (!member) throw HttpError(404, '成员不存在');
  sendJson(res, 200, { member: listMembers().find((m) => m.id === member.id) });
});

/** 邀请页先拿这个确认码还有效、机主是不是已经替他写了名字 */
on('GET', '/api/join/:token', ({ res, req, params }) => {
  const member = memberByToken(params.token);
  if (!member) throw HttpError(403, '这条邀请链接无效或已被机主停用');
  sendJson(res, 200, { valid: true, name: member.name, needsName: !member.name });
});

/**
 * 兑换邀请：种一枚成员 Cookie。名字在这里定一次就固定 ——
 * 之后他的每一条留痕都记这个名字，浏览器再传什么都不采信。
 */
on('POST', '/api/join', async ({ res, req }) => {
  const body = await readJson(req);
  const member = memberByToken(String(body.token ?? '').trim());
  if (!member) throw HttpError(403, '邀请链接无效或已停用，请让机主重新发一条');
  const named = nameMember(member.id, body.name) ?? member;
  res.setHeader('Set-Cookie', `${config.memberCookie}=${encodeURIComponent(named.token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
  sendJson(res, 200, { ok: true, name: named.name || '同事' });
});

on('POST', '/api/member/leave', ({ res }) => {
  res.setHeader('Set-Cookie', `${config.memberCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  sendJson(res, 200, { ok: true });
});

// ── 零拷贝挂载：素材留在原目录，不复制进 data/ ───────────────────────────
const isLocalReq = (req) => isLocalMachine(req.socket?.remoteAddress);

/**
 * 谁能挂目录。
 * 本机：机主自己在这台电脑上操作，想挂哪挂哪。
 * 非本机：要有成员身份或机主口令，而且路径必须落在 MOUNT_ROOTS 白名单底下 ——
 * 连远程的机主口令也受这条限制，因为口令可能是在咖啡馆的手机上输的。
 */
function mountActor(req) {
  if (isLocalReq(req)) return { local: true, member: null };
  const member = memberOf(req);
  if (member) return { local: false, member };
  if (isOwner(req)) return { local: false, member: null };
  throw HttpError(403, '挂载目录需要机主口令，或邀请链接换来的成员身份');
}

/**
 * 白名单根的「真实」形态。macOS 上 /tmp 其实是 /private/tmp，符号链接卷名也会被展开：
 * 校验要用 realpath，回给前端的路径也要用，否则目录浏览器里「上一级」的判断对不上号。
 * 根当前没挂上（盘没插、共享掉线）就退回原样，让错误信息由挂载那一步去报。
 */
async function realMountRoots() {
  return Promise.all(config.mountRoots.map((r) => fsp.realpath(r).catch(() => r)));
}

/** 白名单校验：realpath 之后再前缀匹配，符号链接指向外面也不算在里面 */
async function resolveWithinRoots(target) {
  if (!config.mountRoots.length) {
    throw HttpError(403, '这台 LanReel 没有开放远程挂载；要开放请机主启动时设 MOUNT_ROOTS');
  }
  const real = await fsp.realpath(target).catch(() => null);
  if (!real) throw HttpError(400, '目录不存在或无权访问');
  const roots = await realMountRoots();
  if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) {
    throw HttpError(403, `只能挂载机主允许的目录：${roots.join(' / ')}`);
  }
  return real;
}

/** 这次请求能挂哪些地方：能力 + 白名单，前端据此决定挂载面板长什么样 */
async function mountCapability(req) {
  const local = isLocalReq(req);
  return {
    allowed: local || Boolean(config.mountRoots.length),
    local,
    roots: await realMountRoots(),
  };
}

on('POST', '/api/mounts', async ({ res, req }) => {
  const { local, member } = mountActor(req);
  const body = await readJson(req);
  let picked = normalizePicked(body.path);
  if (!picked) throw HttpError(400, '先选一个目录');
  if (!local) picked = await resolveWithinRoots(picked);
  // 同一个源目录以前挂过又撤了：档案里那段历史要接得上，评审记录不会跟着夹子一起消失
  const prior = await findPriorByRoot(picked);
  const bundle = await createReferenceBundle(picked, body.name, {
    by: actorName(req, '机主'),
    kind: actorKind(req),
    ownerId: member ? member.id : 'machine',
    prior,
  });
  const payload = serializeBundle(bundle, { withItems: false, withRoot: true });
  payload.duplicates = findCopyDuplicates(bundle);
  payload.priorArchive = prior ? { bundleId: prior.bundleId, name: prior.name, records: prior.records } : null;
  sendJson(res, 201, payload);
});

/**
 * 目录浏览器：给不在本机的人挑挂载路径用（原生选择器只能弹在跑 LanReel 的那台屏幕上）。
 * 只列目录、不列文件，而且非本机一律先过白名单。
 */
on('GET', '/api/browse', async ({ res, req, query }) => {
  const { local } = mountActor(req);
  const roots = await realMountRoots();
  const start = query.path ? normalizePicked(query.path) : local ? os.homedir() : roots[0];
  if (!start) throw HttpError(400, '没有可浏览的目录；机主启动时设 MOUNT_ROOTS 才能远程挂载');
  const target = local ? await fsp.realpath(start).catch(() => start) : await resolveWithinRoots(start);
  const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => {
    throw HttpError(400, '读不到这个目录');
  });
  const dirs = [];
  for (const entry of entries) {
    if (dirs.length >= 500) break;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.') || SKIP_DIR.has(entry.name)) continue;
    dirs.push({ name: entry.name, path: path.join(target, entry.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  const parent = path.dirname(target);
  sendJson(res, 200, {
    path: target,
    parent: parent && parent !== target ? parent : '',
    dirs,
    roots,
    truncated: dirs.length >= 500,
  });
});

// 让本机弹出系统文件夹选择器，拿回绝对路径（浏览器自己做不到这一点）
on('POST', '/api/pick-folder', async ({ res, req }) => {
  requireLocal(req);
  const result = await pickFolder();
  if (result.error) throw HttpError(501, result.error);
  sendJson(res, 200, result.cancelled ? { cancelled: true } : { path: result.path });
});

on('POST', '/api/bundles/:ref/rescan', async ({ res, req, params }) => {
  requireBundleAccess(req, params.ref);
  const result = await rescanBundle(params.ref, { by: actorName(req, '机主'), kind: actorKind(req) });
  if (!result) throw HttpError(409, '只有挂载目录需要重新扫描');
  sendJson(res, 200, result);
});

// ── 评审：状态 + 备注 ────────────────────────────────────────────────────
// 改名与删除是管理动作：机主，或建下这个夹子的成员
on('PATCH', '/api/items/:id', async ({ res, req, params }) => {
  requireItemAccess(req, params.id);
  const body = await readJson(req);
  const item = updateItem(params.id, { ...body, by: actorName(req, body.by), kind: actorKind(req) });
  if (!item) throw HttpError(404, '素材不存在');
  sendJson(res, 200, serializeItem(item));
});

on('DELETE', '/api/items/:id', async ({ res, req, params }) => {
  requireItemAccess(req, params.id);
  const ok = await removeItem(params.id, actorName(req, '机主'), actorKind(req));
  if (!ok) throw HttpError(404, '素材不存在');
  sendJson(res, 200, { removed: true });
});

// 打状态、写备注：机主、建夹子的成员、以及拿着分享链接的同事都可以
on('POST', '/api/items/status', async ({ res, req }) => {
  const scope = reviewScope(req);
  const body = await readJson(req);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 2000) : [];
  if (!ids.length) throw HttpError(400, '未选择素材');
  requireScopedIds(scope, ids);
  const changed = setStatuses(ids, String(body.status ?? 'unset'), actorName(req, body.by), actorKind(req));
  sendJson(res, 200, { changed: changed.length, status: body.status });
});

on('POST', '/api/items/:id/notes', async ({ res, req, params }) => {
  const scope = reviewScope(req);
  requireScopedItem(scope, params.id);
  const body = await readJson(req);
  const note = addNote(params.id, { text: body.text, author: actorName(req, body.author), t: body.t, kind: actorKind(req) });
  if (!note) throw HttpError(404, '素材不存在');
  sendJson(res, 201, note);
});

on('DELETE', '/api/items/:id/notes/:noteId', ({ res, req, params, query }) => {
  const scope = reviewScope(req);
  requireScopedItem(scope, params.id);
  const by = actorName(req, query.by ? sanitizeSegment(query.by, '') : '');
  const note = removeNote(params.id, params.noteId, by, Boolean(scope), actorKind(req));
  if (!note) throw HttpError(404, '备注不存在');
  sendJson(res, 200, { removed: true });
});

// 打点：时间轴上的独立时间点，评审时先落点，备注随后跟
on('POST', '/api/items/:id/marks', async ({ res, req, params }) => {
  const scope = reviewScope(req);
  requireScopedItem(scope, params.id);
  const body = await readJson(req);
  const mark = addMark(params.id, { t: body.t, author: actorName(req, body.author), kind: actorKind(req) });
  if (!mark) throw HttpError(404, '素材不存在');
  sendJson(res, 201, mark);
});

on('PATCH', '/api/items/:id/marks/:markId', async ({ res, req, params }) => {
  const scope = reviewScope(req);
  requireScopedItem(scope, params.id);
  const body = await readJson(req);
  const by = actorName(req, body.by ? sanitizeSegment(body.by, '') : '');
  const mark = moveMark(params.id, params.markId, { t: body.t, by }, Boolean(scope), actorKind(req));
  if (!mark) throw HttpError(404, '标记不存在');
  sendJson(res, 200, mark);
});

on('DELETE', '/api/items/:id/marks/:markId', ({ res, req, params, query }) => {
  const scope = reviewScope(req);
  requireScopedItem(scope, params.id);
  const by = actorName(req, query.by ? sanitizeSegment(query.by, '') : '');
  const mark = removeMark(params.id, params.markId, by, Boolean(scope), actorKind(req));
  if (!mark) throw HttpError(404, '标记不存在');
  sendJson(res, 200, { removed: true });
});

// ── 分享视图 ─────────────────────────────────────────────────────────────
on('GET', '/api/share/:token', ({ res, req, params }) => {
  const bundle = getBundleByRef(params.token);
  if (!bundle) throw HttpError(404, '分享链接不存在或已删除');
  if (!shareActive(bundle)) throw HttpError(410, '分享链接已过期');
  // 访客的媒体地址统一带上这条链接的分享码，供 requireMediaAccess 校验
  sendJson(res, 200, bundlePayload(bundle, req, { scope: bundle.token }));
});

// ── 流媒体：Range 支持 = 秒开 + 任意拖拽 ─────────────────────────────────
on('GET', '/api/stream/:id', async ({ res, req, params, query }) => {
  const found = resolveItem(params.id);
  if (!found) throw HttpError(404, '素材不存在');
  requireMediaAccess(req, found, query);
  await sendFile(req, res, found.file, {
    contentType: found.item.mime || mimeOf(found.item.ext),
    disposition: query.download === '1' ? 'attachment' : 'inline',
    filename: found.item.name,
    cache: 'public, max-age=604800, immutable',
    onMissing: () => markMissing(params.id),
  });
});

on('GET', '/api/poster/:id', async ({ res, req, params, query }) => {
  const found = resolveItem(params.id);
  if (!found) throw HttpError(404, '素材不存在');
  requireMediaAccess(req, found, query);
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

/**
 * 实时同步。以前不带参数的订阅谁都能连，而广播里又带着分享码 —— 等于把
 * 从未分享过的素材夹白送给同网任何一台设备。现在同事必须用自己那条分享码订阅，
 * 而且只回放那个夹子；机主听全站，成员只听到自己名下的夹子。
 */
on('GET', '/api/events', ({ res, req, query }) => {
  const ref = String(query.bundle || query.token || '').trim();
  if (isOwner(req)) {
    const bundle = ref ? getBundleByRef(ref) : null;
    if (ref && !bundle) throw HttpError(404, '素材夹不存在');
    addClient(res, { bundleId: bundle?.id ?? null });
    return;
  }
  const member = memberOf(req);
  const requested = ref ? getBundleByRef(ref) : null;
  // 成员订阅自己的库：判定交给 bus 现算，否则他刚建的夹子收不到自己的事件
  if (member && (!ref || requested?.ownerId === member.id)) {
    addClient(res, {
      can: (payload) => {
        const bundle = payload.bundleId ? getBundleByRef(payload.bundleId) : null;
        return bundle ? bundle.ownerId === member.id : false;
      },
    });
    return;
  }
  if (!ref) throw HttpError(403, '请从分享链接打开后再订阅实时同步');
  if (!requested || requested.token !== ref) throw HttpError(403, '分享码无效，请让同事重新发一条链接');
  if (!shareActive(requested)) throw HttpError(410, '分享链接已过期');
  addClient(res, { bundleId: requested.id });
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
