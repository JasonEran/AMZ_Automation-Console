import fs from 'node:fs';
import path from 'node:path';
import { bjDateKey } from './time.js';
import { sanitizeForStorage, sanitizeUrl } from './redact.js';
import { STATUS_LABELS } from './verdict.js';

/** Durable, private and sanitised report writers shared by all eight checks. */

const CSV_COLUMNS = [
  ['check', (r) => r.check], ['run_id', (r) => r.runId], ['slot', (r) => r.slot],
  ['checked_at_bj', (r) => r.checkedAt], ['store_key', (r) => r.storeKey],
  ['store_name', (r) => r.storeName], ['market', (r) => r.market],
  ['url', (r) => sanitizeUrl(r.url)], ['status', (r) => r.status],
  ['status_label', (r) => STATUS_LABELS[r.status] || r.status],
  ['is_normal', (r) => (r.ok ? 'Y' : 'N')], ['severity', (r) => r.severity],
  ['confidence', (r) => r.confidence], ['verdict_source', (r) => r.verdictSource],
  ['ahr_score', (r) => r.ahrScore], ['ahr_score_prev', (r) => r.ahrScorePrev],
  ['ahr_delta', (r) => r.ahrDelta], ['status_prev', (r) => r.statusPrev],
  ['status_changed', (r) => (r.statusChanged ? 'Y' : 'N')],
  ['anomaly_reasons', (r) => (r.anomalyReasons || []).join(' | ')],
  ['attempts', (r) => r.attempts], ['duration_ms', (r) => r.durationMs],
  ['screenshot', (r) => r.screenshot], ['raw_text_file', (r) => r.rawTextFile],
  ['error', (r) => r.error],
];

function scalar(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function reportMetrics(metrics) {
  return Object.entries(metrics || {})
    .filter(([key]) => key !== 'observedBusinessItemKeys');
}

function csvCell(value) {
  let text = scalar(value);
  // Prevent spreadsheet formula injection from Amazon-controlled text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(results) {
  const head = CSV_COLUMNS.map(([name]) => name).join(',');
  const rows = results.map((r) => CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(','));
  return `﻿${[head, ...rows].join('\n')}\n`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }
}

function writeAtomic(file, content) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}

function safeRunName(value, fallback) {
  return String(value || fallback || 'run').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180) || 'run';
}

function reportPaths({ outDir, check, summary }) {
  const parsed = new Date(summary.startedAt || Date.now());
  const dir = path.join(outDir, check, bjDateKey(Number.isNaN(parsed.getTime()) ? new Date() : parsed));
  const base = path.join(dir, safeRunName(summary.runId, `${check}-${Date.now()}`));
  return {
    dir,
    files: {
      json: `${base}.json`, csv: `${base}.csv`, detailsCsv: `${base}_items.csv`,
      html: `${base}.html`, latest: path.join(outDir, check, 'latest.json'),
    },
  };
}

function statusColour(result) {
  if (result.severity === 'ERROR') return { bg: '#f4f3ff', fg: '#5925dc' };
  if (result.severity === 'CRITICAL') return { bg: '#fef3f2', fg: '#b42318' };
  if (result.severity === 'WARN') return { bg: '#fffaeb', fg: '#b54708' };
  return { bg: '#ecfdf3', fg: '#067647' };
}

