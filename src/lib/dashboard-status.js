/**
 * The collector keeps its strict raw severity (OK/WARN/CRITICAL/ERROR).
 * The dashboard adds an owner-oriented state so a reader immediately knows
 * who should act without weakening any verdict.
 */
export const ACTION_LABEL = {
  NORMAL: '正常',
  BUSINESS: '业务待处理',
  COLLECTION: '采集待修复',
  PENDING: '未完成',
};

export const ACTION_OWNER = {
  NORMAL: '无需处理',
  BUSINESS: '运营',
  COLLECTION: '技术',
  PENDING: '排程',
};

const ACTION_RANK = { NORMAL: 0, PENDING: 1, COLLECTION: 2, BUSINESS: 3 };

export function actionStateFor({ state, stale = false } = {}) {
  if (stale) return 'COLLECTION';
  if (['WARN', 'CRITICAL'].includes(state)) return 'BUSINESS';
  if (['ERROR', 'NOT_CONFIGURED'].includes(state)) return 'COLLECTION';
  if (state === 'OK') return 'NORMAL';
  return 'PENDING';
}

export function rawStateLabel(state, { stale = false } = {}) {
  if (stale) return '数据过期';
  return ({
    OK: '正常',
    WARN: '业务关注',
    CRITICAL: '业务异常',
    ERROR: '采集异常',
    NOT_CONFIGURED: '配置缺失',
    NOT_COVERED: '本批未覆盖',
    NEVER_RUN: '尚未运行',
    SKIPPED: '已跳过',
  })[state] || state || '未知';
}

export function worstAction(states) {
  if (!states?.length) return 'PENDING';
  return states.reduce((worst, state) =>
    (ACTION_RANK[state] ?? ACTION_RANK.COLLECTION) > (ACTION_RANK[worst] ?? -1) ? state : worst,
  'NORMAL');
}
