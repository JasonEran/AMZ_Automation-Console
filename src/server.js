#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hasConfiguredDingTalk } from './lib/alert.js';
import { validateAdsNameContains, writeAdsRules } from './lib/ads-rules.js';
import { readAdsMonitoring } from './lib/ads-monitoring.js';
import { CHECKS, SLOTS } from './checks/registry.js';
import { reviewsByDate } from './checks/definitions.js';
import { isReviewResult, reviewDateSummary, reviewEvidencePages, latestReviewEvidence } from './lib/review-evidence.js';
import { filterCurrentAsinResults, loadAsins } from './checks/asin-health.js';
import { loadConfig } from './lib/config.js';
import { configuredHint } from './lib/configured-hints.js';
import { loadZiniaoCredentials } from './lib/credentials.js';
import { latestEffectiveCheck, latestStoreSnapshots, readCheckHistory, storeHistoryDays, validHistoryDate, historyRecordsPage } from './lib/dashboard-history.js';
import { ACTION_LABEL, ACTION_OWNER, actionStateFor, rawStateLabel, worstAction } from './lib/dashboard-status.js';
import {
  buildMonitoringRecommendations, buildOperationalViews, evidenceCompleteness, operationalViewCatalog,
} from './lib/dashboard-views.js';
import { sanitizeForStorage, sanitizeUrl } from './lib/redact.js';
import { readRuntimeProgress } from './lib/run-progress.js';
import { buildSessionHealth } from './lib/session-health.js';
import { createUserStore } from './lib/users.js';
import {
  PRODUCT_UPLOAD_ALLOWED_EXTENSIONS,
  PRODUCT_UPLOAD_MAX_BYTES,
  confirmProductUpload,
  inspectProductUploadFile,
  productUploadEnabled,
  productUploadJobInventory,
  publicProductUploadJob,
  readProductUploadJob,
  stageProductUpload,
  summarizeProductUploadJobs,
} from './lib/product-upload.js';
import { bjHuman, bjIso, bjParts, detectSlot, parseHHMM } from './lib/time.js';
import { DASHBOARD_HTML } from './web/dashboard.js';
import { intelligenceRequest } from './intelligence/http.js';

const INTELLIGENCE_ASSETS = new Map([
  ['/assets/intelligence.css', ['intelligence.css', 'text/css; charset=utf-8']],
  ['/assets/intelligence-client.js', ['intelligence-client.js', 'text/javascript; charset=utf-8']],
]);

process.umask(0o077);

/**
 * Dashboard + ingest API. Zero dependencies so it deploys by copying files.
 *
 * Routes:
 *   GET  /                     the dashboard page
 *   GET  /api/status           all 8 checks, rolled up
 *   GET  /api/check/:id        one check's latest full report
 *   POST /api/ingest           accept a report from a collector machine
 *   GET  /api/health           liveness
 *   GET  /shot?f=<path>        serve a screenshot from out/ (path-guarded)
 */

const { config, stores, storesPath } = loadConfig();
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const INGEST_TOKEN = process.env.AMZGUARD_INGEST_TOKEN || process.env.INGEST_TOKEN || '';
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DASHBOARD_SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || '';
const userStore = createUserStore({
  outDir: config.outDir,
  bootstrapUsername: DASHBOARD_USERNAME,
  bootstrapPassword: DASHBOARD_PASSWORD,
});
const AUTH_ENABLED = userStore.enabled();
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const CHECK_IDS = new Set(CHECKS.map((check) => check.id));
const MAX_INGEST_BYTES = 8 * 1024 * 1024;
const PRODUCT_UPLOAD_ENABLED = productUploadEnabled();
const staleHours = Number(process.env.REPORT_STALE_HOURS || 36);
const STALE_AFTER_MS = (Number.isFinite(staleHours) ? Math.max(1, staleHours) : 36) * 60 * 60 * 1000;
const SESSION_MAX_AGE_S = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map();
const uploadStageAttempts = new Map();
const activeUploadStageIps = new Set();
let activeUploadStages = 0;
const UPLOAD_STAGE_WINDOW_MS = 10 * 60 * 1000;
const UPLOAD_STAGE_MAX_ATTEMPTS = 5;
const UPLOAD_PENDING_GLOBAL_MAX = 20;
const UPLOAD_PENDING_STORE_MAX = 3;
const UPLOAD_MIN_FREE_BYTES = 512 * 1024 * 1024;

function isLoopbackAddress(value) {
  const normalized = String(value || '').replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

const EXTERNAL_MODE = process.env.NODE_ENV === 'production' || !isLoopbackAddress(HOST);

if (EXTERNAL_MODE && !AUTH_ENABLED) {
  throw new Error('非本机监听或生产环境必须存在至少一个 Dashboard 用户');
}
if (AUTH_ENABLED && DASHBOARD_SESSION_SECRET.length < 32) {
  throw new Error('启用 Dashboard 用户认证时，DASHBOARD_SESSION_SECRET 必须至少 32 个字符');
}
if (EXTERNAL_MODE && INGEST_TOKEN.length < 32) {
  throw new Error('非本机监听或生产环境必须设置至少 32 个字符的 INGEST_TOKEN');
}
if (PRODUCT_UPLOAD_ENABLED && !AUTH_ENABLED) {
  throw new Error('商品批量上传启用时必须开启 Dashboard 登录保护');
}
if (
  PRODUCT_UPLOAD_ENABLED
  && (() => {
    const user = userStore.get(String(process.env.AMZGUARD_PRODUCT_UPLOAD_ADMIN_USERNAME || '').trim());
    return !user || !user.enabled || user.role !== 'admin';
  })()
) {
  throw new Error('商品批量上传启用时，AMZGUARD_PRODUCT_UPLOAD_ADMIN_USERNAME 必须精确匹配已启用的 Dashboard 管理员');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const SECRET_KEY = /(?:password|passwd|secret|token|authorization|cookie|browseroauth|openid|otp|verification.?code|session)/i;
const INTERNAL_KEY = /^(?:storeId|rawTextFile|file|path|reportFile|htmlFile|csvFile)$/i;

/** Sanitise untrusted report content before it reaches storage or the browser. */
function safeData(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const urlValue = /^https?:\/\//i.test(value) ? sanitizeUrl(value) : null;
    if (urlValue) return urlValue;
    return value
      .replace(/https?:\/\/[^\s<>"']+/gi, (match) => sanitizeUrl(match) || '[redacted URL]')
      .replace(/(?:\/Users|\/home|\/opt|\/var|\/tmp|\/private)(?:\/[^\s<>"']+)+/g, '[internal path]')
      .slice(0, 4_000);
  }
  if (depth >= 6 || typeof value !== 'object') return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 250).map((item) => safeData(item, depth + 1, seen));
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 250)) {
    if (SECRET_KEY.test(key) || INTERNAL_KEY.test(key)) continue;
    result[key] = safeData(child, depth + 1, seen);
  }
  return result;
}

function trustedProxy(req) {
  return TRUST_PROXY && isLoopbackAddress(req.socket.remoteAddress);
}

function applySecurityHeaders(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').flatMap((part) => {
    const i = part.indexOf('=');
    if (i < 0) return [];
    try { return [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]]; }
    catch { return []; }
  }));
}

function rolesForUser(user) {
  const roles = [user.role === 'admin' ? 'dashboard-admin' : 'dashboard-operator'];
  if (productUploadAuthorizedUser(user.username)) roles.push('product-upload-admin');
  return roles;
}

function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({
    version: 3,
    sid: crypto.randomUUID(),
    username: user.username,
    credentialVersion: user.credentialVersion,
    roles: rolesForUser(user),
    issuedAt: Date.now(),
    expiresAt: Date.now() + SESSION_MAX_AGE_S * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', DASHBOARD_SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validSession(req) {
  if (!AUTH_ENABLED) return true;
  const token = parseCookies(req).amzguard_session || '';
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', DASHBOARD_SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const user = userStore.get(parsed.username);
    return parsed.version === 3
      && typeof parsed.sid === 'string' && parsed.sid.length >= 32
      && user?.enabled === true
      && Number(parsed.credentialVersion) === Number(user.credentialVersion)
      && Array.isArray(parsed.roles)
      && (parsed.roles.includes('dashboard-admin') || parsed.roles.includes('dashboard-operator'))
      && Number(parsed.issuedAt) <= Date.now() + 60_000
      && Number(parsed.expiresAt) > Date.now();
  } catch { return false; }
}

