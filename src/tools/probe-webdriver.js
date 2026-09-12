import fs from 'node:fs';
import path from 'node:path';
import { POLICY_COMPLIANCE_EXTRACTOR } from '../extractors/policy-compliance.js';
import { assertApprovedAmazonUrl } from '../lib/amazon-url.js';
import {
  cleanupFailureSafety, SECURITY_CLEANUP_FAILED, secureCleanupEvidence, secureCleanupEvidenceSet,
} from '../lib/evidence-cleanup.js';
import {
  classifyLivePageSafety, classifyPageSafety, classifyUrlSafety, currentPageUrl,
  rawPageIdentity, verifyPageAfterScreenshot,
} from '../lib/page-safety.js';
import { redactText, sanitizeForStorage, sanitizeUrl } from '../lib/redact.js';
import { bjIso, bjStamp, sleep } from '../lib/time.js';

function stableLiveTransition(before, after, code = 'PAGE_CHANGED_DURING_EVIDENCE_READ') {
  if (!before?.safe) return before;
  if (!after?.safe) return after;
  const beforeUrl = rawPageIdentity(before);
  const afterUrl = rawPageIdentity(after);
  if (beforeUrl && beforeUrl === afterUrl) return after;
  return {
    ...after,
    safe: false,
    code,
    pageChangedDuringEvidence: true,
  };
}

function suppressProbeEvidence(report, safety, { outDir, files = [], priorCleanup = null } = {}) {
  const textFile = report.findings.pageTextFile;
  const screenshotFile = report.findings.screenshotFile;
  const cleanup = secureCleanupEvidenceSet({
    files: [textFile, screenshotFile, ...files],
    outDir,
  });
  const cleanupFailed = report.findings.securityCleanupFailed === true
    || priorCleanup?.ok === false
    || cleanup.ok === false;
  const effectiveSafety = cleanupFailed ? cleanupFailureSafety(safety) : safety;
  report.findings.authenticationPage = report.findings.authenticationPage === true
    || safety?.authSensitive === true;
  report.findings.evidenceSuppressed = !cleanupFailed;
  report.findings.pageSafetyCode = effectiveSafety?.code || 'LIVE_SAFETY_PROBE_UNAVAILABLE';
  if (cleanupFailed) {
    report.findings.securityCleanupFailed = true;
    report.findings.securityCleanupReason = priorCleanup?.ok === false
      ? priorCleanup.reason
      : (cleanup.ok === false ? cleanup.reason : report.findings.securityCleanupReason);
    report.findings.evidenceQuarantined = report.findings.evidenceQuarantined === true
      || priorCleanup?.quarantined === true
      || cleanup.quarantined === true;
  }
  report.findings.extractorOk = false;
  report.findings.contentHasPolicyCompliance = false;
  report.findings.screenshotWritten = false;
  delete report.findings.extractorResult;
  delete report.findings.extractorVia;
  delete report.findings.extractorError;
  delete report.findings.contentTextLength;
  delete report.findings.pageTextFile;
  delete report.findings.screenshotFile;
  return effectiveSafety;
}

/**
 * Real-machine probe for the official Ziniao WebDriver HTTP transport.
 *
 * It exercises only the adapter surface used by the checks: WebDriver service,
 * store start, Selenium attach/navigation, DOM extraction, page text, screenshot
 * and store cleanup. Runtime evidence is written under the ignored out/ tree.
 */
