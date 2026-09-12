import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bjDateKey } from './time.js';

const DEFAULT_STALE_AFTER_MS = 36 * 60 * 60 * 1000;
const DEFAULT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const visit = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(file);
    }
  };
  visit(dir);
  return files;
}

function explicitReportTime(report) {
  const raw = report?.finishedAt || report?.startedAt || report?._ingestedAt || '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function reportTime(report, file) {
  const explicit = explicitReportTime(report);
  if (explicit !== null) return explicit;
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function resultTime(result, fallback) {
  const parsed = Date.parse(result?.checkedAt || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function snapshotEntry(entry, results, time, nowMs, staleAfterMs) {
  return {
    ...entry,
    results,
    time,
    stale: nowMs - time > staleAfterMs,
    ageMs: Math.max(0, nowMs - time),
    _resultTime: time,
  };
}

function validReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  if (report.skipped) return typeof report.check === 'string' || typeof report.runId === 'string';
  if (!Array.isArray(report.results) || report.results.length > 10_000) return false;
  return report.results.every((result) => result && typeof result === 'object' && !Array.isArray(result));
}

/**
 * Load append-only report history for one check. Corrupt/unstructured reports
 * and reports timestamped implausibly in the future are ignored. `latest.json`
 * remains a fallback, while duplicate run ids are collapsed so a single-store
 * rerun never hides newer snapshots belonging to other stores.
 */
export function readCheckHistory({
  outDir,
  checkId,
  now = new Date(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  futureToleranceMs = DEFAULT_FUTURE_TOLERANCE_MS,
}) {
  const dir = path.join(outDir, checkId);
  const byRun = new Map();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  for (const file of jsonFiles(dir)) {
    let report;
    try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!validReport(report)) continue;
    if (typeof report.check === 'string' && report.check !== checkId) continue;
    const explicit = explicitReportTime(report);
    if (explicit !== null && explicit > nowMs + futureToleranceMs) continue;
    const time = reportTime(report, file);
    if (!Number.isFinite(time) || time <= 0) continue;
    const key = report.runId || `${report.startedAt || ''}|${report.finishedAt || ''}|${file}`;
    const candidate = {
      report,
      file,
      time,
      stale: nowMs - time > staleAfterMs,
      ageMs: Math.max(0, nowMs - time),
    };
    const previous = byRun.get(key);
    if (!previous || candidate.time >= previous.time) byRun.set(key, candidate);
  }
  return [...byRun.values()].sort((a, b) => a.time - b.time || a.file.localeCompare(b.file));
}

/** Return the newest valid report fragment for each store, independently. */
export function latestStoreSnapshots(options) {
  const stores = new Map();
  const nowMs = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
  const staleAfterMs = Number(options.staleAfterMs || DEFAULT_STALE_AFTER_MS);
  for (const entry of readCheckHistory(options)) {
    const grouped = new Map();
    for (const result of entry.report.results || []) {
      const key = result.storeKey || result.storeName;
      if (!key || typeof key !== 'string') continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(result);
    }
    for (const [key, results] of grouped) {
      if (options.checkId !== 'asin-health') {
        const candidateTime = Math.max(...results.map((result) => resultTime(result, entry.time)));
        const previous = stores.get(key);
        if (!previous || candidateTime >= previous._resultTime) {
          stores.set(key, snapshotEntry(entry, results, candidateTime, nowMs, staleAfterMs));
        }
        continue;
      }
      const previous = stores.get(key);
      // A scheduled/full ASIN report is authoritative for the store's current
      // set. A targeted recovery updates only its requested product and must
      // not hide the other products from that store. Older reports predate the
      // explicit marker, so a one-row report is treated as targeted only when
      // an earlier multi-row baseline exists.
      const explicitTargeted = entry.report.selection?.targeted;
      const targeted = explicitTargeted === true
        || (explicitTargeted === undefined && results.length === 1 && previous?.results?.length > 1);
      const merged = new Map();
      if (targeted && previous) {
        for (const result of previous.results || []) {
          const asin = String(result?.asin || '').toUpperCase();
          merged.set(`${String(result?.market || 'US').toUpperCase()}:${asin}`, result);
        }
      }
      for (const result of results) {
        const asin = String(result?.asin || '').toUpperCase();
        const itemKey = `${String(result?.market || 'US').toUpperCase()}:${asin}`;
        const prior = merged.get(itemKey);
        if (!prior || resultTime(result, entry.time) >= resultTime(prior, previous?._resultTime || 0)) {
          merged.set(itemKey, result);
        }
      }
      if (!targeted && previous) {
        // A full report defines the inventory set that existed when that run
        // started. Preserve only targeted item results collected after that
        // snapshot, and never let a long-running older full batch roll them
        // back when it happens to finish later.
        const selectionTime = Date.parse(entry.report.startedAt || '');
        const coverageTime = Number.isFinite(selectionTime) ? selectionTime : entry.time;
        for (const prior of previous.results || []) {
          const asin = String(prior?.asin || '').toUpperCase();
          const itemKey = `${String(prior?.market || 'US').toUpperCase()}:${asin}`;
          const current = merged.get(itemKey);
          const priorTime = resultTime(prior, previous._resultTime || 0);
          if (
            (current && priorTime > resultTime(current, entry.time))
            || (!current && priorTime > coverageTime)
          ) {
            merged.set(itemKey, prior);
          }
        }
      }
      const mergedResults = [...merged.values()];
      const candidateTime = Math.max(...mergedResults.map((result) => resultTime(result, entry.time)));
      stores.set(key, snapshotEntry(entry, mergedResults, candidateTime, nowMs, staleAfterMs));
    }
  }
  return stores;
}

/**
 * Compose the latest effective result set for a check.  This is the same
 * per-store view used by the matrix, so a later single-store rerun cannot hide
 * still-current results from other stores on /api/check/:id.
 */
export function latestEffectiveCheck(options) {
  const snapshots = [...latestStoreSnapshots(options).entries()];
  if (!snapshots.length) return null;
  const newest = snapshots.reduce((best, [, entry]) => (!best || entry.time > best.time ? entry : best), null);
  return {
    results: snapshots.flatMap(([, entry]) => entry.results || []),
    newest,
    stale: snapshots.every(([, entry]) => entry.stale),
    sources: snapshots.map(([storeKey, entry]) => ({
      storeKey,
      runId: entry.report.runId || null,
      finishedAt: entry.report.finishedAt || entry.report.startedAt || null,
      stale: Boolean(entry.stale),
    })),
  };
}

/** Chronological report fragments for a single store, suitable for trends. */
export function storeHistory({ outDir, checkId, storeKey, limit = 14, ...options }) {
  const rows = [];
  for (const entry of readCheckHistory({ outDir, checkId, ...options })) {
    const results = (entry.report.results || []).filter(
      (result) => (result.storeKey || result.storeName) === storeKey,
    );
    if (results.length) rows.push({ ...entry, results });
  }
  return rows.slice(-Math.max(1, Math.min(100, Number(limit) || 14)));
}

/** Collection days, not review publication dates or a batch's finish date.
 * Keep every run, including repeated collections and cross-midnight batches. */
export function storeHistoryDays({ storeKey, ...options }) {
  const days = new Map();
  for (const entry of readCheckHistory(options)) {
    const groups = new Map();
    for (const result of entry.report.results || []) {
      if ((result.storeKey || result.storeName) !== storeKey) continue;
      const time = resultTime(result, entry.time);
      const date = bjDateKey(new Date(time));
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push(result);
    }
    for (const [date, results] of groups) {
      const time = Math.max(...results.map((result) => resultTime(result, entry.time)));
      // A legacy report may have no runId. Never expose a filesystem path as its ID.
      const runId = entry.report.runId || createHash('sha256').update(entry.file).digest('hex');
      if (!days.has(date)) days.set(date, []);
      days.get(date).push({ ...entry, results, time, date, runId, at: new Date(time).toISOString() });
    }
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, runs]) => ({
    date, runs: runs.sort((a, b) => a.time - b.time || a.runId.localeCompare(b.runId)),
  }));
}

export function validHistoryDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

/** Paginate stored items before public serialization, so long review lists
 * are inspectable in full without a silent 500-item response truncation. */
export function historyRecordsPage(run, page = 1, pageSize = 20) {
  const total = (run?.results || []).reduce((sum, result) => sum + Math.max(1, result.items?.length || 0), 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.max(1, Math.min(pages, Number(page) || 1));
  const start = (current - 1) * pageSize, end = start + pageSize;
  const records = [];
  let index = 0;
  for (const result of run?.results || []) {
    for (const item of result.items?.length ? result.items : [null]) {
      if (index >= start && index < end) records.push({ result, item });
      index++;
      if (index >= end) break;
    }
    if (index >= end) break;
  }
  return { records, total, page: current, pages, pageSize };
}

export const DASHBOARD_HISTORY_DEFAULTS = {
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
  futureToleranceMs: DEFAULT_FUTURE_TOLERANCE_MS,
};
