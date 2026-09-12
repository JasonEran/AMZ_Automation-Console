import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactText, sanitizeForStorage, sanitizeUrl } from './redact.js';
import { bjDateKey, bjIso, sleep } from './time.js';

const ENTITY_CHECKS = new Set(['feedback', 'reviews', 'outlet', 'voc']);
const SELLERMAKING_PROFILE = 'sellermaking-readonly-v1';
const SELLERMAKING_COLUMNS = [
  'source_id', 'entity_type', 'check', 'shop_name', 'shop_key', 'marketplace_name',
  'date', 'sku', 'fnsku', 'asin', 'star', 'rating', 'comments', 'response', 'order_id',
  'request_date', 'return_reason', 'customer_issue', 'ncx_rate', 'cx_health',
  'disposition', 'requested_quantity', 'shipped_quantity', 'removal_fee', 'currency',
  'status', 'health_score', 'severity', 'is_normal', 'anomaly_reason', 'checked_at',
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }
}

function writeAtomic(file, value) {
  privateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}

function writeAtomicText(file, value) {
  privateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, String(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}

function safeFilePart(value, fallback = 'export') {
  return String(value || fallback).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160) || fallback;
}

function csvCell(value) {
  let text = value === null || value === undefined ? ''
    : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Amazon-controlled content must never become an executable spreadsheet
  // formula when an operator opens the compatibility export.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function readLedger(file) {
  if (!fs.existsSync(file)) return { version: 1, delivered: {} };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const valid = value && typeof value === 'object' && !Array.isArray(value)
      && value.version === 1
      && value.delivered && typeof value.delivered === 'object' && !Array.isArray(value.delivered);
    if (!valid) throw new Error('账本结构或版本无效');
    return value;
  } catch (error) {
    const failure = new Error(`CRM 幂等账本损坏，拒绝继续发送以防重复创建: ${redactText(error.message)}`);
    failure.code = 'CRM_LEDGER_CORRUPT';
    throw failure;
  }
}

function audit(file, record) {
  privateDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(sanitizeForStorage(record))}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}

function parentFields(payload, result) {
  const metrics = result.metrics || (result.ahrScore !== undefined ? {
    accountHealthRating: result.ahrScore,
    accountHealthRatingPrevious: result.ahrScorePrev,
    accountHealthRatingDelta: result.ahrDelta,
  } : {});
  return {
    source: 'singal-amz-guard', check: payload.check || result.check,
    runId: payload.runId || result.runId, slot: payload.slot || result.slot,
    checkedAt: result.checkedAt || payload.finishedAt || payload.startedAt,
    storeKey: result.storeKey || null, storeName: result.storeName || null,
    market: result.market || null, status: result.status || result.policyCompliance || null,
    severity: result.severity || null,
    isNormal: result.ok !== undefined ? Boolean(result.ok) : Boolean(result.isNormal),
    metrics, anomalyReasons: result.anomalyReasons || [],
  };
}

function identitySeed(record, item) {
  const intrinsicVocId = item?.entityType === 'voc-record'
    ? item?.identifier || item?.recordId || item?.returnId
    : null;
  if (intrinsicVocId !== null && intrinsicVocId !== undefined && String(intrinsicVocId).trim()) {
    return `voc-record-id:${String(intrinsicVocId).trim().toLowerCase()}`;
  }
  const explicit = item?.stableKey || item?.itemKey || item?.uniqueKey || item?.activityId ||
    item?.feedbackId || item?.reviewId || item?.returnId || item?.recordId;
  if (explicit) return String(explicit);
  const parts = [item?.asin, item?.sku, item?.relatedId, item?.orderId, item?.date, item?.time,
    item?.rating, item?.title, item?.reason, item?.returnReason, item?.customerIssue]
    .filter((value) => value !== null && value !== undefined && value !== '');
  if (parts.length) return parts.join('|');
  const date = String(record.checkedAt || '').slice(0, 10);
  return `${date}|${record.slot || 'adhoc'}|${record.status || 'UNKNOWN'}`;
}

