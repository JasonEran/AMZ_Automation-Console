import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from './config.js';
import { bjParts, parseHHMM } from './time.js';
import { collectorLockReason, restartZiniaoService } from './ziniao-restart.js';

/** One automatic pass after a slot exits with collection failures.
 * Business verdicts that already collected are not repeated. Unknown delivery
 * statuses stay failed closed. Ziniao is restarted only when startBrowser
 * timed out before NETWORK and no collector holds the run lock. */
export const PAGE_READ_WAIT_MS = 3 * 60 * 1000;
export const UNIT_BUDGET_MS = 3 * 60 * 1000;
export const SLOT_CLEARANCE_MS = 2 * 60 * 1000;
export const ZINIAO_SETTLE_MS = 20 * 1000;
export const MAX_PLAN_AGE_MS = 15 * 60 * 1000;
export const REQUEST_NAME = 'collection-recovery.request';
const ZINIAO_PORT = 18888;

const FAILURE_STATUS = new Set([
  'ERROR', 'PARTIAL_EVIDENCE', 'LOGIN_REQUIRED', 'UNKNOWN', 'UNKNOWN_RATING', 'DETAIL_ERROR',
]);
const EXCLUDED_STATUS = new Set([
  'HEALTHY', 'AT_RISK', 'UNHEALTHY', 'CRITICAL', 'DEACTIVATED',
  'CLEAR', 'OK', 'LOW_RATING', 'TODAY_LOW_RATING', 'RECORDED_LOW_RATING',
  'LOW_REVIEW', 'RECORDED_LOW_REVIEW', 'POOR_CX', 'RECORDED_BUSINESS_EVENT',
  'RECORDED_PERFORMANCE_EVENT', 'INACTIVE_LISTING', 'NO_CART', 'PAGE_NOT_FOUND',
  'UNAVAILABLE', 'RATING_DROP', 'NO_CHANGE', 'EMPTY', 'REGISTERED',
  'ALL_OFF', 'ALL_ON', 'MAJORITY_OFF', 'MAJORITY_ON', 'SHOULD_BE_OFF',
  'SHOULD_BE_ON', 'ADS_SPLIT', 'ADS_OBSERVED', 'INFO', 'NEW_BUYER_MESSAGE',
  'NOT_CONFIGURED', 'BLOCKED', 'REVIEW_OWNERSHIP_UNKNOWN',
]);
const STORE_CHECKS = new Set([
  'store-health', 'performance', 'feedback', 'inbox', 'reviews', 'outlet', 'voc',
]);
const STORE_KEY = /^[A-Za-z0-9._-]{1,64}$/;
const ASIN = /^B0[A-Z0-9]{8}$/;
const SAFETY_PROBE = /^(?:LIVE_SAFETY_PROBE_INCOMPLETE|LIVE_SAFETY_PROBE_UNAVAILABLE|PAGE_CHANGED_[A-Z0-9_]+)$/;

function textOf(result) {
  return [result?.error, ...(result?.anomalyReasons || []), ...(result?.notes || [])].join('\n');
}

export function isStartBrowserTimeout(result) {
  const text = textOf(result);
  return /startBrowser|WebDriver HTTP 服务不可用/.test(text)
    && /timeout|timed out|aborted/i.test(text);
}

function safetyCode(result) {
  return String(result?.evidence?.safety?.code || '');
}

function isSecurityCleanup(result) {
  return textOf(result).includes('SECURITY_CLEANUP_FAILED')
    || safetyCode(result) === 'SECURITY_CLEANUP_FAILED';
}

/** A page was read far enough to reject an unrecognized delivery status.
 * Retrying cannot make that status known. */
export function isUnknownStatusClosure(result) {
  const unknown = Number(result?.metrics?.unknown);
  return Number.isFinite(unknown) && unknown > 0;
}

export function isRetryableCollectionFailure(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.metrics?.collectionStatus === 'COMPLETE') return false;
  if (isSecurityCleanup(result) || isUnknownStatusClosure(result)) return false;
  const status = String(result.status || '');
  if (EXCLUDED_STATUS.has(status)) return false;
  if (isStartBrowserTimeout(result)) return true;
  if (SAFETY_PROBE.test(safetyCode(result))) return true;
  if (FAILURE_STATUS.has(status)) return true;
  return FAILURE_STATUS.has(String(result.metrics?.collectionStatus || ''))
    && !EXCLUDED_STATUS.has(status);
}

