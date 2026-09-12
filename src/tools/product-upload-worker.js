#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAlerter } from '../lib/alert.js';
import { acquireRunLock, releaseRunLock } from '../checks/run.js';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/log.js';
import {
  PRODUCT_UPLOAD_PAGE,
  buildProductUploadResult,
  classifyProductUploadResult,
  clearProductUploadQueueMarker,
  listProductUploadJobs,
  payloadPathForJob,
  productUploadExecutionEnabled,
  recoverInterruptedProductUploads,
  transitionProductUpload,
} from '../lib/product-upload.js';
import { redactText, sanitizeUrl } from '../lib/redact.js';
import { bjDateKey, bjIso } from '../lib/time.js';
import { createZiniao } from '../lib/ziniao-factory.js';

process.umask(0o077);

function oldestQueued(outDir) {
  return listProductUploadJobs({ outDir, limit: 500 })
    .filter((job) => job.state === 'QUEUED')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
}

function scanFile(file) {
  const scanner = process.env.AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH || '/usr/bin/clamscan';
  const configuredAge = Number(process.env.AMZGUARD_PRODUCT_UPLOAD_SIGNATURE_MAX_AGE_DAYS || 7);
  if (!Number.isInteger(configuredAge) || configuredAge < 1 || configuredAge > 30) {
    const invalid = new Error('\u6587\u4ef6\u5b89\u5168\u626b\u63cf\u7b7e\u540d\u6700\u5927\u5e74\u9f84\u914d\u7f6e\u65e0\u6548\uff0c\u5df2\u6309\u5931\u8d25\u5173\u95ed\u5904\u7406');
    invalid.code = 'MALWARE_SIGNATURE_AGE_INVALID';
    return Promise.reject(invalid);
  }
  const maxAgeDays = configuredAge;
  return new Promise((resolve, reject) => {
    try {
      const signatures = fs.readdirSync('/var/lib/clamav')
        .filter((name) => /\.(?:cvd|cld)$/i.test(name))
        .map((name) => fs.statSync(path.join('/var/lib/clamav', name)).mtimeMs);
      const newest = signatures.length ? Math.max(...signatures) : 0;
      if (!newest || Date.now() - newest > maxAgeDays * 86_400_000) {
        const stale = new Error('\u6587\u4ef6\u5b89\u5168\u626b\u63cf\u7b7e\u540d\u7f3a\u5931\u6216\u8fc7\u671f\uff0c\u5df2\u6309\u5931\u8d25\u5173\u95ed\u5904\u7406');
        stale.code = 'MALWARE_SIGNATURES_STALE';
        reject(stale);
        return;
      }
    } catch {
      const unavailable = new Error('\u65e0\u6cd5\u9a8c\u8bc1\u6587\u4ef6\u5b89\u5168\u626b\u63cf\u7b7e\u540d\uff0c\u5df2\u6309\u5931\u8d25\u5173\u95ed\u5904\u7406');
      unavailable.code = 'MALWARE_SIGNATURES_UNAVAILABLE';
      reject(unavailable);
      return;
    }
    execFile(scanner, ['--no-summary', '--stdout', file], { timeout: 120000, maxBuffer: 1024 * 1024 }, (error) => {
      if (!error) return resolve(true);
      const failure = new Error(error.code === 1
        ? '\u6587\u4ef6\u5b89\u5168\u626b\u63cf\u53d1\u73b0\u5a01\u80c1\uff0c\u5df2\u963b\u65ad\u4e0a\u4f20'
        : '\u6587\u4ef6\u5b89\u5168\u626b\u63cf\u5668\u4e0d\u53ef\u7528\u6216\u6267\u884c\u5931\u8d25\uff0c\u5df2\u6309\u5931\u8d25\u5173\u95ed\u5904\u7406');
      failure.code = error.code === 1 ? 'MALWARE_DETECTED' : 'MALWARE_SCANNER_UNAVAILABLE';
      return reject(failure);
    });
  });
}