function structuredItems(check, source) {
  if (check !== 'voc') return Array.isArray(source.items) && source.items.length ? source.items : [null];
  const expanded = [];
  for (const item of Array.isArray(source.items) ? source.items : []) {
    const { records, ...asinSummary } = item || {};
    expanded.push({ ...asinSummary, entityType: 'voc-asin' });
    for (const event of Array.isArray(records) ? records : []) {
      expanded.push({
        ...event, entityType: 'voc-record', asin: item?.asin || null,
      });
    }
  }
  return expanded.length ? expanded : [null];
}

/** Convert a check summary into a minimal, structured CRM upsert envelope. */
export function buildCrmRecords(payload) {
  const out = [];
  for (const source of payload.records || []) {
    const parent = parentFields(payload, source);
    let items = [null];
    if (ENTITY_CHECKS.has(parent.check)) {
      items = structuredItems(parent.check, source);
    } else if (parent.check === 'asin-health' && source.asin) {
      items = [{ asin: source.asin, label: source.label || null, title: source.productTitle || null }];
    }
    for (const item of items) {
      const record = sanitizeForStorage({ ...parent, entity: item || undefined });
      const identity = identitySeed(record, item);
      // Upstream identifiers are not guaranteed to be globally unique (the
      // same reviewId can occur on two ASINs). Keep the owning entity in the
      // natural key even when an explicit ID is present.
      const entityScope = [item?.asin, item?.sku, item?.relatedId, item?.orderId]
        .filter((value) => value !== null && value !== undefined && value !== '')
        .map(String).join('|') || '-';
      const naturalKey = `${record.check}|${record.storeKey || '-'}|${record.market || '-'}|${entityScope}|${identity}`;
      // The external id is stable but opaque, so customer content is not copied
      // into headers, file names or the local ledger.
      record.idempotencyKey = `amzguard:${hash(naturalKey).slice(0, 40)}`;
      out.push(record);
    }
  }
  return out;
}

function sellerMakingRow(record) {
  const entity = record.entity || {};
  const metrics = record.metrics || {};
  const checkedAt = record.checkedAt || '';
  const comments = entity.comments || entity.summary || entity.title
    || entity.reason || entity.returnReason || entity.customerIssue || '';
  return {
    source_id: record.idempotencyKey,
    entity_type: entity.entityType || (entity.asin ? 'asin' : 'check-result'),
    check: record.check,
    shop_name: record.storeName || record.storeKey,
    shop_key: record.storeKey,
    marketplace_name: record.market,
    date: entity.date || entity.time || String(checkedAt).slice(0, 10),
    sku: entity.sku || entity.sellerSku || entity.msku || '',
    fnsku: entity.fnsku || entity.fnSku || '',
    asin: entity.asin || metrics.asin || '',
    star: entity.star ?? entity.rating ?? metrics.rating ?? '',
    rating: entity.reviewCount ?? entity.ratingCount ?? metrics.reviewCount ?? '',
    comments,
    response: entity.response || '',
    order_id: entity.orderId || entity.relatedId || '',
    request_date: entity.requestDate || entity.date || '',
    return_reason: entity.returnReason || entity.reason || '',
    customer_issue: entity.customerIssue || entity.customerProblem || '',
    ncx_rate: entity.ncxRatePct ?? entity.ncxRate ?? metrics.ncxRatePct ?? '',
    cx_health: entity.cxHealth || metrics.cxHealth || '',
    disposition: entity.disposition || '',
    requested_quantity: entity.requestedQuantity ?? '',
    shipped_quantity: entity.shippedQuantity ?? '',
    removal_fee: entity.removalFee ?? '',
    currency: entity.currency || '',
    status: record.status,
    health_score: metrics.accountHealthRating ?? metrics.healthScore ?? '',
    severity: record.severity,
    is_normal: record.isNormal ? 1 : 0,
    anomaly_reason: (record.anomalyReasons || []).join('；'),
    checked_at: checkedAt,
  };
}

/**
 * Produce a stable, local-only CSV aligned with the read-only SellerMaking
 * screens inspected on 2026-08-28 (shop health, Feedback, review and removal
 * fields). This is an exchange file, not an undocumented API write. Network
 * delivery remains disabled until the CRM owner provides a documented HTTPS
 * import endpoint and idempotency contract.
 */
