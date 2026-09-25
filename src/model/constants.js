// 领域常量与共享类型定义。

// RSVP 状态
export const STATUS = Object.freeze({
  CONFIRMED: 'confirmed', // 确认出席
  PENDING: 'pending', // 待定
  DECLINED: 'declined', // 婉拒
});

export const KNOWN_STATUSES = Object.freeze(Object.values(STATUS));

// CSV 中允许出现的状态写法（中英对照）
export const STATUS_ALIASES = Object.freeze({
  confirmed: STATUS.CONFIRMED,
  确认: STATUS.CONFIRMED,
  确认出席: STATUS.CONFIRMED,
  attending: STATUS.CONFIRMED,
  yes: STATUS.CONFIRMED,
  pending: STATUS.PENDING,
  待定: STATUS.PENDING,
  tentative: STATUS.PENDING,
  maybe: STATUS.PENDING,
  declined: STATUS.DECLINED,
  婉拒: STATUS.DECLINED,
  谢绝: STATUS.DECLINED,
  no: STATUS.DECLINED,
});

// 内置来源（人工解决冲突时使用，不允许外部 CSV 冒充）
export const SOURCE_MANUAL = 'manual';

export const EVENT_KIND_RSVP = 'rsvp';
export const EVENT_KIND_RESOLUTION = 'resolution';

// 物化后每个事件在宾客历史上的效果标记
export const EFFECT = Object.freeze({
  APPLIED: 'applied', // 当前生效
  SUPERSEDED: 'superseded', // 被更新事件覆盖（迟到旧事件，仅留痕）
  DUPLICATE: 'duplicate', // 同源同序号重复（幂等丢弃，留痕在导入批次而非账本）
  CONVERGENT: 'convergent', // 同时刻跨来源且内容一致（冗余但无冲突）
  CONFLICTED: 'conflicted', // 同时刻跨来源内容不一致（待人工处理）
});

export function normalizeStatus(raw, field = 'status') {
  const key = String(raw ?? '').trim().toLowerCase();
  const s = STATUS_ALIASES[key];
  if (!s) {
    throw new Error(
      `${field} 非法：${raw}（允许 confirmed/pending/declined 或 确认/待定/婉拒）`,
    );
  }
  return s;
}
