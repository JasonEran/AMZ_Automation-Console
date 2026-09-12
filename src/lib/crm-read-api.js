import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CHECKS } from '../checks/registry.js';
import { DASHBOARD_HISTORY_DEFAULTS, validHistoryDate } from './dashboard-history.js';
import { actionStateFor } from './dashboard-status.js';
import { redactText } from './redact.js';
import { bjDateKey } from './time.js';

// This API reads saved reports only. Authentication belongs to the HTTP host;
// an omitted store allowlist deliberately grants access to no stores.
const PREFIX = '/api/crm/v1';
const CHECK_BY_ID = new Map(CHECKS.map(check => [check.id, check]));
const RANK = { OK: 0, WARN: 1, CRITICAL: 2, ERROR: 3 };
const PRIVATE_KEY = /^(?:author|buyer|buyerName|customerName|reviewer|reviewerName|contactName|email|phone|telephone|mobile|address|shippingAddress|billingAddress)$/i;
const SECRET_KEY = /password|passwd|secret|token|authorization|cookie|browseroauth|browserid|storeid|profileid|otp|verificationcode/i;
const COLLECTION_FAILURE = new Set(['ERROR', 'UNKNOWN', 'PARTIAL_EVIDENCE', 'LOGIN_REQUIRED', 'BLOCKED',
  'NOT_CONFIGURED', 'UNKNOWN_RATING', 'REVIEW_OWNERSHIP_UNKNOWN', 'DETAIL_ERROR']);
const NORMAL_STATUSES = {
  'store-health': ['HEALTHY'], performance: ['CLEAR'], feedback: ['CLEAR'],
  reviews: ['CLEAR', 'RECORDED_LOW_REVIEW'], 'asin-health': ['OK', 'INACTIVE_LISTING'],
  outlet: ['NO_CHANGE'], voc: ['EMPTY', 'REGISTERED', 'RECORDED_BUSINESS_EVENT'],
  'ads-status': ['ALL_OFF', 'ALL_ON', 'MAJORITY_OFF', 'MAJORITY_ON', 'ADS_OBSERVED', 'INFO'], inbox: ['CLEAR'],
};
const METRIC_KEYS = new Set(`
  date lowCount todayTotal historicalIgnoredCount amazonFulfillmentExcludedLowCount
  domAmazonFulfillmentExcludedLowCount textAmazonFulfillmentExcludedLowCount
  amazonFulfillmentExclusionEvidenceAgree unknownDateLowCount businessStatus collectionStatus
  total average confirmedEmpty bothRatingEvidence sameDayCountsAgree structuredCount structuredComplete
  redWarnings redTotal badSections textWarnings nonzeroViolationSignals domNonzeroViolationSignals
  textNonzeroViolationSignals domComplete textComplete normalEvidenceComplete domZeroNormalSignals
  textZeroNormalSignals domHealthyNormalSignals textHealthyNormalSignals domMetricSignals textMetricSignals
  activeBusinessEventCount lowCount ownedLowCount brandLowCount excludedOtherStoreCount
  ownershipPendingCount excludedOutOfScopeCount ownershipPendingAsins ownershipInventoryCount
  ownershipFiltered ownershipReady ownershipComplete ownershipSource newLowCount recordedLowCount
  dealCount newCount baseline confirmedZero evidenceComplete evidenceConflict domActivity textActivity
  textActivityReliable businessEvidenceCount domReportedTotal textReportedTotal reportedTotalsAgree
  reportedTotalGrowth textCountCorroboratesDom domReportedTotalReliable textReportedTotalReliable
  ignoredFilterControlCount ambiguousActionCount duplicateActionCount scanComplete paginationComplete
  asinCount poorCount poorAsins abnormalTrendCount registered detailFailures headerMappingIncomplete
  listCoverageIncomplete headerMappedRowCount headerMappingCompleteRowCount newBusinessEventCount
  recordedBusinessEventCount enabled paused expected nameContains nameFilterVerified stateSource
  domEnabled domPaused domTotal textEnabled textPaused textTotal domReliable textReliable aggregateSource
  aggregateTotalAdjusted domCountConflict textCountConflict countConflict sourceTotalConflict
  sourceStateConflict domRawTotal textRawTotal enabledFilter pausedFilter enabledSweepComplete
  pausedSweepComplete enabledExists pausedZero zeroEnabledSources source portfolioCount campaignCount
  enabledDomPositive enabledTextPositive enabledDomEmpty enabledTextEmpty pausedDomPositive
  pausedTextPositive pausedDomEmpty pausedTextEmpty
  excluded limited unknown majorityRule matching matchingPercent exceptionCount recordedExceptionCount
  opened hasCart rating domRating textRating ratingConflict prevRating ratingDelta prevRatingDate
  reviewCount domReviewCount textReviewCount unavailable pageNotFound listingActive listingState
  listingStateConflict scopedUnavailableCorroborated checkSkipped accountHealthRating
  accountHealthRatingPrevious accountHealthRatingDelta
`.trim().split(/\s+/));
const INBOX_NUMBERS = new Set(`unreadCount domUnreadCount textUnreadCount todayUnreadCount
  domNeedsResponseRows textNeedsResponsePhrases domDeclaredUnread textDeclaredUnread badgeCount
  totalRows textRows boldRowCount visibleFrameCount`.split(/\s+/));
