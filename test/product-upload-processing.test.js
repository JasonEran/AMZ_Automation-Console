import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getProductUploadProcessingSettings, readProductUploadProcessing, requestProductUploadProcessing,
  nextProductUploadProcessingJob, beginProductUploadProcessing, finishProductUploadProcessing,
  publicProductUploadProcessing,
} from '../src/lib/product-upload-processing.js';

const NOW = new Date('2026-09-14T01:00:00.000Z');
function fixture(t, count = 1) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-processing-test-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const ids = [], records = [];
  for (let i = 1; i <= count; i++) {
    const jobId = `upl_${String(i).padStart(32, '0')}`;
    const dir = path.join(outDir, 'product-uploads', 'jobs', jobId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record = path.join(dir, 'record.json');
    const job = { version: 1, id: jobId, state: 'COMPLETED', mode: 'STANDARD',
      updatedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
      store: { key: `US-${i}`, name: `Fixture ${i}`, market: 'US', bindingFingerprint: 'f'.repeat(64) },
      file: { sha256: 'a'.repeat(64), size: 5, extension: '.csv' },
      result: { center: { version: 1, receipt: { status: 'ACCEPTED', evidence: 'UPLOAD_STATUS_ROW' },
        identifiers: { batchId: `batch-${i}` } } } };
    fs.writeFileSync(record, JSON.stringify(job), { mode: 0o600 });
    ids.push(jobId); records.push(record);
  }
  return { outDir, ids, records,
    options: (i = 0) => ({ outDir, jobId: ids[i], now: NOW }),
    file: (i = 0) => path.join(path.dirname(records[i]), 'processing', 'current.json'),
    patchJob(patch, i = 0) { const job = JSON.parse(fs.readFileSync(records[i])); patch(job); fs.writeFileSync(records[i], JSON.stringify(job)); },
  };
}
const snapshot = (batchId = 'batch-1', extra = {}) => ({ status: 'PROCESSING', batchId,
  source: 'AMAZON_UPLOAD_STATUS_ROW', counts: { submitted: 3, success: null, failed: null, warning: null }, ...extra });
const code = expected => error => error.code === expected;

test('processing settings have bounded defaults and invalid configuration fails closed', () => {
  assert.deepEqual(getProductUploadProcessingSettings({}), { enabled: true, intervalMinutes: 5, maxAgeHours: 72,
    timeoutMs: 120000, intervalMs: 300000, maxAgeMs: 259200000 });
  for (const results of [null, [], { enabled: 'false' }, { intervalMinutes: 0 }, { intervalMinutes: 61 },
    { intervalMinutes: '5' }, { maxAgeHours: 169 }, { maxAgeHours: 0 }, { timeoutMs: 9999 },
    { timeoutMs: 180001 }, { arbitrary: 1 }]) {
    assert.throws(() => getProductUploadProcessingSettings({ productUpload: { results } }), code('UPLOAD_PROCESSING_INVALID'));
  }
});

test('processing requests and successful snapshots leave the terminal upload ledger and reset binding unchanged', t => {
  const f = fixture(t), options = f.options(), original = fs.readFileSync(f.records[0]);
  const reset = path.join(path.dirname(f.records[0]), 'reset.json');
  const resetBytes = Buffer.from(JSON.stringify({ fixtureRecordSHA256: crypto.createHash('sha256').update(original).digest('hex') }));
  fs.writeFileSync(reset, resetBytes, { mode: 0o600 });
  assert.equal(readProductUploadProcessing(options), null);
  const requested = requestProductUploadProcessing({ ...options, actor: 'fixture-admin' });
  assert.equal(requestProductUploadProcessing(options).request.id, requested.request.id);
  const started = beginProductUploadProcessing(options);
  assert.equal(started.binding.storeFingerprint, 'f'.repeat(64));
  assert.equal(requestProductUploadProcessing(options).request, null);
  finishProductUploadProcessing({ ...options, attemptId: started.attemptId, snapshot: snapshot() });
  assert.deepEqual(fs.readFileSync(f.records[0]), original);
  assert.deepEqual(fs.readFileSync(reset), resetBytes);
  const view = publicProductUploadProcessing(options);
  assert.equal(view.snapshot.status, 'PROCESSING');
  assert.deepEqual(view.snapshot.counts, { submitted: 3, success: null, failed: null, warning: null });
  assert.equal(view.lastAttempt.status, 'SUCCEEDED');
  assert.equal(view.queued, false); assert.equal(view.running, false);
  assert.doesNotMatch(JSON.stringify(view), /recordSHA|sha256|binding|Fingerprint|fixture-admin|current\.json/);
  assert.equal(fs.statSync(f.file()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.file())).mode & 0o777, 0o700);
});

