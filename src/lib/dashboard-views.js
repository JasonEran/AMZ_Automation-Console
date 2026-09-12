/**
 * Read-only projections used by the seven dashboard work areas.
 *
 * This module deliberately consumes the already-public dashboard result model.
 * It does not read Amazon, CRM or configuration files and it never changes
 * monitoring scope. Unknown states rank as collection failures (fail closed).
 */

export const OPERATIONAL_VIEW_DEFINITIONS = Object.freeze([
  { id: 'overview', title: '巡检总览', checkIds: [] },
  { id: 'store-risk', title: '店铺风险', checkIds: ['store-health', 'performance'] },
  { id: 'customer-voice', title: '客户声音', checkIds: ['feedback', 'inbox', 'reviews', 'voc'] },
  { id: 'product-status', title: '商品状态', checkIds: ['asin-health', 'outlet'] },
  { id: 'ads-watch', title: '广告值守', checkIds: ['ads-status'] },
  { id: 'upload-center', title: '上传中心', checkIds: [] },
  { id: 'system-assurance', title: '系统保障', checkIds: [] },
]);

const RAW_RANK = {
  OK: 0,
  SKIPPED: 1,
  NEVER_RUN: 2,
  NOT_COVERED: 3,
  NOT_CONFIGURED: 4,
  WARN: 5,
  CRITICAL: 6,
  ERROR: 7,
};

const ACTION_RANK = { NORMAL: 0, PENDING: 1, COLLECTION: 2, BUSINESS: 3 };
const COLLECTION_STATUS = new Set([
  'ERROR', 'UNKNOWN', 'LOGIN_REQUIRED', 'BLOCKED', 'NOT_CONFIGURED',
  'PARTIAL_EVIDENCE', 'UNKNOWN_RATING',
]);
const UNAVAILABLE_STATUS = new Set(['PAGE_NOT_FOUND', 'UNAVAILABLE']);

function strictRawState(states) {
  if (!states?.length) return 'NEVER_RUN';
  return states.reduce((worst, state) => {
    const normalized = RAW_RANK[state] === undefined ? 'ERROR' : state;
    return RAW_RANK[normalized] > RAW_RANK[worst] ? normalized : worst;
  }, 'OK');
}

function strictActionState(states) {
  if (!states?.length) return 'PENDING';
  return states.reduce((worst, state) => {
    const normalized = ACTION_RANK[state] === undefined ? 'COLLECTION' : state;
    return ACTION_RANK[normalized] > ACTION_RANK[worst] ? normalized : worst;
  }, 'NORMAL');
}

function resultProjection(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  return {
    subject: result.subject || result.asin || result.storeKey || null,
    asin: result.asin || null,
    storeKey: result.storeKey || null,
    storeName: result.storeName || result.storeKey || null,
    market: result.market || null,
    status: result.status || 'UNKNOWN',
    severity: RAW_RANK[result.severity] === undefined ? 'ERROR' : result.severity,
    confidence: result.confidence || null,
    verdictSource: result.verdictSource || null,
    reasons: Array.isArray(result.reasons) ? result.reasons.slice(0, 20) : [],
    notes: Array.isArray(result.notes) ? result.notes.slice(0, 12) : [],
    metrics: result.metrics && typeof result.metrics === 'object' ? result.metrics : {},
    items: Array.isArray(result.items) ? result.items.slice(0, 500) : [],
    checkedAt: result.checkedAt || null,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
    screenshot: result.screenshot || null,
    screenshotMeta: result.screenshotMeta || null,
    reviewDates: result.reviewDates || null,
    reviewScreenshots: Array.isArray(result.reviewScreenshots) ? result.reviewScreenshots : [],
    evidence: result.evidence && typeof result.evidence === 'object' ? result.evidence : {},
  };
}

function cellProjection(check, cell) {
  const raw = RAW_RANK[cell?.state] === undefined ? 'ERROR' : cell.state;
  const action = ACTION_RANK[cell?.actionState] === undefined ? 'COLLECTION' : cell.actionState;
  return {
    checkId: check.id,
    checkNo: check.no,
    checkTitle: check.title,
    state: raw,
    stateLabel: cell?.stateLabel || raw,
    actionState: action,
    actionLabel: cell?.actionLabel || action,
    actionOwner: cell?.actionOwner || null,
    status: cell?.status || 'UNKNOWN',
    reasons: Array.isArray(cell?.reasons) ? cell.reasons.slice(0, 30) : [],
    lastRunAt: cell?.lastRunAt || null,
    durationMs: Number.isFinite(cell?.durationMs) ? cell.durationMs : null,
    stale: Boolean(cell?.stale),
    previous: cell?.previous || null,
    trend: Array.isArray(cell?.trend) ? cell.trend.slice(-10) : [],
    results: (cell?.results || []).map(resultProjection).filter(Boolean),
  };
}