export function writeCrmCompatibilityExport({ outDir, payload }) {
  const records = buildCrmRecords(payload);
  const rows = records.map(sellerMakingRow);
  const date = bjDateKey(new Date(payload.finishedAt || payload.startedAt || Date.now()));
  const dir = path.join(outDir, 'channels', 'crm-export', date);
  const base = `${safeFilePart(payload.check)}_${safeFilePart(payload.runId)}`;
  const csvFile = path.join(dir, `${base}.csv`);
  const manifestFile = path.join(dir, `${base}.manifest.json`);
  const csv = `\uFEFF${[
    SELLERMAKING_COLUMNS.join(','),
    ...rows.map((row) => SELLERMAKING_COLUMNS.map((column) => csvCell(row[column])).join(',')),
  ].join('\n')}\n`;
  writeAtomicText(csvFile, csv);
  writeAtomic(manifestFile, {
    profile: SELLERMAKING_PROFILE,
    mode: 'local-export-only',
    source: 'singal-amz-guard',
    check: payload.check || null,
    runId: payload.runId || null,
    generatedAt: bjIso(),
    records: rows.length,
    columns: SELLERMAKING_COLUMNS,
  });
  const auditFile = path.join(outDir, 'channels', 'crm-export', `${date}.jsonl`);
  audit(auditFile, {
    at: bjIso(), event: 'compatibility-export', profile: SELLERMAKING_PROFILE,
    check: payload.check || null, runId: payload.runId || null, records: rows.length, ok: true,
  });
  return {
    ok: true,
    profile: SELLERMAKING_PROFILE,
    records: rows.length,
    files: {
      csv: path.relative(outDir, csvFile),
      manifest: path.relative(outDir, manifestFile),
    },
  };
}

export function validateCrmConfig(config) {
  const cfg = config.crm || {};
  if (!cfg.enabled) return { ok: false, enabled: false, reason: 'CRM 推送未启用' };
  if (!cfg.endpoint) return { ok: false, enabled: true, reason: 'endpoint 未配置' };
  try {
    const endpoint = new URL(cfg.endpoint);
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') {
      return { ok: false, enabled: true, reason: 'CRM endpoint 必须使用 HTTPS（本机回环测试除外）' };
    }
  } catch {
    return { ok: false, enabled: true, reason: 'CRM endpoint 不是合法 URL' };
  }
  return { ok: true, enabled: true, endpoint: sanitizeUrl(cfg.endpoint) };
}

/**
 * Send only new or changed business rows. A successful row hash is persisted;
 * retry attempts reuse the exact same Idempotency-Key. Audit files contain no
 * response body, authorization header, endpoint query or raw evidence.
 */
