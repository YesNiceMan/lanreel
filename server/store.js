import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { extOf, id, kindOf, mimeOf, sanitizeRelPath, sanitizeSegment, safeEqual, walkMedia } from './util.js';
import { STATUS_KEYS } from '../public/js/statuses.js';
import {
  actor as archiveActor,
  append as archiveAppend,
  bundleSnapshot,
  findPriorByRoot,
  hasRecords,
  movePosters,
  removeArchive,
  snapshot as itemSnapshot,
} from './archive.js';

export const events = new EventEmitter();

const EMPTY = { version: 1, meta: {}, bundles: [] };
let db = { version: 1, meta: {}, bundles: [] };
const bundleIndex = new Map();
const itemIndex = new Map();
/** 每个夹子保留的操作流水条数上限 */
const LOG_CAP = 500;

function reindex() {
  bundleIndex.clear();
  itemIndex.clear();
  for (const bundle of db.bundles) {
    bundleIndex.set(bundle.id, bundle);
    for (const item of bundle.items) {
      item.status = STATUS_KEYS.includes(item.status) ? item.status : 'unset';
      itemIndex.set(item.id, { item, bundle });
    }
  }
}

/** 备注时间点：秒，保留一位小数；没有就返回 null（注意 Number(null) === 0） */
function clampSeconds(value, digits = 1) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const f = 10 ** digits;
  return Math.round(Math.min(n, 86400) * f) / f;
}

function normalizeMarks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && clampSeconds(m.t, 3) !== null)
    .map((m) => ({
      id: typeof m.id === 'string' && m.id ? m.id : id(8),
      t: clampSeconds(m.t, 3),
      author: sanitizeSegment(m.author ?? '匿名', '匿名').slice(0, 40),
      createdAt: Number(m.createdAt) || Date.now(),
    }))
    .sort((a, b) => a.t - b.t);
}

function normalizeItem(raw, bundle) {
  const name = sanitizeSegment(raw?.name ?? 'untitled');
  const relPath = sanitizeRelPath(raw?.relPath ?? name, name);
  const ext = extOf(name) || extOf(relPath);
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : id(),
    name,
    relPath,
    ext,
    kind: raw?.kind && raw.kind !== 'other' ? raw.kind : kindOf(name),
    mime: raw?.mime || mimeOf(ext),
    size: Number(raw?.size) || 0,
    // 源文件的修改时间：挂载素材没有内容哈希，重挂认领旧档案只能靠 相对路径+体积+这个
    mtimeMs: Number(raw?.mtimeMs) || 0,
    duration: Number(raw?.duration) || 0,
    width: Number(raw?.width) || 0,
    height: Number(raw?.height) || 0,
    hasPoster: Boolean(raw?.hasPoster),
    absPath: typeof raw?.absPath === 'string' && raw.absPath ? raw.absPath : '',
    // 供片时读不到文件就记下来，界面不再假装还能播
    missing: Boolean(raw?.missing),
    digest: typeof raw?.digest === 'string' ? raw.digest : '',
    status: STATUS_KEYS.includes(raw?.status) ? raw.status : 'unset',
    statusBy: typeof raw?.statusBy === 'string' ? raw.statusBy.slice(0, 40) : '',
    statusAt: Number(raw?.statusAt) || 0,
    notes: Array.isArray(raw?.notes)
      ? raw.notes
          .filter((n) => n && typeof n.text === 'string' && n.text.trim())
          .map((n) => ({
            id: n.id || id(8),
            text: String(n.text).slice(0, 4000),
            author: sanitizeSegment(n.author ?? '匿名', '匿名').slice(0, 40),
            createdAt: Number(n.createdAt) || Date.now(),
            t: clampSeconds(n.t),
          }))
      : [],
    marks: normalizeMarks(raw?.marks),
    pending: Boolean(raw?.pending),
    createdAt: Number(raw?.createdAt) || Date.now(),
    updatedAt: Number(raw?.updatedAt) || Date.now(),
    bundleId: bundle.id,
  };
}

function normalizeBundle(raw) {
  const bundle = {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : id(10),
    token: typeof raw?.token === 'string' && raw.token ? raw.token : id(),
    name: sanitizeSegment(raw?.name ?? '未命名素材夹', '未命名素材夹'),
    description: typeof raw?.description === 'string' ? raw.description.slice(0, 600) : '',
    expiresAt: Number(raw?.expiresAt) || 0,
    mode: raw?.mode === 'reference' ? 'reference' : 'copy',
    root: typeof raw?.root === 'string' ? raw.root : '',
    // 归属：'machine' = 机主本机建的夹子。P2 的邀请制成员会填自己的 id，这里先把字段落进 schema。
    ownerId: typeof raw?.ownerId === 'string' && raw.ownerId ? raw.ownerId : 'machine',
    createdAt: Number(raw?.createdAt) || Date.now(),
    updatedAt: Number(raw?.updatedAt) || Date.now(),
    log: normalizeLog(raw?.log),
    items: [],
  };
  bundle.items = (Array.isArray(raw?.items) ? raw.items : []).map((item) => normalizeItem(item, bundle));
  return bundle;
}

/**
 * 评审写操作的归属校验。
 * strict = 从分享链接进来的同事：必须报上自己的名字，且只能动这个名字名下的内容，
 * 缺 `by` 一律当作越权（以前是「不传就放行」，任何人删别人备注都不用付出代价）。
 * 机主（本机或口令）保持豁免，负责收尾清理。
 */
