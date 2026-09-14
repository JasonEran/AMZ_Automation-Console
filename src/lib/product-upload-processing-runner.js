import { readEffectiveStores } from './config.js';
import { PRODUCT_UPLOAD_PAGE, productUploadStoreMatches } from './product-upload.js';
import {
  beginProductUploadProcessing,
  finishProductUploadProcessing,
  getProductUploadProcessingSettings,
  nextProductUploadProcessingJob,
} from './product-upload-processing.js';
import { saveProductUploadReport } from './product-upload-report.js';

/** Called only while the upload worker holds the collector's shared run lease.
 * This path never selects files, submits uploads or sends notifications. */
export async function processProductUploadResults({ config, stores, logger, zn }) {
  const settings = getProductUploadProcessingSettings(config);
  if (!settings.enabled) return { code: 0, processed: false, reason: 'results-disabled' };
  if (typeof zn?.readProductUploadProcessing !== 'function') {
    return { code: 0, processed: false, reason: 'result-transport-unavailable' };
  }
  const next = nextProductUploadProcessingJob({ outDir: config.outDir, config });
  if (!next) return { code: 0, processed: false, reason: 'empty' };
  const attempt = beginProductUploadProcessing({ outDir: config.outDir, jobId: next.jobId });
  let storeId;
  try {
    if (config._storesPath) stores = readEffectiveStores(config);
    const store = stores.find(candidate => candidate.key === attempt.job.store.key);
    if (!productUploadStoreMatches(attempt.job, store)) {
      throw Object.assign(new Error('原上传店铺已停用或绑定改变'), { code: 'PROCESSING_STORE_CHANGED' });
    }
    const opened = await zn.storeOpen({
      name: store.name, id: store.id, market: store.market || attempt.job.store.market,
      url: PRODUCT_UPLOAD_PAGE, headless: false, privacy: false,
      timeoutMs: Math.max(120000, Number(config.ziniao?.openTimeoutMs || 180000)),
    });
    storeId = opened.storeId;
    const snapshot = await zn.readProductUploadProcessing(storeId, {
      batchId: attempt.binding.batchId,
      expectedFileName: `payload${attempt.job.file.extension}`,
      timeoutMs: settings.timeoutMs,
    });
    if (typeof zn.readProductUploadProcessingReport === 'function') {
      try {
        const report = await zn.readProductUploadProcessingReport(storeId, {
          batchId: attempt.binding.batchId, expectedFileName: `payload${attempt.job.file.extension}`,
          timeoutMs: settings.timeoutMs,
        });
        if (report) saveProductUploadReport({ outDir: config.outDir, jobId: next.jobId,
          attemptId: attempt.attemptId, buffer: report.buffer, extension: report.extension });
      } catch { logger?.warn?.('商品处理状态已核实，处理报告尚未取得；保留已有报告并允许稍后刷新'); }
    }
    finishProductUploadProcessing({ outDir: config.outDir, jobId: next.jobId,
      attemptId: attempt.attemptId, snapshot });
    return { code: 0, processed: true, kind: 'processing-result', jobId: next.jobId, processingStatus: snapshot.status };
  } catch (error) {
    // Only bounded codes leave the transport; error messages can contain
    // signed report URLs, account identifiers or the page's private content.
    const code = /^PROCESSING_[A-Z_]{1,69}$/.test(error?.code || '') ? error.code : 'PROCESSING_READ_FAILED';
    finishProductUploadProcessing({ outDir: config.outDir, jobId: next.jobId,
      attemptId: attempt.attemptId, errorCode: code });
    logger?.warn?.(`商品处理结果采集未完成：${code}`);
    return { code: 1, processed: true, kind: 'processing-result', jobId: next.jobId, errorCode: code };
  } finally {
    if (storeId) {
      try { await zn.storeClose(storeId); }
      catch { logger?.warn?.('商品结果采集后关闭店铺会话失败'); }
    }
  }
}
