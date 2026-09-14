import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sanitizeForStorage, sanitizeUrl } from './redact.js';
import { bjIso } from './time.js';

export const PRODUCT_UPLOAD_PAGE = 'https://sellercentral.amazon.com/product-search/bulk';
export const PRODUCT_UPLOAD_STATES = Object.freeze([
  'STAGED', 'QUEUED', 'PROCESSING', 'PREPARED', 'SUBMITTING',
  'COMPLETED', 'REJECTED', 'FAILED_BEFORE_SUBMIT', 'UNKNOWN', 'EXPIRED',
]);
export const PRODUCT_UPLOAD_TERMINAL_STATES = Object.freeze([
  'COMPLETED', 'REJECTED', 'FAILED_BEFORE_SUBMIT', 'UNKNOWN', 'EXPIRED',
]);
export const PRODUCT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const PRODUCT_UPLOAD_MAX_STORED_PAYLOAD_BYTES = 512 * 1024 * 1024;
export const PRODUCT_UPLOAD_ALLOWED_EXTENSIONS = Object.freeze(['.xlsx', '.txt', '.tsv', '.csv']);
export const PRODUCT_UPLOAD_RESULT_ERROR_LIMIT = 50;
export const PRODUCT_UPLOAD_MODES = Object.freeze(['SIMPLE', 'STANDARD']);
export const PRODUCT_UPLOAD_RESPONSE_TEXT_LIMIT = 12000;
export function productUploadMode(value = 'STANDARD') {
  if (!PRODUCT_UPLOAD_MODES.includes(value)) throw new Error('上传模式无效');
  return value;
}
const JOB_ID_RE = /^upl_[a-f0-9]{32}$/;
const EXTENSIONS = new Set(PRODUCT_UPLOAD_ALLOWED_EXTENSIONS);
const PROCESSING_STATUSES = new Set([
  'NOT_AVAILABLE', 'UNKNOWN', 'RECEIVED', 'PROCESSING',
  'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED',
]);
const RECEIPT_STATUSES = new Set(['NOT_SUBMITTED', 'ACCEPTED', 'REJECTED', 'UNKNOWN', 'NOT_AVAILABLE']);
const PRODUCT_UPLOAD_TRANSITIONS = Object.freeze({
  STAGED: new Set(['QUEUED', 'EXPIRED']),
  QUEUED: new Set(['PROCESSING', 'FAILED_BEFORE_SUBMIT']),
  PROCESSING: new Set(['QUEUED', 'SUBMITTING', 'FAILED_BEFORE_SUBMIT']),
  PREPARED: new Set(['QUEUED', 'SUBMITTING', 'FAILED_BEFORE_SUBMIT']),
  SUBMITTING: new Set(['COMPLETED', 'REJECTED', 'UNKNOWN']),
  COMPLETED: new Set(),
  REJECTED: new Set(),
  FAILED_BEFORE_SUBMIT: new Set(),
  UNKNOWN: new Set(),
  EXPIRED: new Set(),
});
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EMPTY_ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export function productUploadEnabled(env = process.env) {
  return String(env.AMZGUARD_PRODUCT_UPLOAD_ENABLED || '') === '1';
}

export function productUploadExecutionEnabled(env = process.env) {
  return productUploadEnabled(env)
    && String(env.AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED || '') === '1';
}

export function productUploadStoreFingerprint(store) {
  return crypto.createHash('sha256').update(JSON.stringify([
    String(store?.id || ''), String(store?.name || store?.key || ''),
    String(store?.market || 'US'), String(store?.host || ''),
  ])).digest('hex');
}

export function productUploadStoreMatches(job, store) {
  if (!store || store.enabled === false || String(store.key) !== job.store?.key
    || String(store.name || store.key) !== job.store.name
    || String(store.market || 'US') !== job.store.market) return false;
  return !job.store.bindingFingerprint || job.store.bindingFingerprint === productUploadStoreFingerprint(store);
}

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('上传存储目录不是受控普通目录');
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }
  return dir;
}

export function productUploadPaths(outDir) {
  const root = path.join(path.resolve(outDir), 'product-uploads');
  return {
    root,
    jobs: path.join(root, 'jobs'),
    queue: path.join(root, 'queue'),
    audit: path.join(root, 'audit'),
  };
}

export function ensureProductUploadStorage(outDir) {
  const dirs = productUploadPaths(outDir);
  privateDirectory(path.resolve(outDir));
  privateDirectory(dirs.root);
  privateDirectory(dirs.jobs);
  privateDirectory(dirs.queue);
  privateDirectory(dirs.audit);
  return dirs;
}

