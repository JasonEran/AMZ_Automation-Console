import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  PRODUCT_UPLOAD_RESULT_ERROR_LIMIT,
  PRODUCT_UPLOAD_RESPONSE_TEXT_LIMIT,
  buildProductUploadResult,
  classifyProductUploadResult,
  confirmProductUpload,
  clearProductUploadQueueMarker,
  ensureProductUploadStorage,
  expireStagedProductUploads,
  inspectProductUploadFile,
  listProductUploadJobs,
  productUploadEnabled,
  productUploadExecutionEnabled,
  payloadPathForJob,
  productUploadDiagnostic,
  productUploadJobInventory,
  productUploadResultCenter,
  productUploadResetInfo,
  productUploadResetPhrase,
  publicProductUploadJob,
  readProductUploadJob,
  recoverInterruptedProductUploads,
  resetProductUploadDuplicate,
  saveProductUploadDiagnostic,
  stageProductUpload,
  summarizeProductUploadJobs,
  transitionProductUpload,
} from '../src/lib/product-upload.js';
import { bjIso } from '../src/lib/time.js';
import {
  ZiniaoWebDriver,
  isApprovedProductBulkUploadUrl,
  isApprovedProductUploadSubmitLabel,
  productUploadReceiptReference,
} from '../src/lib/ziniao-webdriver.js';
import { runProductUploadWorker } from '../src/tools/product-upload-worker.js';

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
  assert.equal(isApprovedProductBulkUploadUrl('https://sellercentral.amazon.com/product-search/bulk/'), false);
  assert.equal(isApprovedProductBulkUploadUrl('https://sellercentral.amazon.com/product-search/bulk//'), false);
  assert.equal(isApprovedProductBulkUploadUrl('https://sellercentral.amazon.com/product-search/bulk?token=secret'), false);
  assert.equal(isApprovedProductBulkUploadUrl('https://sellercentral.amazon.com/product-search/bulk#upload'), false);
  assert.equal(isApprovedProductBulkUploadUrl('https://sellercentral.amazon.com/product-search/bulk/other'), false);
  assert.equal(isApprovedProductBulkUploadUrl('https://evil.example/product-search/bulk'), false);
  assert.equal(isApprovedProductUploadSubmitLabel('Upload file'), true);
  assert.equal(isApprovedProductUploadSubmitLabel('提交商品'), true);
  assert.equal(isApprovedProductUploadSubmitLabel('提交'), false);
  assert.equal(isApprovedProductUploadSubmitLabel('删除商品'), false);
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
  const partial = productUploadResultCenter({ state: 'COMPLETED',
    result: buildProductUploadResult({ state: 'COMPLETED', counts: { success: 1 } }) });
  assert.deepEqual(partial.counts, { availability: 'PARTIAL', success: 1, warning: null, failed: null });
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
    processedFailed: 0, rejected: 0, unknown: 0, failedBeforeSubmit: 0,
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
      submit: {
        async getText() { return 'Upload file'; },
        async getAttribute() { return null; },
        async isDisplayed() { return true; },
        async isEnabled() { return true; },
        async click() { clicks++; },
      },
      submitLabel: 'Upload file',
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

