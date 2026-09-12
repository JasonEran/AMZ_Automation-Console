/**
 * The 9 checks, in one place.
 *
 * The dashboard, the CLI and the scheduler all enumerate from here, so adding a
 * check means adding one entry plus its definition module — nothing else needs
 * to learn about it.
 *
 * `slots` are Beijing-time run windows. Items 1-7 and item 9 ride the 08:00 /
 * 15:30 patrol; item 8 (ads) has its own 11:20 / 18:30 windows because the
 * requirement is that ads must be *off* by 11:20 and *on* by 18:30. Numbers are
 * historical identifiers and are never renumbered — item 9 (Inbox) is shown
 * between Feedback and Reviews in the dashboard's 客户声音 work area.
 */
export const CHECKS = [
  {
    id: 'store-health',
    no: 1,
    title: '店铺健康状态',
    short: '店铺健康',
    requirement: 'Policy Compliance 显示 Healthy 为正常，其他一律异常',
    scope: 'store',
    slots: ['am', 'pm'],
    module: '../checks/store-health.js',
    entry: 'runStoreHealth',
  },
  {
    id: 'performance',
    no: 2,
    title: '绩效未处理检查',
    short: '绩效',
    requirement: 'performance/dashboard 出现明显标红提示即为异常',
    scope: 'store',
    slots: ['am', 'pm'],
    module: '../checks/performance.js',
  },
  {
    id: 'feedback',
    no: 3,
    title: 'Recent Feedback 检查',
    short: 'Feedback',
    requirement: '仅检查北京时间当天 Feedback；当天出现低于 4 分评价即为异常',
    scope: 'store',
    slots: ['am', 'pm'],
    module: '../checks/feedback.js',
  },
  {
    id: 'reviews',
    no: 4,
    title: 'Customer Reviews 检查',
    short: 'Reviews',
    requirement: '筛选 1～3 星并采集全部分页，按本店有效 ASIN 归属；首次发现低星即提醒，旧日期评价不忽略',
    scope: 'store',
    slots: ['am', 'pm'],
    module: '../checks/reviews.js',
  },
  {
    id: 'asin-health',
    no: 5,
    title: 'ASIN 常规检查',
    short: 'ASIN',
    requirement: '先确认 ASIN 仍激活/可售；仅对在售商品检查购物车与评分变化',
    scope: 'asin',
    slots: ['am', 'pm'],
    module: '../checks/asin-health.js',
  },
  {
    id: 'outlet',
    no: 6,
    title: '奥特莱斯监控',
    short: '奥特莱斯',
    requirement: 'Create outlet deal 出现新活动即需提醒',
    scope: 'store',
    slots: ['am', 'pm'],
    module: '../checks/outlet.js',
  },
  {
    id: 'voc',
    no: 7,
    title: '客户登记 (VOC)',
    short: 'VOC',
    requirement: 'Voice of the Customer 逐 ASIN 登记退货记录',
    scope: 'store',
    slots: ['am', 'pm'],
    module: '../checks/voc.js',
  },
  {
    id: 'ads-status',
    no: 8,
    title: '广告开关检查',
    short: '广告',
    requirement: '按广告组合名称限定范围，联合核对组合与活动状态；11:20 多数应关闭，18:30 多数应开启；超过 50% 符合即正常，少数例外留档',
    scope: 'store',
    slots: ['ads-off', 'ads-on'],
    module: '../checks/ads-status.js',
    realtime: true,
  },
  {
    id: 'inbox',
    no: 9,
    title: 'Inbox 买家消息检查',
    short: 'Inbox',
    requirement: 'Inbox 出现未读/待回复的买家消息即需运营处理；只读列表，绝不打开会话',
    scope: 'store',
    slots: ['am', 'pm'],
    module: '../checks/inbox.js',
  },
];

export const CHECK_IDS = CHECKS.map((c) => c.id);

/** Total number of checks, used everywhere a "[n/N]" label is printed. */
export const CHECK_TOTAL = CHECKS.length;

export function getCheck(id) {
  return CHECKS.find((c) => c.id === id) || null;
}

/** Run windows in Beijing time. Item 8 deliberately sits outside the main patrol. */
export const SLOTS = [
  // VOC runs before ASIN health so item 5 can consume the current store's live
  // ASIN list instead of a stale hand-maintained placeholder file. Inbox rides
  // next to Feedback because both answer "what did buyers send us today".
  { name: 'am', at: '08:00', label: '早班巡检', checks: ['store-health', 'performance', 'feedback', 'inbox', 'reviews', 'outlet', 'voc', 'asin-health'] },
  { name: 'ads-off', at: '11:20', label: '广告应已关闭', checks: ['ads-status'] },
  { name: 'pm', at: '15:30', label: '午班巡检', checks: ['store-health', 'performance', 'feedback', 'inbox', 'reviews', 'outlet', 'voc', 'asin-health'] },
  { name: 'ads-on', at: '18:30', label: '广告应已开启', checks: ['ads-status'] },
];

export function checksForSlot(slotName) {
  const slot = SLOTS.find((s) => s.name === slotName);
  return slot ? slot.checks : CHECK_IDS;
}
