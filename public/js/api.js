// ── 与本地服务端的通信层 ──────────────────────────────────────────────────
/** 分享页告诉服务端「我是从哪条链接进来的」，评审写操作只允许落在这个夹子里 */
let shareToken = '';
export const setShareScope = (token) => {
  shareToken = String(token ?? '');
};

function withScope(headers) {
  return shareToken ? { ...headers, 'x-share-token': shareToken } : headers;
}

async function request(url, options = {}) {
  const res = await fetch(url, { ...options, headers: withScope(options.headers ?? {}) });
  if (res.status === 204) return null;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

const post = (url, data) =>
  request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  });

const patch = (url, data) =>
  request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  });

export const api = {
  health: () => request('/api/health'),
  /** 明文口令只在运行 LanReel 的这台电脑上返回 */
  owner: () => request('/api/owner'),
  bundles: () => request('/api/bundles'),
  bundle: (ref) => request(`/api/bundles/${encodeURIComponent(ref)}`),
  share: (token) => request(`/api/share/${encodeURIComponent(token)}`),
  createBundle: (name, description) => post('/api/bundles', { name, description }),
  /** 零拷贝挂载目录（本机任意路径；远程只能落在机主设的 MOUNT_ROOTS 里） */
  mount: (path, name) => post('/api/mounts', { path, name }),
  /** 浏览服务器上的目录（只列文件夹）：远程成员挑挂载路径用 */
  browse: (path = '') => request(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  /** 让本机弹系统文件夹选择器，返回绝对路径（浏览器自己拿不到） */
  pickFolder: () => post('/api/pick-folder', {}),
  rescan: (ref) => post(`/api/bundles/${encodeURIComponent(ref)}/rescan`, {}),
  updateBundle: (ref, data) => patch(`/api/bundles/${encodeURIComponent(ref)}`, data),
  /** 撤下归档：素材夹没了，评审记录和封面留在 data/archive/ 里 */
  deleteBundle: (ref) => request(`/api/bundles/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
  /** 彻底删除：连档案一起抹掉，没有挽回手段 */
  purgeBundle: (ref) => request(`/api/bundles/${encodeURIComponent(ref)}?purge=1`, { method: 'DELETE' }),

  // ── 评审档案（机主专属）────────────────────────────────────────────────
  archiveBundles: () => request('/api/archive'),
  archiveRecords: (ref, filter = {}) => {
    const params = new URLSearchParams();
    if (filter.who) params.set('who', filter.who);
    if (filter.op) params.set('op', filter.op);
    if (filter.q) params.set('q', filter.q);
    const qs = params.toString();
    return request(`/api/archive/${encodeURIComponent(ref)}${qs ? `?${qs}` : ''}`);
  },
  archiveExportHref: (ref, fmt, filter = {}) => {
    const params = new URLSearchParams({ fmt });
    if (filter.who) params.set('who', filter.who);
    if (filter.op) params.set('op', filter.op);
    if (filter.q) params.set('q', filter.q);
    return `/api/archive/${encodeURIComponent(ref)}/export?${params}`;
  },
  archivePosterHref: (ref, itemId) => `/api/archive/${encodeURIComponent(ref)}/posters/${encodeURIComponent(itemId)}`,

  // ── 成员：机主发邀请链接，同事点开换一枚 Cookie ──────────────────────────
  members: () => request('/api/members'),
  inviteMember: (name) => post('/api/members', { name }),
  revokeMember: (ref) => post(`/api/members/${encodeURIComponent(ref)}/revoke`, {}),
  restoreMember: (ref) => post(`/api/members/${encodeURIComponent(ref)}/restore`, {}),
  leaveMember: () => post('/api/member/leave', {}),

  deleteItem: (itemId) => request(`/api/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
  patchItem: (itemId, data) => patch(`/api/items/${encodeURIComponent(itemId)}`, data),
  setStatus: (ids, status, by) => post('/api/items/status', { ids, status, by }),
  addNote: (itemId, text, author, t = null) => post(`/api/items/${encodeURIComponent(itemId)}/notes`, { text, author, t }),
  deleteNote: (itemId, noteId, by) =>
    request(`/api/items/${encodeURIComponent(itemId)}/notes/${encodeURIComponent(noteId)}?by=${encodeURIComponent(by)}`, {
      method: 'DELETE',
    }),

  addMark: (itemId, t, author) => post(`/api/items/${encodeURIComponent(itemId)}/marks`, { t, author }),
  moveMark: (itemId, markId, t, by) => patch(`/api/items/${encodeURIComponent(itemId)}/marks/${encodeURIComponent(markId)}`, { t, by }),
  deleteMark: (itemId, markId, by) =>
    request(`/api/items/${encodeURIComponent(itemId)}/marks/${encodeURIComponent(markId)}?by=${encodeURIComponent(by)}`, {
      method: 'DELETE',
    }),

  /** 原样 PUT 文件字节：没有 multipart，没有云端中转。xhr 用来拿上传进度。 */
  uploadFile(bundleRef, file, { relPath, duration = 0, width = 0, height = 0, onProgress, signal } = {}) {
    const params = new URLSearchParams({
      name: file.name,
      path: relPath || file.name,
      size: String(file.size),
      duration: String(Math.round(duration || 0)),
      width: String(width || 0),
      height: String(height || 0),
    });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/bundles/${encodeURIComponent(bundleRef)}/items?${params}`);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
        else reject(new Error(xhr.response?.error || `上传失败 (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('网络中断，上传失败'));
      xhr.onabort = () => reject(Object.assign(new Error('已取消'), { aborted: true }));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  },

  uploadPoster(itemId, blob, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/items/${encodeURIComponent(itemId)}/poster`);
      xhr.responseType = 'json';
      xhr.setRequestHeader('Content-Type', 'image/jpeg');
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response) : reject(new Error('封面保存失败')));
      xhr.onerror = () => reject(new Error('封面保存失败'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(blob);
    });
  },
};
