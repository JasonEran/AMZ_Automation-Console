import fs from 'node:fs';
import path from 'node:path';
import { artifactPart } from '../lib/artifact-name.js';
import { POLICY_COMPLIANCE_EXTRACTOR } from '../extractors/policy-compliance.js';
import { createAlerter, partitionAlertProblems } from '../lib/alert.js';
import { codexClassifyPolicyCompliance } from '../lib/codex.js';
import { pushToCrmSafely } from '../lib/crm.js';
import {
  SECURITY_CLEANUP_FAILED, cleanupFailureSafety, secureCleanupEvidenceSet,
  secureCleanupReportedEvidence, validateEvidenceArtifact,
} from '../lib/evidence-cleanup.js';
import { mapWithConcurrency } from '../lib/pool.js';
import {
  classifyLivePageSafety, classifyPageSafety, classifyUrlSafety, currentPageUrl,
  isRecoverableBrowserInternalSafety, rawPageIdentity, verifyPageAfterScreenshot,
} from '../lib/page-safety.js';
import { reportDirs, writeReports } from '../lib/report.js';
import { redactText, sanitizeUrl } from '../lib/redact.js';
import { createStateStore } from '../lib/state.js';
import { bjIso, bjStamp, detectSlot, sleep } from '../lib/time.js';
import { STATUS_LABELS, isDecided, parsePolicyComplianceText, reconcile, severityOf } from '../lib/verdict.js';
import { isConfigMissingError, truncate } from '../lib/ziniao.js';

export const CHECK_NAME = 'store-health';
const CHECK_VERSION = '1.0.0';

/**
 * Item 1 of 8: store health check.
 *
 * Verdict rule, straight from the requirement: Policy Compliance == Healthy is
 * normal; anything else is an anomaly. "Anything else" deliberately includes
 * "we could not read the card" — a check that cannot confirm health must shout,
 * not stay quiet.
 *
 * Amazon is only ever touched inside a store browser started by Ziniao. The
 * default transport is the official WebDriver HTTP API plus Selenium; the old
 * ziniao-cli/ZClaw transport remains an explicit compatibility fallback.
 */

function buildUrls(store, cfg) {
  const paths = store.paths || cfg.paths;
  const host = store.host || cfg.defaultHost;
  return paths.map((p) => `https://${host}${p}`);
}

