#!/usr/bin/env node
/**
 * Seed the dashboard with demo data so the UI can be reviewed before Ziniao is
 * configured. Every seeded report is marked `demo:true` and the dashboard shows
 * it like any other run — run `node scripts/seed-demo.mjs --clear` to remove.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/lib/config.js';
import { CHECKS } from '../src/checks/registry.js';
import { bjIso, bjStamp } from '../src/lib/time.js';

const clear = process.argv.includes('--clear');
const production = process.env.NODE_ENV === 'production';

if (production) {
  console.error('生产环境禁止写入或清除演示数据');
  process.exit(2);
}

const { config } = loadConfig();

if (clear) {
  for (const c of CHECKS) {
    const f = path.join(config.outDir, c.id, 'latest.json');
    if (!fs.existsSync(f)) continue;
    let value = null;
    try { value = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* fail closed below */ }
    if (value?.demo === true) { fs.unlinkSync(f); console.log('已删除演示报告', c.id); }
    else console.warn('保留非演示报告', c.id);
  }
  process.exit(0);
}

for (const c of CHECKS) {
  const f = path.join(config.outDir, c.id, 'latest.json');
  if (!fs.existsSync(f)) continue;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* fail closed below */ }
  if (value?.demo !== true) {
    console.error(`拒绝覆盖真实或无法验证的最新报告: ${c.id}`);
    process.exit(2);
  }
}

const S = ['US-01', 'US-02', 'JP-01'];
const mk = (id, no, title, req, results) => ({
  check: id, checkNo: no, checkTitle: title, requirement: req, demo: true,
  runId: `${id}-${bjStamp()}-demo`, slot: 'am', timezone: 'Asia/Shanghai',
  startedAt: bjIso(), finishedAt: bjIso(), durationMs: 42000,
  execution: { mode: 'sequential', concurrencyLimit: 1, peakActive: 1 },
  totals: {
    total: results.length, ok: results.filter(r => r.ok).length,
    abnormal: results.filter(r => !r.ok).length,
    errors: results.filter(r => r.severity === 'ERROR').length,
    warnings: results.filter(r => r.severity === 'WARN').length, notConfigured: 0,
  },
  results, alerts: [], crm: { attempted: false, reason: 'demo' },
});
const row = (k, o) => ({
  storeKey: k, storeName: k, storeId: 'demo', market: k.slice(0, 2), url: 'https://sellercentral.amazon.com/...',
  confidence: 'high', verdictSource: 'dom+text', items: [], notes: [], attempts: 1,
  durationMs: 12000, screenshot: null, error: null, checkedAt: bjIso(), ...o,
});

