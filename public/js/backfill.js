// ── 给挂载进来的素材补封面/时长/尺寸：浏览器直接从同源流地址读 ─────────────
import { api } from './api.js';
import { probeImageSrc, probeVideoSrc } from './inspect.js';

const running = new Set();

export const needsWork = (i) =>
  (i.kind === 'video' && !i.hasPoster) ||
  (i.kind === 'audio' && !i.duration) ||
  (i.kind === 'image' && !i.width);

/**
 * 挂载模式服务端不读文件内容，所以既没封面也没时长。
 * 这里用与上传完全相同的一套管线：把 /api/stream/… 当成媒体源，
 * 读元数据 + canvas 抓一帧，再回传。解码不了的计入 failed。
 */
export async function backfillPosters(bundleId, items, { concurrency = 2, onItem = () => {} } = {}) {
  if (running.has(bundleId)) return { posters: 0, meta: 0, failed: 0, skipped: true };
  const queue = items.filter(needsWork);
  if (!queue.length) return { posters: 0, meta: 0, failed: 0, skipped: false };

  running.add(bundleId);
  const stats = { posters: 0, meta: 0, failed: 0 };

  const lane = async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const meta =
          item.kind === 'image'
            ? await probeImageSrc(item.streamUrl)
            : item.kind === 'audio'
              ? { duration: await probeAudioDuration(item.streamUrl) }
              : await probeVideoSrc(item.streamUrl);
        if (meta.failed) throw new Error('解不了');
        const patch = {};
        if (meta.duration && !item.duration) patch.duration = Math.round(meta.duration * 100) / 100;
        if (meta.width && !item.width) {
          patch.width = meta.width;
          patch.height = meta.height;
        }
        if (Object.keys(patch).length) await api.patchItem(item.id, patch);
        if (meta.poster) {
          await api.uploadPoster(item.id, meta.poster);
          item.hasPoster = true;
          item.posterUrl = `/api/poster/${item.id}`;
          stats.posters += 1;
        } else if (Object.keys(patch).length) {
          stats.meta += 1;
        }
        Object.assign(item, patch);
        onItem({ ...item });
      } catch {
        // 浏览器解不了这个编码（HEVC / ProRes / mkv 等），只能留占位图
        stats.failed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, lane));
  running.delete(bundleId);
  return { ...stats, skipped: false };
}

async function probeAudioDuration(src) {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = src;
  return new Promise((resolve, reject) => {
    audio.addEventListener('loadedmetadata', () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0), { once: true });
    audio.addEventListener('error', () => reject(new Error('解不了')), { once: true });
  });
}