function htmlDocument(summary, { accountHealth = false } = {}) {
  const results = summary.results || [];
  const totals = summary.totals || {};
  const kpis = [
    ['检查记录', totals.total ?? results.length, '#182230'],
    ['正常', totals.ok ?? totals.healthy ?? 0, '#067647'],
    ['业务异常', results.filter((r) => r.severity === 'CRITICAL').length, '#b42318'],
    ['采集失败', totals.errors ?? 0, '#6941c6'],
    ['需复核', totals.warnings ?? 0, '#b54708'],
  ].map(([label, value, colour]) =>
    `<div><b style="color:${colour}">${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
  const rows = results.map((result) => {
    const colour = statusColour(result);
    const metrics = accountHealth
      ? `${result.ahrScore ?? '—'}${result.ahrScoreMax ? ` / ${result.ahrScoreMax}` : ''}`
      : reportMetrics(result.metrics).slice(0, 8).map(([key, value]) => `${key}=${scalar(value)}`).join(' · ') || '—';
    const evidence = [result.verdictSource, result.confidence].filter(Boolean).join(' / ') || '—';
    return `<tr style="background:${colour.bg}"><td>${esc(result.storeKey)}</td><td>${esc(result.storeName || '')}</td>` +
      `<td><b style="color:${colour.fg}">${esc(STATUS_LABELS[result.status] || result.status)}</b></td>` +
      `<td>${esc(metrics)}</td><td>${esc(evidence)}</td>` +
      `<td>${esc((result.anomalyReasons || []).join('；') || result.error || '')}</td>` +
      `<td>${Number(result.durationMs || 0).toLocaleString()} ms</td></tr>`;
  }).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(summary.checkTitle || summary.check)} · ${esc(summary.runId)}</title><style>
body{font:14px/1.55 ui-sans-serif,-apple-system,"PingFang SC","Segoe UI",sans-serif;margin:0;background:#f6f8fb;color:#182230}main{max-width:1280px;margin:auto;padding:28px}h1{font-size:22px;margin:0 0 5px}.meta{color:#667085;margin:0 0 18px}.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0}.kpi div{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:13px}.kpi b{font-size:23px;display:block}.kpi span{color:#667085}.table{overflow:auto;background:#fff;border:1px solid #e4e7ec;border-radius:12px}table{border-collapse:collapse;width:100%;min-width:880px}th,td{border-bottom:1px solid #eaecf0;padding:9px 11px;text-align:left;vertical-align:top}th{background:#f9fafb;color:#475467;font-size:12px}td:nth-child(4),td:nth-child(6){max-width:360px;white-space:normal;overflow-wrap:anywhere}.rule{margin-top:14px;color:#475467}@media(max-width:600px){main{padding:15px}.kpi{grid-template-columns:repeat(2,minmax(0,1fr))}}</style></head><body><main>
<h1>${esc(summary.checkTitle || summary.check)}</h1><p class="meta">${esc(summary.startedAt)} 北京时间 · ${esc(summary.slot)} · ${esc(summary.runId)}</p>
<section class="kpi">${kpis}</section><section class="table"><table><thead><tr><th>店铺</th><th>名称</th><th>状态</th><th>指标</th><th>双路证据</th><th>原因</th><th>耗时</th></tr></thead><tbody>${rows || '<tr><td colspan="7">本批次没有结果</td></tr>'}</tbody></table></section>
<p class="rule">判定规则：${esc(summary.requirement || '无法判定、证据不足及采集失败均不会显示为正常。')}</p></main></body></html>`;
}

export function toHtml(summary) { return htmlDocument(summary, { accountHealth: true }); }
export function toGenericHtml(summary) { return htmlDocument(summary); }

function genericSummaryCsv(summary) {
  const results = summary.results || [];
  const metricKeys = [...new Set(results.flatMap((r) => Object.keys(r.metrics || {})))].sort();
  const head = ['check', 'check_no', 'run_id', 'slot', 'checked_at_bj', 'store_key', 'store_name',
    'market', 'url', 'status', 'is_normal', 'severity', 'confidence', 'verdict_source',
    ...metricKeys.map((key) => `metric_${key}`), 'item_count', 'anomaly_reasons', 'attempts',
    'duration_ms', 'screenshot', 'error'];
  const rows = results.map((r) => [r.check, summary.checkNo, r.runId, r.slot, r.checkedAt,
    r.storeKey, r.storeName, r.market, sanitizeUrl(r.url), r.status, r.ok ? 'Y' : 'N', r.severity,
    r.confidence, r.verdictSource, ...metricKeys.map((key) => r.metrics?.[key]),
    (r.items || []).length, (r.anomalyReasons || []).join(' | '), r.attempts, r.durationMs,
    r.screenshot, r.error].map(csvCell).join(','));
  return `﻿${[head.join(','), ...rows].join('\n')}\n`;
}

export function toDetailsCsv(summary) {
  const records = [];
  for (const result of summary.results || []) {
    const items = Array.isArray(result.items) && result.items.length ? result.items : [{}];
    for (const item of items) records.push({ result, item });
  }
  const metricKeys = [...new Set(records.flatMap(({ result }) => Object.keys(result.metrics || {})))].sort();
  const itemKeys = [...new Set(records.flatMap(({ item }) => Object.keys(item || {})))].sort();
  const head = ['check', 'run_id', 'checked_at_bj', 'store_key', 'store_name', 'market', 'status',
    'severity', ...metricKeys.map((key) => `metric_${key}`), ...itemKeys.map((key) => `item_${key}`)];
  const rows = records.map(({ result, item }) => [result.check, result.runId, result.checkedAt,
    result.storeKey, result.storeName, result.market, result.status, result.severity,
    ...metricKeys.map((key) => result.metrics?.[key]), ...itemKeys.map((key) => item?.[key])]
    .map(csvCell).join(','));
  return `﻿${[head.join(','), ...rows].join('\n')}\n`;
}

function writeAll({ outDir, check, summary, generic }) {
  const { dir, files } = reportPaths({ outDir, check, summary });
  const safe = sanitizeForStorage(summary, { rootDir: outDir });
  writeAtomic(files.json, `${JSON.stringify(safe, null, 2)}\n`);
  writeAtomic(files.csv, generic ? genericSummaryCsv(safe) : toCsv(safe.results || []));
  writeAtomic(files.detailsCsv, toDetailsCsv(safe));
  writeAtomic(files.html, generic ? toGenericHtml(safe) : toHtml(safe));
  writeAtomic(files.latest, `${JSON.stringify(safe, null, 2)}\n`);
  return { dir, files };
}

export function writeReports({ outDir, check, summary }) {
  return writeAll({ outDir, check, summary, generic: false });
}

export function writeGenericReports({ outDir, check, summary }) {
  return writeAll({ outDir, check, summary, generic: true });
}

export function reportDirs({ outDir, check }) {
  const dir = path.join(outDir, check, bjDateKey());
  return { dir, shots: path.join(dir, 'shots'), raw: path.join(dir, 'raw') };
}
