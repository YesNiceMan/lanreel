// ── 文件夹入库：浏览器直传本机服务，并发车道 + 进度 + 首帧封面 ─────────────
import { api } from './api.js';
import { inspect, kindOf } from './inspect.js';
import { naturalCompare } from './dom.js';

const SUPPORTED = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'ts', 'ogv', 'ogx',
  'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'heic', 'heif', 'svg', 'tif', 'tiff',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'amr',
  'pdf', 'txt', 'md', 'srt', 'vtt', 'ass', 'lrc', 'csv', 'json', 'xml',
  'zip', 'rar', '7z', 'tar', 'gz',
]);

export function isSupported(file) {
  const dot = file.name.lastIndexOf('.');
  return dot >= 0 && SUPPORTED.has(file.name.slice(dot + 1).toLowerCase());
}

/** File[] -> [{name, relPath, file}]，relPath 去掉最外层文件夹名。 */
export function planFiles(fileList) {
  const files = [...fileList].filter((f) => f.size > 0);
  return files
    .map((file) => {
      const nested = (file.webkitRelativePath || '').split('/').filter(Boolean);
      const relPath = nested.length > 1 ? nested.slice(1).join('/') : file.name;
      return { file, name: file.name, relPath, kind: kindOf(file), size: file.size };
    })
    .sort((a, b) => naturalCompare(a.relPath, b.relPath));
}

export class UploadJob {
  constructor({ bundleRef, existing = [], concurrency = 3, maxBytes, onEvent = () => {} }) {
    this.bundleRef = bundleRef;
    this.concurrency = concurrency;
    this.maxBytes = maxBytes ?? 4 * 1024 ** 3;
    this.onEvent = onEvent;
    this.seen = new Set(existing.map((item) => `${item.relPath}::${item.size}`));
    this.controller = new AbortController();
    this.stats = { total: 0, done: 0, failed: 0, skipped: 0 };
  }

  get aborted() {
    return this.controller.signal.aborted;
  }

  cancel() {
    this.controller.abort();
  }

  async run(tasks) {
    const queue = [];
    for (const task of tasks) {
      if (!isSupported(task.file)) {
        this.onEvent({ type: 'ignored', task, reason: '类型暂不支持' });
        continue;
      }
      if (task.size > this.maxBytes) {
        this.onEvent({ type: 'rejected', task, reason: '超过单文件上限' });
        continue;
      }
      if (this.seen.has(`${task.relPath}::${task.size}`)) {
        this.stats.skipped += 1;
        this.onEvent({ type: 'skipped', task, reason: '库中已存在' });
        continue;
      }
      this.seen.add(`${task.relPath}::${task.size}`);
      queue.push(task);
    }

    this.stats.total = queue.length;
    const runOne = async () => {
      while (queue.length && !this.aborted) {
        const task = queue.shift();
        await this.#process(task);
      }
    };

    const lanes = Array.from({ length: Math.min(this.concurrency, Math.max(1, queue.length)) }, runOne);
    await Promise.all(lanes);
    return this.stats;
  }

  async #process(task) {
    const { file, relPath, name } = task;
    this.onEvent({ type: 'start', task });
    try {
      // 视频/音频先在本地读出时长与首帧，随上传一起提交，省掉服务端转码；图片只量尺寸
      const meta = await inspect(file);
      if (this.aborted) throw Object.assign(new Error('已取消'), { aborted: true });

      const { item } = await api.uploadFile(this.bundleRef, file, {
        relPath,
        duration: meta.duration ?? 0,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        signal: this.controller.signal,
        onProgress: (loaded) => this.onEvent({ type: 'progress', task, loaded, total: file.size }),
      });

      if (meta.poster && item) {
        try {
          await api.uploadPoster(item.id, meta.poster, this.controller.signal);
          item.hasPoster = true;
          item.posterUrl = `/api/poster/${item.id}`;
        } catch {
          /* 封面失败不影响素材本身 */
        }
      }
      this.stats.done += 1;
      this.onEvent({ type: 'done', task, item, name, relPath });
    } catch (err) {
      if (err?.aborted || this.aborted) {
        this.onEvent({ type: 'cancelled', task });
        return;
      }
      this.stats.failed += 1;
      this.onEvent({ type: 'error', task, reason: err?.message ?? '上传失败' });
    }
  }
}

/** 目录拖拽：递归展开 FileSystemEntry / File。 */
export async function collectDropped(items) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      Object.defineProperty(file, 'webkitRelativePath', { value: `${prefix}${file.name}` });
      out.push(file);
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    // readEntries 会分片返回，必须循环读到空
    const all = [...batch];
    let more = batch;
    while (more.length) {
      more = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      all.push(...more);
    }
    for (const child of all) await walk(child, `${prefix}${entry.name}/`);
  };

  for (const raw of items) {
    const entry = raw.webkitGetAsEntry?.();
    if (entry) await walk(entry, '');
    else {
      const file = raw.getAsFile?.();
      if (file) out.push(file);
    }
  }
  return out;
}
