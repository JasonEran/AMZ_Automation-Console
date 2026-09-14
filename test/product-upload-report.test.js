import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectProductUploadFile, PRODUCT_UPLOAD_MAX_BYTES } from '../src/lib/product-upload.js';
import { beginProductUploadProcessing, finishProductUploadProcessing } from '../src/lib/product-upload-processing.js';
import { saveProductUploadReport, readProductUploadReport, mergeProductUploadReportSummary } from '../src/lib/product-upload-report.js';

const NOW = new Date('2026-09-14T01:00:00.000Z');
const CSV = Buffer.from('sku,status\nSYNTHETIC,OK\n');
const invalid = error => error.code === 'PROCESSING_REPORT_INVALID';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('report summaries fill explicit zeros only when the latest report and page quantities agree', () => {
  const center = { processing: { status: 'COMPLETED' }, counts: { success: 1, failed: null, warning: null }, errors: { availability: 'NOT_AVAILABLE' } };
  const snapshot = { status: 'COMPLETED', counts: { submitted: 1, success: 1 } };
  const report = { matchesLatestAttempt: true, summary: { counts: { submitted: 1, success: 1, failed: 0, warning: 0 },
    errorTotal: 0, successfulWithErrors: 0 } };
  const merged = mergeProductUploadReportSummary(center, snapshot, report);
  assert.equal(merged.conflict, false);
  assert.equal(merged.center.counts.failed, 0);
  assert.equal(merged.center.counts.warning, 0);
  assert.equal(merged.center.counts.source, 'AMAZON_PROCESSING_REPORT');
  assert.equal(merged.center.errors.total, 0);
  assert.equal(center.counts.failed, null, 'the original page-only observation is not changed');
  report.summary.counts.warning = 1;
  assert.equal(mergeProductUploadReportSummary(center, snapshot, report).center.processing.status, 'COMPLETED_WITH_WARNINGS');
  report.summary.counts.submitted = 2;
  const conflict = mergeProductUploadReportSummary(center, snapshot, report);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.center.processing.status, 'UNKNOWN');
  assert.equal(conflict.center.counts.failed, null);
  report.matchesLatestAttempt = false;
  assert.deepEqual(mergeProductUploadReportSummary(center, snapshot, report).center, center, 'an older report remains downloadable but cannot replace the latest observation');
});

function fixture(t, { start = true } = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-report-test-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const jobId = `upl_${'1'.repeat(32)}`, dir = path.join(outDir, 'product-uploads', 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = path.join(dir, 'record.json');
  const job = { version: 1, id: jobId, state: 'COMPLETED', mode: 'STANDARD',
    updatedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
    store: { key: 'US-FIXTURE', name: 'Fixture', market: 'US', bindingFingerprint: 'f'.repeat(64) },
    file: { sha256: 'a'.repeat(64), size: 5, extension: '.csv' },
    result: { center: { version: 1, receipt: { status: 'ACCEPTED', evidence: 'UPLOAD_STATUS_ROW' },
      identifiers: { batchId: 'batch-1' } } } };
  fs.writeFileSync(record, JSON.stringify(job), { mode: 0o600 });
  const options = { outDir, jobId, now: NOW }, attempt = start ? beginProductUploadProcessing(options) : null;
  const reports = path.join(dir, 'processing', 'reports');
  return { options, record, reports, metadata: path.join(reports, 'current.json'),
    save: (extra = {}) => saveProductUploadReport({ ...options, attemptId: attempt?.attemptId, buffer: CSV, extension: '.csv', ...extra }),
    attempt, file: (buffer = CSV, extension = '.csv') => path.join(reports, digest(buffer) + extension) };
}

function structuralXlsx(extra = []) {
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50);
  const entries = ['[Content_Types].xml', 'xl/workbook.xml', ...extra].map(name => {
    const text = Buffer.from(name), entry = Buffer.alloc(46 + text.length);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(text.length, 28); text.copy(entry, 46); return entry;
  });
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  return Buffer.concat([local, ...entries, end]);
}