const INBOX_FLAGS = new Set(`countsAgree markerVocabulary frameContentReadable responseNeededFilter
  textFilterCorroborated listOutsideMainDocument textChromeOnly confirmedEmpty paginationComplete`.split(/\s+/));
const ITEM_KEYS = new Set(`asin parentAsin childAsin brand title summary date identifier source
  rating stars reviewId feedbackId orderId recordId returnId sku sellerSku fnsku msku offerId relatedId
  ownership ownershipAsin ownershipSource sharedOwnership isNew type key category count text
  cxHealth ncxRatePct ncxOrders totalOrders returnRatePct returnReasons customerIssues updatedAt
  abnormalTrend detailComplete detailStatus returnReason customerIssue reason requestDate
  disposition requestedQuantity shippedQuantity removalFee currency response
  portfolioId portfolioName portfolioStatus campaignId campaignName campaignStatus toggle effective
  state name id delivery statusText`.trim().split(/\s+/));
const COVERAGE_KEYS = new Set('complete total rowCount asinCount pagesRead pageSize'.split(' '));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const normalizedTime = value => validTime(value) ? new Date(value).toISOString() : null;
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'UNKNOWN';
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

class ApiError extends Error {
  constructor(status, errorCode, message) { super(message); this.status = status; this.code = errorCode; }
}
function fail(status, errorCode, message) { throw new ApiError(status, errorCode, message); }

function privateValues(value, found = new Set(), privateBranch = false) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, '');
    const hidden = privateBranch || PRIVATE_KEY.test(normalized) || SECRET_KEY.test(normalized);
    if (hidden && typeof child === 'string' && child.trim()) found.add(child.trim());
    else if (child && typeof child === 'object') privateValues(child, found, hidden);
  }
  return found;
}

// Free text remains business text, never raw DOM/page text. Explicit identity
// fields are dropped; their values are also removed from allowed summaries.
function cleanText(value, privateStrings = new Set()) {
  let text = redactText(value);
  for (const secret of [...privateStrings].sort((a, b) => b.length - a.length)) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), '[REDACTED_PERSONAL_DATA]');
  }
  return text
    .replace(/\b(?:review\s+by|reviewer|buyer\s+name|customer\s+name|author)\s*[:=]?\s*[^\n,;]{1,120}?(?=\s+on\s+|[\n,;]|$)/gi, '[REDACTED_PERSONAL_DATA]')
    .replace(/\b(?:phone|telephone|mobile|tel)\s*[:=]\s*\+?[\d ()-]{7,30}/gi, '[REDACTED_PHONE]');
}

function scalarOrList(value, secrets) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finite(value);
  if (typeof value === 'string') return cleanText(value, secrets);
  if (Array.isArray(value)) return value.filter(item => item === null || ['boolean', 'number', 'string'].includes(typeof item))
    .map(item => scalarOrList(item, secrets));
  return undefined;
}