function sessionClaims(req) {
  if (!validSession(req)) return null;
  const token = sessionToken(req);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return AUTH_ENABLED ? null : { username: 'local', roles: ['dashboard-admin'] };
  try { return JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')); }
  catch { return null; }
}

function validProductUploadRole(req) {
  return sessionClaims(req)?.roles?.includes('product-upload-admin') === true;
}

function validAdminRole(req) {
  return sessionClaims(req)?.roles?.includes('dashboard-admin') === true;
}

function sessionToken(req) {
  return parseCookies(req).amzguard_session || '';
}

function csrfToken(req) {
  const token = sessionToken(req);
  if (!token || !DASHBOARD_SESSION_SECRET) return '';
  return crypto.createHmac('sha256', DASHBOARD_SESSION_SECRET).update(`csrf:${token}`).digest('base64url');
}

function validCsrf(req) {
  const given = typeof req.headers['x-amzguard-csrf'] === 'string' ? req.headers['x-amzguard-csrf'] : '';
  return Boolean(given) && safeEqual(given, csrfToken(req));
}

function sameOriginMutation(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin') return false;
  const origin = String(req.headers.origin || '');
  if (!origin) return fetchSite === 'same-origin';
  try {
    const parsed = new URL(origin);
    const expectedProtocol = isSecureRequest(req) ? 'https:' : 'http:';
    return parsed.protocol === expectedProtocol && parsed.host === String(req.headers.host || '');
  } catch { return false; }
}

function requireProtectedMutation(req, res) {
  if (!sameOriginMutation(req)) {
    json(res, 403, { ok: false, error: 'same-origin request required' });
    return false;
  }
  if (!validCsrf(req)) {
    json(res, 403, { ok: false, error: 'csrf validation failed' });
    return false;
  }
  return true;
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted)
    || (trustedProxy(req) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

function sessionCookie(req, value, maxAge = SESSION_MAX_AGE_S) {
  return [
    `amzguard_session=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    isSecureRequest(req) ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function clientIp(req) {
  if (trustedProxy(req)) return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  return String(req.socket.remoteAddress || 'unknown');
}

function failureState(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (loginFailures.get(ip) || []).filter((at) => now - at < LOGIN_WINDOW_MS);
  loginFailures.set(ip, recent);
  return { ip, recent, blocked: recent.length >= LOGIN_MAX_FAILURES };
}

function recordFailure(req) {
  const state = failureState(req);
  state.recent.push(Date.now());
  loginFailures.set(state.ip, state.recent);
}

setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [ip, failures] of loginFailures) {
    const recent = failures.filter((at) => at >= cutoff);
    if (recent.length) loginFailures.set(ip, recent);
    else loginFailures.delete(ip);
  }
  const uploadCutoff = Date.now() - UPLOAD_STAGE_WINDOW_MS;
  for (const [ip, attempts] of uploadStageAttempts) {
    const recent = attempts.filter((at) => at >= uploadCutoff);
    if (recent.length) uploadStageAttempts.set(ip, recent);
    else uploadStageAttempts.delete(ip);
  }
}, LOGIN_WINDOW_MS).unref();

function loginHtml(error = '') {
  const message = error ? `<div class="error" role="alert">${error}</div>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>登录 · 店铺自动化工作台</title><style>
  :root{--ink:#14201c;--muted:#68756f;--line:#dfe5e0;--side:#14221d;--accent:#c9f36a;--bad:#b43d38}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f2f4f1;color:var(--ink);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:grid;place-items:center;padding:22px}.shell{width:min(920px,100%);min-height:540px;background:#fff;border:1px solid var(--line);border-radius:22px;overflow:hidden;display:grid;grid-template-columns:1.05fr .95fr;box-shadow:0 24px 70px rgba(20,34,29,.12)}.intro{background:var(--side);color:#fff;padding:48px;position:relative;overflow:hidden;display:flex;flex-direction:column}.intro:after{content:"";position:absolute;width:310px;height:310px;border-radius:50%;border:1px solid #40564c;right:-120px;bottom:-120px;box-shadow:0 0 0 50px #1a2d25,0 0 0 51px #344a40}.brand{display:flex;align-items:center;gap:12px;position:relative;z-index:1}.mark{width:40px;height:40px;border-radius:12px;background:var(--accent);color:#193014;display:grid;place-items:center;font-weight:900;font-size:12px}.brand b{display:block}.brand small{color:#91a39b}.introcopy{margin:auto 0;position:relative;z-index:1}.eyebrow{color:var(--accent);font-size:11px;font-weight:750;letter-spacing:1.6px;text-transform:uppercase}.intro h1{font-size:32px;line-height:1.2;margin:12px 0 13px;letter-spacing:-.7px}.intro p{color:#abb9b3;max-width:340px;margin:0}.security{position:relative;z-index:1;color:#93a59d;font-size:11px}.formside{padding:58px 54px;display:flex;flex-direction:column;justify-content:center}.formside h2{font-size:22px;margin:0 0 6px}.formside>p{color:var(--muted);margin:0 0 28px}.field{margin-bottom:17px}.field label{display:block;font-size:12px;font-weight:650;margin-bottom:7px}.field input{width:100%;height:44px;border:1px solid var(--line);border-radius:10px;padding:0 13px;outline:none;background:#fafbf9;color:var(--ink)}.field input:focus{border-color:#71867b;box-shadow:0 0 0 3px rgba(35,135,90,.1);background:#fff}.submit{width:100%;height:45px;border:0;border-radius:10px;background:var(--side);color:#fff;font-weight:700;cursor:pointer;margin-top:5px}.submit:hover{background:#21372e}.error{color:var(--bad);background:#fce9e7;border:1px solid #f0c6c2;padding:10px 12px;border-radius:9px;font-size:12px;margin-bottom:17px}.note{text-align:center;color:var(--muted);font-size:11px;margin-top:18px}@media(max-width:700px){.shell{display:block;min-height:0}.intro{padding:28px}.introcopy{margin:44px 0}.intro h1{font-size:25px}.security{display:none}.formside{padding:36px 28px 42px}}
  </style></head><body><main class="shell"><section class="intro"><div class="brand"><span class="mark">AMZ</span><span><b>店铺巡检</b><small>Automation Console</small></span></div><div class="introcopy"><div class="eyebrow">24 / 7 Operations</div><h1>所有店铺状态，<br>集中在一个工作台。</h1><p>九项自动化巡检、异常证据和执行进度统一汇总。</p></div><div class="security">受 HTTPS 与服务端会话保护</div></section><section class="formside"><h2>登录工作台</h2><p>请输入管理员账号继续</p>${message}<form method="post" action="/login" autocomplete="on"><div class="field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required autofocus></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><button class="submit" type="submit">安全登录</button></form><div class="note">连续登录失败将被暂时限制</div></section></main></body></html>`;
}

function html(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function disabledStoreKeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(storesPath, 'utf8'));
    const entries = Array.isArray(raw) ? raw : raw.stores || [];
    return new Set(entries.filter((store) => store?.enabled === false).flatMap((store) =>
      [store.key, store.name, store.id].filter(Boolean),
    ));
  } catch { return new Set(); }
}

const disabledStores = disabledStoreKeys();

function readLatest(checkId) {
  if (!CHECK_IDS.has(checkId)) return null;
  return readCheckHistory({ outDir: config.outDir, checkId, staleAfterMs: STALE_AFTER_MS }).at(-1) || null;
}

/** Roll one check's latest report into the shape the dashboard renders. */
function rollup(def) {
  const latestEntry = readLatest(def.id);
  const latest = latestEntry?.report;
  if (!latest) {
    return {
      ...def,
      state: 'NEVER_RUN',
      stateLabel: '尚未运行',
      lastRunAt: null,
      totals: null,
      problems: [],
      runId: null,
      stale: false,
    };
  }
  if (latest.skipped) {
    return {
      ...def,
      state: 'SKIPPED',
      stateLabel: '已跳过',
      lastRunAt: latest.finishedAt,
      slot: latest.slot,
      totals: latest.totals,
      problems: [],
      skipReason: latest.skipReason || null,
      runId: latest.runId,
      stale: Boolean(latestEntry.stale),
    };
  }

  const results = latest.results || [];
  const notConfigured = results.filter((r) => r.status === 'NOT_CONFIGURED').length;
  const problems = results
    .filter((r) => r.severity && r.severity !== 'OK')
    .map((r) => ({
      subject: r.asin || r.storeKey,
      market: r.market || null,
      status: r.status,
      severity: r.severity,
      confidence: r.confidence,
      reasons: r.anomalyReasons || [],
      metrics: r.metrics || {},
      screenshot: r.screenshot || null,
    }));

  let state = 'OK';
  if (notConfigured && notConfigured === results.length) state = 'NOT_CONFIGURED';
  else if (problems.some((p) => p.severity === 'ERROR')) state = 'ERROR';
  else if (problems.some((p) => p.severity === 'CRITICAL')) state = 'CRITICAL';
  else if (problems.length) state = 'WARN';

  const LABEL = {
    OK: '正常', WARN: '需关注', CRITICAL: '异常', ERROR: '采集失败', NOT_CONFIGURED: '待配置紫鸟',
  };

  return {
    ...def,
    state,
    stateLabel: LABEL[state],
    lastRunAt: latest.finishedAt || latest.startedAt,
    slot: latest.slot,
    runId: latest.runId,
    durationMs: latest.durationMs,
    totals: latest.totals,
    problems,
    source: latest._ingestedAt ? 'ingested' : 'local',
    stale: Boolean(latestEntry.stale),
  };
}

const STATE_LABEL = {
  OK: '正常',
  WARN: '业务关注',
  CRITICAL: '业务异常',
  ERROR: '采集异常',
  NOT_CONFIGURED: '配置缺失',
  NOT_COVERED: '本批未覆盖',
  NEVER_RUN: '尚未运行',
  SKIPPED: '已跳过',
};

const STATE_RANK = {
  ERROR: 7,
  CRITICAL: 6,
  WARN: 5,
  NOT_CONFIGURED: 4,
  NOT_COVERED: 3,
  NEVER_RUN: 2,
  SKIPPED: 1,
  OK: 0,
};

function worstState(states) {
  if (!states?.length) return 'NEVER_RUN';
  return (states || []).reduce(
    (worst, state) => (STATE_RANK[state] ?? STATE_RANK.ERROR) > (STATE_RANK[worst] ?? -1) ? state : worst,
    'OK',
  );
}

function resultState(result) {
  if (result?.status === 'NOT_CONFIGURED') return 'NOT_CONFIGURED';
  // Older collectors archived a stable performance violation as OK after its
  // first alert. Keep those reports red until a fresh complete page proves
  // that Amazon has actually cleared the violation.
  if (result?.status === 'RECORDED_PERFORMANCE_EVENT') return 'CRITICAL';
  if (['ERROR', 'CRITICAL', 'WARN', 'OK'].includes(result?.severity)) return result.severity;
  // A result whose severity cannot be understood is a collection failure, never a pass.
  return 'ERROR';
}

function shotUrl(file) {
  if (!file) return null;
  const base = path.resolve(config.outDir);
  const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(base, file);
  if (!absolute.startsWith(`${base}${path.sep}`)) return null;
  let real;
  try {
    if (!fs.statSync(absolute).isFile()) return null;
    real = fs.realpathSync(absolute);
  } catch { return null; }
  if (!real.startsWith(`${fs.realpathSync(base)}${path.sep}`)) return null;
  if (!/\.(?:png|jpe?g|webp)$/i.test(real)) return null;
  return `/shot?f=${encodeURIComponent(path.relative(base, absolute))}`;
}

function evidencePart(value) {
  if (!value || typeof value !== 'object') return { available: false };
  const allowed = [
    'status', 'confidence', 'reliable', 'pageConfirmed', 'cardFound', 'rowCount', 'total',
    'lowCount', 'enabled', 'paused', 'rating', 'score', 'source', 'stateSource', 'looksLikeLogin',
  ];
  const part = { available: true };
  for (const key of allowed) if (value[key] !== undefined) part[key] = safeData(value[key]);
  if (Array.isArray(value.notes)) part.notes = safeData(value.notes.slice(0, 8));
  if (value.url) part.url = sanitizeUrl(value.url);
  return part;
}

function publicItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return safeData(value);
  const hidden = new Set([
    'itemKey', 'legacyItemKey', 'previousItemKeys', 'context', 'raw', 'detailDiagnostics', 'actionHref', 'rawTextFile',
  ]);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (hidden.has(key)) continue;
    if (key === 'detailScreenshot') {
      const url = shotUrl(child);
      if (url) out.detailEvidence = { url };
      continue;
    }
    if (key === 'records' && Array.isArray(child)) {
      out.records = child.slice(0, 200).map(publicItem);
      continue;
    }
    out[key] = safeData(child);
  }
  return out;
}

