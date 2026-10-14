import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  appName: 'LanReel 局域网素材放映厅',
  version: '1.10.4',
  root,
  publicDir: path.join(root, 'public'),
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data'),
  host: process.env.HOST || '0.0.0.0',
  port: positiveInt(process.env.PORT, 2026),
  maxPortTries: 12,
  // 单个文件上限（MB），默认 4GB
  maxUploadBytes: positiveInt(process.env.MAX_UPLOAD_MB, 4096) * 1024 * 1024,
  maxPosterBytes: 8 * 1024 * 1024,
  maxFilesPerBundle: positiveInt(process.env.MAX_FILES, 3000),
  // 分享链接有效期（天），0 表示永久
  shareTtlDays: positiveInt(process.env.SHARE_TTL_DAYS, 0),
  // 素材库（/ 与 /api/bundles*）默认只允许运行 LanReel 的这台电脑访问；
  // 设成 1 则整个局域网都能管理（任何人都能往这台机器上传/删除）。
  libraryFromLan: ['1', 'true', 'yes'].includes(String(process.env.LIBRARY_FROM_LAN ?? '').toLowerCase()),
  // 机主口令：不设则首启随机生成并写进 data/db.json，用于在其他设备上管理素材库
  ownerToken: String(process.env.OWNER_TOKEN ?? '').trim(),
  ownerCookie: 'lanreel_owner',
};

config.dbFile = path.join(config.dataDir, 'db.json');
config.mediaDir = path.join(config.dataDir, 'media');
config.blobDir = path.join(config.dataDir, 'blobs');

fs.mkdirSync(config.mediaDir, { recursive: true });
fs.mkdirSync(config.blobDir, { recursive: true });