function projectedMetrics(result, checkId, secrets) {
  const source = isObject(result.metrics) ? result.metrics : {};
  const output = {};
  if (checkId === 'inbox') {
    for (const key of INBOX_NUMBERS) if (Object.hasOwn(source, key)) output[key] = finite(source[key]);
    for (const key of INBOX_FLAGS) if (typeof source[key] === 'boolean') output[key] = source[key];
    for (const key of ['date', 'oldestUnreadAt']) if (validHistoryDate(source[key])) output[key] = source[key];
    for (const key of ['businessStatus', 'collectionStatus']) if (Object.hasOwn(source, key)) output[key] = code(source[key]);
    return output;
  }
  for (const key of METRIC_KEYS) if (Object.hasOwn(source, key)) {
    const value = scalarOrList(source[key], secrets);
    if (value !== undefined) output[key] = value;
  }
  if (isObject(source.listCoverage)) {
    output.listCoverage = {};
    for (const key of COVERAGE_KEYS) if (Object.hasOwn(source.listCoverage, key)) {
      const value = source.listCoverage[key];
      if (typeof value === 'boolean' || finite(value) !== null) output.listCoverage[key] = value;
    }
  }
  return output;
}

function projectedItem(item, secrets) {
  const output = {};
  if (!isObject(item)) return output;
  for (const key of ITEM_KEYS) if (Object.hasOwn(item, key)) {
    const value = scalarOrList(item[key], secrets);
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function evidenceSummary(result) {
  const output = {};
  for (const route of ['dom', 'text']) {
    const value = result.evidence?.[route];
    const part = { available: Boolean(isObject(value) && Object.keys(value).length && !Object.hasOwn(value, 'error')) };
    if (part.available) {
      for (const key of ['landed', 'reliable', 'pageConfirmed', 'cardFound', 'complete', 'pageComplete', 'looksLikeLogin', 'looksBlocked']) {
        if (typeof value[key] === 'boolean') part[key] = value[key];
      }
      if (Object.hasOwn(value, 'status')) part.status = code(value.status);
      for (const key of ['total', 'lowCount', 'rowCount', 'rating', 'score', 'enabled', 'paused']) {
        if (Object.hasOwn(value, key)) part[key] = finite(value[key]);
      }
    }
    output[route] = part;
  }
  output.bothAvailable = output.dom.available && output.text.available;
  return output;
}

function reportClock(report, mtimeMs) {
  for (const field of ['finishedAt', 'startedAt', '_ingestedAt']) {
    if (validTime(report[field])) return { time: Date.parse(report[field]), timeSource: `report.${field}` };
  }
  return { time: mtimeMs, timeSource: 'file.mtime' };
}

// readCheckHistory collapses duplicate IDs before returning them. The external
// API must detect conflicting copies first, so it uses this bounded directory
// scope and retains each immutable report's digest. Symlinks are never followed.
function loadReports(outDir, checkId, nowMs) {
  const dir = path.join(outDir, checkId), candidates = [];
  const visit = current => {
    let entries;
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) candidates.push(file);
    }
  };
  visit(dir);
  const byRun = new Map();
  let ignoredReports = 0;
  for (const file of candidates) {
    let report, stat, fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      stat = fs.fstatSync(fd);
      if (!stat.isFile()) { ignoredReports++; continue; }
      try { report = JSON.parse(fs.readFileSync(fd, 'utf8')); }
      catch (error) { if (error instanceof SyntaxError) { ignoredReports++; continue; } throw error; }
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes(error.code)) { ignoredReports++; continue; }
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (!isObject(report) || (report.check !== undefined && report.check !== checkId)
      || (!report.skipped && !Array.isArray(report.results))
      || (report.results !== undefined && (!Array.isArray(report.results)
        || !report.results.every(isObject)))) { ignoredReports++; continue; }
    const clock = reportClock(report, stat.mtimeMs);
    if (!Number.isFinite(clock.time) || clock.time <= 0
      || clock.time > nowMs + DASHBOARD_HISTORY_DEFAULTS.futureToleranceMs) { ignoredReports++; continue; }
    const originalId = typeof report.runId === 'string' && report.runId.length > 0 ? report.runId : null;
    const publicId = originalId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/.test(originalId);
    const runId = publicId ? originalId : originalId ? `opaque:${digest(originalId)}` : `legacy:${digest(path.relative(outDir, file))}`;
    const candidate = { report, runId, runIdSource: publicId ? 'report' : originalId ? 'opaque-report-id' : 'legacy-report',
      snapshotId: digest(report), ...clock, conflicts: [] };
    const previous = byRun.get(runId);
    if (!previous) byRun.set(runId, candidate);
    else if (previous.snapshotId !== candidate.snapshotId) previous.conflicts.push(candidate);
  }
  return { entries: [...byRun.values()].sort((a, b) => a.time - b.time || a.runId.localeCompare(b.runId)), ignoredReports };
}