function publicResult(result, storeFallback = '') {
  // Internal event keys are durable state used to prevent duplicate business
  // alerts. They are useful in private JSON reports, but add no operator value
  // and can make the detail drawer unreadable when a page contains many rows.
  const publicMetrics = { ...(result.metrics || {}) };
  delete publicMetrics.observedBusinessItemKeys;
  const reviewPages=reviewEvidencePages(result).map(page=>{
    const raw=shotUrl(page.screenshot),rel=raw?new URL(raw,'http://localhost').searchParams.get('f'):null;
    return {page:page.page,pages:page.pages,reviewIds:page.reviewIds||[],newestDate:page.newestDate,
      oldestDate:page.oldestDate,capturedAt:page.capturedAt,legacy:page.legacy,
      screenshot:rel?`/evidence?f=${encodeURIComponent(rel)}`:null,
      evidenceId:rel?crypto.createHash('sha256').update(rel).digest('hex').slice(0,12):null};
  });
  const selectedPage=latestReviewEvidence(result,reviewPages);
  const rawScreenshot = shotUrl(result.screenshot);
  const screenshotRel = rawScreenshot
    ? new URL(rawScreenshot, 'http://localhost').searchParams.get('f') : null;
  const screenshot = screenshotRel ? `/evidence?f=${encodeURIComponent(screenshotRel)}` : null;
  const evidenceId = screenshotRel
    ? crypto.createHash('sha256').update(screenshotRel).digest('hex').slice(0, 12) : null;
  return {
    subject: result.asin || result.storeName || result.storeKey || storeFallback,
    asin: result.asin || null,
    storeKey: result.storeKey || storeFallback || null,
    storeName: result.storeName || result.storeKey || storeFallback || null,
    market: result.market || null,
    status: result.status || 'UNKNOWN',
    severity: resultState(result),
    confidence: result.confidence || null,
    verdictSource: result.verdictSource || null,
    reasons: safeData(result.anomalyReasons || []),
    notes: safeData((result.notes || []).slice(0, 12)),
    metrics: safeData(publicMetrics),
    items: (isReviewResult(result)?reviewsByDate(result.items||[]):result.items||[]).slice(0, 500).map(publicItem),
    reviewDates: isReviewResult(result)?reviewDateSummary(result.items||[]):null,
    reviewScreenshots: reviewPages,
    checkedAt: result.checkedAt || null,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
    screenshot: selectedPage?selectedPage.screenshot:screenshot,
    screenshotMeta: (selectedPage?selectedPage.screenshot:screenshot) ? {
      storeKey: result.storeKey || storeFallback || null,
      capturedAt: selectedPage?.capturedAt || result.checkedAt || null,
      evidenceId: selectedPage?.evidenceId || evidenceId,
      page: selectedPage?.page || null,pages:selectedPage?.pages||null,legacy:!!selectedPage?.legacy,
    } : null,
    evidence: {
      dom: evidencePart(result.evidence?.dom),
      text: evidencePart(result.evidence?.text),
    },
  };
}

function evidenceContext(rel) {
  const normalized = String(rel || '').split(path.sep).join('/');
  for (const def of CHECKS) {
    const history = readCheckHistory({ outDir: config.outDir, checkId: def.id });
    for (const entry of history.reverse()) {
      for (const result of entry.report.results || []) {
        const storeKey=result.storeKey||result.storeName;
        const pages=reviewEvidencePages(result);
        const matches=value=>{
          const resultRel=path.isAbsolute(String(value||''))?path.relative(config.outDir,value):String(value||'');
          return resultRel.split(path.sep).join('/')===normalized;
        };
        const page=pages.find(page=>matches(page.screenshot));
        if (!page && !matches(result.screenshot)) continue;
        const brands = [...new Set([
          ...(result.items || []).map((item) => item?.brand),
          ...(result.evidence?.dom?.lowReviews || []).map((item) => item?.brand),
        ].filter(Boolean))];
        return {
          storeKey,
          storeName: result.storeName || storeKey,
          checkTitle: def.title,
          checkedAt: result.checkedAt || entry.report.finishedAt || null,
          brands,
          review: def.id==='reviews',page:page||null,pages,
        };
      }
    }
  }
  return null;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function evidenceTime(value) {
  const date=new Date(value||'');
  return Number.isFinite(date.getTime())?bjHuman(date)+' 北京时间':'时间未记录';
}

function serveEvidenceViewer(res, rel) {
  if (!shotUrl(rel)) return json(res, 404, { ok: false, error: 'evidence not found' });
  const context = evidenceContext(rel);
  if (!context) return json(res, 404, { ok: false, error: 'evidence is not bound to a stored result' });
  const evidenceId = crypto.createHash('sha256').update(rel).digest('hex').slice(0, 12);
  const brandText = context.brands.length ? context.brands.join('、') : '非品牌维度';
  const page=context.page;
  const pageNotice=context.review?`<div class="notice"><b>${page?`第 ${page.page} / ${page.pages} 页原始截图`:'评论原始截图（页码未记录）'}</b> · 采集时间：${escapeHtml(evidenceTime(page?.capturedAt||context.checkedAt))}<br>评价发表日期${page?.newestDate?`：${escapeHtml(page.oldestDate)} 至 ${escapeHtml(page.newestDate)}`:'：以原始评论为准'}。采集时间与评价发表日期含义不同。${page?.legacy?'<br><b>这份旧报告只保存了最后一页截图，不能用它代表最新差评；最新评价请查看结构化明细。</b>':''}</div>`:'';
  const pageLinks=context.pages.filter(p=>p.screenshot&&shotUrl(p.screenshot)).map(p=>{
    const relative=new URL(shotUrl(p.screenshot),'http://localhost').searchParams.get('f');
    return `<a href="/evidence?f=${encodeURIComponent(relative)}" ${p.page===page?.page?'aria-current="page"':''}>第 ${p.page} / ${p.pages} 页${p.newestDate?' · '+escapeHtml(p.newestDate):''}</a>`;
  }).join('　');
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(context.storeKey)} · 原始采集证据</title><style>
  *{box-sizing:border-box}body{margin:0;background:#eef1ee;color:#14201c;font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.bar{position:sticky;top:0;z-index:2;background:#14221d;color:#fff;padding:14px 20px;box-shadow:0 3px 18px rgba(0,0,0,.18)}.top{max-width:1200px;margin:auto;display:flex;align-items:center;gap:16px}.mark{background:#c9f36a;color:#193014;border-radius:8px;padding:7px 10px;font-weight:850}.identity{min-width:0}.identity b{display:block;font-size:16px}.identity small{color:#aebcb6}.meta{margin-left:auto;text-align:right;font-size:11px;color:#c9d3cf}.notice{max-width:1200px;margin:14px auto 10px;padding:11px 14px;background:#fff8df;border:1px solid #ead89b;border-radius:9px;color:#5b4c16}.notice b{color:#2e3b35}.canvas{max-width:1200px;margin:0 auto 28px;background:#fff;border:1px solid #dfe5e0;border-radius:10px;overflow:auto;box-shadow:0 12px 35px rgba(20,34,29,.08)}.canvas img{display:block;width:100%;height:auto}.actions{max-width:1200px;margin:0 auto 10px;text-align:right}.actions a{color:#276a4d;text-decoration:none;font-weight:700;font-size:12px}@media(max-width:650px){.bar{padding:11px}.top{align-items:flex-start}.meta{font-size:9px}.notice,.canvas,.actions{border-radius:0;margin-left:0;margin-right:0}.notice{margin-top:8px}.identity b{font-size:14px}}
  </style></head><body><header class="bar"><div class="top"><span class="mark">证据</span><div class="identity"><b>${escapeHtml(context.storeName)} · ${escapeHtml(context.storeKey)}</b><small>${escapeHtml(context.checkTitle)} · 品牌 ${escapeHtml(brandText)}</small></div><div class="meta">证据 ${escapeHtml(evidenceId)}<br>采集：${escapeHtml(evidenceTime(context.checkedAt))}</div></div></header>${pageNotice}${pageLinks?`<nav class="actions" aria-label="评论截图分页">${pageLinks}</nav>`:''}<div class="notice"><b>原始只读截图，未添加水印或修改像素。</b> Amazon Customer Reviews 原页是品牌级数据，同一品牌授权给多个 Seller 店铺时原始列表可能相同；控制台的业务状态和结构化明细会再按当前店铺的有效 ASIN 清单过滤。请以上方店铺身份、截图内 Amazon 顶栏账户名及控制台“店铺归属”共同核对。</div><div class="actions"><a href="/shot?f=${encodeURIComponent(rel)}" target="_blank" rel="noopener">单独打开原始图片</a></div><main class="canvas"><img src="/shot?f=${encodeURIComponent(rel)}" alt="${escapeHtml(context.storeKey)} 原始采集截图"></main></body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function trendMetric(results) {
  const first = results?.[0] || {};
  const metrics = first.metrics || {};
  const candidates = [
    ['ahr', first.ahrScore], ['rating', metrics.rating], ['average', metrics.average],
    ['lowCount', metrics.lowCount], ['enabled', metrics.enabled], ['newCount', metrics.newCount],
    ['poorCount', metrics.poorCount],
  ];
  const found = candidates.find(([, value]) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)));
  return found ? { name: found[0], value: Number(found[1]) } : null;
}

function historyRunSummary(entry) {
  return {
    runId: entry.runId, date: entry.date, at: entry.at,
    slot: entry.report.slot || 'adhoc',
    state: worstState(entry.results.map(resultState)),
    status: [...new Set(entry.results.map((result) => result.status || 'UNKNOWN'))].join(' / '),
    metric: trendMetric(entry.results),
    resultCount: entry.results.length,
    itemCount: entry.results.reduce((sum, result) => sum + (result.items?.length || 0), 0),
  };
}