function assertMine(author, by, strict, verb, errStatus = 403) {
  const who = String(author ?? '');
  const me = String(by ?? '');
  if (strict && (!me || who !== me)) throw Object.assign(new Error(`只能${verb}自己的内容`), { status: errStatus });
  if (!strict && me && who && who !== me) throw Object.assign(new Error(`只能${verb}自己的内容`), { status: errStatus });
}

function normalizeLog(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e === 'object')
    .slice(-LOG_CAP)
    .map((e) => ({
      t: Number(e.t) || Date.now(),
      by: typeof e.by === 'string' ? e.by.slice(0, 40) : '',
      action: typeof e.action === 'string' ? e.action.slice(0, 24) : 'change',
      item: typeof e.item === 'string' ? e.item.slice(0, 200) : '',
      status: STATUS_KEYS.includes(e.status) ? e.status : '',
      count: Number(e.count) || 0,
    }));
}

/** 追加一条操作流水（谁在什么时候对哪条素材做了什么），超出上限丢最旧的 */
function logAction(bundle, entry) {
  if (!bundle) return;
  bundle.log = normalizeLog([...(bundle.log ?? []), { t: Date.now(), ...entry }]);
}

/**
 * 留痕：往档案里追加一条。kind 一律由路由盖章（owner / member / guest），
 * 默认 guest —— 忘记传参数时最多少一份可信度，不会把自报的名字洗成验证过的。
 */
function archive(bundle, op, { by = '', kind = 'guest', item = null, data = {} } = {}) {
  if (!bundle) return;
  archiveAppend(bundle.id, {
    op,
    actor: archiveActor(by, kind),
    item: itemSnapshot(item),
    data,
  });
}

let writeChain = Promise.resolve();
let dirty = false;
let timer = null;

async function writeNow() {
  const tmp = `${config.dbFile}.${process.pid}.tmp`;
  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, config.dbFile);
}

function flush() {
  if (!dirty) return writeChain;
  dirty = false;
  writeChain = writeChain.then(writeNow).catch((err) => {
    console.error('[store] 写入失败:', err.message);
  });
  return writeChain;
}

export function persist() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flush, 40);
}

export async function flushAndWait() {
  clearTimeout(timer);
  await flush();
  await writeChain;
}

function touch(bundle) {
  bundle.updatedAt = Date.now();
  persist();
}

/**
 * 实时事件里不带 token：拿着它就等于拿着分享链接，能直接读走整个夹子。
 * 订阅方要么是本机/口令（机主），要么本来就知道自己那条分享码（见 routes.js 的 /api/events）。
 */
function emit(type, bundle, extra = {}) {
  events.emit('change', { type, bundleId: bundle?.id ?? null, at: Date.now(), ...extra });
}

/**
 * 机主口令：环境变量优先（不落盘），否则首启随机生成一份存进 db.meta。
 * 拿着它就能在局域网里的其他设备上管理素材库，省去 LIBRARY_FROM_LAN=1 那种把写入权交给全网的开法。
 */
export function ownerToken() {
  return config.ownerToken || db.meta?.ownerToken || '';
}

function ensureOwnerToken() {
  if (config.ownerToken || db.meta?.ownerToken) return false;
  db.meta.ownerToken = id(9);
  return true;
}

/** 这些流水已经被 note/mark/status 记录覆盖了，回灌时不再重复写一遍 */
const REVIEW_LOG_ACTIONS = new Set(['note', 'note-remove', 'mark', 'mark-move', 'mark-remove', 'status']);

