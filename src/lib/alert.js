import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactText, sanitizeForStorage, sanitizeUrl } from './redact.js';
import { bjDateKey, bjHuman } from './time.js';

const SEVERITY_PRESENTATION = {
  OK: {
    conclusion: '运行正常',
    action: '无需处理，请按既定计划继续监测。',
  },
  WARN: {
    conclusion: '需要关注',
    action: '请运营或值班人员复核页面证据，必要时安排人工检查。',
  },
  CRITICAL: {
    conclusion: '业务异常',
    action: '请业务负责人尽快核对并处理；巡检系统不会修改亚马逊侧状态。',
  },
  ERROR: {
    conclusion: '采集故障',
    action: '请技术值班人员排查登录、会话、网络或页面结构；当前结果不可判定为正常。',
  },
};

function presentationOf(severity) {
  return SEVERITY_PRESENTATION[severity] || {
    conclusion: '状态未知',
    action: '请技术值班人员复核，本次结果不可判定为正常。',
  };
}

export function partitionAlertProblems(problems = []) {
  const candidates = problems.filter((problem) => problem?.severity !== 'OK');
  const bucketOf = (problem) => ['CRITICAL', 'WARN'].includes(problem?.severity)
    ? problem.severity : 'ERROR';
  const order = ['ERROR', 'CRITICAL', 'WARN'];
  return order.map((severity) => ({
    severity,
    problems: candidates.filter((problem) => bucketOf(problem) === severity),
  })).filter((group) => group.problems.length > 0);
}

function dingtalkMessage({ alert, lines, at, entry, keyword }) {
  const presentation = presentationOf(alert.severity);
  const details = lines.filter((line) => !entry || !String(line).includes(entry));
  const markdown = [
    '### 亚马逊店铺巡检通知',
    '',
    `**结论**：${presentation.conclusion}`,
    '',
    `**检查项**：${alert.title}`,
    '',
    `**处置建议**：${presentation.action}`,
  ];
  if (keyword) markdown.push('', `**值守主题**：${keyword}`);
  if (details.length) {
    markdown.push('', '#### 结果明细', '', ...details.map((line) => `- ${line}`));
  }
  markdown.push('', '---', '', `**发生时间**：${at}（北京时间）`);
  if (entry) markdown.push('', `**运营看板**：[打开巡检控制台](${entry})`);
  const title = keyword
    ? `【${presentation.conclusion}】${keyword} ${alert.title}`
    : `【${presentation.conclusion}】${alert.title}`;
  return { title, text: markdown.join('\n') };
}