test('only accepted jobs with batch evidence can request or start processing refreshes', t => {
  const f = fixture(t);
  for (const state of ['UNKNOWN', 'REJECTED', 'FAILED_BEFORE_SUBMIT', 'STAGED', 'SUBMITTING']) {
    f.patchJob(job => { job.state = state; });
    assert.equal(publicProductUploadProcessing(f.options()).eligible, false);
    assert.throws(() => requestProductUploadProcessing(f.options()), code('UPLOAD_PROCESSING_NOT_ELIGIBLE'));
    assert.throws(() => beginProductUploadProcessing(f.options()), code('UPLOAD_PROCESSING_NOT_ELIGIBLE'));
  }
  f.patchJob(job => { job.state = 'COMPLETED'; job.result.center.identifiers.batchId = ''; });
  assert.throws(() => requestProductUploadProcessing(f.options()), code('UPLOAD_PROCESSING_NOT_ELIGIBLE'));
  assert.equal(fs.existsSync(f.file()), false);
});

test('processing refresh failures retain older evidence while exposing the failed latest check', t => {
  const f = fixture(t), options = f.options();
  let start = beginProductUploadProcessing(options);
  finishProductUploadProcessing({ ...options, attemptId: start.attemptId, snapshot: snapshot() });
  const old = readProductUploadProcessing(options).snapshot;
  start = beginProductUploadProcessing({ ...options, now: new Date(NOW.getTime() + 60000) });
  finishProductUploadProcessing({ ...options, now: new Date(NOW.getTime() + 61000), attemptId: start.attemptId, errorCode: 'PAGE_NOT_READY' });
  const view = publicProductUploadProcessing(options);
  assert.deepEqual(view.snapshot, old);
  assert.equal(view.lastAttempt.status, 'FAILED');
  assert.equal(view.lastAttempt.errorCode, 'PAGE_NOT_READY');
});

test('completed and replaced attempts reject replay and late results without changing current evidence', t => {
  const f = fixture(t), options = f.options();
  const first = beginProductUploadProcessing(options), second = beginProductUploadProcessing(options);
  assert.throws(() => finishProductUploadProcessing({ ...options, attemptId: first.attemptId, snapshot: snapshot() }), code('UPLOAD_PROCESSING_ATTEMPT_CONFLICT'));
  finishProductUploadProcessing({ ...options, attemptId: second.attemptId, snapshot: snapshot() });
  const saved = fs.readFileSync(f.file());
  assert.throws(() => finishProductUploadProcessing({ ...options, attemptId: second.attemptId, errorCode: 'TIMEOUT' }), code('UPLOAD_PROCESSING_ATTEMPT_CONFLICT'));
  assert.deepEqual(fs.readFileSync(f.file()), saved);
});

test('processing snapshots require the bound batch and strict status/count schema without inventing zeros', t => {
  const f = fixture(t), options = f.options(), started = beginProductUploadProcessing(options);
  for (const value of [snapshot('other-batch'), snapshot('batch-1', { status: 'OK' }),
    snapshot('batch-1', { source: 'ARBITRARY' }), snapshot('batch-1', { counts: { success: '1' } }),
    snapshot('batch-1', { counts: { failed: -1 } }), snapshot('batch-1', { counts: { warning: 1.5 } }),
    snapshot('batch-1', { counts: { arbitrary: 0 } }), snapshot('batch-1', { processingState: '<script>' }),
    snapshot('batch-1', { observedAt: '2000-01-01' }), snapshot('batch-1', { report: '/private' }), null]) {
    assert.throws(() => finishProductUploadProcessing({ ...options, attemptId: started.attemptId, snapshot: value }), code('UPLOAD_PROCESSING_INVALID'));
  }
  finishProductUploadProcessing({ ...options, attemptId: started.attemptId,
    snapshot: snapshot('batch-1', { status: 'UNKNOWN', counts: {}, statusText: 'token=secret https://example.test/?token=private' }) });
  const view = publicProductUploadProcessing(options);
  assert.deepEqual(view.snapshot.counts, { submitted: null, success: null, failed: null, warning: null });
  assert.equal(view.snapshot.status, 'UNKNOWN');
  assert.equal(view.snapshot.observedAt, NOW.toISOString());
  assert.doesNotMatch(view.snapshot.statusText, /secret|private/);
});

