import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PRODUCT_UPLOAD_RESULT_ERROR_LIMIT,
  buildProductUploadResult,
  classifyProductUploadResult,
  confirmProductUpload,
  ensureProductUploadStorage,
  expireStagedProductUploads,
  inspectProductUploadFile,
  listProductUploadJobs,
  productUploadEnabled,
  productUploadExecutionEnabled,
  productUploadJobInventory,
  productUploadResultCenter,
  publicProductUploadJob,
  recoverInterruptedProductUploads,
  stageProductUpload,
  summarizeProductUploadJobs,
  transitionProductUpload,
} from '../src/lib/product-upload.js';
import { bjIso } from '../src/lib/time.js';
import {
  ZiniaoWebDriver,
  isApprovedProductBulkUploadUrl,
  isApprovedProductUploadSubmitLabel,
} from '../src/lib/ziniao-webdriver.js';

function centralEntry(name, { compressed = 0, uncompressed = 0 } = {}) {
  const n = Buffer.from(name);
  const value = Buffer.alloc(46 + n.length);
  value.writeUInt32LE(0x02014b50, 0);
  value.writeUInt32LE(compressed, 20);
  value.writeUInt32LE(uncompressed, 24);
  value.writeUInt16LE(n.length, 28);
  n.copy(value, 46);
  return value;
}

function fakeXlsx(extra = []) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  const entries = ['[Content_Types].xml', 'xl/workbook.xml', ...extra].map((name) => centralEntry(name));
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return Buffer.concat([local, ...entries, eocd]);
}

function tempOut() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-upload-'));
  const outDir = path.join(root, 'out');
  fs.mkdirSync(outDir, { mode: 0o700 });
  return { root, outDir };
}

const STORE = { key: 'SAFE-STORE', name: 'Safe Store', market: 'US', enabled: true };

test('product upload feature requires both explicit gates', () => {
  assert.equal(productUploadEnabled({}), false);
  assert.equal(productUploadExecutionEnabled({ AMZGUARD_PRODUCT_UPLOAD_ENABLED: '1' }), false);
  assert.equal(productUploadExecutionEnabled({
    AMZGUARD_PRODUCT_UPLOAD_ENABLED: '1',
    AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED: '1',
  }), true);
});

test('product upload validates text and xlsx structure while rejecting paths, macros and legacy formats', () => {
  const csv = Buffer.from('sku,price\nABC,12.50\n');
  assert.equal(inspectProductUploadFile({ originalName: 'inventory.csv', buffer: csv }).extension, '.csv');
  assert.equal(inspectProductUploadFile({ originalName: 'inventory.xlsx', buffer: fakeXlsx() }).extension, '.xlsx');
  assert.throws(() => inspectProductUploadFile({ originalName: '../inventory.csv', buffer: csv }), /路径/);
  assert.throws(() => inspectProductUploadFile({ originalName: 'inventory.xlsm', buffer: fakeXlsx() }), /不支持/);
  assert.throws(() => inspectProductUploadFile({ originalName: 'inventory.xls', buffer: Buffer.alloc(20) }), /不支持/);
  assert.throws(() => inspectProductUploadFile({ originalName: 'inventory.xlsx', buffer: Buffer.from('PK fake') }), /工作簿|签名/);
  assert.throws(() => inspectProductUploadFile({ originalName: 'inventory.xlsx', buffer: fakeXlsx(['xl/vbaProject.bin']) }), /宏|嵌入/);
  assert.throws(() => inspectProductUploadFile({ originalName: 'inventory.exe', buffer: csv }), /不支持/);
});