function cellTrend(checkId, storeKey) {
  const days = storeHistoryDays({ outDir: config.outDir, checkId, storeKey, staleAfterMs: STALE_AFTER_MS });
  const byRun = new Map();
  for (const run of days.flatMap((day) => day.runs)) {
    const prior = byRun.get(run.runId);
    byRun.set(run.runId, prior ? { ...run, results: [...prior.results, ...run.results] } : run);
  }
  const runs = [...byRun.values()].sort((a, b) => a.time - b.time);
  return {
    days: days.slice(-10).map((day) => ({
      ...historyRunSummary(day.runs.at(-1)),
      state: worstState(day.runs.flatMap((run) => run.results.map(resultState))),
      runCount: day.runs.length,
    })),
    previous: runs.length > 1 ? historyRunSummary(runs.at(-2)) : null,
  };
}

function publicHistory(id, storeKey, date, runId, page) {
  const day = storeHistoryDays({ outDir: config.outDir, checkId: id, storeKey }).find((entry) => entry.date === date);
  const runs = day?.runs || [];
  const selected = runId ? runs.find((run) => run.runId === runId) : runs.at(-1);
  if (runId && !selected) return null;
  const ordered=id==='reviews'&&selected?{...selected,results:selected.results.map(result=>({...result,items:reviewsByDate(result.items||[])}))}:selected;
  const paginated = historyRecordsPage(ordered, page);
  return {
    checkId: id, storeKey, date, timezone: 'Asia/Shanghai',
    runs: runs.map(historyRunSummary), selectedRun: selected ? historyRunSummary(selected) : null,
    ...paginated,
    records: paginated.records.map(({ result, item }) => ({
      result: publicResult({ ...result, items: [] }, storeKey),
      item: item ? publicItem(item) : null,
    })),
  };
}

function readiness() {
  const credential = loadZiniaoCredentials();
  const ziniaoConfigured = configuredHint('AMZGUARD_ZINIAO_CONFIGURED', credential.complete);
  const asinInfo = loadAsins(config);
  const collectorHealthRequired = process.env.COLLECTOR_HEALTH_REQUIRED === '1';
  let collectorHealth = null;
  try {
    collectorHealth = JSON.parse(fs.readFileSync(path.join(config.outDir, 'runtime', 'collector-health.json'), 'utf8'));
  } catch { /* first monitor run has not completed */ }
  const collectorAgeMs = collectorHealth?.checkedAt ? Date.now() - new Date(collectorHealth.checkedAt).getTime() : Infinity;
  const collectorReady = Boolean(collectorHealth?.ok && collectorAgeMs >= 0 && collectorAgeMs < 30 * 60 * 1000);
  let scheduleCount = 0;
  let dashboardInstalled = false;
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    scheduleCount = SLOTS.filter((slot) => fs.existsSync(path.join(
      dir, `com.singal.amzguard.store-health.${slot.name}.plist`,
    ))).length;
    dashboardInstalled = fs.existsSync(path.join(dir, 'com.singal.amzguard.dashboard.plist'));
  } else if (process.platform === 'linux') {
    const dirs = ['/etc/systemd/system', path.join(os.homedir(), '.config', 'systemd', 'user')];
    scheduleCount = SLOTS.filter((slot) => dirs.some((dir) => fs.existsSync(path.join(
      dir, `amzguard-store-health-${slot.name}.timer`,
    )))).length;
    dashboardInstalled = dirs.some((dir) => fs.existsSync(path.join(dir, 'amzguard-dashboard.service')));
  }
  const dingConfigured = configuredHint('AMZGUARD_DINGTALK_CONFIGURED', hasConfiguredDingTalk(config));
  const alertReady = Boolean(
    dingConfigured
    || (config.alert?.webhook?.enabled && config.alert.webhook.url),
  );
  const crmReady = configuredHint(
    'AMZGUARD_CRM_CONFIGURED',
    Boolean(config.crm?.enabled && config.crm.endpoint),
  );
  const items = [
    { id: 'stores', label: '店铺清单', ok: stores.length > 0, detail: `${stores.length} 家已启用`, required: true },
    {
      id: 'credentials', label: '紫鸟凭据', ok: ziniaoConfigured,
      detail: ziniaoConfigured ? (credential.complete ? credential.source : '采集服务已配置（凭据已隔离）') : '未设置',
      required: true,
    },
    {
      id: 'collector', label: '采集链路', ok: collectorReady,
      detail: collectorHealth
        ? `${collectorHealth.summary || (collectorHealth.ok ? '授权正常' : '授权失败')} · ${bjHuman(new Date(collectorHealth.checkedAt))}`
        : '尚未完成真机授权检查',
      required: collectorHealthRequired,
    },
    {
      id: 'asins', label: '真实 ASIN', ok: asinInfo.inventory.length > 0,
      detail: `${asinInfo.activeCount} 个激活/可售 · ${asinInfo.inactiveCount} 个非激活 · ${asinInfo.weeklyCount} 个低频复核`,
      required: true,
    },
    { id: 'schedule', label: '自动排程', ok: scheduleCount === SLOTS.length, detail: `${scheduleCount}/${SLOTS.length} 个时段`, required: true },
    { id: 'dashboard', label: '看板常驻', ok: dashboardInstalled, detail: dashboardInstalled ? '登录即启动' : '尚未安装', required: true },
    { id: 'alert', label: '实时报警', ok: alertReady, detail: alertReady ? '已配置' : '钉钉/Webhook 未配置', required: true },
    { id: 'crm', label: 'CRM 推送', ok: crmReady, detail: crmReady ? '已配置' : '未配置（保留本地 CSV）', required: false },
  ];
  const blockers = items.filter((item) => item.required && !item.ok);
  return { ready: blockers.length === 0, blockers: blockers.length, items };
}

/** Build a store-first view: every configured store has one cell for every check. */
function buildStores(checks) {
  const asinInfo = loadAsins(config);
  const reports = new Map(CHECKS.map((def) => [def.id, readLatest(def.id)?.report || null]));
  const snapshots = new Map(CHECKS.map((def) => [
    def.id,
    latestStoreSnapshots({ outDir: config.outDir, checkId: def.id }),
  ]));
  const known = new Map(stores.map((store) => [store.key, { ...store }]));

  // Keep results visible even when a remote collector reports a store that is not
  // in this dashboard machine's local stores.json yet.
  for (const storeMap of snapshots.values()) {
    for (const [key, snapshot] of storeMap) {
      if (known.has(key) || disabledStores.has(key)) continue;
      const result = snapshot.results[0] || {};
      known.set(key, {
        key, name: result.storeName || key, id: '', market: result.market || '', host: '', discovered: true,
      });
    }
  }

  return [...known.values()].map((store) => {
    const cells = {};
    for (const def of CHECKS) {
      const report = reports.get(def.id);
      const snapshot = snapshots.get(def.id)?.get(store.key);
      if (!snapshot) {
        if (def.id === 'asin-health') {
          const vocSnapshot = snapshots.get('voc')?.get(store.key);
          const vocResult = vocSnapshot?.results?.[0];
          if (vocResult) {
            const sourceState = resultState(vocResult);
            const state = sourceState === 'OK' ? 'WARN' : sourceState;
            cells[def.id] = {
              state,
              stateLabel: STATE_LABEL[state] || state,
              status: 'ASIN_SOURCE_UNAVAILABLE',
              results: [],
              lastRunAt: vocSnapshot.report.finishedAt || vocSnapshot.report.startedAt,
              slot: vocSnapshot.report.slot,
              runId: vocSnapshot.report.runId || null,
              durationMs: vocSnapshot.report.durationMs || null,
              stale: Boolean(vocSnapshot.stale),
              reasons: safeData([
                sourceState === 'OK'
                  ? 'VOC 已完成，但该店铺没有发现可用于第 5 项的真实 ASIN'
                  : `VOC 未能提供真实 ASIN：${(vocResult.anomalyReasons || [vocResult.status || '采集失败']).join('；')}`,
              ]),
            };
            continue;
          }
        }
        if (report?.skipped) {
          cells[def.id] = {
            state: 'SKIPPED', stateLabel: STATE_LABEL.SKIPPED, status: 'SKIPPED', results: [],
            lastRunAt: report.finishedAt || report.startedAt, slot: report.slot,
            reasons: safeData([report.skipReason || '该批次已跳过']),
            durationMs: report.durationMs || null, stale: false,
          };
          continue;
        }
        cells[def.id] = {
          state: 'NEVER_RUN', stateLabel: STATE_LABEL.NEVER_RUN, status: 'NEVER_RUN',
          results: [], lastRunAt: null, slot: null, durationMs: null, stale: false,
        };
        continue;
      }
      let matching = snapshot.results;
      let deferredAsinResults = [];
      if (def.id === 'asin-health') {
        const split = filterCurrentAsinResults(matching, asinInfo, store.key);
        matching = split.current;
        deferredAsinResults = split.deferred;
      }
      const sourceReport = snapshot.report;

      if (def.id === 'asin-health' && matching.length === 0 && deferredAsinResults.length > 0) {
        cells[def.id] = {
          state: 'OK', stateLabel: STATE_LABEL.OK, status: 'LOW_FREQUENCY_DEFERRED', results: [],
          reasons: safeData([`${deferredAsinResults.length} 个 ASIN 已转入低频复核，不占用当前运营待办`]),
          lastRunAt: sourceReport.finishedAt || sourceReport.startedAt,
          slot: sourceReport.slot, runId: sourceReport.runId || null,
          durationMs: sourceReport.durationMs || null, stale: Boolean(snapshot.stale),
        };
        continue;
      }

      const state = worstState(matching.map(resultState));
      const statuses = [...new Set(matching.map((result) => result.status || 'UNKNOWN'))];
      const reasons = safeData(matching.flatMap((result) => result.anomalyReasons || []));
      cells[def.id] = {
        state,
        stateLabel: STATE_LABEL[state] || state,
        status: statuses.join(' / '),
        results: matching.map((result) => publicResult(result, store.key)),
        reasons,
        lastRunAt: sourceReport.finishedAt || sourceReport.startedAt,
        slot: sourceReport.slot,
        runId: sourceReport.runId || null,
        durationMs: sourceReport.durationMs || null,
        stale: Boolean(snapshot.stale),
      };
    }
    for (const def of CHECKS) {
      const trend = cellTrend(def.id, store.key);
      cells[def.id].trend = trend.days;
      cells[def.id].previous = trend.previous;
      cells[def.id].actionState = actionStateFor(cells[def.id]);
      cells[def.id].actionLabel = ACTION_LABEL[cells[def.id].actionState];
      cells[def.id].actionOwner = ACTION_OWNER[cells[def.id].actionState];
      cells[def.id].stateLabel = rawStateLabel(cells[def.id].state, { stale: cells[def.id].stale });
    }
    const states = Object.values(cells).map((cell) => cell.state);
    const actions = Object.values(cells).map((cell) => cell.actionState);
    const state = worstState(states);
    const actionState = worstAction(actions);
    return {
      key: store.key,
      name: store.name || store.key,
      market: store.market || '',
      discovered: Boolean(store.discovered),
      state,
      stateLabel: STATE_LABEL[state] || state,
      actionState,
      actionLabel: ACTION_LABEL[actionState],
      ok: states.filter((item) => item === 'OK').length,
      problem: states.filter((item) => ['ERROR', 'CRITICAL', 'WARN'].includes(item)).length,
      pending: states.filter((item) => ['NOT_CONFIGURED', 'NOT_COVERED', 'NEVER_RUN', 'SKIPPED'].includes(item)).length,
      normalActions: actions.filter((item) => item === 'NORMAL').length,
      businessActions: actions.filter((item) => item === 'BUSINESS').length,
      collectionActions: actions.filter((item) => item === 'COLLECTION').length,
      pendingActions: actions.filter((item) => item === 'PENDING').length,
      cells,
    };
  });
}