/** Open the store, land on an Account Health URL, and read the card two ways. */
async function probeStore({ zn, store, config, logger, dirs, stamp }) {
  const zcfg = config.ziniao;
  const scfg = config.storeHealth;
  const urls = buildUrls(store, scfg);

  const opened = await zn.storeOpen({
    id: store.id || undefined,
    name: store.id ? undefined : store.name,
    market: store.market,
    url: urls[0],
    headless: zcfg.headless,
    timeoutMs: zcfg.openTimeoutMs,
  });
  const storeId = opened.storeId;
  logger.info(`[${store.key}] 紫鸟店铺浏览器已打开${opened.storeName ? ` (${opened.storeName})` : ''}`);
  if (opened.kernelDownloading) {
    logger.warn(`[${store.key}] 紫鸟正在下载浏览器内核，本次可能较慢`);
  }

  let openedPageUrl = '';
  try { openedPageUrl = await currentPageUrl(zn, storeId); } catch { /* visit below remains authoritative */ }
  let mayReuseOpenedPage = true;

  const trail = [];
  let best = null;

  for (const url of urls) {
    trail.push({ url: sanitizeUrl(url), step: 'visit' });
    let navigation = null;
    const openedSafety = mayReuseOpenedPage ? classifyUrlSafety(openedPageUrl) : null;
    const targetSafety = mayReuseOpenedPage ? classifyUrlSafety(url) : null;
    const reuseOpenedPage = openedSafety?.safe === true
      && targetSafety?.safe === true
      && rawPageIdentity(openedSafety) === rawPageIdentity(targetSafety);
    mayReuseOpenedPage = false;
    if (reuseOpenedPage) {
      navigation = { url: openedPageUrl };
      trail[trail.length - 1].step = 'reuse-opened-page';
    } else {
      try {
        navigation = await zn.visit(storeId, url, { timeoutMs: zcfg.visitTimeoutMs, waitUntil: zcfg.waitUntil });
      } catch (e) {
        logger.warn(`[${store.key}] 打开 ${sanitizeUrl(url)} 失败: ${redactText(e.message)}`);
        trail[trail.length - 1].error = redactText(e.message);
        continue;
      }
    }
    if (zcfg.settleMs) await sleep(zcfg.settleMs);

    let currentUrl = '';
    try {
      currentUrl = await currentPageUrl(zn, storeId, navigation);
    } catch (e) {
      trail[trail.length - 1].currentUrlError = redactText(e.message);
    }
    let safety = classifyUrlSafety(currentUrl);
    trail[trail.length - 1].currentUrl = safety.currentUrl;
    trail[trail.length - 1].safetyCode = safety.code;
    if (!safety.safe) {
      const attempt = {
        url: safety.currentUrl, dom: null, domError: null, txt: null, textError: null,
        pageText: '', safety,
      };
      if (!best) best = attempt;
      logger.warn(`[${store.key}] ${safety.authSensitive ? '认证/拦截页面' : '导航后 current URL 不可确认'}，禁止采集与截图`);
      if (safety.authSensitive) break;
      continue;
    }

    const expectedRawUrl = rawPageIdentity(safety);
    const preLiveSafety = await classifyLivePageSafety({ zn, storeId });
    const preRawUrl = rawPageIdentity(preLiveSafety);
    if (!preLiveSafety.safe || !expectedRawUrl || preRawUrl !== expectedRawUrl) {
      safety = preLiveSafety.safe
        ? {
            ...preLiveSafety, safe: false, code: 'PAGE_CHANGED_BEFORE_EVIDENCE_READ',
            pageChangedBeforeEvidenceRead: true,
          }
        : preLiveSafety;
      trail[trail.length - 1].currentUrl = safety.currentUrl;
      trail[trail.length - 1].safetyCode = safety.code;
      const attempt = {
        url: safety.currentUrl, dom: null, domError: null, txt: null, textError: null,
        pageText: '', safety,
      };
      if (!best || safety.authSensitive) best = attempt;
      logger.warn(`[${store.key}] 页面安全探针未通过或采集前页面发生变化，禁止读取 DOM/文本`);
      if (safety.authSensitive) break;
      continue;
    }

    // Path A — DOM extraction inside the page.
    let dom = null;
    let domError = null;
    try {
      const r = await zn.execExtract(storeId, POLICY_COMPLIANCE_EXTRACTOR, {
        timeoutMs: zcfg.execTimeoutMs,
      });
      dom = r.result;
      if (dom?.url) dom.url = sanitizeUrl(dom.url);
      dom._via = r.via;
    } catch (e) {
      domError = redactText(e.message);
      logger.warn(`[${store.key}] DOM 提取失败: ${domError}`);
    }

    // Path B — full page text, parsed in Node. Independent of exec semantics.
    let pageText = '';
    let textError = null;
    try {
      const c = await zn.content(storeId, { format: 'text', timeoutMs: zcfg.contentTimeoutMs });
      pageText = c.text || '';
    } catch (e) {
      textError = redactText(e.message);
      logger.warn(`[${store.key}] 页面文本获取失败: ${textError}`);
    }
    let txt = pageText ? parsePolicyComplianceText(pageText) : null;

    const postLiveSafety = await classifyLivePageSafety({ zn, storeId });
    const postRawUrl = rawPageIdentity(postLiveSafety);
    if (!postLiveSafety.safe) {
      safety = postLiveSafety;
    } else if (!postRawUrl || postRawUrl !== expectedRawUrl) {
      safety = {
        ...postLiveSafety, safe: false, code: 'PAGE_CHANGED_DURING_EVIDENCE_READ',
        pageChangedDuringEvidenceRead: true,
      };
    } else {
      currentUrl = postRawUrl;
      safety = classifyPageSafety({ currentUrl, dom, txt, pageText });
    }
    trail[trail.length - 1].currentUrl = safety.currentUrl;
    trail[trail.length - 1].safetyCode = safety.code;
    if (!safety.safe) {
      dom = null;
      txt = null;
      pageText = '';
      domError = null;
      textError = null;
    }

    const attempt = { url: safety.currentUrl, dom, domError, txt, textError, pageText, safety };
    trail[trail.length - 1].domStatus = dom?.status ?? null;
    trail[trail.length - 1].textStatus = txt?.status ?? null;

    // Landing on the right page is what makes a reading trustworthy; keep the
    // first URL that actually rendered the card and stop trying alternatives.
    const landed = dom?.hasPolicyComplianceText || txt?.hasPolicyComplianceText;
    if (!best || safety.authSensitive) best = attempt;
    if (safety.authSensitive) {
      logger.warn(`[${store.key}] 页面出现登录/验证码/Passkey/拦截信号，DOM 与文本证据已抑制`);
      break;
    }
    if (landed) {
      best = attempt;
      break;
    }
    logger.warn(`[${store.key}] ${sanitizeUrl(url)} 未渲染出 Policy Compliance 卡片，尝试下一个地址`);
  }

  // Authentication/MFA/robot pages can display account identifiers or a
  // Ziniao-filled one-time code. Never capture those pages as evidence.
  let evidenceSafe = best?.safety?.safe === true;
  let authSensitive = best?.safety?.authSensitive === true;
  let captureSafe = evidenceSafe;
  if (scfg.screenshot && captureSafe) {
    const captureGate = await classifyLivePageSafety({ zn, storeId });
    captureSafe = captureGate.safe
      && rawPageIdentity(captureGate) === rawPageIdentity(best.safety);
    if (!captureSafe) {
      const rejectedGate = captureGate.safe
        ? { ...captureGate, safe: false, code: 'PAGE_CHANGED_BEFORE_SCREENSHOT' }
        : captureGate;
      evidenceSafe = false;
      authSensitive = rejectedGate.authSensitive === true;
      best = {
        ...(best || {}), url: rejectedGate.currentUrl, dom: null, txt: null, pageText: '',
        domError: null, textError: null, safety: rejectedGate,
      };
      for (const step of trail) {
        delete step.domStatus;
        delete step.textStatus;
      }
      logger.warn(`[${store.key}] 截图前页面安全状态变化，已抑制本次 DOM/文本证据且不会调用截图`);
    }
  }

  // Evidence, captured only for a genuine business page.
  let screenshot = null;
  if (scfg.screenshot && evidenceSafe && !authSensitive && captureSafe) {
    const p = path.join(dirs.shots, `${artifactPart(store.key)}_${stamp}.png`);
    let shot = null;
    let screenshotThrew = false;
    let cleanupFailure = null;
    try {
      shot = await zn.screenshot(storeId, p, { fullPage: scfg.fullPageScreenshot });
    } catch (e) {
      screenshotThrew = true;
      const cleaned = secureCleanupEvidenceSet({ files: [p], outDir: config.outDir });
      if (!cleaned.ok) cleanupFailure = cleaned;
      logger.warn(`[${store.key}] 截图失败: ${redactText(e.message)}`);
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
      authSensitive = postSafety.authSensitive === true;
      captureSafe = false;
      best = {
        ...(best || {}), url: postSafety.currentUrl, dom: null, txt: null, pageText: '',
        domError: null, textError: null, safety: postSafety,
      };
      for (const step of trail) {
        delete step.domStatus;
        delete step.textStatus;
      }
      if (!cleanupFailure) {
        logger.warn(`[${store.key}] 截图期间页面状态变化，截图已安全清理并抑制本次 DOM/文本证据`);
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
      authSensitive = false;
      captureSafe = false;
      best = {
        ...(best || {}), url: failedSafety.currentUrl, dom: null, txt: null, pageText: '',
        domError: null, textError: null, safety: failedSafety,
      };
      for (const step of trail) {
        delete step.domStatus;
        delete step.textStatus;
      }
      logger.error(`[${store.key}] 截图证据安全清理失败，结果已标记 ${SECURITY_CLEANUP_FAILED}`);
    }
  }

  let rawTextFile = null;
  if (scfg.saveRawPageText && best?.pageText && evidenceSafe && !authSensitive) {
    try {
      fs.mkdirSync(dirs.raw, { recursive: true, mode: 0o700 });
      rawTextFile = path.join(dirs.raw, `${artifactPart(store.key)}_${stamp}.txt`);
      fs.writeFileSync(rawTextFile, redactText(best.pageText), { mode: 0o600 });
    } catch (e) {
      logger.warn(`[${store.key}] 页面文本落盘失败: ${redactText(e.message)}`);
      rawTextFile = null;
    }
  }

  return { storeId, best, trail, screenshot, rawTextFile, authSensitive };
}

function hasPolicyBusinessEvidence(dom, txt) {
  return dom?.hasPolicyComplianceText === true || txt?.hasPolicyComplianceText === true;
}

function hasDualHealthyEvidence(safety, dom, txt) {
  return safety?.safe === true
    && dom?.hasPolicyComplianceText === true
    && txt?.hasPolicyComplianceText === true
    && dom?.status === 'HEALTHY'
    && txt?.status === 'HEALTHY';
}

async function checkOneStore({
  zn, store, config, logger, dirs, stamp, prevState, codexClassifier,
}) {
  const zcfg = config.ziniao;
  const scfg = config.storeHealth;
  const started = Date.now();

  const result = {
    check: CHECK_NAME,
    storeKey: store.key,
    storeName: store.name || null,
    market: store.market || null,
    url: null,
    status: 'ERROR',
    statusRaw: null,
    ok: false,
    severity: 'ERROR',
    confidence: 'low',
    verdictSource: 'none',
    ahrScore: null,
    ahrScoreMax: null,
    ahrScorePrev: prevState?.ahrScore ?? null,
    ahrDelta: null,
    statusPrev: prevState?.status ?? null,
    statusChanged: false,
    anomalyReasons: [],
    notes: [],
    attempts: 0,
    durationMs: 0,
    screenshot: null,
    rawTextFile: null,
    error: null,
    evidence: { dom: null, text: null, codex: null, trail: [] },
  };

  let lastError = null;
  const maxAttempts = Math.max(1, (zcfg.retries ?? 2) + 1);
  let probe = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result.attempts = attempt;
    try {
      probe = await probeStore({ zn, store, config, logger, dirs, stamp });
      if (isRecoverableBrowserInternalSafety(probe?.best?.safety) && attempt < maxAttempts) {
        try { await zn.storeClose(probe.storeId); } catch { /* poisoned session */ }
        probe = null;
        throw new Error('紫鸟店铺浏览器进入内部错误页，已关闭并准备重试');
      }
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      logger.warn(`[${store.key}] 第 ${attempt}/${maxAttempts} 次检查失败: ${redactText(e.message)}`);
      if (isConfigMissingError(e)) break; // retrying will not help
      if (attempt < maxAttempts) await sleep(zcfg.retryDelayMs ?? 8000);
    }
  }

  if (probe) {
    result.screenshot = probe.screenshot;
    result.rawTextFile = probe.rawTextFile;
    result.evidence.trail = probe.trail;
    result.url = sanitizeUrl(probe.best?.url ?? null);

    const dom = probe.best?.dom ?? null;
    const txt = probe.best?.txt ?? null;
    const safety = probe.best?.safety || classifyPageSafety({
      currentUrl: probe.best?.url,
      dom,
      txt,
      pageText: probe.best?.pageText,
    });
    result.evidence.dom = dom
      ? {
          status: dom.status,
          statusRaw: dom.statusRaw,
          statusSource: dom.statusSource,
          statusVariant: dom.statusVariant,
          score: dom.score,
          scoreSource: dom.scoreSource,
          scoreCandidates: dom.scoreCandidates,
          statusCandidates: dom.statusCandidates,
          cardFound: dom.cardFound,
          cardText: dom.cardText,
          pageTextLength: dom.pageTextLength,
          title: dom.title,
          url: dom.url,
          notes: dom.notes,
          via: dom._via,
        }
      : { error: probe.best?.domError ?? 'no dom result' };
    result.evidence.text = txt
      ? { status: txt.status, statusRaw: txt.statusRaw, score: txt.score, window: txt.window, notes: txt.notes }
      : { error: probe.best?.textError ?? 'no page text' };
    result.evidence.safety = safety;

    const verdict = reconcile(dom, txt);
    result.status = safety.blocked ? 'BLOCKED'
      : safety.authSensitive ? 'LOGIN_REQUIRED'
        : safety.code === SECURITY_CLEANUP_FAILED
          || safety.liveProbeUnavailable || /^PAGE_CHANGED_/.test(String(safety.code || '')) ? 'ERROR'
        : verdict.status;
    result.verdictSource = verdict.source;
    result.confidence = verdict.confidence;
    result.ahrScore = verdict.score;
    result.ahrScoreMax = dom?.scoreMax ?? null;
    result.statusRaw = dom?.statusRaw ?? txt?.statusRaw ?? null;
    result.notes = verdict.notes;
    if (safety.code === SECURITY_CLEANUP_FAILED) {
      result.error = SECURITY_CLEANUP_FAILED;
      result.notes.push('截图证据安全清理失败，结果已阻断且需检查受保护隔离区');
    }
    if (probe.authSensitive) result.notes.push('认证或验证码页面不保存截图和原始文本');

    // Codex arbitrates only what the deterministic paths could not settle.
    // It must never run for an unsafe page or for evidence that did not even
    // establish the Policy Compliance business surface.
    if (
      safety.safe === true
      && hasPolicyBusinessEvidence(dom, txt)
      && verdict.needsArbitration
      && config.codex?.enabled
    ) {
      logger.info(`[${store.key}] 确定性解析不可靠（${verdict.confidence}），调用 Codex 兜底判定`);
      const cx = await codexClassifier({
        config,
        logger,
        pageText: probe.best?.pageText || '',
        cardText: dom?.cardText || null,
        domStatus: dom?.status,
        textStatus: txt?.status,
        storeKey: store.key,
      });
      result.evidence.codex = cx;
      if (cx?.ok) {
        const before = result.status;
        // Trust Codex only where the deterministic layer had nothing, or to
        // escalate a conflict; never to downgrade a confirmed anomaly.
        if (!isDecided(before) && isDecided(cx.status)) {
          result.status = cx.status;
          result.verdictSource = `${verdict.source}+codex`;
          result.confidence = cx.confidence === 'high' ? 'medium' : 'low';
          result.notes.push(`Codex 判定 ${cx.status}（依据: ${truncate(cx.evidence || '', 160)}）`);
          if (result.ahrScore === null && Number.isFinite(cx.score)) result.ahrScore = cx.score;
        } else if (isDecided(before) && cx.status !== before) {
          result.notes.push(`Codex 判定 ${cx.status}，与确定性结果 ${before} 不一致，保留 ${before} 并标记待人工复核`);
          result.confidence = 'conflict';
        } else {
          result.notes.push(`Codex 判定与确定性结果一致 (${cx.status})`);
          if (result.confidence === 'conflict') result.confidence = 'medium';
        }
      }
    } else if (verdict.needsArbitration) {
      result.notes.push(
        safety.safe !== true
          ? '页面安全门禁未通过，禁止将页面证据交给 Codex 仲裁'
          : !hasPolicyBusinessEvidence(dom, txt)
            ? '未取得 Policy Compliance 业务证据，禁止调用 Codex 猜测'
            : '需要兜底判定，但 Codex 未启用',
      );
    }

    // Final invariant, deliberately after every arbitration path: only two
    // independent, explicit Healthy readings from a safe business page may
    // produce HEALTHY/OK. No Codex response can waive this requirement.
    if (result.status === 'HEALTHY' && !hasDualHealthyEvidence(safety, dom, txt)) {
      result.status = 'PARTIAL_EVIDENCE';
      result.verdictSource = dom?.status === 'HEALTHY' ? 'dom' : txt?.status === 'HEALTHY' ? 'text' : 'none';
      result.confidence = 'low';
      result.notes.push('未获得 DOM 与页面文本双路明确 Healthy，不能输出正常');
    }
  }

  if (lastError) {
    result.status = 'ERROR';
    result.error = redactText(lastError.message);
    if (isConfigMissingError(lastError)) {
      result.notes.push('紫鸟传输层未配置：WebDriver 模式请设置本机凭据；CLI 模式请执行 `ziniao-cli config init`');
    }
  }

  // ---- final classification --------------------------------------------
  result.ok = result.status === 'HEALTHY';
  result.severity = result.error || result.status === 'PARTIAL_EVIDENCE' ? 'ERROR' : severityOf(result.status);

  if (!result.ok) {
    result.anomalyReasons.push(
      result.error
        ? `检查执行失败: ${truncate(result.error, 200)}`
        : `Policy Compliance = ${STATUS_LABELS[result.status] || result.status}（非 Healthy）`,
    );
  }

  if (Number.isFinite(result.ahrScore) && Number.isFinite(result.ahrScorePrev)) {
    result.ahrDelta = result.ahrScore - result.ahrScorePrev;
    if (scfg.alertOnAhrDrop && result.ahrDelta <= -(scfg.ahrDropThreshold ?? 1)) {
      result.anomalyReasons.push(
        `账户健康评分下降 ${result.ahrScorePrev} → ${result.ahrScore} (${result.ahrDelta})`,
      );
      if (result.severity === 'OK') result.severity = 'WARN';
    }
  }

  if (result.statusPrev && result.statusPrev !== result.status) {
    result.statusChanged = true;
    if (scfg.alertOnStatusChange) {
      if (result.status === 'HEALTHY') {
        // A recovery is important history, but it is not a current business
        // problem. Keeping it in anomalyReasons made a dual-evidence Healthy
        // shop look yellow in the executive dashboard indefinitely.
        result.notes.push(`状态已恢复：${result.statusPrev} → ${result.status}`);
      } else {
        result.anomalyReasons.push(`状态发生变化：${result.statusPrev} → ${result.status}`);
        if (result.severity === 'OK') result.severity = 'WARN';
      }
    }
  }

  if (result.confidence === 'conflict') {
    result.anomalyReasons.push('判定来源存在冲突，建议人工复核截图');
    if (result.severity === 'OK') result.severity = 'WARN';
  }

  result.durationMs = Date.now() - started;

  // ---- release the browser ---------------------------------------------
  const shouldClose = zcfg.closeStoreAfterCheck && !(zcfg.keepOpenOnFailure && result.severity !== 'OK');
  if (probe?.storeId && shouldClose) {
    try {
      await zn.storeClose(probe.storeId);
      logger.debug(`[${store.key}] 店铺已关闭`);
    } catch (e) {
      logger.warn(`[${store.key}] 关闭店铺失败: ${redactText(e.message)}`);
    }
  } else if (probe?.storeId) {
    logger.info(`[${store.key}] 保留紫鸟店铺浏览器窗口以便人工复核`);
  }

  return result;
}