const storeResults = (entry, storeKey) => (entry.report.results || []).filter(result => (result.storeKey || result.storeName) === storeKey);
const touchesStore = (entry, storeKey) => storeResults(entry, storeKey).length > 0
  || entry.conflicts.some(copy => storeResults(copy, storeKey).length > 0);
function resultTime(result, entry) {
  return validTime(result.checkedAt)
    ? { time: Date.parse(result.checkedAt), timeSource: 'result.checkedAt' }
    : { time: entry.time, timeSource: entry.timeSource };
}

function sourceOf(result, entry, nowMs, staleAfterMs) {
  const clock = resultTime(result, entry);
  const future = clock.time > nowMs + DASHBOARD_HISTORY_DEFAULTS.futureToleranceMs;
  return { runId: entry.runId, runIdSource: entry.runIdSource, snapshotId: entry.snapshotId,
    slot: typeof entry.report.slot === 'string' && /^[a-z0-9_-]{1,60}$/i.test(entry.report.slot) ? entry.report.slot : null,
    collectedAt: new Date(clock.time).toISOString(), checkedAt: normalizedTime(result.checkedAt),
    timeSource: clock.timeSource, collectionDate: bjDateKey(new Date(clock.time)),
    reportStartedAt: normalizedTime(entry.report.startedAt), reportFinishedAt: normalizedTime(entry.report.finishedAt),
    timestampValid: !future, ageMs: Math.max(0, nowMs - clock.time),
    stale: future || nowMs - clock.time > staleAfterMs };
}

function resultProjection(result, entry, checkId, storeKey, nowMs, staleAfterMs, secrets) {
  const source = sourceOf(result, entry, nowMs, staleAfterMs);
  const metrics = projectedMetrics(result, checkId, secrets);
  const status = code(result.status || result.policyCompliance);
  const recordedSeverity = Object.hasOwn(RANK, result.severity) ? result.severity : null;
  const recordedOk = typeof result.ok === 'boolean' ? result.ok : null;
  const evidence = evidenceSummary(result);
  const historicalPerformanceEvent = checkId === 'performance' && status === 'RECORDED_PERFORMANCE_EVENT';
  const confirmedInactive = checkId === 'asin-health' && status === 'INACTIVE_LISTING'
    && metrics.listingActive === false && metrics.collectionStatus === 'COMPLETE';
  const conflict = result.confidence === 'conflict' || ['ratingConflict', 'evidenceConflict', 'countConflict', 'listingStateConflict',
    'sourceStateConflict', 'sourceTotalConflict', 'domCountConflict', 'textCountConflict']
    .some(key => metrics[key] === true);
  const collectionNeedsReview = COLLECTION_FAILURE.has(status) || COLLECTION_FAILURE.has(metrics.collectionStatus)
    || conflict || !source.timestampValid
    || (recordedSeverity === 'OK' && !historicalPerformanceEvent && !NORMAL_STATUSES[checkId].includes(status))
    || ((recordedOk === true || recordedSeverity === 'OK') && (!evidence.bothAvailable || [evidence.dom, evidence.text]
      .some(part => part.reliable === false || (part.landed === false && !confirmedInactive) || part.looksLikeLogin || part.looksBlocked)));
  const severity = collectionNeedsReview ? 'ERROR' : historicalPerformanceEvent ? 'CRITICAL' : recordedSeverity || 'ERROR';
  const ok = collectionNeedsReview || historicalPerformanceEvent ? false : recordedOk;
  const output = { checkId, storeKey, market: /^[A-Z]{2,3}$/.test(result.market || '') ? result.market : null,
    asin: checkId !== 'inbox' && /^[A-Z0-9]{10}$/.test(result.asin || '') ? result.asin : null,
    status, severity, recordedSeverity, ok, recordedOk,
    presentationAdjusted: severity !== recordedSeverity || ok !== recordedOk,
    businessStatus: code(metrics.businessStatus), collectionStatus: code(metrics.collectionStatus),
    confidence: ['high', 'medium', 'low', 'conflict'].includes(result.confidence) ? result.confidence : null,
    verdictSource: typeof result.verdictSource === 'string' && /^[a-z0-9_+.-]{1,60}$/i.test(result.verdictSource) ? result.verdictSource : null,
    metrics, source, evidence,
    actionState: actionStateFor({ state: severity, stale: source.stale }) };
  if (checkId !== 'inbox') {
    output.reasons = Array.isArray(result.anomalyReasons) ? result.anomalyReasons.filter(value => typeof value === 'string').map(value => cleanText(value, secrets)) : [];
    output.notes = Array.isArray(result.notes) ? result.notes.filter(value => typeof value === 'string').map(value => cleanText(value, secrets)) : [];
    for (const field of ['ahrScore', 'ahrScorePrev', 'ahrScoreMax', 'ahrDelta', 'durationMs', 'attempts']) {
      if (Object.hasOwn(result, field)) output[field] = finite(result[field]);
    }
    for (const field of ['label', 'productTitle']) if (typeof result[field] === 'string') output[field] = cleanText(result[field], secrets);
    if (Object.hasOwn(result, 'statusPrev')) output.statusPrev = result.statusPrev === null ? null : code(result.statusPrev);
    if (typeof result.statusChanged === 'boolean') output.statusChanged = result.statusChanged;
    if (typeof result.baselineEligible === 'boolean') output.baselineEligible = result.baselineEligible;
  }
  return output;
}