function nextOccurrence(at, now = new Date()) {
  const { hour, minute } = parseHHMM(at);
  const parts = bjParts(now);
  let time = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour - 8, minute, 0);
  if (time <= now.getTime()) time += 24 * 60 * 60 * 1000;
  return new Date(time);
}

function scheduleView(now = new Date()) {
  const monitoring = readAdsMonitoring(config.outDir);
  const slots = SLOTS.map((slot) => {
    const next = nextOccurrence(slot.at, now);
    const paused = monitoring.paused && slot.checks.includes('ads-status');
    return {
      name: slot.name,
      at: slot.at,
      label: slot.label,
      checks: slot.checks,
      paused,
      nextAt: paused ? null : bjIso(next),
      nextAtHuman: paused ? '已暂停' : bjHuman(next),
    };
  });
  return { slots, next: slots.filter((slot) => !slot.paused).sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))[0] || null };
}

function readJsonLines(dir, limit = 100) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().slice(-14);
  const rows = [];
  for (const name of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).filter(Boolean); } catch { continue; }
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed);
      } catch { /* an interrupted audit line must not break the dashboard */ }
    }
  }
  return rows.slice(-limit);
}

function alertHistory() {
  return readJsonLines(path.join(config.outDir, 'alerts'), 100).reverse().map((record, index) => ({
    id: crypto.createHash('sha256').update(`${record.at || ''}|${record.check || ''}|${record.title || ''}|${index}`).digest('hex').slice(0, 16),
    at: record.at || null,
    check: CHECK_IDS.has(record.check) ? record.check : null,
    severity: ['OK', 'WARN', 'CRITICAL', 'ERROR'].includes(record.severity) ? record.severity : 'ERROR',
    title: safeData(record.title || '巡检通知'),
    lines: safeData((record.lines || []).slice(0, 8)),
    test: Boolean(record.data?.test),
    delivery: safeData(record.delivery || {}),
  }));
}

function latestDelivery(alerts, prefix) {
  for (const alert of alerts) {
    for (const [channel, outcome] of Object.entries(alert.delivery || {})) {
      if (!channel.startsWith(prefix)) continue;
      return {
        at: alert.at,
        ok: outcome === 'ok',
        outcome: outcome === 'ok' ? '成功' : '失败',
      };
    }
  }
  return null;
}

function channelStatus(alerts) {
  const dingConfigured = configuredHint('AMZGUARD_DINGTALK_CONFIGURED', hasConfiguredDingTalk(config));
  const webhookConfigured = Boolean(config.alert?.webhook?.enabled && config.alert.webhook.url);
  const crmConfigured = configuredHint(
    'AMZGUARD_CRM_CONFIGURED',
    Boolean(config.crm?.enabled && config.crm.endpoint),
  );
  const crmAudit = readJsonLines(path.join(config.outDir, 'channels', 'crm'), 1).at(-1) || null;
  const crmLast = crmAudit ? {
    at: crmAudit.at || null,
    ok: crmAudit.ok === true || ['delivered', 'deduplicated'].includes(crmAudit.event),
    dryRun: crmAudit.event === 'dry-run',
    outcome: crmAudit.event || (crmAudit.ok ? '成功' : '失败'),
  } : null;
  const crmExportAudit = readJsonLines(path.join(config.outDir, 'channels', 'crm-export'), 1).at(-1) || null;
  const crmExportLast = crmExportAudit ? {
    at: crmExportAudit.at || null,
    ok: crmExportAudit.ok === true && crmExportAudit.event === 'compatibility-export',
    outcome: crmExportAudit.event || 'compatibility-export',
  } : null;
  return [
    { id: 'dingtalk', label: '钉钉', configured: dingConfigured, last: latestDelivery(alerts, 'dingtalk') },
    { id: 'webhook', label: 'Webhook', configured: webhookConfigured, last: latestDelivery(alerts, 'webhook') },
    { id: 'crm', label: 'CRM', configured: crmConfigured, last: crmLast },
    {
      id: 'crm-export', label: 'CRM 兼容导出', configured: true, last: crmExportLast,
      description: '本地只读交换文件；未向参考 CRM 写入',
    },
  ].map((channel) => ({
    ...channel,
    state: !channel.configured ? 'NOT_CONFIGURED' : !channel.last ? 'NO_DELIVERY'
      : channel.last.dryRun ? 'DRY_RUN' : channel.last.ok ? 'OK' : 'ERROR',
  }));
}

function runtimeProgress() {
  return safeData(readRuntimeProgress(config.outDir));
}

function status() {
  const schedule = scheduleView();
  const alerts = alertHistory();
  const rollups = CHECKS.map(rollup);
  const storeRows = buildStores(rollups);
  const checks = rollups.map((check) => {
    const cells = storeRows.map((store) => store.cells[check.id]);
    const state = worstState(cells.map((cell) => cell.state));
    const actionState = worstAction(cells.map((cell) => cell.actionState));
    const problems = storeRows.flatMap((store) => {
      const cell = store.cells[check.id];
      if (!['ERROR', 'CRITICAL', 'WARN'].includes(cell.state)) return [];
      return [{ subject: store.key, status: cell.status, severity: cell.state, reasons: cell.reasons || [] }];
    });
    const latestAt = cells.map((cell) => cell.lastRunAt).filter(Boolean).sort().at(-1) || null;
    return {
      id: check.id,
      no: check.no,
      title: check.title,
      short: check.short,
      requirement: check.requirement,
      scope: check.scope,
      state,
      stateLabel: STATE_LABEL[state] || state,
      actionState,
      actionLabel: ACTION_LABEL[actionState],
      lastRunAt: latestAt,
      stale: cells.length > 0 && cells.every((cell) => cell.stale),
      problems,
      coverage: {
        total: cells.length,
        completed: cells.filter((cell) => ['OK', 'ERROR', 'CRITICAL', 'WARN'].includes(cell.state)).length,
        ok: cells.filter((cell) => cell.state === 'OK').length,
        problem: cells.filter((cell) => ['ERROR', 'CRITICAL', 'WARN'].includes(cell.state)).length,
        pending: cells.filter((cell) => ['NOT_CONFIGURED', 'NOT_COVERED', 'NEVER_RUN', 'SKIPPED'].includes(cell.state)).length,
        normalActions: cells.filter((cell) => cell.actionState === 'NORMAL').length,
        businessActions: cells.filter((cell) => cell.actionState === 'BUSINESS').length,
        collectionActions: cells.filter((cell) => cell.actionState === 'COLLECTION').length,
        pendingActions: cells.filter((cell) => cell.actionState === 'PENDING').length,
      },
    };
  });
  const worst = worstAction(storeRows.map((store) => store.actionState));
  const cellList = storeRows.flatMap((store) => Object.values(store.cells));
  const asinInfo = loadAsins(config);
  const asinRecommendations = buildMonitoringRecommendations({
    history: readCheckHistory({
      outDir: config.outDir,
      checkId: 'asin-health',
      staleAfterMs: STALE_AFTER_MS,
    }),
    inventory: asinInfo.inventory,
  });
  const issues = storeRows.flatMap((store) => CHECKS.flatMap((def) => {
    const cell = store.cells[def.id];
    if (!['BUSINESS', 'COLLECTION'].includes(cell.actionState)) return [];
    return [{
      storeKey: store.key,
      storeName: store.name,
      market: store.market,
      checkId: def.id,
      checkNo: def.no,
      checkTitle: def.title,
      state: cell.state,
      stateLabel: cell.stateLabel,
      actionState: cell.actionState,
      actionLabel: cell.actionLabel,
      actionOwner: cell.actionOwner,
      status: cell.status,
      reasons: cell.reasons || [],
      lastRunAt: cell.lastRunAt,
    }];
  }));
  return {
    generatedAt: bjIso(),
    generatedAtHuman: bjHuman(),
    timezone: 'Asia/Shanghai',
    currentSlot: detectSlot(SLOTS, new Date()),
    slots: schedule.slots,
    adsMonitoring: readAdsMonitoring(config.outDir),
    nextRun: schedule.next,
    overall: worst,
    readiness: readiness(),
    progress: runtimeProgress(),
    channels: channelStatus(alerts),
    sessionHealth: buildSessionHealth(storeRows),
    evidenceCompleteness: evidenceCompleteness(storeRows),
    alerts,
    views: operationalViewCatalog(),
    summary: {
      total: checks.length,
      ok: checks.filter((c) => c.state === 'OK').length,
      problem: checks.filter((c) => ['CRITICAL', 'ERROR', 'WARN'].includes(c.state)).length,
      pending: checks.filter((c) => ['NEVER_RUN', 'NOT_CONFIGURED', 'NOT_COVERED', 'SKIPPED'].includes(c.state)).length,
      totalProblems: issues.length,
      stores: storeRows.length,
      healthyStores: storeRows.filter((store) => store.actionState === 'NORMAL').length,
      attentionStores: storeRows.filter((store) => ['BUSINESS', 'COLLECTION'].includes(store.actionState)).length,
      totalCells: cellList.length,
      completedCells: cellList.filter((cell) => ['OK', 'ERROR', 'CRITICAL', 'WARN'].includes(cell.state)).length,
      okCells: cellList.filter((cell) => cell.state === 'OK').length,
      problemCells: cellList.filter((cell) => ['ERROR', 'CRITICAL', 'WARN'].includes(cell.state)).length,
      businessProblemCells: cellList.filter((cell) => cell.state === 'CRITICAL').length,
      collectionFailureCells: cellList.filter((cell) => cell.state === 'ERROR').length,
      warningCells: cellList.filter((cell) => cell.state === 'WARN').length,
      pendingCells: cellList.filter((cell) => ['NOT_CONFIGURED', 'NOT_COVERED', 'NEVER_RUN', 'SKIPPED'].includes(cell.state)).length,
      staleCells: cellList.filter((cell) => cell.stale).length,
      normalActionCells: cellList.filter((cell) => cell.actionState === 'NORMAL').length,
      businessActionCells: cellList.filter((cell) => cell.actionState === 'BUSINESS').length,
      collectionActionCells: cellList.filter((cell) => cell.actionState === 'COLLECTION').length,
      pendingActionCells: cellList.filter((cell) => cell.actionState === 'PENDING').length,
    },
    asinInventory: (() => {
      const info = asinInfo;
      return {
        total: info.inventory.length,
        active: info.activeCount,
        inactive: info.inactiveCount,
        weekly: info.weeklyCount,
        due: info.asins.length,
        deferred: info.deferredCount,
        disabled: info.disabledCount,
        recheckDays: info.recheckDays,
        items: safeData([
          ...info.inventory.filter((item) => item.lastStatus === 'INACTIVE_LISTING' && item.monitoring === 'active'),
          ...info.deferredAsins, ...info.disabledAsins,
        ].map((item) => ({
          asin: item.asin,
          storeKey: item.storeKey,
          market: item.market,
          monitoring: item.monitoring,
          reason: item.monitoringReason || item.lastReason || null,
          lastStatus: item.lastStatus,
          lastCheckedAt: item.lastCheckedAt,
          nextCheckAt: item.nextCheckAt,
        }))),
        recommendations: safeData(asinRecommendations),
      };
    })(),
    checks,
    stores: storeRows,
    issues,
  };
}

