// 素材评审状态：服务端与前端共用的唯一定义。
export const STATUSES = [
  { key: 'unset', label: '未标记', tone: 'neutral', hint: '还没有人表态' },
  { key: 'todo', label: '待看', tone: 'info', hint: '放进待审队列' },
  { key: 'short', label: '入选', tone: 'success', hint: '这条要了' },
  { key: 'revise', label: '需修改', tone: 'warn', hint: '有问题，回炉' },
  { key: 'drop', label: '淘汰', tone: 'danger', hint: '不用了' },
];

export const STATUS_KEYS = STATUSES.map((s) => s.key);
export const STATUS_BY_KEY = Object.fromEntries(STATUSES.map((s) => [s.key, s]));

export function statusLabel(key) {
  return STATUS_BY_KEY[key]?.label ?? STATUS_BY_KEY.unset.label;
}
