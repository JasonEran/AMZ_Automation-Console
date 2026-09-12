import fs from 'node:fs';
import path from 'node:path';
import { POLICY_COMPLIANCE_EXTRACTOR } from '../extractors/policy-compliance.js';
import { assertApprovedAmazonUrl } from '../lib/amazon-url.js';
import {
  cleanupFailureSafety, SECURITY_CLEANUP_FAILED, secureCleanupEvidence, secureCleanupEvidenceSet,
} from '../lib/evidence-cleanup.js';
import { bjIso, bjStamp } from '../lib/time.js';
import {
  classifyLivePageSafety, classifyPageSafety, classifyUrlSafety, currentPageUrl,
  rawPageIdentity, verifyPageAfterScreenshot,
} from '../lib/page-safety.js';
import { redactText, sanitizeForStorage, sanitizeUrl } from '../lib/redact.js';
import { buildExtractorScript, parseJsonLoose, pickStoreId, RESULT_MARKER, truncate } from '../lib/ziniao.js';

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
 * Bridge probe — the tool for the surface the offline self-test cannot reach.
 *
 * It runs each ziniao-cli command the check depends on, one at a time, and dumps
 * the *raw* stdout/stderr plus the inferred response shape. The point is to find
 * out what the bridge actually returns (none of it is documented) before trusting
 * a full patrol run, and to pinpoint which of the three exec recovery paths works.
 *
 * Nothing here judges store health; it only characterises the plumbing.
 */

/** Describe a value's structure without dumping its contents. */
function shapeOf(v, depth = 0, maxDepth = 4) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) {
    if (depth >= maxDepth) return `array[${v.length}]`;
    return { __array: v.length, __item: v.length ? shapeOf(v[0], depth + 1, maxDepth) : 'empty' };
  }
  if (typeof v === 'object') {
    if (depth >= maxDepth) return 'object{…}';
    const out = {};
    for (const [k, val] of Object.entries(v).slice(0, 24)) out[k] = shapeOf(val, depth + 1, maxDepth);
    return out;
  }
  if (typeof v === 'string') return `string(${v.length})`;
  return typeof v;
}