async function notifyResult({ config, logger, job }) {
  const presentation = {
    COMPLETED: { severity: 'OK', conclusion: '\u5df2\u88ab Amazon \u4e0a\u4f20\u7aef\u63a5\u6536\uff0c\u540e\u7eed\u5904\u7406\u7ed3\u679c\u4ee5 Seller Central \u5904\u7406\u62a5\u544a\u4e3a\u51c6' },
    REJECTED: { severity: 'CRITICAL', conclusion: 'Amazon \u660e\u786e\u62d2\u7edd\u672c\u6b21\u6587\u4ef6\uff0c\u9700\u4e1a\u52a1\u4fee\u6b63\u6587\u4ef6' },
    FAILED_BEFORE_SUBMIT: { severity: 'ERROR', conclusion: '\u63d0\u4ea4\u524d\u5931\u8d25\uff0cAmazon \u672a\u6267\u884c\u4e0a\u4f20\u70b9\u51fb' },
    UNKNOWN: { severity: 'WARN', conclusion: '\u7ed3\u679c\u65e0\u6cd5\u786e\u8ba4\uff0c\u4e3a\u9632\u6b62\u91cd\u590d\u521b\u5efa\u5df2\u505c\u6b62\u81ea\u52a8\u91cd\u8bd5' },
  }[job.state];
  if (!presentation) return null;
  const alerter = createAlerter({ config, logger, outDir: config.outDir });
  return alerter.send({
    severity: presentation.severity,
    title: `\u5546\u54c1\u6279\u91cf\u4e0a\u4f20 \u00b7 ${job.store.name}`,
    lines: [
      `\u5e97\u94fa\uff1a${job.store.name}\uff08${job.store.key}\uff09`,
      `\u7ed3\u679c\uff1a${presentation.conclusion}`,
      `\u6587\u4ef6\uff1a${job.file.extension} \u00b7 ${job.file.size} \u5b57\u8282 \u00b7 SHA-256 ${job.file.sha256.slice(0, 12)}`,
      `\u4efb\u52a1\uff1a${job.id}`,
      `\u65f6\u95f4\uff1a${job.finishedAt || job.updatedAt}`,
    ],
  });
}

