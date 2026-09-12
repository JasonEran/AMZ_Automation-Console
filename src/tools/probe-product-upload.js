#!/usr/bin/env node
import { PRODUCT_UPLOAD_PAGE } from '../lib/product-upload.js';
import { redactText } from '../lib/redact.js';
import { acquireRunLock, releaseRunLock } from '../checks/run.js';
import { refreshSelectedStores } from '../lib/config.js';

export async function runProductUploadProbe({ config, store, logger, zn }) {
  if (zn?.securityCapabilities?.officialZiniaoWebDriverHttp !== true) {
    throw new Error('商品上传页探针只允许使用紫鸟官方 WebDriver HTTP 传输层');
  }
  let storeId = null;
  let lease = null;
  try {
    lease = acquireRunLock({ outDir: config.outDir, label: `product-upload-probe:${store.key}` });
    [store] = refreshSelectedStores(config, [store]);
    const opened = await zn.storeOpen({
      name: store.name,
      id: store.id,
      market: store.market || 'US',
      url: PRODUCT_UPLOAD_PAGE,
      headless: false,
      privacy: false,
      timeoutMs: Math.max(120000, Number(config.ziniao?.openTimeoutMs || 180000)),
    });
    storeId = opened.storeId;
    const result = await zn.inspectProductBulkUploadPage(storeId);
    logger.info(`商品上传页只读探针通过：店铺=${store.key}，精确地址=${result.exactUrl}，唯一文件控件=${result.eligibleFileInputCount}`);
    return result;
  } catch (error) {
    logger.error(`商品上传页只读探针失败：${redactText(error?.message || error)}`);
    throw error;
  } finally {
    if (storeId) {
      try { await zn.storeClose(storeId); } catch (error) {
        logger.warn(`商品上传页探针关闭店铺会话失败：${redactText(error?.message || error)}`);
      }
    }
    if (lease) releaseRunLock(lease);
  }
}