export function startupNetworkState(logText, storeTokens) {
  const tokens = [...new Set((storeTokens || [])
    .map((token) => String(token || '').trim().toLowerCase())
    .filter((token) => token.length >= 2))];
  if (!tokens.length) return 'unknown';
  const stages = new Map(tokens.map((token) => [token, null]));
  for (const line of String(logText || '').split(/\n/)) {
    const lower = line.toLowerCase();
    const mentioned = tokens.filter((token) => lower.includes(token));
    if (mentioned.length !== 1) continue;
    if (line.includes('BLACK_AND_WHITE')) stages.set(mentioned[0], 'BLACK_AND_WHITE');
    else if (/\bNETWORK\b/.test(line)) stages.set(mentioned[0], 'NETWORK');
  }
  const values = tokens.map((token) => stages.get(token)).filter(Boolean);
  if (values.includes('NETWORK')) return 'reached';
  if (values.includes('BLACK_AND_WHITE')) return 'before-network';
  return 'unknown';
}

function addCalendarDays(parts, offset) {
  const utc = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offset));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function shanghaiDate(day, hour, minute) {
  return new Date(Date.UTC(day.year, day.month - 1, day.day, hour - 8, minute, 0, 0));
}

export function nextSlotAt(slots, now) {
  const parts = bjParts(now);
  let best = null;
  for (let offset = 0; offset <= 1; offset += 1) {
    const day = addCalendarDays(parts, offset);
    for (const slot of slots || []) {
      let hm;
      try { hm = parseHHMM(slot.at); } catch { continue; }
      const at = shanghaiDate(day, hm.hour, hm.minute);
      if (at.getTime() <= now.getTime()) continue;
      if (!best || at.getTime() < best.at.getTime()) best = { name: slot.name, at };
    }
  }
  return best;
}

export function recoverySpec({ check, storeKey, asin, slot }) {
  const store = String(storeKey || '');
  if (!STORE_KEY.test(store)) return null;
  if (check === 'asin-health') {
    const id = String(asin || '').trim().toUpperCase();
    if (!ASIN.test(id)) return null;
    return `asin-health-${id}:${store}`;
  }
  if (check === 'ads-status') {
    if (slot !== 'ads-off' && slot !== 'ads-on') return null;
    return `ads-status-${slot === 'ads-off' ? 'off' : 'on'}:${store}`;
  }
  if (!STORE_CHECKS.has(check)) return null;
  return `${check}:${store}`;
}

/** Arguments accepted by deploy/manual-run.sh for a read-only rerun.
 * Whole-slot and product-upload actions are rejected. */
export function manualArgv(spec) {
  const text = String(spec || '');
  const split = text.indexOf(':');
  if (split <= 0 || split !== text.lastIndexOf(':')) return null;
  const action = text.slice(0, split);
  const storeKey = text.slice(split + 1);
  if (!STORE_KEY.test(storeKey)) return null;
  if (STORE_CHECKS.has(action)) return ['run-check', action, '--store', storeKey];
  const asin = /^asin-health-(B0[A-Z0-9]{8})$/.exec(action);
  if (asin) return ['run-check', 'asin-health', '--store', storeKey, '--asin', asin[1]];
  if (action === 'ads-status-off' || action === 'ads-status-on') {
    return ['run-check', 'ads-status', '--store', storeKey, '--slot', action.endsWith('off') ? 'ads-off' : 'ads-on'];
  }
  return null;
}

function kindFor(results, networkState) {
  if (results.some(isStartBrowserTimeout)) {
    if (networkState === 'before-network') return 'start-browser-before-network';
    if (networkState === 'reached') return 'start-browser-reached';
    return 'unconfirmed-start-timeout';
  }
  return 'page-read';
}

function budgetMs(plan) {
  return (plan.restartZiniao ? ZINIAO_SETTLE_MS : 0) + plan.waitMs + plan.units.length * UNIT_BUDGET_MS;
}

function fitsBefore(nowMs, deadlineMs, plan) {
  return Number.isFinite(deadlineMs) && deadlineMs - nowMs >= budgetMs(plan);
}

/**
 * Decide the single recovery pass for a finished slot. Does not open Amazon
 * or restart anything.
 */