const data = [
  mk('store-health', 1, '店铺健康状态', 'Policy Compliance 显示 Healthy 为正常，其他一律异常', [
    row('US-01', { status: 'HEALTHY', ok: true, severity: 'OK', ahrScore: 256, metrics: { ahrScore: 256 }, anomalyReasons: [] }),
    row('US-02', { status: 'AT_RISK', ok: false, severity: 'CRITICAL', ahrScore: 120, metrics: { ahrScore: 120 }, anomalyReasons: ['Policy Compliance = 有风险 (At Risk)（非 Healthy）'] }),
    row('JP-01', { status: 'HEALTHY', ok: true, severity: 'OK', ahrScore: 892, metrics: { ahrScore: 892 }, anomalyReasons: [] }),
  ]),
  mk('performance', 2, '绩效未处理检查', 'performance/dashboard 出现明显标红提示即为异常', [
    row('US-01', { status: 'CLEAR', ok: true, severity: 'OK', metrics: { redWarnings: 0, badSections: 0 }, anomalyReasons: [] }),
    row('US-02', { status: 'CLEAR', ok: true, severity: 'OK', metrics: { redWarnings: 0, badSections: 0 }, anomalyReasons: [] }),
    row('JP-01', { status: 'CLEAR', ok: true, severity: 'OK', metrics: { redWarnings: 0 }, anomalyReasons: [] }),
  ]),
  mk('feedback', 3, 'Recent Feedback 检查', 'feedback-manager 出现低于 4 分的评价即为异常', [
    row('US-01', { status: 'LOW_RATING', ok: false, severity: 'CRITICAL', metrics: { lowCount: 2, total: 18, average: 4.3 }, anomalyReasons: ['出现 2 条低于 4 分的 Feedback', '1 分：Item arrived damaged, seller unresponsive'] }),
    row('US-02', { status: 'CLEAR', ok: true, severity: 'OK', metrics: { lowCount: 0, total: 9, average: 4.9 }, anomalyReasons: [] }),
    row('JP-01', { status: 'CLEAR', ok: true, severity: 'OK', metrics: { lowCount: 0, total: 12, average: 5 }, anomalyReasons: [] }),
  ]),
  mk('reviews', 4, 'Customer Reviews 检查', 'brand-customer-reviews 出现低于 4 星的评价即为异常', [
    row('US-01', { status: 'CLEAR', ok: true, severity: 'OK', metrics: { lowCount: 0, total: 41, average: 4.6 }, anomalyReasons: [] }),
    row('US-02', { status: 'CLEAR', ok: true, severity: 'OK', metrics: { lowCount: 0, total: 22, average: 4.7 }, anomalyReasons: [] }),
    row('JP-01', { status: 'CLEAR', ok: true, severity: 'OK', metrics: { lowCount: 0, total: 7, average: 4.6 }, anomalyReasons: [] }),
  ]),
  mk('asin-health', 5, 'ASIN 常规检查', '链接可打开、购物车存在、分数与前一日对比不下降', [
    { asin: 'B0CXXXXX01', market: 'US', storeKey: 'US-01', url: 'https://www.amazon.com/dp/B0CXXXXX01', status: 'OK', ok: true, severity: 'OK', confidence: 'high', verdictSource: 'dom+text', metrics: { opened: true, hasCart: true, rating: 4.5, prevRating: 4.5, ratingDelta: 0 }, anomalyReasons: [], items: [], notes: [], durationMs: 9000, screenshot: null, error: null, checkedAt: bjIso() },
    { asin: 'B0CXXXXX02', market: 'US', storeKey: 'US-01', url: 'https://www.amazon.com/dp/B0CXXXXX02', status: 'RATING_DROP', ok: false, severity: 'WARN', confidence: 'high', verdictSource: 'dom+text', metrics: { opened: true, hasCart: true, rating: 4.1, prevRating: 4.4, ratingDelta: -0.3 }, anomalyReasons: ['评分下降 4.4 → 4.1 (-0.3)'], items: [], notes: [], durationMs: 8500, screenshot: null, error: null, checkedAt: bjIso() },
    { asin: 'B0CXXXXX03', market: 'US', storeKey: 'US-02', url: 'https://www.amazon.com/dp/B0CXXXXX03', status: 'NO_CART', ok: false, severity: 'CRITICAL', confidence: 'high', verdictSource: 'dom+text', metrics: { opened: true, hasCart: false, rating: 4.6, prevRating: 4.6, ratingDelta: 0 }, anomalyReasons: ['购物车按钮不存在（可能失去购买资格 / 无 Buy Box）'], items: [], notes: [], durationMs: 7800, screenshot: null, error: null, checkedAt: bjIso() },
  ]),
  mk('outlet', 6, '奥特莱斯监控', 'Create outlet deal 出现新活动即需提醒', [
    row('US-01', { status: 'NEW_DEAL', ok: false, severity: 'WARN', metrics: { dealCount: 5, newCount: 2 }, anomalyReasons: ['出现 2 个新的可创建奥特莱斯活动：B0CXXXXX07, B0CXXXXX08'] }),
    row('US-02', { status: 'NO_CHANGE', ok: true, severity: 'OK', metrics: { dealCount: 1, newCount: 0 }, anomalyReasons: [] }),
    row('JP-01', { status: 'NO_CHANGE', ok: true, severity: 'OK', metrics: { dealCount: 0, newCount: 0 }, anomalyReasons: [] }),
  ]),
  mk('voc', 7, '客户登记 (VOC)', 'Voice of the Customer 逐 ASIN 登记退货记录', [
    row('US-01', { status: 'REGISTERED', ok: true, severity: 'OK', metrics: { asinCount: 24, poorCount: 0, registered: 24 }, anomalyReasons: [] }),
    row('US-02', { status: 'REGISTERED', ok: true, severity: 'OK', metrics: { asinCount: 11, poorCount: 0, registered: 11 }, anomalyReasons: [] }),
    row('JP-01', { status: 'REGISTERED', ok: true, severity: 'OK', metrics: { asinCount: 6, poorCount: 0, registered: 6 }, anomalyReasons: [] }),
  ]),
  mk('ads-status', 8, '广告开关检查', '11:20 应全部关闭，18:30 应全部开启', [
    row('US-01', { status: 'ALL_OFF', ok: true, severity: 'OK', metrics: { enabled: 0, paused: 14, expected: 'ads-off' }, anomalyReasons: [] }),
    row('US-02', { status: 'SHOULD_BE_OFF', ok: false, severity: 'CRITICAL', metrics: { enabled: 3, paused: 11, expected: 'ads-off' }, anomalyReasons: ['应全部关闭，但仍有 3/14 个广告活动处于开启状态'] }),
    row('JP-01', { status: 'ALL_OFF', ok: true, severity: 'OK', metrics: { enabled: 0, paused: 8, expected: 'ads-off' }, anomalyReasons: [] }),
  ]),
];
for (const d of data) {
  const dir = path.join(config.outDir, d.check);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(d, null, 2) + '\n');
}
console.log(`已写入 ${data.length} 个检查项的演示数据 → ${config.outDir}`);
console.log('清除: node scripts/seed-demo.mjs --clear');