test('processing reports preserve original bytes and publish only safe download metadata', t => {
  const f = fixture(t), original = fs.readFileSync(f.record), saved = f.save();
  const view = readProductUploadReport(f.options);
  assert.deepEqual(view, { format: 'CSV', size: CSV.length, observedAt: NOW.toISOString(),
    name: 'processing-batch-1.csv', sha256: digest(CSV), summary: null, matchesLatestAttempt: false });
  assert.equal(saved.sha256, digest(CSV));
  assert.deepEqual(readProductUploadReport({ ...f.options, includeBuffer: true }).buffer, CSV);
  assert.deepEqual(fs.readFileSync(f.record), original);
  assert.doesNotMatch(JSON.stringify(view), /recordSHA|binding|storeKey|Fingerprint|current\.json|product-uploads|https?:/);
  assert.equal(JSON.stringify(view).includes('a'.repeat(64)), false);
  assert.equal(JSON.stringify(view).includes('f'.repeat(64)), false);
  for (const file of [f.file(), f.metadata]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.reports).mode & 0o777, 0o700);
  finishProductUploadProcessing({ ...f.options, attemptId: f.attempt.attemptId,
    snapshot: { source: 'AMAZON_UPLOAD_STATUS_ROW', batchId: 'batch-1', status: 'COMPLETED',
      processingState: 'DONE', counts: { submitted: 1, success: 1, failed: null, warning: null } } });
  assert.equal(readProductUploadReport(f.options).matchesLatestAttempt, true);
  const next = beginProductUploadProcessing(f.options);
  assert.equal(readProductUploadReport(f.options).matchesLatestAttempt, false);
  finishProductUploadProcessing({ ...f.options, attemptId: next.attemptId, errorCode: 'READ_FAILED' });
  assert.equal(readProductUploadReport(f.options).matchesLatestAttempt, false);
  assert.deepEqual(readProductUploadReport({ ...f.options, includeBuffer: true }).buffer, CSV,
    'a failed refresh retains the original report without presenting it as the latest observation');
});

test('processing reports are absent normally until downloaded and after attachment retention', t => {
  const f = fixture(t, { start: false });
  assert.equal(readProductUploadReport(f.options), null);
  const attempt = beginProductUploadProcessing(f.options);
  assert.equal(readProductUploadReport(f.options), null);
  f.save({ attemptId: attempt.attemptId }); fs.unlinkSync(f.file());
  assert.equal(readProductUploadReport({ ...f.options, includeBuffer: true }), null);
});

test('only the current running read attempt can save a report, with no terminal ledger mutation', t => {
  const f = fixture(t), original = fs.readFileSync(f.record);
  assert.throws(() => f.save({ attemptId: 'another-attempt' }), invalid);
  const next = beginProductUploadProcessing(f.options);
  assert.throws(() => f.save(), invalid);
  f.save({ attemptId: next.attemptId });
  finishProductUploadProcessing({ ...f.options, attemptId: next.attemptId, errorCode: 'READ_FINISHED' });
  assert.throws(() => f.save({ attemptId: next.attemptId }), invalid);
  assert.deepEqual(readProductUploadReport({ ...f.options, includeBuffer: true }).buffer, CSV);
  assert.deepEqual(fs.readFileSync(f.record), original);
});

test('report reads and writes reject changed job record bytes, batch and store bindings', t => {
  const f = fixture(t); f.save(); const original = fs.readFileSync(f.record);
  for (const mutate of [job => { job.result.center.identifiers.batchId = 'other-batch'; },
    job => { job.store.bindingFingerprint = 'b'.repeat(64); }, job => { job.file.sha256 = 'c'.repeat(64); }]) {
    const job = JSON.parse(original); mutate(job); fs.writeFileSync(f.record, JSON.stringify(job));
    assert.throws(() => readProductUploadReport(f.options), { code: 'UPLOAD_PROCESSING_CORRUPT' });
    assert.throws(() => f.save(), { code: 'UPLOAD_PROCESSING_CORRUPT' });
  }
  fs.writeFileSync(f.record, Buffer.concat([original, Buffer.from('\n')]));
  assert.throws(() => readProductUploadReport(f.options), { code: 'UPLOAD_PROCESSING_CORRUPT' });
  fs.writeFileSync(f.record, original);
  const metadata = fs.readFileSync(f.metadata);
  for (const field of ['jobId', 'storeKey', 'sha256', 'recordSHA256', 'batchId', 'storeFingerprint']) {
    const value = JSON.parse(metadata); value.binding[field] = 'wrong'; fs.writeFileSync(f.metadata, JSON.stringify(value));
    assert.throws(() => readProductUploadReport(f.options), invalid, field);
  }
});