// Mirrors the dashboard's per-store selection but keeps provenance attached to
// every result. A targeted ASIN recovery must not relabel its siblings' runs.
function latestResults(entries, storeKey, checkId) {
  let selected = [];
  for (const entry of entries) {
    const rows = storeResults(entry, storeKey).map(result => ({ result, entry }));
    if (!rows.length) continue;
    if (entry.conflicts.length) fail(409, 'REPORT_CONFLICT', 'Saved copies of a run disagree.');
    if (checkId !== 'asin-health') {
      const currentTime = Math.max(...rows.map(row => resultTime(row.result, entry).time));
      const previousTime = selected.length ? Math.max(...selected.map(row => resultTime(row.result, row.entry).time)) : -Infinity;
      if (currentTime >= previousTime) selected = rows;
      continue;
    }
    const marker = entry.report.selection?.targeted;
    const targeted = marker === true || (marker === undefined && rows.length === 1 && selected.length > 1);
    const key = row => `${String(row.result.market || 'US').toUpperCase()}:${String(row.result.asin || '').toUpperCase()}`;
    const merged = new Map(targeted ? selected.map(row => [key(row), row]) : []);
    for (const row of rows) {
      const prior = merged.get(key(row));
      if (!prior || resultTime(row.result, row.entry).time >= resultTime(prior.result, prior.entry).time) merged.set(key(row), row);
    }
    if (!targeted) {
      const started = validTime(entry.report.startedAt) ? Date.parse(entry.report.startedAt) : entry.time;
      for (const prior of selected) {
        const current = merged.get(key(prior));
        const time = resultTime(prior.result, prior.entry).time;
        if ((current && time > resultTime(current.result, current.entry).time) || (!current && time > started)) merged.set(key(prior), prior);
      }
    }
    selected = [...merged.values()];
  }
  return selected;
}

function pagesOfReview(item, result) {
  const id = item?.reviewId || item?.identifier;
  if (typeof id !== 'string' || !id) return [];
  return (Array.isArray(result.evidence?.dom?.pages) ? result.evidence.dom.pages : [])
    .filter(page => isObject(page) && Array.isArray(page.reviewIds) && page.reviewIds.includes(id))
    .map(page => ({ page: Number.isSafeInteger(page.page) && page.page > 0 ? page.page : null,
      pages: Number.isSafeInteger(page.pages) && page.pages > 0 ? page.pages : null,
      capturedAt: normalizedTime(page.capturedAt) }));
}

function expandedRecords(results, checkId) {
  const rows = [];
  results.forEach((result, resultIndex) => {
    const items = Array.isArray(result.items) ? result.items : [];
    if (checkId === 'inbox' || !items.length) {
      rows.push({ result, resultIndex, item: null, recordType: 'check-result' });
      return;
    }
    items.forEach((item, itemIndex) => {
      rows.push({ result, resultIndex, item, itemIndex,
        recordType: checkId === 'voc' ? 'voc-asin' : 'business-item' });
      if (checkId === 'voc' && Array.isArray(item?.records)) item.records.forEach((record, recordIndex) => {
        rows.push({ result, resultIndex, item: record, itemIndex, recordIndex,
          parentAsin: item.asin || null, recordType: 'voc-record' });
      });
    });
  });
  return rows;
}

