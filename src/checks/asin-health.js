import fs from 'node:fs';
import path from 'node:path';
import { artifactPart } from '../lib/artifact-name.js';
import { asinDetailDef } from './definitions.js';
import { ASIN_IMAGE_ERROR_TEXT_EXTRACTOR } from '../extractors/checks.js';
import { CHECK_TOTAL } from './registry.js';
import { createAlerter, partitionAlertProblems } from '../lib/alert.js';
import { pushToCrmSafely } from '../lib/crm.js';
import {
  SECURITY_CLEANUP_FAILED, cleanupFailureSafety, secureCleanupEvidenceSet,
  secureCleanupReportedEvidence, validateEvidenceArtifact,
} from '../lib/evidence-cleanup.js';
import { mapWithConcurrency } from '../lib/pool.js';
import {
  canRetryPageIdentity, classifyAsinProductReadSafety, classifyLivePageSafety, classifyPageSafety, classifyUrlSafety,
  currentPageUrl, isRecoverableBrowserInternalSafety, isTransientEmptyDocumentSafety, rawPageIdentity, verifyPageAfterScreenshot,
} from '../lib/page-safety.js';
import { reportDirs, writeGenericReports } from '../lib/report.js';
import { redactText, sanitizeForStorage, sanitizeUrl } from '../lib/redact.js';
import { createStateStore } from '../lib/state.js';
import { readCheckHistory } from '../lib/dashboard-history.js';
import { bjDateKey, bjIso, bjStamp, sleep } from '../lib/time.js';
import { isConfigMissingError, truncate } from '../lib/ziniao.js';

/**
 * Item 5: per-ASIN routine check.
 *
 * Unlike the other seven this reads *public* product detail pages, one per ASIN,
 * so it reuses the matching store browser for a bounded group of ASINs before
 * releasing renderer memory. Rating is compared against the previous run.
 */

const CHECK_ID = 'asin-health';
const filePart = artifactPart;
const INTERNAL_BROWSER_ERROR_DIAGNOSTIC = [
  'var t=String((document.body&&(document.body.innerText||document.body.textContent))||"").toUpperCase();',
  'var m=t.match(/\\b(?:ERR_TIMED_OUT|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_FAILED)\\b/);',
  'return m?m[0]:null;',
].join('');

export function allowlistedBrowserErrorCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^(?:ERR_TIMED_OUT|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_FAILED)$/.test(code)
    ? code : null;
}

async function diagnoseInternalBrowserError({ zn, storeId }) {
  if (typeof zn?.execScript !== 'function') return null;
  try {
    return allowlistedBrowserErrorCode(await zn.execScript(storeId, INTERNAL_BROWSER_ERROR_DIAGNOSTIC));
  } catch {
    return null;
  }
}

function unsafePageReason(pageSafety) {
  if (pageSafety?.blocked) return '页面出现访问拦截，禁止保存证据';
  if (pageSafety?.authSensitive) return '页面进入登录/验证码/Passkey 流程，禁止保存证据';
  if (pageSafety?.emptyShell) return '页面为空壳或未渲染出商品证据，禁止保存证据';
  if (pageSafety?.code === 'LIVE_SAFETY_PROBE_INCOMPLETE') {
    return '页面安全扫描不完整，禁止采集与截图';
  }
  if (pageSafety?.code === 'CURRENT_URL_UNAVAILABLE') {
    return '导航后 current URL 不可确认，禁止采集与截图';
  }
  if (pageSafety?.code === 'UNAPPROVED_AMAZON_HOST') {
    return '页面离开允许的 Amazon HTTPS 域名，禁止采集与截图';
  }
  if (pageSafety?.code === 'ASIN_URL_IDENTITY_MISMATCH' || pageSafety?.code === 'ASIN_DOM_IDENTITY_MISMATCH') {
    return '商品页 ASIN 与待检目标不一致，禁止采集、截图和更新基线';
  }
  if (pageSafety?.code === 'ASIN_DOM_EXTRACTION_TIMEOUT') {
    return '商品页 DOM 提取超时，未取得完整双路证据，禁止截图和更新基线';
  }
  if (/^PAGE_CHANGED_/.test(String(pageSafety?.code || ''))) {
    return '页面在安全校验期间发生变化，禁止采集与截图';
  }
  return '页面未通过安全校验，禁止采集与截图';
}

export function isRecoverableAsinSafety(pageSafety) {
  if (!pageSafety || pageSafety.authSensitive || pageSafety.blocked) return false;
  if (isRecoverableBrowserInternalSafety(pageSafety)) return true;
  return isTransientEmptyDocumentSafety(pageSafety) || pageSafety.code === 'LIVE_SAFETY_PROBE_INCOMPLETE'
    || pageSafety.code === 'ASIN_DOM_EXTRACTION_TIMEOUT'
    || pageSafety.code === 'CURRENT_URL_UNAVAILABLE'
    || /^PAGE_CHANGED_/.test(String(pageSafety.code || ''));
}

export function asinStateKey(storeKey, market, asin) {
  return `${String(storeKey || '').trim()}:${String(market || 'US').toUpperCase()}:${String(asin || '').toUpperCase()}`;
}

export function previousDateKey(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!m) throw new Error(`invalid date key: ${dateKey}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1));
  return d.toISOString().slice(0, 10);
}

function validRatingBaseline(result) {
  return result.baselineEligible !== false
    && Number.isFinite(result.metrics?.rating)
    && !['ERROR', 'UNKNOWN', 'UNKNOWN_RATING', 'LOGIN_REQUIRED', 'BLOCKED', 'NOT_CONFIGURED', 'PARTIAL_EVIDENCE'].includes(result.status)
    && result.severity !== 'ERROR';
}

const MARKET_DOMAIN = {
  US: 'www.amazon.com', CA: 'www.amazon.ca', MX: 'www.amazon.com.mx', BR: 'www.amazon.com.br',
  UK: 'www.amazon.co.uk', GB: 'www.amazon.co.uk', DE: 'www.amazon.de', FR: 'www.amazon.fr',
  IT: 'www.amazon.it', ES: 'www.amazon.es', NL: 'www.amazon.nl', SE: 'www.amazon.se',
  PL: 'www.amazon.pl', TR: 'www.amazon.com.tr', JP: 'www.amazon.co.jp', AU: 'www.amazon.com.au',
  SG: 'www.amazon.sg', AE: 'www.amazon.ae', SA: 'www.amazon.sa', IN: 'www.amazon.in',
};

export function asinUrl(asin, market, domainOverride, pathVariant = 'dp') {
  const host = domainOverride || MARKET_DOMAIN[String(market || 'US').toUpperCase()] || MARKET_DOMAIN.US;
  const productPath = pathVariant === 'gp-product' ? `gp/product/${asin}` : `dp/${asin}`;
  return `https://${host}/${productPath}`;
}