test('reports reject malformed content, executable or macro formats and oversized files before publication', t => {
  const f = fixture(t);
  for (const input of [{ buffer: Buffer.alloc(0) }, { buffer: 'not a buffer' },
    { buffer: Buffer.from([0, 1, 2]) }, { buffer: Buffer.from('not a zip'), extension: '.xlsx' },
    { extension: '.xlsm' }, { extension: '.html' }, { extension: '.zip' }, { extension: '../file.csv' },
    { buffer: structuralXlsx(['xl/vbaProject.bin']), extension: '.xlsx' },
    { buffer: Buffer.alloc(PRODUCT_UPLOAD_MAX_BYTES + 1, 65) }]) {
    assert.throws(() => f.save(input));
    assert.equal(fs.existsSync(f.metadata), false);
  }
  // This only exercises the existing bounded ZIP structural check, not Excel's business validation.
  const xlsx = structuralXlsx(); f.save({ buffer: xlsx, extension: '.xlsx' });
  assert.deepEqual(readProductUploadReport({ ...f.options, includeBuffer: true }).buffer, xlsx);
});

test('XLSM reports preserve safe container bytes but never permit macro content or XLSM upload inputs', t => {
  const f = fixture(t), buffer = structuralXlsx();
  const saved = f.save({ buffer, extension: '.xlsm' });
  const view = readProductUploadReport({ ...f.options, includeBuffer: true });
  assert.equal(view.format, 'XLSM'); assert.equal(view.name, 'processing-batch-1.xlsm');
  assert.equal(saved.sha256, digest(buffer)); assert.deepEqual(view.buffer, buffer);
  assert.throws(() => inspectProductUploadFile({ originalName: 'input.xlsm', buffer }), /不支持的文件格式/);
  const metadata = fs.readFileSync(f.metadata);
  for (const entry of ['xl/vbaProject.bin', 'xl/activeX/activeX1.bin', 'xl/embeddings/oleObject1.bin']) {
    const unsafe = structuralXlsx([entry]);
    assert.throws(() => f.save({ buffer: unsafe, extension: '.xlsm' }), /宏或嵌入对象/);
    assert.throws(() => inspectProductUploadFile({ originalName: 'input.xlsx', buffer: unsafe }), /宏或嵌入对象/);
    assert.deepEqual(fs.readFileSync(f.metadata), metadata);
    assert.deepEqual(readProductUploadReport({ ...f.options, includeBuffer: true }).buffer, buffer);
  }
  f.save();
  assert.equal(fs.existsSync(f.file(buffer, '.xlsm')), false, 'replacing an XLSM report also removes its obsolete attachment');
});

test('UTF-8 and UTF-16 HTML login/error pages cannot be saved as text reports', t => {
  const f = fixture(t);
  for (const text of ['<html>fixture error</html>', '\n<!-- fixture --> <html>fixture login</html>',
    '<!doctype html><body>fixture</body>', '<script>fixture</script>']) {
    const le = Buffer.from(text, 'utf16le'), be = Buffer.from(le).swap16();
    for (const buffer of [Buffer.from(text), Buffer.concat([Buffer.from([0xff, 0xfe]), le]),
      Buffer.concat([Buffer.from([0xfe, 0xff]), be])]) {
      assert.throws(() => f.save({ buffer, extension: '.txt' }), invalid);
      assert.equal(fs.existsSync(f.metadata), false);
    }
  }
});

test('report metadata and attachment tampering fail closed before bytes reach the public caller', t => {
  const f = fixture(t); f.save(); const metadata = fs.readFileSync(f.metadata);
  for (const value of ['{', JSON.stringify({ ...JSON.parse(metadata), size: CSV.length + 1 }),
    JSON.stringify({ ...JSON.parse(metadata), extension: '/../private' }),
    JSON.stringify({ ...JSON.parse(metadata), sha256: '../record' })]) {
    fs.writeFileSync(f.metadata, value);
    assert.throws(() => readProductUploadReport({ ...f.options, includeBuffer: true }), invalid);
  }
  fs.writeFileSync(f.metadata, metadata);
  const changed = Buffer.from(CSV); changed[0] ^= 1; fs.writeFileSync(f.file(), changed);
  assert.throws(() => readProductUploadReport({ ...f.options, includeBuffer: true }), invalid);
});