function pageFromChecks(definition, stores, checkById) {
  const rows = (stores || []).map((store) => {
    const cells = definition.checkIds.map((checkId) => {
      const check = checkById.get(checkId) || { id: checkId, no: null, title: checkId };
      return cellProjection(check, store.cells?.[checkId]);
    });
    return {
      storeKey: store.key,
      storeName: store.name || store.key,
      market: store.market || null,
      state: strictRawState(cells.map((cell) => cell.state)),
      actionState: strictActionState(cells.map((cell) => cell.actionState)),
      checks: cells,
    };
  });
  const cells = rows.flatMap((row) => row.checks);
  return {
    id: definition.id,
    title: definition.title,
    readOnly: true,
    checkIds: [...definition.checkIds],
    state: strictRawState(cells.map((cell) => cell.state)),
    actionState: strictActionState(cells.map((cell) => cell.actionState)),
    summary: {
      stores: rows.length,
      cells: cells.length,
      normal: cells.filter((cell) => cell.actionState === 'NORMAL').length,
      business: cells.filter((cell) => cell.actionState === 'BUSINESS').length,
      collection: cells.filter((cell) => cell.actionState === 'COLLECTION').length,
      pending: cells.filter((cell) => cell.actionState === 'PENDING').length,
      stale: cells.filter((cell) => cell.stale).length,
    },
    stores: rows,
  };
}

function evidenceSourceUsable(source) {
  return source?.available === true
    && source.reliable !== false
    && source.looksLikeLogin !== true;
}

export function evidenceCompleteness(stores) {
  const rows = [];
  for (const store of stores || []) {
    for (const [checkId, cell] of Object.entries(store.cells || {})) {
      for (const result of cell.results || []) {
        const dom = evidenceSourceUsable(result.evidence?.dom);
        const text = evidenceSourceUsable(result.evidence?.text);
        rows.push({
          storeKey: store.key,
          checkId,
          subject: result.subject || result.asin || store.key,
          status: result.status || 'UNKNOWN',
          severity: RAW_RANK[result.severity] === undefined ? 'ERROR' : result.severity,
          dom,
          text,
          complete: dom && text,
        });
      }
    }
  }
  const complete = rows.filter((row) => row.complete).length;
  const partial = rows.filter((row) => row.dom !== row.text).length;
  const missing = rows.filter((row) => !row.dom && !row.text).length;
  const normalWithoutDualEvidence = rows.filter((row) => row.severity === 'OK' && !row.complete).length;
  return {
    state: !rows.length ? 'NO_DATA' : partial || missing || normalWithoutDualEvidence ? 'ERROR' : 'OK',
    total: rows.length,
    complete,
    partial,
    missing,
    normalWithoutDualEvidence,
    percent: rows.length ? Math.round(complete * 100 / rows.length) : 0,
    gaps: rows.filter((row) => !row.complete).slice(0, 200),
  };
}

function overviewView(stores, checks, issues, summary) {
  return {
    id: 'overview',
    title: '巡检总览',
    readOnly: true,
    state: strictRawState((stores || []).map((store) => store.state)),
    actionState: strictActionState((stores || []).map((store) => store.actionState)),
    summary: summary || {},
    checks: (checks || []).map((check) => ({
      id: check.id,
      no: check.no,
      title: check.title,
      state: RAW_RANK[check.state] === undefined ? 'ERROR' : check.state,
      stateLabel: check.stateLabel || check.state || '未知',
      actionState: ACTION_RANK[check.actionState] === undefined ? 'COLLECTION' : check.actionState,
      actionLabel: check.actionLabel || check.actionState || '采集待修复',
      lastRunAt: check.lastRunAt || null,
      coverage: check.coverage || {},
    })),
    stores: (stores || []).map((store) => ({
      storeKey: store.key,
      storeName: store.name || store.key,
      market: store.market || null,
      state: RAW_RANK[store.state] === undefined ? 'ERROR' : store.state,
      actionState: ACTION_RANK[store.actionState] === undefined ? 'COLLECTION' : store.actionState,
      ok: Number(store.ok || 0),
      problem: Number(store.problem || 0),
      pending: Number(store.pending || 0),
    })),
    issues: (issues || []).slice(0, 100),
  };
}

export function operationalViewCatalog() {
  return OPERATIONAL_VIEW_DEFINITIONS.map((view) => ({
    id: view.id,
    title: view.title,
    checkIds: [...view.checkIds],
  }));
}