export function planSlotRecovery({ slot, slotOut, slots, now = new Date(), logText = '', lockHeld = false }) {
  const skipped = {
    business: 0, unknownStatus: 0, unconfirmedStart: 0, excluded: 0, security: 0, checkErrors: 0,
  };
  const grouped = new Map();
  for (const [check, summary] of Object.entries(slotOut?.checks || {})) {
    for (const result of summary?.results || []) {
      if (result?.metrics?.collectionStatus === 'COMPLETE' || EXCLUDED_STATUS.has(String(result?.status || ''))) {
        if (!result?.ok) skipped.business += 1;
        continue;
      }
      if (isSecurityCleanup(result)) { skipped.security += 1; continue; }
      if (isUnknownStatusClosure(result)) { skipped.unknownStatus += 1; continue; }
      if (!isRetryableCollectionFailure(result)) { skipped.excluded += 1; continue; }
      const storeKey = result.storeKey;
      const spec = recoverySpec({
        check: result.check || check, storeKey, asin: result.asin, slot: result.slot || slot,
      });
      if (!spec) { skipped.excluded += 1; continue; }
      if (!grouped.has(spec)) {
        grouped.set(spec, {
          spec,
          check: result.check || check,
          storeKey,
          storeName: result.storeName || null,
          asin: result.asin || null,
          results: [],
        });
      }
      grouped.get(spec).results.push(result);
    }
  }
  skipped.checkErrors = Object.keys(slotOut?.errors || {}).length;
  const units = [];
  for (const group of grouped.values()) {
    const networkState = startupNetworkState(logText, [group.storeKey, group.storeName]);
    const kind = kindFor(group.results, networkState);
    if (kind === 'unconfirmed-start-timeout') { skipped.unconfirmedStart += 1; continue; }
    units.push({ spec: group.spec, kind, storeKey: group.storeKey, storeName: group.storeName });
  }
  const kindOrder = { 'start-browser-before-network': 0, 'start-browser-reached': 1, 'page-read': 2 };
  units.sort((a, b) => (kindOrder[a.kind] - kindOrder[b.kind]) || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0));
  const restartZiniao = units.some((unit) => unit.kind === 'start-browser-before-network');
  const waitMs = units.some((unit) => unit.kind === 'page-read') ? PAGE_READ_WAIT_MS : 0;
  const next = nextSlotAt(slots, now);
  const deadlineMs = next ? next.at.getTime() - SLOT_CLEARANCE_MS : NaN;
  const plan = {
    version: 1,
    slot,
    createdAtMs: now.getTime(),
    deadlineMs,
    nextSlot: next?.name || null,
    restartZiniao,
    waitMs,
    units,
    skipped,
  };
  if (!units.length) {
    return { arm: false, reason: 'nothing-to-retry', plan, message: '没有可自动补采的采集失败。业务结论、未知状态和未能确认的 startBrowser 超时保持原样。' };
  }
  if (lockHeld) {
    return { arm: false, reason: 'lock-held', plan, message: '运行锁仍被占用，跳过自动补采，失败结果保持可见。' };
  }
  if (!fitsBefore(now.getTime(), deadlineMs, plan)) {
    const minutes = next ? Math.max(0, Math.round((next.at.getTime() - now.getTime()) / 60000)) : null;
    return {
      arm: false,
      reason: 'next-slot-too-close',
      plan,
      message: next
        ? `距下一时段 ${next.name} 约 ${minutes} 分钟，自动补采可能重叠，已跳过，失败结果保持可见。`
        : '没有下一时段，跳过自动补采，失败结果保持可见。',
    };
  }
  return {
    arm: true,
    reason: null,
    plan,
    message: `槽次 ${slot} 将在退出后自动补采 ${units.length} 项（重启紫鸟=${restartZiniao ? '是' : '否'}，页面重试前等待 ${Math.round(waitMs / 1000)} 秒），只尝试一次。`,
  };
}

function requestPath(outDir) {
  return path.join(outDir, 'runtime', REQUEST_NAME);
}

