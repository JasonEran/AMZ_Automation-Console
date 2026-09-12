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
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
    | (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(safe)}\n`);
    fs.fsyncSync(fd);
    try { fs.fchmodSync(fd, 0o600); } catch { /* non-POSIX */ }
  } finally { fs.closeSync(fd); }
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

function validateTextPayload(buffer) {
  if (!buffer.length) throw new Error('上传文件为空');
  const probe = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  if (probe.includes(0)) {
    const utf16 = beginsWith(probe, Buffer.from([0xff, 0xfe])) || beginsWith(probe, Buffer.from([0xfe, 0xff]));
    if (!utf16) throw new Error('文本文件包含不可接受的二进制内容');
  }
  if (!probe.includes(0) && probe.toString('utf8').includes('\ufffd')) throw new Error('文本文件不是有效 UTF-8/UTF-16');
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

export function inspectProductUploadFile({ originalName, buffer, maxBytes = PRODUCT_UPLOAD_MAX_BYTES } = {}) {
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
    validateTextPayload(buffer);
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
  return job;
}

export function payloadPathForJob({ outDir, job }) {
  const file = path.join(productUploadPaths(outDir).jobs, job.id, `payload${job.file.extension}`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.file.size) throw new Error('上传任务文件缺失或已改变');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== job.file.sha256) throw new Error('上传任务文件摘要不匹配');
  return file;
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

export function stageProductUpload({ outDir, store, originalName, buffer, actor = 'dashboard', now = new Date() }) {
  if (!store?.key || store.enabled === false) throw new Error('目标店铺无效或未启用');
  const file = inspectProductUploadFile({ originalName, buffer });
  const dirs = ensureProductUploadStorage(outDir);
  expireStagedProductUploads({ outDir, now });
  const duplicate = listProductUploadJobs({ outDir, limit: 500 }).find((job) =>
    job.store?.key === String(store.key)
    && job.file?.sha256 === file.sha256
    && !['EXPIRED', 'FAILED_BEFORE_SUBMIT'].includes(job.state),
  );
  if (duplicate) throw new Error(`相同店铺与文件摘要已存在任务：${duplicate.id}（${duplicate.state}）`);
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
      createdAt,
      updatedAt: createdAt,
      expiresAt: bjIso(new Date(now.getTime() + 30 * 60 * 1000)),
      store: { key: String(store.key), name: String(store.name || store.key), market: String(store.market || 'US') },
      file,
      confirmationPhrase: `确认上传至 ${String(store.key)}`,
      actor: String(actor || 'dashboard').slice(0, 80),
      attempt: 0,
      result: null,
    };
    atomicJson(path.join(jobDir, 'record.json'), job, { createOnly: true });
    appendAudit(outDir, { at: createdAt, event: 'staged', jobId: id, storeKey: job.store.key, size: file.size, sha256: file.sha256 });
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
  return {
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    confirmedAt: job.confirmedAt || null,
    startedAt: job.startedAt || null,
    submittedAt: job.submittedAt || null,
    finishedAt: job.finishedAt || null,
    store: job.store,
    file: {
      extension: job.file.extension,
      size: job.file.size,
      sha256Short: String(job.file.sha256 || '').slice(0, 12),
    },
    confirmationPhrase: job.state === 'STAGED' ? job.confirmationPhrase : null,
    result: publicResult,
    resultCenter: productUploadResultCenter(job),
  };
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
  processingStatus = null, batchId = null, submissionId = null,
  counts = null, errors = null, errorTotal = null, processingReport = null,
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
    resultUrl: safeReportUrl(resultUrl),
    center: {
      version: 1,
      observedAt: Number.isFinite(Date.parse(observedAt)) ? bjIso(new Date(observedAt)) : bjIso(),
      receipt: { status: receipt, evidence: safeState === 'COMPLETED' || safeState === 'REJECTED' ? 'PAGE_TEXT' : 'LEDGER' },
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
    submissionId: center?.identifiers?.submissionId,
    counts: center?.counts?.availability === 'AVAILABLE' ? center.counts : null,
    errors: center?.errors?.availability === 'AVAILABLE' ? center.errors.items : null,
    errorTotal: center?.errors?.availability === 'AVAILABLE' ? center.errors.total : null,
    processingReport: center?.processingReport?.availability === 'AVAILABLE' ? center.processingReport : null,
  }).center;
}

export function summarizeProductUploadJobs(jobs = []) {
  const summary = {
    total: 0, pendingSubmission: 0, acceptedAwaitingResult: 0,
    processing: 0, processedSuccess: 0, processedWithWarnings: 0,
    processedFailed: 0, rejected: 0, unknown: 0,
  };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    summary.total++;
    if (['STAGED', 'QUEUED', 'PROCESSING', 'PREPARED', 'SUBMITTING'].includes(job?.state)) summary.pendingSubmission++;
    else if (job?.state === 'REJECTED') summary.rejected++;
    else if (job?.state === 'UNKNOWN') summary.unknown++;
    const status = productUploadResultCenter(job).processing.status;
    if (status === 'PROCESSING' || status === 'RECEIVED') summary.processing++;
    else if (status === 'COMPLETED') summary.processedSuccess++;
    else if (status === 'COMPLETED_WITH_WARNINGS') summary.processedWithWarnings++;
    else if (status === 'FAILED') summary.processedFailed++;
    else if (job?.state === 'COMPLETED') summary.acceptedAwaitingResult++;
  }
  return summary;
}

/** A new worker may safely retry navigation/file selection, but never a job
 * whose click boundary had already been crossed. */
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