/** 旧库里的评审数据摊平成时间线；署名一律标 legacy，因为当年服务端没验证过名字 */
function legacyRecords(bundle) {
  const who = (name) => ({ name: String(name || '匿名').slice(0, 40), kind: 'legacy', verified: false });
  const out = [
    {
      op: bundle.mode === 'reference' ? 'bundle:mount' : 'bundle:create',
      at: bundle.createdAt,
      actor: who('机主'),
      item: null,
      data: { snapshot: bundleSnapshot(bundle), count: bundle.items.length, legacy: true },
    },
  ];
  for (const item of bundle.items) {
    if (item.status !== 'unset') {
      out.push({
        op: 'status',
        at: item.statusAt || item.updatedAt,
        actor: who(item.statusBy),
        item: itemSnapshot(item),
        data: { status: item.status, legacy: true },
      });
    }
    for (const note of item.notes) {
      out.push({
        op: 'note',
        at: note.createdAt,
        actor: who(note.author),
        item: itemSnapshot(item),
        data: { text: note.text, t: note.t, noteId: note.id, legacy: true },
      });
    }
    for (const mark of item.marks ?? []) {
      out.push({
        op: 'mark',
        at: mark.createdAt,
        actor: who(mark.author),
        item: itemSnapshot(item),
        data: { t: mark.t, markId: mark.id, legacy: true },
      });
    }
  }
  for (const entry of bundle.log ?? []) {
    if (REVIEW_LOG_ACTIONS.has(entry.action)) continue;
    out.push({
      op: 'legacy:log',
      at: entry.t,
      actor: who(entry.by),
      item: null,
      data: { action: entry.action, item: entry.item, status: entry.status, count: entry.count, legacy: true },
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 升级前的记录只活在 db.json 的夹子内部，删了就没了。首次启动把它们回灌成档案。
 * 已经有档案的夹子跳过，所以重启或回滚后再升级都不会写重。
 */
async function backfillArchives() {
  let bundles = 0;
  let records = 0;
  for (const bundle of db.bundles) {
    if (await hasRecords(bundle.id)) continue;
    const recs = legacyRecords(bundle);
    await Promise.all(recs.map((rec) => archiveAppend(bundle.id, rec)));
    bundles += 1;
    records += recs.length;
  }
  return { bundles, records };
}

/**
 * 成员不是账号体系：没有密码、没有注册页。机主发一条 /j/<邀请码> 链接，
 * 对方点开换一枚 HttpOnly Cookie，就能建自己的夹子、上传、分享、看自己的档案。
 * 换来的关键好处是留痕里的名字由服务端盖章（verified=true），不再是浏览器自报。
 */
function normalizeMember(raw) {
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : id(8),
    token: typeof raw?.token === 'string' && raw.token ? raw.token : id(12),
    name: typeof raw?.name === 'string' ? sanitizeSegment(raw.name, '').slice(0, 40) : '',
    createdAt: Number(raw?.createdAt) || Date.now(),
    revoked: Boolean(raw?.revoked),
    createdBy: typeof raw?.createdBy === 'string' ? raw.createdBy.slice(0, 40) : '机主',
  };
}

/** 对外暴露的成员视图：不含 token，邀请码只在生成那一刻回给机主一次 */
export function members() {
  return (db.meta.members ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    createdAt: m.createdAt,
    revoked: m.revoked,
    createdBy: m.createdBy,
    bundles: db.bundles.filter((b) => b.ownerId === m.id).length,
  }));
}

export function createMember({ name = '', by = '机主' } = {}) {
  const member = normalizeMember({ name, createdBy: by });
  db.meta.members = [...(db.meta.members ?? []), member];
  persist();
  return member;
}

export function memberByToken(token) {
  const given = String(token ?? '');
  if (!given) return null;
  return (db.meta.members ?? []).find((m) => !m.revoked && m.token && safeEqual(m.token, given)) ?? null;
}

export function memberById(ref) {
  return (db.meta.members ?? []).find((m) => m.id === ref) ?? null;
}

/** 邀请时没写名字，才由对方在加入那一步填一次；填过就固定，省得同一个人两个署名 */
export function nameMember(ref, name) {
  const member = memberById(ref);
  if (!member) return null;
  if (!member.name) member.name = sanitizeSegment(name, '').slice(0, 40);
  persist();
  return member;
}

/** 停用只作废凭证：他名下的夹子与已留下的记录都还在，由机主收尾 */
export function revokeMember(ref) {
  const member = memberById(ref);
  if (!member || member.revoked) return member;
  member.revoked = true;
  persist();
  return member;
}

export function restoreMember(ref) {
  const member = memberById(ref);
  if (!member || !member.revoked) return member;
  member.revoked = false;
  persist();
  return member;
}

export async function init() {
  try {
    const raw = await fsp.readFile(config.dbFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.bundles)) db = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[store] 数据库读取失败，使用空库:', err.message);
    db = { ...EMPTY, bundles: [] };
  }
  db.bundles = (db.bundles ?? []).map(normalizeBundle);
  db.meta = { ...(db.meta ?? {}) };
  db.meta.members = (db.meta.members ?? []).map(normalizeMember);
  const freshToken = ensureOwnerToken();
  // 清理上次进程崩溃留下的未完成上传
  let pruned = 0;
  for (const bundle of db.bundles) {
    const kept = [];
    for (const item of bundle.items) {
      if (item.pending) {
        pruned += 1;
        await fsp.rm(itemFile(bundle, item), { force: true });
        await fsp.rm(tempFile(bundle, item), { force: true });
        await fsp.rm(posterFile(bundle, item), { force: true });
        itemIndex.delete(item.id);
      } else {
        kept.push(item);
      }
    }
    bundle.items = kept;
  }
  reindex();
  if (pruned || freshToken) persist();
  const archived = await backfillArchives();
  const lost = await verifyReferences();
  const freed = await sweepOrphanBlobs();
  await flush();
  await writeChain;
  return { pruned, freed, archived, missing: lost.missing };
}

/**
 * 挂载模式的素材只是路径。开机时逐个 stat 一遍，
 * 源目录没插好 / 文件被移走的，直接标成 missing 让界面说实话。
 */
async function verifyReferences() {
  let checked = 0;
  let missing = 0;
  for (const bundle of db.bundles) {
    if (bundle.mode !== 'reference') continue;
    for (const item of bundle.items) {
      if (!item.absPath) continue;
      checked += 1;
      const ok = await fsp
        .stat(item.absPath)
        .then((s) => s.isFile())
        .catch(() => false);
      if (ok === item.missing) {
        item.missing = !ok; // 界面说的和磁盘上的不一致，纠正它
        persist();
      }
      if (item.missing) missing += 1;
    }
  }
  return { checked, missing };
}

/**
 * 启动清理：没有任何素材引用、且只剩 blob 自身这一个硬链接的内容，才真正删除。
 * 崩溃或中途断电留下的孤儿字节靠这一步回收。
 */
async function sweepOrphanBlobs() {
  const referenced = new Set();
  for (const bundle of db.bundles) {
    for (const item of bundle.items) if (item.digest) referenced.add(item.digest);
  }
  let freed = 0;
  let buckets;
  try {
    buckets = await fsp.readdir(config.blobDir);
  } catch {
    return 0;
  }
  for (const bucket of buckets) {
    const dir = path.join(config.blobDir, bucket);
    const names = await fsp.readdir(dir).catch(() => []);
    for (const name of names) {
      if (referenced.has(name)) continue;
      const full = path.join(dir, name);
      try {
        if ((await fsp.stat(full)).nlink > 1) continue; // 仍有素材夹链接着它
        await fsp.rm(full, { force: true });
        freed += 1;
      } catch {
        /* 忽略读取失败 */
      }
    }
    await fsp.rmdir(dir).catch(() => {});
  }
  return freed;
}