function atomicJson(file, value, { createOnly = false } = {}) {
  privateDirectory(path.dirname(file));
  if (!createOnly && fs.existsSync(file)) {
    const existing = fs.lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('上传任务记录类型异常');
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    if (createOnly) {
      fs.linkSync(tmp, file);
      fs.unlinkSync(tmp);
    } else {
      fs.renameSync(tmp, file);
    }
    try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

function appendAudit(outDir, record) {
  const dirs = ensureProductUploadStorage(outDir);
  const day = bjIso().slice(0, 10);
  const file = path.join(dirs.audit, `${day}.jsonl`);
  const safe = sanitizeForStorage(record, { rootDir: outDir });
  try {
    const existing = fs.lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error('上传审计文件结构异常');
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
    | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error('上传审计文件结构异常');
    fs.writeSync(fd, `${JSON.stringify(safe)}\n`);
    fs.fsyncSync(fd);
    try { fs.fchmodSync(fd, 0o600); } catch { /* non-POSIX */ }
  } finally { fs.closeSync(fd); }
  const dirFd = fs.openSync(dirs.audit, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

function cleanOriginalName(value) {
  const name = String(value || '').normalize('NFKC').trim();
  if (!name || name.length > 180 || /[\0-\x1f\x7f]/.test(name)) throw new Error('文件名无效');
  if (name !== path.basename(name) || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error('文件名不得包含路径');
  return name;
}

function beginsWith(buffer, magic) {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

function validateTextPayload(buffer, mode) {
  if (!buffer.length) throw new Error('上传文件为空');
  const probe = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  if (probe.includes(0)) {
    const utf16 = beginsWith(probe, Buffer.from([0xff, 0xfe])) || beginsWith(probe, Buffer.from([0xfe, 0xff]));
    if (!utf16) throw new Error('文本文件包含不可接受的二进制内容');
  }
  // Forward legacy text encodings byte-for-byte in simple mode. Amazon owns
  // encoding, template and business validation; binary payload safety remains.
  if (mode !== 'SIMPLE' && !probe.includes(0) && probe.toString('utf8').includes('\ufffd')) throw new Error('文本文件不是有效 UTF-8/UTF-16');
}

function inspectXlsxArchive(buffer) {
  let cursor = 0;
  let entries = 0;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  const names = new Set();
  while (cursor <= buffer.length - 46) {
    const signature = buffer.readUInt32LE(cursor);
    if (signature !== 0x02014b50) {
      cursor++;
      continue;
    }
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) throw new Error('Excel ZIP 目录结构不完整');
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
    if (!name || name.includes('\0') || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error('Excel ZIP 包含不安全的内部路径');
    }
    names.add(name);
    entries++;
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (entries > 5000 || totalUncompressed > 100 * 1024 * 1024) throw new Error('Excel ZIP 展开规模超过安全限制');
    if (uncompressed > 10 * 1024 * 1024 && compressed > 0 && uncompressed / compressed > 100) {
      throw new Error('Excel ZIP 压缩比异常');
    }
    cursor = end;
  }
  if (!entries || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    throw new Error('Excel 文件缺少工作簿结构，无法作为批量模板');
  }
  if ([...names].some((name) => /(?:^|\/)(?:vbaProject\.bin|embeddings\/|activeX\/)/i.test(name))) {
    throw new Error('Excel 文件包含宏或嵌入对象，当前安全策略不允许上传');
  }
  if (totalCompressed > buffer.length * 1.2) throw new Error('Excel ZIP 目录声明与文件大小不一致');
  return { entries, totalUncompressed };
}

export function inspectProductUploadFile({ originalName, buffer, mode = 'STANDARD', maxBytes = PRODUCT_UPLOAD_MAX_BYTES } = {}) {
  productUploadMode(mode);
  const name = cleanOriginalName(originalName);
  if (!Buffer.isBuffer(buffer)) throw new Error('上传内容无效');
  if (!buffer.length) throw new Error('上传文件为空');
  if (buffer.length > maxBytes) throw new Error(`上传文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 限制`);
  const extension = path.extname(name).toLowerCase();
  if (!EXTENSIONS.has(extension)) throw new Error(`不支持的文件格式：${extension || '无扩展名'}`);
  if (extension === '.xlsx') {
    if (!beginsWith(buffer, ZIP_MAGIC) && !beginsWith(buffer, EMPTY_ZIP_MAGIC)) throw new Error('Excel 文件内容签名与扩展名不一致');
    inspectXlsxArchive(buffer);
  } else {
    validateTextPayload(buffer, mode);
  }
  return {
    originalName: name,
    extension,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function jobFile(outDir, jobId) {
  if (!JOB_ID_RE.test(String(jobId || ''))) throw new Error('上传任务 ID 无效');
  return path.join(productUploadPaths(outDir).jobs, jobId, 'record.json');
}

export function readProductUploadJob({ outDir, jobId }) {
  const file = jobFile(outDir, jobId);
  const dir = path.dirname(file);
  const dirStat = fs.lstatSync(dir);
  const fileStat = fs.lstatSync(file);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error('上传任务存储结构异常');
  }
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (job?.version !== 1 || job.id !== jobId || !PRODUCT_UPLOAD_STATES.includes(job.state)) {
    throw new Error('上传任务记录结构无效');
  }
  productUploadMode(job.mode);
  return job;
}

function readUploadLedgerFile(file, { optional = false, maxBytes = 2 * 1024 * 1024 } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (optional && error?.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) {
    throw new Error('上传账本文件结构或大小异常');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('上传账本文件在读取前已变化');
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    const after = fs.fstatSync(fd);
    if (size !== stat.size || after.size !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino
      || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) throw new Error('上传账本文件在读取期间已变化');
    const bytes = buffer.subarray(0, size);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('上传账本 JSON 无效'); }
    return { value, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally { fs.closeSync(fd); }
}

function uploadRecordSnapshot(outDir, jobId) {
  const record = jobFile(outDir, jobId);
  const dirs = productUploadPaths(outDir);
  for (const dir of [dirs.root, dirs.jobs, path.dirname(record)]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('上传账本目录结构异常');
  }
  const snapshot = readUploadLedgerFile(record);
  const job = snapshot.value;
  if (job?.version !== 1 || job.id !== jobId || !PRODUCT_UPLOAD_STATES.includes(job.state)
    || typeof job.store?.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(job.store.key)
    || typeof job.file?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(job.file.sha256)
    || !Number.isSafeInteger(job.file?.size) || job.file.size < 1 || job.file.size > PRODUCT_UPLOAD_MAX_BYTES
    || !EXTENSIONS.has(job.file?.extension)
    || typeof job.createdAt !== 'string' || typeof job.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt))) {
    throw new Error('上传账本缺少有效任务、店铺或文件绑定');
  }
  productUploadMode(job.mode);
  return { job, sha256: snapshot.sha256 };
}

function resetForSnapshot(outDir, snapshot) {
  const { job } = snapshot;
  const file = path.join(path.dirname(jobFile(outDir, job.id)), 'reset.json');
  const stored = readUploadLedgerFile(file, { optional: true, maxBytes: 16 * 1024 });
  if (!stored) return null;
  const reset = stored.value;
  const keys = ['version', 'jobId', 'storeKey', 'sha256', 'size', 'mode', 'state', 'recordUpdatedAt',
    'recordSHA256', 'resetAt', 'actor', 'reason', 'acknowledgeRisk'];
  if (!reset || typeof reset !== 'object' || Array.isArray(reset)
    || Object.keys(reset).length !== keys.length || Object.keys(reset).some(key => !keys.includes(key))
    || reset.version !== 1 || reset.jobId !== job.id || reset.storeKey !== job.store.key
    || reset.sha256 !== job.file.sha256 || reset.size !== job.file.size || reset.mode !== productUploadMode(job.mode)
    || reset.state !== job.state || !PRODUCT_UPLOAD_TERMINAL_STATES.includes(reset.state)
    || reset.recordUpdatedAt !== job.updatedAt || reset.recordSHA256 !== snapshot.sha256
    || reset.acknowledgeRisk !== true || typeof reset.resetAt !== 'string' || !Number.isFinite(Date.parse(reset.resetAt))
    || typeof reset.actor !== 'string' || !reset.actor.trim() || reset.actor.length > 80
    || typeof reset.reason !== 'string' || !reset.reason.trim() || reset.reason.length > 300
    || (fs.lstatSync(file).mode & 0o077) !== 0) {
    throw new Error('重复上传重置记录无效或与原账本不匹配');
  }
  return reset;
}

// Safety decisions use the whole ledger, never the paginated UI inventory or
// its intentionally tolerant handling of damaged historical records.
function scanProductUploadLedger(outDir) {
  const dirs = productUploadPaths(outDir);
  let stat;
  try { stat = fs.lstatSync(dirs.jobs); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('上传账本目录结构异常');
  const rootStat = fs.lstatSync(dirs.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('上传账本目录结构异常');
  const rows = [];
  for (const entry of fs.readdirSync(dirs.jobs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB_ID_RE.test(entry.name)) {
      throw new Error('上传账本包含未知或损坏任务，已阻止重复保护变更');
    }
    const snapshot = uploadRecordSnapshot(outDir, entry.name);
    rows.push({ ...snapshot, reset: resetForSnapshot(outDir, snapshot) });
  }
  return rows;
}

export function productUploadResetPhrase(job) {
  return `重置重复上传 ${job.store.key} ${job.file.sha256.slice(0, 12)}`;
}

export function productUploadResetInfo({ outDir, job }) {
  const snapshot = uploadRecordSnapshot(outDir, job.id);
  if (snapshot.job.state !== job.state || snapshot.job.updatedAt !== job.updatedAt
    || snapshot.job.store.key !== job.store?.key || snapshot.job.file.sha256 !== job.file?.sha256) {
    throw new Error('上传任务已变化，请刷新后重试');
  }
  const reset = resetForSnapshot(outDir, snapshot);
  return { eligible: PRODUCT_UPLOAD_TERMINAL_STATES.includes(job.state) && !reset,
    resetAt: reset?.resetAt || null, reason: reset?.reason || null, actor: reset?.actor || null };
}

function createDurableReset(file, reset) {
  const parent = path.dirname(file);
  const tmp = path.join(parent, `.reset.${crypto.randomUUID()}.tmp`);
  const content = `${JSON.stringify(reset, null, 2)}\n`;
  const expectedSHA = crypto.createHash('sha256').update(content).digest('hex');
  const syncParent = () => {
    const dirFd = fs.openSync(parent, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  };
  let fd, identity, primaryError, published = false, tmpPending = false;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    tmpPending = true;
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    identity = fs.fstatSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.linkSync(tmp, file); // Atomic create-only publication; never overwrite a reset.
    published = true;
    fs.unlinkSync(tmp);
    tmpPending = false;
    syncParent();
  } catch (error) {
    primaryError = error;
    if (published) {
      try {
        // Remove only the exact reset this invocation created. A replacement
        // by another actor is never deleted as part of our rollback.
        const actual = fs.lstatSync(file);
        if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== identity.dev || actual.ino !== identity.ino
          || actual.size !== Buffer.byteLength(content)
          || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expectedSHA) {
          throw new Error('重置记录身份已变化');
        }
        fs.unlinkSync(file);
        syncParent();
      } catch {
        const uncertain = new Error('重置记录提交状态无法确认，请刷新核对；不要自动重试重置或暂存。');
        uncertain.code = 'RESET_COMMIT_UNKNOWN';
        primaryError = uncertain;
        throw uncertain;
      }
    }
    throw error;
  } finally {
    let cleanupError;
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (error) { cleanupError = error; } }
    if (tmpPending) { try { fs.unlinkSync(tmp); } catch (error) { if (error?.code !== 'ENOENT') cleanupError ||= error; } }
    if (!primaryError && cleanupError) throw cleanupError;
  }
}

/** Caller holds the shared run lease. This records a manual exception for one
 * terminal job; it never changes that job, selects a file or queues a retry. */
export function resetProductUploadDuplicate({ outDir, jobId, phrase, reason, actor = 'dashboard', acknowledgeRisk, now = new Date() }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('重置时间无效');
  if (acknowledgeRisk !== true || typeof reason !== 'string' || !reason.trim() || reason.length > 300) {
    throw new Error('须明确知晓重复上传风险并填写不超过300字的重置原因');
  }
  const rows = scanProductUploadLedger(outDir);
  const row = rows.find(entry => entry.job.id === jobId);
  if (!row) throw new Error('上传任务不存在');
  const { job } = row;
  if (!PRODUCT_UPLOAD_TERMINAL_STATES.includes(job.state)) throw new Error('活动上传任务不能重置重复保护');
  if (row.reset) throw new Error('该上传任务已重置，不能重复操作');
  if (typeof phrase !== 'string' || phrase !== productUploadResetPhrase(job)) throw new Error('重置确认短语不匹配');
  if (rows.some(entry => entry.job.store.key === job.store.key && entry.job.file.sha256 === job.file.sha256
    && !PRODUCT_UPLOAD_TERMINAL_STATES.includes(entry.job.state))) throw new Error('相同店铺与文件仍有活动任务，不能重置');
  const queueDir = productUploadPaths(outDir).queue;
  const queueStat = fs.lstatSync(queueDir);
  if (!queueStat.isDirectory() || queueStat.isSymbolicLink()) throw new Error('上传队列目录结构异常');
  const marker = path.join(queueDir, job.id);
  try { fs.lstatSync(marker); throw new Error('上传任务仍有队列标记，不能重置'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const reset = { version: 1, jobId: job.id, storeKey: job.store.key, sha256: job.file.sha256,
    size: job.file.size, mode: productUploadMode(job.mode), state: job.state, recordUpdatedAt: job.updatedAt,
    recordSHA256: row.sha256, resetAt: bjIso(now), actor: boundedText(actor, 80), reason: boundedText(reason, 300), acknowledgeRisk: true };
  if (!reset.actor || !reset.reason) throw new Error('重置操作人或原因无效');
  // Persist the authorization audit before publishing the exception. An audit
  // failure must leave the original duplicate protection in force.
  appendAudit(outDir, { ...reset, at: reset.resetAt, event: 'duplicate-reset-authorized' });
  createDurableReset(path.join(path.dirname(jobFile(outDir, job.id)), 'reset.json'), reset);
  return { eligible: false, resetAt: reset.resetAt, reason: reset.reason, actor: reset.actor };
}

export function payloadPathForJob({ outDir, job }) {
  const file = path.join(productUploadPaths(outDir).jobs, job.id, `payload${job.file.extension}`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.file.size) throw new Error('上传任务文件缺失或已改变');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== job.file.sha256) throw new Error('上传任务文件摘要不匹配');
  return file;
}

// Failure evidence is private operational material. It is deliberately kept
// outside record.result, publicProductUploadJob and notification payloads.
export function saveProductUploadDiagnostic({ outDir, jobId, phase, snapshot }) {
  ensureProductUploadStorage(outDir);
  const job = readProductUploadJob({ outDir, jobId });
  if (!['UNKNOWN', 'FAILED_BEFORE_SUBMIT'].includes(job.state)) throw new Error('上传诊断只允许保存失败现场');
  if (!['PAGE_READY', 'FILE_SELECTION', 'SUBMIT', 'AMAZON_RESPONSE'].includes(phase)) throw new Error('上传诊断阶段无效');
  const source = snapshot?.summary || {};
  const statuses = ['AVAILABLE', 'UNAVAILABLE', 'UNSAFE_PAGE', 'LIMIT_EXCEEDED'];
  const nullableBoolean = value => typeof value === 'boolean' ? value : null;
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;
  const validityKeys = ['valid', 'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort',
    'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'];
  const status = statuses.includes(source.status) ? source.status : 'UNAVAILABLE';
  const available = status === 'AVAILABLE';
  const summary = {
    version: 1, status,
    inputCount: status === 'UNSAFE_PAGE' ? null : count(source.inputCount),
    selectedFileCount: available ? count(source.selectedFileCount) : null,
    singleSelectedFileSizeMatches: available ? nullableBoolean(source.singleSelectedFileSizeMatches) : null,
    inputs: available && Array.isArray(source.inputs) ? source.inputs.slice(0, 32).map(input => ({
      validity: Object.fromEntries(validityKeys.map(key => [key, nullableBoolean(input?.validity?.[key])])),
      ariaInvalid: nullableBoolean(input?.ariaInvalid),
    })) : [],
  };
  const safetySource = snapshot?.safety || {};
  const safetyReasons = ['CURRENT_URL_UNAVAILABLE', 'UNAPPROVED_AMAZON_HOST', 'ACCESS_BLOCKED', 'AUTH_SENSITIVE',
    'URL_ALLOWED', 'LIVE_SAFETY_PROBE_UNAVAILABLE', 'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE',
    'LIVE_SAFETY_PROBE_INCOMPLETE', 'LIVE_PAGE_NON_SENSITIVE'];
  const probeDiagnostics = {};
  for (const field of ['discoveredRootCount', 'scannedRootCount', 'discoveredElementCount', 'scannedElementCount',
    'candidateNodeCount', 'visibleFrameCount', 'unreadableVisibleFrameCount', 'traversalErrorCount',
    'nonFrameTraversalErrorCount', 'unreadableFrameErrorCount', 'opaqueOverlayFrameCount', 'opaqueAuthHintCount',
    'opaqueBlockedHintCount', 'rootBudget', 'elementBudget', 'nodeBudget', 'unreadableFrameBudget']) {
    const value = safetySource.liveProbeDiagnostics?.[field];
    if (Number.isSafeInteger(value) && value >= 0 && value <= 10000000) probeDiagnostics[field] = value;
  }
  for (const field of ['accessibleTraversalComplete', 'mainDocumentTraversalComplete', 'rootBudgetExceeded',
    'elementBudgetExceeded', 'nodeBudgetExceeded', 'unreadableFrameBudgetExceeded']) {
    const value = safetySource.liveProbeDiagnostics?.[field];
    if (typeof value === 'boolean') probeDiagnostics[field] = value;
  }
  const safety = {
    stage: ['START', 'BEFORE_SCREENSHOT', 'AFTER_SCREENSHOT'].includes(safetySource.stage) ? safetySource.stage : null,
    reason: safetyReasons.includes(safetySource.reason) ? safetySource.reason : null,
    exactUrl: nullableBoolean(safetySource.exactUrl), authSensitive: nullableBoolean(safetySource.authSensitive),
    blocked: nullableBoolean(safetySource.blocked),
    liveProbeDiagnostics: Object.keys(probeDiagnostics).length ? probeDiagnostics : null,
  };
  const diagnosticDir = path.join(path.dirname(jobFile(outDir, jobId)), 'diagnostics');
  privateDirectory(diagnosticDir);
  const screenshotStates = ['FAILED', 'TOO_LARGE', 'INVALID', 'BLOCKED', 'NOT_CAPTURED'];
  const screenshot = { status: screenshotStates.includes(snapshot?.screenshotStatus) ? snapshot.screenshotStatus : 'NOT_CAPTURED' };
  if (status === 'UNSAFE_PAGE') screenshot.status = 'BLOCKED';
  else if (snapshot?.screenshotStatus === 'AVAILABLE') {
    const encoded = snapshot.screenshotBase64;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length % 4 !== 0
      || encoded.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error('上传诊断图片无效');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== encoded
      || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error('上传诊断图片无效');
    }
    const fd = fs.openSync(path.join(diagnosticDir, 'current.png'),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('上传诊断图片存储结构异常');
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    screenshot.status = 'AVAILABLE';
    screenshot.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  atomicJson(path.join(diagnosticDir, 'current.json'), {
    version: 1, jobId, phase, capturedAt: bjIso(), summary, safety, screenshot,
  }, { createOnly: true });
  return { saved: true };
}

export function productUploadPayloadBytes({ outDir } = {}) {
  const dirs = productUploadPaths(outDir);
  if (!fs.existsSync(dirs.jobs)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirs.jobs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB_ID_RE.test(entry.name)) continue;
    const jobDir = path.join(dirs.jobs, entry.name);
    for (const child of fs.readdirSync(jobDir, { withFileTypes: true })) {
      if (!child.isFile() || child.isSymbolicLink() || !/^payload\.(?:xlsx|txt|tsv|csv)$/i.test(child.name)) continue;
      const stat = fs.lstatSync(path.join(jobDir, child.name));
      if (stat.isFile() && !stat.isSymbolicLink()) total += stat.size;
      if (!Number.isSafeInteger(total) || total > PRODUCT_UPLOAD_MAX_STORED_PAYLOAD_BYTES) return total;
    }
  }
  return total;
}

export function stageProductUpload({ outDir, store, originalName, buffer, mode = 'STANDARD', actor = 'dashboard', now = new Date() }) {
  if (!store?.key || store.enabled === false) throw new Error('目标店铺无效或未启用');
  const file = inspectProductUploadFile({ originalName, buffer, mode });
  const dirs = ensureProductUploadStorage(outDir);
  scanProductUploadLedger(outDir); // Validate all records before expiry can mutate any of them.
  expireStagedProductUploads({ outDir, now });
  const rows = scanProductUploadLedger(outDir);
  const duplicate = rows.find(({ job, reset }) =>
    job.store?.key === String(store.key)
    && job.file?.sha256 === file.sha256
    && !reset
    && !['EXPIRED', 'FAILED_BEFORE_SUBMIT'].includes(job.state),
  );
  if (duplicate) throw new Error(`相同店铺与文件摘要已存在任务：${duplicate.job.id}（${duplicate.job.state}）`);
  const resetOf = rows.filter(({ job, reset }) => reset && job.store.key === String(store.key)
    && job.file.sha256 === file.sha256).map(({ job }) => job.id).sort();
  if (productUploadPayloadBytes({ outDir }) + file.size > PRODUCT_UPLOAD_MAX_STORED_PAYLOAD_BYTES) {
    throw new Error('上传文件暂存总量已达到安全上限，请等待保留任务清理后重试');
  }
  const id = `upl_${crypto.randomBytes(16).toString('hex')}`;
  const jobDir = path.join(dirs.jobs, id);
  privateDirectory(jobDir);
  let completed = false;
  try {
    const payloadFile = path.join(jobDir, `payload${file.extension}`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);
    const fd = fs.openSync(payloadFile, flags, 0o600);
    try {
      fs.writeFileSync(fd, buffer);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const createdAt = bjIso(now);
    const job = {
      version: 1,
      id,
      state: 'STAGED',
      mode,
      createdAt,
      updatedAt: createdAt,
      expiresAt: bjIso(new Date(now.getTime() + 30 * 60 * 1000)),
      store: { key: String(store.key), name: String(store.name || store.key), market: String(store.market || 'US'),
        bindingFingerprint: productUploadStoreFingerprint(store) },
      file,
      confirmationPhrase: `确认上传至 ${String(store.key)}`,
      actor: String(actor || 'dashboard').slice(0, 80),
      attempt: 0,
      result: null,
      ...(resetOf.length ? { resetOf } : {}),
    };
    atomicJson(path.join(jobDir, 'record.json'), job, { createOnly: true });
    appendAudit(outDir, { at: createdAt, event: 'staged', jobId: id, storeKey: job.store.key, mode, size: file.size, sha256: file.sha256,
      ...(resetOf.length ? { resetOf } : {}) });
    completed = true;
    return job;
  } finally {
    if (!completed) {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* exact newly-created job only */ }
    }
  }
}

export function transitionProductUpload({ outDir, jobId, from, to, patch = {}, auditEvent = null, now = new Date() }) {
  if (!PRODUCT_UPLOAD_STATES.includes(to)) throw new Error('目标上传状态无效');
  const job = readProductUploadJob({ outDir, jobId });
  const allowedFrom = Array.isArray(from) ? from : [from];
  if (!allowedFrom.includes(job.state)) throw new Error(`上传任务状态冲突：当前 ${job.state}`);
  if (!PRODUCT_UPLOAD_TRANSITIONS[job.state]?.has(to)) throw new Error(`禁止的上传状态迁移：${job.state} -> ${to}`);
  const next = sanitizeForStorage({ ...job, ...patch, state: to, updatedAt: bjIso(now) }, { rootDir: outDir });
  // Preserve fields that sanitisation deliberately considers internal but that
  // are required by this private job ledger. None contains a credential.
  next.id = job.id;
  next.file = job.file;
  next.store = job.store;
  next.mode = productUploadMode(job.mode);
  next.confirmationPhrase = job.confirmationPhrase;
  atomicJson(jobFile(outDir, jobId), next);
  if (auditEvent) appendAudit(outDir, {
    at: next.updatedAt, event: auditEvent, jobId, storeKey: job.store.key,
    from: job.state, to, sha256: job.file.sha256, ...(patch.audit || {}),
  });
  return next;
}

export function confirmProductUpload({ outDir, jobId, phrase, actor = 'dashboard', now = new Date() }) {
  const job = readProductUploadJob({ outDir, jobId });
  if (job.state !== 'STAGED') throw new Error(`上传任务当前不可确认：${job.state}`);
  if (Date.parse(job.expiresAt) <= now.getTime()) {
    return transitionProductUpload({ outDir, jobId, from: 'STAGED', to: 'EXPIRED', auditEvent: 'expired', now });
  }
  if (String(phrase || '') !== job.confirmationPhrase) throw new Error('二次确认短语不匹配');
  payloadPathForJob({ outDir, job });
  const queueFile = path.join(ensureProductUploadStorage(outDir).queue, jobId);
  let markerCreated = false;
  try {
    if (!fs.existsSync(queueFile)) {
      fs.writeFileSync(queueFile, `${jobId}\n`, { mode: 0o600, flag: 'wx' });
      markerCreated = true;
    }
    return transitionProductUpload({
      outDir, jobId, from: 'STAGED', to: 'QUEUED',
      patch: { confirmedAt: bjIso(now), confirmedBy: String(actor || 'dashboard').slice(0, 80) },
      auditEvent: 'confirmed-and-queued', now,
    });
  } catch (error) {
    if (markerCreated) {
      try { fs.unlinkSync(queueFile); } catch { /* keep the ledger authoritative */ }
    }
    throw error;
  }
}

export function clearProductUploadQueueMarker({ outDir, jobId }) {
  const file = path.join(productUploadPaths(outDir).queue, String(jobId || ''));
  if (!JOB_ID_RE.test(String(jobId || ''))) return;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(file);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

export function listProductUploadJobs({ outDir, limit = 100 } = {}) {
  const dirs = productUploadPaths(outDir);
  if (!fs.existsSync(dirs.jobs)) return [];
  privateDirectory(dirs.jobs);
  const jobs = [];
  for (const entry of fs.readdirSync(dirs.jobs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB_ID_RE.test(entry.name)) continue;
    try { jobs.push(readProductUploadJob({ outDir, jobId: entry.name })); } catch { /* corrupted jobs stay out of the UI */ }
  }
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.max(1, Math.min(10_000, limit)));
}

export function productUploadJobInventory({ outDir, limit = 100 } = {}) {
  const dirs = productUploadPaths(outDir);
  if (!fs.existsSync(dirs.jobs)) return { jobs: [], corrupt: 0 };
  privateDirectory(dirs.jobs);
  expireStagedProductUploads({ outDir });
  const jobs = [];
  let corrupt = 0;
  for (const entry of fs.readdirSync(dirs.jobs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB_ID_RE.test(entry.name)) {
      corrupt++;
      continue;
    }
    try { jobs.push(readProductUploadJob({ outDir, jobId: entry.name })); } catch { corrupt++; }
  }
  return {
    jobs: jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.max(1, Math.min(10_000, limit))),
    corrupt,
  };
}

export function expireStagedProductUploads({ outDir, now = new Date() } = {}) {
  const expired = [];
  for (const job of listProductUploadJobs({ outDir, limit: 10_000 })) {
    if (job.state !== 'STAGED' || Date.parse(job.expiresAt) > now.getTime()) continue;
    const next = transitionProductUpload({
      outDir, jobId: job.id, from: 'STAGED', to: 'EXPIRED', auditEvent: 'expired', now,
    });
    try {
      const payload = path.join(productUploadPaths(outDir).jobs, job.id, `payload${job.file.extension}`);
      const stat = fs.lstatSync(payload);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(payload);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    expired.push(next);
  }
  return expired;
}

export function publicProductUploadJob(job) {
  const publicResult = job.result ? sanitizeForStorage(job.result) : null;
  // The structured center is exposed once at the stable top-level API field;
  // keep the legacy result object compact for existing consumers of result.code.
  if (publicResult && typeof publicResult === 'object') delete publicResult.center;
  if (publicResult?.amazonResponse) {
    const response = productUploadAmazonResponse(publicResult.amazonResponse.text, job.file?.originalName);
    response.truncated ||= publicResult.amazonResponse.truncated === true;
    publicResult.amazonResponse = response;
  }
  return {
    id: job.id,
    state: job.state,
    resetOf: Array.isArray(job.resetOf) ? [...new Set(job.resetOf.filter(id => typeof id === 'string' && JOB_ID_RE.test(id)))] : [],
    mode: productUploadMode(job.mode),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    confirmedAt: job.confirmedAt || null,
    startedAt: job.startedAt || null,
    submittedAt: job.submittedAt || null,
    finishedAt: job.finishedAt || null,
    store: job.store ? { key: job.store.key, name: job.store.name, market: job.store.market } : undefined,
    file: {
      extension: job.file.extension,
      size: job.file.size,
      sha256Short: String(job.file.sha256 || '').slice(0, 12),
    },
    confirmationPhrase: job.state === 'STAGED' ? job.confirmationPhrase : null,
    result: publicResult,
    diagnostic: productUploadDiagnostic(job),
    resultCenter: productUploadResultCenter(job),
  };
}

export function productUploadAmazonResponse(text, originalName) {
  let value = String(text || '');
  if (originalName) value = value.split(originalName).join('[上传文件]');
  const safe = String(sanitizeForStorage(value)).trim();
  return {
    availability: safe ? 'AVAILABLE' : 'NOT_AVAILABLE',
    source: 'AMAZON_PAGE_TEXT_DELTA',
    text: safe.slice(0, PRODUCT_UPLOAD_RESPONSE_TEXT_LIMIT) || null,
    truncated: safe.length > PRODUCT_UPLOAD_RESPONSE_TEXT_LIMIT,
  };
}

export function productUploadDiagnostic(job) {
  if (!['FAILED_BEFORE_SUBMIT', 'UNKNOWN', 'REJECTED'].includes(job?.state)) return null;
  const message = boundedText(job.result?.message, 500);
  let code = boundedText(job.result?.errorCode || job.result?.code, 100);
  let suggestion = job.state === 'UNKNOWN'
    ? '请通过对应店铺紫鸟核对 Amazon 上传记录；结果未知时禁止自动重试。'
    : job.state === 'REJECTED' ? '请按 Amazon 返回内容修正文件。'
      : '请修复提交前故障，再新建任务并确认上传。';
  if (/文件控件.*(?:[（(]0[）)]|未.*就绪)/.test(message || '')) {
    code = 'UPLOAD_FILE_INPUT_NOT_READY';
    suggestion = 'Amazon 上传页未找到可用的文件选择控件；请检查页面是否加载完成、店铺登录及上传入口。' + (job.state === 'UNKNOWN' ? '旧任务保留结果未知，核对 Amazon 记录前不要重复上传。' : '本次尚未选择文件，可在修复后新建任务。');
  }
  if (code === 'UPLOAD_SUBMIT_CONTROL_NOT_READY' || /^批量上传提交控件未在等待期内就绪/.test(message || '')) {
    code = 'UPLOAD_SUBMIT_CONTROL_NOT_READY';
    suggestion = '未找到可点击的 Amazon 提交控件，请核对文件校验提示和页面必填项。'
      + (job.state === 'UNKNOWN' ? '选择文件可能已触发上传，核对 Amazon 记录前不要重复上传。' : '请先修复控件就绪问题。');
  }
  return { source: job.state === 'REJECTED' ? 'AMAZON' : 'SYSTEM', code,
    phase: boundedText(job.result?.phase, 80), message, suggestion };
}

export function classifyProductUploadResult(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const processing = /(?:\bis being processed\b|received for processing|\u6b63\u5728\u5904\u7406)/i.test(value);
  const success = /(?:your file (?:has been |was )?uploaded|your file is being processed|upload (?:is )?(?:complete|successful)|file (?:was )?received for processing|\u6587\u4ef6(?:\u5df2)?\u4e0a\u4f20(?:\u6210\u529f|\u5b8c\u6210)|\u6587\u4ef6\u5df2\u63a5\u6536(?:\uff0c|,)?\u6b63\u5728\u5904\u7406)/i.test(value);
  const rejected = /(?:upload failed|could not (?:upload|process)|file (?:was )?rejected|invalid file|fix (?:the )?errors? and (?:try|upload)|\u4e0a\u4f20\u5931\u8d25|\u6587\u4ef6\u88ab\u62d2\u7edd|\u6587\u4ef6\u65e0\u6548|\u4fee\u590d\u9519\u8bef\u540e\u91cd\u8bd5)/i.test(value);
  if (rejected) return {
    state: 'REJECTED', code: 'AMAZON_REJECTED_FILE', receiptStatus: 'REJECTED',
    processingStatus: null,
  };
  if (success) return {
    state: 'COMPLETED', code: 'AMAZON_ACCEPTED_UPLOAD', receiptStatus: 'ACCEPTED',
    processingStatus: processing ? 'PROCESSING' : null,
  };
  return {
    state: 'UNKNOWN', code: 'UPLOAD_RESULT_UNCONFIRMED', receiptStatus: 'UNKNOWN',
    processingStatus: null,
  };
}

function boundedText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const safe = String(sanitizeForStorage(String(value))).replace(/\s+/g, ' ').trim();
  return safe ? safe.slice(0, maxLength) : null;
}

function stableAmazonIdentifier(value) {
  const safe = boundedText(value, 160);
  return safe && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(safe) ? safe : null;
}

function nonNegativeCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= 10_000_000 ? count : null;
}

function safeReportUrl(value) {
  const safe = sanitizeUrl(String(value || ''));
  if (!safe || safe === '[REDACTED]') return null;
  try {
    const parsed = new URL(safe);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'sellercentral.amazon.com') return null;
    return parsed.toString();
  } catch { return null; }
}

function normalizeProcessingStatus(value) {
  const status = String(value || '').toUpperCase();
  return PROCESSING_STATUSES.has(status) ? status : 'UNKNOWN';
}

/**
 * Build the durable, public-safe result-center record. This function never
 * infers downstream SKU processing success from the upload receipt. Counts,
 * identifiers, error rows and processing-report metadata remain explicitly
 * NOT_AVAILABLE until an evidence-backed collector supplies them.
 */
export function buildProductUploadResult({
  state = 'UNKNOWN', code = 'UPLOAD_RESULT_UNCONFIRMED', message = null,
  resultUrl = null, observedAt = bjIso(), receiptStatus = null,
  processingStatus = null, batchId = null, submissionId = null, receiptEvidence = null,
  counts = null, errors = null, errorTotal = null, processingReport = null,
  amazonText = null, originalName = null, errorCode = null, phase = null,
} = {}) {
  const safeState = PRODUCT_UPLOAD_STATES.includes(state) ? state : 'UNKNOWN';
  const derivedReceipt = ({
    COMPLETED: 'ACCEPTED', REJECTED: 'REJECTED', UNKNOWN: 'UNKNOWN',
    SUBMITTING: 'UNKNOWN',
  }[safeState] || (['STAGED', 'QUEUED', 'PROCESSING', 'PREPARED', 'FAILED_BEFORE_SUBMIT', 'EXPIRED'].includes(safeState)
    ? 'NOT_SUBMITTED' : 'NOT_AVAILABLE'));
  const requestedReceipt = String(receiptStatus || '').toUpperCase();
  const receipt = RECEIPT_STATUSES.has(requestedReceipt) ? requestedReceipt : derivedReceipt;
  const safeBatchId = stableAmazonIdentifier(batchId);
  const safeSubmissionId = stableAmazonIdentifier(submissionId);
  const success = nonNegativeCount(counts?.success);
  const warning = nonNegativeCount(counts?.warning);
  const failed = nonNegativeCount(counts?.failed);
  const availableCountFields = [success, warning, failed].filter((value) => value !== null).length;
  const suppliedErrors = Array.isArray(errors) ? errors : [];
  const errorItems = suppliedErrors.slice(0, PRODUCT_UPLOAD_RESULT_ERROR_LIMIT).map((entry) => ({
    severity: String(entry?.severity || '').toUpperCase() === 'WARNING' ? 'WARNING' : 'ERROR',
    code: boundedText(entry?.code, 80),
    sku: boundedText(entry?.sku, 120),
    field: boundedText(entry?.field, 120),
    row: Number.isSafeInteger(Number(entry?.row)) && Number(entry.row) > 0 ? Number(entry.row) : null,
    message: boundedText(entry?.message, 500),
  }));
  const declaredErrorTotal = nonNegativeCount(errorTotal);
  const reportId = stableAmazonIdentifier(processingReport?.id);
  const reportUrl = safeReportUrl(processingReport?.url);
  const reportName = boundedText(processingReport?.name, 160);
  const reportFormat = /^(?:CSV|TSV|TXT|XLSX)$/i.test(String(processingReport?.format || ''))
    ? String(processingReport.format).toUpperCase() : null;
  const reportGeneratedAt = Number.isFinite(Date.parse(processingReport?.generatedAt || ''))
    ? bjIso(new Date(processingReport.generatedAt)) : null;
  const normalizedProcessing = normalizeProcessingStatus(processingStatus);
  const processingAvailable = normalizedProcessing !== 'NOT_AVAILABLE'
    && processingStatus !== null && processingStatus !== undefined;
  return sanitizeForStorage({
    code: boundedText(code, 100) || 'UPLOAD_RESULT_UNCONFIRMED',
    message: boundedText(message, 500),
    errorCode: boundedText(errorCode, 100),
    phase: boundedText(phase, 80),
    amazonResponse: productUploadAmazonResponse(amazonText, originalName),
    resultUrl: safeReportUrl(resultUrl),
    center: {
      version: 1,
      observedAt: Number.isFinite(Date.parse(observedAt)) ? bjIso(new Date(observedAt)) : bjIso(),
      receipt: { status: receipt, evidence: safeState === 'COMPLETED' && receiptEvidence === 'UPLOAD_STATUS_ROW'
        && safeBatchId ? 'UPLOAD_STATUS_ROW' : safeState === 'COMPLETED' || safeState === 'REJECTED' ? 'PAGE_TEXT' : 'LEDGER' },
      identifiers: {
        availability: safeBatchId && safeSubmissionId ? 'AVAILABLE'
          : safeBatchId || safeSubmissionId ? 'PARTIAL' : 'NOT_AVAILABLE',
        batchId: safeBatchId,
        submissionId: safeSubmissionId,
      },
      processing: {
        availability: processingAvailable ? 'AVAILABLE' : 'NOT_AVAILABLE',
        status: processingAvailable ? normalizedProcessing : 'UNKNOWN',
      },
      counts: {
        availability: availableCountFields === 3 ? 'AVAILABLE'
          : availableCountFields ? 'PARTIAL' : 'NOT_AVAILABLE',
        success, warning, failed,
      },
      errors: {
        availability: suppliedErrors.length || declaredErrorTotal !== null ? 'AVAILABLE' : 'NOT_AVAILABLE',
        total: declaredErrorTotal ?? (suppliedErrors.length ? suppliedErrors.length : null),
        returned: errorItems.length,
        truncated: suppliedErrors.length > PRODUCT_UPLOAD_RESULT_ERROR_LIMIT
          || (declaredErrorTotal !== null && declaredErrorTotal > errorItems.length),
        items: errorItems,
      },
      processingReport: {
        availability: reportId || reportUrl || reportName || reportFormat || reportGeneratedAt ? 'AVAILABLE' : 'NOT_AVAILABLE',
        id: reportId,
        name: reportName,
        format: reportFormat,
        generatedAt: reportGeneratedAt,
        url: reportUrl,
      },
    },
  });
}

export function productUploadResultCenter(job) {
  const center = job?.result?.center?.version === 1 ? job.result.center : null;
  return buildProductUploadResult({
    state: job?.state,
    code: job?.result?.code,
    message: job?.result?.message,
    resultUrl: job?.result?.resultUrl,
    observedAt: center?.observedAt || job?.finishedAt || job?.updatedAt,
    receiptStatus: center?.receipt?.status,
    processingStatus: center?.processing?.availability === 'AVAILABLE' ? center.processing.status : null,
    batchId: center?.identifiers?.batchId,
    receiptEvidence: center?.receipt?.evidence,
    submissionId: center?.identifiers?.submissionId,
    counts: ['AVAILABLE', 'PARTIAL'].includes(center?.counts?.availability) ? center.counts : null,
    errors: center?.errors?.availability === 'AVAILABLE' ? center.errors.items : null,
    errorTotal: center?.errors?.availability === 'AVAILABLE' ? center.errors.total : null,
    processingReport: center?.processingReport?.availability === 'AVAILABLE' ? center.processingReport : null,
  }).center;
}

export function summarizeProductUploadJobs(jobs = []) {
  const summary = {
    total: 0, pendingSubmission: 0, acceptedAwaitingResult: 0,
    processing: 0, processedSuccess: 0, processedWithWarnings: 0,
    processedFailed: 0, rejected: 0, unknown: 0, failedBeforeSubmit: 0,
  };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    summary.total++;
    if (['STAGED', 'QUEUED', 'PROCESSING', 'PREPARED', 'SUBMITTING'].includes(job?.state)) summary.pendingSubmission++;
    else if (job?.state === 'REJECTED') summary.rejected++;
    else if (job?.state === 'UNKNOWN') summary.unknown++;
    else if (job?.state === 'FAILED_BEFORE_SUBMIT') summary.failedBeforeSubmit++;
    const status = productUploadResultCenter(job).processing.status;
    if (status === 'PROCESSING' || status === 'RECEIVED') summary.processing++;
    else if (status === 'COMPLETED') summary.processedSuccess++;
    else if (status === 'COMPLETED_WITH_WARNINGS') summary.processedWithWarnings++;
    else if (status === 'FAILED') summary.processedFailed++;
    else if (job?.state === 'COMPLETED') summary.acceptedAwaitingResult++;
  }
  return summary;
}

/** A new worker may retry work before the persisted submission boundary.
 * File selection is already beyond that boundary and must never be retried. */
export function recoverInterruptedProductUploads({ outDir, now = new Date() } = {}) {
  const recovered = [];
  for (const job of listProductUploadJobs({ outDir, limit: 500 })) {
    if (job.state === 'SUBMITTING') {
      const finishedAt = bjIso(now);
      const next = transitionProductUpload({
        outDir, jobId: job.id, from: 'SUBMITTING', to: 'UNKNOWN',
        patch: {
          finishedAt,
          result: buildProductUploadResult({
            state: 'UNKNOWN', code: 'WORKER_INTERRUPTED_AFTER_SUBMIT_BOUNDARY', observedAt: finishedAt,
            message: '\u63d0\u4ea4\u8fb9\u754c\u540e\u5de5\u4f5c\u8005\u4e2d\u65ad\uff0c\u4e3a\u9632\u6b62\u91cd\u590d\u4e0a\u4f20\u9700\u4eba\u5de5\u6838\u5bf9',
          }),
        },
        auditEvent: 'interrupted-after-submit-boundary', now,
      });
      clearProductUploadQueueMarker({ outDir, jobId: job.id });
      recovered.push(next);
    } else if (job.state === 'PROCESSING' || job.state === 'PREPARED') {
      const next = transitionProductUpload({
        outDir, jobId: job.id, from: job.state, to: 'QUEUED',
        patch: { result: null, recoveryReason: 'worker-interrupted-before-submit' },
        auditEvent: 'safe-requeue-before-submit', now,
      });
      const marker = path.join(ensureProductUploadStorage(outDir).queue, job.id);
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, `${job.id}\n`, { mode: 0o600, flag: 'wx' });
      recovered.push(next);
    }
  }
  return recovered;
}