test('sidecar bindings detect any change to original record bytes, store fingerprint or batch', t => {
  const f = fixture(t), options = f.options();
  requestProductUploadProcessing(options);
  const record = fs.readFileSync(f.records[0]);
  fs.appendFileSync(f.records[0], '\n');
  assert.throws(() => readProductUploadProcessing(options), code('UPLOAD_PROCESSING_CORRUPT'));
  fs.writeFileSync(f.records[0], record);
  const original = fs.readFileSync(f.file());
  for (const key of ['jobId', 'storeKey', 'sha256', 'recordSHA256', 'batchId', 'storeFingerprint']) {
    const row = JSON.parse(original); row.binding[key] = 'wrong'; fs.writeFileSync(f.file(), JSON.stringify(row));
    assert.throws(() => publicProductUploadProcessing(options), code('UPLOAD_PROCESSING_CORRUPT'));
  }
});

test('processing storage rejects corrupt, oversized, symbolic, hard-linked and publicly readable sidecars', t => {
  const f = fixture(t), options = f.options();
  requestProductUploadProcessing(options);
  const original = fs.readFileSync(f.file()), external = path.join(f.outDir, 'external');
  fs.writeFileSync(external, original, { mode: 0o600 });
  for (const mode of ['corrupt', 'oversized', 'symlink', 'hardlink', 'permissions']) {
    fs.unlinkSync(f.file());
    if (mode === 'symlink') fs.symlinkSync(external, f.file());
    else if (mode === 'hardlink') fs.linkSync(external, f.file());
    else {
      fs.writeFileSync(f.file(), mode === 'corrupt' ? '{' : mode === 'oversized' ? ' '.repeat(128 * 1024 + 1) : original,
        { mode: mode === 'permissions' ? 0o644 : 0o600 });
      if (mode === 'permissions') fs.chmodSync(f.file(), 0o644);
    }
    assert.throws(() => readProductUploadProcessing(options), code('UPLOAD_PROCESSING_CORRUPT'), mode);
  }
});

test('automatic refreshes honor five-minute intervals, age windows and terminal processing results', t => {
  const f = fixture(t), options = f.options();
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: NOW }).jobId, f.ids[0]);
  let started = beginProductUploadProcessing(options);
  finishProductUploadProcessing({ ...options, attemptId: started.attemptId, snapshot: snapshot() });
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: new Date(NOW.getTime() + 299999) }), null);
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: new Date(NOW.getTime() + 300000) }).jobId, f.ids[0]);
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: new Date(NOW.getTime() + 72 * 3600000 + 1) }), null);
  started = beginProductUploadProcessing(options);
  finishProductUploadProcessing({ ...options, attemptId: started.attemptId, snapshot: snapshot('batch-1', { status: 'COMPLETED_WITH_WARNINGS' }) });
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: new Date(NOW.getTime() + 300000) }), null);
  requestProductUploadProcessing(options);
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: new Date(NOW.getTime() + 73 * 3600000) }).reason, 'MANUAL');
});

test('refresh scheduling is fair, excludes jobs already handled and recovers only read attempts', t => {
  const f = fixture(t, 2), options = f.options();
  beginProductUploadProcessing(options);
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: NOW, excludeJobIds: [f.ids[0]] }).jobId, f.ids[1]);
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: NOW, excludeJobIds: f.ids }), null);
  const next = nextProductUploadProcessingJob({ outDir: f.outDir, now: NOW });
  assert.ok(f.ids.includes(next.jobId));
  const original = fs.readFileSync(f.records[0]);
  const restarted = beginProductUploadProcessing(options);
  finishProductUploadProcessing({ ...options, attemptId: restarted.attemptId, errorCode: 'INTERRUPTED_READ' });
  assert.deepEqual(fs.readFileSync(f.records[0]), original);
  assert.equal(fs.existsSync(path.join(f.outDir, 'product-uploads', 'queue')), false);
});

test('disabled refresh settings reject manual queueing and automatic selection without creating files', t => {
  const f = fixture(t), config = { productUpload: { results: { enabled: false } } };
  assert.throws(() => requestProductUploadProcessing({ ...f.options(), config }), code('UPLOAD_PROCESSING_DISABLED'));
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: NOW, config }), null);
  assert.equal(publicProductUploadProcessing({ ...f.options(), config }).eligible, false);
  assert.equal(fs.existsSync(f.file()), false);
});

test('failed atomic publication preserves the prior snapshot and cleans its exact temporary file', t => {
  const f = fixture(t), options = f.options();
  requestProductUploadProcessing(options);
  const original = fs.readFileSync(f.file()), rename = fs.renameSync;
  fs.renameSync = function(source, target) {
    if (target === f.file()) throw new Error('fixture publication failed');
    return rename.call(this, source, target);
  };
  try { assert.throws(() => beginProductUploadProcessing(options), code('UPLOAD_PROCESSING_SAVE_FAILED')); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(f.file()), original);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file())), ['current.json']);
});

