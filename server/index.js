import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { applySecurityHeaders, sendHtml, sendJson, sendStatic } from './media.js';
import { flush as flushArchive, footprint as archiveFootprint } from './archive.js';
import { broadcast, closeAll } from './bus.js';
import { handleApi, isOwner, lanAddresses, memberOf, setServerPort } from './routes.js';
import { events, flushAndWait, init as initStore, ownerToken, storageReport, totals } from './store.js';

const verbose = Boolean(process.env.LOG);

async function page(file) {
  return fsp.readFile(path.join(config.publicDir, file), 'utf8');
}

const HEAD = `<title>%TITLE% · LanReel</title>
<link rel="stylesheet" href="/css/tokens.css" /><link rel="stylesheet" href="/css/error.css" />`;

// CSP 是 style-src 'self'，样式必须走文件：以前内联 <style> 被拦，这两个页面一直是裸文本
const ERROR_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${HEAD.replace('%TITLE%', '这里没有内容')}
<main class="stop"><b>%STATUS%</b><p>这里没有内容 —— <a href="/">回到素材库</a></p></main></html>`;

const GATE_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${HEAD.replace('%TITLE%', '这里需要身份')}
<main class="stop stop--wide">
  <h1>素材库只在这台电脑上管理</h1>
  <p>挂载、上传、改名、删除素材夹都发生在运行 LanReel 的这台机器上。同事看片请用 <code>/s/XXXXXXXX</code> 分享链接，不需要口令。</p>
  <p>想自己建项目、传素材？让机主给你一条 <code>/j/XXXXXXXX</code> 邀请链接，点开填个名字就行 —— 你只管自己名下的素材夹，看不见别人的。</p>
  <form class="stop__form" data-ref="owner-form" autocomplete="off">
    <p class="stop__lead">你是机主、想用手上的另一台设备管理？输入机主口令（启动 LanReel 的那个终端里就印着）。</p>
    <div class="stop__row">
      <input class="stop__input" data-ref="owner-token" type="password" placeholder="机主口令" aria-label="机主口令" spellcheck="false" />
      <button class="stop__btn" type="submit">解锁</button>
    </div>
    <p class="stop__note" data-ref="owner-note" role="status"></p>
  </form>
  <p class="stop__alt">口令想固定下来：启动前设 <code>OWNER_TOKEN=你的口令</code>。也可以设 <code>LIBRARY_FROM_LAN=1</code> 让全网都能管理——那等于把写入和删除权限交给同网段每一台设备，不建议。</p>
</main>
<script src="/js/gate.js" defer></script></html>`;

function notFound(res) {
  sendHtml(res, ERROR_PAGE.replace(/%STATUS%/g, '404'), 404);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  res.on('finish', () => {
    if (verbose) console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });
  res.on('error', (err) => {
    console.error('[http] 响应异常:', err.message);
  });

  handle(req, res, url).catch((err) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error('[http] 未捕获错误:', err);
    if (res.headersSent) return res.destroy();
    const isApi = url.pathname.startsWith('/api/');
    if (isApi) {
      sendJson(res, status, { error: err?.message ?? '服务器内部错误' });
      return;
    }
    // 错误详情只进日志，不拼进 HTML
    sendHtml(res, ERROR_PAGE.replace('%STATUS%', String(status)), status);
  });
});