export async function runStoreHealth({
  zn, config, stores, logger, opts = {}, codexClassifier = codexClassifyPolicyCompliance,
}) {
  const startedAt = new Date();
  const stamp = bjStamp(startedAt);
  const slot = opts.slot || detectSlot(config.schedule?.slots, startedAt);
  const runId = `${CHECK_NAME}-${stamp}-${slot}`;
  const dirs = reportDirs({ outDir: config.outDir, check: CHECK_NAME });
  fs.mkdirSync(dirs.shots, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dirs.shots, 0o700); } catch { /* non-POSIX */ }

  const stateStore = createStateStore({ outDir: config.outDir, name: CHECK_NAME });
  const state = stateStore.read();
  const alerter = createAlerter({ config, logger, outDir: config.outDir });

  // Concurrency is across stores only; every step within a store stays ordered.
  const limit = Math.max(1, opts.concurrency ?? config.ziniao.concurrency ?? 1);
  const staggerMs = config.ziniao.staggerMs ?? 0;
  const jitterMs = config.ziniao.jitterMs ?? 0;

  logger.info(
    `开始店铺健康检查：${stores.length} 个店铺，批次=${slot}，` +
      `${limit > 1 ? `并发=${limit}` : '步进(并发=1)'}${staggerMs || jitterMs ? `，错开=${staggerMs}+~${jitterMs}ms` : ''}，run=${runId}`,
  );
  if (limit > 1) {
    logger.warn(
      '已启用跨店并发。请确认紫鸟里每个店铺都有独立的 IP / 指纹环境——' +
        '共用环境的店铺同时活动会放大账号关联风险。',
    );
  }

  // Snapshot previous state before any task runs, so concurrent tasks all
  // compare against the same baseline rather than each other's writes.
  const prevByKey = new Map(stores.map((s) => [s.key, state.stores?.[s.key]]));

  const { results, peakActive } = await mapWithConcurrency(
    stores,
    async (store) => {
      opts.onProgress?.({ type: 'store', phase: 'started', check: CHECK_NAME, storeKey: store.key });
      logger.info(`--- [${store.key}] ${store.name || '店铺'} ---`);
      let r;
      try {
        r = await checkOneStore({
          zn, store, config, logger, dirs, stamp,
          prevState: prevByKey.get(store.key),
          codexClassifier,
        });
      } catch (e) {
        // Belt and braces: one store must never abort the whole patrol.
        logger.error(`[${store.key}] 未捕获异常: ${redactText(e.stack || e.message)}`);
        r = {
          check: CHECK_NAME, storeKey: store.key, storeName: store.name || null,
          market: store.market || null, url: null, status: 'ERROR', ok: false, severity: 'ERROR',
          confidence: 'low', verdictSource: 'none', ahrScore: null, ahrScoreMax: null,
          ahrScorePrev: null, ahrDelta: null, statusPrev: null, statusChanged: false,
          anomalyReasons: [`检查执行失败: ${truncate(redactText(e.message), 200)}`], notes: [], attempts: 0,
          durationMs: 0, screenshot: null, rawTextFile: null, error: redactText(e.message),
          evidence: { dom: null, text: null, codex: null, trail: [] },
        };
      }
      r.runId = runId;
      r.slot = slot;
      r.checkedAt = bjIso();

      logger.info(
        `[${r.storeKey}] 判定 ${r.status}（${r.ok ? '正常' : '异常'}）` +
          `${r.ahrScore !== null ? ` AHR=${r.ahrScore}` : ''} 来源=${r.verdictSource}/${r.confidence}`,
      );
      opts.onProgress?.({ type: 'store', phase: 'completed', check: CHECK_NAME, storeKey: store.key, status: r.status, severity: r.severity });
      return r;
    },
    { limit, staggerMs, jitterMs },
  );

  state.stores ||= {};
  for (const r of results) {
    if (!isDecided(r.status)) continue;
    state.stores[r.storeKey] = {
      status: r.status,
      ahrScore: r.ahrScore,
      lastRunAt: r.checkedAt,
      lastRunId: runId,
      ok: r.ok,
    };
  }
  stateStore.write(state);

  const totals = {
    total: results.length,
    // `ok` is the field the dashboard and the CLI summary read; `healthy` is kept
    // as the domain-specific alias this check has always reported.
    ok: results.filter((r) => r.ok).length,
    healthy: results.filter((r) => r.ok).length,
    abnormal: results.filter((r) => !r.ok).length,
    undetermined: results.filter((r) => !isDecided(r.status)).length,
    errors: results.filter((r) => r.severity === 'ERROR').length,
    warnings: results.filter((r) => r.severity === 'WARN').length,
  };

  const summary = {
    check: CHECK_NAME,
    checkNo: 1,
    checkTitle: '店铺健康状态检查 (Policy Compliance)',
    requirement: '第 1 项：Policy Compliance 显示 Healthy 为正常，其他一律异常',
    version: CHECK_VERSION,
    runId,
    slot,
    timezone: 'Asia/Shanghai',
    startedAt: bjIso(startedAt),
    finishedAt: bjIso(),
    durationMs: Date.now() - startedAt.getTime(),
    execution: {
      mode: limit > 1 ? 'concurrent' : 'sequential',
      concurrencyLimit: limit,
      peakActive,
      staggerMs,
      jitterMs,
      note: '并发仅作用于店铺之间；单个店铺内部的步骤始终串行。',
    },
    totals,
    results,
    alerts: [],
    crm: null,
  };

  // ---- export -----------------------------------------------------------
  const { dir, files } = writeReports({ outDir: config.outDir, check: CHECK_NAME, summary });
  summary.reportDir = dir;
  summary.reportFiles = files;
  logger.info(`报表已生成: ${files.json}`);
  logger.info(`CRM 导入用 CSV: ${files.csv}`);

  // ---- alerts -----------------------------------------------------------
  const problems = results.filter((r) => r.severity !== 'OK');
  if (problems.length) {
    for (const group of partitionAlertProblems(problems)) {
      const alert = await alerter.send({
        check: CHECK_NAME,
        severity: group.severity,
        title: `店铺健康检查异常：${group.problems.length}/${totals.total} 个店铺需要处理（${slot} 批次）`,
        lines: [
          ...group.problems.map(
            (p) =>
              `**${p.storeKey}**${p.storeName ? ` (${p.storeName})` : ''} → ${STATUS_LABELS[p.status] || p.status}` +
              `${p.ahrScore !== null ? ` · AHR ${p.ahrScore}` : ''}` +
              `${p.anomalyReasons.length ? ` · ${p.anomalyReasons.join('；')}` : ''}`,
          ),
        ],
        data: {
          runId, totals,
          stores: group.problems.map((p) => ({
            storeKey: p.storeKey,
            status: p.status,
            severity: p.severity,
            ahrScore: p.ahrScore,
            reasons: p.anomalyReasons,
            screenshot: p.screenshot,
          })),
        },
      });
      summary.alerts.push(alert);
    }
  } else {
    logger.info(`全部 ${totals.total} 个店铺 Policy Compliance = Healthy，无需报警`);
    if (opts.alwaysNotify) {
      summary.alerts.push(
        await alerter.send({
          check: CHECK_NAME,
          severity: 'OK',
          title: `店铺健康检查正常：${totals.total} 个店铺全部 Healthy（${slot} 批次）`,
          lines: results.map((r) => `**${r.storeKey}** → Healthy${r.ahrScore !== null ? ` · AHR ${r.ahrScore}` : ''}`),
          data: { runId, totals },
        }),
      );
    }
  }

  // A slow or unavailable CRM must never delay an operational alert. The CRM
  // result is still persisted in the final report as a separate channel.
  const crm = await pushToCrmSafely({ config, logger, payload: crmPayload(summary) });
  summary.crm = crm;
  if (!crm.attempted && !crm.channelFailure) logger.info(`CRM 推送跳过（${crm.reason}）`);

  // Rewrite the report so it includes the alert/CRM outcome too.
  writeReports({ outDir: config.outDir, check: CHECK_NAME, summary });

  return summary;
}

/** The shape handed to the CRM import endpoint. */
export function crmPayload(summary) {
  return {
    source: 'singal-amz-guard',
    check: summary.check,
    checkTitle: summary.checkTitle,
    version: summary.version,
    runId: summary.runId,
    slot: summary.slot,
    timezone: summary.timezone,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    totals: summary.totals,
    records: summary.results.map((r) => ({
      storeKey: r.storeKey,
      storeName: r.storeName,
      market: r.market,
      checkedAt: r.checkedAt,
      url: r.url,
      policyCompliance: r.status,
      policyComplianceLabel: STATUS_LABELS[r.status] || r.status,
      isNormal: r.ok,
      severity: r.severity,
      confidence: r.confidence,
      verdictSource: r.verdictSource,
      accountHealthRating: r.ahrScore,
      accountHealthRatingMax: r.ahrScoreMax,
      accountHealthRatingPrev: r.ahrScorePrev,
      accountHealthRatingDelta: r.ahrDelta,
      statusPrev: r.statusPrev,
      statusChanged: r.statusChanged,
      anomalyReasons: r.anomalyReasons,
      screenshot: r.screenshot,
      error: r.error,
    })),
  };
}
