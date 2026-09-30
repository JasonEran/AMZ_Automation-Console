import fs from 'node:fs';
import path from 'node:path';
import { CHECK_TOTAL } from '../checks/registry.js';
import { artifactPart } from './artifact-name.js';
import { createAlerter, partitionAlertProblems } from './alert.js';
import { pushToCrmSafely } from './crm.js';
import {
  SECURITY_CLEANUP_FAILED, cleanupFailureSafety, secureCleanupEvidenceSet,
  secureCleanupReportedEvidence, validateEvidenceArtifact,
} from './evidence-cleanup.js';
import { mapWithConcurrency } from './pool.js';
import {
  canRetryPageIdentity, classifyLivePageSafety, classifyPageSafety, classifyUrlSafety, currentPageUrl,
  isRecoverableBrowserInternalSafety, rawPageIdentity, verifyPageAfterScreenshot,
} from './page-safety.js';
import { reportDirs, writeGenericReports } from './report.js';
import { redactText, sanitizeForStorage, sanitizeUrl } from './redact.js';
import { createStateStore } from './state.js';
import { readCheckHistory } from './dashboard-history.js';
import { bjDateKey, bjIso, bjStamp, sleep } from './time.js';
import { isConfigMissingError, truncate } from './ziniao.js';
import { collectVocList, selectVocListPage, verifyVocListPage } from './voc-list-collector.js';

/**
 * Generic runner shared by checks 2-9, except the dedicated ASIN runner.
 *
 * Every check follows the same shape — open the store browser, land on one or
 * more Seller Central pages, extract the same facts two independent ways (DOM
 * and page text), judge, then report/alert/export. Only the extractor, the text
 * parser and the judgement differ, so those are the three things a check
 * definition supplies:
 *
 *   def.paths      : string[] | (store) => string[]
 *   def.extractor  : ASCII-only JS body run inside the page
 *   def.parseText  : (text, store) => object          // Node-side fallback
 *   def.judge      : ({dom, txt, prev, store}) => {status, ok, severity, reasons, metrics}
 *
 * The judgement contract mirrors item 1's rule and is the reason this is worth
 * centralising: a check that cannot read its page reports a problem rather than
 * quietly passing. `judge` is only called when at least one extraction path
 * produced something; otherwise the runner itself records UNKNOWN.
 */

export const SEVERITY_ORDER = { OK: 0, WARN: 1, CRITICAL: 2, ERROR: 3 };

const safeEvidenceUrl = sanitizeUrl;
const filePart = artifactPart;

const INVALID_BASELINE_STATUSES = new Set([
  'ERROR', 'UNKNOWN', 'LOGIN_REQUIRED', 'BLOCKED', 'NOT_CONFIGURED', 'PARTIAL_EVIDENCE', 'DETAIL_ERROR',
]);

function baselineEligible(result) {
  if (result.baselineEligible === false) return false;
  if (INVALID_BASELINE_STATUSES.has(result.status)) return false;
  return result.severity !== 'ERROR';
}

function resolvePaths(def, store, config) {
  const p = typeof def.paths === 'function' ? def.paths(store, config) : def.paths;
  return (p || []).map((x) => (x.startsWith('http') ? x : `https://${store.host || config.storeHealth.defaultHost}${x}`));
}

function resolveBootstrapPath(def, store, config, fallback) {
  const raw = typeof def.bootstrapPath === 'function'
    ? def.bootstrapPath(store, config)
    : def.bootstrapPath;
  if (!raw) return fallback;
  return raw.startsWith('http') ? raw : `https://${store.host || config.storeHealth.defaultHost}${raw}`;
}

export function advertisingSweepPlan(slot) {
  if (slot === 'ads-off') return ['ENABLED'];
  if (slot === 'ads-on') return ['ENABLED', 'PAUSED'];
  return [];
}

