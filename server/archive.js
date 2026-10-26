import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * 评审档案：一条只追加的时间线。
 * 素材夹可以撤下、素材文件可以消失，但「谁在什么时候对哪条说了什么」必须留在磁盘上，
 * 所以记录不放进 db.json（随夹子删除），也不受操作流水 500 条上限的约束。
 * 每个夹子一份 data/archive/<夹ID>/records.jsonl，封面另存同目录的 posters/。
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 追加链：同一夹子的写入串行，避免并发时行与行交错 */
const chains = new Map();
/** 按文件大小+修改时间失效的读缓存 */
const cache = new Map();

function dirOf(bundleId) {
  const id = String(bundleId ?? '');
  if (!SAFE_ID.test(id)) throw Object.assign(new Error('非法素材夹 ID'), { status: 400 });
  return path.join(config.archiveDir, id);
}

const fileOf = (bundleId) => path.join(dirOf(bundleId), 'records.jsonl');
const posterFile = (bundleId, itemId) => {
  const item = String(itemId ?? '');
  if (!SAFE_ID.test(item)) throw Object.assign(new Error('非法素材 ID'), { status: 400 });
  return path.join(dirOf(bundleId), 'posters', `${item}.jpg`);
};

/**
 * 署名。kind 由服务端盖章，不接受浏览器自报：
 * owner/member 是验证过的身份，guest 是从分享链接进来、名字自己填的，legacy 是升级前旧库里的记录。
 */
export function actor(name, kind = 'guest') {
  return {
    name: String(name ?? '').slice(0, 40) || '匿名',
    kind,
    verified: kind === 'owner' || kind === 'member',
  };
}

/** 素材快照：媒体删掉之后，记录要还能自解释 */
export function snapshot(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    relPath: item.relPath,
    kind: item.kind,
    ext: item.ext,
    size: item.size,
    duration: item.duration,
    mtimeMs: item.mtimeMs ?? 0,
    digest: item.digest || '',
  };
}

export function bundleSnapshot(bundle) {
  return {
    id: bundle.id,
    name: bundle.name,
    mode: bundle.mode,
    root: bundle.root || '',
    ownerId: bundle.ownerId || 'machine',
    createdAt: bundle.createdAt,
    itemCount: bundle.items.filter((i) => !i.pending).length,
  };
}

/** 追加一条记录。永不抛错：留痕失败不能拖累评审本身，但要在日志里看见。 */
export function append(bundleId, rec) {
  let line;
  try {
    line = `${JSON.stringify({ at: Number(rec?.at) || Date.now(), ...rec })}\n`;
  } catch (err) {
    console.error('[archive] 记录序列化失败:', err.message);
    return Promise.resolve();
  }
  const prev = chains.get(bundleId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const dir = dirOf(bundleId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.appendFile(fileOf(bundleId), line, 'utf8');
      cache.delete(bundleId);
    })
    .catch((err) => console.error('[archive] 记录写入失败:', err.message));
  chains.set(bundleId, next);
  return next;
}

async function readAll(bundleId) {
  // 写入是按夹子排队的：刚打完一条备注就刷档案，不等一下就读不到最新那条
  const pending = chains.get(bundleId);
  if (pending) await pending.catch(() => {});
  const file = fileOf(bundleId);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return [];
  }
  const sig = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(bundleId);
  if (hit?.sig === sig) return hit.recs;
  const text = await fsp.readFile(file, 'utf8');
  const recs = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const rec = JSON.parse(raw);
      if (rec && typeof rec === 'object' && typeof rec.op === 'string') recs.push(rec);
    } catch {
      /* 断电或崩溃留下的半截尾行，跳过 */
    }
  }
  recs.sort((a, b) => a.at - b.at);
  cache.set(bundleId, { sig, recs });
  return recs;
}

