import crypto from 'node:crypto';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function id(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const EXT_KIND = {
  video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'ts', 'ogv', 'ogx'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'heic', 'heif', 'svg', 'tif', 'tiff'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'amr'],
  doc: ['pdf', 'txt', 'md', 'srt', 'vtt', 'ass', 'lrc', 'csv', 'json', 'xml'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz'],
};

const MIME = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', ts: 'video/mp2t',
  ogv: 'video/ogg', ogx: 'application/ogg',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic',
  heif: 'image/heif', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
  aiff: 'audio/aiff', aif: 'audio/aiff', amr: 'audio/amr',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  srt: 'application/x-subrip', vtt: 'text/vtt; charset=utf-8', ass: 'text/plain; charset=utf-8',
  lrc: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
};

export const ALLOWED_EXT = new Set(Object.values(EXT_KIND).flat());

export function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function mimeOf(nameOrExt) {
  const ext = nameOrExt.includes('.') ? extOf(nameOrExt) : nameOrExt;
  return MIME[ext] ?? 'application/octet-stream';
}

export function kindOf(name) {
  const ext = extOf(name);
  for (const [kind, list] of Object.entries(EXT_KIND)) {
    if (list.includes(ext)) return kind;
  }
  return 'other';
}

/** Keep a single path segment safe for the filesystem. */
export function sanitizeSegment(raw, fallback = 'untitled') {
  const base = path.basename(String(raw ?? '').replace(/[/\\]/g, ''))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return base || fallback;
}

/** "a/b/c.mp4" -> safe relative path, dot segments removed. */
export function sanitizeRelPath(raw, fallbackName) {
  const parts = String(raw ?? '')
    .split(/[\\/]+/)
    .map((p) => sanitizeSegment(p, ''))
    .filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) parts.push(sanitizeSegment(fallbackName, 'file'));
  return parts.join('/');
}

export async function readJson(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('请求体过大');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('JSON 解析失败');
    err.status = 400;
    throw err;
  }
}

/** 流式落盘并顺便算内容哈希；超出预算直接中断。 */
export function streamToDisk(req, dest, maxBytes) {
  return fsp.mkdir(path.dirname(dest), { recursive: true }).then(async () => {
    await fsp.rm(dest, { force: true });
    const handle = await fsp.open(dest, 'w');
    const hash = crypto.createHash('sha256');
    let written = 0;
    try {
      for await (const chunk of req) {
        written += chunk.length;
        if (written > maxBytes) {
          const err = new Error(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 上限`);
          err.status = 413;
          throw err;
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
      if (written === 0) await fsp.rm(dest, { force: true });
    }
    return { bytes: written, digest: hash.digest('hex') };
  });
}

/**
 * 请求是不是从这台机器自己发出的？
 * 注意：本机浏览器打开 http://<局域网IP>:2026 时，来源地址是那张网卡的 IP，
 * 不是 127.0.0.1，所以只比 loopback 会把机主本人误判成外人。
 */
export function isLocalMachine(address) {
  if (!address) return false;
  const ip = address.replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.')) return true;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.address === ip) return true;
    }
  }
  return false;
}

/** 定长比较，避免用响应时间一位位试出口令 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** 从 Cookie 头里取一个值（Node 不解析 Cookie，这里只够用） */
export function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return '';
}

export const SKIP_DIR = new Set(['.git', 'node_modules', '.Trash', '__MACOSX', '.spotlight-V100', '.fseventsd']);

/** 递归扫描一个本机目录，返回可入库的文件清单（不复制任何字节）。 */
export async function walkMedia(root, { maxFiles = 3000, maxDepth = 8 } = {}) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < maxFiles) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限或已消失，跳过
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name.startsWith('.') || SKIP_DIR.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extOf(entry.name);
      if (!ALLOWED_EXT.has(ext)) continue;
      try {
        const stat = await fsp.stat(full);
        out.push({
          absPath: full,
          relPath: path.relative(root, full).split(path.sep).join('/'),
          name: entry.name,
          size: stat.size,
          mtimeMs: Math.round(stat.mtimeMs),
        });
      } catch {
        /* 读取失败的条目跳过 */
      }
    }
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-CN', { numeric: true }));
}