test('product upload ledger binds store/hash, suppresses duplicates and makes terminal states immutable', () => {
  const { root, outDir } = tempOut();
  try {
    const content = Buffer.from('sku\tprice\nABC\t12.50\n');
    const staged = stageProductUpload({ outDir, store: STORE, originalName: 'inventory.tsv', buffer: content });
    assert.equal(staged.state, 'STAGED');
    assert.equal(fs.statSync(path.join(outDir, 'product-uploads', 'jobs', staged.id, 'record.json')).mode & 0o777, 0o600);
    const publicJob = publicProductUploadJob(staged);
    assert.equal(publicJob.file.sha256Short, crypto.createHash('sha256').update(content).digest('hex').slice(0, 12));
    assert.equal('originalName' in publicJob.file, false);
    assert.doesNotMatch(JSON.stringify(publicJob), /inventory\.tsv|product-uploads|\/tmp\//);
    assert.throws(() => stageProductUpload({ outDir, store: STORE, originalName: 'other.tsv', buffer: content }), /相同店铺与文件摘要/);
    assert.throws(() => confirmProductUpload({ outDir, jobId: staged.id, phrase: 'wrong' }), /短语/);
    const queued = confirmProductUpload({ outDir, jobId: staged.id, phrase: staged.confirmationPhrase });
    assert.equal(queued.state, 'QUEUED');
    const processing = transitionProductUpload({ outDir, jobId: staged.id, from: 'QUEUED', to: 'PROCESSING' });
    const submitting = transitionProductUpload({ outDir, jobId: processing.id, from: 'PROCESSING', to: 'SUBMITTING' });
    const unknown = transitionProductUpload({ outDir, jobId: submitting.id, from: 'SUBMITTING', to: 'UNKNOWN' });
    assert.equal(unknown.state, 'UNKNOWN');
    assert.throws(() => transitionProductUpload({ outDir, jobId: unknown.id, from: 'UNKNOWN', to: 'PROCESSING' }), /禁止的上传状态迁移/);
    assert.throws(() => stageProductUpload({
      outDir, store: STORE, originalName: 'retry.tsv', buffer: content,
    }), /相同店铺与文件摘要.*UNKNOWN/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('worker recovery never retries a persisted submit boundary', () => {
  const { root, outDir } = tempOut();
  try {
    const staged = stageProductUpload({ outDir, store: STORE, originalName: 'inventory.csv', buffer: Buffer.from('sku,qty\nABC,1\n') });
    confirmProductUpload({ outDir, jobId: staged.id, phrase: staged.confirmationPhrase });
    transitionProductUpload({ outDir, jobId: staged.id, from: 'QUEUED', to: 'PROCESSING' });
    transitionProductUpload({ outDir, jobId: staged.id, from: 'PROCESSING', to: 'SUBMITTING' });
    const recovered = recoverInterruptedProductUploads({ outDir });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].state, 'UNKNOWN');
    assert.equal(recovered[0].result.center.receipt.status, 'UNKNOWN');
    assert.equal(recovered[0].result.center.processing.availability, 'NOT_AVAILABLE');
    assert.equal(listProductUploadJobs({ outDir })[0].state, 'UNKNOWN');
    assert.equal(fs.existsSync(path.join(outDir, 'product-uploads', 'queue', staged.id)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('expired and pre-submit-failed jobs release the same store/file for an explicit new task', () => {
  const { root, outDir } = tempOut();
  try {
    const content = Buffer.from('sku,qty\nABC,1\n');
    const created = new Date(Date.now() + 60 * 60 * 1000);
    const staged = stageProductUpload({ outDir, store: STORE, originalName: 'inventory.csv', buffer: content, now: created });
    const payload = path.join(outDir, 'product-uploads', 'jobs', staged.id, 'payload.csv');
    assert.equal(fs.existsSync(payload), true);
    const expired = expireStagedProductUploads({ outDir, now: new Date(created.getTime() + 31 * 60 * 1000) });
    assert.equal(expired[0].state, 'EXPIRED');
    assert.equal(fs.existsSync(payload), false);

    const restaged = stageProductUpload({ outDir, store: STORE, originalName: 'inventory.csv', buffer: content, now: new Date(created.getTime() + 32 * 60 * 1000) });
    confirmProductUpload({ outDir, jobId: restaged.id, phrase: restaged.confirmationPhrase, now: new Date(created.getTime() + 33 * 60 * 1000) });
    transitionProductUpload({ outDir, jobId: restaged.id, from: 'QUEUED', to: 'PROCESSING' });
    transitionProductUpload({ outDir, jobId: restaged.id, from: 'PROCESSING', to: 'FAILED_BEFORE_SUBMIT' });
    const third = stageProductUpload({ outDir, store: STORE, originalName: 'inventory.csv', buffer: content, now: new Date(created.getTime() + 34 * 60 * 1000) });
    assert.equal(third.state, 'STAGED');
    assert.notEqual(third.id, restaged.id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('staging removes its exact new job directory if durable audit creation fails', () => {
  const { root, outDir } = tempOut();
  const external = path.join(root, 'external-audit.jsonl');
  try {
    fs.writeFileSync(external, 'must remain\n', { mode: 0o600 });
    const dirs = ensureProductUploadStorage(outDir);
    fs.symlinkSync(external, path.join(dirs.audit, `${bjIso().slice(0, 10)}.jsonl`));
    assert.throws(() => stageProductUpload({
      outDir, store: STORE, originalName: 'inventory.csv', buffer: Buffer.from('sku,qty\nABC,1\n'),
    }));
    assert.deepEqual(fs.readdirSync(dirs.jobs), []);
    assert.equal(fs.readFileSync(external, 'utf8'), 'must remain\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupt product upload jobs are surfaced instead of silently disappearing', () => {
  const { root, outDir } = tempOut();
  try {
    const staged = stageProductUpload({ outDir, store: STORE, originalName: 'inventory.txt', buffer: Buffer.from('sku\tqty\nABC\t1\n') });
    fs.writeFileSync(path.join(outDir, 'product-uploads', 'jobs', staged.id, 'record.json'), '{broken', { mode: 0o600 });
    const inventory = productUploadJobInventory({ outDir });
    assert.equal(inventory.jobs.length, 0);
    assert.equal(inventory.corrupt, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bulk upload write URL and submit labels are exact allowlists', () => {
  assert.equal(isApprovedProductBulkUploadUrl('https://sellercentral.amazon.com/product-search/bulk'), true);
  assert.equal(isApprovedProductBulkUploadUrl('https://sellercentral.amazon.com/product-search/bulk?token=secret'), false);
  assert.equal(isApprovedProductBulkUploadUrl('https://sellercentral.amazon.com/product-search/bulk#upload'), false);
  assert.equal(isApprovedProductBulkUploadUrl('https://sellercentral.amazon.com/product-search/bulk/other'), false);
  assert.equal(isApprovedProductBulkUploadUrl('https://evil.example/product-search/bulk'), false);
  assert.equal(isApprovedProductUploadSubmitLabel('Upload file'), true);
  assert.equal(isApprovedProductUploadSubmitLabel('Create listing'), false);
  assert.equal(isApprovedProductUploadSubmitLabel('Delete'), false);
});

test('webdriver upload page probe is read-only and requires one exact file control', async () => {
  const exactUrl = 'https://sellercentral.amazon.com/product-search/bulk';
  let sends = 0;
  let clicks = 0;
  const input = {
    async isEnabled() { return true; },
    async getAttribute(name) { return name === 'data-testid' ? 'upload-file' : ''; },
    async sendKeys() { sends++; },
    async click() { clicks++; },
  };
  const driver = {
    async getCurrentUrl() { return exactUrl; },
    async findElements() { return [input]; },
  };
  const transport = new ZiniaoWebDriver({ config: {}, logger: { info() {}, warn() {} }, sleepImpl: async () => {} });
  transport.sessions.set('store', { driver });
  transport.execExtract = async () => ({ result: {
    probeVersion: 2, looksLikeLogin: false, looksBlocked: false,
    liveDocument: true, traversalComplete: true, accessibleTraversalComplete: true,
  } });

  const result = await transport.inspectProductBulkUploadPage('store', { timeoutMs: 1000 });
  assert.equal(result.ready, true);
  assert.equal(result.eligibleFileInputCount, 1);
  assert.equal(sends, 0);
  assert.equal(clicks, 0);

  driver.getCurrentUrl = async () => `${exactUrl}?token=secret`;
  await assert.rejects(() => transport.inspectProductBulkUploadPage('store', { timeoutMs: 1000 }), /批量上传页/);
});

test('webdriver upload page probe discovers a file control inside open shadow DOM', async () => {
  const exactUrl = 'https://sellercentral.amazon.com/product-search/bulk';
  const shadowInput = {
    async isEnabled() { return true; },
    async getAttribute(name) { return name === 'aria-label' ? 'Upload file' : ''; },
  };
  const driver = {
    async getCurrentUrl() { return exactUrl; },
    async findElements() { return []; },
    async executeScript() { return { complete: true, elements: [shadowInput], rootCount: 2 }; },
  };
  const transport = new ZiniaoWebDriver({ config: {}, logger: { info() {}, warn() {} }, sleepImpl: async () => {} });
  transport.sessions.set('store', { driver });
  transport.execExtract = async () => ({ result: {
    probeVersion: 2, looksLikeLogin: false, looksBlocked: false,
    liveDocument: true, traversalComplete: true, accessibleTraversalComplete: true,
  } });
  const result = await transport.inspectProductBulkUploadPage('store', { timeoutMs: 1000 });
  assert.equal(result.ready, true);
  assert.equal(result.eligibleFileInputCount, 1);
});

test('generic upload page titles cannot prove that Amazon accepted the current file', () => {
  assert.equal(classifyProductUploadResult('Upload status Processing report').state, 'UNKNOWN');
  const accepted = classifyProductUploadResult('Your file has been uploaded and is being processed');
  assert.equal(accepted.state, 'COMPLETED');
  assert.equal(accepted.receiptStatus, 'ACCEPTED');
  assert.equal(accepted.processingStatus, 'PROCESSING');
  assert.equal(classifyProductUploadResult('Upload successful').processingStatus, null);
  assert.equal(classifyProductUploadResult('Upload failed. Invalid file.').state, 'REJECTED');
});

test('result center separates upload receipt from downstream SKU processing', () => {
  const accepted = buildProductUploadResult({
    state: 'COMPLETED', code: 'AMAZON_ACCEPTED_UPLOAD', receiptStatus: 'ACCEPTED',
    observedAt: '2026-08-28T10:00:00+08:00',
  });
  assert.equal(accepted.center.receipt.status, 'ACCEPTED');
  assert.equal(accepted.center.processing.availability, 'NOT_AVAILABLE');
  assert.equal(accepted.center.processing.status, 'UNKNOWN');
  assert.deepEqual(accepted.center.counts, {
    availability: 'NOT_AVAILABLE', success: null, warning: null, failed: null,
  });
  assert.equal(accepted.center.identifiers.availability, 'NOT_AVAILABLE');
  assert.equal(accepted.center.errors.availability, 'NOT_AVAILABLE');
  assert.equal(accepted.center.processingReport.availability, 'NOT_AVAILABLE');
  assert.equal(buildProductUploadResult({ counts: { success: 1 } }).center.counts.availability, 'PARTIAL');
});

test('result center retains bounded evidence-backed report metadata and redacts unsafe data', () => {
  const errors = Array.from({ length: PRODUCT_UPLOAD_RESULT_ERROR_LIMIT + 5 }, (_, index) => ({
    severity: index % 2 ? 'warning' : 'error', code: `ERR_${index}`, sku: `SKU-${index}`,
    row: index + 1, field: 'price',
    message: `Invalid value token=do-not-store https://sellercentral.amazon.com/report?openid=secret#otp ${'x'.repeat(600)}`,
  }));
  const result = buildProductUploadResult({
    state: 'COMPLETED', code: 'AMAZON_ACCEPTED_UPLOAD', receiptStatus: 'ACCEPTED',
    processingStatus: 'COMPLETED_WITH_WARNINGS', batchId: 'batch-123', submissionId: 'sub:456',
    counts: { success: 23, warning: 2, failed: 1 }, errors, errorTotal: 55,
    processingReport: {
      id: 'report-789', name: 'Processing report', format: 'csv',
      generatedAt: '2026-08-28T11:30:00+08:00',
      url: 'https://sellercentral.amazon.com/report/download?token=secret#fragment',
    },
    resultUrl: 'https://sellercentral.amazon.com/product-search/bulk?token=secret#done',
  });
  const center = result.center;
  assert.deepEqual(center.identifiers, {
    availability: 'AVAILABLE', batchId: 'batch-123', submissionId: 'sub:456',
  });
  assert.deepEqual(center.counts, { availability: 'AVAILABLE', success: 23, warning: 2, failed: 1 });
  assert.equal(center.errors.items.length, PRODUCT_UPLOAD_RESULT_ERROR_LIMIT);
  assert.equal(center.errors.total, 55);
  assert.equal(center.errors.truncated, true);
  assert.ok(center.errors.items.every((entry) => entry.message.length <= 500));
  assert.doesNotMatch(JSON.stringify(result), /do-not-store|openid=|token=secret|#fragment/);
  assert.equal(center.processingReport.url, 'https://sellercentral.amazon.com/report/download');
  assert.equal(result.resultUrl, 'https://sellercentral.amazon.com/product-search/bulk');

  const blocked = buildProductUploadResult({
    state: 'COMPLETED', processingReport: { url: 'https://evil.example/report.csv' },
  });
  assert.equal(blocked.center.processingReport.availability, 'NOT_AVAILABLE');
  assert.equal(blocked.center.processingReport.url, null);
});

test('public result center revalidates stored rows and upload summary does not call receipt processing complete', () => {
  const accepted = {
    state: 'COMPLETED', updatedAt: '2026-08-28T12:00:00+08:00',
    result: { code: 'AMAZON_ACCEPTED_UPLOAD' },
  };
  assert.equal(productUploadResultCenter(accepted).processing.availability, 'NOT_AVAILABLE');
  assert.deepEqual(summarizeProductUploadJobs([accepted]), {
    total: 1, pendingSubmission: 0, acceptedAwaitingResult: 1,
    processing: 0, processedSuccess: 0, processedWithWarnings: 0,
    processedFailed: 0, rejected: 0, unknown: 0,
  });

  const processing = {
    ...accepted,
    result: buildProductUploadResult({
      state: 'COMPLETED', processingStatus: 'PROCESSING',
      errors: Array.from({ length: 80 }, (_, index) => ({ code: `E${index}`, message: 'safe' })),
    }),
  };
  const safe = productUploadResultCenter(processing);
  assert.equal(safe.errors.items.length, PRODUCT_UPLOAD_RESULT_ERROR_LIMIT);
  assert.equal(summarizeProductUploadJobs([processing]).processing, 1);
  assert.equal(summarizeProductUploadJobs([processing]).acceptedAwaitingResult, 0);
});

test('webdriver waits for a new upload result instead of accepting an old history row', async () => {
  const exactUrl = 'https://sellercentral.amazon.com/product-search/bulk';
  const authorization = {
    approved: true,
    action: 'product-bulk-upload',
    jobId: `upl_${'a'.repeat(32)}`,
    sha256: 'b'.repeat(64),
  };
  const pageTexts = [
    'Upload successful\nOld batch',
    'Upload successful\nOld batch',
    'Upload successful\nOld batch\nYour file has been uploaded',
  ];
  let textReads = 0;
  let clicks = 0;
  const driver = { async getCurrentUrl() { return exactUrl; } };
  const transport = new ZiniaoWebDriver({
    config: {}, logger: { info() {}, warn() {} }, sleepImpl: async () => {},
  });
  transport.sessions.set('store', {
    driver,
    productUploadPrepared: {
      submit: { async click() { clicks++; } },
      preparedUrl: exactUrl,
      jobId: authorization.jobId,
      sha256: authorization.sha256,
    },
  });
  transport.execExtract = async () => ({
    result: {
      probeVersion: 2,
      looksLikeLogin: false,
      looksBlocked: false,
      liveDocument: true,
      traversalComplete: true,
      accessibleTraversalComplete: true,
    },
  });
  transport.content = async () => ({ text: pageTexts[Math.min(textReads++, pageTexts.length - 1)] });

  const result = await transport.submitProductBulkUpload('store', { authorization, timeoutMs: 30000 });
  assert.equal(clicks, 1);
  assert.equal(textReads, 3);
  assert.equal(result.pageTextDelta, 'Your file has been uploaded');
});

test('webdriver refuses a file whose digest is not bound to the persisted authorization before page interaction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-upload-bind-'));
  try {
    const file = path.join(root, 'payload.csv');
    fs.writeFileSync(file, 'sku,qty\nABC,1\n', { mode: 0o600 });
    let pageTouched = false;
    const transport = new ZiniaoWebDriver({ config: {}, logger: { info() {}, warn() {} } });
    transport.sessions.set('store', { driver: { async getCurrentUrl() { pageTouched = true; return 'https://sellercentral.amazon.com/product-search/bulk'; } } });
    await assert.rejects(() => transport.prepareProductBulkUpload('store', file, {
      authorization: { approved: true, action: 'product-bulk-upload', jobId: `upl_${'a'.repeat(32)}`, sha256: 'b'.repeat(64) },
    }), /摘要不匹配/);
    assert.equal(pageTouched, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
