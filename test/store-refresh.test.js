import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS, deepMerge, readEffectiveStores, refreshSelectedStores } from '../src/lib/config.js';
import { createStoreRegistry } from '../src/lib/store-registry.js';
import { runCheckById, runSlot } from '../src/checks/run.js';
import { runProductUploadWorker } from '../src/tools/product-upload-worker.js';
import { runProductUploadProbe } from '../src/tools/probe-product-upload.js';
import { runIntelligenceWorker } from '../src/intelligence/worker.js';
import { saveTarget, requestRun } from '../src/intelligence/store.js';
import { stageProductUpload, confirmProductUpload, readProductUploadJob } from '../src/lib/product-upload.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-refresh-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const outDir = path.join(temp, 'out'), storesPath = path.join(temp, 'stores.json');
  const original = [{ key: 'US-A', name: 'Old profile', id: '1', market: 'US' }, { key: 'US-B', name: 'Other', id: '2', market: 'US' }];
  fs.writeFileSync(storesPath, JSON.stringify(original), { mode: 0o600 });
  const config = deepMerge(DEFAULTS, {
    ziniao: { retries: 0, settleMs: 0, closeStoreAfterCheck: true },
    storeHealth: { screenshot: false, saveRawPageText: false },
    codex: { enabled: false }, alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
    crm: { enabled: false },
  });
  Object.assign(config, { outDir, _storesPath: storesPath });
  const model = createStoreRegistry({ outDir, storesPath });
  const loaded = readEffectiveStores(config);
  const update = (key, patch) => model.update(key, { patch, actor: 'test', expectedRevision: model.read().revision });
  const create = () => model.create({ store: { key: 'US-NEW', name: 'New', id: '3', market: 'US', host: 'sellercentral.amazon.com', enabled: true }, actor: 'test', expectedRevision: model.read().revision });
  return { temp, config, outDir, model, loaded, update, create, lock: path.join(outDir, 'runtime', 'run.lock') };
}
function assertLease(f) { assert.equal(fs.existsSync(f.lock), true, 'store must be opened only while shared lease is held'); }

test('fresh selection keeps explicit keys and order, drops disabled stores and never adds new ones', t => {
  const f = fixture(t);
  f.update('US-A', { name: 'New profile', id: '42' }); f.create();
  const selected = refreshSelectedStores(f.config, [f.loaded[0]]);
  assert.deepEqual(selected.map(store => [store.key, store.id]), [['US-A', '42']]);
  assert.equal(f.loaded[0].id, '1');
  f.update('US-B', { enabled: false });
  assert.deepEqual(refreshSelectedStores(f.config, [f.loaded[1], f.loaded[0]]).map(store => store.key), ['US-A']);
  f.update('US-A', { enabled: false });
  assert.throws(() => refreshSelectedStores(f.config, f.loaded), /停用/);
  assert.equal(refreshSelectedStores({ outDir: f.outDir }, f.loaded), f.loaded, 'injected fixture without config metadata remains supported');
});

test('single-check and slot runners use refreshed binding after taking the lease without expanding selection', async t => {
  const originalFetch = globalThis.fetch; let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error('Network is forbidden in this regression'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const slot of [false, true]) {
    const f = fixture(t); f.update('US-A', { id: '42' }); f.create();
    const opened = [];
    const zn = { async storeOpen(options) { assertLease(f); opened.push(options.id); throw new Error('mock browser stops before any page access'); }, async storeClose() {} };
    const args = { config: f.config, stores: [f.loaded[0]], zn, logger };
    if (slot) await runSlot({ ...args, slot: 'am', opts: { only: ['store-health'] } });
    else await runCheckById({ ...args, id: 'store-health' });
    assert.deepEqual(opened, ['42']);
    assert.equal(fs.existsSync(f.lock), false);
  }
  assert.equal(outbound, 0);
});

test('disabled or corrupt registry stops a runner before opening browsers and releases its lease', async t => {
  for (const corrupt of [false, true]) {
    const f = fixture(t);
    f.update('US-A', { enabled: false });
    if (corrupt) fs.writeFileSync(path.join(f.outDir, 'runtime', 'store-registry.json'), '{broken', { mode: 0o600 });
    let opens = 0;
    await assert.rejects(runCheckById({ id: 'store-health', config: f.config, stores: [f.loaded[0]], logger,
      zn: { storeOpen() { opens++; throw new Error('must not open'); } } }));
    assert.equal(opens, 0); assert.equal(fs.existsSync(f.lock), false);
  }
});