function monitoringRecommendations() {
  const asinInfo = loadAsins(config);
  const history = readCheckHistory({
    outDir: config.outDir,
    checkId: 'asin-health',
    staleAfterMs: STALE_AFTER_MS,
  });
  return buildMonitoringRecommendations({ history, inventory: asinInfo.inventory });
}

function operationalViews(req) {
  const current = status();
  return buildOperationalViews({
    stores: current.stores,
    checks: current.checks,
    issues: current.issues,
    summary: current.summary,
    sessionHealth: current.sessionHealth,
    progress: current.progress,
    readiness: current.readiness,
    channels: current.channels,
    alerts: current.alerts,
    monitoringRecommendations: current.asinInventory?.recommendations || monitoringRecommendations(),
    upload: {
      enabled: PRODUCT_UPLOAD_ENABLED,
      authorized: validProductUploadRole(req),
    },
  });
}

function publicReport(checkId) {
  const def = CHECKS.find((check) => check.id === checkId);
  const effective = def ? latestEffectiveCheck({ outDir: config.outDir, checkId, staleAfterMs: STALE_AFTER_MS }) : null;
  if (!def || !effective) return null;
  const report = effective.newest.report;
  const effectiveTotals = effective.results.reduce((totals, result) => {
    totals.total++;
    const state = resultState(result);
    if (state === 'OK') totals.ok++;
    else if (state === 'CRITICAL') totals.business++;
    else if (state === 'WARN') totals.warning++;
    else totals.collection++;
    return totals;
  }, { total: 0, ok: 0, business: 0, warning: 0, collection: 0 });
  const history = readCheckHistory({
    outDir: config.outDir,
    checkId,
    staleAfterMs: STALE_AFTER_MS,
  }).slice(-30).map((row) => ({
    runId: row.report.runId || null,
    slot: row.report.slot || null,
    startedAt: row.report.startedAt || null,
    finishedAt: row.report.finishedAt || null,
    durationMs: row.report.durationMs || null,
    stale: Boolean(row.stale),
    totals: safeData(row.report.totals || {}),
    states: [...new Set((row.report.results || []).map(resultState))],
  }));
  return {
    check: { id: def.id, no: def.no, title: def.title, short: def.short, requirement: def.requirement },
    run: {
      runId: 'LATEST_EFFECTIVE_BY_STORE',
      slot: 'latest-effective',
      startedAt: null,
      finishedAt: report.finishedAt || report.startedAt || null,
      durationMs: null,
      stale: Boolean(effective.stale),
      skipped: false,
      skipReason: null,
      sources: safeData(effective.sources),
    },
    totals: effectiveTotals,
    results: effective.results.map((result) => publicResult(result)),
    history,
  };
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

function readBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBufferBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes) {
      reject(new Error('invalid content length'));
      req.resume();
      return;
    }
    let size = 0;
    let failed = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes || size > declared) {
        failed = true;
        chunks.length = 0;
        reject(new Error('payload too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (size !== declared) return reject(new Error('content length mismatch'));
      return resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJsonRequest(req, maxBytes = 32 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    const error = new Error('application/json required');
    error.statusCode = 415;
    throw error;
  }
  try { return JSON.parse(await readBody(req, maxBytes)); }
  catch (error) {
    if (error?.statusCode) throw error;
    const invalid = new Error('invalid JSON payload');
    invalid.statusCode = 400;
    throw invalid;
  }
}

function userContext(req) {
  const claims = sessionClaims(req) || {};
  const me = userStore.get(claims.username);
  const canManage = validAdminRole(req);
  return {
    ok: true,
    csrf: csrfToken(req),
    canManage,
    me,
    users: canManage ? userStore.list() : (me ? [me] : []),
    passwordMinLength: 12,
  };
}

async function createUserRequest(req, res) {
  if (!validAdminRole(req)) return json(res, 403, { ok: false, error: 'administrator role required' });
  if (!requireProtectedMutation(req, res)) return;
  let payload;
  try { payload = await readJsonRequest(req); }
  catch (error) { return json(res, error.statusCode || 400, { ok: false, error: error.message }); }
  try {
    const user = userStore.create(payload || {});
    if (payload) payload.password = '';
    return json(res, 201, { ok: true, user });
  } catch (error) {
    if (payload) payload.password = '';
    return json(res, 400, { ok: false, error: safeData(String(error?.message || error)) });
  }
}

async function updateUserRequest(req, res, username) {
  if (!validAdminRole(req)) return json(res, 403, { ok: false, error: 'administrator role required' });
  if (!requireProtectedMutation(req, res)) return;
  const current = sessionClaims(req)?.username || '';
  if (username === current) return json(res, 409, { ok: false, error: '请使用“修改我的密码”；不能停用或降级当前账户' });
  let payload;
  try { payload = await readJsonRequest(req); }
  catch (error) { return json(res, error.statusCode || 400, { ok: false, error: error.message }); }
  try {
    const user = payload?.password
      ? userStore.changePassword({ username, newPassword: payload.password })
      : userStore.update({ username, enabled: payload?.enabled, role: payload?.role });
    if (payload) payload.password = '';
    return json(res, 200, { ok: true, user });
  } catch (error) {
    if (payload) payload.password = '';
    return json(res, 400, { ok: false, error: safeData(String(error?.message || error)) });
  }
}

function deleteUserRequest(req, res, username) {
  if (!validAdminRole(req)) return json(res, 403, { ok: false, error: 'administrator role required' });
  if (!requireProtectedMutation(req, res)) return;
  if (username === sessionClaims(req)?.username) return json(res, 409, { ok: false, error: '不能删除当前登录账户' });
  try { return json(res, 200, { ok: true, user: userStore.remove(username) }); }
  catch (error) { return json(res, 400, { ok: false, error: safeData(String(error?.message || error)) }); }
}

async function changeOwnPasswordRequest(req, res) {
  if (!requireProtectedMutation(req, res)) return;
  let payload;
  try { payload = await readJsonRequest(req); }
  catch (error) { return json(res, error.statusCode || 400, { ok: false, error: error.message }); }
  const username = sessionClaims(req)?.username || '';
  if (!userStore.verifyPassword(username, String(payload?.currentPassword || ''))) {
    if (payload) payload.currentPassword = '';
    return json(res, 401, { ok: false, error: '当前密码不正确' });
  }
  try {
    userStore.changePassword({ username, newPassword: payload?.newPassword });
    payload.currentPassword = '';
    payload.newPassword = '';
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return json(res, 200, { ok: true, loginRequired: true });
  } catch (error) {
    if (payload) { payload.currentPassword = ''; payload.newPassword = ''; }
    return json(res, 400, { ok: false, error: safeData(String(error?.message || error)) });
  }
}

function adsRulesContext(req) {
  return {
    ok: true,
    csrf: csrfToken(req),
    canManage: validAdminRole(req),
    rules: stores.map((store) => ({
      storeKey: store.key,
      storeName: store.name || store.key,
      nameContains: String(store.adsNameContains || ''),
      configured: Boolean(String(store.adsNameContains || '').trim()),
    })),
  };
}

async function updateAdsRulesRequest(req, res) {
  if (!validAdminRole(req)) return json(res, 403, { ok: false, error: 'administrator role required' });
  if (!requireProtectedMutation(req, res)) return;
  let payload;
  try { payload = await readJsonRequest(req); }
  catch (error) { return json(res, error.statusCode || 400, { ok: false, error: error.message }); }
  try {
    const submitted = Array.isArray(payload?.rules) ? payload.rules : [];
    const expected = new Set(stores.map((store) => store.key));
    if (submitted.length !== expected.size) throw new Error('必须一次提交全部已启用店铺的广告规则');
    const rules = new Map();
    for (const row of submitted) {
      const storeKey = String(row?.storeKey || '');
      if (!expected.has(storeKey) || rules.has(storeKey)) throw new Error('广告规则包含未知或重复店铺');
      rules.set(storeKey, validateAdsNameContains(row?.nameContains));
    }
    writeAdsRules(config.outDir, rules);
    for (const store of stores) store.adsNameContains = rules.get(store.key);
    return json(res, 200, adsRulesContext(req));
  } catch (error) {
    return json(res, 400, { ok: false, error: safeData(String(error?.message || error)) });
  }
}

function productUploadAuthorizedUser(username = '') {
  const configured = String(process.env.AMZGUARD_PRODUCT_UPLOAD_ADMIN_USERNAME || '').trim();
  return PRODUCT_UPLOAD_ENABLED && Boolean(configured) && configured === String(username || '');
}

function uploadConfirmationChallenge(job) {
  return crypto.createHmac('sha256', DASHBOARD_SESSION_SECRET).update([
    'product-upload-v1', job.id, job.store.key, job.file.sha256, job.file.size, job.expiresAt,
  ].join(':')).digest('base64url');
}

function publicUploadJob(job) {
  const value = publicProductUploadJob(job);
  if (job.state === 'STAGED') value.confirmationChallenge = uploadConfirmationChallenge(job);
  return value;
}

function decodeHeader(value) {
  try { return decodeURIComponent(String(value || '')); } catch { return ''; }
}

function operatorIdentity(req) {
  const ipDigest = crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 16);
  return `${sessionClaims(req)?.username || 'unknown'}:${ipDigest}`;
}

function uploadStageAllowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (uploadStageAttempts.get(ip) || []).filter((at) => now - at < UPLOAD_STAGE_WINDOW_MS);
  if (recent.length >= UPLOAD_STAGE_MAX_ATTEMPTS || activeUploadStages >= 2 || activeUploadStageIps.has(ip)) return false;
  recent.push(now);
  uploadStageAttempts.set(ip, recent);
  activeUploadStages++;
  activeUploadStageIps.add(ip);
  return true;
}

