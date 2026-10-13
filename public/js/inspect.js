// ── 浏览器侧元数据探测：时长、分辨率、首帧封面（无需 ffmpeg）──────────────
const TIMEOUT = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ failed: true, timeout: true }), ms)),
  ]);
}

function makeVideo(src, objectUrl) {
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  video.src = src;
  return { video, release: () => { video.removeAttribute('src'); video.load(); if (objectUrl) URL.revokeObjectURL(objectUrl); } };
}

/** 把已经解码好的画面缩到 640px 宽存成 jpeg，作为网格里的缩略图 */
function snapshot(source, srcW, srcH) {
  const canvas = document.createElement('canvas');
  const ratio = srcH / (srcW || 1) || 0.5625;
  canvas.width = Math.min(640, srcW || 640);
  canvas.height = Math.round(canvas.width * ratio);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.72));
}

/**
 * 从任意同源地址读时长/分辨率并抓一帧封面。
 * 既服务上传（blob:），也服务挂载（/api/stream/…）。
 */
export async function probeVideoSrc(src, objectUrl) {
  const { video, release } = makeVideo(src, objectUrl);
  try {
    const meta = await withTimeout(
      new Promise((resolve) => {
        const fail = () => resolve({ failed: true });
        video.addEventListener('loadedmetadata', () => {
          const base = {
            duration: Number.isFinite(video.duration) ? video.duration : 0,
            width: video.videoWidth || 0,
            height: video.videoHeight || 0,
          };
          if (!base.duration) return resolve(base);
          const seekTo = Math.min(1.2, base.duration * 0.15);
          const onSeeked = () => {
            video.removeEventListener('error', fail);
            snapshot(video, video.videoWidth, video.videoHeight)
              .then((poster) => resolve({ ...base, poster }))
              .catch(() => resolve(base));
          };
          video.addEventListener('seeked', onSeeked, { once: true });
          video.addEventListener('error', () => resolve(base), { once: true });
          try {
            video.currentTime = seekTo;
          } catch {
            resolve(base);
          }
        }, { once: true });
        video.addEventListener('error', fail, { once: true });
      }),
      TIMEOUT,
    );
    return meta;
  } finally {
    release();
  }
}

/** 视频：读元数据 + 抓一帧当封面。失败不阻塞入库。 */
export function inspectVideo(file) {
  const url = URL.createObjectURL(file);
  return probeVideoSrc(url, url);
}

/** 音频只有时长，没有画面。 */
export async function inspectAudio(file) {
  const url = URL.createObjectURL(file);
  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  audio.src = url;
  try {
    return await withTimeout(
      new Promise((resolve) => {
        audio.addEventListener('loadedmetadata', () =>
          resolve({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }),
        );
        audio.addEventListener('error', () => resolve({}), { once: true });
      }),
      TIMEOUT,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 图片：量尺寸，并顺手压一张缩略图。
 * 原图可能是几 MB 的海报或截帧，网格不能直接拿它当封面用。
 */
export async function probeImageSrc(src, objectUrl, { poster = true } = {}) {
  const img = new Image();
  try {
    return await withTimeout(
      new Promise((resolve) => {
        img.onload = async () => {
          const base = {
            width: img.naturalWidth,
            height: img.naturalHeight,
            failed: !img.naturalWidth,
          };
          if (!base.failed && poster) {
            try {
              return resolve({ ...base, poster: await snapshot(img, img.naturalWidth, img.naturalHeight) });
            } catch {
              /* 压不出封面就只回尺寸 */
            }
          }
          resolve(base);
        };
        img.onerror = () => resolve({ failed: true });
        img.src = src;
      }),
      8000,
    );
  } finally {
    img.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export async function inspectImage(file) {
  const url = URL.createObjectURL(file);
  return probeImageSrc(url, url);
}

export async function inspect(file) {
  const kind = kindOf(file);
  if (kind === 'video') return inspectVideo(file);
  if (kind === 'audio') return inspectAudio(file);
  if (kind === 'image') return inspectImage(file);
  return {};
}

export const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'ts', 'ogv'];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'heic', 'heif', 'svg', 'tif', 'tiff'];
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'amr'];

export function extOf(file) {
  const dot = file.name.lastIndexOf('.');
  return dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase();
}

export function kindOf(file) {
  const ext = extOf(file);
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return 'other';
}
