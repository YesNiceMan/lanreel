// 评审档案的操作口径：服务端写记录、前端看记录、导出出表，三处共用同一份中文说法。
export const ARCHIVE_OPS = {
  'bundle:create': { label: '建夹', ico: 'plus' },
  'bundle:mount': { label: '挂载目录', ico: 'folder' },
  'bundle:rename': { label: '素材夹改名', ico: 'pencil' },
  'bundle:expire': { label: '改分享有效期', ico: 'clock' },
  'bundle:rescan': { label: '重新扫描', ico: 'refresh' },
  'bundle:reopen': { label: '重挂认领', ico: 'link' },
  'bundle:description': { label: '改说明', ico: 'pencil' },
  unlist: { label: '撤下归档', ico: 'archive' },
  'item:add': { label: '素材入库', ico: 'upload' },
  'item:rename': { label: '素材改名', ico: 'pencil' },
  'item:remove': { label: '删除素材', ico: 'trash' },
  'item:missing': { label: '源文件丢失', ico: 'eye' },
  status: { label: '打状态', ico: 'check' },
  note: { label: '写备注', ico: 'note' },
  'note:remove': { label: '删备注', ico: 'trash' },
  mark: { label: '打时间点', ico: 'tag' },
  'mark:move': { label: '移动时间点', ico: 'clock' },
  'mark:remove': { label: '删时间点', ico: 'trash' },
  'legacy:log': { label: '旧库流水', ico: 'doc' },
};

export const ARCHIVE_KINDS = {
  owner: { label: '机主', hint: '运行 LanReel 的这台电脑，或带正确机主口令' },
  member: { label: '成员', hint: '邀请链接进来、服务端盖过章的人' },
  guest: { label: '同事', hint: '从分享链接进来，名字是自己填的，没验证过' },
  legacy: { label: '旧库', hint: '升级前从素材夹内部回灌出来的历史记录' },
  system: { label: '系统', hint: 'LanReel 自己记下的事件' },
};

export const OP_LABEL = (key) => ARCHIVE_OPS[key]?.label ?? key;
export const KIND_LABEL = (key) => ARCHIVE_KINDS[key]?.label ?? key;