export async function runProbe({ zn, config, store, logger, opts = {} }) {
  const startedAt = new Date();
  const stamp = bjStamp(startedAt);
  const outDir = path.join(config.outDir, 'probe');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const host = store.host || config.storeHealth.defaultHost;
  const url = assertApprovedAmazonUrl(
    opts.url || `https://${host}${(store.paths || config.storeHealth.paths)[0]}`,
  );

  const report = {
    tool: 'bridge-probe',
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

  /** Run one labelled ziniao-cli invocation, capturing everything, never throwing. */
  async function step(label, args, { timeoutMs = 60000, note } = {}) {
    const t0 = Date.now();
    const rec = { label, operation: args.slice(0, 2).join(' '), note };
    logger.info(`▶ ${label}`);
    try {
      const r = await zn.cli(args, { timeoutMs, expectJson: false });
      rec.ok = true;
      rec.exitCode = 0;
      rec.stdoutBytes = r.stdout.length;
      rec._stdout = r.stdout;
      rec._stderr = r.stderr;
      const json = parseJsonLoose(r.stdout) ?? parseJsonLoose(r.stderr);
      rec.parsedOk = !!json;
      rec.envelopeShape = json ? shapeOf(json) : null;
      rec._json = json;
      logger.info(`  ✓ ${label} (${Date.now() - t0}ms, ${rec.stdoutBytes}B stdout)`);
    } catch (e) {
      rec.ok = false;
      rec.exitCode = e.exitCode ?? null;
      rec.error = redactText(e.message);
      rec._stdout = e.stdout || '';
      rec._stderr = e.stderr || '';
      logger.warn(`  ✗ ${label}: ${rec.error}`);
    }
    rec.durationMs = Date.now() - t0;
    report.steps.push(rec);
    return rec;
  }

  // ---- 1. CLI reachable + bridge alive -----------------------------------
  await step('version', ['--version'], { timeoutMs: 20000, note: 'CLI 是否可执行' });
  const tools = await step('zclaw tools', ['zclaw', 'tools'], {
    timeoutMs: 30000,
    note: '这条不需要 config init，用来单独确认 Bridge 通不通',
  });
  report.findings.bridgeAlive = !!tools.ok;

  // ---- 2. resolve + open -------------------------------------------------
  const resolveArgs = ['store', 'resolve', '--format', 'json'];
  if (store.id) resolveArgs.push('--id', store.id);
  else resolveArgs.push('--name', store.name);
  const resolved = await step('store resolve', resolveArgs, { note: '按名称/ID 能否找到店铺' });
  if (resolved.ok) {
    report.findings.storeResolutionShape = resolved.envelopeShape;
  }

  const openArgs = ['store', 'open'];
  if (store.id) openArgs.push('--id', store.id);
  else openArgs.push('--name', store.name);
  openArgs.push('--url', url);
  if (opts.headless) openArgs.push('--headless');
  const opened = await step('store open', openArgs, {
    timeoutMs: config.ziniao.openTimeoutMs,
    note: '首次可能要下载浏览器内核，会很慢',
  });

  if (opened.ok) {
    storeId = pickStoreId(opened._json) || store.id || null;
    report.findings.sessionMapped = !!storeId;
    if (!storeId) {
      report.recommendations.push(
        'store open 成功但没能从响应里提取到 storeId —— 请把这一步的 stdout 发我，我调整 pickStoreId() 的取值优先级。',
      );
    }
  } else {
    report.recommendations.push(
      /config not found/i.test(opened.error || '')
        ? '先执行 `ziniao-cli config init`，其余步骤都被它阻塞。'
        : `store open 失败：${opened.error}。确认店铺名/ID 正确且紫鸟浏览器在运行。`,
    );
  }

  if (!storeId) {
    report.finishedAt = bjIso();
    const file = path.join(outDir, `probe_${store.key}_${stamp}.json`);
    const safeReport = sanitizeForStorage(stripInternals(report), { rootDir: config.outDir });
    fs.writeFileSync(file, `${JSON.stringify(safeReport, null, 2)}\n`, { mode: 0o600 });
    return { report: safeReport, file };
  }

  // ---- 3. navigation ----------------------------------------------------
  await step('page visit', [
    'page', 'visit', '--store-id', storeId, '--url', url,
    '--wait-until', config.ziniao.waitUntil, '--timeout', String(config.ziniao.visitTimeoutMs),
  ], { timeoutMs: config.ziniao.visitTimeoutMs + 30000, note: '导航到 Account Health 页面' });

  if (config.ziniao.settleMs) {
    await new Promise((r) => setTimeout(r, config.ziniao.settleMs));
  }

  let actualUrl = '';
  try { actualUrl = await currentPageUrl(zn, storeId); } catch { /* fail closed below */ }
  let pageSafety = classifyUrlSafety(actualUrl);
  if (!pageSafety.safe) {
    report.findings.authenticationPage = pageSafety.authSensitive;
    report.findings.evidenceSuppressed = true;
    report.findings.pageSafetyCode = pageSafety.code;
    report.findings.extractorOk = false;
    report.findings.contentHasPolicyCompliance = false;
    report.recommendations.push('认证、SSO、验证码、Passkey、拦截或 current URL 不可确认，已跳过 DOM、页面文本和截图落盘。');
    if (!opts.noClose) await step('store close', ['store', 'close', '--id', storeId], { timeoutMs: 60000 });
    else report.recommendations.push('本次使用 --no-close，店铺浏览器仍保持打开，请调试完成后手动关闭。');
    report.finishedAt = bjIso();
    report.durationMs = Date.now() - startedAt.getTime();
    const file = path.join(outDir, `probe_${store.key}_${stamp}.json`);
    const safeReport = sanitizeForStorage(stripInternals(report), { rootDir: config.outDir });
    fs.writeFileSync(file, `${JSON.stringify(safeReport, null, 2)}\n`, { mode: 0o600 });
    return { report: safeReport, file };
  }

  // ---- 4. exec semantics: the riskiest assumption ------------------------
  // Does `page exec` return the expression value at all?
  const execTrivial = await step('page exec (裸表达式 1+1)', [
    'page', 'exec', '--store-id', storeId, '--script', '1+1', '--timeout', '15000',
  ], { timeoutMs: 45000, note: 'exec 到底会不会回传返回值' });
  report.findings.execReturnsValue = !!(execTrivial.ok && /\b2\b/.test(execTrivial._stdout || ''));

  // Does the marker survive the round trip via the return value?
  const markerScript = buildExtractorScript('return {probe:"ok",href:String(location.href)};');
  const execMarker = await step('page exec (marker 协议)', [
    'page', 'exec', '--store-id', storeId, '--script', markerScript, '--timeout', '20000',
  ], { timeoutMs: 50000, note: '三重回收路径中的第 1 条：返回值' });
  report.findings.markerViaReturn = !!(execMarker.ok && String(execMarker._stdout || '').includes(RESULT_MARKER));

  // Does it survive via window stash instead?
  const execWindow = await step('page exec (window 回读)', [
    'page', 'exec', '--store-id', storeId, '--script', 'window.__ZN_R__ || null', '--timeout', '15000',
  ], { timeoutMs: 45000, note: '三重回收路径中的第 2 条：window.__ZN_R__' });
  report.findings.markerViaWindow = !!(execWindow.ok && String(execWindow._stdout || '').includes(RESULT_MARKER));

  // ---- 5. the real extractor -------------------------------------------
  let extracted = null;
  let text = '';
  let textEvidence = null;
  const beforeDom = await classifyLivePageSafety({ zn, storeId });
  pageSafety = stableLiveTransition(pageSafety, beforeDom, 'PAGE_CHANGED_BEFORE_EVIDENCE_READ');
  if (pageSafety.safe) {
    logger.info('▶ 真实提取脚本 (execExtract)');
    const t0 = Date.now();
    try {
      extracted = await zn.execExtract(storeId, POLICY_COMPLIANCE_EXTRACTOR, {
        timeoutMs: config.ziniao.execTimeoutMs,
      });
    } catch (e) {
      const message = redactText(e.message);
      report.findings.extractorError = message;
      logger.warn(`  ✗ 提取失败: ${message}`);
      report.recommendations.push(
        `路径 A（DOM 提取）不可用：${message}。检查会自动降级到路径 B（页面文本），` +
          '但建议把这一步的 stdout 发我修正 exec 调用方式。',
      );
    }
    const afterDom = await classifyLivePageSafety({ zn, storeId });
    pageSafety = stableLiveTransition(pageSafety, afterDom);
    if (!pageSafety.safe) extracted = null;
    if (extracted && pageSafety.safe) {
      report.findings.extractorOk = true;
      report.findings.extractorVia = extracted.via;
      report.findings.extractorResult = sanitizeForStorage(extracted.result, { rootDir: config.outDir });
      logger.info(`  ✓ 提取成功 (via ${extracted.via}, ${Date.now() - t0}ms)`);
      logger.info(
        `    status=${extracted.result.status} score=${extracted.result.score} cardFound=${extracted.result.cardFound} source=${extracted.result.statusSource}`,
      );
      if (!extracted.result.cardFound) {
        report.recommendations.push(
          '提取脚本跑通了，但没定位到 Policy Compliance 卡片。请把 findings.extractorResult 里的 ' +
            'statusCandidates / notes 和 raw 页面文本发我，用来校准选择器。',
        );
      }
    } else {
      report.findings.extractorOk = false;
    }
  }

  // ---- 6. page content (path B) ----------------------------------------
  let contentStep = null;
  if (pageSafety.safe) {
    const beforeRawContent = await classifyLivePageSafety({ zn, storeId });
    pageSafety = stableLiveTransition(pageSafety, beforeRawContent, 'PAGE_CHANGED_BEFORE_EVIDENCE_READ');
    if (pageSafety.safe) {
      contentStep = await step('page content (text)', [
        'page', 'content', '--store-id', storeId, '--content-format', 'text',
        '--timeout', String(config.ziniao.contentTimeoutMs),
      ], { timeoutMs: config.ziniao.contentTimeoutMs + 30000, note: '路径 B：全页文本' });
      const afterRawContent = await classifyLivePageSafety({ zn, storeId });
      pageSafety = stableLiveTransition(beforeRawContent, afterRawContent);
      if (!pageSafety.safe && contentStep) {
        contentStep._stdout = '';
        contentStep._stderr = '';
        contentStep._json = null;
      }
    }
  }

  if (contentStep?.ok && pageSafety.safe) {
    const beforeParsedContent = await classifyLivePageSafety({ zn, storeId });
    pageSafety = stableLiveTransition(pageSafety, beforeParsedContent, 'PAGE_CHANGED_BEFORE_EVIDENCE_READ');
    let content = null;
    if (pageSafety.safe) {
      try {
        content = await zn.content(storeId, { format: 'text', timeoutMs: config.ziniao.contentTimeoutMs });
      } catch { content = null; }
      const afterParsedContent = await classifyLivePageSafety({ zn, storeId });
      pageSafety = stableLiveTransition(beforeParsedContent, afterParsedContent);
    }
    if (pageSafety.safe) {
      text = String(content?.text || '');
      const hasPolicyCompliance = /policy\s+compliance|政策合规性/i.test(text);
      textEvidence = text ? {
        landed: hasPolicyCompliance,
        hasPolicyComplianceText: hasPolicyCompliance,
      } : null;
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
    report.findings.contentTextLength = text.length;
    report.findings.contentHasPolicyCompliance = !!textEvidence?.hasPolicyComplianceText;
    if (text) {
      const rawFile = path.join(outDir, `pagetext_${store.key}_${stamp}.txt`);
      fs.writeFileSync(rawFile, redactText(text), { mode: 0o600 });
      report.findings.pageTextFile = rawFile;
      logger.info(`  页面文本 ${text.length} 字符，已存 ${rawFile}`);
    }
  }
  report.findings.authenticationPage = pageSafety.authSensitive;
  report.findings.evidenceSuppressed = !pageSafety.safe;
  report.findings.pageSafetyCode = pageSafety.code;
  if (!pageSafety.safe) pageSafety = suppressProbeEvidence(report, pageSafety, { outDir });
  if (!report.findings.contentHasPolicyCompliance) {
    report.recommendations.push(
      "页面文本里没有 'Policy Compliance' —— 可能没登录、URL 不对、或页面还没渲染完。" +
        '看一眼截图，并考虑把 config.ziniao.settleMs 调大。',
    );
  }

  // ---- 7. screenshot ---------------------------------------------------
  if (config.storeHealth.screenshot !== false && pageSafety.safe) {
    const beforeScreenshot = await classifyLivePageSafety({ zn, storeId });
    pageSafety = stableLiveTransition(pageSafety, beforeScreenshot, 'PAGE_CHANGED_BEFORE_SCREENSHOT');
    if (!pageSafety.safe) pageSafety = suppressProbeEvidence(report, pageSafety, { outDir });
  }
  if (config.storeHealth.screenshot !== false && pageSafety.safe) {
    const shot = path.join(outDir, `shot_${store.key}_${stamp}.png`);
    let screenshotResult = null;
    try {
      screenshotResult = await zn.screenshot(storeId, shot, { fullPage: true });
    } catch (e) {
      const cleanup = secureCleanupEvidence({ file: shot, outDir });
      const transportCleanup = e?.code === SECURITY_CLEANUP_FAILED
        ? { ok: false, reason: e.cleanupReason || 'TRANSPORT_ARTIFACT_CLEANUP_FAILED', quarantined: false }
        : null;
      if (!cleanup.ok || transportCleanup) {
        pageSafety = suppressProbeEvidence(report, pageSafety, {
          outDir, files: [shot], priorCleanup: transportCleanup || cleanup,
        });
      }
      logger.warn(`  ✗ 截图失败: ${redactText(e.message)}`);
    }
    const postScreenshot = pageSafety.safe
      ? await verifyPageAfterScreenshot({
        zn,
        storeId,
        expectedUrl: rawPageIdentity(pageSafety),
        dom: extracted?.result,
        txt: textEvidence,
        pageText: text,
      })
      : pageSafety;
    if (!postScreenshot.safe) {
      pageSafety = postScreenshot;
      pageSafety = suppressProbeEvidence(report, pageSafety, { outDir, files: [shot] });
      logger.warn(report.findings.securityCleanupFailed
        ? '  ✗ 截图期间页面状态变化，证据清理未完成，已标记 SECURITY_CLEANUP_FAILED'
        : '  ✗ 截图期间页面状态变化，已删除截图并抑制 DOM/页面文本证据');
    } else if (
      screenshotResult?.path
      && path.resolve(String(screenshotResult.path)) === path.resolve(shot)
      && fs.existsSync(shot)
    ) {
      report.findings.screenshotWritten = true;
      report.findings.screenshotFile = shot;
      try { fs.chmodSync(shot, 0o600); } catch { /* non-POSIX */ }
      logger.info(`  ✓ 截图 ${shot}`);
      pageSafety = postScreenshot;
    } else {
      const cleanup = secureCleanupEvidence({ file: shot, outDir });
      if (!cleanup.ok) {
        pageSafety = suppressProbeEvidence(report, pageSafety, {
          outDir, files: [shot], priorCleanup: cleanup,
        });
      }
      report.findings.screenshotWritten = false;
      logger.info('  ✗ 截图命令成功但文件没落盘');
    }
  }
  if (!pageSafety.safe) {
    report.recommendations.push(report.findings.securityCleanupFailed
      ? '敏感证据清理未能确认完成；已显式标记 SECURITY_CLEANUP_FAILED，禁止将本次视为已抑制成功。'
      : '检测到认证/验证码/Passkey/拦截或页面变化，已跳过并抑制页面文本和截图证据。');
  }

  // ---- 8. cleanup ------------------------------------------------------
  if (!opts.noClose) {
    await step('store close', ['store', 'close', '--id', storeId], { timeoutMs: 60000 });
  } else {
    logger.info('按 --no-close 保留当前店铺浏览器窗口（标识不输出）');
  }

  // ---- verdict on the plumbing ----------------------------------------
  const f = report.findings;
  if (f.extractorOk && f.contentHasPolicyCompliance) {
    report.recommendations.unshift('双路提取都通了，可以放心跑 `node src/cli.js store-health`。');
  } else if (f.contentHasPolicyCompliance) {
    report.recommendations.unshift('只有路径 B 通。检查仍可用（medium 置信度），但建议先修路径 A。');
  } else if (f.extractorOk) {
    report.recommendations.unshift('只有路径 A 通。检查仍可用，但失去了交叉校验。');
  } else if (storeId) {
    report.recommendations.unshift('两条提取路径都不通 —— 现在跑检查只会得到 UNKNOWN 告警。请先按上面的建议排查。');
  }

  report.finishedAt = bjIso();
  report.durationMs = Date.now() - startedAt.getTime();
  const file = path.join(outDir, `probe_${store.key}_${stamp}.json`);
  const safeReport = sanitizeForStorage(stripInternals(report), { rootDir: config.outDir });
  fs.writeFileSync(file, `${JSON.stringify(safeReport, null, 2)}\n`, { mode: 0o600 });
  return { report: safeReport, file };
}

/** Drop the parsed-JSON scratch fields before writing the report. */
function stripInternals(report) {
  return {
    ...report,
    steps: report.steps.map(({ _json, _stdout, _stderr, ...rest }) => rest),
  };
}
