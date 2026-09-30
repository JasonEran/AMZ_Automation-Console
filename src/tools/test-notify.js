import { createAlerter, defaultDingTalkSeverities } from '../lib/alert.js';
import { pushToCrm } from '../lib/crm.js';
import { sanitizeUrl } from '../lib/redact.js';
import { bjIso } from '../lib/time.js';

/**
 * Exercise the notification and CRM wiring with a clearly-labelled sample, so
 * the channels can be verified now instead of the first time a real store goes
 * unhealthy at 08:00.
 */
export async function runTestNotify({ config, logger, opts = {} }) {
  const dt = config.alert?.dingtalk || {};
  const wh = config.alert?.webhook || {};

  logger.plain('');
  logger.plain('报警与 CRM 通道测试');
  logger.plain('─'.repeat(52));
  const dtChannels = Array.isArray(dt.channels) ? dt.channels.filter((c) => c.enabled && c.webhook) : [];
  logger.plain(`钉钉:    ${dtChannels.length ? `已启用 ${dtChannels.length} 个路由通道` : dt.enabled && dt.webhook ? `已启用${dt.secret ? '（含加签）' : '（无加签）'}` : '未启用'}`);
  logger.plain(`Webhook: ${wh.enabled && wh.url ? `已启用 → ${sanitizeUrl(wh.url)}` : '未启用'}`);
  logger.plain(`本地文件: ${config.alert?.file !== false ? '已启用' : '未启用'}`);
  logger.plain(`CRM:     ${config.crm?.enabled && config.crm?.endpoint ? `已启用 → ${sanitizeUrl(config.crm.endpoint)}` : '未启用'}`);
  logger.plain('─'.repeat(52));

  if (!dt.enabled && !dtChannels.length && !wh.enabled && !config.crm?.enabled) {
    logger.plain('');
    logger.plain('外部通道都没启用，只会写本地 alerts 文件。要测钉钉先设：');
    logger.plain('  export DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=..."');
    logger.plain('  export DINGTALK_SECRET="SEC..."   # 用了加签才需要');
    logger.plain('');
  }

  const alerter = createAlerter({ config, logger, outDir: config.outDir });

  // A routed setup needs one harmless, clearly labelled message per severity
  // class. Otherwise a CRITICAL-only test can prove the regular robot while
  // leaving the operations robot entirely untested (or vice versa).
  const preferredSeverity = (channel) => {
    const levels = channel.severities || defaultDingTalkSeverities(channel);
    const preferred = channel.name === 'operations' ? ['ERROR', 'WARN']
      : channel.name === 'business' ? ['CRITICAL', 'WARN'] : ['CRITICAL', 'OK'];
    return preferred.find((level) => levels.includes(level)) || levels[0] || 'ERROR';
  };
  const severities = opts.severity
    ? [opts.severity]
    : dtChannels.length
      ? [...new Set(dtChannels.map(preferredSeverity))]
      : ['CRITICAL'];
  const alerts = [];
  for (const severity of severities) {
    const accepts = (channel) => (channel.severities || defaultDingTalkSeverities(channel)).includes(severity);
    const businessTest = dtChannels.some((channel) => channel.name === 'business' && accepts(channel));
    const regularTest = dtChannels.some((channel) => !['operations', 'business'].includes(channel.name) && accepts(channel));
    const operationsTest = dtChannels.some((channel) => channel.name === 'operations' && accepts(channel))
      || (!dtChannels.length && (severity === 'ERROR' || severity === 'WARN'));
    const routeLabel = [
      regularTest ? '常规机器人（业务异常与运行正常）' : '',
      businessTest ? '业务机器人（页面证据业务事项）' : '',
      operationsTest ? '运维机器人（采集故障与需关注）' : '',
    ].filter(Boolean).join('；')
      || (operationsTest ? '运维机器人（采集故障与需关注）' : '常规机器人（业务异常与运行正常）');
    const titleAudience = businessTest && !regularTest && !operationsTest ? '业务'
      : operationsTest && !regularTest && !businessTest ? '运维'
      : '常规';
    alerts.push(await alerter.send({
      check: 'channel-connectivity',
      severity,
      title: `[测试消息，请忽略] ${titleAudience}通知通道连通性验证`,
      lines: [
        '测试性质：仅验证消息投递，不代表真实业务状态',
        `目标路由：${routeLabel}`,
        '测试范围：通知链路、加签配置与本地投递审计',
      ],
      data: { test: true, runId: 'test-notify', severity, sentAt: bjIso() },
    }));
  }

  logger.plain('');
  logger.plain('投递结果:');
  for (const alert of alerts) {
    for (const [channel, result] of Object.entries(alert.delivery || {})) {
      if (channel === 'file') continue;
      logger.plain(`  ${channel}: ${result}`);
    }
  }

  let crmResult = null;
  if (config.crm?.enabled && config.crm?.endpoint) {
    logger.plain('');
    logger.plain('正在执行 CRM dry-run（仅验证配置、结构和幂等键，不发送任何虚假业务数据）…');
    crmResult = await pushToCrm({
      config,
      logger,
      dryRun: true,
      payload: {
        source: 'singal-amz-guard',
        check: 'store-health',
        checkTitle: '店铺健康状态检查 (Policy Compliance)',
        runId: 'test-notify',
        slot: 'test',
        timezone: 'Asia/Shanghai',
        startedAt: bjIso(),
        finishedAt: bjIso(),
        test: true,
        totals: { total: 1, healthy: 0, abnormal: 1, undetermined: 0, errors: 0, warnings: 0 },
        records: [
          {
            storeKey: 'TEST-US-01',
            storeName: '示例店铺（测试数据）',
            storeId: 'test-0000',
            market: 'US',
            checkedAt: bjIso(),
            url: 'https://sellercentral.amazon.com/performance/dashboard/accounthealth',
            policyCompliance: 'AT_RISK',
            policyComplianceLabel: '有风险 (At Risk)',
            isNormal: false,
            severity: 'CRITICAL',
            confidence: 'high',
            verdictSource: 'dom+text',
            accountHealthRating: 120,
            accountHealthRatingMax: 1000,
            accountHealthRatingPrev: 256,
            accountHealthRatingDelta: -136,
            statusPrev: 'HEALTHY',
            statusChanged: true,
            anomalyReasons: ['Policy Compliance = 有风险 (At Risk)（非 Healthy）'],
            screenshot: null,
            error: null,
          },
        ],
      },
    });
    logger.plain(`  CRM: ${crmResult.ok ? `dry-run 通过（待发送 ${crmResult.pending ?? 0} 条）` : crmResult.reason || 'dry-run 失败'}`);
    logger.plain('  未向 CRM 发出网络请求，也没有创建测试记录。');
  }

  logger.plain('');
  logger.plain(`本地审计文件: ${alerter.fileSink}`);

  const deliveryFor = (name) => alerts.some((alert) => alert.delivery?.[name] === 'ok');
  const dtConfigured = dt.enabled || dtChannels.length > 0;
  const dtOk = !dtConfigured || (dtChannels.length
    ? dtChannels.every((channel) => deliveryFor(`dingtalk:${channel.name || 'default'}`))
    : deliveryFor('dingtalk:default'));
  const whOk = !wh.enabled || alerts.some((alert) => alert.delivery?.webhook === 'ok');
  const crmOk = !crmResult || crmResult.ok;
  const allOk = dtOk && whOk && crmOk;
  logger.plain(allOk ? '结论: 已启用的通道全部投递成功。' : '结论: 有通道投递失败，见上面的错误信息。');
  return allOk ? 0 : 1;
}