export async function runWebDriverProbe({ zn, config, store, logger, opts = {} }) {
  const startedAt = new Date();
  const stamp = bjStamp(startedAt);
  const outDir = path.join(config.outDir, 'probe');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const host = store.host || config.storeHealth.defaultHost;
  const url = assertApprovedAmazonUrl(
    opts.url || `https://${host}${(store.paths || config.storeHealth.paths)[0]}`,
  );
  const report = {
    tool: 'webdriver-probe',
    version: '1.0.0',
    probedAt: bjIso(startedAt),
    storeKey: store.key,
    storeName: store.name || null,
    targetUrl: sanitizeUrl(url),
    steps: [],
    findings: {},
    recommendations: [],
  };

  let storeId = null;
  async function step(label, work) {
    const rec = { label, startedAt: bjIso(), ok: false };
    const t0 = Date.now();
    logger.info(`▶ ${label}`);
    try {
      const value = await work();
      rec.ok = true;
      logger.info(`  ✓ ${label} (${Date.now() - t0}ms)`);
      return value;
    } catch (e) {
      rec.error = redactText(e.message);
      logger.warn(`  ✗ ${label}: ${redactText(e.message)}`);
      return null;
    } finally {
      rec.durationMs = Date.now() - t0;
      report.steps.push(rec);
    }
  }

  const initialPing = await step('WebDriver HTTP ping', async () => {
    const alive = await zn.ping();
    if (!alive) throw new Error(`本机 ${zn.baseUrl || 'WebDriver HTTP 端口'} 尚未响应`);
    return true;
  });
  report.findings.serviceInitiallyAlive = initialPing === true;
  const opened = await step('updateCore + getBrowserList + startBrowser + Selenium attach', () => zn.storeOpen({
    id: store.id || undefined,
    name: store.id ? undefined : store.name,
    market: store.market,
    headless: !!opts.headless,
    timeoutMs: config.ziniao.openTimeoutMs,
  }));

  if (opened) {
    storeId = opened.storeId;
    report.findings.transportReady = true;
    report.findings.sessionMapped = !!storeId;
    report.findings.debuggingPort = opened.debuggingPort || null;
    report.findings.coreVersion = opened.coreVersion || null;

    const visited = await step('Selenium 导航到 Account Health', () => zn.visit(storeId, url, {
      timeoutMs: config.ziniao.visitTimeoutMs,
    }));
    report.findings.navigationOk = !!visited;
    if (visited && config.ziniao.settleMs) await sleep(config.ziniao.settleMs);

    let actualUrl = '';
    try { actualUrl = await currentPageUrl(zn, storeId, visited); } catch { /* fail closed below */ }
    let pageSafety = classifyUrlSafety(actualUrl);
    let extracted = null;
    let text = '';
    let textEvidence = null;
    if (pageSafety.safe) {
      const trivial = await step('Selenium executeScript (1+1)', () => zn.execScript(storeId, 'return 1+1;'));
      report.findings.execReturnsValue = trivial === 2;

      const beforeDom = await classifyLivePageSafety({ zn, storeId });
      pageSafety = stableLiveTransition(pageSafety, beforeDom, 'PAGE_CHANGED_BEFORE_EVIDENCE_READ');
      if (pageSafety.safe) {
        extracted = await step('路径 A：DOM 提取', () => zn.execExtract(
          storeId,
          POLICY_COMPLIANCE_EXTRACTOR,
          { timeoutMs: config.ziniao.execTimeoutMs },
        ));
        const afterDom = await classifyLivePageSafety({ zn, storeId });
        pageSafety = stableLiveTransition(pageSafety, afterDom);
        if (!pageSafety.safe) extracted = null;
      }
      report.findings.extractorOk = !!extracted;

      if (pageSafety.safe) {
        const beforeText = await classifyLivePageSafety({ zn, storeId });
        pageSafety = stableLiveTransition(pageSafety, beforeText, 'PAGE_CHANGED_BEFORE_EVIDENCE_READ');
        if (pageSafety.safe) {
          const content = await step('路径 B：页面文本', () => zn.content(storeId, {
            format: 'text',
            timeoutMs: config.ziniao.contentTimeoutMs,
          }));
          const afterText = await classifyLivePageSafety({ zn, storeId });
          pageSafety = stableLiveTransition(beforeText, afterText);
          if (pageSafety.safe) {
            text = String(content?.text || '');
            textEvidence = text ? {
              landed: /policy\s+compliance|政策合规性/i.test(text),
              hasPolicyComplianceText: /policy\s+compliance|政策合规性/i.test(text),
            } : null;
          }
        }
      }
      if (pageSafety.safe) {
        pageSafety = classifyPageSafety({
          currentUrl: rawPageIdentity(pageSafety),
          dom: extracted?.result,
          txt: textEvidence,
          pageText: text,
        });
      }
      if (pageSafety.safe) {
        if (extracted) {
          report.findings.extractorVia = extracted.via;
          report.findings.extractorResult = sanitizeForStorage(extracted.result, { rootDir: config.outDir });
        }
        report.findings.contentTextLength = text.length;
        report.findings.contentHasPolicyCompliance = !!textEvidence?.hasPolicyComplianceText;
        if (text) {
          const textFile = path.join(outDir, `pagetext_${store.key}_${stamp}.txt`);
          fs.writeFileSync(textFile, redactText(text), { mode: 0o600 });
          report.findings.pageTextFile = textFile;
        }
      }
    }
    report.findings.authenticationPage = pageSafety.authSensitive;
    report.findings.evidenceSuppressed = !pageSafety.safe;
    report.findings.pageSafetyCode = pageSafety.code;
    if (!pageSafety.safe) {
      pageSafety = suppressProbeEvidence(report, pageSafety, { outDir });
    }

    if (config.storeHealth.screenshot !== false && pageSafety.safe) {
      const beforeScreenshot = await classifyLivePageSafety({ zn, storeId });
      pageSafety = stableLiveTransition(pageSafety, beforeScreenshot, 'PAGE_CHANGED_BEFORE_SCREENSHOT');
      if (!pageSafety.safe) pageSafety = suppressProbeEvidence(report, pageSafety, { outDir });
    }
    if (config.storeHealth.screenshot !== false && pageSafety.safe) {
      const shotFile = path.join(outDir, `screenshot_${store.key}_${stamp}.png`);
      let shotError = null;
      const shot = await step('Selenium 截图', async () => {
        try {
          return await zn.screenshot(storeId, shotFile, { fullPage: true });
        } catch (error) {
          shotError = error;
          throw error;
        }
      });
      const postScreenshot = await verifyPageAfterScreenshot({
        zn,
        storeId,
        expectedUrl: rawPageIdentity(pageSafety),
        dom: extracted?.result,
        txt: textEvidence,
        pageText: text,
      });
      if (!postScreenshot.safe) {
        pageSafety = postScreenshot;
        pageSafety = suppressProbeEvidence(report, pageSafety, { outDir, files: [shotFile] });
        logger.warn(report.findings.securityCleanupFailed
          ? '  ✗ 截图期间页面状态变化，证据清理未完成，已标记 SECURITY_CLEANUP_FAILED'
          : '  ✗ 截图期间页面状态变化，已删除截图并抑制 DOM/页面文本证据');
      } else if (
        shot?.path
        && path.resolve(String(shot.path)) === path.resolve(shotFile)
        && fs.existsSync(shotFile)
      ) {
        report.findings.screenshotWritten = true;
        report.findings.screenshotFile = shotFile;
        try { fs.chmodSync(shotFile, 0o600); } catch { /* non-POSIX */ }
        pageSafety = postScreenshot;
      } else {
        const cleanup = secureCleanupEvidence({ file: shotFile, outDir });
        const transportCleanup = shotError?.code === SECURITY_CLEANUP_FAILED
          ? {
            ok: false,
            reason: shotError.cleanupReason || 'TRANSPORT_ARTIFACT_CLEANUP_FAILED',
            quarantined: false,
          }
          : null;
        if (!cleanup.ok || transportCleanup) {
          pageSafety = suppressProbeEvidence(report, pageSafety, {
            outDir, files: [shotFile], priorCleanup: transportCleanup || cleanup,
          });
        }
        report.findings.screenshotWritten = false;
      }
    }
    if (!pageSafety.safe) {
      report.recommendations.push(report.findings.securityCleanupFailed
        ? '敏感证据清理未能确认完成；已显式标记 SECURITY_CLEANUP_FAILED，禁止将本次视为已抑制成功。'
        : '认证、SSO、验证码、Passkey、拦截、空壳或 current URL 不可确认，已跳过 DOM、页面文本和截图落盘。');
    }
  } else {
    report.findings.transportReady = false;
    report.findings.sessionMapped = false;
    report.recommendations.push('店铺启动失败：先运行 doctor，检查本机凭据、紫鸟 WebDriver HTTP 模式和店铺 ID。');
  }

  if (!report.findings.extractorOk && !report.findings.contentHasPolicyCompliance && storeId) {
    report.recommendations.push('两条采集路径都未确认 Policy Compliance；查看截图和页面文本，确认登录状态、站点与页面结构。');
  }

  if (storeId && !opts.noClose) {
    report.findings.storeClosed = !!(await step('stopBrowser + Selenium 清理', () => zn.storeClose(storeId)));
  } else if (storeId) {
    report.findings.storeClosed = false;
    report.recommendations.push('本次使用 --no-close，店铺浏览器仍保持打开，请调试完成后手动关闭。');
  }

  report.finishedAt = bjIso();
  const file = path.join(outDir, `probe_${store.key}_${stamp}.json`);
  const safeReport = sanitizeForStorage(report, { rootDir: config.outDir });
  fs.writeFileSync(file, `${JSON.stringify(safeReport, null, 2)}\n`, { mode: 0o600 });
  return { report: safeReport, file };
}