export function bundleDir(bundleId) {
  return path.join(config.mediaDir, bundleId);
}

function itemFile(bundle, item) {
  if (item.absPath) return item.absPath; // 零拷贝：素材留在原位
  return path.join(bundleDir(bundle.id), item.id + (item.ext ? `.${item.ext}` : ''));
}

function blobFile(digest) {
  return path.join(config.blobDir, digest.slice(0, 2), digest);
}

/**
 * 复制入库的字节统一放进 blobs/<sha256>，素材夹里那份只是硬链接。
 * 同一个文件反复入库只占一份磁盘；删除时链接数归零才真正回收。
 */
async function adoptBlob(tmpPath, digest, dest) {
  const blob = blobFile(digest);
  try {
    await fsp.access(blob);
    await fsp.rm(tmpPath, { force: true });
  } catch {
    await fsp.mkdir(path.dirname(blob), { recursive: true });
    await fsp.rename(tmpPath, blob);
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rm(dest, { force: true });
  await fsp.link(blob, dest);
  return blob;
}

async function releaseBlob(digest) {
  if (!digest) return;
  const blob = blobFile(digest);
  try {
    const stat = await fsp.stat(blob);
    if (stat.nlink <= 1) await fsp.rm(blob, { force: true });
  } catch {
    /* 已被回收 */
  }
}

function posterFile(bundle, item) {
  return path.join(bundleDir(bundle.id), `${item.id}.poster.jpg`);
}

/** 上传先落到 .upload 临时文件，算出哈希后再归位到 blob 仓库 */
function tempFile(bundle, item) {
  return `${itemFile(bundle, item)}.upload`;
}

export function resolveItem(itemId) {
  const entry = itemIndex.get(itemId);
  if (!entry) return null;
  const bundle = bundleIndex.get(entry.item.bundleId);
  if (!bundle) return null;
  return {
    item: entry.item,
    bundle,
    file: itemFile(bundle, entry.item),
    temp: tempFile(bundle, entry.item),
    poster: posterFile(bundle, entry.item),
  };
}

export function getBundleByRef(ref) {
  return bundleIndex.get(ref) ?? db.bundles.find((b) => b.token === ref) ?? null;
}

export function shareActive(bundle) {
  return !bundle.expiresAt || bundle.expiresAt > Date.now();
}

function statusTally(bundle) {
  const tally = Object.fromEntries(STATUS_KEYS.map((key) => [key, 0]));
  let noted = 0;
  for (const item of bundle.items) {
    if (item.pending) continue;
    tally[item.status] = (tally[item.status] ?? 0) + 1;
    if (item.notes.length) noted += 1;
  }
  return { tally, noted };
}

export function bundleStats(bundle) {
  const live = bundle.items.filter((i) => !i.pending);
  const { tally, noted } = statusTally(bundle);
  return {
    total: live.length,
    bytes: live.reduce((sum, i) => sum + i.size, 0),
    duration: live.reduce((sum, i) => sum + (i.duration || 0), 0),
    videos: live.filter((i) => i.kind === 'video').length,
    images: live.filter((i) => i.kind === 'image').length,
    audio: live.filter((i) => i.kind === 'audio').length,
    others: live.filter((i) => i.kind !== 'video' && i.kind !== 'image' && i.kind !== 'audio').length,
    noted,
    missing: live.filter((i) => i.missing).length,
    statuses: tally,
    reviewed: live.filter((i) => i.status !== 'unset').length,
  };
}

/**
 * 素材的可读地址。
 * 访客拿到的每一条都带 `?t=<分享码>`：`<img>` / `<video>` 这类子资源请求带不上自定义头，
 * 只能靠 URL 把「我是从哪条链接进来的」传给服务端做作用域校验（见 routes.js 的 requireMediaAccess）。
 */
function scoped(url, scope) {
  if (!scope) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(scope)}`;
}

export function serializeItem(item, { scope = '' } = {}) {
  return {
    id: item.id,
    name: item.name,
    relPath: item.relPath,
    kind: item.kind,
    ext: item.ext,
    mime: item.mime,
    size: item.size,
    duration: item.duration,
    width: item.width,
    height: item.height,
    hasPoster: item.hasPoster,
    missing: Boolean(item.missing),
    status: item.status,
    statusBy: item.statusBy,
    statusAt: item.statusAt,
    notes: item.notes,
    marks: item.marks ?? [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    streamUrl: scoped(`/api/stream/${item.id}`, scope),
    posterUrl: item.hasPoster ? scoped(`/api/poster/${item.id}`, scope) : null,
  };
}

export function serializeBundle(bundle, { withItems = true, withRoot = false, withLog = false, scope = '' } = {}) {
  const payload = {
    id: bundle.id,
    token: bundle.token,
    name: bundle.name,
    description: bundle.description,
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
    expiresAt: bundle.expiresAt,
    mode: bundle.mode,
    ownerId: bundle.ownerId,
    shareable: shareActive(bundle),
    shareUrl: `/s/${bundle.token}`,
    stats: bundleStats(bundle),
  };
  if (withItems) payload.items = bundle.items.filter((i) => !i.pending).map((item) => serializeItem(item, { scope }));
  if (withLog) payload.log = bundle.log ?? [];
  // 绝对路径只回给本机的素材库接口；分享视图里不含（见 routes.js）
  if (withRoot && bundle.mode === 'reference') payload.root = bundle.root;
  return payload;
}

export function listBundles({ withRoot = false, ownerId = null } = {}) {
  const list = ownerId ? db.bundles.filter((b) => b.ownerId === ownerId) : db.bundles;
  return list.map((bundle) => serializeBundle(bundle, { withItems: false, withRoot }));
}

export function createBundle({ name, description = '', by = '机主', kind = 'owner', ownerId = 'machine' }) {
  const bundle = normalizeBundle({
    id: id(10),
    name: sanitizeSegment(name, '未命名素材夹'),
    description: String(description ?? '').slice(0, 600),
    expiresAt: config.shareTtlDays ? Date.now() + config.shareTtlDays * 86400000 : 0,
    ownerId,
    items: [],
  });
  db.bundles.unshift(bundle);
  bundleIndex.set(bundle.id, bundle);
  logAction(bundle, { by, action: 'create' });
  touch(bundle);
  archive(bundle, 'bundle:create', { by, kind, data: { snapshot: bundleSnapshot(bundle) } });
  emit('bundle:created', bundle);
  return bundle;
}

/**
 * 零拷贝挂载：素材留在原始目录，库里只记路径与元数据。
 * 删除素材夹只会解除分享，绝不动用户原始文件。
 */
export async function createReferenceBundle(rootPath, name, { by = '机主', kind = 'owner', ownerId = 'machine', prior = null } = {}) {
  const root = path.resolve(String(rootPath ?? ''));
  let stat;
  try {
    stat = await fsp.stat(root);
  } catch {
    const err = new Error('目录不存在或无权访问');
    err.status = 400;
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error('这不是一个目录');
    err.status = 400;
    throw err;
  }
  const files = await walkMedia(root, { maxFiles: config.maxFilesPerBundle });
  if (!files.length) {
    const err = new Error('目录里没有可入库的素材文件');
    err.status = 400;
    throw err;
  }
  const bundle = normalizeBundle({
    id: id(10),
    name: sanitizeSegment(name || path.basename(root), '挂载目录'),
    mode: 'reference',
    root,
    ownerId,
    expiresAt: config.shareTtlDays ? Date.now() + config.shareTtlDays * 86400000 : 0,
    items: files,
  });
  db.bundles.unshift(bundle);
  bundleIndex.set(bundle.id, bundle);
  for (const item of bundle.items) itemIndex.set(item.id, { item, bundle });
  logAction(bundle, { by, action: 'mount', count: bundle.items.length });
  touch(bundle);
  archive(bundle, 'bundle:mount', {
    by,
    kind,
    data: { snapshot: bundleSnapshot(bundle), count: bundle.items.length },
  });
  // 同一个源目录挂过又撤了，现在挂回来：记下上一次，档案视图把两段接成一条历史
  if (prior) {
    archive(bundle, 'bundle:reopen', {
      by,
      kind,
      data: { previousBundleId: prior.bundleId, previousName: prior.name, previousRecords: prior.records },
    });
  }
  emit('bundle:created', bundle);
  return bundle;
}

/** 源目录有新文件就补进来、被删掉的就移出，已有的状态与备注原样保留。 */
export async function rescanBundle(ref, { by = '机主', kind = 'owner' } = {}) {
  const bundle = getBundleByRef(ref);
  if (!bundle || bundle.mode !== 'reference') return null;
  const files = await walkMedia(bundle.root, { maxFiles: config.maxFilesPerBundle });
  const existing = new Map(bundle.items.map((i) => [i.relPath, i]));
  const kept = new Map();
  let added = 0;
  let revived = 0;
  for (const file of files) {
    const old = existing.get(file.relPath);
    if (old && old.size === file.size) {
      if (old.missing) {
        old.missing = false;
        revived += 1;
      }
      kept.set(old.id, old);
      continue;
    }
    const fresh = normalizeItem({ ...file }, bundle);
    kept.set(fresh.id, fresh);
    itemIndex.set(fresh.id, { item: fresh, bundle });
    added += 1;
  }
  let removed = 0;
  for (const item of bundle.items) {
    if (kept.has(item.id)) continue;
    itemIndex.delete(item.id);
    removed += 1;
  }
  bundle.items = [...kept.values()];
  bundle.updatedAt = Date.now();
  logAction(bundle, { by, action: 'rescan', count: added + removed + revived });
  persist();
  archive(bundle, 'bundle:rescan', { by, kind, data: { added, removed, revived, total: bundle.items.length } });
  emit('bundle:items', bundle, { action: 'rescan' });
  return { added, removed, revived, total: bundle.items.length };
}

async function walkInodes(dir, acc) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkInodes(full, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fsp.stat(full);
      const key = `${stat.dev}:${stat.ino}`;
      if (acc.seen.has(key)) continue; // 硬链接只算一次物理占用
      acc.seen.add(key);
      acc.files += 1;
      acc.bytes += stat.size;
    } catch {
      /* 忽略读取失败 */
    }
  }
  return acc;
}

/** 实际磁盘占用：按 inode 去重，所以硬链接与重复内容只算一份。 */
export async function storageReport() {
  const acc = await walkInodes(config.dataDir, { seen: new Set(), files: 0, bytes: 0 });
  return { files: acc.files, onDisk: acc.bytes };
}

export function updateBundle(ref, patch, by = '机主', kind = 'owner') {
  const bundle = getBundleByRef(ref);
  if (!bundle) return null;
  const prevName = bundle.name;
  const prevExpiry = bundle.expiresAt;
  const renamed = typeof patch.name === 'string' && patch.name.trim() && sanitizeSegment(patch.name, bundle.name) !== bundle.name;
  if (typeof patch.name === 'string') bundle.name = sanitizeSegment(patch.name, bundle.name);
  if (typeof patch.description === 'string') bundle.description = patch.description.slice(0, 600);
  if (patch.expiresAt !== undefined) bundle.expiresAt = Math.max(0, Number(patch.expiresAt) || 0);
  if (renamed) logAction(bundle, { by, action: 'rename', item: bundle.name });
  touch(bundle);
  if (renamed) archive(bundle, 'bundle:rename', { by, kind, data: { from: prevName, to: bundle.name } });
  if (bundle.expiresAt !== prevExpiry) {
    archive(bundle, 'bundle:expire', { by, kind, data: { from: prevExpiry, to: bundle.expiresAt } });
  }
  emit('bundle:updated', bundle);
  return bundle;
}

/**
 * 撤下归档：解除分享、把属于我们的字节从 data/ 里清掉，但评审记录与封面留在 data/archive/。
 * 顺序是刻意的：先从 db 移除并落盘（提交点），再搬封面，最后才动素材文件——
 * 后半段即使崩了，历史也已经安全落地。
 */
export async function unlistBundle(ref, { by = '机主', kind = 'owner' } = {}) {
  const bundle = getBundleByRef(ref);
  if (!bundle) return null;
  const items = [...bundle.items];
  const snapshot = bundleSnapshot(bundle);
  const notes = items.reduce((sum, i) => sum + i.notes.length, 0);
  const marks = items.reduce((sum, i) => sum + (i.marks ?? []).length, 0);

  db.bundles = db.bundles.filter((b) => b.id !== bundle.id);
  bundleIndex.delete(bundle.id);
  for (const item of items) itemIndex.delete(item.id);
  persist();
  emit('bundle:removed', bundle);
  await flushAndWait();

  const posters = await movePosters(bundle.id, items, (item) => posterFile(bundle, item));
  for (const item of items) {
    if (!item.absPath) {
      // 原始文件留在原地；复制入库的先解链接，再判断 blob 是否可回收
      await fsp.rm(itemFile(bundle, item), { force: true });
      await releaseBlob(item.digest);
    }
    await fsp.rm(posterFile(bundle, item), { force: true });
  }
  await fsp.rm(bundleDir(bundle.id), { recursive: true, force: true });

  archive(bundle, 'unlist', { by, kind, data: { snapshot, notes, marks, posters } });
  return { id: bundle.id, name: snapshot.name, mode: snapshot.mode, items: items.length, notes, marks, posters };
}

/** 彻底删除：连档案一起抹掉。机主显式确认才走到这里，没有挽回手段。 */
export async function purgeBundle(ref, opts = {}) {
  const result = await unlistBundle(ref, opts);
  if (!result) return null;
  await removeArchive(result.id);
  return { ...result, archived: false };
}

export function reserveItem(bundle, { name, relPath, mime, size, duration, width, height }) {
  if (bundle.items.filter((i) => !i.pending).length >= config.maxFilesPerBundle) {
    const err = new Error(`素材夹最多 ${config.maxFilesPerBundle} 个文件`);
    err.status = 409;
    throw err;
  }
  const cleanName = sanitizeSegment(name, 'untitled');
  const dupe = bundle.items.find((i) => !i.pending && i.relPath === relPath && i.size === Number(size));
  if (dupe) return { item: dupe, duplicate: true, file: itemFile(bundle, dupe), temp: tempFile(bundle, dupe), poster: posterFile(bundle, dupe) };

  const item = normalizeItem(
    {
      name: cleanName,
      relPath: sanitizeRelPath(relPath, cleanName),
      mime: mime || undefined,
      size: Number(size) || 0,
      duration: Number(duration) || 0,
      width: Number(width) || 0,
      height: Number(height) || 0,
      pending: true,
    },
    bundle,
  );
  bundle.items.push(item);
  itemIndex.set(item.id, { item, bundle });
  touch(bundle);
  return { item, duplicate: false, file: itemFile(bundle, item), temp: tempFile(bundle, item), poster: posterFile(bundle, item) };
}

export async function commitItem(item, meta = {}) {
  const entry = itemIndex.get(item.id);
  if (!entry) return null;
  const target = entry.item;
  if (meta.digest) {
    target.digest = meta.digest;
    await adoptBlob(meta.temp ?? tempFile(entry.bundle, target), meta.digest, itemFile(entry.bundle, target));
  }
  target.pending = false;
  target.size = Number(meta.size ?? target.size) || target.size;
  if (meta.duration) target.duration = Math.round(Number(meta.duration) * 100) / 100;
  if (meta.width) target.width = Number(meta.width) || target.width;
  if (meta.height) target.height = Number(meta.height) || target.height;
  target.updatedAt = Date.now();
  entry.bundle.updatedAt = target.updatedAt;
  persist();
  archive(entry.bundle, 'item:add', {
    by: meta.by ?? '机主',
    kind: meta.kind ?? 'owner',
    item: target,
    data: { mime: target.mime },
  });
  emit('bundle:items', entry.bundle, { itemId: target.id, action: 'add' });
  return target;
}

export async function discardItem(bundle, item) {
  const entry = itemIndex.get(item.id);
  if (entry?.item.pending) {
    bundle.items = bundle.items.filter((i) => i.id !== item.id);
    itemIndex.delete(item.id);
    await fsp.rm(itemFile(bundle, item), { force: true });
    await fsp.rm(tempFile(bundle, item), { force: true });
    persist();
  }
}

export function updateItem(itemId, patch = {}) {
  const found = resolveItem(itemId);
  if (!found) return null;
  const { item, bundle } = found;
  const kind = patch.kind ?? 'owner';
  let entry = null;
  if (patch.status !== undefined) {
    if (!STATUS_KEYS.includes(patch.status)) {
      const err = new Error('未知状态');
      err.status = 400;
      throw err;
    }
    const prev = item.status;
    item.status = patch.status;
    item.statusBy = typeof patch.by === 'string' ? patch.by.slice(0, 40) : '';
    item.statusAt = item.status === 'unset' ? 0 : Date.now();
    entry = { by: item.statusBy, action: 'status', item: item.name, status: patch.status };
    archive(bundle, 'status', { by: item.statusBy, kind, item, data: { status: patch.status, from: prev } });
  }
  if (typeof patch.name === 'string' && patch.name.trim()) {
    const from = item.name;
    item.name = sanitizeSegment(patch.name, item.name);
    item.relPath = sanitizeRelPath(patch.relPath ?? item.name, item.name);
    entry = { by: typeof patch.by === 'string' ? patch.by : '', action: 'rename', item: item.name };
    archive(bundle, 'item:rename', { by: entry.by, kind, item, data: { from, to: item.name } });
  }
  if (patch.duration) item.duration = Math.round(Number(patch.duration) * 100) / 100;
  if (patch.width) item.width = Number(patch.width) || item.width;
  if (patch.height) item.height = Number(patch.height) || item.height;
  item.updatedAt = Date.now();
  bundle.updatedAt = item.updatedAt;
  if (entry) logAction(bundle, entry);
  persist();
  emit('bundle:items', bundle, { itemId, action: 'update' });
  return item;
}

export function setStatuses(itemIds, status, by = '', kind = 'guest') {
  if (!STATUS_KEYS.includes(status)) {
    const err = new Error('未知状态');
    err.status = 400;
    throw err;
  }
  const stamp = status === 'unset' ? 0 : Date.now();
  const signer = typeof by === 'string' ? by.slice(0, 40) : '';
  const changed = [];
  const touched = new Map();
  const lastItem = new Map();
  // 一次批量勾选出多条记录，用同一个 batch 串起来，看档案时知道哪些是同一只手一次点的
  const batch = id(6);
  for (const itemId of itemIds) {
    const found = resolveItem(itemId);
    if (!found) continue;
    const prev = found.item.status;
    found.item.status = status;
    found.item.statusBy = signer;
    found.item.statusAt = stamp;
    found.item.updatedAt = Date.now();
    archive(found.bundle, 'status', { by: signer, kind, item: found.item, data: { status, from: prev, batch } });
    changed.push(found.item.id);
    lastItem.set(found.bundle, found.item.name);
    touched.set(found.bundle, (touched.get(found.bundle) ?? 0) + 1);
  }
  for (const [bundle, count] of touched) {
    bundle.updatedAt = Date.now();
    // 单条改动记文件名，批量只记条数：「谁把这条改成淘汰的」要能一眼看出来
    logAction(bundle, { by: signer, action: 'status', status, count, item: count === 1 ? lastItem.get(bundle) : '' });
    emit('bundle:items', bundle, { action: 'status', actor: signer, count, status });
  }
  if (changed.length) persist();
  return changed;
}

export function setPoster(itemId, bytes) {
  const found = resolveItem(itemId);
  if (!found) return null;
  found.item.hasPoster = bytes > 0;
  found.item.updatedAt = Date.now();
  found.bundle.updatedAt = found.item.updatedAt;
  persist();
  emit('bundle:items', found.bundle, { itemId, action: 'poster' });
  return found.item;
}

/** 供片时读不到源文件：记一条 missing，让界面说实话（重新扫描或文件回来才清掉）。 */
export function markMissing(itemId) {
  const found = resolveItem(itemId);
  if (!found || found.item.missing) return null;
  found.item.missing = true;
  found.item.updatedAt = Date.now();
  found.bundle.updatedAt = found.item.updatedAt;
  persist();
  archive(found.bundle, 'item:missing', { by: '系统', kind: 'system', item: found.item });
  emit('bundle:items', found.bundle, { itemId, action: 'missing' });
  return found.item;
}

export function addNote(itemId, { text, author, t, kind = 'guest' }) {
  const found = resolveItem(itemId);
  if (!found) return null;
  const clean = String(text ?? '').trim().slice(0, 4000);
  if (!clean) {
    const err = new Error('备注不能为空');
    err.status = 400;
    throw err;
  }
  const note = {
    id: id(8),
    text: clean,
    author: sanitizeSegment(author, '匿名').slice(0, 40) || '匿名',
    createdAt: Date.now(),
    t: clampSeconds(t),
  };
  found.item.notes.push(note);
  found.item.updatedAt = note.createdAt;
  found.bundle.updatedAt = note.createdAt;
  logAction(found.bundle, { by: note.author, action: 'note', item: found.item.name });
  persist();
  archive(found.bundle, 'note', {
    by: note.author,
    kind,
    item: found.item,
    data: { text: note.text, t: note.t, noteId: note.id },
  });
  emit('bundle:items', found.bundle, { itemId, action: 'note', actor: note.author });
  return note;
}

export function removeNote(itemId, noteId, by, strict = false, kind = 'guest') {
  const found = resolveItem(itemId);
  if (!found) return null;
  const note = found.item.notes.find((n) => n.id === noteId);
  if (!note) return null;
  assertMine(note.author, by, strict, '删除');
  found.item.notes = found.item.notes.filter((n) => n.id !== noteId);
  found.item.updatedAt = Date.now();
  found.bundle.updatedAt = found.item.updatedAt;
  logAction(found.bundle, { by, action: 'note-remove', item: found.item.name });
  persist();
  // 删掉的备注原文必须留在档案里：谁撤了谁的意见，事后是要对得上的
  archive(found.bundle, 'note:remove', {
    by,
    kind,
    item: found.item,
    data: { text: note.text, t: note.t, noteId, noteBy: note.author },
  });
  emit('bundle:items', found.bundle, { itemId, action: 'note-remove' });
  return note;
}

/** 打点：时间轴上的独立标记，只有时间点没有正文 */
const markError = (status, message) => Object.assign(new Error(message), { status });

function touchMark(found) {
  found.item.updatedAt = Date.now();
  found.bundle.updatedAt = found.item.updatedAt;
}

export function addMark(itemId, { t, author, kind = 'guest' }) {
  const found = resolveItem(itemId);
  if (!found) return null;
  if (found.item.kind !== 'video' && found.item.kind !== 'audio') {
    throw markError(400, '只有视频或音频能打时间点标记');
  }
  const seconds = clampSeconds(t, 3);
  if (seconds === null) throw markError(400, '时间点无效');
  const mark = {
    id: id(8),
    t: seconds,
    author: sanitizeSegment(author, '匿名').slice(0, 40) || '匿名',
    createdAt: Date.now(),
  };
  found.item.marks = normalizeMarks([...(found.item.marks ?? []), mark]);
  touchMark(found);
  logAction(found.bundle, { by: mark.author, action: 'mark', item: found.item.name });
  persist();
  archive(found.bundle, 'mark', { by: mark.author, kind, item: found.item, data: { t: mark.t, markId: mark.id } });
  emit('bundle:items', found.bundle, { itemId, action: 'mark', actor: mark.author });
  return mark;
}

export function moveMark(itemId, markId, { t, by }, strict = false, kind = 'guest') {
  const found = resolveItem(itemId);
  if (!found) return null;
  const mark = (found.item.marks ?? []).find((m) => m.id === markId);
  if (!mark) return null;
  assertMine(mark.author, by, strict, '移动');
  const seconds = clampSeconds(t, 3);
  if (seconds === null) throw markError(400, '时间点无效');
  const from = mark.t;
  mark.t = seconds;
  found.item.marks.sort((a, b) => a.t - b.t);
  touchMark(found);
  logAction(found.bundle, { by: by ?? mark.author, action: 'mark-move', item: found.item.name });
  persist();
  archive(found.bundle, 'mark:move', {
    by: by ?? mark.author,
    kind,
    item: found.item,
    data: { from, to: seconds, markId },
  });
  emit('bundle:items', found.bundle, { itemId, action: 'mark-move', actor: by ?? mark.author });
  return mark;
}

export function removeMark(itemId, markId, by, strict = false, kind = 'guest') {
  const found = resolveItem(itemId);
  if (!found) return null;
  const mark = (found.item.marks ?? []).find((m) => m.id === markId);
  if (!mark) return null;
  assertMine(mark.author, by, strict, '删除');
  found.item.marks = found.item.marks.filter((m) => m.id !== markId);
  touchMark(found);
  logAction(found.bundle, { by: by ?? mark.author, action: 'mark-remove', item: found.item.name });
  persist();
  archive(found.bundle, 'mark:remove', {
    by: by ?? mark.author,
    kind,
    item: found.item,
    data: { t: mark.t, markId, markBy: mark.author },
  });
  emit('bundle:items', found.bundle, { itemId, action: 'mark-remove' });
  return mark;
}

export async function removeItem(itemId, by = '', kind = 'owner') {
  const found = resolveItem(itemId);
  if (!found) return false;
  const { bundle, item } = found;
  bundle.items = bundle.items.filter((i) => i.id !== itemId);
  itemIndex.delete(itemId);
  logAction(bundle, { by, action: 'remove', item: item.name });
  archive(bundle, 'item:remove', {
    by,
    kind,
    item,
    data: { notes: item.notes.length, marks: (item.marks ?? []).length, status: item.status },
  });
  if (!item.absPath) {
    await fsp.rm(found.file, { force: true });
    await releaseBlob(item.digest);
  }
  await fsp.rm(found.poster, { force: true });
  bundle.updatedAt = Date.now();
  persist();
  emit('bundle:items', bundle, { itemId, action: 'remove' });
  return true;
}

/** 找出与刚挂载目录内容基本重合的「复制入库」素材夹，便于回收磁盘空间。 */
export function findCopyDuplicates(referenceBundle) {
  const signature = new Set(referenceBundle.items.map((i) => `${i.name}::${i.size}`));
  const out = [];
  for (const bundle of db.bundles) {
    if (bundle.mode !== 'copy' || bundle.id === referenceBundle.id) continue;
    const live = bundle.items.filter((i) => !i.pending);
    if (!live.length) continue;
    const hit = live.filter((i) => signature.has(`${i.name}::${i.size}`)).length;
    if (hit / live.length < 0.9) continue;
    out.push({
      id: bundle.id,
      name: bundle.name,
      items: live.length,
      bytes: live.reduce((sum, i) => sum + i.size, 0),
    });
  }
  return out;
}

export function totals({ ownerId = null } = {}) {
  const list = ownerId ? db.bundles.filter((b) => b.ownerId === ownerId) : db.bundles;
  const items = list.reduce((sum, b) => sum + b.items.filter((i) => !i.pending).length, 0);
  const bytes = list.reduce((sum, b) => sum + b.items.reduce((s, i) => s + i.size, 0), 0);
  const mountedBytes = list
    .filter((b) => b.mode === 'reference')
    .reduce((sum, b) => sum + b.items.reduce((s, i) => s + i.size, 0), 0);
  const missing = list.reduce((sum, b) => sum + b.items.filter((i) => i.missing).length, 0);
  return { bundles: list.length, items, bytes, mountedBytes, missing, dataDir: config.dataDir };
}