async function handle(req, res, url) {
  applySecurityHeaders(res);

  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, url);
    if (!handled) sendJson(res, 404, { error: '接口不存在' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: '方法不允许' });
    return;
  }

  // 素材库与档案：机主（本机或口令）和拿着邀请码换过 Cookie 的成员走同一道门，
  // 区别在接口层 —— 成员只看得到自己名下的夹子（见 routes.js 的 requireBundleAccess）
  const library = isOwner(req) || Boolean(memberOf(req));

  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!library) {
      sendHtml(res, GATE_PAGE);
      return;
    }
    sendHtml(res, await page('index.html'));
    return;
  }

  // 评审档案里含备注原文与素材清单，所以和素材库同一道门
  if (url.pathname === '/archive' || url.pathname === '/archive.html') {
    if (!library) {
      sendHtml(res, GATE_PAGE);
      return;
    }
    sendHtml(res, await page('archive.html'));
    return;
  }

  // 邀请链接的落地页：码就是凭证，对方在这里填一次名字换成员 Cookie
  const invite = /^\/j\/([A-Za-z0-9_-]{6,64})\/?$/.exec(url.pathname);
  if (invite) {
    sendHtml(res, await page('join.html'));
    return;
  }

  const share = /^\/s\/([A-Za-z0-9_-]{6,64})\/?$/.exec(url.pathname);
  if (share) {
    sendHtml(res, await page('share.html'));
    return;
  }

  if (url.pathname === '/favicon.svg') {
    await sendStatic(req, res, config.publicDir, 'favicon.svg', { immutable: true });
    return;
  }

  if (/^\/(css|js|vendor)\/.+\.(css|js|map)$/.test(url.pathname)) {
    await sendStatic(req, res, config.publicDir, url.pathname, { immutable: false });
    return;
  }

  notFound(res);
}

async function banner(port) {
  const lan = lanAddresses();
  const { bundles, items, bytes, mountedBytes, missing } = totals();
  const { onDisk } = await storageReport();
  const archive = await archiveFootprint();
  const mb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
  const lines = [
    '',
    `  ${config.appName}  v${config.version}`,
    '',
    `  本机         http://localhost:${port}`,
    ...lan.map(({ address, name }) => `  局域网       http://${address}:${port}   (${name})`),
    '',
    `  素材夹 ${bundles} 个 · 素材 ${items} 个 · 素材合计 ${mb(bytes)}`,
    `  项目目录实占 ${mb(onDisk)}${mountedBytes ? `（挂载素材 ${mb(mountedBytes)} 留在原处，未复制）` : ''}`,
    `  数据目录     ${config.dataDir}`,
    `  评审档案     ${archive.records} 条记录 · ${archive.bundles} 个夹子${archive.unlisted ? `（${archive.unlisted} 个已撤下）` : ''}${archive.posters ? ` · ${archive.posters} 张封面` : ''} — 在 ${config.archiveDir}`,
    ...(missing ? [`  警告：${missing} 个素材的源文件读不到，请检查源目录/外接盘是否在原位，然后点「重新扫描」。`] : []),
    `  素材库       ${config.libraryFromLan ? '已放开：LIBRARY_FROM_LAN=1，同网任何设备都能写入' : '仅本机管理；同事用 /s/ 链接即可看'}`,
    `  机主口令   ${ownerToken() || '未生成'}${config.ownerToken ? '（来自 OWNER_TOKEN）' : ''} — 在其他设备上管理素材库时输给你自己`,
    lan.length ? '  把上面的局域网地址 + 分享链接发给同事，同网即可秒开。' : '  警告：未发现局域网 IPv4 地址，分享链接可能仅限本机。',
    '',
  ];
  console.log(lines.join('\n'));
}

function listen(attempt = 0) {
  const port = config.port + attempt;
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < config.maxPortTries) {
      console.warn(`  端口 ${port} 被占用，改用 ${port + 1} …`);
      listen(attempt + 1);
      return;
    }
    console.error('[server] 启动失败:', err.message);
    process.exit(1);
  });
  server.listen(port, config.host, () => {
    setServerPort(port);
    banner(port).catch((err) => console.error('[server] 启动信息生成失败:', err.message));
  });
}

events.on('change', (payload) => broadcast(payload));

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n  收到 ${signal}，正在落盘 …`);
  await Promise.all([flushAndWait(), flushArchive()]);
  closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[fatal] 未处理的 Promise 拒绝:', err));

const boot = await initStore();
if (boot.pruned) console.log(`  清理了 ${boot.pruned} 个未完成的上传`);
if (boot.freed) console.log(`  回收了 ${boot.freed} 个无人引用的内容块`);
if (boot.archived?.bundles) console.log(`  回灌了 ${boot.archived.bundles} 个素材夹的 ${boot.archived.records} 条评审记录进档案`);
setServerPort(config.port);
listen();
