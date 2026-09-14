import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireRunLock, releaseRunLock } from '../src/checks/run.js';
import { productUploadStoreFingerprint } from '../src/lib/product-upload.js';
import { readProductUploadProcessing, requestProductUploadProcessing } from '../src/lib/product-upload-processing.js';
import { runProductUploadWorker } from '../src/tools/product-upload-worker.js';

function fixture(t) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-results-worker-'));
  const store = { key: 'FIXTURE', name: 'Fixture Store', id: '101', market: 'US', host: 'sellercentral.amazon.com' };
  const jobId = `upl_${'f'.repeat(32)}`;
  const dir = path.join(outDir, 'product-uploads', 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = path.join(dir, 'record.json');
  fs.writeFileSync(record, JSON.stringify({ version: 1, id: jobId, state: 'COMPLETED', mode: 'STANDARD',
    finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    store: { key: store.key, name: store.name, market: store.market, bindingFingerprint: productUploadStoreFingerprint(store) },
    file: { sha256: 'a'.repeat(64), size: 100, extension: '.xlsx' },
    result: { center: { receipt: { status: 'ACCEPTED' }, identifiers: { batchId: '123456' } } },
  }), { mode: 0o600 });
  const original = fs.readFileSync(record), calls = [], warnings = [];
  const previous = Object.fromEntries(['AMZGUARD_PRODUCT_UPLOAD_ENABLED', 'AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED'].map(key => [key, process.env[key]]));
  process.env.AMZGUARD_PRODUCT_UPLOAD_ENABLED = '1';
  process.env.AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED = '0';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  const zn = {
    async storeOpen(options) { calls.push('open'); assert.equal(options.id, store.id); return { storeId: 'fixture-browser' }; },
    async readProductUploadProcessing(_id, options) {
      calls.push('read');
      assert.equal(options.batchId, '123456'); assert.equal(options.expectedFileName, 'payload.xlsx');
      assert.ok(fs.existsSync(path.join(outDir, 'runtime', 'run.lock')));
      return { version: 1, source: 'AMAZON_UPLOAD_STATUS_ROW', batchId: '123456', status: 'COMPLETED',
        processingState: 'DONE', counts: { submitted: 1, success: 1, failed: null, warning: null } };
    },
    async storeClose() { calls.push('close'); },
    async prepareProductBulkUpload() { assert.fail('result polling must never select a file'); },
    async submitProductBulkUpload() { assert.fail('result polling must never submit'); },
  };
  const config = { outDir }, logger = { info() {}, warn(message) { warnings.push(message); } };
  return { outDir, jobId, record, original, calls, warnings, zn, store, config,
    run: () => runProductUploadWorker({ config, stores: [store], logger, zn }) };
}

test('accepted batch results finish under the shared lease with write execution disabled, no payload and no notifications', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.processingStatus, 'COMPLETED');
  assert.deepEqual(f.calls, ['open', 'read', 'close']);
  assert.deepEqual(fs.readFileSync(f.record), f.original);
  assert.equal(readProductUploadProcessing(f).snapshot.counts.success, 1);
  assert.equal(readProductUploadProcessing(f).snapshot.counts.warning, null);
  assert.equal(fs.existsSync(path.join(f.outDir, 'channels')), false);
  assert.equal(fs.existsSync(path.join(f.outDir, 'runtime/run.lock')), false);
  assert.equal((await f.run()).processed, false);
  assert.deepEqual(f.calls, ['open', 'read', 'close'], 'terminal result is not automatically collected again');
});

test('result read failures preserve the prior snapshot and never change the upload receipt or retry an upload', async t => {
  const f = fixture(t);
  await f.run();
  const old = readProductUploadProcessing(f).snapshot;
  requestProductUploadProcessing(f);
  f.zn.readProductUploadProcessing = async () => { throw new Error('signed-private-link=secret'); };
  assert.equal((await f.run()).errorCode, 'PROCESSING_READ_FAILED');
  assert.deepEqual(readProductUploadProcessing(f).snapshot, old);
  assert.equal(readProductUploadProcessing(f).lastAttempt.status, 'FAILED');
  assert.deepEqual(fs.readFileSync(f.record), f.original);
  assert.doesNotMatch(f.warnings.join(' '), /secret|signed-private/);
  assert.equal(f.calls.at(-1), 'close');
});

test('changed store bindings and an occupied run lease cannot open an upload-result browser', async t => {
  const f = fixture(t);
  const lease = acquireRunLock({ outDir: f.outDir, label: 'fixture-other-worker' });
  try {
    assert.equal((await f.run()).reason, 'collector-busy');
    assert.deepEqual(f.calls, []);
  } finally { releaseRunLock(lease); }
  f.store.id = '102';
  assert.equal((await f.run()).errorCode, 'PROCESSING_STORE_CHANGED');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readFileSync(f.record), f.original);
});

test('disabled or invalid result configuration cannot read Amazon', async t => {
  const f = fixture(t);
  f.config.productUpload = { results: { enabled: false } };
  assert.equal((await f.run()).reason, 'results-disabled');
  f.config.productUpload.results.intervalMinutes = 0;
  await assert.rejects(f.run, /参数无效/);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(path.join(f.outDir, 'runtime/run.lock')), false);
});
