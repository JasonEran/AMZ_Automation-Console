import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runGenericCheck } from '../lib/check-runner.js';
import { redactText } from '../lib/redact.js';
import { GENERIC_BY_ID } from './definitions.js';
import { runAsinHealth } from './asin-health.js';
import { runStoreHealth } from './store-health.js';
import { CHECKS, CHECK_TOTAL, checksForSlot, getCheck } from './registry.js';
import { applyProgressEvent, createProgressCells } from '../lib/run-progress.js';
import { readAdsMonitoring } from '../lib/ads-monitoring.js';
import { scopedReviewsCheck } from '../lib/reviews-collector.js';
import { adsPortfolioCheck } from '../lib/ads-portfolio-collector.js';

function runtimePaths(outDir) {
  const dir = path.join(outDir, 'runtime');
  return { dir, lock: path.join(dir, 'run.lock'), progress: path.join(dir, 'run-progress.json') };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Acquire a single-host collector lease. `wx` makes the decision atomic even
 * when two systemd timers fire in the same millisecond. */
export function acquireRunLock({ outDir, label }) {
  const files = runtimePaths(outDir);
  fs.mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const record = { version: 1, token, pid: process.pid, label, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(files.lock, 'wx', 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); } finally { fs.closeSync(fd); }
      return { ...record, file: files.lock, progressFile: files.progress };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let incumbent = null;
      let ageMs = 0;
      try {
        incumbent = JSON.parse(fs.readFileSync(files.lock, 'utf8'));
        ageMs = Date.now() - fs.statSync(files.lock).mtimeMs;
      } catch { /* malformed lock is treated as active until it ages out */ }
      const stale = incumbent ? !processAlive(Number(incumbent.pid)) : ageMs > 6 * 60 * 60 * 1000;
      if (!stale) {
        const e = new Error(`已有巡检运行中（pid=${incumbent?.pid || 'unknown'}，任务=${incumbent?.label || 'unknown'}）`);
        e.code = 'RUN_ALREADY_ACTIVE';
        throw e;
      }
      const staleFile = `${files.lock}.stale-${Date.now()}`;
      try { fs.renameSync(files.lock, staleFile); } catch (renameError) {
        if (renameError?.code !== 'ENOENT') throw renameError;
      }
    }
  }
  throw new Error('无法取得巡检运行锁');
}

export function writeRunProgress(lease, patch) {
  const prior = (() => {
    try {
      const value = JSON.parse(fs.readFileSync(lease.progressFile, 'utf8'));
      return value.leaseToken === lease.token ? value : {};
    } catch { return {}; }
  })();
  const next = {
    version: 2,
    ...prior,
    ...patch,
    runId: prior.runId || randomUUID(),
    leaseToken: lease.token,
    pid: process.pid,
    label: lease.label,
    updatedAt: new Date().toISOString(),
  };
  atomicJson(lease.progressFile, next);
  return next;
}

function recordProgressEvent(lease, event) {
  const raw = JSON.parse(fs.readFileSync(lease.progressFile, 'utf8'));
  if (raw.leaseToken !== lease.token) return;
  writeRunProgress(lease, applyProgressEvent(raw, event));
}