async function pushToCrmInternal({ config, logger, payload, dryRun = false }, channelState) {
  const cfg = config.crm || {};
  const compatibilityExport = writeCrmCompatibilityExport({ outDir: config.outDir, payload });
  const valid = validateCrmConfig(config);
  if (!valid.ok) return {
    attempted: false, ok: false, reason: valid.reason, compatibilityExport,
  };

  const channelDir = path.join(config.outDir, 'channels', 'crm');
  const ledgerFile = path.join(channelDir, 'ledger.json');
  const auditFile = path.join(channelDir, `${bjDateKey()}.jsonl`);
  const ledger = readLedger(ledgerFile);
  const all = buildCrmRecords(payload);
  const pending = all.filter((record) => ledger.delivered[record.idempotencyKey]?.hash !== hash(record));

  if (dryRun) {
    const result = { attempted: false, ok: true, dryRun: true, records: all.length, pending: pending.length };
    audit(auditFile, { at: bjIso(), event: 'dry-run', endpoint: valid.endpoint, ...result });
    return { ...result, compatibilityExport };
  }
  if (!pending.length) {
    const result = { attempted: true, ok: true, duplicateSuppressed: all.length, records: 0 };
    audit(auditFile, { at: bjIso(), event: 'deduplicated', endpoint: valid.endpoint, ...result });
    return { ...result, compatibilityExport };
  }

  const envelope = {
    source: 'singal-amz-guard', operation: 'upsert', check: payload.check,
    runId: payload.runId, sentAt: bjIso(), records: pending,
  };
  const batchKey = `amzguard-batch:${hash(pending.map((record) => [record.idempotencyKey, hash(record)]).sort()).slice(0, 40)}`;
  const retries = Math.max(0, Number(cfg.retries ?? 2));
  const attempts = [];

  for (let index = 0; index <= retries; index++) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Number(cfg.timeoutMs || 30000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let attempt;
    try {
      channelState.networkAttempted = true;
      const response = await fetch(cfg.endpoint, {
        method: cfg.method || 'POST',
        headers: {
          'Content-Type': 'application/json', ...(cfg.headers || {}),
          'Idempotency-Key': batchKey,
        },
        body: JSON.stringify(envelope), signal: controller.signal,
      });
      // Consume, but never persist or log, a possibly sensitive response body.
      await response.arrayBuffer().catch(() => new ArrayBuffer(0));
      attempt = { attempt: index + 1, status: response.status, ok: response.ok };
      attempts.push(attempt);
      audit(auditFile, {
        at: bjIso(), event: 'attempt', endpoint: valid.endpoint, check: payload.check,
        runId: payload.runId, batchKey, recordCount: pending.length, ...attempt,
      });
      if (response.ok) {
        for (const record of pending) {
          ledger.delivered[record.idempotencyKey] = {
            hash: hash(record), deliveredAt: bjIso(), check: record.check,
          };
        }
        writeAtomic(ledgerFile, ledger);
        logger.info(`CRM 幂等导入成功：${pending.length} 条 (HTTP ${response.status})`);
        return { attempted: true, ok: true, status: response.status, records: pending.length,
          duplicateSuppressed: all.length - pending.length, attempts, batchKey, compatibilityExport };
      }
      logger.warn(`CRM 导入失败 (HTTP ${response.status})，第 ${index + 1}/${retries + 1} 次`);
    } catch (error) {
      const message = error.name === 'AbortError'
        ? `timeout ${timeoutMs}ms`
        : redactText(String(error.message || error));
      attempt = { attempt: index + 1, ok: false, errorClass: error.name || 'Error', error: message.slice(0, 180) };
      attempts.push(attempt);
      audit(auditFile, {
        at: bjIso(), event: 'attempt', endpoint: valid.endpoint, check: payload.check,
        runId: payload.runId, batchKey, recordCount: pending.length, ...attempt,
      });
      logger.warn(`CRM 导入异常: ${message}，第 ${index + 1}/${retries + 1} 次`);
    } finally {
      clearTimeout(timer);
    }
    if (index < retries) await sleep(2000 * (index + 1));
  }

  return { attempted: true, ok: false, records: pending.length,
    duplicateSuppressed: all.length - pending.length, attempts, batchKey, compatibilityExport };
}

export async function pushToCrm(args) {
  const channelState = { networkAttempted: false };
  try {
    return await pushToCrmInternal(args, channelState);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.crmNetworkAttempted = channelState.networkAttempted;
    throw failure;
  }
}

/**
 * Keep channel storage/audit failures separate from the business collection.
 * A corrupt ledger remains fail-closed inside pushToCrm; this wrapper only
 * turns that exception into a reportable channel result so the batch can
 * persist its primary report and continue with the next check.
 */
export async function pushToCrmSafely(args) {
  try {
    return await pushToCrm(args);
  } catch (error) {
    const networkAttempted = error?.crmNetworkAttempted === true;
    const message = redactText(String(error?.message || error || 'unknown CRM channel failure')).slice(0, 240);
    const ledgerCorrupt = error?.code === 'CRM_LEDGER_CORRUPT';
    args?.logger?.error?.(`CRM 通道故障，主报告继续落盘: ${message}`);
    return {
      attempted: networkAttempted,
      ok: false,
      channelFailure: true,
      channelStatus: 'ERROR',
      deliveryState: networkAttempted ? 'UNKNOWN' : 'NOT_ATTEMPTED',
      errorCode: ledgerCorrupt ? 'CRM_LEDGER_CORRUPT' : 'CRM_CHANNEL_IO_ERROR',
      requiresOperatorAction: true,
      reason: `CRM 通道故障: ${message}`,
    };
  }
}