function pagination(total, page, pageSize) {
  return { page, pageSize, total, pages: Math.ceil(total / pageSize), hasMore: page * pageSize < total };
}
function query(url, allowed) {
  const values = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(values, key)) fail(400, 'INVALID_QUERY', 'Unknown or repeated query parameter.');
    values[key] = value;
  }
  return values;
}
function positiveInteger(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) fail(400, 'INVALID_QUERY', 'Invalid page or pageSize.');
  return Number(value);
}

export function createCrmReadApi({ outDir, stores = [], allowedStoreKeys = [], now = () => new Date(),
  staleAfterMs = DASHBOARD_HISTORY_DEFAULTS.staleAfterMs } = {}) {
  if (typeof outDir !== 'string' || !outDir) throw new TypeError('outDir is required');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new TypeError('staleAfterMs must be positive');
  const allowed = new Set(allowedStoreKeys);
  const directory = new Map(stores.filter(store => typeof store.key === 'string' && store.key && store.enabled !== false
    && allowed.has(store.key)).map(store => [store.key, { storeKey: store.key,
    storeName: redactText(store.name || store.key), market: typeof store.market === 'string' ? redactText(store.market) : null }]));

  return {
    handle(input) {
      const instant = typeof now === 'function' ? now() : now;
      const nowMs = instant instanceof Date ? instant.getTime() : Number(instant);
      if (!Number.isFinite(nowMs)) throw new TypeError('now must produce a valid time');
      const metadata = { generatedAt: new Date(nowMs).toISOString(), timezone: 'Asia/Shanghai', readOnly: true,
        dataSource: 'saved-reports', collectionTriggered: false, staleAfterMs,
        completeness: 'All valid saved records allowed by the public-field policy; not a claim of complete Amazon collection.',
        excluded: ['credentials', 'buyer-identity-and-contact', 'raw-page-content', 'internal-paths', 'screenshots', 'inbox-message-records'],
        ignoredReports: 0 };
      const respond = (data, page = null) => ({ status: 200, body: { data, pagination: page, metadata } });
      try {
        let url;
        try { url = input instanceof URL ? input : new URL(input, 'http://localhost'); }
        catch { fail(400, 'INVALID_URL', 'Invalid URL.'); }
        if (url.hash) fail(400, 'INVALID_URL', 'URL fragments are not accepted.');
        if (url.pathname === `${PREFIX}/stores`) {
          query(url, []);
          return respond([...directory.values()]);
        }
        const match = /^\/api\/crm\/v1\/stores\/([^/]+)\/(results|checks\/([^/]+)\/(runs|data))$/.exec(url.pathname);
        if (!match) fail(404, 'NOT_FOUND', 'Resource not found.');
        let storeKey, checkId;
        try { storeKey = decodeURIComponent(match[1]); checkId = match[3] ? decodeURIComponent(match[3]) : null; }
        catch { fail(400, 'INVALID_URL', 'Invalid path encoding.'); }
        if (!directory.has(storeKey)) fail(404, 'NOT_FOUND', 'Resource not found.');
        const route = match[2] === 'results' ? 'results' : match[4];
        if (checkId && !CHECK_BY_ID.has(checkId)) fail(404, 'NOT_FOUND', 'Resource not found.');
        const values = query(url, route === 'results' ? [] : route === 'runs'
          ? ['from', 'to', 'page', 'pageSize'] : ['runId', 'snapshotId', 'page', 'pageSize']);
        const load = id => {
          const history = loadReports(path.resolve(outDir), id, nowMs);
          metadata.ignoredReports += history.ignoredReports;
          return history.entries.filter(entry => touchesStore(entry, storeKey));
        };
        if (route === 'results') {
          const checks = CHECKS.map(check => {
            const entries = load(check.id);
            if (entries.some(entry => entry.conflicts.length)) fail(409, 'REPORT_CONFLICT', 'Saved copies of a run disagree.');
            const rows = latestResults(entries, storeKey, check.id).map(({ result, entry }) =>
              resultProjection(result, entry, check.id, storeKey, nowMs, staleAfterMs, privateValues(result)));
            const severity = rows.length ? rows.reduce((worst, row) => RANK[row.severity] > RANK[worst] ? row.severity : worst, 'OK') : null;
            return { checkId: check.id, checkNo: check.no, title: check.title,
              status: rows.length ? [...new Set(rows.map(row => row.status))] : ['NEVER_RUN'], severity,
              stale: rows.some(row => row.source.stale), resultCount: rows.length, results: rows };
          });
          return respond({ store: directory.get(storeKey), checks });
        }
        const page = positiveInteger(values.page, 1, 1000000), pageSize = positiveInteger(values.pageSize, 100, 200);
        const entries = load(checkId);
        if (route === 'runs') {
          for (const field of ['from', 'to']) if (values[field] !== undefined && !validHistoryDate(values[field])) fail(400, 'INVALID_QUERY', 'Invalid collection date.');
          if (values.from && values.to && values.from > values.to) fail(400, 'INVALID_QUERY', 'from must not be after to.');
          const runs = [];
          for (const entry of [...entries].reverse()) {
            if (entry.conflicts.length) fail(409, 'REPORT_CONFLICT', 'Saved copies of a run disagree.');
            const results = storeResults(entry, storeKey);
            const selected = results.filter(result => {
              const day = bjDateKey(new Date(resultTime(result, entry).time));
              return (!values.from || day >= values.from) && (!values.to || day <= values.to);
            });
            if (!selected.length) continue;
            runs.push({ runId: entry.runId, runIdSource: entry.runIdSource, snapshotId: entry.snapshotId,
              startedAt: normalizedTime(entry.report.startedAt), finishedAt: normalizedTime(entry.report.finishedAt),
              collectionDates: [...new Set(selected.map(result => bjDateKey(new Date(resultTime(result, entry).time))))].sort(),
              resultCount: results.length, matchingResultCount: selected.length,
              savedRecordCount: expandedRecords(results, checkId).length,
              statuses: [...new Set(selected.map(result => code(result.status || result.policyCompliance)))] });
          }
          metadata.dateFilterMeaning = 'Per-result collection date in Asia/Shanghai; not review publication date.';
          return respond(runs.slice((page - 1) * pageSize, page * pageSize), pagination(runs.length, page, pageSize));
        }
        if (!values.runId || values.runId.length > 300 || /[\x00-\x1f\x7f]/.test(values.runId)) fail(400, 'INVALID_QUERY', 'A saved runId is required.');
        if (values.snapshotId !== undefined && !/^[a-f0-9]{64}$/.test(values.snapshotId)) fail(400, 'INVALID_QUERY', 'Invalid snapshotId.');
        const entry = entries.find(row => row.runId === values.runId);
        if (!entry) fail(404, 'NOT_FOUND', 'Resource not found.');
        if (entry.conflicts.length) fail(409, 'REPORT_CONFLICT', 'Saved copies of a run disagree.');
        if (values.snapshotId && values.snapshotId !== entry.snapshotId) fail(409, 'SNAPSHOT_CHANGED', 'The saved run changed; restart pagination.');
        metadata.runId = entry.runId;
        metadata.runIdSource = entry.runIdSource;
        metadata.snapshotId = entry.snapshotId;
        metadata.paginationOrder = 'Saved result/item order; VOC ASIN followed by its saved records.';
        const results = storeResults(entry, storeKey), expanded = expandedRecords(results, checkId);
        const projections = new Map();
        const records = expanded.slice((page - 1) * pageSize, page * pageSize).map(row => {
          let cached = projections.get(row.resultIndex);
          if (!cached) {
            const secrets = privateValues(row.result);
            cached = { secrets, result: resultProjection(row.result, entry, checkId, storeKey, nowMs, staleAfterMs, secrets) };
            projections.set(row.resultIndex, cached);
          }
          const output = { recordType: row.recordType, resultIndex: row.resultIndex, result: cached.result };
          if (checkId !== 'inbox') {
            output.itemIndex = row.itemIndex ?? null;
            output.item = row.item ? projectedItem(row.item, cached.secrets) : null;
            if (row.recordType === 'voc-record') {
              output.recordIndex = row.recordIndex;
              output.parentAsin = /^[A-Z0-9]{10}$/.test(row.parentAsin || '') ? row.parentAsin : null;
            }
            if (checkId === 'reviews' && row.item) output.reviewPages = pagesOfReview(row.item, row.result);
          }
          return output;
        });
        return respond(records, pagination(expanded.length, page, pageSize));
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return { status: error.status, body: { data: null, pagination: null, metadata,
          error: { code: error.code, message: error.message } } };
      }
    },
  };
}