export async function selectAdvertisingCampaignStateResilient({
  zn, storeId, state, logger, storeKey = '', timeoutMs = 45000, retryDelayMs = 800,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await zn.selectAdvertisingCampaignState(storeId, state, { timeoutMs });
    } catch (error) {
      lastError = error;
      const transient = /stale element|not attached|detached|标签不可用|弹层缺少唯一|未观察到目标筛选生效/i
        .test(String(error?.message || error));
      if (!transient || attempt >= 2) break;
      logger?.warn?.(`[ads-status/${storeKey || 'store'}] Amazon Ads 状态筛选控件发生异步重绘，重新定位后重试`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

export async function waitForStablePageIdentity({
  zn, storeId, navigation = null, timeoutMs = 0, pollMs = 250,
}) {
  let current = await currentPageUrl(zn, storeId, navigation);
  if (!(Number(timeoutMs) > 0)) return current;
  let previousIdentity = rawPageIdentity(classifyUrlSafety(current));
  const deadline = Date.now() + Number(timeoutMs);
  do {
    await sleep(Math.max(50, Number(pollMs) || 250));
    const next = await currentPageUrl(zn, storeId);
    const nextSafety = classifyUrlSafety(next);
    if (!nextSafety.safe) return next;
    const nextIdentity = rawPageIdentity(nextSafety);
    if (nextIdentity && nextIdentity === previousIdentity) return next;
    current = next;
    previousIdentity = nextIdentity;
  } while (Date.now() < deadline);
  return current;
}

export function minimumReadyAgeSatisfied(def, readStartedAt, now = Date.now()) {
  const minimum = Math.max(0, Number(def?.readyMinWaitMs || 0));
  return Number(now) - Number(readStartedAt) >= minimum;
}

export function canRetryEvidenceIdentity(def, evidence, attempt = 0) {
  return canRetryPageIdentity(evidence?.liveSafety, attempt, def?.pageIdentityRetries);
}

async function readEvidenceWithIdentityRetry(args) {
  const { zn, storeId, def, store, logger } = args;
  let url = args.url;
  for (let attempt = 0; ; attempt++) {
    const evidence = await readEvidence({ ...args, url });
    if (!canRetryEvidenceIdentity(def, evidence, attempt)) return evidence;
    logger.warn(`[${def.id}/${store.key}] SPA 页面身份在读取期间变化，已丢弃本次证据；等待稳定后从零重试 (${attempt + 1}/${Number(def.pageIdentityRetries)})`);
    url = await waitForStablePageIdentity({
      zn, storeId,
      timeoutMs: Number(def.urlStabilizeMs || 0),
      pollMs: Number(def.urlStabilizePollMs || 250),
    });
  }
}

export function shouldRetryIncompletePage(def, probeResult, retryUsed = false) {
  const best = probeResult?.best;
  return def?.retryFreshSessionWhenNotReady === true
    && retryUsed !== true
    && best?.readWasLiveSafe === true
    && best?.landedBeforeSafety === true
    && (best?.safety?.safe === true || best?.safety?.code === 'ACCESS_BLOCKED')
    && best?.ready !== true;
}

async function readEvidence({ zn, storeId, def, store, config, logger, url, adsNameFilter = null }) {
  const z = config.ziniao;
  const readStartedAt = Date.now();
  const deadline = Date.now() + Math.max(0, Number(def.readyTimeoutMs || 0));
  const expectedSafety = classifyUrlSafety(url);
  const expectedRawUrl = rawPageIdentity(expectedSafety);
  let stableRawUrl = expectedRawUrl;
  let last = {
    dom: null, domError: null, txt: null, textError: null, pageText: '', ready: false,
    liveSafety: null,
  };
  const suppressForLiveSafety = (liveSafety, code = null) => ({
    dom: null, domError: null, txt: null, textError: null, pageText: '', ready: false,
    liveSafety: code ? { ...liveSafety, safe: false, code } : liveSafety,
  });
  do {
    const preLiveSafety = await classifyLivePageSafety({ zn, storeId });
    if (!preLiveSafety.safe) return suppressForLiveSafety(preLiveSafety);
    const preRawUrl = rawPageIdentity(preLiveSafety);
    if (!stableRawUrl) stableRawUrl = preRawUrl;
    if (!preRawUrl || preRawUrl !== stableRawUrl) {
      return suppressForLiveSafety(preLiveSafety, 'PAGE_CHANGED_BEFORE_EVIDENCE_READ');
    }
    let dom = null;
    let domError = null;
    if (def.extractor) {
      try {
        const r = await zn.execExtract(storeId, def.extractor, { timeoutMs: z.execTimeoutMs });
        dom = r.result;
        if (dom && adsNameFilter) dom.nameFilter = { ...adsNameFilter };
        if (dom?.url) dom.url = safeEvidenceUrl(dom.url);
        if (dom) dom._via = r.via;
      } catch (e) {
        domError = redactText(e.message);
      }
    }

    let pageText = '';
    let textError = null;
    try {
      const c = await zn.content(storeId, { format: 'text', timeoutMs: z.contentTimeoutMs });
      pageText = c.text || '';
    } catch (e) {
      textError = redactText(e.message);
    }
    const txt = pageText && def.parseText ? def.parseText(pageText, store, {
      url: safeEvidenceUrl(url), adsNameFilter,
    }) : null;
    const postLiveSafety = await classifyLivePageSafety({ zn, storeId });
    if (!postLiveSafety.safe) return suppressForLiveSafety(postLiveSafety);
    if (!rawPageIdentity(postLiveSafety) || rawPageIdentity(postLiveSafety) !== stableRawUrl) {
      return suppressForLiveSafety(postLiveSafety, 'PAGE_CHANGED_DURING_EVIDENCE_READ');
    }
    const rawReady = typeof def.ready !== 'function' || def.ready({ dom, txt, pageText, store, config });
    const ready = rawReady && minimumReadyAgeSatisfied(def, readStartedAt);
    last = { dom, domError, txt, textError, pageText, ready, liveSafety: postLiveSafety };
    if (ready || Date.now() >= deadline || !def.readyTimeoutMs) break;
    await sleep(Math.max(250, Number(def.readyPollMs || 1500)));
  } while (Date.now() < deadline);

  if (!last.ready && typeof def.ready === 'function') {
    last.dom ||= null;
    if (last.dom) {
      last.dom.notes ||= [];
      last.dom.notes.push(`dynamic data did not become ready within ${Number(def.readyTimeoutMs || 0)}ms`);
    }
    logger.warn(`[${def.id}] 异步内容等待超时，保留证据并按无法完整判定处理`);
  }
  return last;
}

async function collectAdvertisingStateSweep({
  zn, storeId, def, store, config, logger, initialEvidence, url, adsNameFilter,
}) {
  const cloneView = (view) => (view && typeof view === 'object' ? { ...view } : null);
  const sweepPlan = advertisingSweepPlan(config?._currentSlot);
  const initialKind = String(
    initialEvidence?.dom?.filterKind || initialEvidence?.txt?.filterKind
    || (initialEvidence?.dom?.enabledFilter || initialEvidence?.txt?.enabledFilter ? 'ENABLED' : '')
    || (initialEvidence?.dom?.pausedFilter || initialEvidence?.txt?.pausedFilter ? 'PAUSED' : ''),
  ).toUpperCase();
  let enabledEvidence = initialKind === 'ENABLED' ? initialEvidence : null;
  let pausedEvidence = initialKind === 'PAUSED' ? initialEvidence : null;
  try {
    if (initialKind !== 'ENABLED') {
      await selectAdvertisingCampaignStateResilient({
        zn, storeId, state: 'ENABLED', logger, storeKey: store.key,
      });
      if (typeof zn.verifyAdvertisingCampaignNameFilter !== 'function') throw new Error('广告名称筛选复核能力不可用');
      adsNameFilter = await zn.verifyAdvertisingCampaignNameFilter(storeId, adsNameFilter.keyword);
      await sleep(750);
      const enabledUrl = await currentPageUrl(zn, storeId);
      enabledEvidence = await readEvidence({
        zn, storeId, def, store, config, logger, url: enabledUrl, adsNameFilter,
      });
    }
    // At 11:20 the question is only whether any enabled campaign exists. The
    // exact Enabled filter's total is a full-set proof: zero means every
    // campaign is off; a positive count is immediately actionable. Walking
    // thousands of paused rows adds latency without adding evidence.
    if (sweepPlan.length === 1) {
      const enabledDom = cloneView(enabledEvidence?.dom);
      const enabledTxt = cloneView(enabledEvidence?.txt);
      return {
        ...enabledEvidence,
        dom: enabledDom ? {
          ...enabledDom,
          stateViews: { enabled: enabledDom, paused: null },
          stateSweepComplete: enabledEvidence?.ready === true,
        } : null,
        txt: enabledTxt ? {
          ...enabledTxt,
          stateViews: { enabled: enabledTxt, paused: null },
          stateSweepComplete: enabledEvidence?.ready === true,
        } : null,
        ready: enabledEvidence?.ready === true,
      };
    }
    await selectAdvertisingCampaignStateResilient({
      zn, storeId, state: 'PAUSED', logger, storeKey: store.key,
    });
    if (typeof zn.verifyAdvertisingCampaignNameFilter !== 'function') throw new Error('广告名称筛选复核能力不可用');
    adsNameFilter = await zn.verifyAdvertisingCampaignNameFilter(storeId, adsNameFilter.keyword);
    await sleep(750);
    const pausedUrl = await currentPageUrl(zn, storeId);
    pausedEvidence = await readEvidence({
      zn, storeId, def, store, config, logger, url: pausedUrl, adsNameFilter,
    });
    const enabledDom = cloneView(enabledEvidence?.dom);
    const enabledTxt = cloneView(enabledEvidence?.txt);
    const pausedDom = cloneView(pausedEvidence?.dom);
    const pausedTxt = cloneView(pausedEvidence?.txt);
    return {
      ...pausedEvidence,
      dom: pausedDom ? {
        ...pausedDom,
        stateViews: { enabled: enabledDom, paused: pausedDom },
        stateSweepComplete: enabledEvidence?.ready === true && pausedEvidence?.ready === true,
      } : null,
      txt: pausedTxt ? {
        ...pausedTxt,
        stateViews: { enabled: enabledTxt, paused: pausedTxt },
        stateSweepComplete: enabledEvidence?.ready === true && pausedEvidence?.ready === true,
      } : null,
      ready: enabledEvidence?.ready === true && pausedEvidence?.ready === true,
    };
  } catch (e) {
    const stateSweepError = redactText(e.message);
    logger.warn(`[${def.id}/${store.key}] Amazon Ads 只读状态双筛选未完成: ${stateSweepError}`);
    const baseEvidence = enabledEvidence || pausedEvidence || initialEvidence;
    const enabledDom = cloneView(enabledEvidence?.dom);
    const enabledTxt = cloneView(enabledEvidence?.txt);
    const pausedDom = cloneView(pausedEvidence?.dom);
    const pausedTxt = cloneView(pausedEvidence?.txt);
    return {
      ...baseEvidence,
      dom: (enabledDom || pausedDom) ? {
        ...(pausedDom || enabledDom),
        stateViews: { enabled: enabledDom, paused: pausedDom },
        stateSweepComplete: false,
        stateSweepError,
      } : null,
      txt: (enabledTxt || pausedTxt) ? {
        ...(pausedTxt || enabledTxt),
        stateViews: { enabled: enabledTxt, paused: pausedTxt },
        stateSweepComplete: false,
        stateSweepError,
      } : null,
      ready: false,
    };
  }
}

function safeVocDetailUrl(rawUrl, listUrl) {
  if (!rawUrl) return null;
  try {
    const base = new URL(listUrl);
    const target = new URL(rawUrl, base);
    if (target.origin !== base.origin) return null;
    if (!/voice|customer|experience|\bncx\b/i.test(`${target.pathname} ${target.search}`)) return null;
    if (/(?:\/dp\/|\/gp\/product\/)/i.test(target.pathname)) return null;
    return target.href;
  } catch {
    return null;
  }
}

export function isRecoverableVocRendererFailure(error) {
  return /(?:timed out receiving message from renderer|renderer[^\n]{0,80}timed out|chrome not reachable|disconnected from devtools|invalid session id)/i
    .test(String(error || ''));
}

export function isRecoverableVocDetailFailure(safety, error) {
  if (isRecoverableBrowserInternalSafety(safety)) return true;
  if (isRecoverableVocRendererFailure(error)) return true;
  // A safe Amazon URL with no bound ASIN/detail vocabulary is an asynchronous
  // empty shell, not a business finding. Retry it only through a fresh profile
  // and keep the same bounded per-ASIN budget used for renderer failures.
  return safety?.emptyShell === true
    && /(?:详情为空壳|未获得 DOM\+页面文本双路完整证据)/i.test(String(error || ''));
}

export function reusableVocDetailsFromReport(report, { storeKey, asins, dateKey } = {}) {
  const wanted = [...new Set((asins || []).map((asin) => String(asin || '').toUpperCase()))]
    .filter((asin) => /^B0[A-Z0-9]{8}$/.test(asin));
  if (!report || report.check !== 'voc' || !storeKey || !wanted.length) return new Map();
  const observedAt = report.finishedAt || report.startedAt;
  const observedDate = Number.isFinite(Date.parse(observedAt || ''))
    ? bjDateKey(new Date(observedAt)) : null;
  if (!observedDate || observedDate !== dateKey) return new Map();
  const result = (report.results || []).find((item) => item?.storeKey === storeKey);
  if (!result || result.metrics?.collectionStatus !== 'PARTIAL_EVIDENCE'
    || !(Number(result.metrics?.detailFailures) > 0)) return new Map();
  const priorRows = [...new Set((result.evidence?.dom?.rows || [])
    .map((row) => String(row?.asin || '').toUpperCase())
    .filter((asin) => /^B0[A-Z0-9]{8}$/.test(asin)))];
  if (priorRows.length !== wanted.length || !wanted.every((asin) => priorRows.includes(asin))) return new Map();
  const reusable = new Map();
  for (const detail of result.evidence?.dom?.details || []) {
    const asin = String(detail?.asin || '').toUpperCase();
    const complete = wanted.includes(asin)
      && !detail?.error
      && detail?.safety?.safe === true
      && detail?.safety?.code === 'BUSINESS_PAGE'
      && detail?.dom?.landed === true
      && detail?.dom?.asinBound === true
      && detail?.dom?.detailRootMatched === true
      && detail?.dom?.asin === asin
      && detail?.txt?.landed === true
      && detail?.txt?.asinBound === true
      && detail?.txt?.asin === asin;
    if (complete) reusable.set(asin, detail);
  }
  return reusable;
}

async function collectDetails({ zn, session, def, store, config, logger, listUrl, rows, dirs, stamp }) {
  const details = [];
  const diagnosticState = { attempted: false };
  const suppressForCleanupFailure = (detail, previousSafety) => {
    const failedSafety = cleanupFailureSafety(previousSafety);
    detail.dom = null;
    detail.txt = null;
    delete detail.domError;
    delete detail.textError;
    detail.safety = failedSafety;
    detail.error = 'VOC 详情截图证据安全清理失败，结果已阻断';
    detail.screenshot = null;
    detail.diagnostics ||= {};
    detail.diagnostics.cleanupCode = SECURITY_CLEANUP_FAILED;
  };
  const captureFirstFailure = async (detail) => {
    if (diagnosticState.attempted || !config.storeHealth.screenshot) return;
    diagnosticState.attempted = true;
    detail.diagnostics ||= {};
    const pre = await classifyLivePageSafety({ zn, storeId: session.storeId });
    detail.diagnostics.capturePreSafetyCode = pre.code;
    if (!pre.safe) return;
    const p = path.join(
      dirs.shots,
      `${filePart(def.id)}_detail_failure_${filePart(store.key)}_${filePart(detail.asin)}_${stamp}.png`,
    );
    let shot = null;
    let screenshotThrew = false;
    let cleanupFailure = null;
    try {
      shot = await zn.screenshot(session.storeId, p, { fullPage: false });
    } catch (e) {
      screenshotThrew = true;
      detail.diagnostics.captureError = redactText(e.message);
      const cleaned = secureCleanupEvidenceSet({ files: [p], outDir: config.outDir });
      if (!cleaned.ok) cleanupFailure = cleaned;
    }
    const post = await classifyLivePageSafety({ zn, storeId: session.storeId });
    const stable = post.safe && rawPageIdentity(post) === rawPageIdentity(pre);
    detail.diagnostics.capturePostSafetyCode = post.code;
    detail.diagnostics.captureUrlStable = stable;
    if (!stable) {
      const cleaned = screenshotThrew
        ? secureCleanupEvidenceSet({ files: [p], outDir: config.outDir })
        : secureCleanupReportedEvidence({
            expectedFile: p, reportedFile: shot?.path, outDir: config.outDir,
          });
      if (!cleaned.ok) cleanupFailure = cleaned;
      if (cleanupFailure) {
        suppressForCleanupFailure(detail, post);
        logger.error(`[${def.id}/${store.key}/${detail.asin}] 截图证据安全清理失败，结果已标记 ${SECURITY_CLEANUP_FAILED}`);
        return;
      }
      if (post.authSensitive || post.blocked) {
        detail.dom = null;
        detail.txt = null;
        delete detail.domError;
        delete detail.textError;
        detail.safety = post;
        detail.error = post.blocked
          ? 'VOC 详情诊断截图期间进入访问拦截，截图与页面证据已抑制'
          : 'VOC 详情诊断截图期间进入认证流程，截图与页面证据已抑制';
      }
      return;
    }
    if (!(
      shot?.path
      && path.resolve(String(shot.path)) === path.resolve(p)
      && validateEvidenceArtifact({ file: p, outDir: config.outDir }).ok
    )) {
      const cleaned = screenshotThrew
        ? secureCleanupEvidenceSet({ files: [p], outDir: config.outDir })
        : secureCleanupReportedEvidence({
            expectedFile: p, reportedFile: shot?.path, outDir: config.outDir,
          });
      if (!cleaned.ok) cleanupFailure = cleaned;
      if (cleanupFailure) {
        suppressForCleanupFailure(detail, post);
        logger.error(`[${def.id}/${store.key}/${detail.asin}] 截图证据安全清理失败，结果已标记 ${SECURITY_CLEANUP_FAILED}`);
      }
      return;
    }
    try { fs.chmodSync(p, 0o600); } catch { /* non-POSIX */ }
    const relative = path.relative(config.outDir, p).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../')) {
      const cleaned = secureCleanupEvidenceSet({ files: [p], outDir: config.outDir });
      if (!cleaned.ok) {
        suppressForCleanupFailure(detail, post);
        logger.error(`[${def.id}/${store.key}/${detail.asin}] 截图证据安全清理失败，结果已标记 ${SECURITY_CLEANUP_FAILED}`);
      }
      return;
    }
    detail.screenshot = relative;
  };
  const uniqueRows = [...new Map((rows || [])
    .filter((row) => /^B0[A-Z0-9]{8}$/.test(String(row?.asin || '')))
    .map((row) => [row.asin, row])).values()];
  let reusableDetails = new Map();
  for (const entry of [...readCheckHistory({ outDir: config.outDir, checkId: 'voc' })].reverse()) {
    reusableDetails = reusableVocDetailsFromReport(entry.report, {
      storeKey: store.key,
      asins: uniqueRows.map((row) => row.asin),
      dateKey: bjDateKey(),
    });
    if (reusableDetails.size) break;
  }
  if (reusableDetails.size) {
    logger.info(`[${def.id}/${store.key}] 同日部分报告续跑：复用 ${reusableDetails.size}/${uniqueRows.length} 条已保存双路完整详情，仅重试失败项`);
  }
  const maxDetailsPerSession = Math.max(1, Number(def.detailSessionMaxItems || 8));
  // A poisoned Chromium renderer can survive the first profile reopen while
  // the ZiNiao extension is restoring the marketplace tab. Keep retries
  // bounded by the configured limit (four fresh-session retries by default)
  // for each read-only VOC detail before failing closed. One bad
  // row cannot consume the retry budget of the remaining store.
  const retryCounts = new Map();
  const maxDetailRetries = Math.max(0, Number(def.detailMaxRetries ?? 4));
  const takeDetailRetry = (asin) => {
    const used = retryCounts.get(asin) || 0;
    if (used >= maxDetailRetries) return false;
    retryCounts.set(asin, used + 1);
    return true;
  };
  let sessionDetailAttempts = 0;
  const restartDetailSession = async (reason, nextIndex) => {
    try { await zn.releaseVocReadOnlyDetail?.(session.storeId); } catch { /* best effort before close */ }
    try { await zn.storeClose(session.storeId); } catch { /* poisoned session may already be gone */ }
    await sleep(Math.max(500, Number(def.detailRestartDelayMs || 2500)));
    const reopened = await zn.storeOpen({
      id: store.id || undefined,
      name: store.id ? undefined : store.name,
      market: store.market,
      url: listUrl,
      headless: config.ziniao.headless,
      timeoutMs: config.ziniao.openTimeoutMs,
    });
    session.storeId = reopened.storeId;
    sessionDetailAttempts = 0;
    const settleMs = Math.max(0, Math.min(2000, Number(def.settleMs || 0)));
    if (settleMs) await sleep(settleMs);
    // startBrowser may return before its requested Seller Central tab becomes
    // the active, readable document. Consuming a detail retry immediately at
    // that boundary produced false CURRENT_URL_UNAVAILABLE/list-identity
    // failures in production. Wait only for a stable, non-auth Amazon URL;
    // the normal per-row activation still owns all business DOM/text reads.
    const readyDeadline = Date.now() + Math.max(1000, Number(def.detailRestartReadyTimeoutMs || 20000));
    let listStable = false;
    do {
      let liveUrl = '';
      try { liveUrl = await currentPageUrl(zn, session.storeId); } catch { /* retry within deadline */ }
      const urlGate = classifyUrlSafety(liveUrl);
      if (urlGate.authSensitive || urlGate.blocked) {
        throw new Error('VOC 列表会话重启后进入认证/拦截页面，禁止普通重试');
      }
      if (urlGate.safe) {
        const liveGate = await classifyLivePageSafety({ zn, storeId: session.storeId });
        if (liveGate.authSensitive || liveGate.blocked) {
          throw new Error('VOC 列表会话重启后进入认证/拦截页面，禁止普通重试');
        }
        listStable = liveGate.safe === true
          && rawPageIdentity(liveGate) === rawPageIdentity(urlGate);
      }
      if (!listStable && Date.now() < readyDeadline) {
        await sleep(Math.max(100, Number(def.detailRestartReadyPollMs || 750)));
      }
    } while (!listStable && Date.now() < readyDeadline);
    if (!listStable) {
      logger.warn(`[${def.id}/${store.key}] 紫鸟店铺浏览器已重启，但 VOC 列表在等待窗口内尚未稳定`);
    }
    logger.info(`[${def.id}/${store.key}] ${reason}，继续读取第 ${nextIndex + 1}/${uniqueRows.length} 个 VOC 详情`);
  };
  for (let rowIndex = 0; rowIndex < uniqueRows.length; rowIndex++) {
    const row = uniqueRows[rowIndex];
    if (reusableDetails.has(row.asin)) {
      const prior = reusableDetails.get(row.asin);
      details.push(sanitizeForStorage({
        ...prior,
        diagnostics: { ...(prior.diagnostics || {}), resumedSameDayCompleteEvidence: true },
      }, { rootDir: config.outDir }));
      continue;
    }
    if (sessionDetailAttempts >= maxDetailsPerSession) {
      await restartDetailSession('已按详情数量上限轮换紫鸟店铺浏览器会话', rowIndex);
    }
    sessionDetailAttempts++;
    let listCurrentUrl = '';
    try {
      listCurrentUrl = await currentPageUrl(zn, session.storeId);
    } catch (e) {
      logger.warn(`[${def.id}/${store.key}/${row.asin}] 无法确认当前页面 URL: ${redactText(e.message)}`);
    }
    const listUrlGate = classifyUrlSafety(listCurrentUrl);
    let listLiveGate = null;
    if (listUrlGate.safe) listLiveGate = await classifyLivePageSafety({ zn, storeId: session.storeId });
    const listIdentityStable = listLiveGate?.safe === true
      && rawPageIdentity(listLiveGate) === rawPageIdentity(listUrlGate);
    if (!listUrlGate.safe || !listIdentityStable) {
      const blockedGate = !listUrlGate.safe
        ? listUrlGate
        : listLiveGate?.safe
          ? { ...listLiveGate, safe: false, code: 'VOC_LIST_CHANGED_BEFORE_DETAIL_ACTIVATION' }
          : listLiveGate;
      const failed = {
        asin: row.asin,
        url: blockedGate?.currentUrl || listUrlGate.currentUrl,
        dom: null,
        txt: null,
        safety: blockedGate || listUrlGate,
        error: blockedGate?.authSensitive || blockedGate?.blocked
          ? '认证/拦截页面禁止读取 VOC 详情'
          : '无法安全确认 VOC 列表当前页面身份，详情采集已阻断',
      };
      await captureFirstFailure(failed);
      try {
        await zn.releaseVocReadOnlyDetail?.(session.storeId);
      } catch (e) {
        failed.diagnostics = { releaseFailed: true };
        logger.warn(`[${def.id}/${store.key}/${row.asin}] VOC 详情预检失败后的标签页恢复失败: ${redactText(e.message)}`);
      }
      if (isRecoverableBrowserInternalSafety(failed.safety)) {
        const retry = takeDetailRetry(row.asin);
        await restartDetailSession('内部错误页后已重启紫鸟店铺浏览器', rowIndex);
        if (retry) {
          rowIndex--;
          continue;
        }
      }
      details.push(sanitizeForStorage(failed, { rootDir: config.outDir }));
      continue;
    }
    const rawUrl = safeVocDetailUrl(row.detailUrl, listUrl);
    let openedReadOnlyDetail = false;
    let openDiagnostics = null;
    if (!rawUrl && typeof zn.activateVocReadOnlyDetail === 'function') {
      try {
        const opened = await zn.activateVocReadOnlyDetail(session.storeId, row.asin, {
          timeoutMs: Math.max(5000, Number(def.detailOpenTimeoutMs || 30000)),
        });
        openedReadOnlyDetail = opened?.activated === true;
        openDiagnostics = {
          activated: openedReadOnlyDetail,
          transition: /^(?:new-tab|url|dialog|drawer|inline|none)$/.test(String(opened?.transition || ''))
            ? String(opened.transition) : 'none',
          openedNewTab: opened?.openedNewTab === true,
          rowFound: opened?.rowFound === true,
          controlFound: opened?.controlFound === true,
          candidateCount: Number.isFinite(Number(opened?.candidateCount)) ? Number(opened.candidateCount) : null,
          controlTag: /^[a-z0-9-]{1,32}$/.test(String(opened?.controlTag || ''))
            ? String(opened.controlTag) : null,
          hasHref: opened?.hasHref === true,
          clickMethod: /^(?:webdriver|webdriver-shadow)$/.test(String(opened?.clickMethod || ''))
            ? String(opened.clickMethod) : null,
          usedShadowButton: opened?.usedShadowButton === true,
          handleCountBefore: Number.isFinite(Number(opened?.handleCountBefore)) ? Number(opened.handleCountBefore) : null,
          handleCountAfter: Number.isFinite(Number(opened?.handleCountAfter)) ? Number(opened.handleCountAfter) : null,
        };
      } catch (e) {
        openDiagnostics = { activated: false, transition: 'none', transportError: redactText(e.message) };
        logger.warn(`[${def.id}/${store.key}/${row.asin}] WebDriver 只读详情激活失败: ${redactText(e.message)}`);
      }
    } else if (!rawUrl) {
      openDiagnostics = { activated: false, transition: 'none', capabilityUnavailable: true };
    }
    if (!rawUrl && !openedReadOnlyDetail) {
      const failed = {
        asin: row.asin, url: listUrlGate.currentUrl, dom: null, txt: null,
        error: typeof zn.activateVocReadOnlyDetail === 'function'
          ? 'VOC 只读详情控件未观察到安全实际转场'
          : '当前紫鸟传输层不支持严格 VOC 只读详情原生激活',
        diagnostics: { openedVia: 'none', open: openDiagnostics },
      };
      await captureFirstFailure(failed);
      try {
        await zn.releaseVocReadOnlyDetail?.(session.storeId);
      } catch (e) {
        failed.diagnostics = { ...failed.diagnostics, releaseFailed: true };
        logger.warn(`[${def.id}/${store.key}/${row.asin}] VOC 失败详情标签页恢复失败: ${redactText(e.message)}`);
      }
      details.push(sanitizeForStorage(failed, { rootDir: config.outDir }));
      // No detail transition was observed. The transport has already cleaned
      // up any unexpected tab and restored the origin page; navigating the SPA
      // again here can hand the Ziniao extension an unnecessary second load.
      // The next row's URL/live gate remains the fail-closed authority.
      continue;
    }
    const detail = {
      asin: row.asin, url: null, dom: null, txt: null, error: null, safety: null,
      screenshot: null,
      diagnostics: { openedVia: rawUrl ? 'href' : 'webdriver-readonly-control', open: openDiagnostics },
    };
    try {
      let navigation = null;
      if (rawUrl) {
        navigation = await zn.visit(session.storeId, rawUrl, {
          timeoutMs: Math.max(5000, Number(def.detailVisitTimeoutMs || 20000)),
          waitUntil: config.ziniao.waitUntil,
        });
      }
      const settleMs = Math.max(0, Number(def.detailSettleMs ?? 1000));
      if (settleMs) await sleep(settleMs);
      let actualUrl = await currentPageUrl(zn, session.storeId, navigation);
      let safety = classifyUrlSafety(actualUrl);
      detail.url = safety.currentUrl;
      detail.safety = safety;
      if (!safety.safe) {
        detail.error = safety.authSensitive
          ? 'VOC 详情跳转进入认证/拦截页面，证据已抑制'
          : 'VOC 详情导航后当前 URL 不可确认，证据已抑制';
      } else {
        const deadline = Date.now() + Math.max(0, Number(def.detailReadyTimeoutMs ?? 20000));
        let detailText = '';
        let detailTextScoped = false;
        let liveGateFailure = null;
        const detailScript = typeof def.detailExtractor === 'function'
          ? def.detailExtractor(row, store) : def.detailExtractor;
        do {
          const preReadSafety = await classifyLivePageSafety({ zn, storeId: session.storeId });
          if (!preReadSafety.safe) {
            liveGateFailure = preReadSafety;
            break;
          }
          try {
            const extracted = await zn.execExtract(session.storeId, detailScript, {
              timeoutMs: Math.max(5000, Number(def.detailExecTimeoutMs || 30000)),
            });
            detail.dom = extracted.result || null;
            if (detail.dom?.url) detail.dom.url = safeEvidenceUrl(detail.dom.url);
          } catch (e) {
            detail.domError = redactText(e.message);
          }
          detailText = '';
          detailTextScoped = false;
          try {
            actualUrl = await currentPageUrl(zn, session.storeId);
            if (typeof zn.vocReadOnlyDetailText === 'function') {
              const scoped = await zn.vocReadOnlyDetailText(session.storeId, row.asin);
              detailText = scoped?.text || '';
              detailTextScoped = scoped?.scoped === true;
            } else {
              detailText = (await zn.content(session.storeId, { format: 'text', timeoutMs: config.ziniao.contentTimeoutMs })).text || '';
            }
            detail.txt = def.detailParseText?.(detailText, row, store, {
              url: actualUrl, scoped: detailTextScoped,
            }) || null;
          } catch (e) {
            detail.textError = redactText(e.message);
          }
          const postReadSafety = await classifyLivePageSafety({ zn, storeId: session.storeId });
          if (!postReadSafety.safe || rawPageIdentity(postReadSafety) !== rawPageIdentity(preReadSafety)) {
            liveGateFailure = postReadSafety.safe
              ? { ...postReadSafety, safe: false, code: 'VOC_DETAIL_PAGE_CHANGED_DURING_READ' }
              : postReadSafety;
            break;
          }
          if (typeof def.detailReady !== 'function' || def.detailReady({ dom: detail.dom, txt: detail.txt, row })) break;
          if (Date.now() >= deadline) break;
          await sleep(Math.max(250, Number(def.detailReadyPollMs || 1500)));
        } while (Date.now() < deadline);
        if (liveGateFailure) {
          detail.dom = null;
          detail.txt = null;
          delete detail.domError;
          delete detail.textError;
          detail.safety = liveGateFailure;
          detail.url = liveGateFailure.currentUrl || detail.url;
          detail.diagnostics = { ...detail.diagnostics, liveSafetyCode: liveGateFailure.code || null };
          detail.error = liveGateFailure.authSensitive || liveGateFailure.blocked
            ? 'VOC 详情读取期间出现认证/拦截页面，DOM 与文本证据已抑制'
            : 'VOC 详情读取期间页面变化或安全探针不可用，DOM 与文本证据已抑制';
        } else {
          let finalLiveSafety = await classifyLivePageSafety({ zn, storeId: session.storeId });
          actualUrl = await currentPageUrl(zn, session.storeId);
          if (finalLiveSafety.safe && rawPageIdentity(finalLiveSafety) !== actualUrl) {
            finalLiveSafety = {
              ...finalLiveSafety, safe: false, code: 'VOC_DETAIL_PAGE_CHANGED_AFTER_READ',
              currentUrl: safeEvidenceUrl(actualUrl),
            };
          }
          const domLanded = detail.dom?.landed === true;
          const txtLanded = detail.txt?.landed === true;
          const domAsinMatches = detail.dom?.asinBound === true
            && detail.dom?.detailRootMatched === true && detail.dom?.asin === row.asin;
          const txtAsinMatches = detail.txt?.asinBound === true && detail.txt?.asin === row.asin;
          detail.diagnostics = {
            ...detail.diagnostics,
            urlChangedFromList: actualUrl !== listCurrentUrl,
            detailTextLength: detailText.length,
            detailTextScoped,
            domPageTextLength: Number.isFinite(Number(detail.dom?.pageTextLength))
              ? Number(detail.dom.pageTextLength) : null,
            domLanded,
            txtLanded,
            domAsinMatches,
            txtAsinMatches,
            visibleDialogCount: Number.isFinite(Number(detail.dom?.diagnostics?.visibleDialogCount))
              ? Number(detail.dom.diagnostics.visibleDialogCount) : null,
            visibleDrawerCount: Number.isFinite(Number(detail.dom?.diagnostics?.visibleDrawerCount))
              ? Number(detail.dom.diagnostics.visibleDrawerCount) : null,
            detailAsinCount: Number.isFinite(Number(detail.dom?.diagnostics?.detailAsinCount))
              ? Number(detail.dom.diagnostics.detailAsinCount) : null,
            detailRootMatched: detail.dom?.detailRootMatched === true,
            liveSafetyCode: finalLiveSafety.code || null,
          };
          safety = finalLiveSafety.safe
            ? classifyPageSafety({ currentUrl: actualUrl, dom: detail.dom, txt: detail.txt, pageText: detailText })
            : finalLiveSafety;
          detail.url = safety.currentUrl;
          detail.safety = safety;
          if (!safety.safe) {
            detail.dom = null;
            detail.txt = null;
            delete detail.domError;
            delete detail.textError;
            detail.error = safety.authSensitive
              ? 'VOC 详情为认证/拦截页面，DOM 与文本证据已抑制'
              : 'VOC 详情为空壳或无法确认，DOM 与文本证据已抑制';
          }
        }
      }
      const complete = typeof def.detailReady === 'function'
        ? def.detailReady({ dom: detail.dom, txt: detail.txt, row })
        : detail.dom?.landed === true && detail.txt?.landed === true;
      if (!complete && !detail.error) detail.error = 'VOC 详情未获得 DOM+页面文本双路完整证据';
    } catch (e) {
      detail.error = redactText(e.message);
    }
    if (detail.error) await captureFirstFailure(detail);
    let releasedNewTabToList = false;
    try {
      if (typeof zn.releaseVocReadOnlyDetail === 'function') {
        const released = await zn.releaseVocReadOnlyDetail(session.storeId);
        releasedNewTabToList = openDiagnostics?.transition === 'new-tab'
          && released?.closedNewTab === true;
      }
    } catch (e) {
      detail.error = `VOC 详情标签页生命周期恢复失败: ${redactText(e.message)}`;
      detail.dom = null;
      detail.txt = null;
      detail.diagnostics = { ...detail.diagnostics, releaseFailed: true };
      await captureFirstFailure(detail);
      logger.warn(`[${def.id}/${store.key}/${row.asin}] VOC 详情标签页恢复失败: ${redactText(e.message)}`);
    }
    const recoverableDetailFailure = isRecoverableVocDetailFailure(detail.safety, detail.error);
    if (recoverableDetailFailure) {
      const retry = takeDetailRetry(row.asin);
      await restartDetailSession('详情渲染器异常后已重启紫鸟店铺浏览器', rowIndex);
      if (retry) {
        rowIndex--;
        continue;
      }
    }
    details.push(sanitizeForStorage(detail, { rootDir: config.outDir }));
    if (releasedNewTabToList) continue;
    const nextRawUrl = safeVocDetailUrl(uniqueRows[rowIndex + 1]?.detailUrl, listUrl);
    if (rawUrl && nextRawUrl) {
      // All detail hrefs were captured from the already verified list. Walk a
      // contiguous href-backed sequence directly and return to the SPA once at
      // the end; reloading the list after every ASIN has caused the Ziniao
      // extension error page on large stores.
      continue;
    }
    try {
      await zn.visit(session.storeId, listUrl, {
        timeoutMs: config.ziniao.visitTimeoutMs,
        waitUntil: config.ziniao.waitUntil,
      });
      const listSettle = Math.max(0, Math.min(2000, Number(def.settleMs || 0)));
      if (listSettle) await sleep(listSettle);
    } catch (e) {
      logger.warn(`[${def.id}/${store.key}] 返回 VOC 列表失败，后续详情将明确记为失败: ${redactText(e.message)}`);
    }
  }
  return details;
}

/** Open the store, walk the candidate URLs, and read each landing page twice. */
async function probe({ zn, store, config, logger, def, dirs, stamp }) {
  const z = config.ziniao;
  const urls = resolvePaths(def, store, config);

  const opened = await zn.storeOpen({
    id: store.id || undefined,
    name: store.id ? undefined : store.name,
    market: store.market,
    // Amazon Ads may have an expired cross-service session even while Seller
    // Central can still be recovered by the approved Ziniao Passkey/OTP flow.
    // Bootstrap through Seller Central, then discover/follow Campaign Manager;
    // direct Ads URLs remain bounded fallbacks in `urls`.
    url: resolveBootstrapPath(def, store, config, urls[0]),
    headless: z.headless,
    timeoutMs: z.openTimeoutMs,
  });
  let storeId = opened.storeId;
  logger.info(`[${def.id}/${store.key}] 店铺浏览器已打开`);

  // A few Seller Central apps only render their list pane on a desktop-width
  // viewport. Widening the window is browser geometry, not an Amazon action.
  if (Number(def.minWindowWidth) > 0 && typeof zn.ensureWindowSize === 'function') {
    try {
      const sized = await zn.ensureWindowSize(storeId, {
        width: Number(def.minWindowWidth),
        height: Number(def.minWindowHeight || 1000),
      });
      if (sized?.changed) logger.info(`[${def.id}/${store.key}] 已放大店铺窗口至 ${sized.width}x${sized.height} 以渲染完整布局`);
    } catch (e) {
      logger.warn(`[${def.id}/${store.key}] 调整窗口尺寸失败，继续采集: ${redactText(e.message)}`);
    }
  }

  // From this point the native ZiNiao profile belongs to this probe.  If a
  // read-only UI preparation step (for example an Ads filter) throws before
  // `probe()` can return its storeId, the outer retry loop cannot otherwise
  // close that session.  Always compensate here so one failed page cannot
  // poison the next attempt or the next store.
  try {

  let discoveryUrl = '';
  try { discoveryUrl = await currentPageUrl(zn, storeId); } catch { /* fail closed below */ }
  const discoveryGate = classifyUrlSafety(discoveryUrl);
  let discoveryLiveGate = null;
  if (def.linkExtractor && discoveryGate.safe) {
    discoveryLiveGate = await classifyLivePageSafety({ zn, storeId });
  }
  const discoveryIdentityStable = discoveryLiveGate?.safe === true
    && rawPageIdentity(discoveryLiveGate) === rawPageIdentity(discoveryGate);
  if (def.linkExtractor && discoveryGate.safe && discoveryIdentityStable) {
    try {
      const discovered = await zn.execExtract(storeId, def.linkExtractor, { timeoutMs: z.execTimeoutMs });
      const href = String(discovered?.result?.href || '').trim();
      const postDiscoveryGate = await classifyLivePageSafety({ zn, storeId });
      const discoveryStillStable = postDiscoveryGate.safe
        && rawPageIdentity(postDiscoveryGate) === rawPageIdentity(discoveryGate);
      if (!discoveryStillStable) {
        logger.warn(`[${def.id}/${store.key}] 业务入口发现期间出现认证/拦截或页面身份变化，禁止点击入口并丢弃发现结果`);
        throw new Error('业务入口发现后的页面安全复核失败');
      }
      let followed = '';
      if (def.navigationLink && typeof zn.followNavigationLink === 'function') {
        try {
          followed = String(await zn.followNavigationLink(storeId, {
            ...def.navigationLink,
            timeoutMs: Math.min(15000, Number(z.visitTimeoutMs || 30000)),
          }) || '').trim();
        } catch (e) {
          logger.warn(`[${def.id}/${store.key}] 点击业务入口未跳转，继续尝试发现的地址: ${redactText(e.message)}`);
        }
      }
      if (/^https?:\/\//i.test(followed)) {
        if (def.preferFollowedLink) urls.splice(0, urls.length, followed);
        else if (!urls.includes(followed)) urls.unshift(followed);
      }
      if (/^https?:\/\//i.test(href) && !(def.preferFollowedLink && followed) && !urls.includes(href)) {
        urls.splice(1, 0, href);
        logger.info(`[${def.id}/${store.key}] 已从 Seller Central 导航发现业务入口`);
      }
    } catch (e) {
      logger.warn(`[${def.id}/${store.key}] 业务入口发现失败，继续尝试备选地址: ${redactText(e.message)}`);
    }
  } else if (def.linkExtractor) {
    logger.warn(`[${def.id}/${store.key}] 店铺启动后的 live 页面为认证/拦截页、探针不可用或身份已变化，跳过业务入口 DOM 探测`);
  }

  let openedPageUrl = discoveryUrl;
  try { openedPageUrl = await currentPageUrl(zn, storeId); } catch { /* visit below remains authoritative */ }
  let mayReuseOpenedPage = true;

  const trail = [];
  let best = null;
  let screenshotPageSafe = true;

  for (const url of urls) {
    const step = { url: safeEvidenceUrl(url) };
    trail.push(step);
    let navigation = null;
    let currentUrl = '';
    const openedSafety = mayReuseOpenedPage ? classifyUrlSafety(openedPageUrl) : null;
    const targetSafety = mayReuseOpenedPage ? classifyUrlSafety(url) : null;
    const reuseOpenedPage = openedSafety?.safe === true
      && targetSafety?.safe === true
      && rawPageIdentity(openedSafety) === rawPageIdentity(targetSafety);
    mayReuseOpenedPage = false;
    if (reuseOpenedPage) {
      navigation = { url: openedPageUrl };
      step.reusedOpenedPage = true;
    } else {
      try {
        navigation = await zn.visit(storeId, url, { timeoutMs: z.visitTimeoutMs, waitUntil: z.waitUntil });
      } catch (e) {
        step.error = redactText(e.message);
        logger.warn(`[${def.id}/${store.key}] 打开 ${safeEvidenceUrl(url)} 失败: ${redactText(e.message)}`);
        continue;
      }
    }
    if (def.advertisingAccountSwitch && typeof zn.selectAdvertisingAccount === 'function') {
      try {
        await zn.selectAdvertisingAccount(storeId, {
          timeoutMs: Math.min(90000, Number(z.visitTimeoutMs || 60000)),
        });
      } catch (e) {
        logger.warn(`[${def.id}/${store.key}] Amazon Ads 账户选择未完成: ${redactText(e.message)}`);
      }
    }
    const settleMs = def.settleMs ?? z.settleMs;
    if (settleMs) await sleep(settleMs);

    try {
      currentUrl = await waitForStablePageIdentity({
        zn, storeId, navigation,
        timeoutMs: Number(def.urlStabilizeMs || 0),
        pollMs: Number(def.urlStabilizePollMs || 250),
      });
    } catch (e) {
      step.currentUrlError = redactText(e.message);
    }
    let safety = classifyUrlSafety(currentUrl);
    step.currentUrl = safety.currentUrl;
    step.safetyCode = safety.code;
    if (!safety.safe) {
      const attempt = {
        url: safety.currentUrl,
        dom: null,
        domError: null,
        txt: null,
        textError: null,
        pageText: '',
        safety,
      };
      // A later ZiNiao/Chromium internal error is more actionable than an
      // earlier unverified SPA shell: retain it so the outer store loop can
      // close the poisoned browser and use its remaining bounded retry.
      if (!best || isRecoverableBrowserInternalSafety(safety)) best = attempt;
      screenshotPageSafe = false;
      logger.warn(`[${def.id}/${store.key}] ${safety.authSensitive ? '认证/拦截页面' : '导航后 current URL 不可确认'}，禁止采集与截图`);
      if (safety.authSensitive) break;
      continue;
    }

    let adsNameFilter = null;
    if (def.advertisingNameFilter === true) {
      const keyword = String(store.adsNameContains || '').trim();
      if (!keyword) throw new Error(`店铺 ${store.key} 未配置广告名称特征，拒绝无筛选检查全部广告`);
      if (typeof zn.selectAdvertisingCampaignNameFilter !== 'function') {
        throw new Error('当前紫鸟传输层不支持安全的广告名称筛选，拒绝无筛选检查全部广告');
      }
      const preNameFilterSafety = await classifyLivePageSafety({ zn, storeId });
      if (!preNameFilterSafety.safe) throw new Error('广告名称筛选前页面安全校验失败');
      adsNameFilter = await zn.selectAdvertisingCampaignNameFilter(storeId, keyword, { timeoutMs: 45000 });
      if (adsNameFilter?.verified !== true || adsNameFilter.keyword !== keyword) {
        throw new Error('广告名称筛选未通过精确值复核，拒绝读取未限定的广告结果');
      }
      logger.info(`[${def.id}/${store.key}] 已限定广告名称包含“${keyword}”`);
    }

    // The scheduled advertising verdict is defined by an exact filter view,
    // so establish the first read-only view before waiting for table readiness.
    // Otherwise the default "All campaigns" table can consume the full ready
    // timeout even though it is intentionally not accepted as proof for the
    // ads-off slot. Keep the live safety gate in front of the click.
    const initialAdvertisingFilter = advertisingSweepPlan(config?._currentSlot)[0] || null;
    if (
      def.advertisingStateSweep === true
      && initialAdvertisingFilter
      && typeof zn.selectAdvertisingCampaignState === 'function'
    ) {
      try {
        const preFilterSafety = await classifyLivePageSafety({ zn, storeId });
        if (preFilterSafety.safe === true) {
          await selectAdvertisingCampaignStateResilient({
            zn, storeId, state: initialAdvertisingFilter, logger, storeKey: store.key,
          });
          if (adsNameFilter) adsNameFilter = await zn.verifyAdvertisingCampaignNameFilter(storeId, adsNameFilter.keyword);
          await sleep(750);
          currentUrl = await currentPageUrl(zn, storeId);
        }
      } catch (e) {
        logger.warn(`[${def.id}/${store.key}] 预选 Amazon Ads “已启用”筛选未完成: ${redactText(e.message)}`);
      }
    }

    let evidence = await readEvidenceWithIdentityRetry({
      zn, storeId, def, store, config, logger, url: currentUrl, adsNameFilter,
    });
    if (evidence.liveSafety?.safe === true) currentUrl = rawPageIdentity(evidence.liveSafety);
    if (def.id === 'voc' && evidence.dom?.listCoverageRequired === true && evidence.liveSafety?.safe === true) {
      evidence = await collectVocList({
        initialEvidence: evidence, logger,
        selectPage: (page, expected) => selectVocListPage(zn, storeId, page, expected),
        readPage: expected => readEvidenceWithIdentityRetry({
          zn, storeId, store, config, logger, url: currentUrl,
          def: { ...def, readyTimeoutMs: 30000, readyPollMs: 750,
            ready: ({ dom, txt }) => verifyVocListPage(dom, txt, expected) },
        }),
      });
      // A click may fail while the same URL hydrates an auth/interstitial page.
      // Revalidate live content even when the pager threw before readPage.
      const postListSafety = await classifyLivePageSafety({ zn, storeId });
      if (!postListSafety.safe || rawPageIdentity(postListSafety) !== currentUrl) {
        evidence = { dom: null, txt: null, pageText: '', ready: false,
          liveSafety: { ...postListSafety, safe: false, code: postListSafety.safe ? 'PAGE_CHANGED_AFTER_VOC_PAGINATION' : postListSafety.code } };
      } else evidence.liveSafety = postListSafety;
    }
    if (
      def.advertisingStateSweep === true
      && ['ads-off', 'ads-on'].includes(config?._currentSlot)
      && typeof zn.selectAdvertisingCampaignState === 'function'
      && evidence.liveSafety?.safe === true
    ) {
      evidence = await collectAdvertisingStateSweep({
        zn, storeId, def, store, config, logger, initialEvidence: evidence, url: currentUrl,
        adsNameFilter,
      });
    }
    let { dom, domError, txt, textError, pageText } = evidence;
    try {
      currentUrl = await currentPageUrl(zn, storeId);
    } catch (e) {
      currentUrl = '';
      step.currentUrlError = redactText(e.message);
    }
    const currentUrlSafety = classifyUrlSafety(currentUrl);
    if (evidence.liveSafety?.safe !== true) {
      safety = evidence.liveSafety || {
        ...currentUrlSafety, safe: false, code: 'LIVE_SAFETY_PROBE_UNAVAILABLE', liveProbeUnavailable: true,
      };
    } else if (!currentUrlSafety.safe) {
      safety = currentUrlSafety;
    } else if (rawPageIdentity(currentUrlSafety) !== rawPageIdentity(evidence.liveSafety)) {
      safety = { ...currentUrlSafety, safe: false, code: 'PAGE_CHANGED_AFTER_EVIDENCE_READ' };
    } else {
      safety = classifyPageSafety({ currentUrl, dom, txt, pageText });
    }
    step.currentUrl = safety.currentUrl;
    step.safetyCode = safety.code;
    if (!safety.safe) {
      dom = null;
      txt = null;
      pageText = '';
      domError = null;
      textError = null;
    }

    const landedBeforeSafety = evidence.dom?.landed === true || evidence.txt?.landed === true;
    step.domOk = !!dom;
    step.landed = safety.safe && (dom?.landed === true || txt?.landed === true);
    step.ready = evidence.ready;

    const attempt = {
      url: safety.currentUrl, dom, domError, txt, textError, pageText, safety,
      ready: evidence.ready === true,
      readWasLiveSafe: evidence.liveSafety?.safe === true,
      landedBeforeSafety,
    };
    if (!best) best = attempt;
    if (safety.authSensitive) {
      best = attempt;
      screenshotPageSafe = false;
      logger.warn(`[${def.id}/${store.key}] 页面出现登录/验证码/Passkey/拦截信号，DOM 与文本证据已抑制`);
      break;
    }
    if (step.landed) {
      best = attempt;
      screenshotPageSafe = true;
      if (def.detailExtractor && dom && !(dom.listCoverageRequired === true && dom.listCoverage?.complete !== true)) {
        const detailSession = { storeId };
        dom.details = await collectDetails({
          zn, session: detailSession, def, store, config, logger,
          listUrl: currentUrl, dirs, stamp,
          rows: dom.rows || [],
        });
        storeId = detailSession.storeId;
        // Detail URLs are needed only for navigation. Never retain their query
        // strings or fragments in a report/evidence object.
        for (const row of dom.rows || []) {
          if (row.detailUrl) row.detailUrl = safeEvidenceUrl(row.detailUrl);
        }
        // Return to the list so the screenshot and raw text correspond to the
        // evidence used for the store-level judgement.
        try {
          const backNavigation = await zn.visit(storeId, currentUrl, { timeoutMs: z.visitTimeoutMs, waitUntil: z.waitUntil });
          if (settleMs) await sleep(Math.min(settleMs, 2000));
          const backCurrentUrl = await waitForStablePageIdentity({
            zn, storeId, navigation: backNavigation,
            timeoutMs: Number(def.urlStabilizeMs || 0),
            pollMs: Number(def.urlStabilizePollMs || 250),
          });
          const backUrlSafety = classifyUrlSafety(backCurrentUrl);
          if (!backUrlSafety.safe) {
            screenshotPageSafe = false;
          } else {
            // Returning from detail pages can hydrate/redirect just like the
            // initial list. Apply the same bounded fresh dual-path read here.
            const refreshed = await readEvidenceWithIdentityRetry({
              zn, storeId, def, store, config, logger, url: backCurrentUrl,
            });
            const verifiedUrl = await currentPageUrl(zn, storeId);
            if (refreshed.liveSafety?.safe !== true) {
              best = {
                ...(best || {}), url: refreshed.liveSafety?.currentUrl || safeEvidenceUrl(verifiedUrl),
                dom: null, txt: null, pageText: '', domError: null, textError: null,
                safety: refreshed.liveSafety || {
                  safe: false, code: 'LIVE_SAFETY_PROBE_UNAVAILABLE', liveProbeUnavailable: true,
                  authSensitive: false, blocked: false, currentUrl: safeEvidenceUrl(verifiedUrl),
                },
              };
              screenshotPageSafe = false;
            } else {
              screenshotPageSafe = rawPageIdentity(refreshed.liveSafety) === verifiedUrl
                && classifyPageSafety({
                  currentUrl: verifiedUrl,
                  dom: refreshed.dom,
                  txt: refreshed.txt,
                  pageText: refreshed.pageText,
                }).safe;
            }
          }
        } catch (e) {
          screenshotPageSafe = false;
          logger.warn(`[${def.id}/${store.key}] 详情采集后返回列表失败: ${redactText(e.message)}`);
        }
      }
      break;
    }
    logger.warn(`[${def.id}/${store.key}] ${safeEvidenceUrl(url)} 看起来不是目标页面，尝试下一个地址`);
  }

  let evidenceSafe = best?.safety?.safe === true;
  let sensitiveAuth = best?.safety?.authSensitive === true;
  if (def.screenshotRequiresReady === true && best?.ready !== true) {
    screenshotPageSafe = false;
    logger.warn(`[${def.id}/${store.key}] 页面仍在动态加载，未达到判定就绪条件，本次不保存截图`);
  }
  if (config.storeHealth.screenshot && evidenceSafe && screenshotPageSafe) {
    const captureGate = await classifyLivePageSafety({ zn, storeId });
    screenshotPageSafe = captureGate.safe
      && rawPageIdentity(captureGate) === rawPageIdentity(best.safety);
    if (!screenshotPageSafe) {
      const rejectedGate = captureGate.safe
        ? { ...captureGate, safe: false, code: 'PAGE_CHANGED_BEFORE_SCREENSHOT' }
        : captureGate;
      evidenceSafe = false;
      sensitiveAuth = rejectedGate.authSensitive === true;
      best = {
        ...(best || {}), url: rejectedGate.currentUrl, dom: null, txt: null, pageText: '',
        domError: null, textError: null, safety: rejectedGate,
      };
      for (const step of trail) {
        delete step.domOk;
        delete step.landed;
        delete step.ready;
      }
      logger.warn(`[${def.id}/${store.key}] 截图前页面安全状态变化，已抑制本次 DOM/文本证据且不会调用截图`);
    }
  }
  let screenshot = null;
  if (config.storeHealth.screenshot && evidenceSafe && !sensitiveAuth && screenshotPageSafe) {
    const p = path.join(dirs.shots, `${filePart(def.id)}_${filePart(store.key)}_${stamp}.png`);
    let shot = null;
    let screenshotThrew = false;
    let cleanupFailure = null;
    try {
      shot = await zn.screenshot(storeId, p, { fullPage: config.storeHealth.fullPageScreenshot });
    } catch (e) {
      screenshotThrew = true;
      const cleaned = secureCleanupEvidenceSet({ files: [p], outDir: config.outDir });
      if (!cleaned.ok) cleanupFailure = cleaned;
      logger.warn(`[${def.id}/${store.key}] 截图失败: ${redactText(e.message)}`);
    }
    const postSafety = await verifyPageAfterScreenshot({
      zn, storeId, expectedUrl: rawPageIdentity(best?.safety),
      dom: best?.dom, txt: best?.txt, pageText: best?.pageText,
    });
    if (!postSafety.safe) {
      const cleaned = screenshotThrew
        ? secureCleanupEvidenceSet({ files: [p], outDir: config.outDir })
        : secureCleanupReportedEvidence({
            expectedFile: p, reportedFile: shot?.path, outDir: config.outDir,
          });
      if (!cleaned.ok) cleanupFailure = cleaned;
      screenshot = null;
      evidenceSafe = false;
      sensitiveAuth = postSafety.authSensitive === true;
      screenshotPageSafe = false;
      best = {
        ...(best || {}), url: postSafety.currentUrl, dom: null, txt: null, pageText: '',
        domError: null, textError: null, safety: postSafety,
      };
      for (const step of trail) {
        delete step.domOk;
        delete step.landed;
        delete step.ready;
      }
      if (!cleanupFailure) {
        logger.warn(`[${def.id}/${store.key}] 截图期间页面状态变化，截图已安全清理并抑制本次 DOM/文本证据`);
      }
    } else if (
      shot?.path
      && path.resolve(String(shot.path)) === path.resolve(p)
      && validateEvidenceArtifact({ file: p, outDir: config.outDir }).ok
    ) {
      screenshot = p;
      try { fs.chmodSync(p, 0o600); } catch { /* non-POSIX */ }
    } else {
      const cleaned = screenshotThrew
        ? secureCleanupEvidenceSet({ files: [p], outDir: config.outDir })
        : secureCleanupReportedEvidence({
            expectedFile: p, reportedFile: shot?.path, outDir: config.outDir,
          });
      if (!cleaned.ok) cleanupFailure = cleaned;
    }
    if (cleanupFailure) {
      const failedSafety = cleanupFailureSafety(postSafety);
      screenshot = null;
      evidenceSafe = false;
      sensitiveAuth = false;
      screenshotPageSafe = false;
      best = {
        ...(best || {}), url: failedSafety.currentUrl, dom: null, txt: null, pageText: '',
        domError: null, textError: null, safety: failedSafety,
      };
      for (const step of trail) {
        delete step.domOk;
        delete step.landed;
        delete step.ready;
      }
      logger.error(`[${def.id}/${store.key}] 截图证据安全清理失败，结果已标记 ${SECURITY_CLEANUP_FAILED}`);
    }
  } else if (!evidenceSafe || sensitiveAuth) {
    logger.warn(`[${def.id}/${store.key}] 认证/拦截/空壳/URL 不可确认页面不截图、不保存 DOM 或原始页面文本`);
  }

  let rawTextFile = null;
  if (config.storeHealth.saveRawPageText && best?.pageText && evidenceSafe && !sensitiveAuth) {
    try {
      fs.mkdirSync(dirs.raw, { recursive: true, mode: 0o700 });
      fs.chmodSync(dirs.raw, 0o700);
      rawTextFile = path.join(dirs.raw, `${filePart(def.id)}_${filePart(store.key)}_${stamp}.txt`);
      fs.writeFileSync(rawTextFile, redactText(best.pageText), { mode: 0o600 });
    } catch {
      rawTextFile = null;
    }
  }

    return { storeId, best, trail: sanitizeForStorage(trail, { rootDir: config.outDir }), screenshot, rawTextFile };
  } catch (error) {
    try {
      await zn.storeClose(storeId);
    } catch (cleanupError) {
      logger.warn(`[${def.id}/${store.key}] 采集失败后的紫鸟会话清理未完成: ${redactText(cleanupError.message)}`);
    }
    throw error;
  }
}

async function checkOneStore({ zn, store, config, logger, def, dirs, stamp, prev, reviewOwnership }) {
  const z = config.ziniao;
  const started = Date.now();
  const result = {
    check: def.id,
    storeKey: store.key,
    storeName: store.name || null,
    market: store.market || null,
    url: null,
    status: 'ERROR',
    ok: false,
    severity: 'ERROR',
    confidence: 'low',
    verdictSource: 'none',
    metrics: {},
    anomalyReasons: [],
    items: [],
    notes: [],
    attempts: 0,
    durationMs: 0,
    screenshot: null,
    rawTextFile: null,
    error: null,
    evidence: {},
    baselineEligible: false,
  };

  let p = null;
  let lastError = null;
  const maxAttempts = Math.max(
    def.retryFreshSessionWhenNotReady === true ? 2 : 1,
    Math.max(1, Number(def.maxAttempts || 1)),
    (z.retries ?? 2) + 1,
  );
  let incompleteFreshRetryUsed = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result.attempts = attempt;
    try {
      p = await (def.probe || probe)({ zn, store, config, logger, def, dirs, stamp });
      if (shouldRetryIncompletePage(def, p, incompleteFreshRetryUsed) && attempt < maxAttempts) {
        incompleteFreshRetryUsed = true;
        try { await zn.storeClose(p.storeId); } catch { /* incomplete session */ }
        p = null;
        throw new Error('目标页动态数据加载超时，已关闭紫鸟店铺浏览器并准备一次新会话重试');
      }
      if (isRecoverableBrowserInternalSafety(p?.best?.safety) && attempt < maxAttempts) {
        try { await zn.storeClose(p.storeId); } catch { /* poisoned session */ }
        p = null;
        throw new Error('紫鸟店铺浏览器进入内部错误页，已关闭并准备重试');
      }
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      logger.warn(`[${def.id}/${store.key}] 第 ${attempt}/${maxAttempts} 次失败: ${redactText(e.message)}`);
      if (isConfigMissingError(e)) break;
      if (attempt < maxAttempts) await sleep(z.retryDelayMs ?? 8000);
    }
  }

  if (p) {
    result.screenshot = p.screenshot;
    result.rawTextFile = p.rawTextFile;
    result.url = safeEvidenceUrl(p.best?.url ?? null);
    const dom = p.best?.dom ?? null;
    const txt = p.best?.txt ?? null;
    const safety = p.best?.safety || classifyPageSafety({
      currentUrl: p.best?.url,
      dom,
      txt,
      pageText: p.best?.pageText,
    });
    result.evidence = sanitizeForStorage({
      dom: dom ? { ...dom, _bigFieldsTrimmed: true } : { error: p.best?.domError ?? 'no dom result' },
      text: txt ?? { error: p.best?.textError ?? 'no page text' },
      trail: p.trail,
      safety,
    }, { rootDir: config.outDir });

    const domLanded = dom?.landed === true;
    const textLanded = txt?.landed === true;
    const landed = domLanded || textLanded;
    if (!landed) {
      // Could not confirm we were even on the right page — never pass silently.
      result.status = safety.blocked ? 'BLOCKED'
        : safety.authSensitive ? 'LOGIN_REQUIRED'
          : safety.code === SECURITY_CLEANUP_FAILED
            || safety.liveProbeUnavailable || /^PAGE_CHANGED_/.test(String(safety.code || '')) ? 'ERROR'
            : 'UNKNOWN';
      if (safety.code === SECURITY_CLEANUP_FAILED) result.error = SECURITY_CLEANUP_FAILED;
      result.anomalyReasons.push(
        result.status === 'LOGIN_REQUIRED' ? '需要登录，无法读取页面'
          : result.status === 'BLOCKED' ? '页面出现访问拦截/Robot Check，无法读取业务数据'
            : safety.code === SECURITY_CLEANUP_FAILED ? '截图证据安全清理失败，结果已阻断且需检查受保护隔离区'
            : result.status === 'ERROR' ? '页面安全探针不可用或采集期间页面发生变化，本次证据已抑制'
              : '未能确认已打开目标页面，本次结果不可信',
      );
    } else {
      try {
        const v = def.judge({ dom, txt, prev, store, config, reviewOwnership });
        result.status = v.status;
        result.ok = !!v.ok;
        result.severity = v.severity || (v.ok ? 'OK' : 'CRITICAL');
        result.confidence = v.confidence || (dom && txt ? 'high' : 'medium');
        result.verdictSource = v.source || (dom && txt ? 'dom+text' : dom ? 'dom' : 'text');
        result.metrics = sanitizeForStorage(v.metrics || {}, { rootDir: config.outDir });
        result.items = sanitizeForStorage(v.items || [], { rootDir: config.outDir });
        result.anomalyReasons = sanitizeForStorage(v.reasons || [], { rootDir: config.outDir });
        result.notes = sanitizeForStorage(v.notes || [], { rootDir: config.outDir });
        result.baselineEligible = v.baselineEligible !== false;

        // Generic checks 2-9 inherit item 1's dual-path safety rule: one path may be
        // enough to report a problem, but never enough to assert normal.
        if (result.ok && !(domLanded && textLanded)) {
          result.ok = false;
          result.status = 'PARTIAL_EVIDENCE';
          result.severity = 'ERROR';
          result.confidence = 'low';
          result.baselineEligible = false;
          result.anomalyReasons.push('只有一条提取路径确认目标页面，不能据此下正常结论');
        }
      } catch (e) {
        result.status = 'ERROR';
        result.error = `判定逻辑异常: ${redactText(e.message)}`;
        result.anomalyReasons.push(result.error);
      }
    }
  }

  if (lastError) {
    result.status = 'ERROR';
    result.error = redactText(lastError.message);
    if (isConfigMissingError(lastError)) {
      result.status = 'NOT_CONFIGURED';
      result.notes.push('紫鸟传输层未配置：WebDriver 模式请设置本机凭据；CLI 模式请执行 `ziniao-cli config init`');
    }
  }

  if (result.status !== 'ERROR' && result.status !== 'NOT_CONFIGURED' && !result.ok && !result.anomalyReasons.length) {
    result.anomalyReasons.push(`状态 ${result.status}（非正常）`);
  }
  if (result.status === 'ERROR' && !result.anomalyReasons.length) {
    result.anomalyReasons.push(`检查执行失败: ${truncate(result.error || '未知', 200)}`);
  }
  if (result.status === 'NOT_CONFIGURED') {
    result.severity = 'WARN';
    result.anomalyReasons = ['紫鸟传输层尚未配置，无法采集'];
  } else if (result.ok) {
    result.severity = 'OK';
  } else if (result.severity === 'OK') {
    result.severity = 'CRITICAL';
  }

  result.durationMs = Date.now() - started;

  const shouldClose = z.closeStoreAfterCheck && !(z.keepOpenOnFailure && result.severity !== 'OK');
  if (p?.storeId && shouldClose) {
    try {
      await zn.storeClose(p.storeId);
    } catch { /* not fatal */ }
  }
  return result;
}

async function buildReviewOwnershipByStore({ config, stores, logger, override }) {
  if (override) return override;
  try {
    // Loaded lazily because asin-health itself imports the shared check
    // definitions.  The runtime dependency is one-way here: Reviews only
    // consumes the already durable ASIN inventory and never opens another page.
    const { loadAsins } = await import('../checks/asin-health.js');
    const info = loadAsins(config);
    const ownersByAsin = new Map();
    const activeInventory = (info.inventory || []).filter((item) =>
      item?.storeKey && item.monitoring !== 'disabled' && item.lastStatus !== 'INACTIVE_LISTING'
        && /^[A-Z0-9]{10}$/.test(String(item.asin || '').toUpperCase()),
    );
    for (const item of activeInventory) {
      const asin = String(item.asin).toUpperCase();
      if (!ownersByAsin.has(asin)) ownersByAsin.set(asin, new Set());
      ownersByAsin.get(asin).add(item.storeKey);
    }
    return new Map(stores.map((store) => {
      const storeAsins = new Set(activeInventory
        .filter((item) => item.storeKey === store.key)
        .map((item) => String(item.asin).toUpperCase()));
      return [store.key, {
        ready: true,
        storeAsins,
        ownersByAsin,
        inventoryCount: storeAsins.size,
        source: 'configured+latest-usable-voc',
      }];
    }));
  } catch (e) {
    logger.warn(`[reviews] ASIN 归属清单加载失败: ${redactText(e.message)}`);
    return new Map(stores.map((store) => [store.key, {
      ready: false,
      storeAsins: new Set(),
      ownersByAsin: new Map(),
      inventoryCount: 0,
      source: 'unavailable',
    }]));
  }
}

/** Ads-status can run two stores at once without raising the other checks. */
export function storeConcurrencyLimit({ checkId, config = {}, opts = {} }) {
  if (checkId === 'ads-status') {
    const ads = Number(config.adsStatus?.concurrency);
    if (Number.isInteger(ads) && ads >= 1) return ads;
  }
  return Math.max(1, opts.concurrency ?? config.ziniao?.concurrency ?? 1);
}

export async function runGenericCheck({ zn, config, stores, logger, def, opts = {} }) {
  const startedAt = new Date();
  const stamp = bjStamp(startedAt);
  const slot = opts.slot || 'adhoc';
  const runId = `${def.id}-${stamp}-${slot}`;
  const dirs = reportDirs({ outDir: config.outDir, check: def.id });
  fs.mkdirSync(dirs.shots, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirs.shots, 0o700);

  const stateStore = createStateStore({ outDir: config.outDir, name: def.id });
  const state = stateStore.read();
  const alerter = createAlerter({ config, logger, outDir: config.outDir });

  const limit = storeConcurrencyLimit({ checkId: def.id, config, opts });
  logger.info(`[${def.id}] ${def.title} — ${stores.length} 个店铺，批次=${slot}，${limit > 1 ? `并发=${limit}` : '步进'}`);

  const prevByKey = new Map(stores.map((s) => [s.key, state.stores?.[s.key]]));
  const reviewOwnershipByStore = def.no === 4
    ? await buildReviewOwnershipByStore({
        config, stores, logger, override: opts.reviewOwnershipByStore,
      })
    : null;

  const { results, peakActive } = await mapWithConcurrency(
    stores,
    async (store) => {
      opts.onProgress?.({ type: 'store', phase: 'started', check: def.id, storeKey: store.key });
      let r;
      const adsKeyword = String(store?.adsNameContains || '').trim();
      if (def.advertisingNameFilter === true && (!adsKeyword || adsKeyword.length > 40 || /[\u0000-\u001f\u007f]/.test(adsKeyword))) {
        r = {
          check: def.id, storeKey: store.key, storeName: store.name || null,
          market: store.market || null, url: null, status: 'NOT_CONFIGURED', ok: false, severity: 'WARN',
          confidence: 'high', verdictSource: 'configuration-preflight', metrics: { nameContains: null }, items: [],
          anomalyReasons: ['广告名称特征未配置或格式无效；已在打开店铺浏览器前停止，绝不回退为全账户广告检查'],
          notes: [], attempts: 0, durationMs: 0, screenshot: null, rawTextFile: null, error: null,
          evidence: {}, baselineEligible: false,
        };
      }
      try {
        if (!r) {
          r = await checkOneStore({
            zn, store, config, logger, def, dirs, stamp, prev: prevByKey.get(store.key),
            reviewOwnership: reviewOwnershipByStore?.get(store.key),
          });
        }
      } catch (e) {
        logger.error(`[${def.id}/${store.key}] 未捕获异常: ${redactText(e.stack || e.message)}`);
        r = {
          check: def.id, storeKey: store.key, storeName: store.name || null,
          market: store.market || null, url: null, status: 'ERROR', ok: false, severity: 'ERROR',
          confidence: 'low', verdictSource: 'none', metrics: {}, items: [],
          anomalyReasons: [`检查执行失败: ${truncate(redactText(e.message), 200)}`], notes: [], attempts: 0,
          durationMs: 0, screenshot: null, rawTextFile: null, error: redactText(e.message), evidence: {},
        };
      }
      r.runId = runId;
      r.slot = slot;
      r.checkedAt = bjIso();
      logger.info(`[${def.id}/${r.storeKey}] ${r.status} ${r.ok ? '正常' : '异常'} ${JSON.stringify(r.metrics)}`);
      if (typeof opts.onProgress === 'function') opts.onProgress({
        type: 'store', phase: 'completed', check: def.id, storeKey: r.storeKey, status: r.status, severity: r.severity,
      });
      return r;
    },
    { limit, staggerMs: config.ziniao.staggerMs ?? 0, jitterMs: config.ziniao.jitterMs ?? 0 },
  );

  const totals = {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    abnormal: results.filter((r) => !r.ok).length,
    errors: results.filter((r) => r.severity === 'ERROR').length,
    warnings: results.filter((r) => r.severity === 'WARN').length,
    notConfigured: results.filter((r) => r.status === 'NOT_CONFIGURED').length,
  };

  const summary = {
    check: def.id,
    checkNo: def.no,
    checkTitle: def.title,
    requirement: def.requirement,
    runId,
    slot,
    timezone: 'Asia/Shanghai',
    startedAt: bjIso(startedAt),
    finishedAt: bjIso(),
    durationMs: Date.now() - startedAt.getTime(),
    execution: { mode: limit > 1 ? 'concurrent' : 'sequential', concurrencyLimit: limit, peakActive },
    totals,
    results,
    alerts: [],
    crm: null,
  };

  const { dir, files } = writeGenericReports({ outDir: config.outDir, check: def.id, summary });
  summary.reportDir = dir;
  summary.reportFiles = files;

  const problems = results.filter((r) => r.severity !== 'OK');
  if (problems.length) {
    for (const group of partitionAlertProblems(problems)) {
      summary.alerts.push(await alerter.send({
        check: def.id,
        severity: group.severity,
        title: `[${def.no}/${CHECK_TOTAL}] ${def.title} 异常：${group.problems.length}/${totals.total} 个店铺（${slot}）`,
        lines: [
          ...group.problems.map((p) => `**${p.storeKey}** → ${p.status}${p.anomalyReasons.length ? ` · ${p.anomalyReasons.join('；')}` : ''}`),
          `判定依据: ${def.requirement}`,
        ],
        data: {
          runId, totals,
          stores: group.problems.map((p) => ({ storeKey: p.storeKey, status: p.status, reasons: p.anomalyReasons })),
        },
      }));
    }
  } else {
    logger.info(`[${def.id}] 全部 ${totals.total} 个店铺正常`);
  }

  // Operational alerts must not wait behind a slow/retrying CRM endpoint.
  summary.crm = await pushToCrmSafely({
    config, logger,
    payload: { source: 'singal-amz-guard', ...summary, results: undefined, records: results },
  });

  writeGenericReports({ outDir: config.outDir, check: def.id, summary });

  // A comparison baseline is also the duplicate-alert cursor.  Advance it
  // only after the report is durable and every attempted alert sink confirms
  // delivery; otherwise the next run must retry the business notification.
  const alertDeliveryFailed = summary.alerts.some((alert) => Object.values(alert?.delivery || {}).some(
    (delivery) => delivery !== 'ok',
  ));
  state.stores ||= {};
  for (const r of results) {
    if (!baselineEligible(r)) continue;
    if (r.severity !== 'OK' && alertDeliveryFailed) continue;
    state.stores[r.storeKey] = {
      status: r.status, ok: r.ok, metrics: r.metrics,
      lastRunAt: r.checkedAt, lastRunId: runId,
    };
  }
  stateStore.write(state);
  return summary;
}