export function writeRecoveryRequest(outDir, plan) {
  const file = requestPath(outDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function readZiniaoClientLog({ homeDir = os.homedir(), logDir = '' } = {}) {
  const safeHome = path.resolve(homeDir);
  const expectedRoot = path.join(safeHome, '.config', 'ziniaobrowser', 'instances');
  const targetDir = path.resolve(logDir || path.join(expectedRoot, 'userdata1', 'logs', 'client'));
  const relative = path.relative(expectedRoot, targetDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('紫鸟日志目录不在允许的实例目录内');
  }
  if (!fs.existsSync(targetDir)) return '';
  const rootStat = fs.lstatSync(targetDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('紫鸟日志目录类型不安全');
  const files = [];
  for (const name of fs.readdirSync(targetDir)) {
    if (!name || name.startsWith('.') || name.includes('..')) continue;
    const file = path.join(targetDir, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
    files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let text = '';
  for (const item of files.slice(-8)) {
    const length = Math.min(item.size, 262144);
    const start = item.size - length;
    let fd;
    try {
      fd = fs.openSync(item.file, 'r');
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      text += `\n${buf.toString('utf8')}`;
    } catch { /* unreadable log is treated as unknown, not as NETWORK */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    if (text.length > 1_000_000) break;
  }
  return text.slice(-1_000_000);
}

function validPlan(plan, nowMs) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.units) || !plan.units.length) return false;
  if (!Number.isFinite(plan.createdAtMs) || nowMs - plan.createdAtMs > MAX_PLAN_AGE_MS || plan.createdAtMs > nowMs + 60_000) return false;
  if (!Number.isFinite(plan.deadlineMs) || (plan.waitMs !== 0 && plan.waitMs !== PAGE_READ_WAIT_MS)) return false;
  if (typeof plan.restartZiniao !== 'boolean') return false;
  const kinds = new Set(['page-read', 'start-browser-before-network', 'start-browser-reached']);
  return plan.units.every((unit) => manualArgv(unit?.spec)
    && kinds.has(unit.kind)
    && STORE_KEY.test(String(unit.storeKey || '')));
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => { socket.removeAllListeners(); socket.destroy(); resolve(open); };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForZiniaoPort({ portOpenImpl, sleep, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpenImpl(ZINIAO_PORT)) return true;
    await sleep(1000);
  }
  return false;
}

function defaultRunSpec(spec) {
  const args = manualArgv(spec);
  if (!args) return { status: 2 };
  const result = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), ...args], {
    cwd: ROOT, stdio: 'inherit',
  });
  return { status: result.status == null ? 2 : result.status };
}