function asinRetailOrigin(item) {
  return `${new URL(asinUrl(item.asin, item.market, item.domain)).origin}/`;
}

function asinIdentity(item) {
  return `${item.storeKey || '*'}:${String(item.market || 'US').toUpperCase()}:${item.asin}`;
}

function monitoringMode(item) {
  if (item.enabled === false || ['disabled', 'retired'].includes(String(item.monitoring || '').toLowerCase())) {
    return 'disabled';
  }
  if (['weekly', 'verify', 'verification'].includes(String(item.monitoring || '').toLowerCase())) return 'weekly';
  return 'active';
}

function latestAsinChecks(config) {
  const latest = new Map();
  for (const entry of readCheckHistory({ outDir: config.outDir, checkId: CHECK_ID })) {
    const checkedAt = entry.report.finishedAt || entry.report.startedAt || null;
    for (const result of entry.report.results || []) {
      const asin = String(result?.asin || '').trim().toUpperCase();
      const storeKey = result?.storeKey || null;
      if (!storeKey || !/^[A-Z0-9]{10}$/.test(asin)) continue;
      const item = { storeKey, market: result.market || 'US', asin };
      latest.set(asinIdentity(item), {
        checkedAt: result.checkedAt || checkedAt,
        status: result.status || 'UNKNOWN',
        reason: (result.anomalyReasons || [])[0] || null,
      });
    }
  }
  return latest;
}

function cadence(item, latestChecks, now, recheckDays) {
  const last = latestChecks.get(asinIdentity(item));
  if (item.monitoring !== 'weekly') return { due: true, lastCheck: last || null, nextCheckAt: null };
  const lastMs = Date.parse(last?.checkedAt || '');
  if (!Number.isFinite(lastMs)) return { due: true, lastCheck: last || null, nextCheckAt: null };
  const nextMs = lastMs + recheckDays * 24 * 60 * 60 * 1000;
  return {
    due: now.getTime() >= nextMs,
    lastCheck: last,
    nextCheckAt: new Date(nextMs).toISOString(),
  };
}