export async function read(bundleId, { who = '', op = '', since = 0, until = 0, q = '' } = {}) {
  const recs = await readAll(bundleId);
  const needle = String(q ?? '').trim().toLowerCase();
  return recs.filter((rec) => {
    if (who && rec.actor?.name !== who) return false;
    if (op && rec.op !== op) return false;
    if (since && rec.at < since) return false;
    if (until && rec.at > until) return false;
    if (needle) {
      const hay = [rec.item?.name, rec.item?.relPath, rec.data?.text, rec.data?.to, rec.actor?.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export async function hasRecords(bundleId) {
  return (await readAll(bundleId)).length > 0;
}

/** 一个夹子的档案概况：首末时间、记录数、参与过的人、撤下时间、封面张数 */
async function summary(bundleId) {
  const recs = await readAll(bundleId);
  if (!recs.length) return null;
  const first = recs.find((r) => r.data?.snapshot)?.data.snapshot ?? null;
  const last = [...recs].reverse().find((r) => r.data?.snapshot)?.data.snapshot ?? first;
  const unlist = recs.filter((r) => r.op === 'unlist').pop() ?? null;
  const people = new Map();
  const counts = {};
  let posterCount = 0;
  for (const rec of recs) {
    counts[rec.op] = (counts[rec.op] ?? 0) + 1;
    const name = rec.actor?.name;
    if (name && !rec.data?.snapshot) {
      const seen = people.get(name) ?? { name, kind: rec.actor.kind, verified: rec.actor.verified, records: 0, lastAt: 0 };
      seen.records += 1;
      if (rec.at > seen.lastAt) {
        seen.lastAt = rec.at;
        seen.kind = rec.actor.kind;
        seen.verified = rec.actor.verified;
      }
      people.set(name, seen);
    }
    if (rec.op === 'unlist') posterCount = rec.data?.posters ?? posterCount;
  }
  let postersOnDisk = 0;
  try {
    postersOnDisk = (await fsp.readdir(path.join(dirOf(bundleId), 'posters'))).length;
  } catch {
    /* 还没有封面 */
  }
  return {
    bundleId,
    name: last?.name ?? '（无名素材夹）',
    mode: first?.mode ?? 'copy',
    root: first?.root ?? '',
    ownerId: first?.ownerId ?? 'machine',
    createdAt: first?.createdAt ?? recs[0].at,
    firstAt: recs[0].at,
    lastAt: unlist?.at ?? recs[recs.length - 1].at,
    records: recs.length,
    counts,
    people: [...people.values()].sort((a, b) => b.lastAt - a.lastAt),
    unlistedAt: unlist?.at ?? 0,
    legacy: recs.some((r) => r.data?.legacy),
    backfilled: Boolean(recs[0]?.data?.snapshot?.backfilled) || recs.some((r) => r.data?.legacy),
    posters: postersOnDisk,
  };
}

/** 全部档案，按最近活动排序 */
export async function summaries() {
  let entries;
  try {
    entries = await fsp.readdir(config.archiveDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    const item = await summary(entry.name).catch(() => null);
    if (item) out.push(item);
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * 撤下归档：把浏览器抓的封面从 data/media/<夹>/ 搬进档案。
 * 挂载模式的素材字节从来不属于我们，封面是唯一留下的画面，不搬就随夹子一起没了。
 */
export async function movePosters(bundleId, items, posterPathOf) {
  let moved = 0;
  for (const item of items) {
    if (!item.hasPoster) continue;
    const from = posterPathOf(item);
    const to = posterFile(bundleId, item.id);
    try {
      await fsp.stat(from);
    } catch {
      continue;
    }
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rm(to, { force: true });
      await fsp.rename(from, to);
      moved += 1;
    } catch {
      try {
        await fsp.copyFile(from, to);
        moved += 1;
      } catch {
        /* 跨卷或权限问题：记录还在，封面丢了 */
      }
    }
  }
  return moved;
}

export function posterPath(bundleId, itemId) {
  return posterFile(bundleId, itemId);
}

/** 彻底删除（机主显式确认）：连档案一起抹掉 */
export async function removeArchive(bundleId) {
  chains.delete(bundleId);
  cache.delete(bundleId);
  await fsp.rm(dirOf(bundleId), { recursive: true, force: true });
}

/** 同一个源目录是否挂过一次：撤下后再挂回来，历史要能接上 */
export async function findPriorByRoot(root, exceptBundleId = '') {
  if (!root) return null;
  for (const item of await summaries()) {
    if (item.bundleId === exceptBundleId) continue;
    if (item.mode !== 'reference' || !item.root) continue;
    if (item.root !== root) continue;
    if (!item.unlistedAt) continue; // 还在映的不算「上一次」
    return item;
  }
  return null;
}

/** 退出前把排队中的记录写完，免得最后几条备注丢了 */
export async function flush() {
  await Promise.all([...chains.values()]);
}

/** 档案概况；传 ownerId 就只数这个人名下的，免得成员从数字里看出全站规模 */
export async function footprint({ ownerId = null } = {}) {
  const all = await summaries();
  const list = ownerId ? all.filter((b) => b.ownerId === ownerId) : all;
  return {
    bundles: list.length,
    unlisted: list.filter((b) => b.unlistedAt).length,
    records: list.reduce((sum, b) => sum + b.records, 0),
    posters: list.reduce((sum, b) => sum + b.posters, 0),
  };
}