export async function executeCollectionRecovery(plan, {
  now = () => new Date(),
  readLog = () => '',
  lockReason = () => null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  restart = restartZiniaoService,
  runSpec = defaultRunSpec,
  portOpenImpl = portOpen,
  outDir,
  logger = console,
} = {}) {
  const started = now();
  if (!validPlan(plan, started.getTime())) {
    return { action: 'skipped', reason: 'invalid-plan', restartedZiniao: false, results: [] };
  }
  if (lockReason()) {
    logger.warn?.('[recovery] 运行锁仍被占用，跳过自动补采，失败结果保持可见。');
    return { action: 'skipped', reason: 'lock-held', restartedZiniao: false, results: [] };
  }
  if (!fitsBefore(started.getTime(), plan.deadlineMs, plan)) {
    logger.warn?.('[recovery] 距下一时段过近，跳过自动补采，失败结果保持可见。');
    return { action: 'skipped', reason: 'next-slot-too-close', restartedZiniao: false, results: [] };
  }

  let units = plan.units.map((unit) => ({ ...unit }));
  let didRestart = false;
  if (plan.restartZiniao) {
    const logText = readLog() || '';
    const networkOf = (unit) => startupNetworkState(logText, [unit.storeKey, unit.storeName]);
    const startUnits = units.filter((unit) => unit.kind === 'start-browser-before-network');
    const stillStuck = startUnits.filter((unit) => networkOf(unit) === 'before-network');
    const reached = startUnits.filter((unit) => networkOf(unit) === 'reached');
    units = units.filter((unit) => unit.kind !== 'start-browser-before-network'
      || stillStuck.includes(unit) || reached.includes(unit));
    if (stillStuck.length) {
      try {
        await restart({ outDir });
        didRestart = true;
        const ready = await waitForZiniaoPort({ portOpenImpl, sleep, timeoutMs: ZINIAO_SETTLE_MS });
        if (!ready) throw new Error('紫鸟重启后端口未监听');
      } catch (error) {
        logger.error?.(`[recovery] 紫鸟重启未完成，停止自动补采，失败结果保持可见。${error?.message || ''}`);
        return { action: 'skipped', reason: 'restart-failed', restartedZiniao: didRestart, results: [] };
      }
    } else if (reached.length) {
      logger.info?.('[recovery] 店铺启动日志已到达 NETWORK，不重启紫鸟，只另开一次会话重试。');
    } else if (startUnits.length) {
      logger.warn?.('[recovery] 未能确认 startBrowser 在 NETWORK 之前超时，不重启紫鸟，也不重试这些启动失败。');
    }
  }
  if (!units.length) {
    return { action: 'skipped', reason: 'log-unconfirmed', restartedZiniao: didRestart, results: [] };
  }

  if (plan.waitMs > 0 && units.some((unit) => unit.kind === 'page-read')) {
    const afterRestart = now();
    const remainingMs = plan.waitMs + units.filter((unit) => unit.kind === 'page-read').length * UNIT_BUDGET_MS;
    if (afterRestart.getTime() + remainingMs > plan.deadlineMs) {
      logger.warn?.('[recovery] 等待后将重叠下一时段，跳过自动补采，失败结果保持可见。');
      return { action: 'skipped', reason: 'next-slot-too-close', restartedZiniao: didRestart, results: [] };
    }
    logger.info?.(`[recovery] 页面读取失败等待 ${Math.round(plan.waitMs / 1000)} 秒后另开一次会话，不在原浏览器里重试。`);
    await sleep(plan.waitMs);
  }

  const results = [];
  for (const unit of units) {
    const at = now();
    if (lockReason() || at.getTime() + UNIT_BUDGET_MS > plan.deadlineMs) {
      logger.warn?.(`[recovery] 停止剩余补采 ${unit.spec}，避免重叠下一时段或并发采集。`);
      for (const rest of units.slice(units.indexOf(unit))) {
        results.push({ spec: rest.spec, kind: rest.kind, status: 'skipped' });
      }
      break;
    }
    const argv = manualArgv(unit.spec);
    if (!argv) {
      results.push({ spec: unit.spec, kind: unit.kind, status: 'rejected' });
      break;
    }
    logger.info?.(`[recovery] 补采一次 ${argv.join(' ')}`);
    const ran = await runSpec(unit.spec);
    const status = Number(ran?.status);
    results.push({ spec: unit.spec, kind: unit.kind, status: Number.isFinite(status) ? status : 2 });
  }
  return { action: 'ran', reason: null, restartedZiniao: didRestart, results };
}

export function recoveryExitCode(outcome) {
  if (!outcome || outcome.action === 'idle' || outcome.reason === 'already-running') return 0;
  if (outcome.action === 'skipped') return 2;
  const statuses = (outcome.results || []).map((item) => item.status);
  if (statuses.some((status) => status === 2 || status === 'skipped' || status === 'rejected')) return 2;
  if (statuses.some((status) => status === 1)) return 1;
  return 0;
}

export async function claimAndRunRecovery({
  outDir, logger, now, readLog, lockReason, sleep, restart, runSpec, portOpenImpl,
}) {
  const file = requestPath(outDir);
  const running = path.join(outDir, 'runtime', 'collection-recovery.running');
  if (!fs.existsSync(file)) return { action: 'idle', reason: null, restartedZiniao: false, results: [] };
  if (fs.existsSync(running)) {
    logger.warn?.('[recovery] 已有补采进行中，本次不再开始。');
    return { action: 'skipped', reason: 'already-running', restartedZiniao: false, results: [] };
  }
  fs.renameSync(file, running);
  try {
    const plan = JSON.parse(fs.readFileSync(running, 'utf8'));
    const outcome = await executeCollectionRecovery(plan, {
      now, readLog, lockReason, sleep, restart, runSpec, portOpenImpl, outDir, logger,
    });
    const last = path.join(outDir, 'runtime', 'collection-recovery.last.json');
    fs.writeFileSync(last, `${JSON.stringify({ ...outcome, finishedAtMs: Date.now() })}\n`, { mode: 0o600 });
    return outcome;
  } finally {
    try { fs.rmSync(running, { force: true }); } catch { /* the request was already consumed */ }
  }
}