test('report files reject symbolic links, hard links and non-private permissions on save and read', t => {
  for (const target of ['metadata', 'attachment']) for (const mode of ['symlink', 'hardlink', 'permissions']) {
    const f = fixture(t); f.save(); const file = target === 'metadata' ? f.metadata : f.file();
    const original = fs.readFileSync(file), external = path.join(f.options.outDir, 'external');
    fs.writeFileSync(external, original, { mode: 0o600 }); fs.unlinkSync(file);
    if (mode === 'symlink') fs.symlinkSync(external, file);
    else if (mode === 'hardlink') fs.linkSync(external, file);
    else {
      fs.writeFileSync(file, original, { mode: 0o644 });
      fs.chmodSync(file, 0o644);
    }
    assert.throws(() => readProductUploadReport({ ...f.options, includeBuffer: true }), invalid, `${target}: ${mode}`);
    assert.throws(() => f.save(), invalid, `${target}: ${mode}`);
    assert.deepEqual(fs.readFileSync(external), original);
  }
});

test('report directories cannot be substituted by links or relaxed to public permissions', t => {
  for (const mode of ['symlink', 'permissions']) {
    const f = fixture(t); f.save();
    if (mode === 'symlink') {
      const moved = path.join(f.options.outDir, 'moved'); fs.renameSync(f.reports, moved); fs.symlinkSync(moved, f.reports);
    } else fs.chmodSync(f.reports, 0o777);
    assert.throws(() => readProductUploadReport({ ...f.options, includeBuffer: true }), invalid, mode);
    assert.throws(() => f.save(), invalid, mode);
  }
});

test('attachment growth between its verified stat and read is bounded and rejected', t => {
  const f = fixture(t); f.save(); const originalRead = fs.readSync, originalOpen = fs.openSync;
  let targetFd = null, changed = false, requested = 0;
  fs.openSync = function (file, ...args) { const fd = originalOpen.call(this, file, ...args); if (file === f.file()) targetFd = fd; return fd; };
  fs.readSync = function (fd, buffer, offset, length, ...args) {
    if (fd === targetFd && !changed) { changed = true; requested = length; fs.appendFileSync(f.file(), Buffer.alloc(1024, 65)); }
    return originalRead.call(this, fd, buffer, offset, length, ...args);
  };
  try { assert.throws(() => readProductUploadReport({ ...f.options, includeBuffer: true }), invalid); }
  finally { fs.openSync = originalOpen; fs.readSync = originalRead; }
  assert.equal(changed, true); assert.equal(requested, CSV.length + 1);
});

test('successful replacement retains only the current attachment and repeated identical saves do not grow storage', t => {
  const f = fixture(t); f.save(); f.save();
  assert.deepEqual(fs.readdirSync(f.reports).sort(), ['current.json', path.basename(f.file())].sort());
  const newer = Buffer.from('sku,status\nSYNTHETIC,DONE\n'); f.save({ buffer: newer });
  assert.deepEqual(fs.readdirSync(f.reports).sort(), ['current.json', path.basename(f.file(newer))].sort());
  assert.deepEqual(readProductUploadReport({ ...f.options, includeBuffer: true }).buffer, newer);
});

test('metadata publication failure preserves the previously verified downloadable report', t => {
  const f = fixture(t); f.save(); const metadata = fs.readFileSync(f.metadata), originalRename = fs.renameSync;
  fs.renameSync = function (from, to) { if (to === f.metadata) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); return originalRename.call(this, from, to); };
  try { assert.throws(() => f.save({ buffer: Buffer.from('sku,status\nSYNTHETIC,NEW\n') }), { code: 'EIO' }); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(f.metadata), metadata);
  assert.deepEqual(readProductUploadReport({ ...f.options, includeBuffer: true }).buffer, CSV);
  assert.equal(fs.readdirSync(f.reports).some(name => name.endsWith('.tmp')), false);
});