test('simple mode forwards original bytes and delegates text encoding validation while preserving safety and duplicate guards', () => {
  const { root, outDir } = tempOut();
  try {
    const bytes = Buffer.from([0x73, 0x6b, 0x75, 0x09, 0xe9, 0x0a]);
    assert.throws(() => inspectProductUploadFile({ originalName: 'feed.txt', buffer: bytes }), /UTF/);
    const job = stageProductUpload({ outDir, store: STORE, originalName: 'feed.txt', buffer: bytes, mode: 'SIMPLE' });
    assert.equal(publicProductUploadJob(job).mode, 'SIMPLE');
    assert.deepEqual(fs.readFileSync(payloadPathForJob({ outDir, job })), bytes);
    assert.equal(job.file.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(confirmProductUpload({ outDir, jobId: job.id, phrase: job.confirmationPhrase }).mode, 'SIMPLE');
    assert.throws(() => inspectProductUploadFile({ originalName: 'feed.txt', buffer: bytes, mode: 'SKIP_ALL' }), /模式/);
    for (const mode of ['SIMPLE', 'STANDARD']) {
      assert.throws(() => inspectProductUploadFile({ originalName: '../feed.txt', buffer: bytes, mode }), /路径/);
      assert.throws(() => inspectProductUploadFile({ originalName: 'feed.txt', buffer: Buffer.alloc(20), mode }), /二进制/);
      assert.throws(() => inspectProductUploadFile({ originalName: 'feed.xlsx', buffer: fakeXlsx(['xl/vbaProject.bin']), mode }), /宏/);
      assert.throws(() => inspectProductUploadFile({ originalName: 'feed.csv', buffer: Buffer.alloc(0), mode }), /为空/);
    }
    const normal = Buffer.from('sku,qty\nABC,1\n');
    stageProductUpload({ outDir, store: STORE, originalName: 'feed.csv', buffer: normal, mode: 'SIMPLE' });
    assert.throws(() => stageProductUpload({ outDir, store: STORE, originalName: 'feed.csv', buffer: normal, mode: 'STANDARD' }), /相同店铺与文件摘要/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Amazon response keeps new page text with redaction, truncation and no invented SKU result', () => {
  const result = buildProductUploadResult({ state: 'REJECTED', amazonText: 'Upload failed\nprivate-file.csv\nhttps://sellercentral.amazon.com/report?token=secret\n' + 'x'.repeat(15000), originalName: 'private-file.csv' });
  assert.equal(result.amazonResponse.availability, 'AVAILABLE');
  assert.equal(result.amazonResponse.text.length, PRODUCT_UPLOAD_RESPONSE_TEXT_LIMIT);
  assert.equal(result.amazonResponse.truncated, true);
  assert.match(result.amazonResponse.text, /Upload failed\n\[上传文件\]/);
  assert.doesNotMatch(JSON.stringify(result), /private-file.csv|token=secret/);
  const publicJob = publicProductUploadJob({ id: 'fixture', state: 'REJECTED', file: { originalName: 'private-file.csv' }, result });
  assert.equal(publicJob.amazonResponse, undefined);
  assert.equal(publicJob.result.amazonResponse.truncated, true);
  assert.equal(publicJob.resultCenter.counts.availability, 'NOT_AVAILABLE');
  assert.equal(buildProductUploadResult().amazonResponse.availability, 'NOT_AVAILABLE');
});

test('legacy missing-file-control failure shows actionable cause without changing UNKNOWN or allowing retry', () => {
  const legacy = { state: 'UNKNOWN', result: { code: 'SUBMISSION_OUTCOME_UNKNOWN', message: '批量上传文件控件数量不可唯一确定（0）' } };
  const diagnostic = productUploadDiagnostic(legacy);
  assert.equal(diagnostic.source, 'SYSTEM');
  assert.equal(diagnostic.code, 'UPLOAD_FILE_INPUT_NOT_READY');
  assert.match(diagnostic.suggestion, /不要重复上传/);
  assert.equal(legacy.state, 'UNKNOWN');
  assert.notEqual(productUploadDiagnostic({ ...legacy, result: { message: '批量上传文件控件数量不可唯一确定（10）' } }).code, 'UPLOAD_FILE_INPUT_NOT_READY');
  assert.equal(summarizeProductUploadJobs([{ state: 'FAILED_BEFORE_SUBMIT' }]).failedBeforeSubmit, 1);
});

test('worker waits for readiness before the submit boundary and preserves Amazon replies; failures never auto retry', async t => {
  const previous = {};
  for (const key of ['AMZGUARD_PRODUCT_UPLOAD_ENABLED', 'AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED', 'AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH']) previous[key] = process.env[key];
  const readdir = fs.readdirSync, stat = fs.statSync;
  fs.readdirSync = (dir, ...args) => dir === '/var/lib/clamav' ? ['fixture.cvd'] : readdir(dir, ...args);
  fs.statSync = (file, ...args) => file === '/var/lib/clamav/fixture.cvd' ? { mtimeMs: Date.now() } : stat(file, ...args);
  t.after(() => {
    fs.readdirSync = readdir; fs.statSync = stat;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  process.env.AMZGUARD_PRODUCT_UPLOAD_ENABLED = '1'; process.env.AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED = '1';
  for (const scenario of ['not-ready', 'prepare-fails', 'controls-not-ready', 'diagnostic-fails', 'diagnostic-timeout', 'accepted', 'status-receipt', 'invalid-status-receipt', 'rejected', 'no-reply', 'scanner-fails']) {
    const { root, outDir } = tempOut();
    try {
      const scanner = path.join(root, 'fixture-scanner'); fs.writeFileSync(scanner, '#!/bin/sh\nexit ' + (scenario === 'scanner-fails' ? '1' : '0') + '\n', { mode: 0o700 });
      process.env.AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH = scanner;
      const staged = stageProductUpload({ outDir, store: STORE, mode: 'SIMPLE', originalName: 'feed.csv', buffer: Buffer.from('sku,qty\nABC,1\n') });
      confirmProductUpload({ outDir, jobId: staged.id, phrase: staged.confirmationPhrase });
      const calls = [];
      let resolveLateCapture;
      const amazonText = scenario === 'rejected' ? 'Upload failed. Invalid file.\nMissing product type.'
        : ['no-reply', 'status-receipt', 'invalid-status-receipt'].includes(scenario) ? '' : 'Your file has been uploaded\nfeed.csv';
      const zn = {
        async storeOpen() { calls.push('open'); return { storeId: 'mock' }; },
        async inspectProductBulkUploadPage() {
          calls.push('inspect');
          const job = readProductUploadJob({ outDir, jobId: staged.id });
          assert.equal(job.state, 'PROCESSING'); assert.equal(job.submittedAt, undefined);
          if (scenario === 'not-ready') throw new Error('批量上传文件控件未在等待期内就绪（0）');
          return { ready: true, eligibleFileInputCount: 1 };
        },
        async prepareProductBulkUpload(_id, file) {
          calls.push('prepare'); assert.equal(readProductUploadJob({ outDir, jobId: staged.id }).state, 'SUBMITTING');
          assert.equal(fs.readFileSync(file, 'utf8'), 'sku,qty\nABC,1\n');
          if (scenario === 'prepare-fails') throw new Error('page changed after boundary');
          if (['controls-not-ready', 'diagnostic-fails', 'diagnostic-timeout'].includes(scenario)) throw Object.assign(new Error('批量上传提交控件未在等待期内就绪（最后一轮：控件总数=1，白名单标签=1，不可见=0，原生禁用=0，disabled禁用=1，aria禁用=0，读取异常=0）'), { code: 'UPLOAD_SUBMIT_CONTROL_NOT_READY' });
        },
        async submitProductBulkUpload() {
          calls.push('submit');
          return { pageTextDelta: amazonText, currentUrl: 'https://sellercentral.amazon.com/product-search/bulk',
            ...(['status-receipt', 'invalid-status-receipt'].includes(scenario) ? { receipt: {
              version: 1, source: 'AMAZON_UPLOAD_STATUS_ROW', batchId: 'fixture-batch-123',
              fileNameMatched: true, latestRowMatched: scenario === 'status-receipt',
            } } : {}) };
        },
        async captureProductBulkUploadDiagnostic(_id, { expectedSize }) {
          calls.push('capture');
          assert.equal(expectedSize, staged.file.size);
          assert.ok(['UNKNOWN', 'FAILED_BEFORE_SUBMIT'].includes(readProductUploadJob({ outDir, jobId: staged.id }).state));
          assert.equal(fs.readdirSync(path.join(outDir, 'product-uploads/queue')).length, 0);
          if (scenario === 'diagnostic-fails') throw new Error('private-page-value secret-token');
          if (scenario === 'diagnostic-timeout') return new Promise(resolve => { resolveLateCapture = resolve; });
          return { summary: { status: 'AVAILABLE', inputCount: 1, selectedFileCount: scenario === 'not-ready' ? 0 : 1,
            singleSelectedFileSizeMatches: scenario === 'not-ready' ? null : true, inputs: [] }, screenshotStatus: 'NOT_CAPTURED' };
        },
        async storeClose() { calls.push('close'); },
      };
      const warnings = [];
      const options = { config: { outDir }, stores: [STORE], logger: { info() {}, warn(message) { warnings.push(message); }, error() {} }, zn };
      const run = await runProductUploadWorker(options);
      const saved = readProductUploadJob({ outDir, jobId: staged.id });
      const expected = { 'not-ready': 'FAILED_BEFORE_SUBMIT', 'prepare-fails': 'UNKNOWN', 'controls-not-ready': 'UNKNOWN', 'diagnostic-fails': 'UNKNOWN', 'diagnostic-timeout': 'UNKNOWN', accepted: 'COMPLETED', 'status-receipt': 'COMPLETED', 'invalid-status-receipt': 'UNKNOWN', rejected: 'REJECTED', 'no-reply': 'UNKNOWN', 'scanner-fails': 'FAILED_BEFORE_SUBMIT' }[scenario];
      assert.equal(run.state, expected);
      if (scenario === 'not-ready') { assert.deepEqual(calls, ['open', 'inspect', 'capture', 'close']); assert.equal(saved.result.phase, 'PAGE_READY'); assert.equal(saved.submittedAt, undefined); }
      else if (scenario === 'scanner-fails') { assert.deepEqual(calls, []); assert.equal(saved.result.errorCode, 'MALWARE_DETECTED'); }
      else if (['prepare-fails', 'controls-not-ready', 'diagnostic-fails', 'diagnostic-timeout'].includes(scenario)) {
        assert.deepEqual(calls, ['open', 'inspect', 'prepare', 'capture', 'close']);
        if (scenario === 'controls-not-ready') {
          assert.equal(saved.result.errorCode, 'UPLOAD_SUBMIT_CONTROL_NOT_READY');
          assert.equal(saved.result.phase, 'FILE_SELECTION');
          assert.equal(saved.result.amazonResponse.availability, 'NOT_AVAILABLE');
          assert.match(publicProductUploadJob(saved).diagnostic.message, /disabled禁用=1/);
          assert.equal(saved.state, 'UNKNOWN');
        }
      }
      else { assert.deepEqual(calls, ['open', 'inspect', 'prepare', 'submit', ...(['no-reply', 'invalid-status-receipt'].includes(scenario) ? ['capture'] : []), 'close']); assert.equal(saved.result.amazonResponse.text, amazonText.replace('feed.csv', '[上传文件]') || null); }
      if (scenario === 'status-receipt') {
        const center = publicProductUploadJob(saved).resultCenter;
        assert.deepEqual(center.receipt, { status: 'ACCEPTED', evidence: 'UPLOAD_STATUS_ROW' });
        assert.equal(center.identifiers.batchId, 'fixture-batch-123');
        assert.equal(center.processing.availability, 'NOT_AVAILABLE');
        assert.equal(center.processing.status, 'UNKNOWN');
        assert.equal(center.counts.availability, 'NOT_AVAILABLE');
        assert.equal(saved.result.amazonResponse.availability, 'NOT_AVAILABLE');
      }
      if (scenario === 'diagnostic-fails' || scenario === 'diagnostic-timeout') {
        assert.equal(warnings.filter(message => message === '上传失败现场未能保存；原任务结果保持不变').length, 1);
        assert.doesNotMatch(warnings.join(' '), /private|secret-token/);
        if (resolveLateCapture) {
          resolveLateCapture({ summary: { status: 'AVAILABLE', inputCount: 1 }, screenshotStatus: 'NOT_CAPTURED' });
          await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(fs.existsSync(path.join(outDir, 'product-uploads/jobs', staged.id, 'diagnostics')), false);
      }
      assert.doesNotMatch(JSON.stringify(publicProductUploadJob(saved)), /screenshotBase64|selectedFileCount|diagnostics\/|private-page-value/);
      assert.equal((await runProductUploadWorker(options)).processed, false);
      assert.equal(fs.existsSync(path.join(outDir, 'channels')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('observed Chinese product-submit button completes the mocked transport with a shadow file input', async t => {
  const { root, outDir } = tempOut();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(outDir, 'payload.csv');
  fs.writeFileSync(file, 'sku,product_type\n');
  const authorization = { approved: true, action: 'product-bulk-upload', jobId: `upl_${'d'.repeat(32)}`,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  let fileSelections = 0, clicks = 0;
  const input = {
    async isEnabled() { return true; },
    async getAttribute(name) { return name === 'id' ? 'upload-file' : ''; },
    async sendKeys(value) { assert.equal(value, file); fileSelections++; },
  };
  const submit = {
    async getText() { return ''; },
    async getAttribute(name) { return name === 'label' ? '提交商品' : null; },
    async isDisplayed() { return true; },
    async isEnabled() { return fileSelections === 1; },
    async click() { clicks++; },
  };
  const driver = {
    async getCurrentUrl() { return 'https://sellercentral.amazon.com/product-search/bulk'; },
    async executeScript() { return { complete: true, elements: [input], rootCount: 2 }; },
    async findElements(selector) { return selector.value.includes('#bulk-upload-page') ? [] : [submit]; },
  };
  const zn = new ZiniaoWebDriver({ config: {}, logger: { info() {}, warn() {} }, sleepImpl: async () => {} });
  zn.sessions.set('mock-store', { driver });
  zn.execExtract = async () => ({ result: { probeVersion: 2, looksLikeLogin: false, looksBlocked: false,
    liveDocument: true, traversalComplete: true, accessibleTraversalComplete: true } });
  zn.content = async () => ({ text: clicks ? 'Upload status\nYour file has been uploaded and is being processed' : 'Upload status' });
  const ready = await zn.inspectProductBulkUploadPage('mock-store');
  assert.equal(ready.ready, true); assert.equal(fileSelections, 0); assert.equal(clicks, 0);
  const prepared = await zn.prepareProductBulkUpload('mock-store', file, { authorization });
  assert.equal(prepared.submitLabel, '提交商品'); assert.equal(fileSelections, 1); assert.equal(clicks, 0);
  const response = await zn.submitProductBulkUpload('mock-store', { authorization });
  assert.equal(clicks, 1);
  assert.equal(response.pageTextDelta, 'Your file has been uploaded and is being processed');
  assert.equal(classifyProductUploadResult(response.pageTextDelta).state, 'COMPLETED');
  await assert.rejects(() => zn.submitProductBulkUpload('mock-store', { authorization }), /未完成/);
  assert.equal(clicks, 1, 'A consumed preparation must never submit twice');
});

function mockProductUploadTransport(t) {
  const { root, outDir } = tempOut();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(outDir, 'payload.csv');
  fs.writeFileSync(file, 'sku,product_type\n', { mode: 0o600 });
  const authorization = { approved: true, action: 'product-bulk-upload', jobId: `upl_${'e'.repeat(32)}`,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  const state = { disabled: null, ariaDisabled: null, label: '提交商品', clicks: 0, selections: 0, clickError: null };
  const input = {
    async isEnabled() { return true; },
    async getAttribute(name) { return name === 'id' ? 'upload-file' : null; },
    async sendKeys(value) { assert.equal(value, file); state.selections++; },
  };
  const submit = {
    async getText() { return ''; },
    async getAttribute(name) {
      return ({ label: state.label, disabled: state.disabled, 'aria-disabled': state.ariaDisabled })[name] ?? null;
    },
    async isDisplayed() { return true; },
    // A custom KAT host can pass WebDriver's native enabled check while its
    // own disabled/aria-disabled state still blocks the business action.
    async isEnabled() { return true; },
    async click() { state.clicks++; if (state.clickError) throw state.clickError; },
  };
  const driver = {
    async getCurrentUrl() { return 'https://sellercentral.amazon.com/product-search/bulk'; },
    async executeScript() { return { complete: true, elements: [input], rootCount: 2 }; },
    async findElements(selector) { return selector.value.includes('#bulk-upload-page') ? [] : [submit]; },
  };
  const zn = new ZiniaoWebDriver({ config: {}, logger: { info() {}, warn() {} }, sleepImpl: async () => {} });
  zn.sessions.set('mock-store', { driver });
  zn.execExtract = async () => ({ result: { probeVersion: 2, looksLikeLogin: false, looksBlocked: false,
    liveDocument: true, traversalComplete: true, accessibleTraversalComplete: true } });
  zn.content = async () => ({ text: state.clicks ? 'Your file has been uploaded' : 'Upload status' });
  return { zn, state, file, authorization };
}

test('upload preparation waits for the KAT disabled and aria-disabled states to clear', async t => {
  for (const disabledState of [{ disabled: 'true' }, { disabled: '' }, { ariaDisabled: 'true' }]) {
    const { zn, state, file, authorization } = mockProductUploadTransport(t);
    Object.assign(state, disabledState);
    let waits = 0;
    zn.sleep = async () => { waits++; state.disabled = null; state.ariaDisabled = 'false'; };
    const prepared = await zn.prepareProductBulkUpload('mock-store', file, { authorization });
    assert.equal(prepared.prepared, true);
    assert.equal(waits, 1, 'Native isEnabled alone cannot prove that a KAT submit control is ready');
    assert.equal(state.selections, 1);
    assert.equal(state.clicks, 0);
  }
});

test('submit readiness timeout reports only the last poll and keeps page data out of diagnostics', async t => {
  const { zn, state, file, authorization } = mockProductUploadTransport(t);
  const control = (overrides = {}) => ({
    async getText() { return '提交商品'; },
    async getAttribute() { return null; },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    ...overrides,
  });
  const rejected = [
    control({ async getText() { return 'private-customer-label'; } }),
    control({ async isDisplayed() { return false; } }),
    control({ async isEnabled() { return false; } }),
    control({ async getAttribute(name) { return name === 'disabled' ? 'true' : null; } }),
    control({ async getAttribute(name) { return name === 'aria-disabled' ? 'true' : null; } }),
    control({ async getText() { throw new Error('private-file.xlsx https://example.invalid/?token=secret'); } }),
  ];
  const nativeNow = Date.now;
  t.after(() => { Date.now = nativeNow; });
  let now = nativeNow(), polls = 0;
  Date.now = () => now;
  zn.session('mock-store').driver.findElements = async selector => {
    if (selector.value.includes('#bulk-upload-page')) return [];
    polls++; return rejected;
  };
  zn.sleep = async () => { now += 2500; };
  await assert.rejects(() => zn.prepareProductBulkUpload('mock-store', file, { authorization, timeoutMs: 5000 }), error => {
    assert.equal(error.code, 'UPLOAD_SUBMIT_CONTROL_NOT_READY');
    assert.match(error.message, /最后一轮：控件总数=6，白名单标签=4，不可见=1，原生禁用=1，disabled禁用=1，aria禁用=1，读取异常=1/);
    assert.doesNotMatch(error.message, /private|secret|提交商品/);
    assert.ok(error.message.length < 300, 'The worker must persist the complete diagnostic');
    return true;
  });
  assert.equal(polls, 2, 'Counters must reset, not accumulate across polls');
  assert.equal(state.selections, 1);
  assert.equal(state.clicks, 0);
  await assert.rejects(() => zn.submitProductBulkUpload('mock-store', { authorization }), /未完成/);
  assert.equal(state.clicks, 0);
});

test('legacy submit-control timeout receives an actionable display without inventing historical evidence', () => {
  const job = { state: 'UNKNOWN', result: { code: 'SUBMISSION_OUTCOME_UNKNOWN', phase: 'FILE_SELECTION',
    message: '批量上传提交控件未在等待期内就绪' } };
  const original = JSON.stringify(job);
  const diagnostic = productUploadDiagnostic(job);
  assert.equal(diagnostic.code, 'UPLOAD_SUBMIT_CONTROL_NOT_READY');
  assert.match(diagnostic.suggestion, /文件校验提示/);
  assert.match(diagnostic.suggestion, /不要重复上传/);
  assert.doesNotMatch(diagnostic.message, /最后一轮/);
  assert.equal(JSON.stringify(job), original);
});

test('failure snapshots stay private, immutable and separate from upload results', t => {
  const { root, outDir } = tempOut();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = stageProductUpload({ outDir, store: STORE, mode: 'SIMPLE', originalName: 'feed.csv', buffer: Buffer.from('sku,qty\nABC,1\n') });
  confirmProductUpload({ outDir, jobId: staged.id, phrase: staged.confirmationPhrase });
  transitionProductUpload({ outDir, jobId: staged.id, from: 'QUEUED', to: 'PROCESSING' });
  transitionProductUpload({ outDir, jobId: staged.id, from: 'PROCESSING', to: 'SUBMITTING' });
  transitionProductUpload({ outDir, jobId: staged.id, from: 'SUBMITTING', to: 'UNKNOWN' });
  const jobDir = path.join(outDir, 'product-uploads/jobs', staged.id);
  const original = fs.readFileSync(path.join(jobDir, 'record.json'));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V6YAAAAASUVORK5CYII=', 'base64');
  const snapshot = { summary: { status: 'AVAILABLE', inputCount: 1, selectedFileCount: 1, singleSelectedFileSizeMatches: true,
    rawText: 'private-customer', inputs: [{ fileName: 'private.xlsx', validity: { valid: false, customError: true, message: 'secret' }, ariaInvalid: true }] },
  safety: { stage: 'AFTER_SCREENSHOT', reason: 'LIVE_PAGE_NON_SENSITIVE', exactUrl: true, authSensitive: false, blocked: false,
    rawUrl: 'https://private.invalid/?token=secret', liveProbeDiagnostics: { discoveredRootCount: 115, rootBudgetExceeded: false,
      candidateNodeCount: 'private-text', unknownField: 'private-text' } },
  screenshotStatus: 'AVAILABLE', screenshotBase64: image.toString('base64'), secret: 'private-page-value' };
  const args = { outDir, jobId: staged.id, phase: 'FILE_SELECTION', snapshot };
  assert.deepEqual(saveProductUploadDiagnostic(args), { saved: true });
  const diagnosticDir = path.join(jobDir, 'diagnostics');
  const metadata = fs.readFileSync(path.join(diagnosticDir, 'current.json'), 'utf8');
  assert.doesNotMatch(metadata, /private|secret|fileName|rawText|screenshotBase64/);
  const saved = JSON.parse(metadata);
  assert.equal(saved.summary.singleSelectedFileSizeMatches, true);
  assert.equal(saved.summary.inputs[0].validity.customError, true);
  assert.equal(saved.safety.reason, 'LIVE_PAGE_NON_SENSITIVE');
  assert.deepEqual(saved.safety.liveProbeDiagnostics, { discoveredRootCount: 115, rootBudgetExceeded: false });
  assert.equal(saved.screenshot.sha256, crypto.createHash('sha256').update(image).digest('hex'));
  assert.deepEqual(fs.readFileSync(path.join(diagnosticDir, 'current.png')), image);
  assert.equal(fs.statSync(diagnosticDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(diagnosticDir, 'current.png')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(diagnosticDir, 'current.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(path.join(jobDir, 'record.json')), original);
  assert.doesNotMatch(JSON.stringify(publicProductUploadJob(readProductUploadJob({ outDir, jobId: staged.id }))), /diagnostics|screenshotBase64|selectedFileCount/);
  assert.throws(() => saveProductUploadDiagnostic(args), /EEXIST/);
  assert.deepEqual(fs.readFileSync(path.join(diagnosticDir, 'current.png')), image);
});

test('failure snapshot storage blocks unsafe-page images and symbolic diagnostic directories', t => {
  const { root, outDir } = tempOut();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const scenario of ['unsafe', 'symlink', 'invalid-image', 'not-terminal']) {
    const staged = stageProductUpload({ outDir, store: STORE, mode: 'SIMPLE', originalName: 'feed.csv', buffer: Buffer.from(`sku,qty\n${scenario},1\n`) });
    if (scenario !== 'not-terminal') {
      confirmProductUpload({ outDir, jobId: staged.id, phrase: staged.confirmationPhrase });
      transitionProductUpload({ outDir, jobId: staged.id, from: 'QUEUED', to: 'PROCESSING' });
      transitionProductUpload({ outDir, jobId: staged.id, from: 'PROCESSING', to: 'FAILED_BEFORE_SUBMIT' });
    }
    const diagnosticDir = path.join(outDir, 'product-uploads/jobs', staged.id, 'diagnostics');
    const args = { outDir, jobId: staged.id, phase: 'PAGE_READY', snapshot: {
      summary: { status: scenario === 'unsafe' ? 'UNSAFE_PAGE' : 'AVAILABLE', inputCount: 1, selectedFileCount: 1 },
      safety: { stage: 'START', reason: 'LIVE_SAFETY_PROBE_INCOMPLETE', exactUrl: true, authSensitive: false, blocked: false,
        liveProbeDiagnostics: { rootBudgetExceeded: true, discoveredRootCount: 631, scannedRootCount: 512, rootBudget: 512 } },
      screenshotStatus: 'AVAILABLE', screenshotBase64: Buffer.from('private page').toString('base64'),
    } };
    if (scenario === 'symlink') {
      const target = path.join(root, 'outside'); fs.mkdirSync(target);
      fs.symlinkSync(target, diagnosticDir);
      assert.throws(() => saveProductUploadDiagnostic(args), /存储目录/);
      assert.deepEqual(fs.readdirSync(target), []);
    } else if (scenario === 'invalid-image') assert.throws(() => saveProductUploadDiagnostic(args), /图片无效/);
    else if (scenario === 'not-terminal') assert.throws(() => saveProductUploadDiagnostic(args), /失败现场/);
    else {
      saveProductUploadDiagnostic(args);
      const saved = JSON.parse(fs.readFileSync(path.join(diagnosticDir, 'current.json'), 'utf8'));
      assert.equal(saved.screenshot.status, 'BLOCKED');
      assert.equal(saved.summary.inputCount, null);
      assert.equal(saved.safety.reason, 'LIVE_SAFETY_PROBE_INCOMPLETE');
      assert.equal(saved.safety.liveProbeDiagnostics.discoveredRootCount, 631);
      assert.equal(fs.existsSync(path.join(diagnosticDir, 'current.png')), false);
    }
  }
});

test('private snapshot storage accepts large bounded Base64 without regex recursion and rejects overflow', t => {
  const { root, outDir } = tempOut();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const size of [4 * 1024 * 1024, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1]) {
    const staged = stageProductUpload({ outDir, store: STORE, mode: 'SIMPLE', originalName: 'feed.csv', buffer: Buffer.from(`sku,qty\n${size},1\n`) });
    confirmProductUpload({ outDir, jobId: staged.id, phrase: staged.confirmationPhrase });
    transitionProductUpload({ outDir, jobId: staged.id, from: 'QUEUED', to: 'PROCESSING' });
    transitionProductUpload({ outDir, jobId: staged.id, from: 'PROCESSING', to: 'FAILED_BEFORE_SUBMIT' });
    const bytes = Buffer.alloc(size); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    const args = { outDir, jobId: staged.id, phase: 'PAGE_READY', snapshot: {
      summary: { status: 'AVAILABLE', inputCount: 0, selectedFileCount: 0, inputs: [] },
      screenshotStatus: 'AVAILABLE', screenshotBase64: bytes.toString('base64'),
    } };
    const imagePath = path.join(outDir, 'product-uploads/jobs', staged.id, 'diagnostics/current.png');
    if (size > 8 * 1024 * 1024) {
      assert.throws(() => saveProductUploadDiagnostic(args), /图片无效/);
      assert.equal(fs.existsSync(imagePath), false);
    } else {
      saveProductUploadDiagnostic(args);
      assert.equal(fs.statSync(imagePath).size, size);
    }
  }
});

test('upload rechecks the prepared control immediately before clicking and consumes changed preparations', async t => {
  for (const changedState of [{ disabled: 'true' }, { ariaDisabled: 'true' }, { label: '删除商品' }]) {
    const { zn, state, file, authorization } = mockProductUploadTransport(t);
    await zn.prepareProductBulkUpload('mock-store', file, { authorization });
    // Change the page after the pre-click text read to exercise the last guard.
    zn.content = async () => { Object.assign(state, changedState); return { text: 'Upload status' }; };
    await assert.rejects(() => zn.submitProductBulkUpload('mock-store', { authorization }), /提交控件/);
    assert.equal(state.clicks, 0);
    await assert.rejects(() => zn.submitProductBulkUpload('mock-store', { authorization }), /未完成/);
    assert.equal(state.clicks, 0);
  }
});

test('a thrown upload click consumes its preparation and cannot be invoked twice', async t => {
  const { zn, state, file, authorization } = mockProductUploadTransport(t);
  await zn.prepareProductBulkUpload('mock-store', file, { authorization });
  state.clickError = new Error('mock click command response lost');
  await assert.rejects(() => zn.submitProductBulkUpload('mock-store', { authorization }), /response lost/);
  assert.equal(state.clicks, 1);
  await assert.rejects(() => zn.submitProductBulkUpload('mock-store', { authorization }), /未完成/);
  assert.equal(state.clicks, 1);
});

test('concurrent upload submit calls can consume a preparation only once', async t => {
  const { zn, state, file, authorization } = mockProductUploadTransport(t);
  await zn.prepareProductBulkUpload('mock-store', file, { authorization });
  const results = await Promise.allSettled([
    zn.submitProductBulkUpload('mock-store', { authorization }),
    zn.submitProductBulkUpload('mock-store', { authorization }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(state.clicks, 1);
});

function mockProductUploadPreview(t, options = {}) {
  const { root, outDir } = tempOut();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(outDir, 'payload.csv');
  fs.writeFileSync(file, 'sku,product_type\nPREVIEW,TEST\n', { mode: 0o600 });
  const authorization = { approved: true, action: 'product-bulk-upload', jobId: `upl_${'f'.repeat(32)}`,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  const state = { url: 'https://sellercentral.amazon.com/product-search/bulk', selections: 0,
    open: 0, submit: 0, confirm: 0, waits: 0, opened: false, submitted: false, confirmed: false,
    needsConfirmation: false, existingConfirmation: false, controls: {}, blocker: null,
    gridCount: 1, gridVisible: true, gridId: 'preview-grid', modalCount: 1, modalVisible: true,
    modalId: 'preview-modal', tourVisible: false, tourCount: 1, tourId: 'preview-tour',
    escapes: 0, keyEvents: [], queries: [], ...options };
  const control = action => ({
    async isDisplayed() { return state.controls[action]?.visible !== false; },
    async isEnabled() { return state.controls[action]?.enabled !== false; },
    async getText() { return ''; },
    async getAttribute(name) {
      const values = { label: ({ open: '验证您的文件', submit: '提交', confirm: '带错误提交' })[action],
        ...state.controls[action] };
      if (name === 'aria-disabled') return values.ariaDisabled ?? null;
      return values[name] ?? null;
    },
    async click() {
      state[action]++;
      if (action !== 'open' && state.tourVisible) throw new Error('mock Joyride intercepts the upload click');
      if (state.controls[action]?.clickError) throw new Error('mock preview click response lost');
      if (action === 'open') state.opened = true;
      if (action === 'submit') state.submitted = true;
      if (action === 'confirm') state.confirmed = true;
      state.afterClick?.(action);
    },
  });
  const input = { async isEnabled() { return true; }, async getAttribute() { return null; },
    async sendKeys(value) { assert.equal(value, file); state.selections++; } };
  const modalVisible = () => state.existingConfirmation || (state.submitted && state.needsConfirmation && !state.confirmed);
  const driver = {
    async getCurrentUrl() { return state.url; },
    async executeScript() { return { complete: true, elements: [input], rootCount: 2 }; },
    actions() {
      return {
        sendKeys(...keys) { assert.deepEqual(keys, ['\uE00C']); state.keyEvents.push(keys); return this; },
        async perform() {
          state.escapes++;
          if (state.escapeError) throw new Error('mock Escape response lost');
          if (!state.keepTour) state.tourVisible = false;
          state.afterEscape?.();
        },
      };
    },
    async findElements(selector) {
      const query = selector.value;
      state.queries.push(query);
      state.onFind?.(query);
      if (query === '.react-joyride__overlay[data-test-id="overlay"]') {
        return Array.from({ length: state.tourCount }, (_, index) => {
          const id = `${state.tourId}-${index}`;
          return { async isDisplayed() { return state.tourVisible; }, async getId() { return id; } };
        });
      }
      if (query.endsWith('kat-modal.amazon-template-preview[visible]:not([visible="false"])')) {
        return Array.from({ length: state.modalCount }, () => ({
          async isDisplayed() { return state.modalVisible && state.opened; }, async getId() { return state.modalId; },
        }));
      }
      if (query.includes('#onlineSpreadsheetErrorBanner')) {
        const blockingSelector = ({ progress: 'kat-progress', fatal: '#onlineSpreadsheetErrorBanner',
          spinner: '.submit-in-progress-spinner-wrapper' })[state.blocker?.kind];
        return blockingSelector && query.includes(blockingSelector)
          ? [{ async isDisplayed() { return state.blocker.visible !== false; } }] : [];
      }
      if (query.endsWith('#online-spreadsheet-workbook')) {
        return Array.from({ length: state.gridCount }, () => ({
          async isDisplayed() { return state.gridVisible; }, async getId() { return state.gridId; },
        }));
      }
      let action;
      if (query.includes('#open-upload-preview-btn')) action = !state.opened ? 'open' : null;
      else if (query.includes('#submit-products-confirmation-submit-with-errors-btn')) action = modalVisible() ? 'confirm' : null;
      else if (query.includes('kat-modal#submit-products-confirmation-modal')) {
        return modalVisible() ? [{ async isDisplayed() { return true; } }] : [];
      } else if (query.includes('kat-button#submit-button')) action = state.opened ? 'submit' : null;
      else return [];
      return action ? Array.from({ length: state.controls[action]?.count ?? 1 }, () => control(action)) : [];
    },
  };
  // Avoid constructors, credentials and all external transports in this fixture.
  const zn = Object.create(ZiniaoWebDriver.prototype);
  zn.sessions = new Map([['preview-store', { driver }]]);
  zn.sleep = async () => { state.waits++; state.onWait?.(); };
  zn.execExtract = async () => {
    state.onSafety?.();
    return { result: { probeVersion: 2, looksLikeLogin: !!state.authSensitive,
      looksBlocked: !!state.blocked, liveDocument: true, traversalComplete: true, accessibleTraversalComplete: true } };
  };
  zn.content = async () => {
    state.onContent?.();
    return { text: state.submitted && (!state.needsConfirmation || state.confirmed)
      ? 'Your file has been uploaded' : 'Upload status' };
  };
  const prepare = () => zn.prepareProductBulkUpload('preview-store', file, { authorization, timeoutMs: 5000 });
  const submit = () => zn.submitProductBulkUpload('preview-store', { authorization, timeoutMs: 30000 });
  return { zn, state, file, authorization, prepare, submit };
}

function productUploadClock(t) {
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  t.after(() => { Date.now = original; });
  return (milliseconds = 2500) => { now += milliseconds; };
}

test('preview opens once and submits an unchanged file once without broadening generic Submit', async t => {
  const { zn, state, prepare, submit } = mockProductUploadPreview(t);
  assert.equal(isApprovedProductUploadSubmitLabel('提交'), false);
  assert.equal(isApprovedProductUploadSubmitLabel('Submit'), false);
  await prepare();
  assert.equal(zn.session('preview-store').productUploadPrepared.flow, 'AMAZON_TEMPLATE_PREVIEW');
  assert.deepEqual([state.selections, state.open, state.submit, state.confirm], [1, 1, 0, 0]);
  assert.equal((await submit()).pageTextDelta, 'Your file has been uploaded');
  await assert.rejects(submit, /未完成/);
  assert.deepEqual([state.selections, state.open, state.submit, state.confirm], [1, 1, 1, 0]);
  assert.ok(state.queries.filter(query => query.includes('kat-button#submit-button')).every(query =>
    query.includes('#bulk-upload-page kat-modal.amazon-template-preview[visible]') && query.includes('.online-spreadsheet-root')));
});

test('preview confirms errors only after this task submits and never repeats either click', async t => {
  const { state, prepare, submit } = mockProductUploadPreview(t, { needsConfirmation: true });
  await prepare();
  const result = await submit();
  assert.equal(classifyProductUploadResult(result.pageTextDelta).state, 'COMPLETED');
  await assert.rejects(submit, /未完成/);
  assert.deepEqual([state.selections, state.open, state.submit, state.confirm], [1, 1, 1, 1]);
});

test('preview refuses a preexisting errors modal before the task submit even if its button is disabled', async t => {
  const { state, prepare, submit } = mockProductUploadPreview(t, { existingConfirmation: true,
    controls: { confirm: { disabled: 'true' } } });
  await prepare();
  await assert.rejects(submit, /已存在.*确认弹窗/);
  await assert.rejects(submit, /未完成/);
  assert.deepEqual([state.submit, state.confirm], [0, 0]);
});

test('preview waits for loading to finish and refuses fatal, hidden, absent or ambiguous grids', async t => {
  const advance = productUploadClock(t);
  for (const options of [{ blocker: { kind: 'progress' } }, { blocker: { kind: 'fatal' } },
    { blocker: { kind: 'spinner' } }, { gridCount: 0 }, { gridCount: 2 }, { gridVisible: false }]) {
    const { state, prepare } = mockProductUploadPreview(t, options);
    state.onWait = advance;
    await assert.rejects(prepare, error => error.code === 'UPLOAD_PREVIEW_SUBMIT_NOT_READY');
    assert.deepEqual([state.selections, state.open, state.submit, state.confirm], [1, 1, 0, 0]);
  }
  const { state, prepare } = mockProductUploadPreview(t, { blocker: { kind: 'progress' } });
  state.onWait = () => { advance(500); if (state.waits === 2) state.blocker = null; };
  await prepare();
  assert.equal(state.open, 1);
  assert.equal(state.submit, 0);
});

test('preview controls reject duplicate, hidden, disabled, aria-disabled and loading candidates', async t => {
  const advance = productUploadClock(t);
  for (const action of ['open', 'submit']) {
    for (const changes of [{ count: 2 }, { visible: false }, { enabled: false },
      { disabled: '' }, { ariaDisabled: 'true' }, { loading: '' }, { loading: 'true' }, { label: '' }]) {
      const { state, prepare } = mockProductUploadPreview(t, { controls: { [action]: changes } });
      state.onWait = advance;
      await assert.rejects(prepare);
      assert.equal(state[action], 0);
      assert.equal(state.selections, 1);
      assert.equal(state.confirm, 0);
    }
  }
});

test('preview error confirmation is not clicked when duplicate, hidden, disabled or loading', async t => {
  const advance = productUploadClock(t);
  for (const changes of [{ count: 2 }, { visible: false }, { enabled: false }, { disabled: '' },
    { ariaDisabled: 'true' }, { loading: 'true' }]) {
    const { state, prepare, submit } = mockProductUploadPreview(t,
      { needsConfirmation: true, controls: { confirm: changes } });
    state.onWait = advance;
    await prepare();
    if (changes.count) await assert.rejects(submit, /不唯一/);
    else assert.equal(classifyProductUploadResult((await submit()).pageTextDelta).state, 'UNKNOWN');
    await assert.rejects(submit, /未完成/);
    assert.deepEqual([state.selections, state.open, state.submit, state.confirm], [1, 1, 1, 0]);
  }
});

test('lost preview click responses never repeat the opener, submit or error confirmation', async t => {
  for (const action of ['open', 'submit', 'confirm']) {
    const { state, prepare, submit } = mockProductUploadPreview(t,
      { needsConfirmation: true, controls: { [action]: { clickError: true } } });
    if (action === 'open') await assert.rejects(prepare, /response lost/);
    else { await prepare(); await assert.rejects(submit, /response lost/); }
    await assert.rejects(submit, /未完成/);
    assert.equal(state[action], 1);
    assert.equal(state.selections, 1);
  }
});

test('preview submit rechecks changed labels, final page location and live safety after text sampling', async t => {
  for (const change of ['label', 'url', 'auth', 'blocked']) {
    const { state, prepare, submit } = mockProductUploadPreview(t);
    await prepare();
    state.onContent = () => {
      if (change === 'label') state.controls.submit = { label: 'changed action' };
      if (change === 'url') state.url = 'https://sellercentral.amazon.com/orders-v3';
      if (change === 'auth') state.authSensitive = true;
      if (change === 'blocked') state.blocked = true;
    };
    await assert.rejects(submit);
    await assert.rejects(submit, /未完成/);
    assert.deepEqual([state.submit, state.confirm], [0, 0]);
  }
});

test('preview stops if the page leaves the exact route after opening or before confirming', async t => {
  for (const action of ['open', 'submit']) {
    const { state, prepare, submit } = mockProductUploadPreview(t, { needsConfirmation: true });
    state.afterClick = clicked => { if (clicked === action) state.url = 'https://example.invalid/'; };
    if (action === 'open') await assert.rejects(prepare, /离开/);
    else { await prepare(); await assert.rejects(submit, /未批准/); }
    await assert.rejects(submit, /未完成/);
    assert.equal(state.confirm, 0);
    assert.equal(state.selections, 1);
  }
});

test('concurrent preview submit requests consume one preparation and one confirmation', async t => {
  const { state, prepare, submit } = mockProductUploadPreview(t, { needsConfirmation: true });
  await prepare();
  const results = await Promise.allSettled([submit(), submit()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.deepEqual([state.selections, state.open, state.submit, state.confirm], [1, 1, 1, 1]);
});

test('preview rechecks the opener URL and error-confirmation safety after their final control reads', async t => {
  for (const action of ['open', 'confirm']) {
    const { state, prepare, submit } = mockProductUploadPreview(t, { needsConfirmation: true });
    let reads = 0;
    state.onFind = query => {
      const matched = action === 'open' ? query.includes('#open-upload-preview-btn')
        : query.includes('#submit-products-confirmation-submit-with-errors-btn');
      if (matched && ++reads === 2) {
        if (action === 'open') state.url = 'https://sellercentral.amazon.com/orders-v3';
        else state.authSensitive = true;
      }
    };
    if (action === 'open') await assert.rejects(prepare);
    else { await prepare(); await assert.rejects(submit, /安全检查/); }
    assert.equal(state[action], 0);
    assert.equal(state.selections, 1);
    await assert.rejects(submit, /未完成/);
  }
});

test('preview controls becoming disabled during the final safety probe are never clicked', async t => {
  for (const action of ['submit', 'confirm']) {
    const { state, prepare, submit } = mockProductUploadPreview(t, { needsConfirmation: true });
    await prepare();
    let checkAfterProbe = false, confirmationReads = 0;
    if (action === 'submit') state.onContent = () => { checkAfterProbe = true; };
    else state.onFind = query => {
      if (query.includes('#submit-products-confirmation-submit-with-errors-btn') && ++confirmationReads === 2) checkAfterProbe = true;
    };
    state.onSafety = () => { if (checkAfterProbe) state.controls[action] = { disabled: 'true' }; };
    await assert.rejects(submit);
    assert.equal(state[action], 0);
    await assert.rejects(submit, /未完成/);
  }
});

test('preview tour uses one normal Escape and preserves the original file and submit authorization', async t => {
  for (const phase of ['prepare', 'submit']) {
    const { zn, state, prepare, submit } = mockProductUploadPreview(t, { tourVisible: phase === 'prepare' });
    await prepare();
    assert.equal(state.escapes, phase === 'prepare' ? 1 : 0);
    if (phase === 'submit') state.tourVisible = true;
    assert.equal((await submit()).pageTextDelta, 'Your file has been uploaded');
    assert.deepEqual(state.keyEvents, [['\uE00C']]);
    assert.deepEqual([state.selections, state.open, state.escapes, state.submit, state.confirm], [1, 1, 1, 1, 0]);
    assert.equal(zn.session('preview-store').productUploadPrepared, null);
    await assert.rejects(submit, /未完成/);
    assert.equal(state.escapes, 1);
  }
});

test('preview without a visible tour sends no keyboard action', async t => {
  for (const tourCount of [0, 1, 2]) {
    const { state, prepare, submit } = mockProductUploadPreview(t, { tourCount, tourVisible: false });
    await prepare(); await submit();
    assert.deepEqual(state.keyEvents, []);
    assert.equal(state.escapes, 0);
    assert.equal(state.submit, 1);
  }
});

test('preview tour requires one visible overlay, modal and grid with no business confirmation', async t => {
  for (const options of [{ tourCount: 2 }, { modalCount: 2 }, { modalVisible: false },
    { gridCount: 2 }, { gridVisible: false }, { existingConfirmation: true }]) {
    const { state, prepare, submit } = mockProductUploadPreview(t, { tourVisible: true, ...options });
    await assert.rejects(prepare);
    assert.deepEqual([state.selections, state.escapes, state.submit, state.confirm], [1, 0, 0, 0]);
    await assert.rejects(submit, /未完成/);
  }
});

test('preview tour rechecks safety, exact URL and element identities before pressing Escape', async t => {
  for (const change of ['auth', 'blocked', 'url', 'modal', 'grid', 'overlay']) {
    const { state, prepare } = mockProductUploadPreview(t, { tourVisible: true });
    state.onSafety = () => {
      if (!state.opened) return;
      if (change === 'auth') state.authSensitive = true;
      if (change === 'blocked') state.blocked = true;
      if (change === 'url') state.url = 'https://sellercentral.amazon.com/orders-v3';
      if (change === 'modal') state.modalId = 'replaced-modal';
      if (change === 'grid') state.gridId = 'replaced-grid';
      if (change === 'overlay') state.tourId = 'replaced-overlay';
    };
    await assert.rejects(prepare, undefined, change);
    assert.deepEqual([state.escapes, state.submit, state.confirm], [0, 0, 0], change);
  }
});

test('preview tour Escape failures and persistent overlays stop without a repeated key or submit click', async t => {
  const advance = productUploadClock(t);
  for (const phase of ['prepare', 'submit']) {
    for (const failure of [{ escapeError: true }, { keepTour: true }]) {
      const { state, prepare, submit } = mockProductUploadPreview(t,
        { tourVisible: phase === 'prepare', ...failure });
      state.onWait = () => advance(1000);
      if (phase === 'prepare') await assert.rejects(prepare);
      else { await prepare(); state.tourVisible = true; await assert.rejects(submit); }
      await assert.rejects(submit, /未完成/);
      assert.deepEqual([state.selections, state.open, state.escapes, state.submit, state.confirm], [1, 1, 1, 0, 0]);
    }
  }
});

test('preview tour dismissal must preserve the same visible safe preview and leave no business modal', async t => {
  for (const change of ['auth', 'blocked', 'url', 'modal', 'grid', 'hidden-modal', 'hidden-grid', 'confirmation']) {
    const { state, prepare, submit } = mockProductUploadPreview(t, { tourVisible: true });
    state.afterEscape = () => {
      if (change === 'auth') state.authSensitive = true;
      if (change === 'blocked') state.blocked = true;
      if (change === 'url') state.url = 'https://sellercentral.amazon.com/orders-v3';
      if (change === 'modal') state.modalId = 'replaced-modal';
      if (change === 'grid') state.gridId = 'replaced-grid';
      if (change === 'hidden-modal') state.modalVisible = false;
      if (change === 'hidden-grid') state.gridVisible = false;
      if (change === 'confirmation') state.existingConfirmation = true;
    };
    await assert.rejects(prepare, undefined, change);
    await assert.rejects(submit, /未完成/);
    assert.deepEqual([state.selections, state.escapes, state.submit, state.confirm], [1, 1, 0, 0], change);
  }
});

test('preview tour that returns after dismissal or appears during final checks never causes another action', async t => {
  for (const phase of ['before-submit', 'text-sampling']) {
    const { state, prepare, submit } = mockProductUploadPreview(t, { tourVisible: phase === 'before-submit' });
    await prepare();
    if (phase === 'before-submit') state.tourVisible = true;
    else state.onContent = () => { state.tourVisible = true; };
    await assert.rejects(submit, error => error.code === 'UPLOAD_PREVIEW_TOUR_BLOCKED');
    await assert.rejects(submit, /未完成/);
    assert.equal(state.escapes, phase === 'before-submit' ? 1 : 0);
    assert.equal(state.submit, 0);
  }
});

test('concurrent preview submissions can dismiss a late tour only once', async t => {
  const { state, prepare, submit } = mockProductUploadPreview(t);
  await prepare(); state.tourVisible = true;
  const results = await Promise.allSettled([submit(), submit()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.deepEqual([state.selections, state.escapes, state.submit], [1, 1, 1]);
});

test('upload receipt URLs require the exact status route and one complete batch/account reference', () => {
  const base = 'https://sellercentral.amazon.com/listing/status';
  assert.equal(productUploadReceiptReference(`${base}?reference_id=batch-123&account_id=fixture-account`), 'batch-123');
  for (const url of [base, `${base}?reference_id=batch-123`, `${base}?reference_id=batch-123&account_id=`,
    `${base}?reference_id=batch-123&reference_id=batch-456&account_id=fixture-account`,
    `${base}?reference_id=batch-123&account_id=a&account_id=b`,
    `${base}?reference_id=bad%2Fbatch&account_id=fixture-account`,
    `${base}?reference_id=${'b'.repeat(161)}&account_id=fixture-account`,
    `${base}?reference_id=batch-123&account_id=fixture-account#old`,
    `${base}/?reference_id=batch-123&account_id=fixture-account`,
    'http://sellercentral.amazon.com/listing/status?reference_id=batch-123&account_id=a',
    'https://sellercentral.amazon.com.example.invalid/listing/status?reference_id=batch-123&account_id=a']) {
    assert.equal(productUploadReceiptReference(url), null);
  }
});

test('status-row receipt evidence survives public normalization only for completed uploads with a valid batch', () => {
  const result = buildProductUploadResult({ state: 'COMPLETED', receiptEvidence: 'UPLOAD_STATUS_ROW', batchId: 'batch-123' });
  const job = { state: 'COMPLETED', file: {}, result };
  const center = publicProductUploadJob(job).resultCenter;
  assert.deepEqual(center.receipt, { status: 'ACCEPTED', evidence: 'UPLOAD_STATUS_ROW' });
  assert.equal(center.identifiers.batchId, 'batch-123');
  assert.equal(center.processing.status, 'UNKNOWN');
  assert.equal(center.counts.availability, 'NOT_AVAILABLE');
  assert.equal(result.amazonResponse.availability, 'NOT_AVAILABLE');
  for (const args of [{ state: 'UNKNOWN', batchId: 'batch-123' }, { state: 'COMPLETED' },
    { state: 'COMPLETED', batchId: 'invalid/batch' }]) {
    const value = buildProductUploadResult({ receiptEvidence: 'UPLOAD_STATUS_ROW', ...args });
    assert.notEqual(value.center.receipt.evidence, 'UPLOAD_STATUS_ROW');
  }
});

function uploadReceiptDom(options = {}) {
  const make = (tagName, attributes = {}, text = '') => {
    const el = { tagName: tagName.toUpperCase(), attributes, children: [], parentElement: null, shadowRoot: null,
      textContent: text, innerText: text, hidden: false, style: { display: 'block', visibility: 'visible', opacity: '1' },
      getAttribute(name) { return this.attributes[name] ?? null; },
      getClientRects() { return this.noRects ? [] : [{}]; },
      getRootNode() { return this.parentElement ? this.parentElement.getRootNode() : this.root || document; },
      querySelectorAll(selector) {
        const all = [];
        const walk = node => { for (const child of node.children) { all.push(child); walk(child); } };
        walk(this);
        if (selector === '*') return all;
        if (selector === '.file-name-content > b') return all.filter(node => node.tagName === 'B'
          && node.parentElement?.classList.contains('file-name-content'));
        throw new Error(`Unexpected receipt DOM selector ${selector}`);
      } };
    el.classList = { contains(name) { return String(el.attributes.class || '').split(/\s+/).includes(name); } };
    return el;
  };
  const append = (parent, child) => { parent.children.push(child); child.parentElement = parent.tagName === '#SHADOW-ROOT' ? null : parent;
    if (parent.tagName === '#SHADOW-ROOT') child.root = parent; return child; };
  const table = make('kat-data-table', { id: 'submission-status-table' });
  const document = { querySelectorAll(selector) { assert.equal(selector, '#submission-status-table');
    return options.missingTable ? [] : options.duplicateTable ? [table, table] : [table]; } };
  const shadow = make('#shadow-root'); shadow.host = table; table.shadowRoot = shadow;
  const wrapper = append(shadow, make('div'));
  const cell = (id, text = '', latest = true) => append(wrapper, make('td', { 'data-cy-id': id,
    class: latest ? 'latest-submission-table-row' : '' }, text));
  const batch = cell('feed-batch-id:row-1', options.batch || 'batch-123', options.latestBatch !== false);
  const filenameCell = cell(`file-name-and-date:row-${options.differentRow ? 2 : 1}`, '', options.latestFile !== false);
  const filename = append(append(filenameCell, make('div', { class: 'file-name-content' })), make('b', {}, options.filename || 'payload.csv'));
  const privateAction = cell('actions-container:row-1');
  Object.defineProperty(privateAction, 'textContent', { get() { throw new Error('Receipt must not read action payloads'); } });
  if (options.duplicateBatch) cell('feed-batch-link:row-1', 'batch-123');
  if (options.duplicateFilename) append(filename.parentElement, make('b', {}, 'payload.csv'));
  if (options.invisible === 'table') table.style.opacity = '0';
  if (options.invisible === 'ancestor') wrapper.style.opacity = '0';
  if (options.invisible === 'batch') batch.style.visibility = 'collapse';
  if (options.invisible === 'filename') filename.style.display = 'none';
  if (options.noRects) batch.noRects = true;
  if (options.wrongTag) table.tagName = 'DIV';
  if (options.nodeLimit) for (let i = 0; i < 12001; i++) append(wrapper, make('span'));
  if (options.rootLimit) for (let i = 0; i < 256; i++) {
    const host = append(wrapper, make('span')), root = make('#shadow-root'); root.host = host; host.shadowRoot = root;
  }
  return { document, getComputedStyle: node => node.style };
}

function useUploadReceiptDom(fixture, options = {}) {
  const { zn, state } = fixture;
  const driver = zn.session('preview-store').driver;
  const originalExecute = driver.executeScript;
  state.receiptReads = 0;
  state.afterClick = action => {
    if (action === 'submit') state.url = options.url
      || 'https://sellercentral.amazon.com/listing/status?reference_id=batch-123&account_id=fixture-account';
  };
  driver.executeScript = async (script, ...args) => {
    if (!script.includes('submission-status-table')) return originalExecute(script, ...args);
    state.receiptReads++;
    assert.equal(state.submit, 1, 'Receipt sampling must follow this task’s submit click');
    // Execute only our own transport extractor against synthetic DOM objects;
    // no Amazon application bundle or external page is evaluated.
    const result = vm.runInNewContext(`(function(){${script}}).apply(null,args)`,
      { ...uploadReceiptDom(options), args });
    if (options.changeAfterRead) state.url = 'https://sellercentral.amazon.com/listing/status?reference_id=other&account_id=fixture-account';
    if (options.authAfterRead) state.authSensitive = true;
    return result;
  };
}

test('upload receipt extractor follows the KAT table shadow root and returns only this batch/file association', async t => {
  const fixture = mockProductUploadPreview(t);
  useUploadReceiptDom(fixture);
  await fixture.prepare();
  assert.equal(fixture.state.receiptReads, 0);
  const result = await fixture.submit();
  assert.deepEqual(result.receipt, { version: 1, source: 'AMAZON_UPLOAD_STATUS_ROW', batchId: 'batch-123',
    fileNameMatched: true, latestRowMatched: true });
  assert.equal(result.pageTextDelta, '');
  assert.doesNotMatch(JSON.stringify(result), /fixture-account|payload\.csv|action/);
  assert.equal(fixture.state.receiptReads, 1);
  await assert.rejects(fixture.submit, /未完成/);
});

test('upload receipt extractor refuses old, mismatched, ambiguous, invisible or incomplete table evidence', async t => {
  const advance = productUploadClock(t);
  for (const options of [{ batch: 'old-batch' }, { filename: 'old-file.csv' }, { latestBatch: false },
    { latestFile: false }, { differentRow: true }, { duplicateBatch: true }, { duplicateFilename: true },
    { duplicateTable: true }, { missingTable: true }, { wrongTag: true }, { invisible: 'table' },
    { invisible: 'ancestor' }, { invisible: 'batch' }, { invisible: 'filename' }, { noRects: true },
    { rootLimit: true }, { nodeLimit: true }]) {
    const fixture = mockProductUploadPreview(t);
    fixture.state.onWait = () => advance(fixture.state.submitted ? 10000 : 250);
    useUploadReceiptDom(fixture, options);
    await fixture.prepare();
    const result = await fixture.submit();
    assert.equal(result.receipt, undefined, JSON.stringify(options));
    assert.equal(result.pageTextDelta, '', 'A status-page title cannot replace a missing associated receipt');
    assert.equal(classifyProductUploadResult(result.pageTextDelta).state, 'UNKNOWN');
    assert.equal(fixture.state.submit, 1);
  }
});

test('upload status redirect alone and a changed or unsafe page during receipt sampling cannot prove acceptance', async t => {
  const advance = productUploadClock(t);
  for (const options of [{ url: 'https://sellercentral.amazon.com/listing/status' },
    { changeAfterRead: true }, { authAfterRead: true }]) {
    const fixture = mockProductUploadPreview(t);
    fixture.state.onWait = () => advance(fixture.state.submitted ? 10000 : 250);
    useUploadReceiptDom(fixture, options);
    await fixture.prepare();
    if (options.url) {
      const result = await fixture.submit();
      assert.equal(result.receipt, undefined);
      assert.equal(result.pageTextDelta, '');
      assert.equal(fixture.state.receiptReads, 0);
    } else await assert.rejects(fixture.submit, /页面发生变化/);
    assert.equal(fixture.state.submit, 1);
    await assert.rejects(fixture.submit, /未完成/);
  }
});

function resettableUploadFixture(t, state = 'UNKNOWN') {
  const { root, outDir } = tempOut();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('sku,qty\nORIGINAL,1\n');
  let job = stageProductUpload({ outDir, store: STORE, originalName: 'original.csv', buffer: bytes, mode: 'SIMPLE' });
  const record = path.join(outDir, 'product-uploads', 'jobs', job.id, 'record.json');
  // Construct every legacy state, including PREPARED, without a real worker.
  job = { ...job, state };
  fs.writeFileSync(record, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  const resetFile = path.join(path.dirname(record), 'reset.json');
  const reset = overrides => resetProductUploadDuplicate({ outDir, jobId: job.id,
    phrase: productUploadResetPhrase(job), reason: '人工核对后重新提交', actor: 'fixture-operator', acknowledgeRisk: true, ...overrides });
  return { root, outDir, bytes, job, record, resetFile, reset };
}

test('manual duplicate reset preserves UNKNOWN bytes and state, and permits only a separately confirmed new job', t => {
  const { outDir, bytes, job, record, resetFile, reset } = resettableUploadFixture(t);
  const oldRecord = fs.readFileSync(record);
  const oldPayload = fs.readFileSync(payloadPathForJob({ outDir, job }));
  assert.deepEqual(productUploadResetInfo({ outDir, job }), { eligible: true, resetAt: null, reason: null, actor: null });
  const info = reset();
  assert.equal(info.eligible, false);
  assert.equal(info.actor, 'fixture-operator');
  assert.ok(info.resetAt);
  assert.equal(fs.statSync(resetFile).mode & 0o777, 0o600);
  const marker = JSON.parse(fs.readFileSync(resetFile, 'utf8'));
  assert.equal(marker.recordSHA256, crypto.createHash('sha256').update(oldRecord).digest('hex'));
  assert.equal(marker.state, 'UNKNOWN');
  assert.equal(marker.sha256, job.file.sha256);
  assert.deepEqual(fs.readFileSync(record), oldRecord);
  assert.deepEqual(fs.readFileSync(payloadPathForJob({ outDir, job })), oldPayload);
  assert.deepEqual(productUploadResetInfo({ outDir, job }), info);
  assert.throws(() => reset(), /已重置/);
  const next = stageProductUpload({ outDir, store: STORE, originalName: 'again.csv', buffer: bytes, mode: 'SIMPLE' });
  assert.notEqual(next.id, job.id);
  assert.equal(next.state, 'STAGED');
  assert.equal(next.confirmedAt, undefined);
  assert.deepEqual(next.resetOf, [job.id]);
  assert.deepEqual(publicProductUploadJob(next).resetOf, [job.id]);
  assert.deepEqual(fs.readFileSync(payloadPathForJob({ outDir, job: next })), bytes);
  assert.equal(fs.readdirSync(path.join(outDir, 'product-uploads', 'queue')).length, 0);
  assert.throws(() => stageProductUpload({ outDir, store: STORE, originalName: 'third.csv', buffer: bytes }), /相同店铺与文件摘要/);
  const queued = confirmProductUpload({ outDir, jobId: next.id, phrase: next.confirmationPhrase });
  assert.equal(queued.state, 'QUEUED');
  assert.equal(readProductUploadJob({ outDir, jobId: job.id }).state, 'UNKNOWN');
});

test('duplicate reset refuses active states, queue markers, invalid acknowledgments and replay', t => {
  for (const state of ['STAGED', 'QUEUED', 'PROCESSING', 'PREPARED', 'SUBMITTING']) {
    const { outDir, job, resetFile, reset } = resettableUploadFixture(t, state);
    assert.equal(productUploadResetInfo({ outDir, job }).eligible, false);
    assert.throws(() => reset(), /活动上传任务/);
    assert.equal(fs.existsSync(resetFile), false);
  }
  const { outDir, job, resetFile, reset } = resettableUploadFixture(t);
  for (const bad of [{ phrase: 'wrong' }, { acknowledgeRisk: false }, { reason: '' }, { reason: 'x'.repeat(301) }]) {
    assert.throws(() => reset(bad), /短语|风险|原因/);
    assert.equal(fs.existsSync(resetFile), false);
  }
  const queue = path.join(outDir, 'product-uploads', 'queue', job.id);
  fs.writeFileSync(queue, job.id, { mode: 0o600 });
  assert.throws(() => reset(), /队列标记/);
  clearProductUploadQueueMarker({ outDir, jobId: job.id });
  fs.symlinkSync(resetFile, queue);
  assert.throws(() => reset(), /队列标记/);
  fs.unlinkSync(queue);
  reset();
  assert.throws(() => reset(), /已重置/);
});

test('duplicate decisions inspect records older than the latest 500 entries', t => {
  const { outDir, bytes, job, record, reset } = resettableUploadFixture(t);
  const old = { ...job, createdAt: '2020-01-01T00:00:00+08:00', updatedAt: '2020-01-01T00:00:00+08:00' };
  fs.writeFileSync(record, JSON.stringify(old));
  const jobs = path.dirname(path.dirname(record));
  for (let i = 1; i <= 501; i++) {
    const id = `upl_${i.toString(16).padStart(32, '0')}`;
    const dir = path.join(jobs, id);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ ...job, id, state: 'COMPLETED',
      store: { ...job.store, key: `OTHER-${i}` } }), { mode: 0o600 });
  }
  assert.equal(listProductUploadJobs({ outDir, limit: 500 }).some(row => row.id === job.id), false);
  assert.throws(() => stageProductUpload({ outDir, store: STORE, originalName: 'again.csv', buffer: bytes }), /相同店铺与文件摘要/);
  reset();
  const next = stageProductUpload({ outDir, store: STORE, originalName: 'again.csv', buffer: bytes });
  assert.deepEqual(next.resetOf, [job.id]);
  assert.throws(() => stageProductUpload({ outDir, store: STORE, originalName: 'third.csv', buffer: bytes }), /相同店铺与文件摘要/);
});

test('damaged records and reset bindings fail closed across the complete ledger', t => {
  for (const damage of ['json', 'missing-binding', 'bad-sha-type', 'bad-store-type', 'unknown-entry', 'reset-json', 'reset-binding', 'record-changed', 'reset-hardlink', 'reset-symlink', 'reset-oversized']) {
    const { outDir, bytes, job, record, resetFile, reset } = resettableUploadFixture(t);
    if (damage.startsWith('reset-') || damage === 'record-changed') reset();
    if (damage === 'json') fs.writeFileSync(record, '{broken');
    if (damage === 'missing-binding') fs.writeFileSync(record, JSON.stringify({ version: 1, id: job.id, state: 'UNKNOWN' }));
    if (damage === 'bad-sha-type') fs.writeFileSync(record, JSON.stringify({ ...job, file: { ...job.file, sha256: [job.file.sha256] } }));
    if (damage === 'bad-store-type') fs.writeFileSync(record, JSON.stringify({ ...job, store: { ...job.store, key: [job.store.key] } }));
    if (damage === 'unknown-entry') fs.writeFileSync(path.join(path.dirname(path.dirname(record)), 'unknown'), 'unidentified');
    if (damage === 'reset-json') fs.writeFileSync(resetFile, '{broken');
    if (damage === 'reset-binding') {
      const value = JSON.parse(fs.readFileSync(resetFile, 'utf8')); value.sha256 = 'f'.repeat(64); fs.writeFileSync(resetFile, JSON.stringify(value));
    }
    if (damage === 'record-changed') fs.appendFileSync(record, '\n');
    if (damage === 'reset-hardlink') fs.linkSync(resetFile, path.join(outDir, 'other-link'));
    if (damage === 'reset-symlink') { const actual = `${resetFile}.old`; fs.renameSync(resetFile, actual); fs.symlinkSync(actual, resetFile); }
    if (damage === 'reset-oversized') fs.writeFileSync(resetFile, ' '.repeat(17 * 1024));
    assert.throws(() => stageProductUpload({ outDir, store: { ...STORE, key: 'OTHER' }, originalName: 'new.csv', buffer: bytes }), undefined, damage);
    assert.throws(() => reset(), undefined, damage);
  }
});

test('a failed reset audit leaves duplicate protection intact', t => {
  const { outDir, bytes, job, resetFile, reset } = resettableUploadFixture(t);
  const auditDir = path.join(outDir, 'product-uploads', 'audit');
  const audit = path.join(auditDir, `${bjIso().slice(0, 10)}.jsonl`);
  fs.unlinkSync(audit);
  fs.symlinkSync(path.join(outDir, 'unrelated'), audit);
  assert.throws(() => reset(), /审计文件结构异常/);
  assert.equal(fs.existsSync(resetFile), false);
  assert.equal(productUploadResetInfo({ outDir, job }).eligible, true);
  assert.throws(() => stageProductUpload({ outDir, store: STORE, originalName: 'again.csv', buffer: bytes }), /相同店铺与文件摘要/);
});

test('reset publication failure removes only its own sidecar, and reports uncertain cleanup explicitly', t => {
  const originalSync = fs.fsyncSync, originalUnlink = fs.unlinkSync;
  t.after(() => { fs.fsyncSync = originalSync; fs.unlinkSync = originalUnlink; });
  for (const scenario of ['remove-ok', 'unlink-fails', 'replaced-inode', 'changed-content', 'double-sync', 'cleanup-unknown']) {
    const { outDir, bytes, job, resetFile, reset } = resettableUploadFixture(t);
    let failed = false, replacement = null;
    fs.fsyncSync = fd => {
      if (failed && scenario === 'double-sync' && fs.fstatSync(fd).isDirectory()) throw new Error('fixture rollback sync failure');
      if (!failed && fs.existsSync(resetFile) && fs.fstatSync(fd).isDirectory()) {
        if (scenario === 'replaced-inode') {
          replacement = 'unrelated replacement';
          fs.writeFileSync(`${resetFile}.replacement`, replacement);
          fs.renameSync(`${resetFile}.replacement`, resetFile);
        } else if (scenario === 'changed-content') {
          replacement = fs.readFileSync(resetFile, 'utf8').replace('"version": 1', '"version": 2');
          fs.writeFileSync(resetFile, replacement);
        }
        failed = true; throw new Error('fixture directory sync failure');
      }
      return originalSync(fd);
    };
    fs.unlinkSync = file => {
      if (['unlink-fails', 'cleanup-unknown'].includes(scenario) && file === resetFile) throw new Error('fixture cleanup failure');
      if (failed && scenario === 'cleanup-unknown' && path.basename(file).startsWith('.reset.')) throw new Error('fixture finalizer cleanup failure');
      return originalUnlink(file);
    };
    assert.throws(() => reset(), scenario !== 'remove-ok' ? { code: 'RESET_COMMIT_UNKNOWN' } : /fixture directory sync failure/);
    fs.fsyncSync = originalSync; fs.unlinkSync = originalUnlink;
    assert.equal(fs.existsSync(resetFile), !['remove-ok', 'double-sync'].includes(scenario));
    if (replacement !== null) assert.equal(fs.readFileSync(resetFile, 'utf8'), replacement);
    assert.equal(readProductUploadJob({ outDir, jobId: job.id }).state, 'UNKNOWN');
    if (['remove-ok', 'double-sync'].includes(scenario)) assert.throws(() => stageProductUpload({ outDir, store: STORE, originalName: 'again.csv', buffer: bytes }), /相同店铺与文件摘要/);
  }
});

test('a committed reset cannot fail from repeated cleanup of its removed temporary file', t => {
  const { outDir, job, reset } = resettableUploadFixture(t);
  const originalUnlink = fs.unlinkSync;
  t.after(() => { fs.unlinkSync = originalUnlink; });
  let temporaryUnlinks = 0;
  fs.unlinkSync = file => {
    if (path.basename(file).startsWith('.reset.') && ++temporaryUnlinks > 1) throw new Error('fixture repeated cleanup failure');
    return originalUnlink(file);
  };
  const result = reset();
  fs.unlinkSync = originalUnlink;
  assert.equal(temporaryUnlinks, 1);
  assert.deepEqual(productUploadResetInfo({ outDir, job }), result);
  assert.equal(result.eligible, false);
});

// Synthetic only. Do not construct the transport (its constructor loads
// credentials); exercise the actual method on its prototype with mock I/O.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=';
const SECRET = 'PRIVATE_FILENAME_OR_CUSTOMER_TEXT';
function fileInput(sizes = [123], aria = 'false') {
  return { isConnected: true, tagName: 'INPUT', type: 'file',
    files: sizes.map(size => ({ size, get name() { throw new Error(SECRET); } })),
    validity: { valid: true, valueMissing: false },
    getAttribute(name) { return name === 'aria-invalid' ? aria : SECRET; } };
}
function captureFixture(options = {}) {
  const state = { scripts: 0, shots: 0, gates: 0, urls: 0 };
  const inputs = options.inputs || [fileInput()];
  const driver = {
    async getCurrentUrl() { state.urls++; return options.urlAtRead?.(state.urls) ?? options.url ?? 'https://sellercentral.amazon.com/product-search/bulk'; },
    async executeScript(script, ...args) {
      state.scripts++;
      if (script.includes('maxRoots=240')) return { complete: options.traversalComplete !== false, elements: inputs };
      if (options.raw) return options.raw;
      return vm.runInNewContext(`(function(){${script}})`, {}, { timeout: 1000 })(...args);
    },
    async takeScreenshot() {
      state.shots++;
      if (options.shotFails) throw new Error(SECRET);
      return options.image ?? PNG;
    },
    async findElements() { throw new Error('Unexpected fallback'); },
  };
  const zn = Object.create(ZiniaoWebDriver.prototype);
  zn.sessions = new Map([['mock-store', { driver }]]);
  zn.execExtract = async () => {
    state.gates++;
    return { result: { probeVersion: 2, looksLikeLogin: state.gates === options.unsafeGate,
      looksBlocked: false, liveDocument: true, traversalComplete: true, accessibleTraversalComplete: true,
      ...(options.probeForGate ? options.probeForGate(state.gates) : options.probe) } };
  };
  return { state, capture: expectedSize => zn.captureProductBulkUploadDiagnostic('mock-store', { expectedSize }) };
}

test('capture returns only safe file/validity fields and one private PNG', async () => {
  const f = captureFixture();
  const result = await f.capture(123);
  assert.equal(result.summary.status, 'AVAILABLE');
  assert.equal(result.summary.inputCount, 1);
  assert.equal(result.summary.selectedFileCount, 1);
  assert.equal(result.summary.singleSelectedFileSizeMatches, true);
  assert.equal(result.summary.inputs[0].validity.valid, true);
  assert.equal(result.summary.inputs[0].validity.valueMissing, false);
  assert.equal(result.summary.inputs[0].validity.customError, null);
  assert.equal(result.summary.inputs[0].ariaInvalid, false);
  assert.equal(result.screenshotStatus, 'AVAILABLE');
  assert.equal(result.screenshotBase64, PNG);
  assert.equal(f.state.shots, 1);
  assert.equal(f.state.gates, 3);
  assert.equal(result.safety.stage, 'AFTER_SCREENSHOT');
  assert.equal(result.safety.reason, 'LIVE_PAGE_NON_SENSITIVE');
  assert.equal(result.safety.exactUrl, true);
  assert.equal(result.safety.authSensitive, false);
  assert.equal(result.safety.blocked, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FILENAME_OR_CUSTOMER_TEXT|"(?:filename|name|path)"/i);
});

test('zero, multiple and mismatched files never imply selection or matching', async () => {
  const empty = await captureFixture({ inputs: [] }).capture(123);
  assert.equal(empty.summary.inputCount, 0);
  assert.equal(empty.summary.selectedFileCount, 0);
  assert.equal(empty.summary.singleSelectedFileSizeMatches, null);
  const multiple = await captureFixture({ inputs: [fileInput([123, 456])] }).capture(123);
  assert.equal(multiple.summary.selectedFileCount, 2);
  assert.equal(multiple.summary.singleSelectedFileSizeMatches, null);
  assert.equal((await captureFixture().capture(999)).summary.singleSelectedFileSizeMatches, false);
  assert.equal((await captureFixture().capture(undefined)).summary.singleSelectedFileSizeMatches, null);
});

test('ARIA values and unknown script fields cannot leak arbitrary text', async () => {
  const aria = await captureFixture({ inputs: [fileInput([123], SECRET)] }).capture(123);
  assert.equal(aria.summary.inputs[0].ariaInvalid, null);
  const invalid = await captureFixture({ raw: { complete: true, selectedFileCount: SECRET,
    singleSelectedFileSizeMatches: SECRET, inputs: [], filename: SECRET } }).capture(123);
  assert.equal(invalid.summary.status, 'UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE/);
});

test('unsafe page before reads, before screenshot or after screenshot discards evidence', async () => {
  for (const unsafeGate of [1, 2, 3]) {
    const f = captureFixture({ unsafeGate });
    const result = await f.capture(123);
    assert.equal(result.summary.status, 'UNSAFE_PAGE');
    assert.equal(result.summary.inputCount, null);
    assert.deepEqual(result.summary.inputs, []);
    assert.equal(result.screenshotStatus, 'BLOCKED');
    assert.equal(result.screenshotBase64, null);
    assert.equal(f.state.shots, unsafeGate === 3 ? 1 : 0);
    assert.equal(result.safety.stage, ['START', 'BEFORE_SCREENSHOT', 'AFTER_SCREENSHOT'][unsafeGate - 1]);
    assert.equal(result.safety.reason, 'AUTH_SENSITIVE');
    assert.equal(result.safety.authSensitive, true);
    assert.equal(result.safety.blocked, false);
  }
  const mismatch = captureFixture({ url: 'https://sellercentral.amazon.com/ap/signin?token=private' });
  assert.equal((await mismatch.capture(123)).screenshotStatus, 'BLOCKED');
  assert.equal(mismatch.state.scripts, 0);
  assert.equal(mismatch.state.shots, 0);
});

test('incomplete traversal retains only the existing numeric and boolean safety fields at the failed gate', async () => {
  for (const failureAt of [1, 2, 3]) {
    const f = captureFixture({ probeForGate: gate => gate === failureAt ? {
      traversalComplete: false, accessibleTraversalComplete: true,
      visibleFrameCount: 2, unreadableVisibleFrameCount: 1, unreadableFrameErrorCount: 1,
      mainDocumentTraversalComplete: true, rootBudgetExceeded: false,
      rootBudget: 512, elementBudget: 50000, nodeBudget: 5000,
      discoveredRootCount: SECRET, scannedRootCount: 0.5,
      traversalErrorCount: 10000001, opaqueBlockedHintCount: -1,
      currentUrl: 'https://example.invalid/?token=PRIVATE', message: SECRET, unknownCounter: 123,
    } : {} });
    const result = await f.capture(123);
    assert.equal(result.safety.reason, 'LIVE_SAFETY_PROBE_INCOMPLETE');
    assert.equal(result.safety.stage, ['START', 'BEFORE_SCREENSHOT', 'AFTER_SCREENSHOT'][failureAt - 1]);
    assert.equal(result.safety.authSensitive, false);
    assert.equal(result.safety.blocked, false);
    assert.deepEqual(result.safety.liveProbeDiagnostics, {
      visibleFrameCount: 2, unreadableVisibleFrameCount: 1, unreadableFrameErrorCount: 1,
      rootBudget: 512, elementBudget: 50000, nodeBudget: 5000,
      accessibleTraversalComplete: true, mainDocumentTraversalComplete: true, rootBudgetExceeded: false,
    });
    assert.equal(result.summary.status, 'UNSAFE_PAGE');
    assert.equal(result.summary.inputCount, null);
    assert.equal(result.screenshotBase64, null);
    assert.equal(f.state.shots, failureAt === 3 ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|unknownCounter|currentUrl|example.invalid/);
  }
});

test('blocked, unavailable and changed-page safety causes remain distinguishable without retaining URLs', async () => {
  const blocked = await captureFixture({ probe: { looksBlocked: true } }).capture(123);
  assert.equal(blocked.safety.reason, 'ACCESS_BLOCKED');
  assert.equal(blocked.safety.authSensitive, true);
  assert.equal(blocked.safety.blocked, true);
  const unavailable = await captureFixture({ probe: { liveDocument: false } }).capture(123);
  assert.equal(unavailable.safety.reason, 'LIVE_SAFETY_PROBE_UNAVAILABLE');
  const changed = await captureFixture({ urlAtRead: n => n >= 3
    ? 'https://sellercentral.amazon.com/ap/signin?token=PRIVATE'
    : 'https://sellercentral.amazon.com/product-search/bulk' }).capture(123);
  assert.equal(changed.safety.reason, 'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE');
  assert.equal(changed.safety.authSensitive, true);
  assert.equal(changed.screenshotBase64, null);
  assert.doesNotMatch(JSON.stringify(changed), /PRIVATE|https|signin/);
});

test('exact bulk URL rejection and missing URL are safe reasons without reading the page', async () => {
  const query = captureFixture({ url: 'https://sellercentral.amazon.com/product-search/bulk?private=1' });
  const result = await query.capture(123);
  assert.equal(result.safety.reason, 'URL_ALLOWED');
  assert.equal(result.safety.exactUrl, false);
  assert.equal(result.screenshotStatus, 'BLOCKED');
  assert.equal(query.state.scripts, 0);
  assert.equal(query.state.shots, 0);
  const missing = captureFixture({ url: '' });
  assert.equal((await missing.capture(123)).safety.reason, 'CURRENT_URL_UNAVAILABLE');
  assert.equal(missing.state.scripts, 0);
});

test('screenshot failure retains only the safe summary and never retries the capture', async () => {
  const f = captureFixture({ shotFails: true });
  const result = await f.capture(123);
  assert.equal(result.summary.status, 'AVAILABLE');
  assert.equal(result.screenshotStatus, 'FAILED');
  assert.equal(result.screenshotBase64, null);
  assert.equal(f.state.shots, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('invalid, noncanonical and oversized image data is refused', async () => {
  for (const image of ['not an image', 'Zh==', 'aGVsbG8=', 'AAAA=AAA', 'AAAA\n']) {
    const result = await captureFixture({ image }).capture(123);
    assert.equal(result.screenshotStatus, 'INVALID');
    assert.equal(result.screenshotBase64, null);
  }
  const result = await captureFixture({ image: 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4) }).capture(123);
  assert.equal(result.screenshotStatus, 'TOO_LARGE');
  assert.equal(result.screenshotBase64, null);
});

test('file traversal and per-input limits never produce a false complete summary', async () => {
  const incomplete = await captureFixture({ traversalComplete: false }).capture(123);
  assert.equal(incomplete.summary.status, 'UNAVAILABLE');
  assert.equal(incomplete.summary.inputCount, null);
  const tooMany = await captureFixture({ inputs: Array.from({ length: 33 }, () => fileInput()) }).capture(123);
  assert.equal(tooMany.summary.status, 'LIMIT_EXCEEDED');
  assert.equal(tooMany.summary.inputCount, 33);
  assert.equal(tooMany.summary.selectedFileCount, null);
  const detached = await captureFixture({ inputs: [{ ...fileInput(), isConnected: false }] }).capture(123);
  assert.equal(detached.summary.status, 'UNAVAILABLE');
  assert.equal(detached.summary.selectedFileCount, null);
});