function releaseUploadStage(req) {
  activeUploadStages = Math.max(0, activeUploadStages - 1);
  activeUploadStageIps.delete(clientIp(req));
}

function hasUploadCapacity(storeKey, declaredBytes) {
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > PRODUCT_UPLOAD_MAX_BYTES) return false;
  const inventory = productUploadJobInventory({ outDir: config.outDir, limit: 10_000 });
  const pending = inventory.jobs.filter((job) => ['STAGED', 'QUEUED', 'PROCESSING', 'PREPARED', 'SUBMITTING'].includes(job.state));
  if (pending.length >= UPLOAD_PENDING_GLOBAL_MAX) return false;
  if (pending.filter((job) => job.store?.key === storeKey).length >= UPLOAD_PENDING_STORE_MAX) return false;
  try {
    const disk = fs.statfsSync(config.outDir);
    const free = Number(disk.bavail) * Number(disk.bsize);
    if (!Number.isFinite(free) || free < UPLOAD_MIN_FREE_BYTES + declaredBytes * 2) return false;
  } catch { return false; }
  return true;
}

function productUploadApi(url, authorized = false) {
  const inventory = productUploadJobInventory({ outDir: config.outDir, limit: 10_000 });
  const storeFilter = String(url.searchParams.get('store') || '');
  const stateFilter = String(url.searchParams.get('state') || '');
  const filteredJobs = inventory.jobs.filter((job) =>
    (!storeFilter || job.store?.key === storeFilter)
    && (!stateFilter || job.state === stateFilter),
  );
  const pageSize = Math.max(1, Math.min(50, Number(url.searchParams.get('pageSize')) || 10));
  const pageCount = Math.max(1, Math.ceil(filteredJobs.length / pageSize));
  const page = Math.max(1, Math.min(pageCount, Number(url.searchParams.get('page')) || 1));
  const start = (page - 1) * pageSize;
  return {
    ok: true,
    enabled: PRODUCT_UPLOAD_ENABLED,
    authorized,
    csrf: '',
    limits: {
      maxBytes: PRODUCT_UPLOAD_MAX_BYTES,
      extensions: PRODUCT_UPLOAD_ALLOWED_EXTENSIONS,
      stageExpiresMinutes: 30,
    },
    stores: stores.filter((store) => store.enabled !== false).map((store) => ({
      key: String(store.key), name: String(store.name || store.key), market: String(store.market || 'US'),
    })),
    jobs: filteredJobs.slice(start, start + pageSize).map(publicUploadJob),
    resultSummary: summarizeProductUploadJobs(filteredJobs),
    pagination: { page, pageSize, pageCount, total: filteredJobs.length, totalAll: inventory.jobs.length },
    corrupt: inventory.corrupt,
  };
}

function productUploadContext(req, url) {
  const body = productUploadApi(url, validProductUploadRole(req));
  body.csrf = csrfToken(req);
  return body;
}

async function stageProductUploadRequest(req, res) {
  if (!PRODUCT_UPLOAD_ENABLED) return json(res, 503, { ok: false, error: 'product upload disabled' });
  if (!validProductUploadRole(req)) return json(res, 403, { ok: false, error: 'product upload role required' });
  if (!requireProtectedMutation(req, res)) return;
  if (String(req.headers['content-type'] || '').toLowerCase() !== 'application/octet-stream') {
    return json(res, 415, { ok: false, error: 'application/octet-stream required' });
  }
  const storeKey = String(req.headers['x-amzguard-store-key'] || '');
  const store = stores.find((candidate) => candidate.enabled !== false && candidate.key === storeKey);
  if (!store) return json(res, 400, { ok: false, error: 'unknown or disabled store' });
  const declaredBytes = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > PRODUCT_UPLOAD_MAX_BYTES) {
    return json(res, 411, { ok: false, error: 'valid Content-Length required' });
  }
  if (!hasUploadCapacity(storeKey, declaredBytes)) return json(res, 429, { ok: false, error: 'upload queue or storage capacity reached' });
  if (!uploadStageAllowed(req)) return json(res, 429, { ok: false, error: 'upload staging temporarily limited' });
  const originalName = decodeHeader(req.headers['x-amzguard-file-name']);
  let buffer;
  try {
    try { buffer = await readBufferBody(req, PRODUCT_UPLOAD_MAX_BYTES); }
    catch { return json(res, 400, { ok: false, error: 'invalid or oversized upload body' }); }
    inspectProductUploadFile({ originalName, buffer });
    const job = stageProductUpload({
      outDir: config.outDir, store, originalName, buffer,
      actor: operatorIdentity(req),
    });
    return json(res, 201, { ok: true, job: publicUploadJob(job) });
  } catch (error) {
    return json(res, 400, { ok: false, error: safeData(String(error?.message || error)) });
  } finally {
    if (buffer) buffer.fill(0);
    releaseUploadStage(req);
  }
}

async function confirmProductUploadRequest(req, res) {
  if (!PRODUCT_UPLOAD_ENABLED) return json(res, 503, { ok: false, error: 'product upload disabled' });
  if (!validProductUploadRole(req)) return json(res, 403, { ok: false, error: 'product upload role required' });
  if (!requireProtectedMutation(req, res)) return;
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    return json(res, 415, { ok: false, error: 'application/json required' });
  }
  const failure = failureState(req);
  if (failure.blocked) return json(res, 429, { ok: false, error: 'reauthentication temporarily limited' });
  let payload;
  try { payload = JSON.parse(await readBody(req, 16 * 1024)); }
  catch { return json(res, 400, { ok: false, error: 'invalid JSON payload' }); }
  const username = sessionClaims(req)?.username || '';
  if (!userStore.verifyPassword(username, String(payload.password || ''))) {
    payload.password = '';
    recordFailure(req);
    return json(res, 401, { ok: false, error: 'dashboard password incorrect' });
  }
  payload.password = '';
  loginFailures.delete(failure.ip);
  try {
    const current = readProductUploadJob({ outDir: config.outDir, jobId: String(payload.jobId || '') });
    const challenge = String(payload.confirmationChallenge || '');
    if (
      !safeEqual(challenge, uploadConfirmationChallenge(current))
      || String(payload.storeKey || '') !== current.store.key
      || String(payload.sha256Short || '') !== current.file.sha256.slice(0, 12)
      || Number(payload.size) !== current.file.size
    ) return json(res, 409, { ok: false, error: 'confirmation binding mismatch' });
    const job = confirmProductUpload({
      outDir: config.outDir,
      jobId: String(payload.jobId || ''),
      phrase: String(payload.phrase || ''),
      actor: operatorIdentity(req),
    });
    return json(res, 202, { ok: true, job: publicUploadJob(job) });
  } catch (error) {
    return json(res, 409, { ok: false, error: safeData(String(error?.message || error)) });
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function ingestValidation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'payload must be an object';
  if (!CHECK_IDS.has(payload.check)) return 'unknown or missing check';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(String(payload.runId || ''))) return 'invalid or missing runId';
  if (!payload.skipped && (!Array.isArray(payload.results) || payload.results.length > 10_000)) return 'invalid results';
  if (payload.results?.some((result) => !result || typeof result !== 'object' || Array.isArray(result))) return 'invalid result row';
  if (payload.results?.some((result) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(result.storeKey || '')))) {
    return 'invalid or missing result storeKey';
  }
  for (const field of ['startedAt', 'finishedAt']) {
    if (payload[field] !== undefined && !Number.isFinite(Date.parse(payload[field]))) return `invalid ${field}`;
    if (payload[field] !== undefined && Date.parse(payload[field]) > Date.now() + 5 * 60 * 1000) return `${field} is in the future`;
  }
  if (payload.startedAt && payload.finishedAt && Date.parse(payload.finishedAt) < Date.parse(payload.startedAt)) {
    return 'finishedAt precedes startedAt';
  }
  return null;
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }
}

function writeAtomic(file, body) {
  privateDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}

function writeNewAtomic(file, body) {
  privateDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/** Accept a report using an ingest-only token, independent of UI sessions. */
async function ingest(req, res) {
  if (!INGEST_TOKEN) return json(res, 503, { ok: false, error: 'ingest disabled' });
  const given = typeof req.headers['x-ingest-token'] === 'string' ? req.headers['x-ingest-token'] : '';
  if (!safeEqual(given, INGEST_TOKEN)) return json(res, 401, { ok: false, error: 'authentication required' });
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    return json(res, 415, { ok: false, error: 'application/json required' });
  }
  let payload;
  try { payload = JSON.parse(await readBody(req, MAX_INGEST_BYTES)); }
  catch { return json(res, 400, { ok: false, error: 'invalid JSON payload' }); }
  const invalid = ingestValidation(payload);
  if (invalid) return json(res, 400, { ok: false, error: invalid });

  const clean = sanitizeForStorage(payload, { rootDir: config.outDir });
  const digest = crypto.createHash('sha256').update(JSON.stringify(canonical(clean))).digest('hex');
  const storedAt = bjIso();
  const stored = {
    ...clean,
    _ingestedAt: storedAt,
    _ingestDigest: digest,
    _ingestSource: crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 16),
  };
  const body = `${JSON.stringify(stored, null, 2)}\n`;
  const dir = path.join(config.outDir, clean.check);
  const historyFile = path.join(dir, 'ingested', `${clean.runId}.json`);
  if (fs.existsSync(historyFile)) {
    let previousDigest = null;
    try { previousDigest = JSON.parse(fs.readFileSync(historyFile, 'utf8'))._ingestDigest; } catch { /* conflict */ }
    if (safeEqual(previousDigest || '', digest)) {
      return json(res, 200, { ok: true, duplicate: true, check: clean.check, runId: clean.runId });
    }
    return json(res, 409, { ok: false, error: 'runId already exists with different content' });
  }
  if (!writeNewAtomic(historyFile, body)) return json(res, 409, { ok: false, error: 'runId conflict' });
  const newest = readCheckHistory({ outDir: config.outDir, checkId: clean.check, staleAfterMs: STALE_AFTER_MS }).at(-1);
  if (newest?.report?.runId === clean.runId) writeAtomic(path.join(dir, 'latest.json'), body);
  return json(res, 201, { ok: true, duplicate: false, check: clean.check, runId: clean.runId, storedAt });
}