test('read-only upload probe refreshes binding under its lease and refuses disabled selection', async t => {
  const f = fixture(t); f.update('US-A', { id: '42' });
  const opened = [];
  const zn = { securityCapabilities: { officialZiniaoWebDriverHttp: true },
    async storeOpen(options) { assertLease(f); opened.push(options.id); return { storeId: 'mock' }; },
    async inspectProductBulkUploadPage() { return { exactUrl: true, eligibleFileInputCount: 1 }; }, async storeClose() {} };
  await runProductUploadProbe({ config: f.config, store: f.loaded[0], zn, logger });
  assert.deepEqual(opened, ['42']);
  f.update('US-A', { enabled: false });
  await assert.rejects(runProductUploadProbe({ config: f.config, store: f.loaded[0], zn, logger }), /停用/);
  assert.deepEqual(opened, ['42']); assert.equal(fs.existsSync(f.lock), false);
});

test('intelligence worker refreshes selected profile after lease and does not open disabled stores', async t => {
  for (const disabled of [false, true]) {
    const f = fixture(t);
    saveTarget(f.outDir, { asin: 'B012345678', storeKey: 'US-A', role: 'competitor', productLine: 'fixture', enabled: true }, f.loaded, 'test');
    requestRun(f.outDir, 'test');
    f.update('US-A', disabled ? { enabled: false } : { id: '42' });
    const opened = [];
    const result = await runIntelligenceWorker({ config: f.config, stores: f.loaded, logger, windowCheck: () => false,
      zn: { async storeOpen(options) { assertLease(f); opened.push(options.id); return { storeId: 'mock' }; }, async storeClose() {} },
      collect: async () => ({ observedAt: new Date().toISOString(), status: 'ERROR', priceCents: null, availability: 'UNKNOWN', trusted: { price: false, availability: false }, issues: ['mock result'], evidence: { suppressed: true }, contextKey: null }) });
    assert.equal(result.processed, true);
    assert.deepEqual(opened, disabled ? [] : ['42']);
    assert.equal(fs.existsSync(f.lock), false);
    assert.equal(fs.existsSync(path.join(f.outDir, 'channels')), false);
  }
});

test('upload worker reads the whole current active registry under lease and never uses startup binding', async t => {
  const oldEnv = { enabled: process.env.AMZGUARD_PRODUCT_UPLOAD_ENABLED, execution: process.env.AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED, scan: process.env.AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH };
  t.after(() => {
    for (const [name, value] of [['AMZGUARD_PRODUCT_UPLOAD_ENABLED', oldEnv.enabled], ['AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED', oldEnv.execution], ['AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH', oldEnv.scan]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.AMZGUARD_PRODUCT_UPLOAD_ENABLED = '1'; process.env.AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED = '1';
  const readdir = fs.readdirSync, stat = fs.statSync;
  fs.readdirSync = (dir, ...args) => dir === '/var/lib/clamav' ? ['fixture.cvd'] : readdir(dir, ...args);
  fs.statSync = (file, ...args) => file === '/var/lib/clamav/fixture.cvd' ? { mtimeMs: Date.now() } : stat(file, ...args);
  t.after(() => { fs.readdirSync = readdir; fs.statSync = stat; });
  for (const mode of ['rebound', 'new-store', 'disabled']) {
    const f = fixture(t);
    if (mode === 'new-store') f.create(); else f.update('US-A', { id: '42' });
    const current = readEffectiveStores(f.config).find(store => store.key === (mode === 'new-store' ? 'US-NEW' : 'US-A'));
    const staged = stageProductUpload({ outDir: f.outDir, store: current, originalName: 'fixture.csv', buffer: Buffer.from('sku,qty\nfixture,1\n') });
    confirmProductUpload({ outDir: f.outDir, jobId: staged.id, phrase: staged.confirmationPhrase });
    if (mode === 'disabled') f.update('US-A', { enabled: false });
    const scanner = path.join(f.temp, 'scanner-fixture'); fs.writeFileSync(scanner, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    process.env.AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH = scanner;
    const opened = [];
    const result = await runProductUploadWorker({ config: f.config, stores: f.loaded, logger,
      zn: { async storeOpen(options) { assertLease(f); opened.push(options.id); return { storeId: 'mock' }; },
        async prepareProductBulkUpload() { assert.equal(readProductUploadJob({ outDir: f.outDir, jobId: staged.id }).state, 'SUBMITTING'); },
        async submitProductBulkUpload() { return { pageTextDelta: '', currentUrl: 'https://sellercentral.amazon.com/product-search/bulk' }; }, async storeClose() {} } });
    assert.deepEqual(opened, mode === 'disabled' ? [] : [mode === 'new-store' ? '3' : '42']);
    assert.equal(result.state, mode === 'disabled' ? 'FAILED_BEFORE_SUBMIT' : 'UNKNOWN');
    assert.equal(fs.existsSync(f.lock), false);
    assert.equal(fs.existsSync(path.join(f.outDir, 'channels')), false);
  }
});
