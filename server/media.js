import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      "script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self' data:; " +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
  );
}

export function parseRange(header, size) {
  if (!header) return { state: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return { state: 'full' };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { state: 'full' };
  let start;
  let end;
  if (!rawStart) {
    const suffix = Math.min(Number(rawEnd), size);
    start = size - suffix;
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  }
  if (start > end || start >= size || start < 0) return { state: 'unsatisfiable', start, end };
  return { state: 'partial', start, end };
}

/** Serve a file with HTTP Range support — the backbone of instant seeking. */
export async function sendFile(req, res, filePath, { contentType, disposition = 'inline', filename, cache = 'no-cache', onMissing } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    await onMissing?.();
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: '文件不存在' }));
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '不是常规文件' }));
    return;
  }

  const type = contentType || 'application/octet-stream';
  const range = parseRange(req.headers.range, stat.size);
  const lastModified = new Date(stat.mtimeMs).toUTCString();
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    'Last-Modified': lastModified,
    'X-Content-Type-Options': 'nosniff',
  };

  // no-cache 的资源要能真正完成协商，否则浏览器只能整份重取
  if (!req.headers.range && req.headers['if-modified-since'] === lastModified) {
    res.writeHead(304, { 'Cache-Control': cache, 'Last-Modified': lastModified });
    res.end();
    return;
  }

  if (disposition) {
    const encoded = filename ? `; filename*=UTF-8''${encodeURIComponent(filename)}` : '';
    headers['Content-Disposition'] = `${disposition}${encoded}`;
  }

  if (range.state === 'unsatisfiable') {
    headers['Content-Range'] = `bytes */${stat.size}`;
    res.writeHead(416, headers);
    res.end();
    return;
  }

  const isHead = req.method === 'HEAD';

  if (range.state === 'partial') {
    const length = range.end - range.start + 1;
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers['Content-Length'] = String(length);
    res.writeHead(206, headers);
    if (isHead) return res.end();
    const stream = createReadStream(filePath, { start: range.start, end: range.end });
    stream.pipe(res);
    res.on('close', () => stream.destroy());
    return;
  }

  headers['Content-Length'] = String(stat.size);
  res.writeHead(200, headers);
  if (isHead) return res.end();
  const stream = createReadStream(filePath);
  stream.pipe(res);
  res.on('close', () => stream.destroy());
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function sendHtml(res, html, status = 200) {
  const body = Buffer.from(html);
  applySecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Serve a request path from a whitelisted static directory. */
export async function sendStatic(req, res, publicDir, relPath, { immutable = false } = {}) {
  const decoded = decodeURIComponent(relPath.replace(/^\/+/, ''));
  const target = path.resolve(publicDir, decoded === '' ? 'index.html' : decoded);
  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
    return sendJson(res, 404, { error: 'Not found' });
  }
  const ext = path.extname(target).toLowerCase();
  const type = STATIC_TYPES[ext] ?? 'application/octet-stream';
  await sendFile(req, res, target, {
    contentType: type,
    disposition: null,
    cache: immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
}