export function loadAsins(config, { now = new Date() } = {}) {
  const file = path.join(config._root, 'config', 'asins.json');
  let raw = [];
  const missing = !fs.existsSync(file);
  if (!missing) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config/asins.json 不是合法 JSON: ${e.message}`);
    }
  }
  const configuredRaw = (Array.isArray(raw) ? raw : raw.asins || [])
    .filter((a) => a && a.asin)
    .map((a) => ({
      asin: String(a.asin).trim().toUpperCase(),
      market: a.market || 'US',
      domain: a.domain || null,
      storeKey: a.storeKey || null,
      label: a.label || '',
      monitoring: monitoringMode(a),
      monitoringReason: String(a.monitoringReason || a.reason || '').trim() || null,
      source: 'configured',
    }));
  const placeholders = configuredRaw.filter((a) => /EXAMPLE|示例/i.test(`${a.asin} ${a.label}`));
  const configured = configuredRaw.filter((a) => !placeholders.includes(a) && /^[A-Z0-9]{10}$/.test(a.asin));

  const discovered = [];
  if (config.asinHealth?.autoDiscoverFromVoc !== false) {
    // Keep the newest successful ASIN-bearing VOC snapshot per store. A later
    // LOGIN_REQUIRED/ERROR report is still the dashboard truth, but must not
    // silently erase the last known product inventory from daily ASIN checks.
    const latestUsableByStore = new Map();
    for (const entry of readCheckHistory({ outDir: config.outDir, checkId: 'voc' })) {
      const usableInReport = new Map();
      for (const result of entry.report.results || []) {
        const storeKey = result.storeKey || result.storeName || null;
        if (!storeKey) continue;
        // A partial list/header parse must not replace a previously complete
        // inventory with only the subset it happened to recognize. Detail
        // failures are allowed here when the list itself remained complete;
        // they still stay red in the VOC report and do not affect this narrow
        // question of which ASINs the independent product check must visit.
        if (result.metrics?.headerMappingIncomplete === true) continue;
        if (['LOGIN_REQUIRED', 'ERROR', 'UNKNOWN', 'BLOCKED', 'NOT_CONFIGURED'].includes(result.status)) continue;
        const validItems = [...new Map((result.items || [])
          .map((item) => [String(item?.asin || '').trim().toUpperCase(), item])
          .filter(([asin]) => /^[A-Z0-9]{10}$/.test(asin))).entries()];
        const declaredCount = Number(result.metrics?.asinCount);
        if (Number.isFinite(declaredCount) && declaredCount > 0 && validItems.length !== declaredCount) continue;
        if (!usableInReport.has(storeKey)) usableInReport.set(storeKey, []);
        for (const [asin] of validItems) {
          if (!usableInReport.has(storeKey)) usableInReport.set(storeKey, []);
          usableInReport.get(storeKey).push({
            asin, market: result.market || 'US', domain: null, storeKey, label: 'VOC 自动发现',
            monitoring: 'active', monitoringReason: null, source: 'voc',
          });
        }
      }
      for (const [storeKey, items] of usableInReport) latestUsableByStore.set(storeKey, items);
    }
    for (const items of latestUsableByStore.values()) {
      discovered.push(...items);
    }
  }

  // A local rule must be able to lower the cadence of a VOC-discovered ASIN;
  // otherwise an enabled=false/weekly operator decision would be overwritten
  // by the next successful discovery run.
  const configuredRules = new Map(configured.map((item) => [asinIdentity(item), item]));
  const wildcardRules = new Map(configured.filter((item) => !item.storeKey).map((item) => [
    `${String(item.market || 'US').toUpperCase()}:${item.asin}`, item,
  ]));
  const unique = new Map();
  for (const discoveredItem of discovered) {
    const rule = configuredRules.get(asinIdentity(discoveredItem))
      || wildcardRules.get(`${String(discoveredItem.market || 'US').toUpperCase()}:${discoveredItem.asin}`);
    unique.set(asinIdentity(discoveredItem), rule
      ? { ...discoveredItem, ...rule, storeKey: discoveredItem.storeKey, source: 'voc+configured' }
      : discoveredItem);
  }
  for (const item of configured) unique.set(asinIdentity(item), item);

  const latestChecks = latestAsinChecks(config);
  const recheckDays = Math.max(1, Number(config.asinHealth?.recheckDays || 7));
  const inventory = [...unique.values()].map((item) => {
    const last = latestChecks.get(asinIdentity(item));
    // A product that two independent retail-page routes confirmed as absent
    // or unsellable must not consume a daily browser visit forever. Keep it in
    // the auditable inventory and recheck weekly so a relisted ASIN can return
    // automatically without an operator editing configuration.
    const autoDeferredInactive = item.monitoring === 'active' && last?.status === 'INACTIVE_LISTING';
    const effectiveItem = autoDeferredInactive ? {
      ...item,
      monitoring: 'weekly',
      monitoringReason: item.monitoringReason || `系统双路确认当前非激活/不可售，自动改为每 ${recheckDays} 天复核`,
    } : item;
    const c = cadence(effectiveItem, latestChecks, now, recheckDays);
    return {
      ...effectiveItem,
      due: effectiveItem.monitoring === 'disabled' ? false : c.due,
      lastStatus: c.lastCheck?.status || null,
      lastReason: c.lastCheck?.reason || null,
      lastCheckedAt: c.lastCheck?.checkedAt || null,
      nextCheckAt: c.nextCheckAt,
      autoDeferredInactive,
    };
  });
  const asins = inventory.filter((item) => item.monitoring !== 'disabled' && item.due);
  const deferredAsins = inventory.filter((item) => item.monitoring === 'weekly' && !item.due);
  const disabledAsins = inventory.filter((item) => item.monitoring === 'disabled');
  return {
    asins, inventory, deferredAsins, disabledAsins, file, missing,
    configuredCount: configured.filter((item) => item.monitoring !== 'disabled').length,
    discoveredCount: discovered.length,
    placeholderCount: placeholders.length,
    activeCount: inventory.filter((item) => item.monitoring === 'active' && item.lastStatus !== 'INACTIVE_LISTING').length,
    inactiveCount: inventory.filter((item) => item.lastStatus === 'INACTIVE_LISTING').length,
    weeklyCount: inventory.filter((item) => item.monitoring === 'weekly').length,
    deferredCount: deferredAsins.length,
    disabledCount: disabledAsins.length,
    recheckDays,
  };
}

/**
 * Split a report snapshot into current daily action results and assets whose
 * configured cadence is currently deferred/disabled. Historical reports stay
 * immutable and auditable; the dashboard simply stops presenting a known
 * low-frequency asset as an everyday open incident.
 */
export function filterCurrentAsinResults(results, asinInfo, storeKey = '') {
  const suppressed = new Set(
    [...(asinInfo?.deferredAsins || []), ...(asinInfo?.disabledAsins || [])]
      .map((item) => asinIdentity(item)),
  );
  const current = [];
  const deferred = [];
  for (const result of results || []) {
    const identity = asinIdentity({
      asin: result?.asin,
      storeKey: result?.storeKey || storeKey,
      market: result?.market || 'US',
    });
    (suppressed.has(identity) ? deferred : current).push(result);
  }
  return { current, deferred };
}

/** Group ASINs by the store browser they should be checked through. */
export function groupByStore(asins, stores) {
  const groups = new Map();
  for (const a of asins) {
    // A --store recovery must never route another shop's ASINs through the
    // selected browser. Only unassigned manual ASINs may use the first store.
    const store = a.storeKey ? stores.find((s) => s.key === a.storeKey) : stores[0];
    if (!store) continue;
    if (!groups.has(store.key)) groups.set(store.key, { store, asins: [] });
    groups.get(store.key).asins.push(a);
  }
  return [...groups.values()];
}

export function selectAsinsForRun(asins, requested = []) {
  const wanted = [...new Set((requested || []).map((value) => String(value || '').trim().toUpperCase()))];
  const invalid = wanted.filter((asin) => !/^B0[A-Z0-9]{8}$/.test(asin));
  if (invalid.length) throw new Error(`--asin 仅接受真实 10 位 ASIN: ${invalid.join(', ')}`);
  if (!wanted.length) return { asins: [...asins], missing: [] };
  const wantedSet = new Set(wanted);
  const selected = asins.filter((item) => wantedSet.has(String(item?.asin || '').toUpperCase()));
  const found = new Set(selected.map((item) => String(item.asin).toUpperCase()));
  return { asins: selected, missing: wanted.filter((asin) => !found.has(asin)) };
}

export function scopeAsinsToStores(asins, stores) {
  const allowed = new Set((stores || []).map((store) => String(store?.key || '')).filter(Boolean));
  if (!allowed.size) return [];
  return (asins || []).filter((item) => !item?.storeKey || allowed.has(String(item.storeKey)));
}

async function checkAsinsInStore({ zn, store, asins, config, logger, dirs, stamp, prevByAsin, onProgress }) {
  const z = config.ziniao;
  const results = [];

  const opened = await zn.storeOpen({
    id: store.id || undefined,
    name: store.id ? undefined : store.name,
    market: store.market,
    url: asinRetailOrigin(asins[0]),
    headless: z.headless,
    timeoutMs: z.openTimeoutMs,
  });
  let storeId = opened.storeId;
  logger.info(`[${CHECK_ID}] 通过店铺 ${store.key} 打开浏览器，待检 ${asins.length} 个 ASIN`);

  const pending = [...asins];
  const retried = new Set();
  let sessionRecoveryFailure = null;
  // Retail navigations retain renderer memory across products. A 4 GiB Linux
  // host exhausted RAM during an otherwise sequential store run (2026-09-11).
  // Bound visits in each native profile, independently of per-ASIN retries.
  const configuredSessionItems = Number(config.asinHealth?.sessionMaxItems ?? 10);
  const sessionMaxItems = Number.isSafeInteger(configuredSessionItems) && configuredSessionItems > 0
    ? Math.min(20, configuredSessionItems) : 10;
  let sessionVisits = 0;
  const reopenStore = async (a, reason, requireClose = false) => {
    try {
      await zn.storeClose(storeId);
    } catch (error) {
      // A crashed session may already be gone during error recovery. Planned
      // memory rotation, however, must confirm release before opening again.
      if (requireClose) {
        sessionRecoveryFailure = new Error(`店铺会话释放失败，已停止本店剩余页面访问，等待补采：${redactText(error.message)}`);
        sessionRecoveryFailure.code = 'STORE_SESSION_RECOVERY_FAILED';
        throw sessionRecoveryFailure;
      }
    }
    let reopened;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        reopened = await zn.storeOpen({
          id: store.id || undefined, name: store.id ? undefined : store.name,
          market: store.market, url: asinRetailOrigin(a),
          headless: z.headless, timeoutMs: z.openTimeoutMs,
        });
        break;
      } catch (error) {
        if (attempt === 0 && !isConfigMissingError(error)) {
          logger.warn(`[${CHECK_ID}/${store.key}] 店铺重开未成功，稍后再恢复一次`);
          await sleep(Math.max(0, Math.min(5000, Number(z.retryDelayMs ?? 2000))));
          continue;
        }
        sessionRecoveryFailure = new Error(`店铺会话恢复失败，已停止本店剩余页面访问，等待补采：${redactText(error.message)}`);
        sessionRecoveryFailure.code = 'STORE_SESSION_RECOVERY_FAILED';
        throw sessionRecoveryFailure;
      }
    }
    storeId = reopened.storeId;
    sessionVisits = 0;
    logger.warn(`[${CHECK_ID}/${a.asin}] ${reason}，已重启店铺浏览器`);
  };
  const restartStoreForRetry = async (a, reason) => {
    // Rotation must not consume this independent one-retry-per-ASIN budget.
    if (retried.has(a.asin) || sessionRecoveryFailure) return false;
    retried.add(a.asin);
    await reopenStore(a, reason);
    // The Amazon retail site exposes both canonical read-only product routes.
    // A poisoned Chromium error extension can be route-specific, so the one
    // bounded retry uses the alternate official product path while retaining
    // the same domain, store browser and ASIN identity gate. Do not re-check
    // the current page as a "prewarm" when this queued retry is eventually
    // reached: other ASINs have legitimately reused the session in between,
    // and their opaque retail iframes must not prevent navigation to the exact
    // retry target. The target itself is still gated by URL, live-page and
    // ASIN identity checks before any evidence is read.
    pending.push({ ...a, _productPath: 'gp-product' });
    logger.warn(`[${CHECK_ID}/${a.asin}] 将在本店队列末尾自动重试一次`);
    return true;
  };
  for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex++) {
    const a = pending[pendingIndex];
    onProgress?.({ type: 'asin', phase: 'started', check: CHECK_ID, storeKey: store.key, asin: a.asin });
    let retryScheduled = false;
    const started = Date.now();
    const url = asinUrl(a.asin, a.market, a.domain, a._productPath);
    const rec = {
      check: CHECK_ID, storeKey: store.key, asin: a.asin, market: a.market,
      label: a.label || null, url, status: 'ERROR', ok: false, severity: 'ERROR',
      confidence: 'low', verdictSource: 'none', metrics: {}, anomalyReasons: [], items: [],
      notes: [], durationMs: 0, screenshot: null, error: null, evidence: {},
    };

    try {
      if (sessionRecoveryFailure) throw sessionRecoveryFailure;
      if (sessionVisits >= sessionMaxItems) {
        await reopenStore(a, `已采集 ${sessionVisits} 个商品页，为释放浏览器内存轮换会话`, true);
      }
      sessionVisits++;
      const navigation = await zn.visit(storeId, url, {
        timeoutMs: config.asinHealth?.visitTimeoutMs ?? z.visitTimeoutMs,
        waitUntil: z.waitUntil,
      });
      const settleMs = config.asinHealth?.settleMs ?? z.settleMs;
      if (settleMs) await sleep(settleMs);

      let currentUrl = '';
      try { currentUrl = await currentPageUrl(zn, storeId, navigation); } catch (e) {
        rec.notes.push(`current URL 获取失败: ${redactText(e.message)}`);
      }
      let pageSafety = classifyUrlSafety(currentUrl);
      rec.url = pageSafety.currentUrl || sanitizeUrl(url);

      let dom = null;
      let txt = null;
      let pageText = '';

      for (let identityAttempt = 0; pageSafety.safe; identityAttempt++) {
        const navigationRawUrl = rawPageIdentity(pageSafety);
        const preLiveSafety = await classifyAsinProductReadSafety({ zn, storeId, expectedAsin: a.asin });
        const preRawUrl = rawPageIdentity(preLiveSafety);
        if (!preLiveSafety.safe) {
          pageSafety = preLiveSafety;
        } else if (!preRawUrl) {
          pageSafety = {
            ...preLiveSafety, safe: false, code: 'PAGE_CHANGED_BEFORE_EVIDENCE_READ',
            pageChangedBeforeEvidenceRead: true,
          };
        } else {
          // Amazon may finish a same-ASIN canonical/variant redirect between
          // navigation settling and the first live probe. The probe has
          // already verified the approved retail host, target ASIN and absence
          // of authentication/block state, so bind the evidence read to this
          // first stable live URL. The exact raw URL (query and fragment
          // included) must still remain unchanged through the post-read gate.
          const expectedRawUrl = preRawUrl;
          if (navigationRawUrl && navigationRawUrl !== preRawUrl) {
            rec.notes.push('商品页在首个安全探针前完成同 ASIN 规范化跳转，已绑定安全落地页读取');
          }
          let domTimedOut = false;
          try {
            dom = (await zn.execExtract(storeId, asinDetailDef.extractor, { timeoutMs: z.execTimeoutMs })).result;
          } catch (e) {
            domTimedOut = /\b(?:script timeout|renderer timeout|timed out|timeout)\b/i.test(String(e.message || ''));
            rec.notes.push(`DOM 提取失败: ${redactText(e.message)}`);
          }
          try {
            const c = await zn.content(storeId, { format: 'text', timeoutMs: z.contentTimeoutMs });
            pageText = c.text || '';
            txt = pageText ? asinDetailDef.parseText(pageText) : null;
            if (dom?.dogPage && !txt?.notFound) {
              // Read the actual accessible wording of Amazon's image-only
              // error page independently of the DOM verdict. This read stays
              // inside the same pre/post safety and exact-ASIN identity gates.
              const accessible = (await zn.execExtract(storeId, ASIN_IMAGE_ERROR_TEXT_EXTRACTOR, {
                timeoutMs: z.execTimeoutMs,
              })).result;
              if (accessible?.text) {
                pageText += `\n${accessible.text}`;
                txt = asinDetailDef.parseText(pageText);
              }
            }
          } catch (e) {
            rec.notes.push(`页面文本获取失败: ${redactText(e.message)}`);
          }

          const postLiveSafety = await classifyAsinProductReadSafety({ zn, storeId, expectedAsin: a.asin });
          const postRawUrl = rawPageIdentity(postLiveSafety);
          if (!postLiveSafety.safe) {
            pageSafety = postLiveSafety;
          } else if (!postRawUrl || postRawUrl !== expectedRawUrl) {
            pageSafety = {
              ...postLiveSafety, safe: false, code: 'PAGE_CHANGED_DURING_EVIDENCE_READ',
              pageChangedDuringEvidenceRead: true,
            };
          } else {
            currentUrl = postRawUrl;
            const observedAsin = String(dom?.asin || '').trim().toUpperCase();
            if (domTimedOut) {
              // Missing output after a renderer timeout is not evidence of a
              // different ASIN. Discard both paths and use the existing single
              // fresh-session retry; a real mismatch still fails closed below.
              pageSafety = Object.assign(postLiveSafety, {
                safe: false, code: 'ASIN_DOM_EXTRACTION_TIMEOUT',
              });
            } else if (observedAsin !== a.asin) {
              pageSafety = Object.assign(postLiveSafety, {
                safe: false,
                code: 'ASIN_DOM_IDENTITY_MISMATCH',
                identityMismatch: true,
                mainDocumentReadable: false,
              });
            } else {
              pageSafety = classifyPageSafety({ currentUrl, dom, txt, pageText });
              const preIsolated = preLiveSafety.isolatedUnreadableFrames === true;
              const postIsolated = postLiveSafety.isolatedUnreadableFrames === true;
              if (preIsolated || postIsolated) {
                Object.assign(pageSafety, {
                  isolatedUnreadableFrames: true,
                  mainDocumentRead: {
                    pre: preIsolated ? preLiveSafety.liveProbeDiagnostics : null,
                    post: postIsolated ? postLiveSafety.liveProbeDiagnostics : null,
                  },
                });
              }
            }
          }
        }
        rec.url = pageSafety.currentUrl || sanitizeUrl(url);
        if (!pageSafety.safe) {
          dom = null;
          txt = null;
          pageText = '';
        }
        if (!canRetryPageIdentity(pageSafety, identityAttempt, 2)) break;
        rec.notes.push(`商品页地址在读取期间变化，已丢弃证据并从零重试 (${identityAttempt + 1}/2)`);
        // Keep the same store and exact ASIN. The next iteration repeats both
        // live probes and both evidence paths, including query/fragment checks.
        await sleep(500);
        currentUrl = await currentPageUrl(zn, storeId);
        pageSafety = classifyUrlSafety(currentUrl);
      }

      if (!pageSafety.safe) {
        rec.status = pageSafety.blocked ? 'BLOCKED'
          : pageSafety.authSensitive ? 'LOGIN_REQUIRED'
            : pageSafety.emptyShell ? 'UNKNOWN' : 'ERROR';
        rec.severity = 'ERROR';
        rec.baselineEligible = false;
        rec.anomalyReasons.push(unsafePageReason(pageSafety));
        if (isRecoverableBrowserInternalSafety(pageSafety)) {
          const internalErrorCode = await diagnoseInternalBrowserError({ zn, storeId });
          if (internalErrorCode) rec.notes.push(`紫鸟内部错误类型: ${internalErrorCode}`);
        }
      } else if (!dom && !txt) {
        rec.status = 'UNKNOWN';
        rec.anomalyReasons.push('两条提取路径都失败，无法判断该 ASIN 状态');
      } else {
        const key = asinStateKey(store.key, a.market, a.asin);
        const v = asinDetailDef.judgeAsin({ dom, txt, prev: prevByAsin.get(key), asin: a.asin });
        Object.assign(rec, {
          status: v.status, ok: v.ok, severity: v.severity,
          anomalyReasons: sanitizeForStorage(v.reasons, { rootDir: config.outDir }),
          metrics: sanitizeForStorage(v.metrics, { rootDir: config.outDir }),
          confidence: v.confidence || (dom && txt ? 'high' : 'medium'),
          verdictSource: dom && txt ? 'dom+text' : dom ? 'dom' : 'text',
          productTitle: sanitizeForStorage(v.title, { rootDir: config.outDir }),
          baselineEligible: v.baselineEligible !== false && dom?.landed === true && txt?.landed === true,
        });
        // A verified missing/unavailable listing is a complete negative read,
        // so it cannot also require a successfully rendered active product.
        // judgeAsin only emits this verdict after both paths agree.
        const confirmedInactive = v.status === 'INACTIVE_LISTING'
          && v.metrics?.listingActive === false && v.metrics?.collectionStatus === 'COMPLETE';
        if (rec.ok && !confirmedInactive && !(dom?.landed === true && txt?.landed === true)) {
          rec.ok = false;
          rec.status = 'PARTIAL_EVIDENCE';
          rec.severity = 'ERROR';
          rec.confidence = 'low';
          rec.baselineEligible = false;
          rec.metrics.collectionStatus = 'PARTIAL_EVIDENCE';
          rec.anomalyReasons.push('只有一条提取路径确认商品页，不能据此下正常结论');
        }
      }
      rec.evidence = sanitizeForStorage({ dom, text: txt, safety: pageSafety }, { rootDir: config.outDir });

      const suppressUnsafeEvidence = (unsafeSafety, phase) => {
        pageSafety = unsafeSafety;
        dom = null;
        txt = null;
        pageText = '';
        rec.url = unsafeSafety.currentUrl || sanitizeUrl(url);
        rec.status = unsafeSafety.blocked ? 'BLOCKED'
          : unsafeSafety.authSensitive ? 'LOGIN_REQUIRED'
            : unsafeSafety.emptyShell ? 'UNKNOWN' : 'ERROR';
        rec.ok = false;
        rec.severity = 'ERROR';
        rec.confidence = 'low';
        rec.verdictSource = 'none';
        rec.baselineEligible = false;
        if (unsafeSafety.code === SECURITY_CLEANUP_FAILED) rec.error = SECURITY_CLEANUP_FAILED;
        rec.metrics = {};
        rec.items = [];
        rec.notes = [];
        delete rec.productTitle;
        rec.anomalyReasons = [
          unsafeSafety.code === SECURITY_CLEANUP_FAILED
            ? '截图证据安全清理失败，结果已阻断且需检查隔离区'
            : unsafeSafety.blocked
            ? `${phase}页面进入访问拦截，已抑制证据`
            : unsafeSafety.authSensitive
              ? `${phase}页面进入登录/验证码/Passkey 流程，已抑制证据`
              : `${phase}页面状态变化或 current URL 不可确认，已抑制证据`,
        ];
        rec.evidence = sanitizeForStorage({ dom: null, text: null, safety: unsafeSafety }, { rootDir: config.outDir });
        rec.screenshot = null;
      };

      // Screenshot only when something is wrong — one shot per bad ASIN keeps
      // a 200-ASIN run from filling the disk.
      let captureSafe = pageSafety.safe;
      if (config.storeHealth.screenshot && rec.severity !== 'OK' && captureSafe) {
        const captureGate = await classifyLivePageSafety({ zn, storeId });
        const captureUrlStable = rawPageIdentity(captureGate) === rawPageIdentity(pageSafety);
        const isolatedFrameCaptureBlock = !captureGate.safe
          && captureGate.code === 'LIVE_SAFETY_PROBE_INCOMPLETE'
          && captureGate.unreadableFramesOnly === true
          && captureUrlStable;
        captureSafe = captureGate.safe
          && captureUrlStable;
        if (isolatedFrameCaptureBlock) {
          rec.notes.push('截图因可见跨域 iframe 无法安全读取而跳过；主文档双路证据已保留');
          rec.evidence.capture = sanitizeForStorage({
            suppressed: true,
            code: 'UNREADABLE_VISIBLE_FRAME',
            liveProbeDiagnostics: captureGate.liveProbeDiagnostics,
          }, { rootDir: config.outDir });
        } else if (!captureSafe) {
          const rejectedGate = captureGate.safe
            ? { ...captureGate, safe: false, code: 'PAGE_CHANGED_BEFORE_SCREENSHOT' }
            : captureGate;
          suppressUnsafeEvidence(rejectedGate, '截图前');
        }
      }
      if (config.storeHealth.screenshot && rec.severity !== 'OK' && captureSafe) {
        const p = path.join(dirs.shots, `${CHECK_ID}_${filePart(store.key)}_${filePart(a.market)}_${a.asin}_${stamp}.png`);
        let shot = null;
        let screenshotThrew = false;
        let cleanupFailure = null;
        try {
          shot = await zn.screenshot(storeId, p, { fullPage: false });
        } catch {
          screenshotThrew = true;
          const cleaned = secureCleanupEvidenceSet({ files: [p], outDir: config.outDir });
          if (!cleaned.ok) cleanupFailure = cleaned;
        }
        const postSafety = await verifyPageAfterScreenshot({
          zn, storeId, expectedUrl: rawPageIdentity(pageSafety), dom, txt, pageText,
        });
        if (!postSafety.safe) {
          const cleaned = screenshotThrew
            ? secureCleanupEvidenceSet({ files: [p], outDir: config.outDir })
            : secureCleanupReportedEvidence({
                expectedFile: p, reportedFile: shot?.path, outDir: config.outDir,
              });
          if (!cleaned.ok) cleanupFailure = cleaned;
          suppressUnsafeEvidence(postSafety, '截图期间');
        } else if (
          shot?.path
          && path.resolve(String(shot.path)) === path.resolve(p)
          && validateEvidenceArtifact({ file: p, outDir: config.outDir }).ok
        ) {
          rec.screenshot = p;
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
          suppressUnsafeEvidence(cleanupFailureSafety(postSafety), '截图证据清理');
          logger.error(`[${CHECK_ID}/${store.key}/${a.asin}] 截图证据安全清理失败，结果已标记 ${SECURITY_CLEANUP_FAILED}`);
        }
      }
      if (isRecoverableAsinSafety(pageSafety) && !retried.has(a.asin)) {
        try {
          retryScheduled = await restartStoreForRetry(a,
            isRecoverableBrowserInternalSafety(pageSafety)
              ? '页面进入紫鸟/Chromium 内部错误页'
              : pageSafety.code === 'ASIN_DOM_EXTRACTION_TIMEOUT'
                ? '商品页 DOM 脚本执行超时'
                : '页面安全状态在只读采集期间发生瞬态变化');
        } catch (reopenError) {
          rec.notes.push(`店铺浏览器恢复失败: ${redactText(reopenError.message)}`);
          logger.warn(`[${CHECK_ID}/${a.asin}] 店铺浏览器恢复失败: ${redactText(reopenError.message)}`);
        }
      }
      // A retail shell can be a poisoned renderer even when the URL and live
      // safety probe still look healthy. A same-session revisit repeated the
      // shell in production, so reopen the same Ziniao store browser before
      // the one bounded queue-tail retry. It remains a collection failure when
      // the fresh session also cannot produce business evidence.
      if (rec.status === 'UNKNOWN' && pageSafety.emptyShell && !retried.has(a.asin)) {
        try {
          retryScheduled = await restartStoreForRetry(a, '商品页为空壳');
        } catch (reopenError) {
          rec.notes.push(`店铺浏览器恢复失败: ${redactText(reopenError.message)}`);
          logger.warn(`[${CHECK_ID}/${a.asin}] 店铺浏览器恢复失败: ${redactText(reopenError.message)}`);
        }
      }
      if (rec.status === 'UNKNOWN_RATING' && pageSafety.safe && !retried.has(a.asin)) {
        try {
          retryScheduled = await restartStoreForRetry(a, '商品页评分未完整加载');
        } catch (reopenError) {
          rec.notes.push(`店铺浏览器恢复失败: ${redactText(reopenError.message)}`);
        }
      }
    } catch (e) {
      rec.error = redactText(e.message);
      rec.status = isConfigMissingError(e) ? 'NOT_CONFIGURED' : 'ERROR';
      rec.severity = rec.status === 'NOT_CONFIGURED' ? 'WARN' : 'ERROR';
      rec.baselineEligible = false;
      rec.anomalyReasons.push(`检查失败: ${truncate(redactText(e.message), 160)}`);
      if (e.code === 'STORE_SESSION_RECOVERY_FAILED') {
        rec.evidence.safety = { safe: false, code: e.code, authSensitive: false, blocked: false };
      }
      if (isConfigMissingError(e)) throw e; // pointless to continue

      // A renderer timeout often poisons the attached Chromium session: every
      // later navigation then waits the full timeout and fails. Isolate that
      // one product by reopening the Ziniao store browser before continuing.
      try {
        retryScheduled = await restartStoreForRetry(a, '页面异常后');
      } catch (reopenError) {
        rec.notes.push(`店铺浏览器恢复失败: ${redactText(reopenError.message)}`);
        logger.warn(`[${CHECK_ID}/${a.asin}] 店铺浏览器恢复失败: ${redactText(reopenError.message)}`);
      }
    }

    if (retryScheduled) continue;
    rec.durationMs = Date.now() - started;
    rec.checkedAt = bjIso();
    results.push(rec);
    logger.info(`[${CHECK_ID}/${a.asin}] ${rec.status} 评分=${rec.metrics.rating ?? '-'}${rec.metrics.ratingDelta ? ` (${rec.metrics.ratingDelta})` : ''} 购物车=${rec.metrics.hasCart ? 'Y' : 'N'}`);
    if (typeof onProgress === 'function') onProgress({
      type: 'asin', phase: 'completed', check: CHECK_ID, storeKey: store.key, asin: a.asin,
      status: rec.status, severity: rec.severity,
    });
  }

  if (z.closeStoreAfterCheck) {
    try {
      await zn.storeClose(storeId);
    } catch { /* not fatal */ }
  }
  return results;
}

export async function runAsinHealth({ zn, config, stores, logger, opts = {} }) {
  const startedAt = new Date();
  const stamp = bjStamp(startedAt);
  const slot = opts.slot || 'adhoc';
  const runId = `${CHECK_ID}-${stamp}-${slot}`;
  const dirs = reportDirs({ outDir: config.outDir, check: CHECK_ID });
  fs.mkdirSync(dirs.shots, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirs.shots, 0o700);

  const {
    asins: dueAsins, inventory, deferredAsins, disabledAsins,
    configuredCount, discoveredCount, placeholderCount, activeCount, inactiveCount, weeklyCount, recheckDays,
  } = loadAsins(config, { now: startedAt });
  // An explicit operator recovery is allowed to bring a weekly asset forward
  // for immediate read-only verification. A disabled asset remains excluded.
  // Scope before selecting so the same ASIN owned by two stores is never
  // counted as two tasks or silently "found" in the wrong selected store.
  const requestedAsins = Array.isArray(opts.asin) ? opts.asin : [];
  const candidates = requestedAsins.length
    ? inventory.filter((item) => item.monitoring !== 'disabled')
    : dueAsins;
  const selection = selectAsinsForRun(scopeAsinsToStores(candidates, stores), requestedAsins);
  const asins = selection.asins;
  if (selection.missing.length) {
    logger.warn(`[${CHECK_ID}] 当前到期清单中找不到指定 ASIN，已忽略: ${selection.missing.join(', ')}`);
  }
  const stateStore = createStateStore({ outDir: config.outDir, name: CHECK_ID });
  const state = stateStore.read();
  const alerter = createAlerter({ config, logger, outDir: config.outDir });
  const currentDate = bjDateKey(startedAt);
  const comparisonDate = previousDateKey(currentDate);
  const prevByAsin = new Map();
  for (const [key, entry] of Object.entries(state.asins || {})) {
    if (!key.includes(':')) continue; // legacy ASIN-only keys are ambiguous across stores
    const day = entry?.days?.[comparisonDate];
    if (day && Number.isFinite(day.rating)) prevByAsin.set(key, { ...day, baselineDate: comparisonDate });
  }

  const summary = {
    check: CHECK_ID,
    checkNo: 5,
    checkTitle: 'ASIN 常规检查',
    requirement: asinDetailDef.requirement,
    runId,
    slot,
    timezone: 'Asia/Shanghai',
    comparisonDate,
    startedAt: bjIso(startedAt),
    finishedAt: bjIso(),
    execution: { mode: 'sequential', concurrencyLimit: 1, peakActive: 1 },
    selection: {
      targeted: requestedAsins.length > 0,
      requestedAsins: [...new Set(requestedAsins.map((asin) => String(asin).trim().toUpperCase()))],
    },
    totals: { total: 0, ok: 0, abnormal: 0, errors: 0, warnings: 0, notConfigured: 0 },
    results: [],
    alerts: [],
    crm: null,
    asinInventory: {
      total: inventory.length,
      active: activeCount,
      inactive: inactiveCount,
      weekly: weeklyCount,
      due: asins.length,
      deferred: deferredAsins.length,
      disabled: disabledAsins.length,
      recheckDays,
      items: [...deferredAsins, ...disabledAsins].map((item) => ({
        asin: item.asin,
        storeKey: item.storeKey,
        market: item.market,
        monitoring: item.monitoring,
        reason: item.monitoringReason || item.lastReason || null,
        lastStatus: item.lastStatus,
        lastCheckedAt: item.lastCheckedAt,
        nextCheckAt: item.nextCheckAt,
      })),
    },
  };

  if (!asins.length) {
    logger.warn(`[${CHECK_ID}] 本批没有到期的真实 ASIN（配置=${configuredCount}，VOC 自动发现=${discoveredCount}，低频待复核=${deferredAsins.length}，已停检=${disabledAsins.length}，已忽略示例=${placeholderCount}），跳过`);
    summary.skipped = true;
    summary.skipReason = inventory.length
      ? `本批没有到期 ASIN：${deferredAsins.length} 个处于每 ${recheckDays} 天复核，${disabledAsins.length} 个已人工停检`
      : '没有真实 ASIN：请填写 config/asins.json，或先成功运行 VOC 以自动发现店铺 ASIN；示例 ASIN 不会参与正式巡检';
    summary.finishedAt = bjIso();
    const { dir, files } = writeGenericReports({ outDir: config.outDir, check: CHECK_ID, summary });
    summary.reportDir = dir;
    summary.reportFiles = files;
    return summary;
  }

  const groups = groupByStore(asins, stores);
  opts.onProgress?.({ type: 'asin-plan', check: CHECK_ID, stores: groups.map((group) => ({ storeKey: group.store.key, total: group.asins.length })) });
  if (!groups.length) {
    summary.skipped = true;
    summary.skipReason = '没有可用的店铺来打开浏览器（先配置 config/stores.json）';
    summary.finishedAt = bjIso();
    const { dir, files } = writeGenericReports({ outDir: config.outDir, check: CHECK_ID, summary });
    summary.reportDir = dir;
    summary.reportFiles = files;
    return summary;
  }

  logger.info(`[${CHECK_ID}] ASIN 常规检查 — 本批 ${asins.length} 个（持续监测 ${activeCount} / 低频复核 ${weeklyCount} / 延后 ${deferredAsins.length} / 停检 ${disabledAsins.length}），分布在 ${groups.length} 个店铺浏览器，批次=${slot}`);

  const limit = Math.max(1, opts.concurrency ?? config.ziniao.concurrency ?? 1);
  const { results: grouped } = await mapWithConcurrency(
    groups,
    async (g) => {
      opts.onProgress?.({ type: 'store', phase: 'started', check: CHECK_ID, storeKey: g.store.key });
      try {
        const results = await checkAsinsInStore({
          zn, store: g.store, asins: g.asins, config, logger, dirs, stamp, prevByAsin,
          onProgress: opts.onProgress,
        });
        opts.onProgress?.({ type: 'store', phase: 'completed', check: CHECK_ID, storeKey: g.store.key,
          severity: results.some((result) => result.severity === 'ERROR') ? 'ERROR' : 'OK' });
        return results;
      } catch (e) {
        opts.onProgress?.({ type: 'store', phase: 'completed', check: CHECK_ID, storeKey: g.store.key, severity: 'ERROR' });
        logger.error(`[${CHECK_ID}/${g.store.key}] 整组失败: ${redactText(e.message)}`);
        return g.asins.map((a) => ({
          check: CHECK_ID, storeKey: g.store.key, asin: a.asin, market: a.market,
          url: asinUrl(a.asin, a.market, a.domain),
          status: isConfigMissingError(e) ? 'NOT_CONFIGURED' : 'ERROR',
          ok: false, severity: isConfigMissingError(e) ? 'WARN' : 'ERROR',
          confidence: 'low', verdictSource: 'none', metrics: {},
          anomalyReasons: [`检查失败: ${truncate(redactText(e.message), 160)}`], items: [], notes: [],
          durationMs: 0, screenshot: null, error: redactText(e.message), evidence: {}, checkedAt: bjIso(),
          baselineEligible: false,
        }));
      }
    },
    { limit, staggerMs: config.ziniao.staggerMs ?? 0, jitterMs: config.ziniao.jitterMs ?? 0 },
  );

  const results = grouped.flat().filter(Boolean);
  for (const r of results) {
    r.runId = runId;
    r.slot = slot;
  }
  summary.results = results;
  summary.asinInventory.activeObserved = results.filter((result) => result.metrics?.listingActive === true).length;
  summary.asinInventory.inactiveObserved = results.filter((result) => result.status === 'INACTIVE_LISTING').length;

  state.asins ||= {};
  for (const r of results) {
    if (!validRatingBaseline(r)) continue;
    const key = asinStateKey(r.storeKey, r.market, r.asin);
    const prior = state.asins[key] || {};
    const days = { ...(prior.days || {}) };
    days[currentDate] = {
      rating: r.metrics.rating,
      hasCart: r.metrics?.hasCart ?? null,
      status: r.status,
      checkedAt: r.checkedAt,
    };
    for (const day of Object.keys(days).sort().slice(0, -35)) delete days[day];
    state.asins[key] = {
      storeKey: r.storeKey, market: r.market, asin: r.asin, days,
      latestDate: currentDate, lastRunAt: r.checkedAt,
    };
  }
  stateStore.write(state);

  summary.totals = {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    abnormal: results.filter((r) => !r.ok).length,
    errors: results.filter((r) => r.severity === 'ERROR').length,
    warnings: results.filter((r) => r.severity === 'WARN').length,
    notConfigured: results.filter((r) => r.status === 'NOT_CONFIGURED').length,
  };
  summary.finishedAt = bjIso();
  summary.durationMs = Date.now() - startedAt.getTime();
  summary.execution.concurrencyLimit = limit;

  const { dir, files } = writeGenericReports({ outDir: config.outDir, check: CHECK_ID, summary });
  summary.reportDir = dir;
  summary.reportFiles = files;

  const problems = results.filter((r) => r.severity !== 'OK');
  if (problems.length) {
    for (const group of partitionAlertProblems(problems)) {
      summary.alerts.push(await alerter.send({
        check: CHECK_ID,
        severity: group.severity,
        title: `[5/${CHECK_TOTAL}] ASIN 常规检查异常：${group.problems.length}/${results.length} 个 ASIN（${slot}）`,
        lines: [
          ...group.problems.slice(0, 20).map((p) => `**${p.asin}** (${p.market}) → ${p.status} · ${p.anomalyReasons.join('；')}`),
          group.problems.length > 20 ? `…另有 ${group.problems.length - 20} 个，见报表` : '',
        ].filter(Boolean),
        data: { runId, totals: summary.totals },
      }));
    }
  }

  summary.crm = await pushToCrmSafely({
    config, logger,
    payload: { source: 'singal-amz-guard', ...summary, results: undefined, records: results },
  });

  writeGenericReports({ outDir: config.outDir, check: CHECK_ID, summary });
  return summary;
}