export async function runProductUploadWorker({ config, stores, logger, zn: providedZiniao } = {}) {
  if (!productUploadExecutionEnabled()) {
    logger?.info?.('\u5546\u54c1\u6279\u91cf\u4e0a\u4f20\u6267\u884c\u5f00\u5173\u672a\u542f\u7528');
    return { code: 0, processed: false, reason: 'disabled' };
  }
  let lease;
  try {
    lease = acquireRunLock({ outDir: config.outDir, label: 'product-upload' });
  } catch (error) {
    if (error?.code === 'RUN_ALREADY_ACTIVE') {
      logger?.info?.('\u5f53\u524d\u6709\u5de1\u68c0\u8fd0\u884c\uff0c\u4e0a\u4f20\u4efb\u52a1\u4fdd\u7559\u961f\u5217\u7b49\u5f85\u4e0b\u6b21\u8c03\u5ea6');
      return { code: 0, processed: false, reason: 'collector-busy' };
    }
    throw error;
  }

  let job = null;
  let openedStoreId = null;
  let stateAtFailure = null;
  const zn = providedZiniao || createZiniao({ config, logger });
  try {
    recoverInterruptedProductUploads({ outDir: config.outDir });
    job = oldestQueued(config.outDir);
    if (!job) return { code: 0, processed: false, reason: 'empty' };
    const store = stores.find((candidate) => candidate.key === job.store.key && candidate.enabled !== false);
    if (!store) {
      const finishedAt = bjIso();
      job = transitionProductUpload({
        outDir: config.outDir, jobId: job.id, from: 'QUEUED', to: 'FAILED_BEFORE_SUBMIT',
        patch: {
          finishedAt,
          result: buildProductUploadResult({
            state: 'FAILED_BEFORE_SUBMIT', code: 'STORE_NOT_AVAILABLE', observedAt: finishedAt,
            message: '\u76ee\u6807\u5e97\u94fa\u4e0d\u5b58\u5728\u6216\u5df2\u505c\u7528',
          }),
        },
        auditEvent: 'failed-before-submit',
      });
      clearProductUploadQueueMarker({ outDir: config.outDir, jobId: job.id });
      await notifyResult({ config, logger, job });
      return { code: 2, processed: true, jobId: job.id, state: job.state };
    }

    job = transitionProductUpload({
      outDir: config.outDir, jobId: job.id, from: 'QUEUED', to: 'PROCESSING',
      patch: { startedAt: bjIso(), attempt: Number(job.attempt || 0) + 1, result: null },
      auditEvent: 'worker-started',
    });
    stateAtFailure = 'PROCESSING';
    const payloadFile = payloadPathForJob({ outDir: config.outDir, job });
    await scanFile(payloadFile);
    const opened = await zn.storeOpen({
      name: store.name, id: store.id, market: store.market || job.store.market,
      url: PRODUCT_UPLOAD_PAGE, headless: false, privacy: false,
      timeoutMs: Math.max(120000, Number(config.ziniao?.openTimeoutMs || 180000)),
    });
    openedStoreId = opened.storeId;
    // Sending a path to input[type=file] can itself trigger an upload on a
    // changed Amazon page. Persist the no-retry boundary before sendKeys.
    job = transitionProductUpload({
      outDir: config.outDir, jobId: job.id, from: 'PROCESSING', to: 'SUBMITTING',
      patch: { submittedAt: bjIso(), result: { code: 'SUBMIT_BOUNDARY_CROSSED' } },
      auditEvent: 'submit-boundary-crossed',
    });
    stateAtFailure = 'SUBMITTING';
    const writeAuthorization = {
      approved: true, action: 'product-bulk-upload', jobId: job.id, sha256: job.file.sha256,
    };
    await zn.prepareProductBulkUpload(openedStoreId, payloadFile, { authorization: writeAuthorization, timeoutMs: 45000 });
    const response = await zn.submitProductBulkUpload(openedStoreId, {
      authorization: writeAuthorization,
      timeoutMs: 120000,
    });
    const classified = classifyProductUploadResult(response.pageTextDelta);
    const finishedAt = bjIso();
    job = transitionProductUpload({
      outDir: config.outDir, jobId: job.id, from: 'SUBMITTING', to: classified.state,
      patch: {
        finishedAt,
        result: buildProductUploadResult({
          state: classified.state,
          code: classified.code,
          receiptStatus: classified.receiptStatus,
          processingStatus: classified.processingStatus,
          resultUrl: sanitizeUrl(response.currentUrl),
          observedAt: finishedAt,
        }),
      },
      auditEvent: classified.state === 'COMPLETED' ? 'amazon-accepted'
        : classified.state === 'REJECTED' ? 'amazon-rejected' : 'result-unconfirmed',
    });
    clearProductUploadQueueMarker({ outDir: config.outDir, jobId: job.id });
    await notifyResult({ config, logger, job });
    return { code: job.state === 'COMPLETED' ? 0 : job.state === 'REJECTED' ? 1 : 2, processed: true, jobId: job.id, state: job.state };
  } catch (error) {
    if (!job) throw error;
    const message = redactText(String(error?.message || error)).slice(0, 300);
    const afterBoundary = stateAtFailure === 'SUBMITTING' || job.state === 'SUBMITTING';
    try {
      const finishedAt = bjIso();
      const targetState = afterBoundary ? 'UNKNOWN' : 'FAILED_BEFORE_SUBMIT';
      job = transitionProductUpload({
        outDir: config.outDir, jobId: job.id,
        from: afterBoundary ? 'SUBMITTING' : ['QUEUED', 'PROCESSING', 'PREPARED'],
        to: targetState,
        patch: {
          finishedAt,
          result: buildProductUploadResult({
            state: targetState,
            code: afterBoundary ? 'SUBMISSION_OUTCOME_UNKNOWN' : 'FAILED_BEFORE_SUBMIT',
            message,
            observedAt: finishedAt,
          }),
        },
        auditEvent: afterBoundary ? 'result-unconfirmed' : 'failed-before-submit',
      });
      clearProductUploadQueueMarker({ outDir: config.outDir, jobId: job.id });
      await notifyResult({ config, logger, job });
    } catch (recordError) {
      logger?.error?.(`\u4e0a\u4f20\u5931\u8d25\u4e14\u65e0\u6cd5\u5b8c\u6210\u4efb\u52a1\u5ba1\u8ba1: ${redactText(recordError.message)}`);
    }
    return { code: 2, processed: true, jobId: job.id, state: job.state, error: message };
  } finally {
    if (openedStoreId) {
      try { await zn.storeClose(openedStoreId); } catch (error) { logger?.warn?.(`\u4e0a\u4f20\u540e\u5173\u95ed\u7d2b\u9e1f\u5e97\u94fa\u4f1a\u8bdd\u5931\u8d25: ${redactText(error.message)}`); }
    }
    releaseRunLock(lease);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { config, stores } = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    file: path.join(config.outDir, 'logs', `product-upload-${bjDateKey()}.log`),
  });
  runProductUploadWorker({ config, stores, logger }).then(async (result) => {
    await logger.close();
    process.exit(result.code ?? 2);
  }, async (error) => {
    logger.error(`\u5546\u54c1\u6279\u91cf\u4e0a\u4f20\u5de5\u4f5c\u8005\u81f4\u547d\u9519\u8bef: ${redactText(error?.stack || error)}`);
    await logger.close();
    process.exit(2);
  });
}