export function releaseRunLock(lease) {
  try {
    const current = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
    if (current.token === lease.token && Number(current.pid) === process.pid) fs.unlinkSync(lease.file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function withRunLease({ config, label, initialProgress }, fn) {
  const lease = acquireRunLock({ outDir: config.outDir, label });
  writeRunProgress(lease, {
    state: 'RUNNING', startedAt: new Date().toISOString(), finishedAt: null,
    heartbeatAt: new Date().toISOString(), activityAt: new Date().toISOString(),
    completedChecks: 0, errors: [], abortReason: null, fatalError: null, ...initialProgress,
  });
  const heartbeat = setInterval(() => {
    try { writeRunProgress(lease, { heartbeatAt: new Date().toISOString() }); }
    catch { /* A stalled heartbeat is surfaced by the dashboard, never fabricated. */ }
  }, 5000);
  heartbeat.unref();
  try {
    const result = await fn(lease);
    const summaries = result?.checks ? Object.values(result.checks) : [result];
    const hasInfrastructureErrors = Object.keys(result?.errors || {}).length > 0
      || summaries.some((summary) => (summary?.totals?.errors || 0) > 0 || (summary?.totals?.notConfigured || 0) > 0);
    const hasFindings = summaries.some((summary) => (summary?.totals?.abnormal || 0) > 0);
    writeRunProgress(lease, {
      state: hasInfrastructureErrors ? 'COMPLETED_WITH_ERRORS' : hasFindings ? 'COMPLETED_WITH_FINDINGS' : 'COMPLETED',
      finishedAt: new Date().toISOString(), currentCheck: null, currentUnit: null,
      abortReason: null, fatalError: null,
    });
    return result;
  } catch (error) {
    writeRunProgress(lease, {
      state: 'FAILED', finishedAt: new Date().toISOString(), currentCheck: null,
      currentUnit: null,
      fatalError: redactText(String(error?.message || error)).slice(0, 300),
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    releaseRunLock(lease);
  }
}

/**
 * One entry point for all 9 checks.
 *
 * Item 1 keeps its own purpose-built implementation (it is the most thoroughly
 * tested path) and item 5 needs a per-ASIN loop, so those two dispatch to
 * dedicated runners; the remaining seven share the generic page-check runner.
 */
export async function runCheckById({ id, zn, config, stores, logger, opts = {} }) {
  const def = getCheck(id);
  if (!def) throw new Error(`未知检查项: ${id}`);

  if (!opts._lockHeld) {
    return withRunLease({
      config,
      label: `check:${id}`,
      initialProgress: {
        slot: opts.slot || 'adhoc', totalChecks: 1, checkIds: [id], currentCheck: id,
        storeTotal: stores.length, completedUnits: 0, currentUnit: null,
        cells: createProgressCells([id], stores),
      },
    }, async (lease) => {
      const onProgress = (event) => {
        recordProgressEvent(lease, event);
        opts.onProgress?.(event);
      };
      const result = await runCheckById({
        id, zn, config, stores, logger, opts: { ...opts, _lockHeld: true, onProgress },
      });
      recordProgressEvent(lease, { type: 'check-complete', check: id, results: result?.results, skipped: result?.skipped });
      writeRunProgress(lease, {
        completedChecks: 1,
        currentCheck: null,
        currentCheckTotals: result?.totals || null,
      });
      return result;
    });
  }

  // The ads check needs to know which window it is running in to know whether
  // "all on" or "all off" is the correct state.
  if (id === 'ads-status' && readAdsMonitoring(config.outDir).paused) {
    logger.info('[ads-status] 广告监测已暂停，本次跳过');
    return { check: id, skipped: true, skipReason: '广告监测已暂停', results: [],
      totals: { total: 0, ok: 0, abnormal: 0, errors: 0, warnings: 0, notConfigured: 0 } };
  }
  config._currentSlot = opts.slot || 'adhoc';

  if (id === 'store-health') return runStoreHealth({ zn, config, stores, logger, opts });
  if (id === 'asin-health') return runAsinHealth({ zn, config, stores, logger, opts });

  const generic = id === 'ads-status' && readAdsMonitoring(config.outDir).source === 'portfolios'
    ? adsPortfolioCheck : id === 'reviews' ? scopedReviewsCheck : GENERIC_BY_ID[id];
  if (!generic) throw new Error(`检查项 ${id} 缺少定义`);
  return runGenericCheck({ zn, config, stores, logger, def: { ...generic, no: def.no, title: def.title }, opts });
}

/**
 * Run every check that belongs to a slot, sequentially.
 *
 * Sequential by design: the checks share one Ziniao browser installation, and
 * two checks opening the same store at once is the one collision the pool cannot
 * protect against. Concurrency inside a single check still applies.
 */
export async function runSlot({ slot, zn, config, stores, logger, opts = {} }) {
  const ids = opts.only?.length ? opts.only : checksForSlot(slot);
  if (!opts._lockHeld) {
    return withRunLease({
      config,
      label: `slot:${slot}`,
      initialProgress: {
        slot, totalChecks: ids.length, checkIds: ids, storeTotal: stores.length,
        currentCheck: null, currentUnit: null, completedUnits: 0, cells: createProgressCells(ids, stores),
      },
    }, (lease) => runSlot({
      slot, zn, config, stores, logger,
      opts: { ...opts, _lockHeld: true, _lease: lease },
    }));
  }
  const startedAt = new Date();
  const out = { slot, startedAt: startedAt.toISOString(), checks: {}, errors: {} };

  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    const def = getCheck(id);
    if (!def) continue;
    if (opts._lease) recordProgressEvent(opts._lease, { type: 'check-start', check: id });
    if (opts._lease) writeRunProgress(opts._lease, {
      state: 'RUNNING', currentCheck: id, currentCheckNo: def.no,
      completedChecks: index, currentCheckStartedAt: new Date().toISOString(),
    });
    logger.info(`━━━ [${def.no}/${CHECK_TOTAL}] ${def.title} ━━━`);
    try {
      const onProgress = (event) => {
        if (opts._lease) recordProgressEvent(opts._lease, event);
        opts.onProgress?.(event);
      };
      out.checks[id] = await runCheckById({
        id, zn, config, stores, logger, opts: { ...opts, slot, _lockHeld: true, onProgress },
      });
      if (opts._lease) recordProgressEvent(opts._lease, {
        type: 'check-complete', check: id, results: out.checks[id]?.results, skipped: out.checks[id]?.skipped,
      });
      if (opts._lease) writeRunProgress(opts._lease, {
        completedChecks: index + 1,
        currentCheckTotals: out.checks[id]?.totals || null,
      });
    } catch (e) {
      logger.error(`[${id}] 执行失败: ${redactText(e.message)}`);
      out.errors[id] = redactText(e.message);
      if (opts._lease) recordProgressEvent(opts._lease, { type: 'check-complete', check: id, failed: true });
      if (opts._lease) writeRunProgress(opts._lease, {
        completedChecks: index + 1,
        errors: Object.entries(out.errors).map(([check, message]) => ({ check, message })),
      });
    }
  }
  out.finishedAt = new Date().toISOString();
  return out;
}

export { CHECKS, CHECK_TOTAL, getCheck, checksForSlot };
