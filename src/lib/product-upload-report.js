import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectProductUploadFile, PRODUCT_UPLOAD_MAX_BYTES } from './product-upload.js';
import { readProductUploadProcessing } from './product-upload-processing.js';
import { readProductUploadReportSummary } from './product-upload-report-summary.js';

const invalid = () => Object.assign(new Error('处理报告无法安全核对'), { code: 'PROCESSING_REPORT_INVALID' });
const EXTENSIONS = new Set(['.xlsx', '.xlsm', '.csv', '.tsv', '.txt']);
const summaries = new Map();
function summaryFor(buffer, sha256) {
  if (!summaries.has(sha256)) {
    if (summaries.size >= 128) summaries.delete(summaries.keys().next().value);
    summaries.set(sha256, readProductUploadReportSummary(buffer));
  }
  return structuredClone(summaries.get(sha256));
}
function looksLikeHtml(buffer) {
  const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le'
    : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : 'utf-8';
  const prefix = new TextDecoder(encoding).decode(buffer.subarray(0, 65536));
  return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype|html|head|body|script|svg|\?xml)\b/i.test(prefix);
}
function directory(dir, create = false) {
  if (create) { try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  if (stat.mode & 0o077) throw invalid();
}
function location(outDir, jobId, create = false) {
  if (typeof jobId !== 'string' || !/^upl_[a-f0-9]{32}$/.test(jobId)) throw invalid();
  const root = path.resolve(outDir), uploads = path.join(root, 'product-uploads'), jobs = path.join(uploads, 'jobs');
  const job = path.join(jobs, jobId), processing = path.join(job, 'processing');
  for (const dir of [root, uploads, jobs, job, processing]) directory(dir);
  const reports = path.join(processing, 'reports');
  directory(reports, create);
  return { reports, metadata: path.join(reports, 'current.json') };
}
function bytes(file, limit) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.mode & 0o077
    || before.size < 1 || before.size > limit) throw invalid();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw invalid();
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    const after = fs.fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) throw invalid();
    return buffer.subarray(0, size);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function write(file, buffer) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Store only the original attachment obtained by the corresponding Ziniao
 * browser. The caller holds the run lease and supplies its active attempt. */
export function saveProductUploadReport({ outDir, jobId, attemptId, buffer, extension, now = new Date() }) {
  const state = readProductUploadProcessing({ outDir, jobId });
  if (!state || state.lastAttempt?.status !== 'RUNNING' || state.lastAttempt.id !== attemptId
    || !Buffer.isBuffer(buffer) || !EXTENSIONS.has(extension)) throw invalid();
  if (looksLikeHtml(buffer)) throw invalid();
  // Amazon's processing summary is an XLSM container even when it contains no
  // VBA. Preserve that format while applying the XLSX archive safety checks;
  // real VBA/ActiveX/embedded objects remain rejected. Upload inputs are unchanged.
  inspectProductUploadFile({ originalName: `processing-report${extension === '.xlsm' ? '.xlsx' : extension}`, buffer, mode: 'STANDARD' });
  const dir = location(outDir, jobId, true), sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = `${sha256}${extension}`, file = path.join(dir.reports, filename);
  if (fs.existsSync(file)) {
    if (!bytes(file, PRODUCT_UPLOAD_MAX_BYTES).equals(buffer)) throw invalid();
  } else write(file, buffer);
  const metadata = { version: 1, binding: state.binding, attemptId, sha256, size: buffer.length, extension,
    observedAt: now.toISOString() };
  const tmp = path.join(dir.reports, `.current-${crypto.randomUUID()}.tmp`);
  try {
    write(tmp, Buffer.from(JSON.stringify(metadata)));
    if (fs.existsSync(dir.metadata)) bytes(dir.metadata, 8192);
    fs.renameSync(tmp, dir.metadata);
    const fd = fs.openSync(dir.reports, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Publish and sync the replacement before removing obsolete attachments.
    // A batch has one current report; repeated refreshes cannot fill the disk
    // with copies that differ only by a generated timestamp.
    for (const name of fs.readdirSync(dir.reports)) {
      if (name === filename || !/^[a-f0-9]{64}\.(?:xlsx|xlsm|csv|tsv|txt)$/.test(name)) continue;
      const old = path.join(dir.reports, name), stat = fs.lstatSync(old);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) fs.unlinkSync(old);
    }
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return { size: buffer.length, extension, sha256, observedAt: metadata.observedAt };
}

/** All reads recheck the job/batch/record binding and the attachment checksum.
 * No Amazon URL or local filesystem path is included in the public projection. */
export function readProductUploadReport({ outDir, jobId, includeBuffer = false }) {
  const state = readProductUploadProcessing({ outDir, jobId });
  if (!state) return null;
  let dir, metadata;
  try {
    dir = location(outDir, jobId);
    metadata = JSON.parse(bytes(dir.metadata, 8192).toString('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw invalid(); }
  if (metadata?.version !== 1 || JSON.stringify(metadata.binding) !== JSON.stringify(state.binding)
    || typeof metadata.attemptId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(metadata.attemptId)
    || !/^[a-f0-9]{64}$/.test(metadata.sha256 || '') || !EXTENSIONS.has(metadata.extension)
    || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > PRODUCT_UPLOAD_MAX_BYTES
    || !Number.isFinite(Date.parse(metadata.observedAt || ''))) throw invalid();
  let buffer;
  try { buffer = bytes(path.join(dir.reports, metadata.sha256 + metadata.extension), PRODUCT_UPLOAD_MAX_BYTES); }
  catch (error) { if (error.code === 'ENOENT') return null; throw invalid(); }
  if (buffer.length !== metadata.size || crypto.createHash('sha256').update(buffer).digest('hex') !== metadata.sha256) throw invalid();
  return { format: metadata.extension.slice(1).toUpperCase(), size: metadata.size, observedAt: metadata.observedAt,
    name: `processing-${state.binding.batchId}${metadata.extension}`, sha256: metadata.sha256,
    summary: summaryFor(buffer, metadata.sha256),
    matchesLatestAttempt: state.lastAttempt?.status === 'SUCCEEDED' && state.lastAttempt.id === metadata.attemptId,
    ...(includeBuffer ? { buffer } : {}) };
}

/** A report from an earlier attempt remains downloadable with its timestamp,
 * but must not silently replace a newer page observation. */
export function mergeProductUploadReportSummary(center, snapshot, report) {
  const result = structuredClone(center);
  if (!report?.summary || !report.matchesLatestAttempt || !snapshot) return { center: result, conflict: false };
  const totals = report.summary.counts;
  if (snapshot.counts.submitted !== totals.submitted || snapshot.counts.success !== totals.success) {
    result.processing.status = 'UNKNOWN';
    return { center: result, conflict: true };
  }
  result.counts = { availability: 'AVAILABLE', ...totals, source: 'AMAZON_PROCESSING_REPORT' };
  result.errors = { availability: 'AVAILABLE', total: report.summary.errorTotal,
    returned: 0, truncated: report.summary.errorTotal > 0, items: [] };
  if (snapshot.status === 'COMPLETED' && (totals.failed > 0 || totals.warning > 0
    || report.summary.successfulWithErrors > 0 || report.summary.errorTotal > 0)) {
    result.processing.status = 'COMPLETED_WITH_WARNINGS';
  }
  return { center: result, conflict: false };
}