/** Build the complete server-side model for the seven work areas. */
export function buildOperationalViews({
  stores = [], checks = [], issues = [], summary = {}, sessionHealth = [], progress = {},
  readiness = {}, channels = [], alerts = [], monitoringRecommendations = [], upload = {},
} = {}) {
  const checkById = new Map(checks.map((check) => [check.id, check]));
  const views = new Map();
  views.set('overview', overviewView(stores, checks, issues, summary));
  for (const definition of OPERATIONAL_VIEW_DEFINITIONS.filter((view) => view.checkIds.length)) {
    const page = pageFromChecks(definition, stores, checkById);
    if (definition.id === 'product-status') {
      page.monitoringRecommendations = monitoringRecommendations;
    }
    views.set(definition.id, page);
  }
  views.set('upload-center', {
    id: 'upload-center',
    title: '上传中心',
    readOnly: false,
    enabled: Boolean(upload.enabled),
    authorized: Boolean(upload.authorized),
    api: '/api/product-uploads',
    writeBoundary: '仅逐任务预检、再认证和精确确认后允许通过紫鸟提交；未知结果禁止自动重试',
  });
  views.set('system-assurance', {
    id: 'system-assurance',
    title: '系统保障',
    readOnly: true,
    sessionHealth,
    progress,
    readiness,
    channels,
    evidence: evidenceCompleteness(stores),
    alerts: alerts.slice(0, 100),
  });
  return Object.fromEntries(views);
}

function asinIdentity(result) {
  const asin = String(result?.asin || '').trim().toUpperCase();
  const storeKey = String(result?.storeKey || result?.storeName || '').trim();
  const market = String(result?.market || 'US').trim().toUpperCase();
  if (!storeKey || !/^[A-Z0-9]{10}$/.test(asin)) return null;
  return `${storeKey}:${market}:${asin}`;
}

/**
 * Produce read-only monitoring suggestions from immutable ASIN report history.
 * The output intentionally has no "disable" action. Even a long absence streak
 * can only ask an operator to verify or consider a lower-frequency cadence.
 */
export function buildMonitoringRecommendations({ history = [], inventory = [], threshold = 3 } = {}) {
  const configured = new Map((inventory || []).flatMap((item) => {
    const key = asinIdentity(item);
    return key ? [[key, item]] : [];
  }));
  const observations = new Map();
  for (const entry of history || []) {
    const report = entry?.report || entry;
    const reportAt = report?.finishedAt || report?.startedAt || null;
    for (const result of report?.results || []) {
      const key = asinIdentity(result);
      if (!key) continue;
      if (!observations.has(key)) observations.set(key, []);
      observations.get(key).push({
        at: result.checkedAt || reportAt,
        status: result.status || 'UNKNOWN',
        severity: RAW_RANK[result.severity] === undefined ? 'ERROR' : result.severity,
        reason: (result.anomalyReasons || [])[0] || null,
        asin: String(result.asin).toUpperCase(),
        storeKey: result.storeKey || result.storeName,
        market: String(result.market || 'US').toUpperCase(),
      });
    }
  }

  const rows = [];
  for (const [key, values] of observations) {
    const ordered = values.sort((left, right) => {
      const a = Date.parse(left.at || '') || 0;
      const b = Date.parse(right.at || '') || 0;
      return a - b;
    });
    const latest = ordered.at(-1);
    let streak = 0;
    for (let index = ordered.length - 1; index >= 0; index--) {
      if (!UNAVAILABLE_STATUS.has(ordered[index].status)) break;
      streak++;
    }
    let previousAbsenceStreak = 0;
    if (latest.status === 'OK') {
      for (let index = ordered.length - 2; index >= 0; index--) {
        if (!UNAVAILABLE_STATUS.has(ordered[index].status)) break;
        previousAbsenceStreak++;
      }
    }
    const collectionFailure = latest.severity === 'ERROR' || COLLECTION_STATUS.has(latest.status);
    let recommendation = 'KEEP_DAILY';
    let reason = '继续按当前频率监测';
    if (collectionFailure) {
      recommendation = 'FIX_COLLECTION_FIRST';
      reason = '最新一次为采集故障或证据不足，不能据此调整监测范围';
    } else if (previousAbsenceStreak > 0) {
      recommendation = 'RECOVERED';
      reason = `商品在连续 ${previousAbsenceStreak} 次不可用后恢复，继续每日监测`;
    } else if (streak >= Math.max(2, Number(threshold) || 3)) {
      recommendation = 'MANUAL_VERIFY_OR_CONSIDER_WEEKLY';
      reason = `连续 ${streak} 次 ${latest.status}，建议人工核验 Seller Central 状态；确认长期停售后可考虑低频复核`;
    } else if (streak > 0) {
      reason = `已连续 ${streak} 次 ${latest.status}，证据不足以调整监测频率`;
    }
    const item = configured.get(key);
    rows.push({
      asin: latest.asin,
      storeKey: latest.storeKey,
      market: latest.market,
      currentMonitoring: item?.monitoring || 'unknown',
      latestStatus: latest.status,
      latestSeverity: latest.severity,
      latestCheckedAt: latest.at || null,
      consecutiveUnavailable: streak,
      recommendation,
      reason,
      readOnly: true,
      automaticChange: false,
    });
  }
  return rows.sort((left, right) =>
    left.storeKey.localeCompare(right.storeKey) || left.asin.localeCompare(right.asin));
}