/** Serve a screenshot, but only from inside outDir. */
function serveShot(res, rel) {
  if (typeof rel !== 'string' || rel.includes('\0') || path.isAbsolute(rel)) {
    return json(res, 403, { ok: false, error: 'path outside output directory' });
  }
  let base;
  let target;
  try {
    base = fs.realpathSync(config.outDir);
    target = fs.realpathSync(path.resolve(config.outDir, rel));
  } catch {
    return json(res, 404, { ok: false, error: 'not found' });
  }
  if (!target.startsWith(`${base}${path.sep}`) || !/\.(png|jpe?g)$/i.test(target) || !fs.statSync(target).isFile()) {
    return json(res, 403, { ok: false, error: 'not available' });
  }
  const buf = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': target.endsWith('.png') ? 'image/png' : 'image/jpeg',
    'Content-Length': buf.length,
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store, max-age=0',
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  try {
    applySecurityHeaders(req, res);
    if (String(req.url || '').length > 4096) return json(res, 414, { ok: false, error: 'URI too long' });
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, { ok: true, at: bjIso() });
    }
    // Collector authentication is deliberately independent from the browser
    // session. A collector can push while the dashboard remains locked down.
    if (p === '/api/ingest') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return json(res, 405, { ok: false, error: 'method not allowed' });
      }
      return ingest(req, res);
    }
    if (req.method === 'GET' && p === '/login') {
      if (validSession(req)) return redirect(res, '/');
      return html(res, 200, loginHtml());
    }
    if (req.method === 'POST' && p === '/login') {
      if (!AUTH_ENABLED) return redirect(res, '/');
      const state = failureState(req);
      if (state.blocked) return html(res, 429, loginHtml('登录尝试过多，请 10 分钟后再试。'));
      let fields;
      try { fields = new URLSearchParams(await readBody(req, 8192)); }
      catch { return html(res, 400, loginHtml('请求无效，请重试。')); }
      const username = fields.get('username') || '';
      const password = fields.get('password') || '';
      const user = userStore.verifyPassword(username, password);
      if (!user) {
        recordFailure(req);
        return html(res, 401, loginHtml('用户名或密码不正确。'));
      }
      loginFailures.delete(state.ip);
      return redirect(res, '/', { 'Set-Cookie': sessionCookie(req, makeSession(user)) });
    }
    if (req.method === 'POST' && p === '/logout') {
      return redirect(res, '/login', { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (!validSession(req)) {
      if (p.startsWith('/api/') || p === '/shot') return json(res, 401, { ok: false, error: 'authentication required' });
      // Render the login page directly for the public entry point. This avoids
      // making availability depend on a client following a redirect while the
      // canonical /login path remains available for explicit bookmarks.
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return html(res, 200, loginHtml());
      }
      return redirect(res, '/login');
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = DASHBOARD_HTML;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }
    if (p === '/intelligence' && req.method === 'GET') return redirect(res, '/#intelligence');
    if (INTELLIGENCE_ASSETS.has(p)) {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
      const [file, type] = INTELLIGENCE_ASSETS.get(p);
      const body = fs.readFileSync(new URL(`./web/${file}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
      return res.end(body);
    }
    if (p === '/api/intelligence' || p.startsWith('/api/intelligence/')) {
      return intelligenceRequest(req, res, url, { config, stores, json, readJsonRequest,
        validAdminRole, requireProtectedMutation, csrfToken, sessionClaims });
    }
    if (req.method === 'GET' && p === '/api/status') return json(res, 200, status());
    if (req.method === 'GET' && p === '/api/progress') return json(res, 200, runtimeProgress());
    if (req.method === 'GET' && p === '/api/users') return json(res, 200, userContext(req));
    if (p === '/api/users' && req.method === 'POST') return createUserRequest(req, res);
    if (p.startsWith('/api/users/')) {
      const username = decodeURIComponent(p.slice('/api/users/'.length));
      if (!username || username.includes('/')) return json(res, 404, { ok: false, error: 'unknown user' });
      if (req.method === 'PATCH') return updateUserRequest(req, res, username);
      if (req.method === 'DELETE') return deleteUserRequest(req, res, username);
      res.setHeader('Allow', 'PATCH, DELETE');
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }
    if (p === '/api/account/password') {
      if (req.method === 'POST') return changeOwnPasswordRequest(req, res);
      res.setHeader('Allow', 'POST');
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }
    if (req.method === 'GET' && p === '/api/ads-rules') return json(res, 200, adsRulesContext(req));
    if (p === '/api/ads-rules' && req.method === 'PUT') return updateAdsRulesRequest(req, res);
    if (req.method === 'GET' && p === '/api/views') {
      const views = operationalViews(req);
      return json(res, 200, {
        generatedAt: bjIso(),
        views: operationalViewCatalog().map((view) => ({
          ...view,
          state: views[view.id]?.state || null,
          actionState: views[view.id]?.actionState || null,
          summary: views[view.id]?.summary || null,
        })),
      });
    }
    if (req.method === 'GET' && p.startsWith('/api/view/')) {
      const id = decodeURIComponent(p.slice('/api/view/'.length));
      if (!operationalViewCatalog().some((view) => view.id === id)) {
        return json(res, 404, { ok: false, error: 'unknown view' });
      }
      return json(res, 200, operationalViews(req)[id]);
    }
    if (req.method === 'GET' && p === '/api/product-uploads') {
      return json(res, 200, productUploadContext(req, url));
    }
    if (p === '/api/product-uploads/stage') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return json(res, 405, { ok: false, error: 'method not allowed' });
      }
      return stageProductUploadRequest(req, res);
    }
    if (p === '/api/product-uploads/confirm') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return json(res, 405, { ok: false, error: 'method not allowed' });
      }
      return confirmProductUploadRequest(req, res);
    }
    if (req.method === 'GET' && p.startsWith('/api/history/')) {
      const id = decodeURIComponent(p.slice('/api/history/'.length));
      const storeKey = url.searchParams.get('store');
      const date = url.searchParams.get('date');
      const page = Number(url.searchParams.get('page') || 1);
      const runId = url.searchParams.get('runId') || '';
      if (!CHECK_IDS.has(id) || !stores.some((store) => store.key === storeKey)) {
        return json(res, 404, { ok: false, error: 'unknown check or store' });
      }
      if (!validHistoryDate(date) || !Number.isSafeInteger(page) || page < 1 || page > 100000 || runId.length > 200) {
        return json(res, 400, { ok: false, error: 'invalid history selection' });
      }
      const history = publicHistory(id, storeKey, date, runId, page);
      if (!history) return json(res, 404, { ok: false, error: 'run not found for this store and date' });
      return json(res, 200, history);
    }
    if (req.method === 'GET' && p.startsWith('/api/check/')) {
      const id = decodeURIComponent(p.slice('/api/check/'.length));
      if (!CHECK_IDS.has(id)) return json(res, 404, { ok: false, error: 'unknown check' });
      const report = publicReport(id);
      if (!report) return json(res, 404, { ok: false, error: 'no report yet' });
      return json(res, 200, report);
    }
    if (req.method === 'GET' && p === '/shot') {
      const f = url.searchParams.get('f');
      if (!f) return json(res, 400, { ok: false, error: 'missing f' });
      return serveShot(res, f);
    }
    if (req.method === 'GET' && p === '/evidence') {
      const f = url.searchParams.get('f');
      if (!f) return json(res, 400, { ok: false, error: 'missing f' });
      return serveEvidenceViewer(res, f);
    }
    const knownPath = p === '/' || p === '/index.html' || p === '/login' || p === '/logout'
      || p === '/api/status' || p === '/api/progress' || p === '/api/views' || p.startsWith('/api/view/')
      || p === '/api/users' || p.startsWith('/api/users/') || p === '/api/account/password'
      || p === '/api/ads-rules'
      || p === '/api/product-uploads' || p === '/api/product-uploads/stage'
      || p === '/api/product-uploads/confirm' || p === '/shot' || p === '/evidence' || p.startsWith('/api/check/') || p.startsWith('/api/history/');
    if (knownPath) {
      res.setHeader('Allow', p === '/logout' ? 'POST' : 'GET');
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    process.stderr.write(`看板请求处理失败: ${safeData(String(e?.message || e))}\n`);
    if (!res.headersSent) return json(res, 500, { ok: false, error: 'internal server error' });
    return res.end();
  }
});

server.headersTimeout = 15_000;
server.requestTimeout = 65_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  process.stdout.write(`看板已启动: http://${HOST === '0.0.0.0' ? '0.0.0.0' : HOST}:${PORT}\n`);
  process.stdout.write(`接收接口: POST /api/ingest${INGEST_TOKEN ? '（独立令牌保护）' : '（已禁用）'}\n`);
  process.stdout.write(`登录保护: ${AUTH_ENABLED ? '已启用' : '未启用（仅限本机开发）'}\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(`端口 ${PORT} 已被占用。换端口: PORT=8080 node src/server.js\n`);
  } else if (e.code === 'EACCES') {
    process.stderr.write(`没有权限绑定端口 ${PORT}（Linux 上 <1024 需要 root）。换端口: PORT=8080 node src/server.js\n`);
  } else {
    process.stderr.write(`服务启动失败: ${e.message}\n`);
  }
  process.exit(1);
});