test('completed processing requires positive matching submitted/success counts without known errors or warnings', t => {
  const f = fixture(t), options = f.options(), started = beginProductUploadProcessing(options);
  for (const counts of [{}, { submitted: 0, success: 0 }, { submitted: 3, success: 2 },
    { submitted: 3, success: 3, failed: 1 }, { submitted: 3, success: 3, warning: 1 }]) {
    assert.throws(() => finishProductUploadProcessing({ ...options, attemptId: started.attemptId,
      snapshot: snapshot('batch-1', { status: 'COMPLETED', counts }) }), code('UPLOAD_PROCESSING_INVALID'));
  }
  finishProductUploadProcessing({ ...options, attemptId: started.attemptId,
    snapshot: snapshot('batch-1', { version: 1, status: 'COMPLETED', processingState: 'DONE',
      counts: { submitted: 3, success: 3, failed: 0 }, submittedAt: '2026-09-14T08:59:00+08:00' }) });
  const saved = publicProductUploadProcessing(options).snapshot;
  assert.equal(saved.status, 'COMPLETED');
  assert.equal(saved.processingState, 'DONE');
  assert.equal(saved.counts.warning, null);
  assert.equal(saved.submittedAt, '2026-09-14T00:59:00.000Z');
  const row = JSON.parse(fs.readFileSync(f.file())); row.snapshot.counts.success = 2;
  fs.writeFileSync(f.file(), JSON.stringify(row));
  assert.throws(() => readProductUploadProcessing(options), code('UPLOAD_PROCESSING_CORRUPT'));
});

test('legacy store bindings remain explicit and refresh scheduling never reads or requires the original payload', t => {
  const f = fixture(t, 2);
  f.patchJob(job => { delete job.store.bindingFingerprint; });
  const first = beginProductUploadProcessing(f.options());
  assert.equal(first.binding.storeFingerprint, null);
  finishProductUploadProcessing({ ...f.options(), attemptId: first.attemptId, errorCode: 'READ_FAILED' });
  assert.equal(nextProductUploadProcessingJob({ outDir: f.outDir, now: NOW }).jobId, f.ids[1]);
  for (const record of f.records) assert.deepEqual(fs.readdirSync(path.dirname(record)).filter(name => name.startsWith('payload')), []);
});

test('sidecar schema rejects prototype fields and linked processing directories without changing foreign files', t => {
  const f = fixture(t), options = f.options();
  requestProductUploadProcessing(options);
  const original = fs.readFileSync(f.file());
  const changed = JSON.parse(original);
  Object.defineProperty(changed, '__proto__', { enumerable: true, value: { status: 'COMPLETED' } });
  fs.writeFileSync(f.file(), JSON.stringify(changed));
  assert.throws(() => readProductUploadProcessing(options), code('UPLOAD_PROCESSING_CORRUPT'));
  const other = path.join(f.outDir, 'foreign'); fs.mkdirSync(other, { mode: 0o700 });
  fs.writeFileSync(path.join(other, 'current.json'), original, { mode: 0o600 });
  fs.rmSync(path.dirname(f.file()), { recursive: true }); fs.symlinkSync(other, path.dirname(f.file()));
  assert.throws(() => requestProductUploadProcessing(options), code('UPLOAD_PROCESSING_CORRUPT'));
  assert.deepEqual(fs.readFileSync(path.join(other, 'current.json')), original);
});

test('stored request and attempt identifiers and error codes never accept coerced array values', t => {
  const f = fixture(t), options = f.options();
  requestProductUploadProcessing(options);
  let original = fs.readFileSync(f.file()), row = JSON.parse(original);
  row.request.id = [row.request.id]; fs.writeFileSync(f.file(), JSON.stringify(row));
  assert.throws(() => readProductUploadProcessing(options), code('UPLOAD_PROCESSING_CORRUPT'));
  fs.writeFileSync(f.file(), original);
  const started = beginProductUploadProcessing(options);
  finishProductUploadProcessing({ ...options, attemptId: started.attemptId, errorCode: 'TIMEOUT' });
  original = fs.readFileSync(f.file());
  for (const field of ['id', 'errorCode']) {
    row = JSON.parse(original); row.lastAttempt[field] = [row.lastAttempt[field]];
    fs.writeFileSync(f.file(), JSON.stringify(row));
    assert.throws(() => readProductUploadProcessing(options), code('UPLOAD_PROCESSING_CORRUPT'));
  }
});
