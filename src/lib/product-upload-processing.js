import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeForStorage } from './redact.js';

const JOB = /^upl_[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STATES = new Set(['UNKNOWN', 'RECEIVED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED']);
const FINAL = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED']);
const ATTEMPTS = new Set(['RUNNING', 'SUCCEEDED', 'FAILED']);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status, statusCode: status });
const invalid = () => fail('UPLOAD_PROCESSING_INVALID', '上传处理结果参数无效', 400);
const corrupt = () => fail('UPLOAD_PROCESSING_CORRUPT', '上传处理结果记录无法安全核对', 503);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, names) {
  if (!object(value) || Object.keys(value).some(key => !names.includes(key))) throw invalid();
}
function instant(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw invalid();
  return date.toISOString();
}
const dateString = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function safeText(value, limit) {
  if (typeof value !== 'string' || value.length > limit * 4) throw invalid();
  return String(sanitizeForStorage(value)).replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** Invalid configured values throw; callers must not fall back to defaults. */
export function getProductUploadProcessingSettings(config = {}) {
  const supplied = config?.productUpload?.results === undefined ? {} : config.productUpload.results;
  fields(supplied, ['enabled', 'intervalMinutes', 'maxAgeHours', 'timeoutMs']);
  const value = { enabled: true, intervalMinutes: 5, maxAgeHours: 72, timeoutMs: 120000, ...supplied };
  if (typeof value.enabled !== 'boolean'
    || !Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 60
    || !Number.isInteger(value.maxAgeHours) || value.maxAgeHours < 1 || value.maxAgeHours > 168
    || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 10000 || value.timeoutMs > 180000) throw invalid();
  return { ...value, intervalMs: value.intervalMinutes * 60000, maxAgeMs: value.maxAgeHours * 3600000 };
}

function directory(dir, create = false) {
  if (create) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw corrupt();
  if (create && (stat.mode & 0o077)) throw corrupt();
}

function readJson(file, optional = false, maxBytes = 2 * 1024 * 1024) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw corrupt(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw corrupt();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw corrupt();
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0, count;
    while (size < bytes.length && (count = fs.readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
    const after = fs.fstatSync(fd);
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) throw corrupt();
    return { value: JSON.parse(bytes.subarray(0, size).toString('utf8')),
      sha256: crypto.createHash('sha256').update(bytes.subarray(0, size)).digest('hex') };
  } catch { throw corrupt(); } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function context(outDir, jobId) {
  if (typeof outDir !== 'string' || !outDir || typeof jobId !== 'string' || !JOB.test(jobId)) throw invalid();
  const root = path.resolve(outDir), uploads = path.join(root, 'product-uploads'), jobs = path.join(uploads, 'jobs');
  const jobDir = path.join(jobs, jobId);
  for (const dir of [root, uploads, jobs, jobDir]) {
    try { directory(dir); } catch { throw corrupt(); }
  }
  const record = readJson(path.join(jobDir, 'record.json'));
  const job = record.value;
  if (job?.version !== 1 || job.id !== jobId || typeof job.store?.key !== 'string'
    || !['STAGED', 'QUEUED', 'PROCESSING', 'PREPARED', 'SUBMITTING', 'COMPLETED', 'REJECTED', 'FAILED_BEFORE_SUBMIT', 'UNKNOWN', 'EXPIRED'].includes(job.state)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(job.store.key)
    || typeof job.file?.sha256 !== 'string' || !SHA.test(job.file.sha256)
    || !Number.isSafeInteger(job.file?.size) || job.file.size <= 0) throw corrupt();
  const batchId = job.result?.center?.identifiers?.batchId;
  const eligible = job.state === 'COMPLETED' && job.result?.center?.receipt?.status === 'ACCEPTED'
    && typeof batchId === 'string' && ID.test(batchId);
  const storeFingerprint = job.store.bindingFingerprint ?? null;
  if (storeFingerprint !== null && (typeof storeFingerprint !== 'string' || !SHA.test(storeFingerprint))) throw corrupt();
  const binding = { jobId, storeKey: job.store.key, sha256: job.file.sha256, recordSHA256: record.sha256,
    batchId: eligible ? batchId : null, storeFingerprint };
  const processingDir = path.join(jobDir, 'processing');
  return { job, binding, eligible, processingDir, file: path.join(processingDir, 'current.json') };
}

function normalizeSnapshot(value, binding, now) {
  fields(value, ['version', 'status', 'statusText', 'source', 'processingState', 'batchId', 'counts', 'submittedAt']);
  if ((value.version !== undefined && value.version !== 1) || !STATES.has(value.status)
    || value.source !== 'AMAZON_UPLOAD_STATUS_ROW' || value.batchId !== binding.batchId) throw invalid();
  const counts = value.counts ?? {};
  fields(counts, ['submitted', 'success', 'failed', 'warning']);
  const cleanCounts = {};
  for (const field of ['submitted', 'success', 'failed', 'warning']) {
    const n = counts[field] ?? null;
    if (n !== null && (!Number.isSafeInteger(n) || n < 0 || n > 10000000)) throw invalid();
    cleanCounts[field] = n;
  }
  if (value.status === 'COMPLETED' && (!(cleanCounts.submitted > 0)
    || cleanCounts.success !== cleanCounts.submitted || cleanCounts.failed > 0 || cleanCounts.warning > 0)) throw invalid();
  const processingState = value.processingState ?? null;
  if (processingState !== null && (typeof processingState !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(processingState))) throw invalid();
  if (value.submittedAt != null && !dateString(value.submittedAt)) throw invalid();
  return { version: 1, status: value.status, statusText: value.statusText == null ? null : safeText(value.statusText, 500),
    source: value.source, processingState, batchId: binding.batchId, counts: cleanCounts,
    ...(value.submittedAt == null ? {} : { submittedAt: new Date(value.submittedAt).toISOString() }), observedAt: instant(now) };
}

function readState(ctx) {
  try { directory(ctx.processingDir); if (fs.lstatSync(ctx.processingDir).mode & 0o077) throw corrupt(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw corrupt(); }
  const stored = readJson(ctx.file, true, 128 * 1024);
  if (!stored) return null;
  if (fs.lstatSync(ctx.file).mode & 0o077) throw corrupt();
  try {
    const value = stored.value;
    fields(value, ['version', 'binding', 'request', 'lastAttempt', 'snapshot']);
    if (value.version !== 1 || !ctx.eligible || JSON.stringify(value.binding) !== JSON.stringify(ctx.binding)) throw corrupt();
    if (value.request !== null) {
      fields(value.request, ['id', 'at', 'actor']);
      if (typeof value.request.id !== 'string' || !ID.test(value.request.id) || !dateString(value.request.at)
        || !safeText(value.request.actor, 80)) throw corrupt();
    }
    if (value.lastAttempt !== null) {
      const row = value.lastAttempt;
      fields(row, ['id', 'status', 'startedAt', 'finishedAt', 'errorCode']);
      if (typeof row.id !== 'string' || !ID.test(row.id) || !ATTEMPTS.has(row.status) || !dateString(row.startedAt)
        || (row.status === 'RUNNING' ? row.finishedAt !== null : !dateString(row.finishedAt))
        || (row.errorCode !== null && (typeof row.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(row.errorCode)))) throw corrupt();
    }
    if (value.snapshot !== null) {
      const { observedAt, ...snapshot } = value.snapshot;
      if (!dateString(observedAt)) throw corrupt();
      value.snapshot = normalizeSnapshot(snapshot, ctx.binding, observedAt);
    }
    return value;
  } catch { throw corrupt(); }
}

function initial(ctx) { return { version: 1, binding: ctx.binding, request: null, lastAttempt: null, snapshot: null }; }
function publish(ctx, value) {
  directory(ctx.processingDir, true);
  const tmp = path.join(ctx.processingDir, `.current.${crypto.randomUUID()}.tmp`);
  let fd, pending = false;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    pending = true;
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, ctx.file); pending = false;
    const dirFd = fs.openSync(ctx.processingDir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { throw fail('UPLOAD_PROCESSING_SAVE_FAILED', '上传处理结果未能确认保存，请刷新核对', 503); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (pending) { try { fs.unlinkSync(tmp); } catch { /* Keep the primary failure. */ } }
  }
}

/** Read-only; does not expire staged jobs, touch payloads or change the upload ledger. */
export function readProductUploadProcessing({ outDir, jobId }) { return readState(context(outDir, jobId)); }

/** Caller must hold the shared run lease. Repeated pending requests are idempotent. */
export function requestProductUploadProcessing({ outDir, jobId, config = {}, actor = 'dashboard', now = new Date() }) {
  if (!getProductUploadProcessingSettings(config).enabled) {
    throw fail('UPLOAD_PROCESSING_DISABLED', '上传处理结果刷新未启用', 503);
  }
  const ctx = context(outDir, jobId);
  if (!ctx.eligible) throw fail('UPLOAD_PROCESSING_NOT_ELIGIBLE', '任务缺少已接收的 Amazon 批次绑定');
  const state = readState(ctx) || initial(ctx);
  const at = instant(now), by = safeText(actor, 80);
  if (!by) throw invalid();
  if (!state.request && state.lastAttempt?.status !== 'RUNNING') {
    state.request = { id: crypto.randomUUID(), at, actor: by };
    publish(ctx, state);
  }
  return state;
}

/** Caller holds the shared run lease. One selection per job per worker invocation
 * is enforced with excludeJobIds. A prior RUNNING attempt is safe to re-read;
 * this queue never grants or repeats an Amazon upload action. */
export function nextProductUploadProcessingJob({ outDir, config = {}, now = new Date(), excludeJobIds = [] }) {
  const settings = getProductUploadProcessingSettings(config), nowMs = Date.parse(instant(now));
  if (!settings.enabled) return null;
  if (!Array.isArray(excludeJobIds) || excludeJobIds.some(id => typeof id !== 'string' || !JOB.test(id))) throw invalid();
  const jobsDir = path.join(path.resolve(outDir), 'product-uploads', 'jobs');
  try { directory(jobsDir); } catch (error) { if (error.code === 'ENOENT') return null; throw corrupt(); }
  const candidates = [];
  for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB.test(entry.name)) throw corrupt();
    if (excludeJobIds.includes(entry.name)) continue;
    const ctx = context(outDir, entry.name);
    if (!ctx.eligible) continue;
    const state = readState(ctx) || initial(ctx);
    const manual = Boolean(state.request), interrupted = state.lastAttempt?.status === 'RUNNING';
    const accepted = Date.parse(ctx.job.finishedAt || ctx.job.updatedAt || '');
    const last = Date.parse(state.lastAttempt?.finishedAt || state.lastAttempt?.startedAt || '') || 0;
    const due = !FINAL.has(state.snapshot?.status) && Number.isFinite(accepted) && nowMs >= accepted
      && nowMs - accepted <= settings.maxAgeMs && (!last || nowMs - last >= settings.intervalMs);
    if (manual || interrupted || due) candidates.push({ jobId: entry.name, reason: manual ? 'MANUAL' : 'AUTO',
      order: last || accepted || 0 });
  }
  candidates.sort((a, b) => a.order - b.order || a.jobId.localeCompare(b.jobId));
  return candidates.length ? { jobId: candidates[0].jobId, reason: candidates[0].reason } : null;
}

/** Caller holds the shared run lease throughout collection and completion. */
export function beginProductUploadProcessing({ outDir, jobId, now = new Date() }) {
  const ctx = context(outDir, jobId);
  if (!ctx.eligible) throw fail('UPLOAD_PROCESSING_NOT_ELIGIBLE', '任务缺少已接收的 Amazon 批次绑定');
  const state = readState(ctx) || initial(ctx), attemptId = crypto.randomUUID();
  state.request = null;
  state.lastAttempt = { id: attemptId, status: 'RUNNING', startedAt: instant(now), finishedAt: null, errorCode: null };
  publish(ctx, state);
  return { attemptId, job: ctx.job, binding: ctx.binding };
}

/** Exactly one snapshot or static errorCode is accepted. Stale/late completions
 * fail without changing either the prior snapshot or the immutable ledger. */
export function finishProductUploadProcessing({ outDir, jobId, attemptId, snapshot, errorCode, now = new Date() }) {
  const ctx = context(outDir, jobId), state = readState(ctx);
  if (!state || state.lastAttempt?.status !== 'RUNNING' || state.lastAttempt.id !== attemptId) {
    throw fail('UPLOAD_PROCESSING_ATTEMPT_CONFLICT', '结果刷新已变化，已拒绝迟到结果');
  }
  if ((snapshot === undefined) === (errorCode === undefined)) throw invalid();
  if (errorCode !== undefined && (typeof errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode))) throw invalid();
  const finishedAt = instant(now);
  if (Date.parse(finishedAt) < Date.parse(state.lastAttempt.startedAt)) throw invalid();
  if (snapshot !== undefined) state.snapshot = normalizeSnapshot(snapshot, ctx.binding, finishedAt);
  state.lastAttempt = { ...state.lastAttempt, status: snapshot === undefined ? 'FAILED' : 'SUCCEEDED',
    finishedAt, errorCode: errorCode || null };
  publish(ctx, state);
  return state;
}

/** UI-safe projection: no account binding, file digest, request actor or paths. */
export function publicProductUploadProcessing({ outDir, jobId, config = {}, now = new Date() }) {
  const settings = getProductUploadProcessingSettings(config);
  instant(now);
  const ctx = context(outDir, jobId), state = readState(ctx);
  const last = state?.lastAttempt;
  return { eligible: ctx.eligible && settings.enabled, queued: Boolean(state?.request), running: last?.status === 'RUNNING',
    lastAttempt: last ? { status: last.status, startedAt: last.startedAt, finishedAt: last.finishedAt, errorCode: last.errorCode } : null,
    snapshot: state?.snapshot || null };
}
