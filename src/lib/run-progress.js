import fs from 'node:fs';
import path from 'node:path';
import { CHECKS } from '../checks/registry.js';

const CHECK_IDS = new Set(CHECKS.map((check) => check.id));
const TERMINAL = new Set(['COMPLETED', 'ERROR', 'SKIPPED']);
const RUN_STATES = new Set(['RUNNING', 'COMPLETED', 'COMPLETED_WITH_FINDINGS', 'COMPLETED_WITH_ERRORS', 'FAILED', 'IDLE']);
const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

export function createProgressCells(checkIds, stores) {
  return [...new Set(checkIds)].filter((id) => CHECK_IDS.has(id)).flatMap((check) =>
    [...new Set(stores.map((store) => store.key))].map((storeKey) => ({
      check, storeKey, state: 'QUEUED', completed: 0, total: 1,
      startedAt: null, updatedAt: null, finishedAt: null,
    })));
}

/** Events describe execution, independently of the previous business verdict. */
export function applyProgressEvent(raw, event, now = new Date().toISOString()) {
  const next = structuredClone(raw);
  const cells = (next.cells || []).filter((cell) => cell.check === event.check);
  next.activityAt = now;
  if (event.type === 'check-start') {
    next.currentCheck = event.check;
    next.currentCheckStartedAt = now;
    next.completedUnits = 0;
    next.currentUnit = null;
  } else if (event.type === 'asin-plan') {
    for (const cell of cells) {
      const planned = event.stores.find((store) => store.storeKey === cell.storeKey);
      cell.total = count(planned?.total);
      cell.completed = 0;
      cell.completedAsins = [];
      if (!cell.total) Object.assign(cell, { state: 'SKIPPED', finishedAt: now });
    }
  } else if (event.type === 'check-complete') {
    for (const cell of cells) {
      const results = (event.results || []).filter((result) => result.storeKey === cell.storeKey);
      const failed = Boolean(event.failed) || results.some((result) => result.severity === 'ERROR' || result.status === 'NOT_CONFIGURED');
      cell.state = failed ? 'ERROR' : event.skipped || !results.length ? 'SKIPPED' : 'COMPLETED';
      cell.completed = cell.total;
      cell.currentAsin = null;
      cell.finishedAt = now;
      cell.updatedAt = now;
      if (results.length === 1) { cell.status = results[0].status; cell.severity = results[0].severity; }
    }
    next.currentUnit = null;
  } else {
    const cell = cells.find((item) => item.storeKey === event.storeKey);
    if (!cell) return next;
    cell.updatedAt = now;
    if (event.phase === 'started') {
      cell.state = 'RUNNING';
      cell.startedAt ||= now;
      cell.currentAsin = event.asin || null;
      next.currentUnit = { check: event.check, storeKey: event.storeKey, asin: event.asin || null };
    } else if (event.type === 'asin') {
      cell.completedAsins ||= [];
      if (!cell.completedAsins.includes(event.asin)) cell.completedAsins.push(event.asin);
      cell.completed = Math.min(cell.total, cell.completedAsins.length);
      cell.currentAsin = null;
      // A queue-tail retry may follow; only the store-finished event closes the cell.
    } else if (event.type === 'store') {
      cell.state = event.severity === 'ERROR' || event.status === 'NOT_CONFIGURED' ? 'ERROR' : 'COMPLETED';
      cell.completed = cell.total;
      cell.status = event.status || null;
      cell.severity = event.severity || null;
      cell.currentAsin = null;
      cell.finishedAt = now;
    }
  }
  next.completedUnits = cells.reduce((total, cell) => total + count(cell.completed), 0);
  return next;
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** Only expose the documented progress fields; no PID, lock token or raw errors. */
export function normalizeRunProgress(raw = {}, { alive = false, now = Date.now() } = {}) {
  let state = RUN_STATES.has(raw.state) ? raw.state : 'IDLE';
  if (state === 'RUNNING' && !alive) state = 'INTERRUPTED';
  const active = state === 'RUNNING';
  const heartbeatAt = date(raw.heartbeatAt || raw.updatedAt);
  const heartbeatAgeMs = heartbeatAt ? Math.max(0, now - Date.parse(heartbeatAt)) : null;
  const delayed = active && (heartbeatAgeMs === null || heartbeatAgeMs > 30000);
  const cells = (Array.isArray(raw.cells) ? raw.cells : []).filter((cell) =>
    CHECK_IDS.has(cell?.check) && typeof cell.storeKey === 'string').map((cell) => {
    let cellState = ['QUEUED', 'RUNNING', 'COMPLETED', 'ERROR', 'SKIPPED'].includes(cell.state) ? cell.state : 'QUEUED';
    if (!active && ['QUEUED', 'RUNNING'].includes(cellState)) cellState = 'INTERRUPTED';
    const total = count(cell.total);
    return {
      check: cell.check, storeKey: cell.storeKey.slice(0, 100), state: cellState,
      total, completed: Math.min(total, count(cell.completed)),
      currentAsin: /^[A-Z0-9]{10}$/.test(cell.currentAsin || '') ? cell.currentAsin : null,
      status: typeof cell.status === 'string' ? cell.status.slice(0, 60) : null,
      severity: ['OK', 'WARN', 'CRITICAL', 'ERROR'].includes(cell.severity) ? cell.severity : null,
      startedAt: date(cell.startedAt), updatedAt: date(cell.updatedAt), finishedAt: date(cell.finishedAt),
    };
  });
  const check = CHECK_IDS.has(raw.currentCheck) ? raw.currentCheck : CHECK_IDS.has(raw.check || raw.checkId) ? raw.check || raw.checkId : null;
  const checkIds = Array.isArray(raw.checkIds) ? [...new Set(raw.checkIds.filter((id) => CHECK_IDS.has(id)))] : check ? [check] : [];
  const running = active ? cells.filter((cell) => cell.state === 'RUNNING') : [];
  // Overall progress counts store/check pairs, so ASIN counts cannot overflow
  // a store denominator. Inside an ASIN cell, completed products add a fraction.
  const total = cells.length || count(raw.totalChecks) * count(raw.storeTotal)
    || count(raw.total ?? raw.totalSteps ?? raw.storesTotal);
  const completed = cells.length ? cells.filter((cell) => TERMINAL.has(cell.state)).length
    : Math.min(total, count(raw.completed ?? raw.completedSteps ?? raw.storesCompleted
      ?? count(raw.completedChecks) * count(raw.storeTotal) + (check ? Math.min(count(raw.storeTotal), count(raw.completedUnits)) : 0)));
  const fraction = cells.length ? cells.reduce((sum, cell) => sum + (TERMINAL.has(cell.state) ? 1
    : cell.total ? Math.min(0.99, cell.completed / cell.total) : 0), 0) : completed;
  const finished = ['COMPLETED', 'COMPLETED_WITH_FINDINGS', 'COMPLETED_WITH_ERRORS'].includes(state);
  const percent = finished ? 100 : total ? Math.min(active ? 99 : 100, Math.floor(fraction * 100 / total)) : 0;
  const storeKeys = [...new Set(cells.map((cell) => cell.storeKey))];
  const stores = storeKeys.map((storeKey) => {
    const selected = cells.filter((cell) => cell.storeKey === storeKey);
    const done = selected.filter((cell) => TERMINAL.has(cell.state)).length;
    const current = selected.find((cell) => cell.state === 'RUNNING');
    const storeFraction = selected.reduce((sum, cell) => sum + (TERMINAL.has(cell.state) ? 1
      : cell.total ? Math.min(0.99, cell.completed / cell.total) : 0), 0);
    return {
      storeKey, completed: done, total: selected.length,
      percent: Math.floor(storeFraction * 100 / selected.length),
      state: current ? 'RUNNING' : selected.some((cell) => cell.state === 'QUEUED') ? 'QUEUED'
        : selected.some((cell) => cell.state === 'INTERRUPTED') ? 'INTERRUPTED'
          : selected.some((cell) => cell.state === 'ERROR') ? 'ERROR' : 'COMPLETED',
      check: current?.check || null, currentAsin: current?.currentAsin || null,
    };
  });
  return {
    state, active, delayed, heartbeatAt, heartbeatAgeMs,
    runId: typeof raw.runId === 'string' ? raw.runId.slice(0, 128) : null,
    slot: typeof raw.slot === 'string' ? raw.slot.slice(0, 32) : null,
    check, checkIds, totalChecks: checkIds.length || count(raw.totalChecks), completedChecks: count(raw.completedChecks),
    store: running.map((cell) => cell.storeKey).join('、') || null,
    startedAt: date(raw.startedAt), finishedAt: date(raw.finishedAt), updatedAt: date(raw.updatedAt),
    activityAt: date(raw.activityAt), total, completed: finished ? total : completed, percent, cells, stores,
  };
}

export function readRuntimeProgress(outDir, options = {}) {
  const dir = path.join(outDir, 'runtime');
  let raw, lock;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'run-progress.json'), 'utf8')); }
  catch { return normalizeRunProgress({}, options); }
  try { lock = JSON.parse(fs.readFileSync(path.join(dir, 'run.lock'), 'utf8')); } catch { /* no live lease */ }
  const alive = Boolean(lock && lock.pid === raw.pid && lock.label === raw.label
    && (!raw.leaseToken || raw.leaseToken === lock.token) && processIsAlive(Number(raw.pid)));
  return normalizeRunProgress(raw, { ...options, alive });
}