function signDingtalk(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now();
  const sign = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
  return `${webhook}${webhook.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

async function postJson(url, body, { headers = {}, method = 'POST', timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0,
      errorClass: error.name || 'Error',
      error: error.name === 'AbortError'
        ? `timeout ${timeoutMs}ms`
        : redactText(String(error.message || error)).slice(0, 180) };
  } finally {
    clearTimeout(timer);
  }
}

function isSecureEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** DingTalk credentials are destination-bound: never send them, or alert
 * business data, to an arbitrary HTTPS endpoint that merely looks valid. */
export function isOfficialDingTalkWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'oapi.dingtalk.com'
      && !url.port
      && !url.username
      && !url.password
      && !url.hash
      && url.pathname === '/robot/send';
  } catch {
    return false;
  }
}

const COLLECTION_FAILURE_STATUSES = new Set([
  'ERROR', 'PARTIAL_EVIDENCE', 'LOGIN_REQUIRED', 'BLOCKED', 'UNKNOWN',
  'NOT_CONFIGURED', 'DETAIL_ERROR', 'REVIEW_OWNERSHIP_UNKNOWN', 'UNKNOWN_RATING',
]);

export function defaultDingTalkSeverities(channel) {
  if (channel?.name === 'operations') return ['ERROR', 'WARN'];
  if (channel?.name === 'business') return ['CRITICAL', 'WARN'];
  return ['OK', 'CRITICAL'];
}

function alertStatuses(alert) {
  const stored = Array.isArray(alert?.data?.stores) ? alert.data.stores : [];
  const fromData = stored.map((item) => String(item?.status || '')).filter(Boolean);
  if (fromData.length) return fromData;
  return (alert?.lines || []).flatMap((line) => {
    const match = /→\s*([A-Z][A-Z0-9_]*)/.exec(String(line));
    return match ? [match[1]] : [];
  });
}

/** Collection failures stay off the business robot even if a caller labels
 * them WARN. */
export function isCollectionFailureAlert(alert) {
  if (alert?.severity === 'ERROR') return true;
  const statuses = alertStatuses(alert);
  return statuses.length > 0 && statuses.every((status) => COLLECTION_FAILURE_STATUSES.has(status));
}

const BUSINESS_ROBOT_CHECKS = new Set(['ads-status', 'performance']);

export function businessRobotKeyword(check) {
  if (check === 'ads-status') return '广告值守';
  if (check === 'performance') return 'ASIN';
  return '';
}

function channelMatches(channel, alert) {
  if (!channel?.enabled || !channel.webhook) return false;
  const levels = channel.severities || defaultDingTalkSeverities(channel);
  if (!levels.includes(alert?.severity)) return false;
  if (channel.name === 'business') {
    if (!BUSINESS_ROBOT_CHECKS.has(alert?.check)) return false;
    if (isCollectionFailureAlert(alert)) return false;
  }
  return true;
}

function channelsOf(config, alert) {
  const legacy = config.alert?.dingtalk || {};
  const configured = Array.isArray(legacy.channels) ? legacy.channels : [];
  if (!configured.length) return legacy.enabled && legacy.webhook ? [{ name: 'default', ...legacy }] : [];
  return configured.filter((channel) => channelMatches(channel, alert));
}

export function hasConfiguredDingTalk(config) {
  const dingtalk = config.alert?.dingtalk || {};
  const channels = Array.isArray(dingtalk.channels) ? dingtalk.channels : [];
  return channels.length
    ? channels.some((channel) => channel?.enabled && channel.webhook)
    : Boolean(dingtalk.enabled && dingtalk.webhook);
}

function dashboardUrl(config) {
  const value = config.dashboard?.publicUrl || process.env.DASHBOARD_PUBLIC_URL || '';
  if (!/^https:\/\//i.test(value)) return '';
  const safe = sanitizeUrl(value);
  return /^https:\/\//i.test(safe || '') ? String(safe).replace(/\/+$/, '') : '';
}

function privateAppend(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* non-POSIX */ }
  const safe = sanitizeForStorage(record, { rootDir: path.dirname(path.dirname(file)) });
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}

export function createAlerter({ config, logger, outDir }) {
  const cfg = config.alert || {};
  const fileSink = path.join(outDir, 'alerts', `${bjDateKey()}.jsonl`);
  const sent = [];

  async function send(alert) {
    const safeAlert = sanitizeForStorage(alert, { rootDir: outDir });
    const entry = dashboardUrl(config);
    const lines = [...(safeAlert.lines || [])];
    if (entry && !lines.some((line) => String(line).includes(entry))) lines.push(`看板入口：${entry}`);
    // The exact sanitized message sent to external channels is also the one
    // retained locally, so channel audits are complete and reproducible.
    const record = { at: bjHuman(), ...safeAlert, lines, delivery: {} };

    if (cfg.console !== false) {
      const fn = safeAlert.severity === 'OK' ? logger.info : safeAlert.severity === 'WARN' ? logger.warn : logger.error;
      fn(`[${presentationOf(safeAlert.severity).conclusion}] ${safeAlert.title}`);
      for (const line of lines) fn(`    ${line}`);
    }

    for (const channel of channelsOf(config, safeAlert)) {
      const key = `dingtalk:${channel.name || 'default'}`;
      if (!isOfficialDingTalkWebhook(channel.webhook)) {
        record.delivery[key] = {
          status: 0, errorClass: 'ConfigurationError', reason: '仅允许官方钉钉 HTTPS 机器人地址',
        };
        logger.error(`钉钉通道 ${channel.name || 'default'} 不是官方机器人地址，已拒绝发送`);
        continue;
      }
      const keyword = channel.name === 'business' ? businessRobotKeyword(safeAlert.check) : '';
      const markdown = dingtalkMessage({ alert: safeAlert, lines, at: record.at, entry, keyword });
      const response = await postJson(signDingtalk(channel.webhook, channel.secret), {
        msgtype: 'markdown', markdown,
        at: { atMobiles: channel.atMobiles || [], isAtAll: Boolean(channel.atAll) },
      }, { timeoutMs: Number(channel.timeoutMs || 20000) });
      let errcode = null;
      try { errcode = JSON.parse(response.text || '{}').errcode ?? null; } catch { /* malformed response */ }
      const ok = response.ok && (errcode === null || errcode === 0);
      record.delivery[key] = ok ? 'ok' : {
        status: response.status, errorClass: response.errorClass || null,
        reason: errcode !== null ? `errcode:${errcode}` : (response.error || 'request-failed'),
      };
      if (!ok) logger.error(`钉钉通道 ${channel.name || 'default'} 推送失败 (HTTP ${response.status || 0})`);
    }

    const webhook = cfg.webhook || {};
    if (webhook.enabled && webhook.url) {
      if (!isSecureEndpoint(webhook.url)) {
        record.delivery.webhook = {
          status: 0, errorClass: 'ConfigurationError', reason: 'Webhook 地址必须使用 HTTPS（本机回环测试除外）',
          endpoint: sanitizeUrl(webhook.url),
        };
        logger.error('Webhook 配置不安全，已拒绝发送');
      } else {
        const response = await postJson(webhook.url, record, {
          headers: webhook.headers, method: webhook.method || 'POST', timeoutMs: Number(webhook.timeoutMs || 20000),
        });
        record.delivery.webhook = response.ok ? 'ok' : {
          status: response.status, errorClass: response.errorClass || null,
          reason: response.error || 'request-failed', endpoint: sanitizeUrl(webhook.url),
        };
        if (!response.ok) logger.error(`Webhook 推送失败 (HTTP ${response.status || 0})`);
      }
    }

    if (cfg.file !== false) {
      try {
        record.delivery.file = 'ok';
        privateAppend(fileSink, record);
      } catch (error) {
        record.delivery.file = { reason: redactText(String(error.message || error)).slice(0, 180) };
      }
    }
    sent.push(record);
    return record;
  }

  return { send, sent, fileSink };
}
