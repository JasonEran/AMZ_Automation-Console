import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POLICY_COMPLIANCE_EXTRACTOR } from '../extractors/policy-compliance.js';
import { ASIN_DETAIL_EXTRACTOR, ASIN_IMAGE_ERROR_TEXT_EXTRACTOR, VOC_EXTRACTOR, vocDetailExtractor } from '../extractors/checks.js';
import { runStoreHealth } from '../checks/store-health.js';
import {
  allowlistedBrowserErrorCode, asinStateKey, filterCurrentAsinResults, groupByStore, isRecoverableAsinSafety, loadAsins,
  previousDateKey, runAsinHealth,
  scopeAsinsToStores, selectAsinsForRun,
} from '../checks/asin-health.js';
import {
  adsCheck, asinDetailDef, feedbackCheck, GENERIC_CHECKS, inboxCheck, outletCheck,
  performanceCheck, reviewsCheck, vocCheck,
} from '../checks/definitions.js';
import { deepMerge, DEFAULTS } from '../lib/config.js';
import { loadZiniaoCredentials } from '../lib/credentials.js';
import { latestStoreSnapshots } from '../lib/dashboard-history.js';
import { mapWithConcurrency } from '../lib/pool.js';
import { POST_SCREENSHOT_SAFETY_EXTRACTOR } from '../lib/page-safety.js';
import { ADS_PORTFOLIO_EXTRACTOR } from '../extractors/ads-portfolios.js';
import { effectiveCampaignState } from '../lib/ads-portfolio-verdict.js';
import {
  advertisingSweepPlan, canRetryEvidenceIdentity, isRecoverableVocDetailFailure, isRecoverableVocRendererFailure,
  minimumReadyAgeSatisfied, reusableVocDetailsFromReport, runGenericCheck, waitForStablePageIdentity,
  shouldRetryIncompletePage,
} from '../lib/check-runner.js';
import { acquireRunLock, releaseRunLock, runSlot, writeRunProgress } from '../checks/run.js';
import { toCsv, toHtml } from '../lib/report.js';
import {
  beijingToLocal, cronLines, macPlist, macServerPlist, serviceUnit, timerUnit,
} from '../lib/schedule-units.js';
import { bjDateKey, bjParts } from '../lib/time.js';
import { parsePolicyComplianceText, reconcile, severityOf } from '../lib/verdict.js';
import { buildExtractorScript, parseJsonLoose, pickStoreId, RESULT_MARKER } from '../lib/ziniao.js';
import { ZiniaoWebDriver } from '../lib/ziniao-webdriver.js';
import { NodeFilter, e } from './dom-stub.js';
import * as F from './fixtures.js';

/**
 * Offline regression coverage without a live Ziniao browser:
 * the in-page extractor (against a DOM stub), the text parser, the reconcile
 * rules, the marker transport, and the run pipeline against mock transports.
 *
 * Passing these cases does not verify live page layouts, credentials, browser
 * I/O, deployment state, or business outcomes.
 */

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failures.push({ name, error: e.message });
    process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failures.push({ name, error: e.message });
    process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`);
  }
}

function eq(actual, expected, what = 'value') {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const ADS_TEST_KEYWORD = '2.26';
function adsScopedArgs(args = {}) {
  const proof = { keyword: ADS_TEST_KEYWORD, verified: true };
  const attach = (value) => value ? { ...value, nameFilter: proof } : value;
  return {
    ...args,
    dom: attach(args.dom),
    txt: attach(args.txt),
    store: { key: 'ADS-SELFTEST', adsNameContains: ADS_TEST_KEYWORD, ...(args.store || {}) },
  };
}

function judgeAds(args) {
  return adsCheck.judge(adsScopedArgs(args));
}

function readyAds(args) {
  return adsCheck.ready(adsScopedArgs(args));
}

/** Execute the extractor body against the DOM stub. */
function runExtractor(env) {
  const fn = new Function('window', 'document', 'location', 'NodeFilter', POLICY_COMPLIANCE_EXTRACTOR);
  return fn(env.window, env.document, env.location, NodeFilter);
}

export async function selfTest({ logger }) {
  process.stdout.write('\n[1] 页面内提取脚本 (extractor)\n');

  check('脚本是合法 JS 且仅含 ASCII', () => {
    ok(!/[^\x00-\x7F]/.test(POLICY_COMPLIANCE_EXTRACTOR), 'extractor 含非 ASCII 字符');
    // Throws a SyntaxError here if the body does not parse.
    new Function('window', 'document', 'location', 'NodeFilter', POLICY_COMPLIANCE_EXTRACTOR);
  });

  check('Healthy + AHR 256：状态与分数都正确', () => {
    const r = runExtractor(F.envFor(F.accountHealthDom('Healthy', 256)));
    eq(r.status, 'HEALTHY', 'status');
    eq(r.statusRaw, 'Healthy', 'statusRaw');
    eq(r.score, 256, 'score');
    eq(r.cardFound, true, 'cardFound');
    ok(r.hasPolicyComplianceText, '应识别到 Policy Compliance 文本');
  });

  check('中文“政策合规性 / 良好”双路识别为 HEALTHY', () => {
    const dom = runExtractor(F.envFor(F.accountHealthDomZh(344)));
    const txt = parsePolicyComplianceText(F.TEXT_HEALTHY_ZH);
    eq(dom.status, 'HEALTHY', 'DOM status');
    eq(dom.score, 344, 'DOM score');
    eq(txt.status, 'HEALTHY', 'text status');
    eq(txt.score, 344, 'text score');
    eq(reconcile(dom, txt).confidence, 'high', '双路置信度');
  });

  check('坐标刻度 0/100/200/1000 不会被当成分数', () => {
    const r = runExtractor(F.envFor(F.accountHealthDom('Healthy', 256)));
    ok(r.score !== 1000 && r.score !== 0 && r.score !== 200, `score 误取刻度: ${r.score}`);
    ok(r.scoreCandidates.length >= 5, '应收集到分数与刻度共 5 个候选');
    eq(r.scoreCandidates[0].value, 256, '字号排序后的首选');
  });

  check('At Risk 被判为异常状态', () => {
    const r = runExtractor(F.envFor(F.accountHealthDom('At Risk', 120)));
    eq(r.status, 'AT_RISK', 'status');
    eq(r.score, 120, 'score');
  });

  check('Unhealthy 不会被误判成 Healthy', () => {
    const r = runExtractor(F.envFor(F.accountHealthDom('Unhealthy', 88)));
    eq(r.status, 'UNHEALTHY', 'status');
  });

  check('隐藏的状态徽标被跳过，取可见的那个', () => {
    const dom = F.accountHealthDom('Healthy', 256);
    const card = dom.children.find((c) => c.getAttribute('class') === 'ah-card');
    const head = card.children[0];
    // Insert a hidden "Unhealthy" pill ahead of the visible "Healthy" one, so
    // DOM order alone would pick the wrong answer.
    const hidden = e('kat-status', {}, { fontSize: '13px', display: 'none' }, 'Unhealthy');
    hidden.parentElement = head;
    head.childNodes.splice(1, 0, hidden);
    const r = runExtractor(F.envFor(dom));
    eq(r.status, 'HEALTHY', 'status');
    ok(
      r.statusCandidates.some((c) => c.status === 'UNHEALTHY' && c.visible === false),
      '隐藏徽标应被记录为候选但标记为不可见',
    );
  });

  check('404 页 + 导航栏 Healthy 徽标 → 绝不报 HEALTHY（真机回归）', () => {
    const r = runExtractor(F.envFor(F.notFoundWithNavHealthPill()));
    eq(r.cardFound, false, 'cardFound');
    eq(r.hasPolicyComplianceText, false, 'hasPolicyComplianceText');
    ok(r.status !== 'HEALTHY', `导航徽标不得被当作判定依据，实际 status=${r.status}`);
    eq(r.status, null, 'status 应为 null，交由上层判 UNKNOWN');
    eq(r.statusCandidates.length, 0, '卡片缺失时不应产生任何候选');
  });

  check('真实页面文本 → HEALTHY / 256（真机样本）', () => {
    const r = parsePolicyComplianceText(F.TEXT_REAL_XCAI);
    eq(r.status, 'HEALTHY', 'status');
    eq(r.score, 256, 'score');
  });

  check('登录页被识别为 LOGIN_REQUIRED 信号', () => {
    const r = runExtractor(F.envFor(F.loginDom(), 'https://sellercentral.amazon.com/ap/signin'));
    eq(r.looksLikeLogin, true, 'looksLikeLogin');
    eq(r.hasPolicyComplianceText, false, 'hasPolicyComplianceText');
  });

  check('kat 组件用 label 属性时也能读到状态', () => {
    // A pill that renders via attribute rather than text (shadow DOM style).
    const dom = F.accountHealthDom('', 256, { pillAttrs: { label: 'At Risk' } });
    const r = runExtractor(F.envFor(dom));
    eq(r.status, 'AT_RISK', 'status');
    ok(String(r.statusSource).startsWith('attr:'), `statusSource 应来自属性，实际 ${r.statusSource}`);
  });

  process.stdout.write('\n[2] 页面文本解析 (text parser)\n');

  check('Healthy 文本 → HEALTHY / 256', () => {
    const r = parsePolicyComplianceText(F.TEXT_HEALTHY);
    eq(r.status, 'HEALTHY', 'status');
    eq(r.score, 256, 'score');
  });

  check('At Risk 文本 → AT_RISK / 120', () => {
    const r = parsePolicyComplianceText(F.TEXT_AT_RISK);
    eq(r.status, 'AT_RISK', 'status');
    eq(r.score, 120, 'score');
  });

  check('登录页文本 → LOGIN_REQUIRED', () => {
    eq(parsePolicyComplianceText(F.TEXT_LOGIN).status, 'LOGIN_REQUIRED', 'status');
  });

  check('验证码页文本 → BLOCKED', () => {
    eq(parsePolicyComplianceText(F.TEXT_BLOCKED).status, 'BLOCKED', 'status');
  });

  check('缺少状态词时判 UNKNOWN，绝不默认 HEALTHY', () => {
    const r = parsePolicyComplianceText(F.TEXT_NO_STATUS);
    eq(r.status, 'UNKNOWN', 'status');
    ok(r.hasPolicyComplianceText, '文本里确实有 Policy Compliance');
  });

  check('远处的 "at risk" 干扰词不会翻转判定', () => {
    const r = parsePolicyComplianceText(F.TEXT_HEALTHY_WITH_DECOY);
    eq(r.status, 'HEALTHY', 'status');
    eq(r.score, 310, 'score');
  });

  check('空文本 → UNKNOWN', () => {
    eq(parsePolicyComplianceText('').status, 'UNKNOWN', 'status');
  });

  check('"unhealthy" 不会被 /\\bhealthy\\b/ 命中', () => {
    const r = parsePolicyComplianceText('Policy Compliance Unhealthy Account Health Rating 40');
    eq(r.status, 'UNHEALTHY', 'status');
  });

  process.stdout.write('\n[3] 判定合并 (reconcile)\n');

  check('双路一致 → high 置信度，不需要兜底', () => {
    const r = reconcile({ status: 'HEALTHY', score: 256 }, { status: 'HEALTHY', score: 256 });
    eq(r.status, 'HEALTHY', 'status');
    eq(r.confidence, 'high', 'confidence');
    eq(r.needsArbitration, false, 'needsArbitration');
    eq(r.score, 256, 'score');
  });

  check('双路冲突 → 取更严重的一方并要求兜底', () => {
    const r = reconcile({ status: 'HEALTHY' }, { status: 'AT_RISK' });
    eq(r.status, 'AT_RISK', 'status');
    eq(r.confidence, 'conflict', 'confidence');
    eq(r.needsArbitration, true, 'needsArbitration');
  });

  check('冲突时绝不倒向 HEALTHY（反向顺序同样成立）', () => {
    eq(reconcile({ status: 'UNHEALTHY' }, { status: 'HEALTHY' }).status, 'UNHEALTHY', 'status');
  });

  check('双路都无法判定 → UNKNOWN 且要求兜底', () => {
    const r = reconcile({ status: 'UNKNOWN' }, { status: 'UNKNOWN' });
    eq(r.status, 'UNKNOWN', 'status');
    eq(r.needsArbitration, true, 'needsArbitration');
  });

  check('登录信号优先于一切', () => {
    const r = reconcile({ status: 'HEALTHY', looksLikeLogin: true }, { status: 'HEALTHY' });
    eq(r.status, 'LOGIN_REQUIRED', 'status');
  });

  check('严重度映射：只有 HEALTHY 是 OK', () => {
    eq(severityOf('HEALTHY'), 'OK', 'HEALTHY');
    for (const s of ['AT_RISK', 'UNHEALTHY', 'CRITICAL', 'DEACTIVATED']) eq(severityOf(s), 'CRITICAL', s);
    for (const s of ['UNKNOWN', 'LOGIN_REQUIRED', 'BLOCKED', 'ERROR']) eq(severityOf(s), 'ERROR', s);
  });

  check('AHR 分数以 DOM 为准，冲突时留记录', () => {
    const r = reconcile({ status: 'HEALTHY', score: 256, scoreSource: 'font-size-rank' }, { status: 'HEALTHY', score: 1000 });
    eq(r.score, 256, 'score');
    ok(r.notes.some((n) => n.includes('AHR 分数不一致')), '应记录分数冲突');
  });

  process.stdout.write('\n[4] marker 传输协议 (exec transport)\n');

  check('包装脚本三条回收路径都能解析', () => {
    const script = buildExtractorScript('return {status:"HEALTHY",score:256};');
    ok(script.includes(RESULT_MARKER), '包装脚本应内嵌 marker');
    // Simulate the page evaluating it, then the bridge JSON-encoding the result.
    const payload = new Function(`var window={};return ${script};`)();
    ok(String(payload).startsWith(RESULT_MARKER), 'payload 应以 marker 开头');
    const envelope = JSON.stringify({ ok: true, data: { result: payload } });
    const parsed = parseJsonLoose(envelope);
    const inner = parseJsonLoose(parsed.data.result.slice(RESULT_MARKER.length));
    eq(inner.status, 'HEALTHY', 'status');
    eq(inner.score, 256, 'score');
  });

  check('提取脚本内抛错会被捕获并标记 phase', () => {
    const script = buildExtractorScript('throw new Error("boom");');
    const payload = new Function(`var window={};return ${script}`)();
    const inner = parseJsonLoose(String(payload).slice(RESULT_MARKER.length));
    eq(inner.phase, 'extractor', 'phase');
    ok(/boom/.test(inner.error), 'error 应包含原始信息');
  });

  check('非 ASCII 注入脚本被拒绝', () => {
    let threw = false;
    try {
      buildExtractorScript('return {note:"中文"};');
    } catch {
      threw = true;
    }
    eq(threw, true, '应抛错');
  });

  check('storeId 提取优先 storeId 而非 id', () => {
    eq(pickStoreId({ ok: true, data: { id: 'wrong', detail: { storeId: '16570253873232' } } }), '16570253873232');
  });

  process.stdout.write('\n[5] 全流程（mock 紫鸟 CLI）\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-selftest-'));
  const config = deepMerge(DEFAULTS, {
    outDir: tmp,
    paths: { outDir: tmp },
    ziniao: { settleMs: 0, retries: 0, retryDelayMs: 0, closeStoreAfterCheck: true },
    storeHealth: { screenshot: false, saveRawPageText: true },
    codex: { enabled: false }, // keep the self-test offline and deterministic
    alert: { console: false, file: true, dingtalk: { enabled: false }, webhook: { enabled: false } },
    crm: { enabled: false },
  });
  config.outDir = tmp;

  const scenarios = {
    'US-01': { dom: F.accountHealthDom('Healthy', 256), text: F.TEXT_HEALTHY },
    'US-02': { dom: F.accountHealthDom('At Risk', 120), text: F.TEXT_AT_RISK },
    'JP-01': { dom: null, text: F.TEXT_NO_STATUS },
    'DE-01': { throwOnOpen: 'store open failed: browser busy' },
  };

  const mockZn = {
    async storeOpen({ name, id }) {
      const key = String(id || name);
      if (scenarios[key]?.throwOnOpen) throw new Error(scenarios[key].throwOnOpen);
      return { storeId: `mock-${key}`, storeName: key, kernelDownloading: false, raw: {} };
    },
    async visit() {
      return {};
    },
    async currentUrl() {
      return 'https://sellercentral.amazon.com/performance/dashboard';
    },
    async execExtract(storeId, script) {
      if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
        return { result: {
          probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
          liveDocument: true, traversalComplete: true,
        } };
      }
      const key = storeId.replace(/^mock-/, '');
      const dom = scenarios[key]?.dom;
      if (!dom) throw new Error('page exec 未能取回提取结果（marker 缺失）');
      return { result: runExtractor(F.envFor(dom)), via: 'exec-return' };
    },
    async content(storeId) {
      const key = storeId.replace(/^mock-/, '');
      return { text: scenarios[key]?.text ?? '', raw: {} };
    },
    async screenshot() {
      return { path: null, raw: {} };
    },
    async storeClose() {
      return {};
    },
  };

  const stores = [
    { key: 'US-01', name: 'US-01', id: 'US-01', host: 'sellercentral.amazon.com', market: 'US' },
    { key: 'US-02', name: 'US-02', id: 'US-02', host: 'sellercentral.amazon.com', market: 'US' },
    { key: 'JP-01', name: 'JP-01', id: 'JP-01', host: 'sellercentral.amazon.co.jp', market: 'JP' },
    { key: 'DE-01', name: 'DE-01', id: 'DE-01', host: 'sellercentral.amazon.de', market: 'DE' },
  ];

  const quiet = { ...logger, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
  const summary = await runStoreHealth({ zn: mockZn, config, stores, logger: quiet, opts: { slot: 'selftest' } });

  check('4 个店铺全部产出结果', () => eq(summary.results.length, 4, 'results.length'));

  check('健康店铺判正常', () => {
    const r = summary.results.find((x) => x.storeKey === 'US-01');
    eq(r.status, 'HEALTHY', 'status');
    eq(r.ok, true, 'ok');
    eq(r.severity, 'OK', 'severity');
    eq(r.ahrScore, 256, 'ahrScore');
    eq(r.confidence, 'high', 'confidence');
  });

  check('At Risk 店铺判异常且为 CRITICAL', () => {
    const r = summary.results.find((x) => x.storeKey === 'US-02');
    eq(r.status, 'AT_RISK', 'status');
    eq(r.ok, false, 'ok');
    eq(r.severity, 'CRITICAL', 'severity');
    ok(r.anomalyReasons.length > 0, '应给出异常原因');
  });

  check('DOM 失败 + 文本无状态词 → UNKNOWN，算异常而不是漏报', () => {
    const r = summary.results.find((x) => x.storeKey === 'JP-01');
    eq(r.status, 'UNKNOWN', 'status');
    eq(r.ok, false, 'ok');
    eq(r.severity, 'ERROR', 'severity');
  });

  check('打开店铺失败 → ERROR，且不拖垮其他店铺', () => {
    const r = summary.results.find((x) => x.storeKey === 'DE-01');
    eq(r.status, 'ERROR', 'status');
    eq(r.ok, false, 'ok');
    ok(r.error && /browser busy/.test(r.error), `error 应保留原因，实际 ${r.error}`);
  });

  check('汇总计数正确', () => {
    eq(summary.totals.total, 4, 'total');
    eq(summary.totals.healthy, 1, 'healthy');
    eq(summary.totals.abnormal, 3, 'abnormal');
  });

  check('生成了 json / csv / html / latest 四个产物', () => {
    for (const k of ['json', 'csv', 'html', 'latest']) {
      ok(fs.existsSync(summary.reportFiles[k]), `${k} 报表缺失: ${summary.reportFiles[k]}`);
    }
  });

  check('CSV 表头与行数正确，且状态可读', () => {
    const csv = fs.readFileSync(summary.reportFiles.csv, 'utf8');
    const lines = csv.trim().split('\n');
    eq(lines.length, 5, '1 表头 + 4 数据行');
    ok(lines[0].includes('policy') || lines[0].includes('status'), '表头应含状态列');
    ok(csv.includes('US-01'), 'CSV 应含店铺 key');
  });

  check('HTML 报表可生成且含判定规则说明', () => {
    const html = toHtml(summary);
    ok(html.includes('Policy Compliance'), 'HTML 应含检查项名称');
    ok(html.includes('Healthy 为正常'), 'HTML 应写明判定规则');
  });

  check('CSV 转义不会被逗号/引号破坏', () => {
    const csv = toCsv([
      { check: 'x', runId: 'r', slot: 's', checkedAt: 'now', storeKey: 'a,b', storeName: 'he said "hi"',
        storeId: '1', market: 'US', url: 'u', status: 'HEALTHY', ok: true, severity: 'OK', confidence: 'high',
        verdictSource: 'dom', ahrScore: 1, ahrScorePrev: null, ahrDelta: null, statusPrev: null,
        statusChanged: false, anomalyReasons: [], attempts: 1, durationMs: 1, screenshot: null,
        rawTextFile: null, error: null },
    ]);
    ok(csv.includes('"a,b"'), '含逗号的字段应加引号');
    ok(csv.includes('"he said ""hi"""'), '双引号应转义为两个');
  });

  check('报警写入了本地 JSONL 审计文件', () => {
    const dir = path.join(tmp, 'alerts');
    ok(fs.existsSync(dir), 'alerts 目录应存在');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    ok(files.length > 0, '应有 alerts jsonl');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n')[0]);
    eq(rec.check, 'store-health', 'check');
    ok(/异常/.test(rec.title), `报警标题应指出异常，实际: ${rec.title}`);
  });

  check('状态落盘，供下次跑对比分数', () => {
    const st = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'store-health.json'), 'utf8'));
    eq(st.stores['US-01'].ahrScore, 256, 'US-01 分数');
    eq(st.stores['US-02'].status, 'AT_RISK', 'US-02 状态');
  });

  process.stdout.write('\n[6] 排程单元生成（含 Linux systemd 分支）\n');

  check('北京时间 → 本机时间换算（固定 UTC+8，无夏令时）', () => {
    const p = bjParts();
    // Beijing 08:00 is 00:00 UTC; assert against UTC directly so the result is
    // independent of whichever timezone this test happens to run in.
    const inst = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 8 - 8, 0, 0));
    eq(inst.getUTCHours(), 0, 'Beijing 08:00 的 UTC 小时');
    const l = beijingToLocal('08:00');
    eq(l.hour, inst.getHours(), '本机小时应与同一时刻一致');
    eq(l.minute, 0, '分钟');
    eq(beijingToLocal('15:30').minute, 30, '15:30 的分钟');
  });

  check('systemd service unit 结构正确', () => {
    const u = serviceUnit({
      unit: 'amzguard-store-health-am',
      nodeBin: '/usr/bin/node',
      cliPath: '/opt/app/src/cli.js',
      cwd: '/opt/app',
      args: ['run-slot', 'am'],
      home: '/home/ops',
    });
    ok(u.startsWith('[Unit]'), '应以 [Unit] 开头');
    ok(u.includes('Type=oneshot'), '应是 oneshot');
    ok(u.includes('Environment=TZ=Asia/Shanghai'), '必须固定北京时区');
    ok(u.includes('ExecStart=/usr/bin/node /opt/app/src/cli.js run-slot am'), `ExecStart 不对:\n${u}`);
    // 退出码 1 = 发现异常，是检查成功而不是单元失败
    ok(u.includes('SuccessExitStatus=0 1'), '退出码 1 必须视为成功');
    ok(u.includes('After=graphical-session.target'), '需要图形会话');
    ok(u.includes('/home/ops/.local/bin'), 'PATH 应包含用户级 bin');
    ok(!u.includes('/opt/homebrew'), 'Linux unit 不应出现 Homebrew 路径');
  });

  check('未指定 --display 时不写死 DISPLAY', () => {
    const base = { unit: 'u', nodeBin: 'node', cliPath: 'c', cwd: '/w', args: [] };
    ok(!serviceUnit(base).includes('DISPLAY'), '默认不应注入 DISPLAY');
    ok(serviceUnit({ ...base, display: ':0' }).includes('Environment=DISPLAY=:0'), '显式指定时应注入');
  });

  check('systemd timer unit 结构正确且时间零填充', () => {
    const t = timerUnit({ unit: 'amzguard-store-health-pm', hour: 8, minute: 5, beijingAt: '15:30' });
    ok(t.includes('OnCalendar=*-*-* 08:05:00'), `OnCalendar 零填充不对: ${t}`);
    ok(t.includes('Persistent=true'), '关机期间错过要补跑');
    ok(t.includes('WantedBy=timers.target'), '需要 [Install] 段');
    ok(t.includes('北京时间 15:30'), '描述里应保留原始北京时间');
  });

  check('macOS plist 结构正确', () => {
    const p = macPlist({
      label: 'com.singal.amzguard.store-health.am',
      nodeBin: '/usr/local/bin/node', cliPath: '/app/src/cli.js', cwd: '/app',
      args: ['run-slot', 'am'], hour: 8, minute: 0, home: '/Users/x',
    });
    ok(p.includes('<key>Label</key>'), '应有 Label');
    ok(p.includes('<integer>8</integer>'), '小时');
    ok(p.includes('/opt/homebrew/bin'), 'macOS PATH 应含 Homebrew');
    ok(p.includes('<key>TZ</key><string>Asia/Shanghai</string>'), '固定北京时区');
    ok(p.includes('<string>run-slot</string>') && p.includes('<string>am</string>'), '整批参数应逐个成为 <string>');
  });

  check('macOS 看板 plist 为本地常驻服务', () => {
    const p = macServerPlist({
      label: 'com.singal.amzguard.dashboard', nodeBin: '/usr/bin/node',
      serverPath: '/app/src/server.js', cwd: '/app', port: 4173, home: '/Users/x',
    });
    ok(p.includes('<key>KeepAlive</key><true/>'), '看板必须自动重启');
    ok(p.includes('<key>RunAtLoad</key><true/>'), '看板必须登录即启动');
    ok(p.includes('<key>HOST</key><string>127.0.0.1</string>'), '默认只允许本机访问');
    ok(p.includes('<key>PORT</key><string>4173</string>'), '端口必须写入环境');
  });

  check('cron 兜底行含 PATH 与 TZ', () => {
    const lines = cronLines({
      slots: [{ name: 'am', at: '08:00' }, { name: 'pm', at: '15:30' }],
      root: '/opt/app', nodeBin: '/usr/bin/node', command: 'run-slot', platform: 'linux', home: '/home/ops',
    });
    ok(lines[0].startsWith('PATH='), '首行应是 PATH');
    ok(lines[1] === 'TZ=Asia/Shanghai', `次行应是 TZ，实际 ${lines[1]}`);
    eq(lines.length, 4, 'PATH + TZ + 2 个时段');
    ok(lines[3].includes('run-slot pm'), 'pm 行必须运行整批检查');
    ok(/^\d+ \d+ \* \* \*/.test(lines[2]), `cron 时间字段格式: ${lines[2]}`);
  });

  process.stdout.write('\n[7] 跨店并发（池上限与顺序）\n');

  {
    // mapWithConcurrency is async, so these are awaited before being asserted.
    const items = [1, 2, 3, 4, 5, 6, 7];
    const slow = (ms) => new Promise((r) => setTimeout(r, ms));

    const r1 = await mapWithConcurrency(items, async (x) => {
      await slow(10);
      return x * 10;
    }, { limit: 1 });
    check('并发=1 时峰值为 1（严格步进）', () => {
      eq(r1.peakActive, 1, 'peakActive');
      eq(JSON.stringify(r1.results), JSON.stringify(items.map((x) => x * 10)), 'results');
    });

    const r3 = await mapWithConcurrency(items, async (x) => {
      await slow(25);
      return x * 10;
    }, { limit: 3 });
    check('并发=3 时峰值恰为 3，绝不越界', () => {
      eq(r3.peakActive, 3, 'peakActive');
      eq(r3.limit, 3, 'limit');
    });
    check('结果顺序与输入一致（与完成顺序无关）', () => {
      eq(JSON.stringify(r3.results), JSON.stringify([10, 20, 30, 40, 50, 60, 70]), 'results');
    });

    // Completion order deliberately reversed relative to input order.
    const rOrder = await mapWithConcurrency([100, 50, 10], async (ms, i) => {
      await slow(ms);
      return i;
    }, { limit: 3 });
    check('先完成的任务不会挤占前面的位置', () => {
      eq(JSON.stringify(rOrder.results), JSON.stringify([0, 1, 2]), 'results');
    });

    const rClamp = await mapWithConcurrency([1, 2], async (x) => x, { limit: 99 });
    check('上限被收敛到任务数，不会开多余的 lane', () => eq(rClamp.limit, 2, 'limit'));

    const t0 = Date.now();
    await mapWithConcurrency([1, 2, 3], async (x) => x, { limit: 3, staggerMs: 30 });
    const spent = Date.now() - t0;
    check('staggerMs 真的错开启动，而不是并行等同样久', () => {
      // 3 个任务、间隔 30ms => 第1个立刻、第2个 +30、第3个 +60
      ok(spent >= 55, `应至少耗时 ~60ms，实际 ${spent}ms（说明各 lane 在并行等待，没真正错开）`);
      ok(spent < 200, `不应过度延迟，实际 ${spent}ms`);
    });

    // Slow tasks must not accumulate stagger debt: by the time a lane finishes,
    // the gate is long past, so it should start the next item immediately.
    const t1 = Date.now();
    await mapWithConcurrency([1, 2, 3, 4], async () => {
      await slow(40);
    }, { limit: 1, staggerMs: 30 });
    const spentSlow = Date.now() - t1;
    check('任务耗时 > 间隔时不产生累积延迟', () => {
      // 4 × 40ms 串行 = 160ms；若错误地累加间隔会变成 ~250ms+
      ok(spentSlow < 230, `应接近 160ms（无累积），实际 ${spentSlow}ms`);
    });
  }

  check('单店内部步骤不受并发影响（并发只跨店）', () => {
    // The pool is only ever handed whole stores; probeStore's own steps are
    // plain sequential awaits. Guard that intent against future edits.
    const src = fs.readFileSync(new URL('../checks/store-health.js', import.meta.url), 'utf8');
    ok(src.includes('mapWithConcurrency('), '应使用并发池');
    const probeBody = src.slice(src.indexOf('async function probeStore'), src.indexOf('async function checkOneStore'));
    ok(!/mapWithConcurrency|Promise\.all|Promise\.race/.test(probeBody),
      'probeStore 内部不得出现并发原语——同一亚马逊会话必须串行');
  });

  process.stdout.write('\n[8] 全流程在并发下结果一致\n');

  const summary3 = await runStoreHealth({
    zn: mockZn, config, stores, logger: quiet, opts: { slot: 'selftest-conc', concurrency: 3 },
  });

  check('并发=3 的判定结果与步进一致', () => {
    const byKey = (s) => Object.fromEntries(s.results.map((r) => [r.storeKey, r.status]));
    eq(JSON.stringify(byKey(summary3)), JSON.stringify(byKey(summary)), '各店状态');
  });

  check('报表记录了执行方式与实测并发峰值', () => {
    eq(summary3.execution.mode, 'concurrent', 'mode');
    eq(summary3.execution.concurrencyLimit, 3, 'concurrencyLimit');
    ok(summary3.execution.peakActive >= 2, `峰值应 >1，实际 ${summary3.execution.peakActive}`);
    eq(summary.execution.mode, 'sequential', '默认应是步进');
  });

  check('并发下 CSV 行序仍与店铺清单一致', () => {
    const rows = fs.readFileSync(summary3.reportFiles.csv, 'utf8').trim().split('\n').slice(1);
    const keys = rows.map((l) => l.split(',')[4]);
    eq(JSON.stringify(keys), JSON.stringify(stores.map((s) => s.key)), 'CSV 行序');
  });

  process.stdout.write("\n[9] 跨次对比（分数下降报警）\n");
  // Second run with a lower score — must raise a WARN even though it stays Healthy.
  scenarios['US-01'] = { dom: F.accountHealthDom('Healthy', 210), text: F.TEXT_HEALTHY.replace('256', '210') };
  const summary2 = await runStoreHealth({
    zn: mockZn, config, stores: [stores[0]], logger: quiet, opts: { slot: 'selftest2' },
  });

  check('Healthy 但分数下降 → WARN 且列出原因', () => {
    const r = summary2.results[0];
    eq(r.status, 'HEALTHY', 'status');
    eq(r.ahrScorePrev, 256, 'ahrScorePrev');
    eq(r.ahrScore, 210, 'ahrScore');
    eq(r.ahrDelta, -46, 'ahrDelta');
    eq(r.severity, 'WARN', 'severity');
    ok(r.anomalyReasons.some((x) => x.includes('下降')), '应说明分数下降');
  });

  const recoveredStateFile = path.join(tmp, 'state', 'store-health.json');
  const recoveredState = JSON.parse(fs.readFileSync(recoveredStateFile, 'utf8'));
  recoveredState.stores['US-01'].status = 'AT_RISK';
  recoveredState.stores['US-01'].ahrScore = 210;
  fs.writeFileSync(recoveredStateFile, JSON.stringify(recoveredState));
  const recovered = await runStoreHealth({
    zn: mockZn, config, stores: [stores[0]], logger: quiet, opts: { slot: 'selftest-recovered' },
  });

  check('明确 Healthy 的恢复事件只记历史，不占用当前业务待办', () => {
    const r = recovered.results[0];
    eq(r.status, 'HEALTHY', 'status');
    eq(r.severity, 'OK', 'severity');
    eq(r.statusChanged, true, 'statusChanged');
    ok(r.notes.some((x) => x.includes('状态已恢复')), '恢复记录应保留在 notes');
    ok(!r.anomalyReasons.some((x) => x.includes('状态发生变化')), '恢复不应进入 anomalyReasons');
  });

  check('CRM 载荷结构完整可用', () => {
    ok(summary2.crm && summary2.crm.attempted === false, 'CRM 未配置时应跳过而不是报错');
  });

  process.stdout.write('\n[10] 第 2～9 项判定规则与双路保守合并\n');

  check('第 2～9 项注入脚本全部为 ASCII 且语法有效', () => {
    for (const def of [...GENERIC_CHECKS, asinDetailDef, { id: 'ads-portfolios', extractor: ADS_PORTFOLIO_EXTRACTOR }]) {
      const detailScript = typeof def.detailExtractor === 'function'
        ? def.detailExtractor({ asin: 'B012345678' }) : def.detailExtractor;
      for (const script of [def.extractor, def.linkExtractor, detailScript, def.detailOpenExtractor?.('B012345678')].filter(Boolean)) {
        ok(!/[^\x00-\x7F]/.test(script), `${def.id} extractor 含非 ASCII 字符`);
        ok(!script.includes('`') && !script.includes('${'), `${def.id} extractor 含不兼容的模板字符串语法`);
        new Function('window', 'document', 'location', 'NodeFilter', 'URL', script);
      }
    }
    ok(performanceCheck.extractor.includes('performance/v4'), '绩效 extractor marker 应为 v4');
    ok(outletCheck.extractor.includes('outlet/v5'), 'Outlet extractor marker 应为 v5');
  });

  check('绩效检查：DOM 标红告警必须异常', () => {
    const v = performanceCheck.judge({
      dom: { redTexts: [{ text: 'Action required', matchesWarnVocab: true }], redCount: 1, sections: [] },
      txt: performanceCheck.parseText('Account Health action required policy warning'),
    });
    eq(v.status, 'ATTENTION_REQUIRED', 'status');
    eq(v.ok, false, 'ok');
  });

  check('广告组合投放中不能覆盖子活动暂停，开关和投放状态冲突保持未知', () => {
    eq(effectiveCampaignState({ statusText: '正在投放' }, { statusText: '已暂停', toggle: 'PAUSED' }), 'OFF');
    eq(effectiveCampaignState({ statusText: '已暂停' }, { statusText: '正在投放', toggle: 'ENABLED' }), 'OFF');
    eq(effectiveCampaignState({ statusText: '正在投放' }, { statusText: '正在投放', toggle: 'PAUSED' }), 'UNKNOWN');
    eq(effectiveCampaignState({ statusText: '正在投放' }, { statusText: '已存档', toggle: 'PAUSED' }), 'EXCLUDED');
    eq(effectiveCampaignState({ statusText: '正在投放' }, { statusText: 'Out of budget', toggle: 'ENABLED' }), 'LIMITED');
  });

  check('绩效检查：Violations 0 是零计数栏目，不得误报', () => {
    const text = 'Account Health Policy Compliance Healthy Listing Policy Violations 0 Other Policy Violations (0) Policy warning: 0';
    const txt = performanceCheck.parseText(text);
    const env = F.envFor(e('body', {}, {}, e('main', {}, {}, text)));
    const dom = new Function('window', 'document', 'location', 'NodeFilter', performanceCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    const v = performanceCheck.judge({ dom, txt });
    eq(txt.warnCount, 0, 'warnCount');
    eq(txt.nonzeroSignals.length, 0, 'text nonzero count');
    ok(txt.zeroCountSignals.length >= 2, '页面文本应输出结构化零计数');
    eq(dom.nonzeroSignals.length, 0, 'DOM nonzero count');
    ok(dom.zeroCountSignals.length >= 2, 'DOM 应输出结构化零计数');
    ok(dom.pageComplete && txt.pageComplete, '双路均应取得明确零违规信号');
    eq(performanceCheck.ready({ dom, txt }), true, 'ready');
    eq(v.status, 'CLEAR', 'status');
    eq(v.ok, true, 'ok');
  });

  check('绩效检查：真实中文全类别零计数整页必须双路 CLEAR', () => {
    const text = [
      '账户状况 政策合规性 良好 账户状况评级 544 所有问题',
      '涉嫌侵犯知识产权 0 收到的知识产权投诉 0',
      '商品真实性买家投诉 0 商品状况买家投诉 0 食品和商品安全问题 0',
      '上架政策违规 0 违反受限商品政策 0',
      '违反买家商品评论政策 0 其他违反政策 0 监管合规性 0',
    ].join(' ');
    const txt = performanceCheck.parseText(text);
    const env = F.envFor(e('body', {}, {}, e('main', {}, {}, text)));
    const dom = new Function('window', 'document', 'location', 'NodeFilter', performanceCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    const v = performanceCheck.judge({ dom, txt });
    eq(txt.nonzeroSignals.length, 0, 'text nonzero count');
    eq(dom.nonzeroSignals.length, 0, 'DOM nonzero count');
    eq(txt.zeroCountSignals.length, 10, 'text structured zero count');
    eq(dom.zeroCountSignals.length, 10, 'DOM structured zero count');
    ok(dom.pageComplete && txt.pageComplete, '双路页面完整');
    eq(v.status, 'CLEAR', 'status');
    eq(v.severity, 'OK', 'severity');
    eq(v.ok, true, 'ok');
  });

  check('绩效检查：账户状况保障计划的“不停用”正向文案不得误报', () => {
    const text = [
      '账户状况 政策合规性 良好 账户状况评级 344 所有问题',
      '涉嫌侵犯知识产权 0 知识产权投诉 0 商品真实性买家投诉 0',
      '商品状况买家投诉 0 食品和商品安全问题 0 上架政策违规 0',
      '违反受限商品政策 0 违反买家商品评论政策 0 其他违反政策 0 监管合规性 0',
      '账户状况保障计划 您已注册！加入账户状况保障计划后，只要您与我们合作解决出现的任何问题，我们就不会停用您的销售账户。',
    ].join(' ');
    const txt = performanceCheck.parseText(text);
    const env = F.envFor(e('body', {}, {}, e('main', {}, {}, text)));
    const dom = new Function('window', 'document', 'location', 'NodeFilter', performanceCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    const v = performanceCheck.judge({ dom, txt });
    eq(txt.warnCount, 0, 'positive assurance copy warning count');
    eq(v.status, 'CLEAR', 'positive assurance copy status');
    eq(v.ok, true, 'positive assurance copy ok');

    const genuineWarning = performanceCheck.parseText(
      '账户状况 政策合规性 良好 账户状况评级 344 您的销售账户可能被停用，请立即处理',
    );
    ok(genuineWarning.warnCount > 0, 'genuine deactivation warning must remain actionable');
  });

  check('绩效检查：真实中文词序及监管合规性逐类别非零必须双路 CRITICAL', () => {
    const cases = [
      ['账户状况 政策合规性 违反受限商品政策 2', 'restricted_product_policy_violations'],
      ['账户状况 政策合规性 违反买家商品评论政策 2', 'customer_reviews_policy_violations'],
      ['账户状况 政策合规性 其他违反政策 2', 'other_policy_violations'],
      ['账户状况 政策合规性 监管合规性 2', 'regulatory_compliance'],
      ['Account Health Policy Compliance Regulatory Compliance 2', 'regulatory_compliance'],
    ];
    for (const [text, expectedKey] of cases) {
      const txt = performanceCheck.parseText(text);
      const env = F.envFor(e('body', {}, {}, e('main', {}, {}, text)));
      const dom = new Function('window', 'document', 'location', 'NodeFilter', performanceCheck.extractor)(
        env.window, env.document, env.location, NodeFilter,
      );
      const v = performanceCheck.judge({ dom, txt });
      eq(txt.nonzeroSignals.length, 1, `${expectedKey} text signal count`);
      eq(txt.nonzeroSignals[0].key, expectedKey, `${expectedKey} text key`);
      eq(txt.nonzeroSignals[0].count, 2, `${expectedKey} text count`);
      eq(dom.nonzeroSignals.length, 1, `${expectedKey} DOM signal count`);
      eq(dom.nonzeroSignals[0].key, expectedKey, `${expectedKey} DOM key`);
      eq(dom.nonzeroSignals[0].count, 2, `${expectedKey} DOM count`);
      eq(v.status, 'ATTENTION_REQUIRED', `${expectedKey} status`);
      eq(v.severity, 'CRITICAL', `${expectedKey} severity`);
      eq(v.ok, false, `${expectedKey} ok`);
    }
  });

  check('绩效检查：中英文已知类别的显式非零计数必须直接判为 CRITICAL', () => {
    const cases = [
      ['Account Health Policy Compliance Healthy Account Health Rating 344 Listing Policy Violations 2', 'listing_policy_violations'],
      ['账户状况 政策合规性 良好 账户状况评级 344 所有问题 上架政策违规 2', 'listing_policy_violations'],
      ['Account Health Policy Compliance Received Intellectual Property Complaints: (2)', 'received_ip_complaints'],
    ];
    for (const [text, expectedKey] of cases) {
      const txt = performanceCheck.parseText(text);
      const env = F.envFor(e('body', {}, {}, e('main', {}, {}, text)));
      const dom = new Function('window', 'document', 'location', 'NodeFilter', performanceCheck.extractor)(
        env.window, env.document, env.location, NodeFilter,
      );
      const v = performanceCheck.judge({ dom, txt });
      eq(txt.nonzeroSignals.length, 1, `${expectedKey} text signal count`);
      eq(txt.nonzeroSignals[0].key, expectedKey, `${expectedKey} text key`);
      eq(txt.nonzeroSignals[0].count, 2, `${expectedKey} text count`);
      eq(dom.nonzeroSignals.length, 1, `${expectedKey} DOM signal count`);
      eq(dom.nonzeroSignals[0].key, expectedKey, `${expectedKey} DOM key`);
      eq(dom.nonzeroSignals[0].count, 2, `${expectedKey} DOM count`);
      eq(v.status, 'ATTENTION_REQUIRED', `${expectedKey} status`);
      eq(v.severity, 'CRITICAL', `${expectedKey} severity`);
      eq(v.metrics.nonzeroViolationSignals, 1, `${expectedKey} merged signal count`);
      ok(v.reasons.some((reason) => reason.includes('= 2')), `${expectedKey} reason`);
    }
    const textOnly = performanceCheck.parseText(
      'Account Health Policy Compliance Listing Policy Violations 2',
    );
    const oneRoute = performanceCheck.judge({
      dom: {
        landed: true, redTexts: [], redCount: 0, sections: [], hasRedWarning: false,
        nonzeroSignals: [], pageComplete: false,
      },
      txt: textOnly,
    });
    eq(oneRoute.status, 'ATTENTION_REQUIRED', '任一路非零 status');
    eq(oneRoute.severity, 'CRITICAL', '任一路非零 severity');
    eq(oneRoute.metrics.domNonzeroViolationSignals, 0, '任一路 DOM count');
    eq(oneRoute.metrics.textNonzeroViolationSignals, 1, '任一路 text count');
  });

  check('绩效检查：违规只要仍存在就持续警告，只有页面清除才恢复正常', () => {
    const store = { key: 'S-PERF-EVENT', market: 'US' };
    const evidence = (count) => {
      const text = `Account Health Policy Compliance Healthy Account Health Rating 344 Listing Policy Violations ${count}`;
      const txt = performanceCheck.parseText(text);
      const env = F.envFor(e('body', {}, {}, e('main', {}, {}, text)));
      const dom = new Function('window', 'document', 'location', 'NodeFilter', performanceCheck.extractor)(
        env.window, env.document, env.location, NodeFilter,
      );
      return { dom, txt };
    };
    const first = performanceCheck.judge({ ...evidence(2), store, prev: null });
    eq(first.status, 'ATTENTION_REQUIRED', 'first performance event');
    eq(first.metrics.activeBusinessEventCount, 1, 'first active event count');
    const repeated = performanceCheck.judge({
      ...evidence(2), store, prev: { metrics: first.metrics },
    });
    eq(repeated.status, 'ATTENTION_REQUIRED', 'stable violation keeps warning');
    eq(repeated.severity, 'CRITICAL', 'stable violation stays critical');
    eq(repeated.metrics.businessStatus, 'ANOMALY', 'stable violation is never archived');
    const changed = performanceCheck.judge({
      ...evidence(3), store, prev: { metrics: first.metrics },
    });
    eq(changed.status, 'ATTENTION_REQUIRED', 'changed count remains warning');
    eq(changed.metrics.activeBusinessEventCount, 1, 'changed count remains active');
    const partial = performanceCheck.judge({
      dom: { ...evidence(2).dom, pageComplete: false }, txt: evidence(2).txt,
      store, prev: { metrics: first.metrics },
    });
    eq(partial.status, 'ATTENTION_REQUIRED', 'partial evidence cannot clear a violation');
    const cleared = performanceCheck.judge({
      ...evidence(0), store, prev: { metrics: first.metrics },
    });
    eq(cleared.status, 'CLEAR', 'explicit zero clears the persistent warning');
    eq(cleared.severity, 'OK', 'explicit zero is normal');
  });

  check('绩效检查：帮助文案与 180 天窗口数字不得冒充违规计数', () => {
    const cases = [
      'Account Health Policy Compliance Healthy Account Health Rating 344 Learn more about Listing Policy Violations. Listing Policy Violations 180 days. How to avoid violations.',
      '账户状况 政策合规性 良好 账户状况评级 344 了解上架政策违规 此页面显示过去 180 天的记录',
    ];
    for (const text of cases) {
      const txt = performanceCheck.parseText(text);
      const env = F.envFor(e('body', {}, {}, e('main', {}, {}, text)));
      const dom = new Function('window', 'document', 'location', 'NodeFilter', performanceCheck.extractor)(
        env.window, env.document, env.location, NodeFilter,
      );
      const v = performanceCheck.judge({ dom, txt });
      eq(txt.nonzeroSignals.length, 0, 'text nonzero signal count');
      eq(dom.nonzeroSignals.length, 0, 'DOM nonzero signal count');
      eq(v.metrics.nonzeroViolationSignals, 0, 'merged signal count');
      eq(v.status, 'CLEAR', 'help-only page status');
      eq(v.severity, 'OK', 'help-only page severity');
    }
  });

  check('绩效检查：只有标题落地而无指标/零违规信号时必须 PARTIAL', () => {
    const txt = performanceCheck.parseText('Account Health Policy Compliance dashboard');
    const v = performanceCheck.judge({
      dom: {
        landed: true, redTexts: [], redCount: 0, sections: [], hasRedWarning: false,
        zeroNormalSignalCount: 0, healthyNormalSignalCount: 0, metricSignalCount: 0,
        pageComplete: false,
      },
      txt,
    });
    eq(v.status, 'PARTIAL_EVIDENCE', 'status');
    eq(v.severity, 'ERROR', 'severity');
    eq(v.ok, false, 'ok');
    eq(v.baselineEligible, false, 'baselineEligible');
    eq(performanceCheck.ready({ dom: v.metrics, txt }), false, 'shell ready');
  });

  check('绩效检查：中文健康状态加真实指标可作为双路正常证据', () => {
    const text = '账户状况 政策合规性 良好 账户状况评级 344';
    const txt = performanceCheck.parseText(text);
    const env = F.envFor(e('body', {}, {}, e('main', {}, {}, text)));
    const dom = new Function('window', 'document', 'location', 'NodeFilter', performanceCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    const v = performanceCheck.judge({ dom, txt });
    ok(dom.pageComplete && txt.pageComplete, '中文双路完整');
    eq(v.status, 'CLEAR', 'status');
    eq(v.ok, true, 'ok');
    eq(performanceCheck.ready({ dom, txt }), true, 'ready');
  });

  check('中文 Seller Central 页面可被第 2/3/6/7 项确认落地', () => {
    const performance = performanceCheck.parseText('账户状况 政策合规性 良好 账户状况评级 344 所有问题 上架政策违规 0');
    const feedback = feedbackCheck.parseText('反馈管理器 反馈评级 5 / 5 82 total ratings 最新反馈');
    const outlet = outletCheck.parseText('在单个视图中管理您的亚马逊物流库存 创建奥特莱斯限时促销 0 条结果 您的查询未返回任何结果');
    const voc = vocCheck.parseText('买家之声 买家满意度状况 B0ABCDEF12 买家不满意率 2.5%');
    ok(performance.landed && performance.warnCount === 0, '中文绩效页应落地且零违规不告警');
    ok(feedback.landed && feedback.aggregateRating === 5 && feedback.total === 0, '中文 Feedback 应落地并区分汇总评分');
    ok(outlet.landed && outlet.zeroResults && outlet.mentionCount === 0, '中文奥特莱斯零结果应落地且不误报');
    ok(voc.landed && voc.asinCount === 1, '中文 VOC 应落地并识别 ASIN');

    const run = (def, text) => {
      const env = F.envFor(e('body', {}, {}, e('div', {}, {}, text)));
      return new Function('window', 'document', 'location', 'NodeFilter', def.extractor)(env.window, env.document, env.location, NodeFilter);
    };
    ok(run(performanceCheck, '账户状况 政策合规性 良好 账户状况评级 344').landed, '绩效 DOM 中文落地');
    ok(run(feedbackCheck, '反馈管理器 反馈评级 5 / 5 最新反馈').landed, 'Feedback DOM 中文落地');
    const outletDom = run(outletCheck, '管理亚马逊物流库存 创建奥特莱斯限时促销 0 条结果 未返回任何结果');
    ok(outletDom.landed && outletDom.zeroResults, '奥特莱斯 DOM 中文落地');
    ok(run(vocCheck, '买家之声 买家满意度状况 B0ABCDEF12').landed, 'VOC DOM 中文落地');
  });

  check('Feedback：当天低分任一路发现即提醒，绝不漏报', () => {
    const v = feedbackCheck.judge({
      dom: { landed: true, total: 1, ratings: [{ rating: 5, date: 'Sep 4, 2026' }] },
      txt: {
        landed: true, total: 2,
        ratingItems: [
          { rating: 2, date: 'Sep 4, 2026', identifier: 'TODAY-1' },
          { rating: 1, date: '2026-09-04', identifier: 'TODAY-2' },
        ],
      },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(v.status, 'TODAY_LOW_RATING', 'status');
    eq(v.metrics.lowCount, 2, 'lowCount');
  });

  check('Feedback：历史低分不跨天报警，当天双路无低分才可正常', () => {
    const ratings = [
      { rating: 1, date: 'Sep 3, 2026', identifier: 'YESTERDAY' },
      { rating: 5, date: 'Sep 4, 2026', identifier: 'TODAY' },
    ];
    const v = feedbackCheck.judge({
      dom: { landed: true, total: 2, ratings },
      txt: { landed: true, total: 2, ratingItems: ratings },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(v.status, 'CLEAR', 'status');
    eq(v.metrics.lowCount, 0, 'today low count');
    eq(v.metrics.historicalIgnoredCount, 1, 'historical ignored');
  });

  check('Feedback：仅双路明确标识的亚马逊物流责任差评才排除', () => {
    const summary = 'This item was fulfilled by Amazon, and we take responsibility for this fulfillment experience.';
    const txt = feedbackCheck.parseText(`Feedback Manager Sep 4, 2026 1 out of 5 ${summary}`);
    eq(txt.ratingItems[0].amazonFulfillmentExcluded, true, 'text fulfillment marker');
    const v = feedbackCheck.judge({
      dom: { landed: true, total: 1, ratings: [{ rating: 1, date: 'Sep 4, 2026', summary }] },
      txt,
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(v.status, 'CLEAR', 'confirmed Amazon fulfillment feedback is excluded');
    eq(v.metrics.amazonFulfillmentExcludedLowCount, 1, 'excluded low count');

    const conflict = feedbackCheck.judge({
      dom: { landed: true, total: 1, ratings: [{ rating: 1, date: 'Sep 4, 2026', summary }] },
      txt: { landed: true, total: 1, ratingItems: [{ rating: 1, date: 'Sep 4, 2026', summary: 'Buyer feedback' }] },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(conflict.status, 'TODAY_LOW_RATING', 'one-route exclusion cannot hide a low rating');
  });

  check('Inbox：双路发现未读买家消息必须提醒且交给运营', () => {
    const v = inboxCheck.judge({
      dom: {
        landed: true, totalRows: 6, unreadCount: 2, markerVocabulary: true, paginationComplete: true,
        unreadRows: [
          { date: 'Sep 4, 2026', unread: true, needsResponse: false, identifier: '123-1234567-1234567', source: 'dom-unread-marker' },
          { date: 'Sep 1, 2026', unread: true, needsResponse: true, identifier: null, source: 'dom-needs-response' },
        ],
      },
      txt: { landed: true, totalRows: 6, unreadCount: 2, declaredUnread: 2, markerVocabulary: true },
      store: { key: 'STORE-A', name: 'Store A' },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(v.status, 'NEW_BUYER_MESSAGE', 'status');
    eq(v.ok, false, 'ok');
    eq(v.severity, 'WARN', 'severity');
    eq(v.metrics.unreadCount, 2, 'unreadCount');
    eq(v.metrics.todayUnreadCount, 1, 'todayUnreadCount');
    eq(v.metrics.oldestUnreadAt, '2026-09-01', 'oldestUnreadAt');
    eq(v.metrics.businessStatus, 'ANOMALY', 'businessStatus');
    eq(v.items.length, 2, 'items');
    ok(v.items.every((item) => item.itemKey), '未读消息必须有稳定 itemKey');
    // Privacy: only counts, dates and a visible order id may be retained.
    const allowed = new Set(['date', 'unread', 'needsResponse', 'identifier', 'source', 'storeKey', 'storeName', 'itemKey']);
    ok(v.items.every((item) => Object.keys(item).every((key) => allowed.has(key))), '不得落盘买家姓名、主题或消息正文');
  });

  check('Inbox：只有一路发现未读也必须提醒，绝不漏报', () => {
    const v = inboxCheck.judge({
      dom: {
        landed: true, totalRows: 4, unreadCount: 1, markerVocabulary: true, paginationComplete: true,
        unreadRows: [{ date: 'Sep 4, 2026', unread: true, needsResponse: false, source: 'dom-unread-marker' }],
      },
      txt: { landed: true, totalRows: 4, unreadCount: null },
      store: { key: 'STORE-A' },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(v.status, 'NEW_BUYER_MESSAGE', 'status');
    eq(v.metrics.unreadCount, 1, 'unreadCount');
    eq(v.metrics.countsAgree, false, 'countsAgree');
  });

  check('Inbox：双路确认空收件箱才可判正常', () => {
    const v = inboxCheck.judge({
      dom: { landed: true, totalRows: 0, unreadCount: 0, emptyState: true, paginationComplete: true, markerVocabulary: true },
      txt: { landed: true, totalRows: 0, unreadCount: 0, emptyState: true, markerVocabulary: true },
      store: { key: 'STORE-A' },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(v.status, 'CLEAR', 'status');
    eq(v.ok, true, 'ok');
    eq(v.severity, 'OK', 'severity');
    eq(v.metrics.confirmedEmpty, true, 'confirmedEmpty');
  });

  check('Inbox：无法量化未读状态时按采集异常，不得假绿', () => {
    const unquantifiedText = inboxCheck.judge({
      dom: { landed: true, totalRows: 5, unreadCount: 0, markerVocabulary: true, paginationComplete: true },
      txt: { landed: true, totalRows: 5, unreadCount: null },
      store: { key: 'STORE-A' },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(unquantifiedText.status, 'PARTIAL_EVIDENCE', 'text cannot quantify unread');
    eq(unquantifiedText.severity, 'ERROR', 'severity');
    eq(unquantifiedText.ok, false, 'ok');

    const noMarker = inboxCheck.judge({
      dom: { landed: true, totalRows: 5, unreadCount: null, markerVocabulary: false, paginationComplete: true },
      txt: { landed: true, totalRows: 5, unreadCount: 0, emptyState: false },
      store: { key: 'STORE-A' },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(noMarker.status, 'PARTIAL_EVIDENCE', 'DOM without read-state marker cannot prove zero unread');
    eq(noMarker.metrics.collectionStatus, 'PARTIAL_EVIDENCE', 'collectionStatus');

    const nothing = inboxCheck.judge({
      dom: { landed: true, totalRows: 0, unreadCount: null },
      txt: { landed: true, totalRows: 0, unreadCount: null },
      store: { key: 'STORE-A' },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(nothing.status, 'UNKNOWN', 'no evidence at all');
  });

  check('Inbox：未确认读完分页时 0 未读不得判正常', () => {
    const v = inboxCheck.judge({
      dom: { landed: true, totalRows: 25, unreadCount: 0, markerVocabulary: true, paginationComplete: false, hasNextPage: true },
      txt: { landed: true, totalRows: 25, unreadCount: 0, declaredUnread: 0, markerVocabulary: true },
      store: { key: 'STORE-A' },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(v.status, 'PARTIAL_EVIDENCE', 'status');
    eq(v.ok, false, 'ok');
    ok(v.reasons.some((reason) => /分页/.test(reason)), '必须说明分页未读完');
  });

  check('Inbox：加粗样式不作为未读依据，但要提示人工复核', () => {
    const v = inboxCheck.judge({
      dom: {
        landed: true, totalRows: 5, unreadCount: 0, boldRowCount: 3,
        markerVocabulary: true, paginationComplete: true, unreadRows: [],
      },
      txt: { landed: true, totalRows: 5, unreadCount: 0, declaredUnread: 0, markerVocabulary: true },
      store: { key: 'STORE-A' },
      config: { _now: new Date('2026-09-04T03:00:00Z') },
    });
    eq(v.status, 'CLEAR', 'status');
    eq(v.metrics.boldRowCount, 3, 'boldRowCount');
    ok(v.reasons.some((reason) => /加粗/.test(reason)), '加粗行必须提示人工复核');
  });

  check('Inbox：DOM 未读标识与页面文本计数两路独立可解析', () => {
    const body = e('body', {}, {},
      e('h1', {}, {}, 'Buyer-Seller Messaging'),
      e('div', { class: 'filters' }, {}, e('span', { class: 'tab' }, {}, 'Unread 1')),
      e('table', {}, {},
        e('tr', { class: 'message-row header' }, {}, e('th', {}, {}, 'From'), e('th', {}, {}, 'Subject'), e('th', {}, {}, 'Date')),
        e('tr', { class: 'message-row unread' }, {},
          e('td', {}, { fontWeight: '700' }, 'Buyer'),
          e('td', {}, {}, 'Question about order 123-1234567-1234567'),
          e('td', {}, {}, 'Sep 4, 2026'),
        ),
        e('tr', { class: 'message-row' }, {},
          e('td', {}, {}, 'Buyer'),
          e('td', {}, {}, 'Thanks'),
          e('td', {}, {}, 'Sep 2, 2026'),
        ),
      ),
    );
    const env = F.envFor(body, 'https://sellercentral.amazon.com/messaging/inbox');
    const dom = new Function('window', 'document', 'location', 'NodeFilter', inboxCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    ok(dom.landed, 'Inbox DOM 落地');
    eq(dom.markerVocabulary, true, 'markerVocabulary');
    eq(dom.unreadCount, 1, 'DOM 未读数');
    eq(dom.unreadRows.length, 1, '未读行数');
    eq(dom.unreadRows[0].identifier, '123-1234567-1234567', '订单号');
    eq(dom.unreadRows[0].date, 'Sep 4, 2026', '未读行日期');
    eq(dom.paginationComplete, true, '无下一页即视为已读完列表');
    ok(!JSON.stringify(dom).includes('Thanks'), '已读行内容不得进入未读证据');

    const txt = inboxCheck.parseText('Buyer-Seller Messaging Unread 1 From Subject Date Sep 4, 2026 Question about order');
    ok(txt.landed, 'Inbox 文本落地');
    eq(txt.unreadCount, 1, '文本未读数');
    eq(txt.declaredUnread, 1, '文本声明的未读数');

    const empty = inboxCheck.parseText('Buyer-Seller Messaging From Subject Date You have no messages');
    eq(empty.emptyState, true, '文本空收件箱');
    eq(empty.unreadCount, 0, '空收件箱未读数为 0');

    const zhEmpty = inboxCheck.parseText('买家消息 发件人 主题 日期 暂无消息');
    ok(zhEmpty.landed && zhEmpty.emptyState && zhEmpty.unreadCount === 0, '中文空收件箱应落地并判 0 未读');
    const zhUnread = inboxCheck.parseText('消息中心 未读 2 发件人 主题 日期 2026年9月4日');
    eq(zhUnread.unreadCount, 2, '中文未读计数');
  });

  check('Inbox：注入脚本严格只读，不含任何点击或提交动作', () => {
    const script = inboxCheck.extractor;
    ok(!/\.click\s*\(/.test(script), 'Inbox extractor 不得点击任何控件');
    ok(!/\.submit\s*\(|dispatchEvent|requestSubmit/.test(script), 'Inbox extractor 不得触发事件或提交');
    ok(!/location\s*\.\s*(?:href|assign|replace)\s*=/.test(script), 'Inbox extractor 不得导航');
    ok(inboxCheck.paths.every((p) => !/thread|conversation-detail|messageId/i.test(p)), 'Inbox 只允许列表页，不得进入会话详情');
  });

  check('Inbox：左侧导航的“需要回复”筛选项不得算成买家消息（真机回归）', () => {
    // Verbatim main-document text observed on a live store: Seller Central keeps
    // the messaging filters in page chrome while the table renders in a nested
    // document. Counting the phrase reported a phantom unread for every store.
    const navChrome = '站点地图 卖家平台 Fun Toys LLC 美国 良好 管理商品 反馈管理器 绩效通知 买家之声'
      + ' 广告控制台 其他资源 买家与卖家消息服务 收件箱 折叠 全部 需要回复 已发送消息 已解决 已报告未解决 站点地图 计划政策 反馈';
    const txt = inboxCheck.parseText(navChrome);
    ok(txt.landed, '导航文案仍会落地在消息页');
    eq(txt.needsResponsePhrases, 1, '筛选项只记为文案出现次数');
    eq(txt.unreadCount, null, '导航筛选项不得产生未读计数');
    eq(txt.chromeOnly, true, 'chromeOnly');
    eq(txt.emptyState, false, '不得把导航文案当成空收件箱');

    const v = inboxCheck.judge({
      dom: {
        landed: true, totalRows: 0, datedRows: 0, unreadCount: null, markerVocabulary: false,
        emptyState: false, paginationComplete: false, visibleFrameCount: 1, frameContentReadable: true,
        unreadRows: [],
      },
      txt,
      store: { key: 'XCAI' },
      config: { _now: new Date('2026-09-04T09:00:00Z') },
    });
    eq(v.status, 'UNKNOWN', '既无行也无可量化未读时不得报业务异常');
    eq(v.severity, 'ERROR', 'severity');
    eq(v.metrics.unreadCount, 0, '不得凭导航文案上报未读数');
    eq(v.metrics.listOutsideMainDocument, true, 'listOutsideMainDocument');
    ok(v.reasons.some((reason) => /嵌套文档|iframe/.test(reason)), '必须说明列表不在主文档');
    ok(v.reasons.some((reason) => /导航/.test(reason)), '必须说明筛选项不计数');
  });

  check('Inbox：没有任何列表行时不得声称已读完分页', () => {
    const env = F.envFor(e('body', {}, {},
      e('h1', {}, {}, '买家与卖家消息服务'),
      e('nav', {}, {}, e('a', {}, {}, '全部'), e('a', {}, {}, '需要回复'), e('a', {}, {}, '已解决')),
    ), 'https://sellercentral.amazon.com/messaging/inbox');
    const dom = new Function('window', 'document', 'location', 'NodeFilter', inboxCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    eq(dom.totalRows, 0, '导航链接不是消息行');
    eq(dom.unreadCount, null, 'DOM 未读数无法判定');
    eq(dom.paginationComplete, false, '零行不得视为列表完整');
    ok((dom.notes || []).some((note) => /rows not found/.test(note)), '必须记录未找到列表行');
  });

  check('Inbox：经 Seller Central 导航发现消息入口，不冷启动深链', () => {
    eq(inboxCheck.bootstrapPath, '/home', '必须先经 Seller Central 首页恢复会话');
    eq(inboxCheck.preferFollowedLink, true, '优先使用点击导航得到的地址');
    ok(Array.isArray(inboxCheck.navigationLink?.labels) && inboxCheck.navigationLink.labels.length > 0, '必须声明导航入口标签');
    const env = F.envFor(e('body', {}, {},
      e('div', { id: 'nav' }, {},
        e('a', { href: '/feedback-manager/index.html' }, {}, '反馈管理器'),
        e('a', { href: '/messaging/inbox?ref=xx_nav' }, {}, '买家与卖家消息服务'),
        e('a', { href: 'https://advertising.amazon.com/cm/campaigns' }, {}, '广告活动管理'),
      ),
    ), 'https://sellercentral.amazon.com/home');
    const link = new Function('window', 'document', 'location', 'NodeFilter', inboxCheck.linkExtractor)(
      env.window, env.document,
      { ...env.location, protocol: 'https:', host: 'sellercentral.amazon.com' },
      NodeFilter,
    );
    eq(link.landed, true, '应发现消息入口');
    eq(link.href, 'https://sellercentral.amazon.com/messaging/inbox?ref=xx_nav', '应补全为绝对 Seller Central 地址');
  });

  check('Inbox：需要回复筛选视图下每一行都是待回复消息', () => {
    const body = e('body', {}, {},
      e('h1', {}, {}, '买家与卖家消息服务'),
      e('div', { class: 'filter-chip' }, {}, '需要回复'),
      e('table', {}, {},
        e('tr', { class: 'message-row' }, {}, e('td', {}, {}, 'Buyer'), e('td', {}, {}, '订单 123-1234567-1234567'), e('td', {}, {}, 'Sep 4, 2026')),
        e('tr', { class: 'message-row' }, {}, e('td', {}, {}, 'Buyer'), e('td', {}, {}, '咨询'), e('td', {}, {}, 'Sep 3, 2026')),
      ),
    );
    const env = F.envFor(body, 'https://sellercentral.amazon.com/messaging/inbox-v3?fi=responseNeeded');
    const dom = new Function('window', 'document', 'location', 'NodeFilter', inboxCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    eq(dom.responseNeededFilter, true, '应识别 fi=responseNeeded 筛选视图');
    eq(dom.messagingV3, true, '应识别 messaging v3');
    eq(dom.unreadCount, 2, '筛选视图下行数即待回复数');
    eq(dom.unreadRows[0].source, 'dom-response-needed-filter', '证据来源');
    eq(dom.unreadRows[0].identifier, '123-1234567-1234567', '订单号');

    const txt = inboxCheck.parseText('买家与卖家消息服务 需要回复 Sep 4, 2026 订单 Sep 3, 2026 咨询');
    eq(txt.filterLabelPresent, true, '文本应看到同一筛选上下文');
    const v = inboxCheck.judge({
      dom, txt, store: { key: 'XCAI' }, config: { _now: new Date('2026-09-04T09:00:00Z') },
    });
    eq(v.status, 'NEW_BUYER_MESSAGE', 'status');
    eq(v.severity, 'WARN', 'severity');
    eq(v.metrics.unreadCount, 2, 'unreadCount');
    eq(v.metrics.textUnreadCount, 2, '文本路径独立计数');
    eq(v.metrics.countsAgree, true, 'countsAgree');
    eq(v.metrics.todayUnreadCount, 1, '当天新增');
    eq(inboxCheck.ready({ dom, txt }), true, '筛选视图取到行即为就绪');
  });

  check('Inbox：需要回复筛选视图为空且双路一致才判正常', () => {
    const body = e('body', {}, {},
      e('h1', {}, {}, '买家与卖家消息服务'),
      e('div', {}, {}, '需要回复'),
      e('div', {}, {}, '暂无消息'),
    );
    const env = F.envFor(body, 'https://sellercentral.amazon.com/messaging/inbox-v3?fi=responseNeeded');
    const dom = new Function('window', 'document', 'location', 'NodeFilter', inboxCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    eq(dom.emptyState, true, 'DOM 空态');
    eq(dom.unreadCount, 0, 'DOM 未读 0');
    eq(dom.paginationComplete, true, '空列表即完整');
    const txt = inboxCheck.parseText('买家与卖家消息服务 需要回复 暂无消息');
    const v = inboxCheck.judge({
      dom, txt, store: { key: 'XCAI' }, config: { _now: new Date('2026-09-04T09:00:00Z') },
    });
    eq(v.status, 'CLEAR', 'status');
    eq(v.ok, true, 'ok');
    eq(v.severity, 'OK', 'severity');
  });

  check('Inbox：未校准时快速失败并保留截图，不拖慢批次也不假绿', () => {
    ok(inboxCheck.readyTimeoutMs <= 30000, '单店等待上限不得回到分钟级');
    eq(inboxCheck.retryFreshSessionWhenNotReady, false, '换新会话对未挂载的列表无效，不得重复开销');
    eq(inboxCheck.screenshotRequiresReady, false, '解析未就绪时仍保留截图供运营肉眼核对');
    ok(inboxCheck.minWindowWidth >= 1400, '双栏布局需要桌面级窗口宽度，否则列表窗格不渲染');
    const runnerSource = fs.readFileSync(new URL('../lib/check-runner.js', import.meta.url), 'utf8');
    ok(/ensureWindowSize/.test(runnerSource), 'runner 必须在采集前按需放大窗口');
    const v = inboxCheck.judge({
      dom: {
        landed: true, totalRows: 0, unreadCount: null, responseNeededFilter: true,
        emptyState: false, paginationComplete: false, visibleFrameCount: 0, unreadRows: [],
      },
      txt: { landed: true, totalRows: 0, unreadCount: null, chromeOnly: true, filterLabelPresent: true },
      store: { key: 'XCAI' },
      config: { _now: new Date('2026-09-04T09:00:00Z') },
    });
    eq(v.ok, false, '读不到列表时绝不判正常');
    eq(v.severity, 'ERROR', '按采集待修复交技术');
    eq(v.metrics.businessStatus, 'CLEAR', '不得伪造业务异常');
  });

  check('Inbox：真机 v3 页面「需要回复 0 + 没有需要回复的消息」必须判正常', () => {
    // Verbatim main-document text from the live store after the window was
    // widened. The metrics header carries a date range ("2026年9月4日") that an
    // earlier build mistook for a message row and reported a phantom message.
    const realText = '取消 开始使用 | 更多 查看指标 8月5日 - 2026年9月4日的全球通信指标。选择一张卡片了解更多详情。'
      + ' 需要注意的问题 0 需要回复 0已报告未解决 0 已解决的问题 0 今天已解决的问题 0'
      + ' 收件箱 折叠 全部 需要回复 已发送消息 已解决 已报告未解决 筛选条件 (0) 1 没有需要回复的消息。'
      + ' 站点地图 计划政策 © 1999-2026，Amazon.com, Inc. 或其附属公司 反馈';
    const txt = inboxCheck.parseText(realText);
    eq(txt.landed, true, 'landed');
    eq(txt.declaredPending, 0, '应读到亚马逊自报的待回复数 0');
    eq(txt.emptyState, true, '应识别「没有需要回复的消息」空态');
    eq(txt.unreadCount, 0, '未读数为 0');
    eq(txt.chromeOnly, false, '列表已渲染，不再是纯导航');

    const v = inboxCheck.judge({
      dom: {
        landed: true, responseNeededFilter: true, messagingV3: true,
        declaredPending: 0, unreadCount: 0, emptyState: true, paginationComplete: true,
        totalRows: 0, unreadRows: [],
      },
      txt,
      store: { key: 'XCAI' },
      config: { _now: new Date('2026-09-04T10:30:00Z') },
    });
    eq(v.status, 'CLEAR', 'status');
    eq(v.ok, true, '双路一致的 0 待回复必须判正常');
    eq(v.severity, 'OK', 'severity');
    eq(v.metrics.unreadCount, 0, 'unreadCount');
    eq(v.metrics.businessStatus, 'CLEAR', 'businessStatus');
    eq(v.metrics.collectionStatus, 'COMPLETE', 'collectionStatus');
  });

  check('Inbox：指标卡的日期区间不得被当成消息行', () => {
    const body = e('body', {}, {},
      e('h1', {}, {}, '买家与卖家消息服务'),
      e('div', { class: 'metrics-card' }, {}, '8月5日 - 2026年9月4日的全球通信指标。选择一张卡片了解更多详情。'),
      e('div', { class: 'metrics-tiles' }, {}, e('span', {}, {}, '需要回复 0'), e('span', {}, {}, '已报告未解决 0')),
      e('div', { class: 'list-empty' }, {}, '没有需要回复的消息。'),
    );
    const env = F.envFor(body, 'https://sellercentral.amazon.com/messaging/inbox-v3?fi=responseNeeded');
    const dom = new Function('window', 'document', 'location', 'NodeFilter', inboxCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    eq(dom.responseNeededFilter, true, '筛选视图');
    eq(dom.declaredPending, 0, '应读到页面自报的 0');
    eq(dom.unreadCount, 0, 'unreadCount');
    eq(dom.totalRows, 0, '指标日期区间不得成为消息行');
    eq(dom.paginationComplete, true, '自报 0 即为完整');
  });

  check('Reviews：未解析到星级必须 UNKNOWN，不能当正常', () => {
    const v = reviewsCheck.judge({ dom: { landed: true, lowCount: 0, total: 0 }, txt: { landed: true, lowCount: 0, total: 0 } });
    eq(v.status, 'UNKNOWN', 'status');
    eq(v.ok, false, 'ok');
    eq(v.metrics.collectionStatus, 'PARTIAL_EVIDENCE', 'collectionStatus');
    ok(reviewsCheck.screenshotRequiresReady === true, 'loading shell must not become screenshot evidence');
    ok(reviewsCheck.retryFreshSessionWhenNotReady === true, 'loading shell must trigger one fresh session');
    ok(reviewsCheck.maxAttempts >= 4, 'two internal errors plus spinner must leave a fourth attempt');
  });

  check('Reviews：DOM 有星级但文本未解析评分时必须 PARTIAL，不能假绿', () => {
    const v = reviewsCheck.judge({
      dom: { landed: true, lowCount: 0, total: 10, lowReviews: [] },
      txt: { landed: true, lowCount: 0, total: 0, lowReviews: [] },
    });
    eq(v.status, 'PARTIAL_EVIDENCE', 'status');
    eq(v.severity, 'ERROR', 'severity');
    eq(v.ok, false, 'ok');
    eq(v.metrics.collectionStatus, 'PARTIAL_EVIDENCE', 'collectionStatus');
  });

  check('Reviews：中文买家评论页可落地并识别低星', () => {
    const txt = reviewsCheck.parseText('买家评论 星级评定 2 / 5 星');
    ok(txt.landed && txt.lowCount === 1, '中文 Reviews 文本应落地并读取低星');
    const env = F.envFor(e('body', {}, {},
      e('h1', {}, {}, '买家评论'),
      e('kat-star-rating', { class: 'reviewRating', value: '2' }, {}, ''),
    ));
    const dom = new Function('window', 'document', 'location', 'NodeFilter', reviewsCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    ok(dom.landed && dom.lowCount === 1, '中文 Reviews DOM 应落地并读取低星');
  });

  check('Reviews：评论正文里裸露的 N/5 不是评分标签（2026-09-17 真机回归）', () => {
    const pageText = [
      '买家评论',
      '56 条评论',
      '筛选依据',
      '订单类型',
      '星级评定 (3)',
      '3 星',
      '2 星',
      '1 星',
      '时间段',
      '标记为已完成的包含在内',
      'A.R.E.K. Verdict: 3/5. Installation was easy, but Plain Paper performance is poor.',
      'Daniel B. 于 2026年9月13日 发布的评论',
      "don't work",
      'They sent the wrong size. I would say 4/5 overall.',
      '3 out of 5 stars',
      '1 out of 5 stars',
      '2 out of 5 stars',
      '1 / 5',
    ].join('\n');
    const parsed = reviewsCheck.parseText(pageText);
    eq(parsed.landed, true, '仍应落地');
    eq(parsed.total, 4, '只有评分标签（带星后缀或整行独立）计入文本星数');
    eq(parsed.lowCount, 4, '评论正文中的裸 3/5、4/5 不得计入低星');
  });

  check('Reviews：相邻评论不得把后一条低星绑定到前一条 ASIN', () => {
    const body = e('body', {}, {},
      e('h1', {}, {}, 'Customer Reviews'),
      e('main', {}, {},
        e('article', {}, {},
          e('div', {}, {}, 'Review by Alice on August 20, 2026 Great Parent ASINB0AAAAAA11 Child ASINB0AAAAAA11 BrandALPHA'),
          e('kat-star-rating', { class: 'productRating', value: '4.8', 'aria-label': '4.8 out of 5 stars' }, {}, ''),
          e('kat-star-rating', { class: 'reviewRating', value: '5' }, {}, ''),
        ),
        e('article', {}, {},
          e('div', {}, {}, 'Review by Bob on August 21, 2026 Broken Parent ASINB0BBBBBB22 Child ASINB0BBBBBB22 BrandBETA'),
          e('kat-star-rating', { class: 'productRating', value: '3.2', 'aria-label': '3.2 out of 5 stars' }, {}, ''),
          e('kat-star-rating', { class: 'reviewRating', value: '1' }, {}, ''),
        ),
      ),
    );
    const env = F.envFor(body);
    const dom = new Function('window', 'document', 'location', 'NodeFilter', reviewsCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    eq(dom.lowReviews.length, 1, 'one low review');
    eq(dom.lowReviews[0].parentAsin, 'B0BBBBBB22', 'low review parent ASIN');
    eq(dom.lowReviews[0].author, 'Bob', 'low review author');
    ok(!dom.lowReviews[0].context.includes('B0AAAAAA11'), 'must not include previous row');
  });

  check('Reviews：中文操作控件文字不得混入评论人', () => {
    const body = e('body', {}, {},
      e('h1', {}, {}, '买家评论'),
      e('article', {}, {},
        e('div', {}, {}, '标记为已完成Mei Helms Descant 于 2026年8月25日 发布的评论 Broken 父 ASINB0GTM1CFV8 子 ASINB0GTM1CFV8 品牌USEHOTI'),
        e('kat-star-rating', { class: 'reviewRating', value: '1' }, {}, ''),
      ),
    );
    const env = F.envFor(body);
    const dom = new Function('window', 'document', 'location', 'NodeFilter', reviewsCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    eq(dom.lowReviews[0].author, 'Mei Helms Descant', 'clean author');
  });

  check('Feedback：相邻记录不得把后一条低分绑定到前一条 ASIN', () => {
    const body = e('body', {}, {},
      e('h1', {}, {}, 'Feedback Manager'),
      e('main', {}, {},
        e('article', {}, {}, e('div', {}, {}, 'Recent Feedback B0AAAAAA11 Aug 20, 2026 good'), e('span', { 'aria-label': '5 out of 5 stars' }, {}, '')),
        e('article', {}, {}, e('div', {}, {}, 'Recent Feedback B0BBBBBB22 Aug 21, 2026 bad'), e('span', { 'aria-label': '1 out of 5 stars' }, {}, '')),
      ),
    );
    const env = F.envFor(body);
    const dom = new Function('window', 'document', 'location', 'NodeFilter', feedbackCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    eq(dom.lowRatings.length, 1, 'one low feedback');
    eq(dom.lowRatings[0].asin, 'B0BBBBBB22', 'low feedback ASIN');
    ok(!dom.lowRatings[0].context.includes('B0AAAAAA11'), 'must not include previous row');
  });

  check('Feedback：Katal 星级组件 value 必须形成 DOM 独立证据', () => {
    const body = e('body', {}, {},
      e('h1', {}, {}, 'Feedback Manager'),
      e('main', {}, {},
        e('div', {}, {}, 'Feedback Rating'),
        e('kat-star-rating', { value: '5' }, {}, ''),
        e('div', {}, {}, '5 out of 5 82 total ratings Recent Feedback'),
      ),
    );
    const env = F.envFor(body);
    const dom = new Function('window', 'document', 'location', 'NodeFilter', feedbackCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    const txt = feedbackCheck.parseText('Feedback Manager Feedback Rating 5 out of 5 82 total ratings Recent Feedback');
    eq(dom.total, 0, 'aggregate DOM rating is not a feedback row');
    eq(dom.aggregateRating, 5, 'aggregate DOM rating remains an informational metric');
    eq(txt.total, 0, 'aggregate text rating is not a feedback row');
    eq(feedbackCheck.ready({ dom, txt }), false, 'aggregate-only shell is not ready');
  });

  check('Feedback：Katal 明细星级必须绑定同行日期，加载转圈不得冒充空表', () => {
    const rowBody = e('body', {}, {},
      e('h1', {}, {}, 'Feedback Manager'),
      e('section', {}, {},
        e('h2', {}, {}, 'Recent Feedback'),
        e('div', {}, {}, 'Date Rating Order ID Comments Actions'),
        e('article', {}, {},
          e('span', {}, {}, 'Sep 4, 2026 Order ID TEST-ORDER-0001'),
          e('kat-star-rating', { value: '2' }, {}, ''),
        ),
      ),
    );
    const rowEnv = F.envFor(rowBody);
    const rowDom = new Function('window', 'document', 'location', 'NodeFilter', feedbackCheck.extractor)(
      rowEnv.window, rowEnv.document, rowEnv.location, NodeFilter,
    );
    eq(rowDom.ratings[0].date, 'Sep 4, 2026', 'Katal row date');

    const loadingBody = e('body', {}, {},
      e('h1', {}, {}, 'Feedback Manager'),
      e('section', {}, {},
        e('h2', {}, {}, 'Recent Feedback'),
        e('div', {}, {}, 'Date Rating Order ID Comments Actions'),
        e('kat-spinner', { role: 'progressbar' }, {}, ''),
      ),
    );
    const loadingEnv = F.envFor(loadingBody);
    const loadingDom = new Function('window', 'document', 'location', 'NodeFilter', feedbackCheck.extractor)(
      loadingEnv.window, loadingEnv.document, loadingEnv.location, NodeFilter,
    );
    eq(loadingDom.loading, true, 'spinner detected');
    eq(loadingDom.emptyState, false, 'spinner is not empty evidence');

    const emptyText = feedbackCheck.parseText('Feedback Manager Recent Feedback Date Rating Order ID Comments Actions');
    eq(emptyText.emptyState, true, 'settled text table is empty evidence');
    ok(feedbackCheck.readyMinWaitMs >= 10000, 'empty grid must remain under observation');
    eq(minimumReadyAgeSatisfied(feedbackCheck, 1000, 10999), false, 'minimum wait not reached');
    eq(minimumReadyAgeSatisfied(feedbackCheck, 1000, 13000), true, 'minimum wait reached');
  });

  check('Reviews：页面文本只证明低星数量，不猜测相邻 ASIN', () => {
    const parsed = reviewsCheck.parseText('Customer Reviews Parent ASINB0AAAAAA11 good review 5 out of 5 stars trailing labels Parent ASINB0BBBBBB22 bad review 1 out of 5 stars');
    eq(parsed.lowCount, 1, 'low count');
    eq(parsed.lowReviews[0].asin, undefined, 'text fallback must stay unbound');
    eq(parsed.lowReviews[0].summary, undefined, 'text fallback must not invent row summary');
  });

  check('Feedback 当天低分持续提醒；Reviews 历史低分仍按记录去重', () => {
    const store = { key: 'S-EVENT', name: 'Event Store', market: 'US' };
    const verify = (def, scoreKey, lowField, lowStatus, recordedStatus) => {
      const firstItem = {
        [scoreKey]: 2, asin: 'B012345678', identifier: 'EVENT-0001',
        date: '2026-08-28', summary: 'first low score', source: 'dom',
      };
      const evidence = {
        landed: true, total: 1, lowCount: 1, [lowField]: [firstItem], emptyState: false,
      };
      const first = def.judge({ dom: evidence, txt: evidence, store, prev: null });
      eq(first.status, lowStatus, `${def.id} first status`);
      eq(first.severity, 'CRITICAL', `${def.id} first severity`);
      eq(first.metrics.newLowCount, 1, `${def.id} first new count`);

      const repeated = def.judge({ dom: evidence, txt: evidence, store, prev: { metrics: first.metrics } });
      eq(repeated.status, recordedStatus, `${def.id} repeated status`);
      eq(repeated.severity, 'OK', `${def.id} repeated severity`);
      eq(repeated.metrics.newLowCount, 0, `${def.id} repeated new count`);
      eq(repeated.metrics.businessStatus, 'RECORDED', `${def.id} recorded business state`);

      const secondItem = {
        [scoreKey]: 1, asin: 'B087654321', identifier: 'EVENT-0002',
        date: '2026-08-28', summary: 'second low score', source: 'dom',
      };
      const changed = {
        landed: true, total: 2, lowCount: 2, [lowField]: [firstItem, secondItem], emptyState: false,
      };
      const changedVerdict = def.judge({ dom: changed, txt: changed, store, prev: { metrics: first.metrics } });
      eq(changedVerdict.status, lowStatus, `${def.id} changed status`);
      eq(changedVerdict.metrics.newLowCount, 1, `${def.id} changed new count`);
    };
    verify(reviewsCheck, 'stars', 'lowReviews', 'LOW_REVIEW', 'RECORDED_LOW_REVIEW');

    const feedbackEvidence = {
      landed: true, total: 1, lowCount: 1,
      ratings: [{ rating: 2, asin: 'B012345678', identifier: 'EVENT-0001', date: '2026-08-28', summary: 'same-day low' }],
      ratingItems: [{ rating: 2, asin: 'B012345678', identifier: 'EVENT-0001', date: '2026-08-28', summary: 'same-day low' }],
    };
    const feedbackArgs = {
      dom: feedbackEvidence, txt: feedbackEvidence, store,
      config: { _now: new Date('2026-08-28T03:00:00Z') },
    };
    const firstFeedback = feedbackCheck.judge({ ...feedbackArgs, prev: null });
    const repeatedFeedback = feedbackCheck.judge({ ...feedbackArgs, prev: { metrics: firstFeedback.metrics } });
    eq(firstFeedback.status, 'TODAY_LOW_RATING', 'feedback first status');
    eq(repeatedFeedback.status, 'TODAY_LOW_RATING', 'feedback same-day repeated status');
    eq(repeatedFeedback.severity, 'CRITICAL', 'feedback same-day remains actionable');
  });

  check('Reviews：展示摘要变化不改变业务事件身份', () => {
    const store = { key: 'S-STABLE', name: 'Stable', market: 'US' };
    const evidence = (summary) => ({
      landed: true, total: 1, lowCount: 1,
      lowReviews: [{ stars: 2, asin: 'B012345678', date: 'Aug 28, 2026', title: 'Broken', summary, source: 'kat-star-rating:value' }],
    });
    const firstEvidence = evidence('initial summary');
    const first = reviewsCheck.judge({ dom: firstEvidence, txt: { ...firstEvidence, lowReviews: [] }, store, prev: null });
    const changedEvidence = evidence('same review with slightly changed presentation text');
    const repeated = reviewsCheck.judge({ dom: changedEvidence, txt: { ...changedEvidence, lowReviews: [] }, store, prev: { metrics: first.metrics } });
    eq(repeated.status, 'RECORDED_LOW_REVIEW', 'summary change must remain recorded');
    eq(repeated.metrics.newLowCount, 0, 'summary change new count');
  });

  check('Reviews：品牌页低星只归入拥有对应 ASIN 的店铺', () => {
    const store = { key: 'STORE-A', name: 'Store A', market: 'US' };
    const reviewedAsin = 'B012345678';
    const evidence = {
      landed: true, total: 1, lowCount: 1, emptyState: false,
      lowReviews: [{
        stars: 1, asin: reviewedAsin, date: 'Aug 28, 2026',
        title: 'Broken', summary: 'Arrived broken', source: 'kat-star-rating:value',
      }],
    };
    const owned = reviewsCheck.judge({
      dom: evidence, txt: { ...evidence, lowReviews: [] }, store,
      reviewOwnership: {
        ready: true, storeAsins: new Set([reviewedAsin]),
        ownersByAsin: new Map([[reviewedAsin, new Set(['STORE-A'])]]),
        inventoryCount: 1, source: 'test-inventory',
      },
    });
    eq(owned.status, 'LOW_REVIEW', 'owned status');
    eq(owned.metrics.ownedLowCount, 1, 'owned low count');
    eq(owned.metrics.brandLowCount, 1, 'brand low count');
    eq(owned.items.length, 1, 'owned item retained');
    eq(owned.items[0].ownership, 'OWNED', 'ownership label');

    const other = reviewsCheck.judge({
      dom: evidence, txt: { ...evidence, lowReviews: [] }, store,
      reviewOwnership: {
        ready: true, storeAsins: new Set(['B087654321']),
        ownersByAsin: new Map([[reviewedAsin, new Set(['STORE-B'])]]),
        inventoryCount: 1, source: 'test-inventory',
      },
    });
    eq(other.status, 'CLEAR', 'other-store review must not be a business anomaly');
    eq(other.ok, true, 'other-store review may clear with complete dual evidence');
    eq(other.metrics.ownedLowCount, 0, 'other-store owned count');
    eq(other.metrics.excludedOtherStoreCount, 1, 'other-store excluded count');
    eq(other.items.length, 0, 'other-store item not exported as this store data');
  });

  check('Reviews：范围外 ASIN 被排除，无法绑定的评论仍失败关闭，共享 ASIN 仅在真实共享时同时归属', () => {
    const store = { key: 'STORE-A', name: 'Store A', market: 'US' };
    const reviewedAsin = 'B012345678';
    const evidence = {
      landed: true, total: 1, lowCount: 1, emptyState: false,
      lowReviews: [{
        stars: 2, parentAsin: reviewedAsin, date: 'Aug 28, 2026',
        title: 'Bad', summary: 'Bad item', source: 'kat-star-rating:value',
      }],
    };
    const outOfScope = reviewsCheck.judge({
      dom: evidence, txt: { ...evidence, lowReviews: [] }, store,
      reviewOwnership: {
        ready: true, storeAsins: new Set(['B087654321']), ownersByAsin: new Map(),
        inventoryCount: 1, source: 'test-inventory',
      },
    });
    eq(outOfScope.status, 'CLEAR', 'out-of-scope ASIN status');
    eq(outOfScope.ok, true, 'out-of-scope ASIN is not this store business anomaly');
    eq(outOfScope.metrics.excludedOutOfScopeCount, 1, 'out-of-scope count');

    const unboundEvidence = {
      ...evidence,
      lowReviews: [{
        stars: 2, date: 'Aug 28, 2026', title: 'Bad', summary: 'No ASIN in row',
        source: 'kat-star-rating:value',
      }],
    };
    const unknown = reviewsCheck.judge({
      dom: unboundEvidence, txt: { ...unboundEvidence, lowReviews: [] }, store,
      reviewOwnership: {
        ready: true, storeAsins: new Set(['B087654321']), ownersByAsin: new Map(),
        inventoryCount: 1, source: 'test-inventory',
      },
    });
    eq(unknown.status, 'REVIEW_OWNERSHIP_UNKNOWN', 'unknown ownership status');
    eq(unknown.severity, 'ERROR', 'unknown ownership severity');
    eq(unknown.ok, false, 'unknown ownership cannot pass');
    eq(unknown.metrics.ownershipPendingCount, 1, 'pending ownership count');
    eq(unknown.baselineEligible, false, 'unknown ownership cannot advance baseline');

    const shared = reviewsCheck.judge({
      dom: evidence, txt: { ...evidence, lowReviews: [] }, store,
      reviewOwnership: {
        ready: true, storeAsins: new Set([reviewedAsin]),
        ownersByAsin: new Map([[reviewedAsin, new Set(['STORE-A', 'STORE-B'])]]),
        inventoryCount: 1, source: 'test-inventory',
      },
    });
    eq(shared.status, 'LOW_REVIEW', 'shared owned review remains business anomaly');
    eq(shared.items[0].sharedOwnership, true, 'shared ownership marker');
  });

  check('奥特莱斯：纯文本数量变化只能触发复核，不能伪造新增活动', () => {
    const v = outletCheck.judge({
      dom: { landed: true, createDealCount: 0, textMentionCount: 0, skus: [] },
      txt: { landed: true, mentionCount: 3, activityReliable: true },
      prev: { metrics: { dealCount: 1, dealKeys: [] } },
    });
    eq(v.status, 'PARTIAL_EVIDENCE', 'status');
    eq(v.severity, 'ERROR', 'severity');
    eq(v.metrics.newCount, 0, 'newCount');
    eq(v.metrics.collectionStatus, 'PARTIAL_EVIDENCE', 'collectionStatus');
    eq(v.confidence, 'conflict', 'confidence');
    eq(v.baselineEligible, false, 'baselineEligible');
  });

  check('奥特莱斯：0 results 时筛选标签不算活动', () => {
    const txt = outletCheck.parseText('Manage Inventory Health Recommendation: Create outlet deal 0 results Your query did not return any results');
    const v = outletCheck.judge({
      dom: {
        landed: true, zeroResults: true, zeroResultsReliable: true, scanComplete: true,
        pageComplete: true, paginationComplete: true, ambiguousActionCount: 0,
        createDealCount: 1, textMentionCount: 1, skus: [{ sku: 'sell-through' }],
      },
      txt,
      prev: null,
    });
    eq(v.metrics.dealCount, 0, 'dealCount');
    eq(v.metrics.dealKeys.length, 0, 'dealKeys');
    eq(v.status, 'NO_CHANGE', 'status');
    eq(v.ok, true, 'ok');
    eq(outletCheck.ready({ dom: {
      zeroResults: true, zeroResultsReliable: true, scanComplete: true,
      pageComplete: true, paginationComplete: true, ambiguousActionCount: 0, skus: [],
    }, txt }), true, 'ready');
  });

  check('奥特莱斯：真机中文已选筛选控件不会伪造活动行', () => {
    const filterText = '筛选条件 推荐 已选筛选条件推荐:';
    const emptyText = '0 条结果 未返回任何结果';
    const env = F.envFor(e('body', {}, {},
      e('main', {}, {},
        e('h1', {}, {}, '管理亚马逊物流库存'),
        e('div', { class: 'selected-filters' }, {},
          e('span', {}, {}, filterText),
          e('button', {}, {}, '创建奥特莱斯限时促销')),
        e('div', { class: 'results-table' }, {},
          e('span', {}, {}, '0 条结果'),
          e('span', {}, {}, '未返回任何结果')),
      ),
    ));
    const dom = new Function('window', 'document', 'location', 'NodeFilter', outletCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    const txt = outletCheck.parseText(`${filterText} 创建奥特莱斯限时促销 ${emptyText}`);
    eq(dom.createDealCount, 0, 'DOM activity count');
    eq(dom.skus.length, 0, 'DOM activity rows');
    eq(dom.ignoredFilterControlCount, 1, 'ignored filter controls');
    eq(dom.textMentionCount, 0, 'DOM text mentions');
    ok(dom.zeroResults && dom.pageComplete, 'DOM zero-results evidence complete');
    const v = outletCheck.judge({ dom, txt, prev: null });
    eq(v.status, 'NO_CHANGE', 'status');
    eq(v.confidence, 'high', 'confidence');
    eq(v.metrics.confirmedZero, true, 'confirmedZero');
    eq(v.metrics.ignoredFilterControlCount, 1, 'judged ignored controls');
    eq(outletCheck.ready({ dom, txt }), true, 'ready');

    const legacyDom = {
      ...dom,
      createDealCount: 1,
      ignoredFilterControlCount: 0,
      skus: [{
        asin: null, sku: null, offerId: null, actionFound: true,
        row: '筛选条件 已选筛选条件推荐:创建奥特莱斯限时促销 0 条结果',
      }],
    };
    const defended = outletCheck.judge({ dom: legacyDom, txt, prev: null });
    eq(defended.status, 'NO_CHANGE', 'judge defense status');
    eq(defended.metrics.confirmedZero, true, 'judge defense confirmedZero');
    eq(defended.metrics.ignoredFilterControlCount, 1, 'judge defense ignored controls');

    const noZeroDom = { ...dom, zeroResults: false, zeroResultsReliable: false, pageComplete: false, paginationComplete: false };
    const noZeroTxt = outletCheck.parseText(`${filterText} 创建奥特莱斯限时促销`);
    const uncertain = outletCheck.judge({ dom: noZeroDom, txt: noZeroTxt, prev: null });
    eq(uncertain.status, 'PARTIAL_EVIDENCE', 'filter without reliable zero status');
    eq(uncertain.metrics.newCount, 0, 'filter without reliable zero newCount');
    eq(uncertain.baselineEligible, false, 'filter without reliable zero baseline');

    const unrelatedTotalTxt = outletCheck.parseText(
      `${filterText} 创建奥特莱斯限时促销 ${emptyText} 总计：1`,
    );
    const unrelatedTotal = outletCheck.judge({
      dom: { ...dom, reportedTotal: 1, reportedTotalReliable: false },
      txt: unrelatedTotalTxt,
      prev: { metrics: { dealCount: 0, dealKeys: [] } },
    });
    eq(unrelatedTotal.status, 'NO_CHANGE', 'unrelated total status');
    eq(unrelatedTotal.metrics.newCount, 0, 'unrelated total newCount');
    eq(unrelatedTotal.metrics.reportedTotalsAgree, false, 'unrelated total reliability');
  });

  check('奥特莱斯：真机页面残留 0 条结果时以当前 1 条商品行和稳定标识为准', () => {
    const filterText = '筛选条件 已选筛选条件 推荐: 创建奥特莱斯限时促销';
    const pageText = `${filterText} 0 条结果 管理亚马逊物流库存 1 条结果 ASIN: B0FTG44VKR SKU: F-920-1T 创建奥特莱斯限时促销`;
    const env = F.envFor(e('body', {}, {},
      e('main', {}, {},
        e('h1', {}, {}, '管理亚马逊物流库存'),
        e('div', { class: 'selected-filters' }, {}, filterText, e('span', {}, {}, '0 条结果')),
        e('div', { class: 'results-table' }, {},
          e('span', {}, {}, '1 条结果'),
          e('table', {}, {}, e('tbody', {}, {}, e('tr', { class: 'record-row' }, {},
            e('td', {}, {}, 'ASIN: B0FTG44VKR SKU: F-920-1T'),
            e('td', {}, {}, e('button', {}, {}, '创建奥特莱斯限时促销')),
          ))),
        ),
      ),
    ));
    const dom = new Function('window', 'document', 'location', 'NodeFilter', outletCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    const txt = outletCheck.parseText(pageText);
    eq(dom.zeroResults, false, 'DOM stale zero ignored');
    eq(dom.reportedTotal, 1, 'DOM current total');
    eq(dom.createDealCount, 1, 'DOM action count');
    eq(dom.skus[0].asin, 'B0FTG44VKR', 'DOM ASIN');
    eq(dom.skus[0].sku, 'F-920-1T', 'DOM SKU');
    eq(txt.zeroResults, false, 'text stale zero ignored');
    eq(txt.reportedTotal, 1, 'text current total');
    eq(txt.mentionCount, 1, 'text action count');
    const verdict = outletCheck.judge({ dom, txt, prev: null, store: { key: 'FENG', market: 'US' } });
    eq(verdict.status, 'NO_CHANGE', 'first run baseline status');
    eq(verdict.metrics.dealCount, 1, 'stable baseline count');
    eq(verdict.metrics.collectionStatus, 'COMPLETE', 'collection status');

    const sparseDom = {
      ...dom,
      reportedTotal: null,
      reportedTotalReliable: false,
    };
    const countOnlyText = {
      ...txt,
      mentionCount: 0,
      activityReliable: false,
      reportedTotal: 1,
      reportedTotalReliable: false,
      pageComplete: false,
      paginationComplete: false,
      hasNextPage: false,
    };
    const sparseVerdict = outletCheck.judge({
      dom: sparseDom, txt: countOnlyText, prev: null,
      store: { key: 'FENG', market: 'US' },
    });
    eq(sparseVerdict.status, 'NO_CHANGE', 'stable DOM row plus independent text count establishes baseline');
    eq(sparseVerdict.metrics.collectionStatus, 'COMPLETE', 'cross-route count corroboration is complete');
    eq(sparseVerdict.metrics.textCountCorroboratesDom, true, 'cross-route count metric');
  });

  check('奥特莱斯：总数、重复控件、跨区域零态与 Shadow DOM 均保守判定', () => {
    const filterTotalTxt = outletCheck.parseText(
      'Manage Inventory Health Recommendation filter: Create outlet deal Total results: 1',
    );
    const filterTotal = outletCheck.judge({
      dom: { landed: true, scanComplete: true, createDealCount: 0, skus: [], pageComplete: false },
      txt: filterTotalTxt,
      prev: { metrics: { dealCount: 0, dealKeys: [] } },
    });
    eq(filterTotal.status, 'PARTIAL_EVIDENCE', 'filter plus total status');
    eq(filterTotal.metrics.newCount, 0, 'filter plus total newCount');

    const stableRow = {
      asin: 'B012345678', sku: 'SKU-1', offerId: null, actionFound: true,
      row: 'B012345678 SKU: SKU-1 Create outlet deal',
    };
    const observed = outletCheck.judge({
      store: { key: 'S1', market: 'US' },
      dom: { landed: true, scanComplete: true, createDealCount: 1, skus: [stableRow] },
      txt: { landed: true, mentionCount: 1, reportedTotal: 1, activityReliable: true },
      prev: null,
    });
    const inflated = outletCheck.judge({
      store: { key: 'S1', market: 'US' },
      dom: {
        landed: true, scanComplete: true, createDealCount: 1, skus: [stableRow],
        reportedTotal: 100, reportedTotalReliable: true,
      },
      txt: { landed: true, mentionCount: 1, reportedTotal: 100, activityReliable: false },
      prev: { metrics: { dealCount: 1, dealKeys: observed.metrics.dealKeys } },
    });
    eq(inflated.status, 'PARTIAL_EVIDENCE', 'unrelated total status');
    eq(inflated.metrics.dealCount, 1, 'unrelated total dealCount');
    eq(inflated.metrics.newCount, 0, 'unrelated total newCount');
    eq(inflated.metrics.reportedTotalGrowth, 0, 'unrelated total growth');

    const duplicate = outletCheck.judge({
      store: { key: 'S1', market: 'US' },
      dom: { landed: true, scanComplete: true, createDealCount: 2, skus: [stableRow, { ...stableRow }] },
      txt: { landed: true, mentionCount: 2, reportedTotal: 2, activityReliable: true },
      prev: { metrics: { dealCount: 1, dealKeys: observed.metrics.dealKeys } },
    });
    eq(duplicate.metrics.dealCount, 1, 'duplicate stable key count');
    eq(duplicate.metrics.newCount, 0, 'duplicate stable key newCount');
    eq(duplicate.metrics.duplicateActionCount, 1, 'duplicate action diagnostics');

    const crossEnv = F.envFor(e('body', {}, {},
      e('main', {}, {},
        e('h1', {}, {}, 'Manage Inventory Health'),
        e('div', { class: 'selected-filters' }, {}, e('span', {}, {}, '0 results')),
        e('div', { class: 'ordinary-tile' }, {},
          e('span', {}, {}, 'ASIN B087654321 SKU: SKU-2'),
          e('div', { class: 'action-cell' }, {}, e('button', {}, {}, 'Create outlet deal'))),
      ),
    ));
    const crossDom = new Function('window', 'document', 'location', 'NodeFilter', outletCheck.extractor)(
      crossEnv.window, crossEnv.document, crossEnv.location, NodeFilter,
    );
    const cross = outletCheck.judge({
      dom: crossDom,
      txt: outletCheck.parseText('Manage Inventory Health selected filters 0 results B087654321 Create outlet deal'),
      prev: { metrics: { dealCount: 0, dealKeys: [] } },
    });
    eq(crossDom.ambiguousActionCount, 1, 'cross-region ambiguous action');
    eq(crossDom.zeroResultNodeCount, 0, 'filter zero is not result zero');
    eq(cross.status, 'PARTIAL_EVIDENCE', 'cross-region status');
    eq(cross.metrics.confirmedZero, false, 'cross-region confirmedZero');

    const shadowHost = e('kat-outlet-table', {}, {});
    shadowHost.shadowRoot = e('div', { class: 'results-table' }, {},
      e('div', { role: 'row' }, {},
        e('span', {}, {}, 'ASIN B0ABCDEF12 SKU: SKU-SHADOW'),
        e('button', {}, {}, 'Create outlet deal')),
    );
    const shadowEnv = F.envFor(e('body', {}, {},
      e('main', {}, {},
        e('h1', {}, {}, 'Manage Inventory Health'),
        e('div', { class: 'results-table' }, {}, e('span', {}, {}, '0 results')),
        shadowHost,
      ),
    ));
    const shadowDom = new Function('window', 'document', 'location', 'NodeFilter', outletCheck.extractor)(
      shadowEnv.window, shadowEnv.document, shadowEnv.location, NodeFilter,
    );
    const shadow = outletCheck.judge({
      store: { key: 'S1', market: 'US' }, shadowDom,
      dom: shadowDom,
      txt: outletCheck.parseText('Manage Inventory Health 0 results'),
      prev: { metrics: { dealCount: 0, dealKeys: [] } },
    });
    ok(shadowDom.scanComplete && shadowDom.traversedRootCount >= 2, 'open shadow root scanned');
    eq(shadowDom.createDealCount, 1, 'shadow action count');
    eq(shadow.status, 'NEW_DEAL', 'shadow action must win over external zero');
    eq(shadow.metrics.newCount, 1, 'shadow newCount');

    const rowAsinHost = e('ipv2-product-details', {}, {});
    rowAsinHost.shadowRoot = e('div', {}, {}, 'ASIN: B0FTG44VKR SKU: F-920-1T');
    rowAsinHost.shadowRoot.getRootNode = () => ({ host: rowAsinHost });
    const rowActionHost = e('kat-dropdown-button', {}, {});
    rowActionHost.shadowRoot = e('div', {}, {}, e('button', {}, {}, 'Create outlet deal'));
    rowActionHost.shadowRoot.getRootNode = () => ({ host: rowActionHost });
    const splitShadowRow = e('kat-table-row', { class: 'record-row row' }, {},
      e('div', {}, {}, 'USEHOTI 920XL Ink Cartridges High Yield Replacement'),
      rowAsinHost,
      rowActionHost,
    );
    const splitShadowEnv = F.envFor(e('body', {}, {},
      e('main', {}, {},
        e('h1', {}, {}, 'Manage Inventory Health'),
        e('div', { class: 'results-table' }, {}, splitShadowRow),
      ),
    ));
    const splitShadowDom = new Function('window', 'document', 'location', 'NodeFilter', outletCheck.extractor)(
      splitShadowEnv.window, splitShadowEnv.document, splitShadowEnv.location, NodeFilter,
    );
    eq(splitShadowDom.ambiguousActionCount, 0, 'split shadow row action is not ambiguous');
    eq(splitShadowDom.createDealCount, 1, 'split shadow row action count');
    eq(splitShadowDom.skus[0].asin, 'B0FTG44VKR', 'split shadow row ASIN binding');
    eq(splitShadowDom.skus[0].sku, 'F-920-1T', 'split shadow row SKU binding');

    const overflowHosts = Array.from({ length: 512 }, (_, i) => {
      const host = e(`kat-shadow-${i}`, {}, {});
      host.shadowRoot = e('div', {}, {});
      return host;
    });
    const overflowEnv = F.envFor(e('body', {}, {},
      e('main', {}, {},
        e('h1', {}, {}, 'Manage Inventory Health'),
        e('div', { class: 'results-table' }, {}, e('span', {}, {}, '0 results')),
        ...overflowHosts,
      ),
    ));
    const overflowDom = new Function('window', 'document', 'location', 'NodeFilter', outletCheck.extractor)(
      overflowEnv.window, overflowEnv.document, overflowEnv.location, NodeFilter,
    );
    const overflow = outletCheck.judge({
      dom: overflowDom,
      txt: outletCheck.parseText('Manage Inventory Health 0 results'),
      prev: { metrics: { dealCount: 0, dealKeys: [] } },
    });
    eq(overflowDom.scanComplete, false, 'root budget overflow scanComplete');
    eq(overflow.status, 'PARTIAL_EVIDENCE', 'root budget overflow status');
    eq(overflow.metrics.confirmedZero, false, 'root budget overflow confirmedZero');
  });

  check('奥特莱斯：双路完整且活动集合数量一致才可确认新增', () => {
    const dom = {
      landed: true, zeroResults: false, createDealCount: 2, textMentionCount: 2,
      reportedTotal: 2, reportedTotalReliable: true, scanComplete: true,
      hasNextPage: false, paginationComplete: true, pageComplete: true,
      skus: [
        { asin: 'B012345678', sku: 'SKU-1', actionFound: true, row: 'B012345678 SKU-1 Create outlet deal' },
        { asin: 'B087654321', sku: 'SKU-2', actionFound: true, row: 'B087654321 SKU-2 Create outlet deal' },
      ],
    };
    const txt = {
      landed: true, zeroResults: false, mentionCount: 2, reportedTotal: 2,
      reportedTotalReliable: true, activityReliable: true,
      hasNextPage: false, paginationComplete: true, pageComplete: true,
    };
    const v = outletCheck.judge({
      store: { key: 'S1', market: 'US' }, dom, txt,
      prev: { metrics: { dealCount: 0, dealKeys: [] } },
    });
    eq(v.status, 'NEW_DEAL', 'status');
    eq(v.severity, 'WARN', 'severity');
    eq(v.metrics.newCount, 2, 'newCount');
    eq(v.metrics.evidenceComplete, true, 'evidenceComplete');
    eq(v.baselineEligible, true, 'baselineEligible');
    eq(outletCheck.ready({ dom, txt }), true, 'ready');
  });

  check('奥特莱斯：空壳、数量冲突或未遍历下一页均不得 NO_CHANGE', () => {
    const shell = outletCheck.judge({
      dom: { landed: true, zeroResults: false, createDealCount: 0, skus: [], pageComplete: false },
      txt: outletCheck.parseText('Manage Inventory Health Outlet recommendations'),
      prev: null,
    });
    eq(shell.status, 'PARTIAL_EVIDENCE', 'shell status');
    eq(shell.baselineEligible, false, 'shell baseline');
    eq(outletCheck.ready({
      dom: { landed: true, zeroResults: false, createDealCount: 0, skus: [], pageComplete: false },
      txt: outletCheck.parseText('Manage Inventory Health Outlet recommendations'),
    }), false, 'shell ready');

    const filterOnlyText = outletCheck.parseText(
      'Manage Inventory Health Recommendation filter: Create outlet deal',
    );
    const filterOnly = outletCheck.judge({
      dom: { landed: true, zeroResults: false, createDealCount: 0, skus: [], pageComplete: false },
      txt: filterOnlyText,
      prev: { metrics: { dealCount: 0, dealKeys: [] } },
    });
    eq(filterOnlyText.activityReliable, false, 'filter activity reliability');
    eq(filterOnly.status, 'PARTIAL_EVIDENCE', 'filter-only status');
    eq(filterOnly.metrics.newCount, 0, 'filter-only newCount');

    const dom = {
      landed: true, zeroResults: false, createDealCount: 1, textMentionCount: 1,
      reportedTotal: 1, hasNextPage: false, paginationComplete: true, pageComplete: true,
      skus: [{ asin: 'B012345678', sku: 'SKU-1', actionFound: true }],
    };
    const conflict = outletCheck.judge({
      dom,
      txt: {
        landed: true, zeroResults: false, mentionCount: 2, reportedTotal: 2,
        hasNextPage: false, paginationComplete: true, pageComplete: true,
      },
      prev: null,
    });
    eq(conflict.status, 'PARTIAL_EVIDENCE', 'count conflict');
    eq(conflict.severity, 'ERROR', 'count conflict severity');

    const pagedText = outletCheck.parseText(
      'Manage Inventory Health SKU-1 Create outlet deal Total results: 2 Next page',
    );
    const paged = outletCheck.judge({ dom: { ...dom, hasNextPage: true, paginationComplete: false, pageComplete: false }, txt: pagedText, prev: null });
    eq(paged.status, 'PARTIAL_EVIDENCE', 'pagination status');
    eq(paged.metrics.paginationComplete, false, 'paginationComplete');
  });

  check('奥特莱斯：分页不完整时只按已观察稳定键报警且不以总数放大', () => {
    const dom = {
      landed: true, reportedTotal: 20, createDealCount: 10,
      reportedTotalReliable: true, scanComplete: true,
      hasNextPage: true, paginationComplete: false, pageComplete: false,
      skus: Array.from({ length: 10 }, (_, i) => ({
        asin: `B0${String(i).padStart(8, '0')}`, sku: `SKU-${i}`, actionFound: true,
        row: `B0${String(i).padStart(8, '0')} SKU-${i} Create outlet deal`,
      })),
    };
    const txt = {
      landed: true, reportedTotal: 20, mentionCount: 10,
      reportedTotalReliable: true, activityReliable: true,
      hasNextPage: true, paginationComplete: false, pageComplete: false,
    };
    const increased = outletCheck.judge({
      dom, txt, prev: { metrics: { dealCount: 10, dealKeys: [] } },
    });
    eq(increased.status, 'NEW_DEAL', 'growth status');
    eq(increased.severity, 'WARN', 'growth severity');
    eq(increased.metrics.newCount, 10, 'growth count');
    eq(increased.metrics.dealCount, 10, 'observed stable rows');
    eq(increased.metrics.dealKeys.length, 10, 'only observed stable keys');
    eq(increased.metrics.collectionStatus, 'PARTIAL_EVIDENCE', 'collection status');
    eq(increased.confidence, 'conflict', 'confidence');
    eq(increased.baselineEligible, false, 'baseline');

    const unchanged = outletCheck.judge({
      dom, txt, prev: { metrics: { dealCount: 20, dealKeys: increased.metrics.dealKeys } },
    });
    eq(unchanged.status, 'PARTIAL_EVIDENCE', 'unchanged partial');
    eq(unchanged.metrics.newCount, 0, 'unchanged count');

    const conflictingTotals = outletCheck.judge({
      dom, txt: { ...txt, reportedTotal: 21 },
      prev: { metrics: { dealCount: 10, dealKeys: increased.metrics.dealKeys } },
    });
    eq(conflictingTotals.status, 'PARTIAL_EVIDENCE', 'conflicting totals');
    eq(conflictingTotals.metrics.newCount, 0, 'conflicting totals cannot prove growth');

    const firstRun = outletCheck.judge({ dom, txt, prev: null });
    eq(firstRun.status, 'PARTIAL_EVIDENCE', 'first incomplete run');
    eq(firstRun.metrics.newCount, 0, 'first run is not new');
    eq(firstRun.baselineEligible, false, 'first incomplete baseline');
  });

  check('VOC：文本路径发现 Poor 时必须异常', () => {
    const v = vocCheck.judge({
      dom: { landed: true, rows: [], poorCount: 0 },
      txt: { landed: true, asinCount: 1, poorCount: 1 },
    });
    eq(v.status, 'DETAIL_ERROR', 'status');
    eq(v.ok, false, 'ok');
    eq(v.metrics.businessStatus, 'ANOMALY', 'businessStatus');
    eq(v.metrics.collectionStatus, 'ERROR', 'collectionStatus');
  });

  check('VOC：只有文本 ASIN、DOM 无明细行时不得判登记完成', () => {
    const v = vocCheck.judge({
      dom: { landed: true, rows: [], poorCount: 0 },
      txt: { landed: true, asinCount: 2, asins: ['B0TEST0001', 'B0TEST0002'], poorCount: 0 },
    });
    eq(v.status, 'DETAIL_ERROR', 'status');
    eq(v.ok, false, 'ok');
  });

  check('VOC：已完整登记的同一 Poor 状态只首次提醒，恶化后重新提醒', () => {
    const asin = 'B012345678';
    const store = { key: 'S-VOC-EVENT', market: 'US' };
    const evidence = (cxHealth) => ({
      dom: {
        landed: true,
        rows: [{ asin, cxHealth }],
        details: [{
          asin,
          dom: { landed: true, asinBound: true, detailRootMatched: true, asin, cxHealth, records: [] },
          txt: { landed: true, asinBound: true, asin, cxHealth, records: [] },
        }],
        poorAsins: [asin], poorCount: 1,
        headerMappedRowCount: 1, headerMappingCompleteRowCount: 1,
      },
      txt: { landed: true, asins: [asin], asinCount: 1, poorAsins: [asin], poorCount: 1, cxByAsin: { [asin]: cxHealth } },
    });
    const first = vocCheck.judge({ ...evidence('Poor'), store, prev: null });
    eq(first.status, 'POOR_CX', 'first status');
    eq(first.severity, 'CRITICAL', 'first severity');
    eq(first.metrics.newBusinessEventCount, 1, 'first new event');

    const repeated = vocCheck.judge({ ...evidence('Poor'), store, prev: { metrics: first.metrics } });
    eq(repeated.status, 'RECORDED_BUSINESS_EVENT', 'repeated status');
    eq(repeated.severity, 'OK', 'repeated severity');
    eq(repeated.metrics.businessStatus, 'RECORDED', 'recorded state');

    const worsened = vocCheck.judge({ ...evidence('Very Poor'), store, prev: { metrics: first.metrics } });
    eq(worsened.status, 'POOR_CX', 'worsened status');
    eq(worsened.metrics.newBusinessEventCount, 1, 'worsened new event');

    const legacyRepeated = vocCheck.judge({
      ...evidence('Poor'), store,
      prev: {
        status: 'POOR_CX',
        metrics: { poorAsins: [asin], poorCount: 1, collectionStatus: 'COMPLETE' },
      },
    });
    eq(legacyRepeated.status, 'RECORDED_BUSINESS_EVENT', 'legacy Poor baseline migrates without duplicate alert');
    const legacyWorsened = vocCheck.judge({
      ...evidence('Very Poor'), store,
      prev: {
        status: 'POOR_CX',
        metrics: { poorAsins: [asin], poorCount: 1, collectionStatus: 'COMPLETE' },
      },
    });
    eq(legacyWorsened.status, 'POOR_CX', 'legacy migration must not hide Very Poor worsening');
  });

  check('广告：关闭时只查 Enabled 全集，开启时查 Enabled 与 Paused 两个全集', () => {
    eq(advertisingSweepPlan('ads-off').join(','), 'ENABLED', 'off sweep');
    eq(advertisingSweepPlan('ads-on').join(','), 'ENABLED,PAUSED', 'on sweep');
    eq(advertisingSweepPlan('adhoc').length, 0, 'adhoc sweep');
    ok(adsCheck.paths[0].startsWith('https://advertising.amazon.com/'), '广告控制台应作为首选入口');
    ok(adsCheck.settleMs <= 5000, '广告初始等待应交给可靠 ready 轮询而非固定长等待');
  });

  check('广告：未配置或未复核名称特征时拒绝回退到全账户范围', () => {
    const table = {
      dom: { landed: true, enabled: 1, paused: 0, activeTotal: 1, paginationComplete: true, stateSource: 'cell-text' },
      txt: { landed: true, enabledWords: 1, pausedWords: 0, totalHint: 1, structured: true, pageComplete: true },
    };
    const missing = adsCheck.judge({ ...table, store: { key: 'ADS-NO-SCOPE' }, config: { _currentSlot: 'ads-off' } });
    const unverified = adsCheck.judge({
      ...table,
      dom: { ...table.dom, nameFilter: { keyword: '2.26', verified: false } },
      store: { key: 'ADS-UNVERIFIED', adsNameContains: '2.26' },
      config: { _currentSlot: 'ads-off' },
    });
    eq(missing.status, 'PARTIAL_EVIDENCE', 'missing keyword status');
    eq(unverified.status, 'PARTIAL_EVIDENCE', 'unverified filter status');
    eq(missing.metrics.nameFilterVerified, false, 'must refuse full-account fallback');
  });

  check('广告：新版语义筛选器和 Shadow DOM 活动行可独立提取', () => {
    const row = e('kat-table-row', { role: 'row' }, {},
      e('span', {}, {}, 'Campaign Shadow A'),
      e('span', { role: 'switch', 'aria-checked': 'true', 'aria-label': 'Enabled' }, {}, ''),
    );
    const table = e('kat-campaign-table', {}, {});
    table.shadowRoot = e('div', {}, {}, row);
    const env = F.envFor(e('body', {}, {},
      e('h1', {}, {}, '广告活动'),
      e('button', { role: 'button' }, {}, 'Status: Enabled'),
      e('div', {}, {}, 'Campaign name Country Status Total: 1'),
      table,
    ));
    env.location.hostname = 'advertising.amazon.com';
    env.location.href = 'https://advertising.amazon.com/campaign-manager/all-campaigns';
    const dom = new Function('window', 'document', 'location', 'NodeFilter', adsCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    eq(dom.filterVerified, true, 'semantic filter verified');
    eq(dom.filterKind, 'ENABLED', 'semantic filter kind');
    eq(dom.enabled, 1, 'shadow campaign enabled count');
    eq(dom.stateSource, 'aria-checked', 'shadow row state source');
    eq(dom.paginationComplete, true, 'single filtered result complete');
  });

  check('广告：表格上方的全账户 Total 不得覆盖精筛结果', () => {
    const env = F.envFor(e('body', {}, {},
      e('h1', {}, {}, 'Advertising campaigns'),
      e('div', {}, {}, 'Account analytics Total: 999'),
      e('button', { role: 'button' }, {}, 'Status: Paused'),
      e('div', {}, {}, 'Campaign name Country Status Total: 0 No data available'),
    ));
    env.location.hostname = 'advertising.amazon.com';
    env.location.href = 'https://advertising.amazon.com/campaign-manager/all-campaigns';
    const dom = new Function('window', 'document', 'location', 'NodeFilter', adsCheck.extractor)(
      env.window, env.document, env.location, NodeFilter,
    );
    eq(dom.filterKind, 'PAUSED', 'paused filter kind');
    eq(dom.reportedTotal, 0, 'only campaign-table total may be used');
    eq(dom.paused, 0, 'account analytics total must not become paused campaigns');
    eq(dom.stateSource, 'empty-paused-filter', 'filtered empty proof');
    eq(dom.paginationComplete, true, 'filtered empty result is complete');
  });

  check('广告：相同状态文本的九个 AG Grid 活动按 row-id 合并固定列，忽略行选择框', () => {
    const render = (count, mirror) => {
      const pinned = [], center = [];
      for (let i = 0; i < count; i++) {
        pinned.push(e('div', { role: 'row', 'row-id': `campaign-${i}` }, {},
          e('div', { 'col-id': 'ag-Grid-SelectionColumn' }, {},
            e('input', { type: 'checkbox', 'aria-checked': 'false' }, {})),
          e('div', { 'col-id': 'name' }, {}, `Campaign ${i}`),
          ...(mirror ? [e('div', { 'col-id': 'state' }, {},
            e('span', { role: 'switch', 'aria-checked': 'true' }, {}))] : [])));
        center.push(e('div', { role: 'row', 'row-id': `campaign-${i}` }, {},
          e('div', { 'col-id': 'country' }, {}, 'USA'),
          e('div', { 'col-id': 'status' }, {}, 'Enabled'),
          e('div', { 'col-id': 'startDate' }, {}, '2026-08-31')));
      }
      const env = F.envFor(e('body', {}, {},
        e('h1', {}, {}, 'Advertising campaigns'),
        e('button', { role: 'button' }, {}, 'Status: Enabled'),
        e('div', {}, {}, 'Campaign name Country Status'),
        e('div', {}, {}, pinned), e('div', {}, {}, center),
        e('div', {}, {}, 'Total: 9')));
      env.location.hostname = 'advertising.amazon.com';
      env.location.href = 'https://advertising.amazon.com/campaign-manager/all-campaigns';
      return new Function('window', 'document', 'location', 'NodeFilter', adsCheck.extractor)(
        env.window, env.document, env.location, NodeFilter,
      );
    };
    for (const mirror of [false, true]) {
      const dom = render(9, mirror);
      eq(dom.enabled, 9, 'nine distinct identities despite identical center text');
      eq(dom.paused, 0, 'unchecked selection boxes are not paused campaigns');
      eq(dom.totalRows, 9, 'pinned and center copies count once');
      eq(dom.paginationComplete, true, 'DOM rows corroborate footer');
      eq(dom.campaigns[8].name, 'Campaign 8', 'name is joined from the pinned row');
    }
    const incomplete = render(8, false);
    eq(incomplete.enabled, 8, 'footer does not invent an unread ninth DOM row');
    eq(incomplete.paginationComplete, false, 'incomplete DOM remains incomplete');
  });

  check('广告：应关闭时任一路发现 Enabled 都必须报警', () => {
    const v = judgeAds({
      dom: { landed: true, enabled: 0, paused: 4, activeTotal: 4, stateSource: 'aria-checked', campaigns: [] },
      txt: { landed: true, enabledWords: 1, pausedWords: 4, totalHint: 5, structured: true },
      config: { _currentSlot: 'ads-off' },
    });
    eq(v.status, 'SHOULD_BE_OFF', 'status');
    eq(v.ok, false, 'ok');
  });

  check('广告：结构化活动表忽略筛选器与推荐卡状态词', () => {
    const txt = adsCheck.parseText(
      'Campaigns paused recommendation Active status: Enabled Active Campaign name Country Status Type A Delivering X B Delivering X Total: 2',
      null,
      { url: 'https://advertising.amazon.com/campaign-manager/all-campaigns' },
    );
    const v = judgeAds({
      dom: { landed: true, enabled: 0, paused: 1, campaigns: [] },
      txt,
      config: { _currentSlot: 'ads-off' },
    });
    eq(txt.structured, true, 'structured');
    eq(v.metrics.enabled, 2, 'enabled');
    eq(v.metrics.total, 2, 'total');
  });

  check('广告：中文新控制台活动表可识别进行中活动', () => {
    const txt = adsCheck.parseText(
      '广告活动 筛选条件 进行中 广告活动名称 国家 / 地区 状态 类型 A活动 美国 进行中 商品推广 总计: 3296',
      null,
      { url: 'https://advertising.amazon.com/campaign-manager/all-campaigns' },
    );
    ok(txt.landed && txt.structured && txt.enabledWords > 0 && txt.totalHint === 3296, '中文活动表结构化解析');
    eq(txt.enabledWords, 1, '表头前的进行中筛选不得计为活动');
    const v = judgeAds({ dom: null, txt, config: { _currentSlot: 'ads-off' } });
    eq(v.status, 'SHOULD_BE_OFF', 'off-slot status');
    eq(v.severity, 'CRITICAL', 'off-slot severity');
  });

  check('广告：真机中文表头不得制造假开启或 enabled 大于 total', () => {
    const parse = (states, total) => adsCheck.parseText(
      `广告活动 筛选条件 进行中 广告活动名称 国家 / 地区 状态 类型 ${states
        .map((state, index) => `活动${index + 1} 美国 ${state} 商品推广`).join(' ')} 总计: ${total}`,
      null,
      { url: 'https://advertising.amazon.com/campaign-manager/all-campaigns' },
    );

    const xcai = parse(['已暂停', '已暂停', '已暂停'], 3335);
    eq(xcai.enabledWords, 0, 'XCAI 全暂停可见行不得因表头误报开启');
    const xcaiVerdict = judgeAds({ dom: null, txt: xcai, config: { _currentSlot: 'ads-off' } });
    eq(xcaiVerdict.status, 'PARTIAL_EVIDENCE', 'XCAI 未遍历 3335 条时必须保守失败');
    eq(xcaiVerdict.severity, 'ERROR', 'XCAI 应为采集不完整而非假业务红灯');

    for (const count of [8, 13]) {
      const txt = parse(Array.from({ length: count }, () => '进行中'), count);
      const verdict = judgeAds({ dom: null, txt, config: { _currentSlot: 'ads-off' } });
      eq(txt.enabledWords, count, `${count} 条开启活动的文本计数`);
      eq(verdict.metrics.enabled, count, `${count} 条开启活动的聚合计数`);
      eq(verdict.metrics.total, count, `${count} 条开启活动的聚合总数`);
      eq(verdict.status, 'SHOULD_BE_OFF', `${count} 条真实开启仍必须报警`);
      eq(verdict.severity, 'CRITICAL', `${count} 条真实开启为业务异常`);
    }
  });

  check('广告：源内计数冲突时聚合比例有效且保留原始异常证据', () => {
    const v = judgeAds({
      dom: { landed: true, enabled: 0, paused: 1, activeTotal: 1, stateSource: 'pagetext-count' },
      txt: {
        landed: true, enabledWords: 9, pausedWords: 0, totalHint: 8,
        structured: true, pageComplete: true,
      },
      config: { _currentSlot: 'ads-off' },
    });
    eq(v.status, 'SHOULD_BE_OFF', 'status');
    eq(v.severity, 'CRITICAL', 'severity');
    eq(v.confidence, 'low', 'confidence');
    ok(v.metrics.enabled <= v.metrics.total, '聚合开启数不得大于聚合总数');
    eq(v.metrics.enabled, 9, '可靠路径观测到的异常数');
    eq(v.metrics.total, 9, '冲突时的有效总数下界');
    eq(v.metrics.textEnabled, 9, '文本原始开启数');
    eq(v.metrics.textTotal, 8, '文本原始报告总数');
    eq(v.metrics.textCountConflict, true, '文本源内冲突');
    eq(v.metrics.aggregateTotalAdjusted, true, '聚合总数调整标记');
    ok(v.reasons.some((reason) => /精确数量需复核/.test(reason)), '需说明精确数量低置信');
  });

  check('广告：已启用筛选为空时，关闭时段正常、开启时段异常', () => {
    const txt = adsCheck.parseText(
      '广告活动 筛选条件 进行中: 已启用 广告活动名称 国家 / 地区 状态 总计: 0 无可用数据',
      null,
      { url: 'https://advertising.amazon.com/campaign-manager/all-campaigns' },
    );
    const dom = {
      landed: true, enabled: 0, paused: 0, activeTotal: 0,
      stateSource: 'empty-enabled-filter', emptyEnabledFilter: true, paginationComplete: true, campaigns: [],
    };
    ok(txt.landed && txt.structured && txt.emptyTable && txt.totalHint === 0, '空活动表结构化解析');
    const off = judgeAds({ dom, txt, config: { _currentSlot: 'ads-off' } });
    eq(off.status, 'ALL_OFF', 'off-slot status');
    eq(off.ok, true, 'off-slot ok');
    const on = judgeAds({ dom, txt, config: { _currentSlot: 'ads-on' } });
    eq(on.status, 'SHOULD_BE_ON', 'on-slot status');
    eq(on.ok, false, 'on-slot ok');
    const domOnlyOn = judgeAds({ dom, txt: null, config: { _currentSlot: 'ads-on' } });
    eq(domOnlyOn.status, 'SHOULD_BE_ON', 'DOM-only empty enabled filter is already a reliable anomaly');
  });

  check('广告：开启时段用双筛选证明存在 Enabled 且 Paused 为 0', () => {
    const noFooterPausedEmpty = adsCheck.parseText(
      '广告活动 筛选条件 进行中: 已暂停 广告活动名称 国家 / 地区 状态 类型 无可用数据 请尝试调整筛选条件以查看效果数据',
      null,
      { url: 'https://advertising.amazon.com/campaign-manager/all-campaigns' },
    );
    eq(noFooterPausedEmpty.structured, true, 'new console empty table without total footer is structured');
    eq(noFooterPausedEmpty.emptyTable, true, 'new console empty marker');
    eq(noFooterPausedEmpty.totalHint, 0, 'new console empty total');
    eq(noFooterPausedEmpty.pageComplete, true, 'new console empty paused filter is complete');
    const enabledDom = {
      landed: true, filterKind: 'ENABLED', enabledFilter: true,
      enabled: 14, paused: 0, activeTotal: 14, reportedTotal: 105,
      stateSource: 'filter-total', filterVerified: true, paginationComplete: false, campaigns: [],
    };
    const enabledTxt = {
      landed: true, filterKind: 'ENABLED', enabledFilter: true,
      enabledWords: 14, pausedWords: 0, totalHint: 105,
      structured: true, pageComplete: false,
    };
    const pausedDom = {
      landed: true, filterKind: 'PAUSED', pausedFilter: true,
      enabled: 0, paused: 0, activeTotal: 0, reportedTotal: 0,
      stateSource: 'empty-paused-filter', emptyPausedFilter: true,
      paginationComplete: true, campaigns: [],
    };
    const pausedTxt = {
      landed: true, filterKind: 'PAUSED', pausedFilter: true,
      enabledWords: 0, pausedWords: 0, totalHint: 0,
      structured: true, emptyTable: true, pageComplete: true,
    };
    const dom = { ...pausedDom, stateViews: { enabled: enabledDom, paused: pausedDom } };
    const txt = { ...pausedTxt, stateViews: { enabled: enabledTxt, paused: pausedTxt } };
    const v = judgeAds({ dom, txt, config: { _currentSlot: 'ads-on' } });
    eq(v.status, 'ALL_ON', 'status');
    eq(v.ok, true, 'ok');
    eq(v.severity, 'OK', 'severity');
    eq(v.metrics.enabled, 105, 'enabled total');
    eq(v.metrics.paused, 0, 'paused total');
    eq(v.metrics.paginationComplete, true, 'semantic sweep complete');
    eq(readyAds({ dom: enabledDom, txt: enabledTxt, config: { _currentSlot: 'ads-on' } }), true,
      'enabled existence does not require walking every enabled page');
    eq(readyAds({ dom: pausedDom, txt: pausedTxt, config: { _currentSlot: 'ads-on' } }), true,
      'paused zero view is complete');
  });

  check('广告：双筛选任一路发现 Paused 都是业务异常', () => {
    const enabledDom = {
      landed: true, filterKind: 'ENABLED', enabledFilter: true,
      enabled: 8, paused: 0, reportedTotal: 8, stateSource: 'aria-label', campaigns: [],
    };
    const enabledTxt = {
      landed: true, filterKind: 'ENABLED', enabledFilter: true,
      enabledWords: 8, pausedWords: 0, totalHint: 8, structured: true,
    };
    const pausedDom = {
      landed: true, filterKind: 'PAUSED', pausedFilter: true,
      enabled: 0, paused: 1, reportedTotal: 1, stateSource: 'aria-label', campaigns: [],
    };
    const pausedTxt = {
      landed: true, filterKind: 'PAUSED', pausedFilter: true,
      enabledWords: 0, pausedWords: 1, totalHint: 1, structured: true,
    };
    const v = judgeAds({
      dom: { ...pausedDom, stateViews: { enabled: enabledDom, paused: pausedDom } },
      txt: { ...pausedTxt, stateViews: { enabled: enabledTxt, paused: pausedTxt } },
      config: { _currentSlot: 'ads-on' },
    });
    eq(v.status, 'SHOULD_BE_ON', 'status');
    eq(v.severity, 'CRITICAL', 'severity');
    ok(v.reasons.some((reason) => /已暂停/.test(reason)), 'paused reason');
  });

  check('广告：Paused 只有单路零证据仍必须 PARTIAL', () => {
    const enabledDom = {
      landed: true, filterKind: 'ENABLED', enabledFilter: true,
      enabled: 8, paused: 0, reportedTotal: 8, stateSource: 'aria-label', campaigns: [],
    };
    const enabledTxt = {
      landed: true, filterKind: 'ENABLED', enabledFilter: true,
      enabledWords: 8, pausedWords: 0, totalHint: 8, structured: true,
    };
    const pausedDom = {
      landed: true, filterKind: 'PAUSED', pausedFilter: true,
      enabled: 0, paused: 0, reportedTotal: 0, stateSource: 'empty-paused-filter',
      emptyPausedFilter: true, paginationComplete: true, campaigns: [],
    };
    const v = judgeAds({
      dom: { ...pausedDom, stateViews: { enabled: enabledDom, paused: pausedDom } },
      txt: { stateViews: { enabled: enabledTxt, paused: null } },
      config: { _currentSlot: 'ads-on' },
    });
    eq(v.status, 'PARTIAL_EVIDENCE', 'status');
    eq(v.severity, 'ERROR', 'severity');
    eq(v.ok, false, 'ok');
  });

  check('广告：普通完整空活动表在关闭时段正常、开启时段必须报警', () => {
    const dom = {
      landed: true, enabled: 0, paused: 0, activeTotal: 0, reportedTotal: 0,
      paginationComplete: true, campaigns: [],
    };
    const txt = {
      landed: true, enabledWords: 0, pausedWords: 0, totalHint: 0,
      structured: true, emptyTable: true, enabledFilter: false, pageComplete: true,
    };
    const off = judgeAds({ dom, txt, config: { _currentSlot: 'ads-off' } });
    eq(off.status, 'ALL_OFF', 'off status');
    eq(off.ok, true, 'off ok');
    const on = judgeAds({ dom, txt, config: { _currentSlot: 'ads-on' } });
    eq(on.status, 'SHOULD_BE_ON', 'on status');
    eq(on.severity, 'CRITICAL', 'on severity');
    ok(on.metrics.zeroEnabledSources.length === 2, '双路均明确 enabled=0');
  });

  check('广告：ads-on 任一可靠来源 enabled=0 必须保留业务异常', () => {
    const v = judgeAds({
      dom: {
        landed: true, enabled: 0, paused: 0, activeTotal: 0, reportedTotal: 0,
        paginationComplete: true, campaigns: [],
      },
      txt: {
        landed: true, enabledWords: 5, pausedWords: 0, totalHint: 5,
        structured: true, pageComplete: true,
      },
      config: { _currentSlot: 'ads-on' },
    });
    eq(v.status, 'SHOULD_BE_ON', 'status');
    eq(v.severity, 'CRITICAL', 'severity');
    eq(v.metrics.countConflict, true, 'countConflict');
    eq(v.baselineEligible, false, 'conflicting anomaly baseline');
  });

  check('广告：adhoc 仅双路完整一致时 INFO，分页不完整或计数冲突必须 PARTIAL', () => {
    const dom = {
      landed: true, enabled: 2, paused: 1, activeTotal: 3, reportedTotal: 3,
      stateSource: 'cell-text', paginationComplete: true, campaigns: [],
    };
    const txt = {
      landed: true, enabledWords: 2, pausedWords: 1, totalHint: 3,
      structured: true, pageComplete: true,
    };
    const complete = judgeAds({ dom, txt, config: { _currentSlot: 'adhoc' } });
    eq(complete.status, 'INFO', 'complete status');
    eq(complete.ok, true, 'complete ok');
    eq(readyAds({ dom, txt }), true, 'complete ready');

    const paged = judgeAds({
      dom: { ...dom, paginationComplete: false },
      txt: { ...txt, pageComplete: false, hasNextPage: true },
      config: { _currentSlot: 'adhoc' },
    });
    eq(paged.status, 'PARTIAL_EVIDENCE', 'paged status');
    eq(paged.severity, 'ERROR', 'paged severity');
    eq(paged.baselineEligible, false, 'paged baseline');
    eq(readyAds({ dom: { ...dom, paginationComplete: false }, txt: { ...txt, pageComplete: false } }), false, 'paged ready');

    const conflict = judgeAds({
      dom,
      txt: { ...txt, enabledWords: 1, pausedWords: 2 },
      config: { _currentSlot: 'adhoc' },
    });
    eq(conflict.status, 'PARTIAL_EVIDENCE', 'conflict status');
    eq(conflict.metrics.countConflict, true, 'conflict metric');
    eq(conflict.baselineEligible, false, 'conflict baseline');
  });

  check('ASIN：图片式 404 必须由页面标题和独立图片文字双路确认', () => {
    const wording = "Sorry! We couldn't find that page. Try searching or go to Amazon's home page.";
    const evaluate = ({ title = 'Page Not Found', image = true, hidden = false, product = false } = {}) => {
      const body = e('body', {}, {},
        ...(image ? [e('img', { alt: wording }, { display: hidden ? 'none' : 'block' })] : []),
        ...(product ? [e('span', { id: 'productTitle' }, {}, 'Actual product')] : []),
      );
      const env = F.envFor(body, 'https://www.amazon.com/dp/B0H4ZGYZM3');
      env.document.title = title;
      env.document.getElementById = (id) => body.querySelectorAll('*').find(el => el.getAttribute('id') === id) || null;
      env.document.querySelectorAll = (selector) => selector === 'img[alt]' ? body.querySelectorAll(selector) : [];
      env.document.querySelector = () => null;
      const read = (script) => new Function('window', 'document', 'location', 'NodeFilter', script)(env.window, env.document, env.location, NodeFilter);
      const dom = read(ASIN_DETAIL_EXTRACTOR), accessible = read(ASIN_IMAGE_ERROR_TEXT_EXTRACTOR);
      const txt = asinDetailDef.parseText(accessible.text);
      return { dom, accessible, verdict: asinDetailDef.judgeAsin({ asin: 'B0H4ZGYZM3', dom, txt, prev: null }) };
    };
    const found = evaluate();
    eq(found.dom.dogPage, true, 'DOM title recognizes the actual error page');
    eq(found.accessible.text, wording, 'text route reads literal visible image wording');
    eq(found.verdict.status, 'INACTIVE_LISTING', 'two routes confirm unavailable page');
    eq(found.verdict.baselineEligible, false, '404 must not become a rating baseline');
    for (const options of [{ image: false }, { hidden: true }]) {
      const result = evaluate(options);
      eq(result.accessible.text, '', 'absent/hidden images provide no text proof');
      eq(result.verdict.severity, 'ERROR', 'title alone cannot exclude a listing');
    }
    for (const options of [{ title: 'Amazon.com: Actual product' }, { product: true }]) {
      const result = evaluate(options);
      eq(result.dom.dogPage, false, 'unrelated image/title cannot identify a product as missing');
      eq(result.accessible.text, '', 'normal product page does not use error-image fallback');
      ok(result.verdict.status !== 'INACTIVE_LISTING', 'do not exclude normal products');
    }
    ok(!/[^\x00-\x7f]|`|\$\{/.test(ASIN_IMAGE_ERROR_TEXT_EXTRACTOR), 'injected image-text script remains ASCII ES5 transport compatible');
  });

  check('ASIN：购物车双路冲突按无购物车处理，评分取更低值', () => {
    const v = asinDetailDef.judgeAsin({
      asin: 'B0TEST0001',
      dom: { landed: true, hasCart: true, rating: 4.5 },
      txt: { landed: true, hasCartText: false, rating: 4.2 },
      prev: { rating: 4.4 },
    });
    eq(v.status, 'NO_CART', 'status');
    eq(v.ok, false, 'ok');
    eq(v.metrics.rating, 4.2, 'rating');
    eq(v.metrics.ratingConflict, true, 'ratingConflict');
    eq(v.baselineEligible, false, 'conflicting rating baseline');
    ok(v.reasons.some((reason) => /评分冲突/.test(reason)), '必须显示评分冲突');
  });

  check('ASIN：评分双路冲突不得 OK，且真实无货异常不得被冲突掩盖', () => {
    const conflict = asinDetailDef.judgeAsin({
      asin: 'B0TEST0001',
      dom: { landed: true, hasCart: true, rating: 4.5 },
      txt: { landed: true, hasCartText: true, rating: 4.2 },
      prev: { rating: 4.2 },
    });
    eq(conflict.status, 'PARTIAL_EVIDENCE', 'conflict status');
    eq(conflict.severity, 'ERROR', 'conflict severity');
    eq(conflict.metrics.collectionStatus, 'PARTIAL_EVIDENCE', 'collectionStatus');
    eq(conflict.baselineEligible, false, 'baselineEligible');

    const unavailable = asinDetailDef.judgeAsin({
      asin: 'B0TEST0001',
      dom: { landed: true, unavailable: true, hasCart: false, rating: 4.5 },
      txt: { landed: true, unavailable: true, hasCartText: false, rating: 4.2 },
      prev: { rating: 4.2 },
    });
    eq(unavailable.status, 'INACTIVE_LISTING', 'inactive status');
    eq(unavailable.severity, 'OK', 'inactive listings are excluded');
    eq(unavailable.metrics.ratingConflict, true, 'conflict retained');
    eq(unavailable.baselineEligible, false, 'business conflict baseline');
  });

  check('ASIN：相关推荐缺货文字不得覆盖主商品可购买状态', () => {
    const parsed = asinDetailDef.parseText(
      'Main product Add to Cart 4.8 out of 5 stars 21 ratings Recommended item Currently unavailable',
    );
    eq(parsed.hasCartText, true, 'text cart');
    eq(parsed.pageUnavailable, true, 'raw page unavailable signal');
    eq(parsed.unavailable, false, 'unscoped unavailable must be ignored');

    const makeEl = (text) => ({
      textContent: text, innerText: text, value: '', children: [],
      getClientRects: () => [{ width: 100, height: 20 }],
    });
    const title = makeEl('Main product');
    const cart = makeEl('Add to Cart');
    const elements = { productTitle: title, 'add-to-cart-button': cart };
    const document = {
      title: 'Amazon.com: Main product',
      body: makeEl('Main product Add to Cart 4.8 out of 5 stars 21 ratings Recommended item Currently unavailable'),
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createTreeWalker: () => ({ nextNode: () => null }),
    };
    const window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
    const dom = new Function('window', 'document', 'location', 'NodeFilter', ASIN_DETAIL_EXTRACTOR)(
      window, document, { href: 'https://www.amazon.com/dp/B0TEST0001' }, NodeFilter,
    );
    eq(dom.hasCart, true, 'DOM cart');
    eq(dom.unavailable, false, 'DOM unscoped unavailable must be ignored');
    eq(dom.buyable, true, 'DOM buyable');

    const verdict = asinDetailDef.judgeAsin({ asin: 'B0TEST0001', dom, txt: parsed, prev: null });
    eq(verdict.status, 'OK', 'status');
    eq(verdict.metrics.collectionStatus, 'COMPLETE', 'collection status');
  });

  check('ASIN：主购买区 DOM 定位与页面文本缺货相互印证时排除非激活商品', () => {
    const verdict = asinDetailDef.judgeAsin({
      asin: 'B0TEST0001',
      dom: { landed: true, unavailable: true, availabilityScoped: true, hasCart: true, rating: 4.6 },
      txt: asinDetailDef.parseText('Currently unavailable Add to Cart 4.6 out of 5 stars 11 ratings'),
      prev: null,
    });
    eq(verdict.status, 'INACTIVE_LISTING', 'status');
    eq(verdict.severity, 'OK', 'severity');
    eq(verdict.metrics.scopedUnavailableCorroborated, true, 'scoped corroboration');

    const oneRouteOnly = asinDetailDef.judgeAsin({
      asin: 'B0TEST0001',
      dom: { landed: true, unavailable: true, availabilityScoped: true, hasCart: true, rating: 4.6 },
      txt: asinDetailDef.parseText('Add to Cart 4.6 out of 5 stars 11 ratings'),
      prev: null,
    });
    eq(oneRouteOnly.status, 'PARTIAL_EVIDENCE', 'one-route status');
    eq(oneRouteOnly.severity, 'ERROR', 'one-route severity');
  });

  check('ASIN：评分冲突不能掩盖较低可靠评分相对前日下降', () => {
    const v = asinDetailDef.judgeAsin({
      asin: 'B0TEST0001',
      dom: { landed: true, hasCart: true, rating: 4.5 },
      txt: { landed: true, hasCartText: true, rating: 4.2 },
      prev: { rating: 4.4 },
    });
    eq(v.status, 'RATING_DROP', 'business status');
    eq(v.severity, 'ERROR', 'collection conflict severity');
    eq(v.confidence, 'conflict', 'confidence');
    eq(v.metrics.ratingDelta, -0.2, 'rating delta');
    eq(v.metrics.businessStatus, 'ANOMALY', 'business metric');
    eq(v.metrics.collectionStatus, 'PARTIAL_EVIDENCE', 'collection status');
    eq(v.baselineEligible, false, 'conflicting rating baseline');
  });

  await checkAsync('ASIN 报告保留 judge 的证据冲突置信度', async () => {
    const root = path.join(tmp, 'asin-confidence-conflict');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({
      asins: [{ asin: 'B012345678', storeKey: 'S-ASIN-CONFLICT' }],
    }));
    const cfg = deepMerge(DEFAULTS, {
      ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
      asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
      storeHealth: { screenshot: false },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    cfg._root = root;
    cfg.outDir = outDir;
    const canonicalUrl = 'https://www.amazon.com/dp/B012345678?th=1#product';
    let currentUrlCalls = 0;
    const zn = {
      async storeOpen() { return { storeId: 'asin-confidence-conflict' }; },
      async visit(_storeId, url) { return { url }; },
      async currentUrl() {
        currentUrlCalls++;
        return currentUrlCalls === 1 ? 'https://www.amazon.com/dp/B012345678' : canonicalUrl;
      },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        return { result: { asin: 'B012345678', landed: true, hasCart: true, rating: 4.5, unavailable: false } };
      },
      async content() { return { text: 'Product details Add to Cart 4.2 out of 5 stars' }; },
      async storeClose() {},
    };
    const summary = await runAsinHealth({
      zn, config: cfg,
      stores: [{ key: 'S-ASIN-CONFLICT', id: 'S-ASIN-CONFLICT', name: 'S-ASIN-CONFLICT', market: 'US' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(summary.results[0].status, 'PARTIAL_EVIDENCE', 'status');
    eq(summary.results[0].confidence, 'conflict', 'report confidence');
    eq(summary.results[0].metrics.collectionStatus, 'PARTIAL_EVIDENCE', 'collection status');
    eq(summary.results[0].baselineEligible, false, 'baseline');
    ok(summary.results[0].notes.some((note) => /规范化跳转/.test(note)), 'safe same-ASIN canonical redirect');
  });

  await checkAsync('ASIN 跨域 iframe 只隔离主文档读取，异常截图继续 fail-closed', async () => {
    const root = path.join(tmp, 'asin-isolated-frame-read');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({
      asins: [{ asin: 'B012345678', storeKey: 'S-ASIN-FRAME' }],
    }));
    const cfg = deepMerge(DEFAULTS, {
      ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
      asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
      storeHealth: { screenshot: true },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    cfg._root = root;
    cfg.outDir = outDir;
    const pageUrl = 'https://www.amazon.com/dp/B012345678?variant=PRIVATE#details';
    const isolatedFrameProbe = {
      probeVersion: 2, looksLikeLogin: false, looksBlocked: false,
      liveDocument: true, traversalComplete: false,
      accessibleTraversalComplete: true, mainDocumentTraversalComplete: true,
      discoveredRootCount: 1, scannedRootCount: 1,
      discoveredElementCount: 9000, scannedElementCount: 9000,
      candidateNodeCount: 350, visibleFrameCount: 3, unreadableVisibleFrameCount: 3,
      traversalErrorCount: 3, nonFrameTraversalErrorCount: 0, unreadableFrameErrorCount: 3,
      opaqueOverlayFrameCount: 0, opaqueAuthHintCount: 0, opaqueBlockedHintCount: 0,
      rootBudget: 512, elementBudget: 50000, nodeBudget: 5000, unreadableFrameBudget: 8,
      rootBudgetExceeded: false, elementBudgetExceeded: false, nodeBudgetExceeded: false,
      unreadableFrameBudgetExceeded: false,
    };
    let screenshotCalls = 0;
    const zn = {
      securityCapabilities: { officialZiniaoWebDriverHttp: true, mainDocumentTextOnly: true },
      async storeOpen() { return { storeId: 'asin-isolated-frame' }; },
      async visit() { return { url: pageUrl }; },
      async currentUrl() { return pageUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return { result: isolatedFrameProbe };
        return { result: {
          asin: 'B012345678', landed: true, pageNotFound: false, unavailable: false,
          hasCart: false, rating: 4.5, reviewCount: 20,
        } };
      },
      async content() { return { text: 'Product details 4.5 out of 5 stars 20 ratings' }; },
      async screenshot() { screenshotCalls++; throw new Error('screenshot must stay blocked'); },
      async storeClose() {},
    };
    const summary = await runAsinHealth({
      zn, config: cfg,
      stores: [{ key: 'S-ASIN-FRAME', id: 'S-ASIN-FRAME', name: 'S-ASIN-FRAME', market: 'US' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    const result = summary.results[0];
    eq(result.status, 'NO_CART', 'active listing without cart remains actionable');
    eq(result.verdictSource, 'dom+text', 'dual evidence');
    eq(result.screenshot, null, 'screenshot');
    eq(screenshotCalls, 0, 'screenshot calls');
    eq(result.evidence.dom.landed, true, 'DOM retained');
    eq(result.evidence.text.landed, true, 'text retained');
    eq(result.evidence.safety.isolatedUnreadableFrames, true, 'frame isolation evidence');
    eq(result.evidence.capture.suppressed, true, 'capture suppression');
    eq(result.evidence.capture.code, 'UNREADABLE_VISIBLE_FRAME', 'capture suppression code');
  });

  await checkAsync('第 2～9 项通用检查只有单路证据时不得输出正常', async () => {
    const onePathZn = {
      async storeOpen() { return { storeId: 'partial-1' }; },
      async visit() { return {}; },
      async currentUrl() { return 'https://sellercentral.amazon.com/target'; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: { probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true } };
        }
        throw new Error('mock DOM unavailable');
      },
      async content() { return { text: 'target page clear' }; },
      async screenshot() { return { path: null }; },
      async storeClose() { return {}; },
    };
    const def = {
      id: 'partial-test', no: 99, title: 'partial', requirement: 'dual path',
      paths: ['/target'], extractor: 'return {landed:true};',
      parseText: () => ({ landed: true, clear: true }),
      judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }),
    };
    const s = await runGenericCheck({
      zn: onePathZn,
      config,
      stores: [{ key: 'S1', id: 'S1', host: 'sellercentral.amazon.com' }],
      logger: quiet,
      def,
      opts: { slot: 'selftest' },
    });
    eq(s.results[0].status, 'PARTIAL_EVIDENCE', 'status');
    eq(s.results[0].ok, false, 'ok');
    eq(s.results[0].severity, 'ERROR', 'severity');
    eq(s.results[0].baselineEligible, false, 'baselineEligible');
  });

  await checkAsync('ERROR/UNKNOWN/LOGIN_REQUIRED/PARTIAL 不覆盖上一份有效状态', async () => {
    const outDir = path.join(tmp, 'baseline-preserve');
    const cfg = deepMerge(config, {
      outDir, paths: { outDir }, storeHealth: { screenshot: true, saveRawPageText: true },
    });
    cfg.outDir = outDir;
    let pageMode = 'clear';
    let screenshots = 0;
    const zn = {
      async storeOpen() { return { storeId: 'state-1' }; },
      async visit() { return {}; },
      async currentUrl() {
        if (pageMode === 'login') return 'https://www.amazon.com/ap/signin';
        if (pageMode === 'blocked') return 'https://www.amazon.com/errors/robot-check';
        return 'https://sellercentral.amazon.com/target';
      },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: { probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true } };
        }
        if (pageMode === 'login') return { result: { landed: false, looksLikeLogin: true } };
        if (pageMode === 'blocked') return { result: { landed: false, looksBlocked: true } };
        return { result: { landed: true, clear: true } };
      },
      async content() {
        if (pageMode === 'login') return { text: 'Amazon Sign-In Email or mobile phone number' };
        if (pageMode === 'blocked') return { text: 'Robot Check Enter the characters you see' };
        return { text: 'target clear https://example.test/path?token=SECRET' };
      },
      async screenshot(_storeId, file) { screenshots++; return { path: file }; },
      async storeClose() {},
    };
    const def = {
      id: 'baseline-test', no: 99, title: 'baseline', requirement: 'preserve', paths: ['/target'],
      extractor: 'return {landed:true};',
      parseText: (text) => pageMode === 'login' ? { landed: false, looksLikeLogin: true }
        : pageMode === 'blocked' ? { landed: false, looksBlocked: true }
          : { landed: true, clear: /clear/.test(text) },
      judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: { count: 7 } }),
    };
    const storesForTest = [{ key: 'S1', id: 'S1', host: 'sellercentral.amazon.com' }];
    const first = await runGenericCheck({ zn, config: cfg, stores: storesForTest, logger: quiet, def, opts: { slot: 'good' } });
    ok(!fs.readFileSync(first.results[0].rawTextFile, 'utf8').includes('SECRET'), 'raw page text must redact URL queries');
    const file = path.join(outDir, 'state', 'baseline-test.json');
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    eq(good.stores.S1.status, 'CLEAR', 'valid baseline');
    pageMode = 'login';
    const failed = await runGenericCheck({ zn, config: cfg, stores: storesForTest, logger: quiet, def, opts: { slot: 'login' } });
    eq(failed.results[0].status, 'LOGIN_REQUIRED', 'failed status');
    eq(screenshots, 1, 'login/MFA page must not be screenshotted');
    eq(failed.results[0].rawTextFile, null, 'login/MFA raw text must not persist');
    pageMode = 'blocked';
    const blocked = await runGenericCheck({ zn, config: cfg, stores: storesForTest, logger: quiet, def, opts: { slot: 'blocked' } });
    eq(blocked.results[0].status, 'BLOCKED', 'blocked status');
    eq(screenshots, 1, 'blocked page must not be screenshotted');
    eq(blocked.results[0].rawTextFile, null, 'blocked page raw text must not persist');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    eq(after.stores.S1.status, 'CLEAR', 'baseline remains valid');
    eq(after.stores.S1.metrics.count, 7, 'baseline metrics remain valid');
  });

  await checkAsync('截图 TOCTOU：同 URL 认证覆盖层会删图并抑制三类采集证据', async () => {
    const marker = 'SCREENSHOT_TOCTOU_SECRET_MARKER';
    const liveProbe = (auth) => ({
      result: { probeVersion: 1, looksLikeLogin: auth, looksBlocked: false, liveDocument: true, traversalComplete: true },
    });

    const genericOut = path.join(tmp, 'generic-screenshot-toctou');
    const genericCfg = deepMerge(config, {
      outDir: genericOut, paths: { outDir: genericOut },
      storeHealth: { screenshot: true, saveRawPageText: true },
    });
    let genericOverlay = false;
    let genericShot = null;
    const genericZn = {
      async storeOpen() { return { storeId: 'generic-toctou' }; },
      async visit() { return { url: 'https://sellercentral.amazon.com/target' }; },
      async currentUrl() { return 'https://sellercentral.amazon.com/target'; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return liveProbe(genericOverlay);
        return { result: { landed: true, clear: true, marker } };
      },
      async content() { return { text: `target clear ${marker}` }; },
      async screenshot(_storeId, file) {
        genericShot = file;
        fs.writeFileSync(file, marker);
        genericOverlay = true;
        return { path: file };
      },
      async storeClose() {},
    };
    const generic = await runGenericCheck({
      zn: genericZn, config: genericCfg,
      stores: [{ key: 'S-TOCTOU', id: 'S-TOCTOU', host: 'sellercentral.amazon.com' }],
      logger: quiet,
      def: {
        id: 'generic-toctou', no: 99, title: 'generic toctou', requirement: 'safe capture',
        paths: ['/target'], extractor: 'return {landed:true};', settleMs: 0,
        parseText: () => ({ landed: true, clear: true, marker }),
        judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }),
      },
      opts: { slot: 'selftest' },
    });
    eq(generic.results[0].status, 'LOGIN_REQUIRED', 'generic status');
    eq(generic.results[0].screenshot, null, 'generic screenshot');
    eq(generic.results[0].rawTextFile, null, 'generic raw text');
    ok(genericShot && !fs.existsSync(genericShot), 'generic sensitive screenshot must be deleted');
    ok(!JSON.stringify(generic.results[0].evidence).includes(marker), 'generic DOM/text evidence must be suppressed');

    const storeOut = path.join(tmp, 'store-screenshot-toctou');
    const storeCfg = deepMerge(config, {
      outDir: storeOut, paths: { outDir: storeOut },
      storeHealth: { screenshot: true, saveRawPageText: true },
    });
    let storeOverlay = false;
    let storeShot = null;
    const storeZn = {
      async storeOpen() { return { storeId: 'store-toctou' }; },
      async visit() { return { url: 'https://sellercentral.amazon.com/performance/dashboard' }; },
      async currentUrl() { return 'https://sellercentral.amazon.com/performance/dashboard'; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return liveProbe(storeOverlay);
        return { result: {
          landed: true, hasPolicyComplianceText: true, status: 'HEALTHY', statusRaw: 'Healthy',
          cardFound: true, cardText: `Policy Compliance Healthy ${marker}`,
        } };
      },
      async content() { return { text: `Policy Compliance Healthy ${marker}` }; },
      async screenshot(_storeId, file) {
        storeShot = file;
        fs.writeFileSync(file, marker);
        storeOverlay = true;
        return { path: file };
      },
      async storeClose() {},
    };
    const storeHealth = await runStoreHealth({
      zn: storeZn, config: storeCfg,
      stores: [{ key: 'S-TOCTOU', id: 'S-TOCTOU', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(storeHealth.results[0].status, 'LOGIN_REQUIRED', 'store health status');
    eq(storeHealth.results[0].screenshot, null, 'store health screenshot');
    eq(storeHealth.results[0].rawTextFile, null, 'store health raw text');
    ok(storeShot && !fs.existsSync(storeShot), 'store health sensitive screenshot must be deleted');
    ok(!JSON.stringify(storeHealth.results[0].evidence).includes(marker), 'store health evidence must be suppressed');

    const asinRoot = path.join(tmp, 'asin-screenshot-toctou');
    const asinOut = path.join(asinRoot, 'out');
    fs.mkdirSync(path.join(asinRoot, 'config'), { recursive: true });
    fs.writeFileSync(path.join(asinRoot, 'config', 'asins.json'), JSON.stringify({
      asins: [{ asin: 'B012345678', storeKey: 'S-TOCTOU' }],
    }));
    const asinCfg = deepMerge(DEFAULTS, {
      ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
      asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
      storeHealth: { screenshot: true },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    asinCfg._root = asinRoot;
    asinCfg.outDir = asinOut;
    let asinOverlay = false;
    let asinShot = null;
    const asinZn = {
      async storeOpen() { return { storeId: 'asin-toctou' }; },
      async visit(_storeId, url) { return { url }; },
      async currentUrl() { return 'https://www.amazon.com/dp/B012345678'; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return liveProbe(asinOverlay);
        return { result: {
          asin: 'B012345678', landed: true, hasCart: false, unavailable: false, rating: 4.5, titleText: marker,
        } };
      },
      async content() { return { text: `Product details 4.5 out of 5 stars ${marker}` }; },
      async screenshot(_storeId, file) {
        asinShot = file;
        fs.writeFileSync(file, marker);
        asinOverlay = true;
        return { path: file };
      },
      async storeClose() {},
    };
    const asin = await runAsinHealth({
      zn: asinZn, config: asinCfg,
      stores: [{ key: 'S-TOCTOU', id: 'S-TOCTOU', name: 'S-TOCTOU', market: 'US' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(asin.results[0].status, 'LOGIN_REQUIRED', 'ASIN status');
    eq(asin.results[0].screenshot, null, 'ASIN screenshot');
    ok(asinShot && !fs.existsSync(asinShot), 'ASIN sensitive screenshot must be deleted');
    ok(!JSON.stringify(asin.results[0].evidence).includes(marker), 'ASIN evidence must be suppressed');
    eq(asin.results[0].baselineEligible, false, 'ASIN baseline eligibility');
  });

  await checkAsync('截图前 live gate：同 URL Shadow Passkey 出现时三条主链均 0 次 screenshot', async () => {
    const safeProbe = (auth) => ({ result: {
      probeVersion: 1, looksLikeLogin: auth, looksBlocked: false,
      liveDocument: true, traversalComplete: true,
    } });

    const genericOut = path.join(tmp, 'generic-pre-screenshot-auth');
    const genericCfg = deepMerge(config, {
      outDir: genericOut, paths: { outDir: genericOut },
      storeHealth: { screenshot: true, saveRawPageText: true },
    });
    genericCfg.outDir = genericOut;
    let genericProbes = 0;
    let genericShots = 0;
    const genericMarker = 'GENERIC_PRE_SCREENSHOT_SECRET';
    const genericZn = {
      async storeOpen() { return { storeId: 'generic-pre-shot' }; },
      async visit() { return { url: 'https://sellercentral.amazon.com/target' }; },
      async currentUrl() { return 'https://sellercentral.amazon.com/target'; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return safeProbe(++genericProbes === 3);
        return { result: { landed: true, clear: true, marker: genericMarker } };
      },
      async content() { return { text: `target clear ${genericMarker}` }; },
      async screenshot() { genericShots++; return { path: null }; },
      async storeClose() {},
    };
    const generic = await runGenericCheck({
      zn: genericZn, config: genericCfg,
      stores: [{ key: 'S-GENERIC-PRESHOT', id: 'S-GENERIC-PRESHOT', host: 'sellercentral.amazon.com' }],
      logger: quiet,
      def: {
        id: 'generic-pre-shot', no: 99, title: 'generic pre-shot', requirement: 'safe screenshot',
        paths: ['/target'], settleMs: 0, extractor: 'return {landed:true};',
        parseText: () => ({ landed: true }),
        judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }),
      },
      opts: { slot: 'selftest' },
    });
    eq(genericShots, 0, 'generic screenshot calls');
    eq(generic.results[0].status, 'LOGIN_REQUIRED', 'generic status');
    ok(!JSON.stringify(generic.results[0].evidence).includes(genericMarker), 'generic evidence suppressed');

    const storeOut = path.join(tmp, 'store-pre-screenshot-auth');
    const storeCfg = deepMerge(config, {
      outDir: storeOut, paths: { outDir: storeOut },
      storeHealth: { screenshot: true, saveRawPageText: true, paths: ['/performance/dashboard'] },
    });
    storeCfg.outDir = storeOut;
    let storeProbes = 0;
    let storeShots = 0;
    const storeMarker = 'STORE_PRE_SCREENSHOT_SECRET';
    const storeZn = {
      async storeOpen() { return { storeId: 'store-pre-shot' }; },
      async visit() { return { url: 'https://sellercentral.amazon.com/performance/dashboard' }; },
      async currentUrl() { return 'https://sellercentral.amazon.com/performance/dashboard'; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return safeProbe(++storeProbes === 3);
        return { result: {
          landed: true, hasPolicyComplianceText: true, status: 'HEALTHY', statusRaw: 'Healthy',
          cardFound: true, cardText: `Policy Compliance Healthy ${storeMarker}`,
        } };
      },
      async content() { return { text: `Policy Compliance Healthy ${storeMarker}` }; },
      async screenshot() { storeShots++; return { path: null }; },
      async storeClose() {},
    };
    const store = await runStoreHealth({
      zn: storeZn, config: storeCfg,
      stores: [{ key: 'S-STORE-PRESHOT', id: 'S-STORE-PRESHOT', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(storeShots, 0, 'store-health screenshot calls');
    eq(store.results[0].status, 'LOGIN_REQUIRED', 'store-health status');
    ok(!JSON.stringify(store.results[0].evidence).includes(storeMarker), 'store-health evidence suppressed');

    const asinRoot = path.join(tmp, 'asin-pre-screenshot-auth');
    const asinOut = path.join(asinRoot, 'out');
    fs.mkdirSync(path.join(asinRoot, 'config'), { recursive: true });
    fs.writeFileSync(path.join(asinRoot, 'config', 'asins.json'), JSON.stringify({
      asins: [{ asin: 'B012345678', storeKey: 'S-ASIN-PRESHOT' }],
    }));
    const asinCfg = deepMerge(DEFAULTS, {
      ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
      asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
      storeHealth: { screenshot: true },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    asinCfg._root = asinRoot;
    asinCfg.outDir = asinOut;
    let asinProbes = 0;
    let asinShots = 0;
    const asinMarker = 'ASIN_PRE_SCREENSHOT_SECRET';
    const asinZn = {
      async storeOpen() { return { storeId: 'asin-pre-shot' }; },
      async visit(_storeId, url) { return { url }; },
      async currentUrl() { return 'https://www.amazon.com/dp/B012345678'; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return safeProbe(++asinProbes === 3);
        return { result: {
          asin: 'B012345678', landed: true, hasCart: false, unavailable: false, rating: 4.5, titleText: asinMarker,
        } };
      },
      async content() { return { text: `Product details 4.5 out of 5 stars ${asinMarker}` }; },
      async screenshot() { asinShots++; return { path: null }; },
      async storeClose() {},
    };
    const asin = await runAsinHealth({
      zn: asinZn, config: asinCfg,
      stores: [{ key: 'S-ASIN-PRESHOT', id: 'S-ASIN-PRESHOT', name: 'S-ASIN-PRESHOT', market: 'US' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(asinShots, 0, 'ASIN screenshot calls');
    eq(asin.results[0].status, 'LOGIN_REQUIRED', 'ASIN status');
    ok(!JSON.stringify(asin.results[0].evidence).includes(asinMarker), 'ASIN evidence suppressed');
  });

  await checkAsync('关闭截图时 generic live gate 仍阻断同 URL KAT Passkey 覆盖层', async () => {
    const outDir = path.join(tmp, 'generic-no-screenshot-passkey');
    const cfg = deepMerge(config, {
      outDir, paths: { outDir }, storeHealth: { screenshot: false, saveRawPageText: false },
    });
    cfg.outDir = outDir;
    let businessReads = 0;
    let screenshots = 0;
    const listUrl = 'https://sellercentral.amazon.com/voice-of-the-customer';
    const zn = {
      async storeOpen() { return { storeId: 'voc-passkey-overlay' }; },
      async visit() { return { url: listUrl }; },
      async currentUrl() { return listUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: { probeVersion: 1, looksLikeLogin: true, looksBlocked: false, liveDocument: true, traversalComplete: true } };
        }
        businessReads++;
        return { result: { landed: true, rows: [], zeroResults: true, poorCount: 0 } };
      },
      async content() { businessReads++; return { text: 'Voice of the Customer 0 results' }; },
      async screenshot() { screenshots++; return { path: null }; },
      async storeClose() {},
    };
    const summary = await runGenericCheck({
      zn, config: cfg,
      stores: [{ key: 'S-PASSKEY', id: 'S-PASSKEY', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet, def: { ...vocCheck, settleMs: 0, readyTimeoutMs: 0 }, opts: { slot: 'selftest' },
    });
    eq(summary.results[0].status, 'LOGIN_REQUIRED', 'same-URL Passkey overlay status');
    eq(summary.results[0].ok, false, 'same-URL Passkey overlay must not pass');
    eq(businessReads, 0, 'unsafe live gate must block DOM/content reads');
    eq(screenshots, 0, 'screenshot=false must remain disabled');
    eq(summary.results[0].rawTextFile, null, 'sensitive overlay must not persist raw text');
  });

  await checkAsync('业务入口发现前后 live gate 阻断同 URL Shadow Passkey，禁止读取或点击入口', async () => {
    const runScenario = async (mode) => {
      const outDir = path.join(tmp, `link-discovery-${mode}`);
      const cfg = deepMerge(config, {
        outDir, paths: { outDir }, ziniao: { retries: 0 },
        storeHealth: { screenshot: false, saveRawPageText: false },
      });
      cfg.outDir = outDir;
      const pageUrl = 'https://sellercentral.amazon.com/home?ref=nav#top';
      const linkScript = 'return {href:"https://advertising.amazon.com/cm/campaigns"};';
      let probeCalls = 0;
      let linkReads = 0;
      let pageReads = 0;
      let followCalls = 0;
      const zn = {
        async storeOpen() { return { storeId: `link-${mode}` }; },
        async visit() { return { url: pageUrl }; },
        async currentUrl() { return pageUrl; },
        async execExtract(_storeId, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
            probeCalls++;
            const auth = mode === 'pre' || (mode === 'post' && probeCalls >= 2);
            return { result: {
              probeVersion: 1, looksLikeLogin: auth, looksBlocked: false,
              liveDocument: true, traversalComplete: true,
            } };
          }
          if (script === linkScript) {
            linkReads++;
            return { result: { href: 'https://advertising.amazon.com/cm/campaigns' } };
          }
          pageReads++;
          return { result: { landed: true, clear: true } };
        },
        async content() { pageReads++; return { text: 'target clear' }; },
        async followNavigationLink() { followCalls++; return 'https://advertising.amazon.com/cm/campaigns'; },
        async storeClose() {},
      };
      const def = {
        id: `link-gate-${mode}`, no: 99, title: 'link gate', requirement: 'safe discovery',
        paths: ['/target'], linkExtractor: linkScript,
        navigationLink: { labels: ['Campaign Manager'] }, settleMs: 0,
        extractor: 'return {landed:true};', parseText: () => ({ landed: true }),
        judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }),
      };
      const summary = await runGenericCheck({
        zn, config: cfg,
        stores: [{ key: `S-LINK-${mode}`, id: `S-LINK-${mode}`, host: 'sellercentral.amazon.com' }],
        logger: quiet, def, opts: { slot: 'selftest' },
      });
      return { summary, linkReads, pageReads, followCalls };
    };

    const pre = await runScenario('pre');
    eq(pre.linkReads, 0, 'pre-gate must block link extractor');
    eq(pre.pageReads, 0, 'pre-gate must block page DOM/content');
    eq(pre.followCalls, 0, 'pre-gate must block native navigation click');
    eq(pre.summary.results[0].status, 'LOGIN_REQUIRED', 'pre-gate status');

    const post = await runScenario('post');
    eq(post.linkReads, 1, 'post scenario first reads the safe link once');
    eq(post.pageReads, 0, 'post-gate must block later business evidence reads');
    eq(post.followCalls, 0, 'post-gate must block native navigation click');
    eq(post.summary.results[0].status, 'LOGIN_REQUIRED', 'post-gate status');
  });

  await checkAsync('VOC 每行详情激活前 live gate 阻断同 URL Shadow OTP，激活次数为 0', async () => {
    const outDir = path.join(tmp, 'voc-detail-preactivation-gate');
    const cfg = deepMerge(config, {
      outDir, paths: { outDir }, ziniao: { retries: 0 },
      storeHealth: { screenshot: false, saveRawPageText: false },
    });
    cfg.outDir = outDir;
    const listUrl = 'https://sellercentral.amazon.com/voice-of-the-customer';
    let safetyProbes = 0;
    let activationCalls = 0;
    let detailBusinessReads = 0;
    const zn = {
      async storeOpen() { return { storeId: 'voc-preactivate-auth' }; },
      async visit() { return { url: listUrl }; },
      async currentUrl() { return listUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          safetyProbes++;
          return { result: {
            probeVersion: 1, looksLikeLogin: safetyProbes === 3, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        if (String(script).includes('voc-detail/v1')) detailBusinessReads++;
        return { result: {
          landed: true, poorCount: 0, zeroResults: false,
          headerMappedRowCount: 1, headerMappingCompleteRowCount: 1,
          rows: [{ asin: 'B012345678', cxHealth: 'Good', detailUrl: null }],
        } };
      },
      async content() { return { text: 'Voice of the Customer B012345678 CX Health Good' }; },
      async activateVocReadOnlyDetail() { activationCalls++; return { activated: true, transition: 'dialog' }; },
      async releaseVocReadOnlyDetail() {},
      async storeClose() {},
    };
    const summary = await runGenericCheck({
      zn, config: cfg,
      stores: [{ key: 'S-VOC-PREAUTH', id: 'S-VOC-PREAUTH', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet, def: { ...vocCheck, settleMs: 0, readyTimeoutMs: 0 }, opts: { slot: 'selftest' },
    });
    eq(activationCalls, 0, 'unsafe list gate must block detail activation');
    eq(detailBusinessReads, 0, 'unsafe list gate must block detail extractor');
    eq(summary.results[0].status, 'DETAIL_ERROR', 'detail gate failure status');
    eq(summary.results[0].severity, 'ERROR', 'detail gate failure severity');
  });

  await checkAsync('generic live gate 用完整内存 URL 阻断 Outlet query-only 页面切换', async () => {
    const outDir = path.join(tmp, 'generic-query-toctou');
    const cfg = deepMerge(config, {
      outDir, paths: { outDir },
      ziniao: { retries: 0 },
      storeHealth: { screenshot: false, saveRawPageText: false },
    });
    cfg.outDir = outDir;
    const outletUrl = 'https://sellercentral.amazon.com/inventoryplanning/manageinventoryhealth?RECOMMENDATION=OUTLET_DEAL';
    const restockUrl = 'https://sellercentral.amazon.com/inventoryplanning/manageinventoryhealth?RECOMMENDATION=RESTOCK';
    let current = outletUrl;
    let businessReads = 0;
    const zn = {
      async storeOpen() { return { storeId: 'outlet-query-toctou' }; },
      async visit() { current = outletUrl; return { url: outletUrl }; },
      async currentUrl() { return current; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        businessReads++;
        return { result: { landed: true, clear: true } };
      },
      async content() {
        businessReads++;
        current = restockUrl;
        return { text: 'Manage Inventory Health clear' };
      },
      async storeClose() {},
    };
    const def = {
      id: 'outlet-query-toctou', no: 6, title: 'Outlet query identity', requirement: 'strict page identity',
      paths: [outletUrl], settleMs: 0, readyTimeoutMs: 0,
      extractor: 'return {landed:true,clear:true};',
      parseText: () => ({ landed: true, clear: true }),
      judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }),
    };
    const summary = await runGenericCheck({
      zn, config: cfg,
      stores: [{ key: 'S-QUERY', id: 'S-QUERY', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet, def, opts: { slot: 'selftest' },
    });
    eq(businessReads, 2, 'business evidence reads before query transition detection');
    eq(summary.results[0].status, 'ERROR', 'query-only transition status');
    eq(summary.results[0].ok, false, 'query-only transition must not pass');
    ok(!JSON.stringify(summary.results[0]).includes('RECOMMENDATION='), 'raw query identity must not persist');
  });

  await checkAsync('Store Health 在导航后 MFA URL 上不读取或保存任何页面证据', async () => {
    const outDir = path.join(tmp, 'store-health-mfa');
    const cfg = deepMerge(config, {
      outDir, paths: { outDir }, storeHealth: { screenshot: true, saveRawPageText: true },
    });
    cfg.outDir = outDir;
    let reads = 0;
    let screenshots = 0;
    const zn = {
      async storeOpen() { return { storeId: 'INTERNAL-MFA-ID' }; },
      async visit() { return { url: 'https://www.amazon.com/ap/mfa?openid=SECRET' }; },
      async currentUrl() { return 'https://www.amazon.com/ap/mfa?openid=SECRET'; },
      async execExtract() { reads++; return { result: { hasPolicyComplianceText: true, status: 'HEALTHY' } }; },
      async content() { reads++; return { text: '政策合规性 良好 验证码 123456' }; },
      async screenshot() { screenshots++; return { path: null }; },
      async storeClose() {},
    };
    const s = await runStoreHealth({
      zn, config: cfg,
      stores: [{ key: 'MFA', id: 'INTERNAL-MFA-ID', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(s.results[0].status, 'LOGIN_REQUIRED', 'status');
    eq(reads, 0, '认证 URL 必须在 DOM/文本读取前阻断');
    eq(screenshots, 0, '认证 URL 不得截图');
    eq(s.results[0].rawTextFile, null, '认证 URL 不得保存原始文本');
    ok(!Object.prototype.hasOwnProperty.call(s.results[0], 'storeId'), '报告不得包含紫鸟店铺标识字段');
  });

  await checkAsync('Store Health screenshot=false 时在同 URL Shadow Passkey/OTP 前 0 次业务读取', async () => {
    const outDir = path.join(tmp, 'store-health-live-preauth');
    const cfg = deepMerge(config, {
      outDir, paths: { outDir }, ziniao: { retries: 0 },
      storeHealth: {
        screenshot: false, saveRawPageText: false,
        paths: ['/performance/dashboard'],
      },
    });
    cfg.outDir = outDir;
    const pageUrl = 'https://sellercentral.amazon.com/performance/dashboard?ref=health#policy';
    let businessReads = 0;
    const zn = {
      async storeOpen() { return { storeId: 'store-shadow-passkey' }; },
      async visit() { return { url: pageUrl }; },
      async currentUrl() { return pageUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: true, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        businessReads++;
        return { result: { hasPolicyComplianceText: true, status: 'HEALTHY' } };
      },
      async content() { businessReads++; return { text: 'Policy Compliance Healthy OTP 123456' }; },
      async storeClose() {},
    };
    const summary = await runStoreHealth({
      zn, config: cfg,
      stores: [{ key: 'S-STORE-PASSKEY', id: 'S-STORE-PASSKEY', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(businessReads, 0, 'live auth gate must precede DOM/content');
    eq(summary.results[0].status, 'LOGIN_REQUIRED', 'status');
    eq(summary.results[0].rawTextFile, null, 'raw text');
    ok(!JSON.stringify(summary.results[0].evidence).includes('123456'), 'OTP must never enter evidence');
  });

  await checkAsync('Store Health 用完整内存 URL 阻断 evidence read 中 query/fragment 变化', async () => {
    const variants = [
      ['query', 'https://sellercentral.amazon.com/performance/dashboard?tab=policy#one',
        'https://sellercentral.amazon.com/performance/dashboard?tab=other#one'],
      ['fragment', 'https://sellercentral.amazon.com/performance/dashboard?tab=policy#one',
        'https://sellercentral.amazon.com/performance/dashboard?tab=policy#two'],
    ];
    for (const [kind, initialUrl, changedUrl] of variants) {
      const outDir = path.join(tmp, `store-health-${kind}-identity`);
      const cfg = deepMerge(config, {
        outDir, paths: { outDir }, ziniao: { retries: 0 },
        storeHealth: { screenshot: false, saveRawPageText: false, paths: ['/performance/dashboard'] },
      });
      cfg.outDir = outDir;
      let current = initialUrl;
      const marker = `STORE_${kind.toUpperCase()}_SENSITIVE`;
      const zn = {
        async storeOpen() { return { storeId: `store-${kind}-identity` }; },
        async visit() { current = initialUrl; return { url: initialUrl }; },
        async currentUrl() { return current; },
        async execExtract(_storeId, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
            return { result: {
              probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
              liveDocument: true, traversalComplete: true,
            } };
          }
          return { result: {
            landed: true, hasPolicyComplianceText: true, status: 'HEALTHY',
            statusRaw: 'Healthy', cardFound: true, cardText: `Policy Compliance Healthy ${marker}`,
          } };
        },
        async content() { current = changedUrl; return { text: `Policy Compliance Healthy ${marker}` }; },
        async storeClose() {},
      };
      const summary = await runStoreHealth({
        zn, config: cfg,
        stores: [{ key: `S-STORE-${kind}`, id: `S-STORE-${kind}`, market: 'US', host: 'sellercentral.amazon.com' }],
        logger: quiet, opts: { slot: 'selftest' },
      });
      eq(summary.results[0].status, 'ERROR', `${kind} transition status`);
      eq(summary.results[0].ok, false, `${kind} transition ok`);
      ok(!JSON.stringify(summary.results[0].evidence).includes(marker), `${kind} evidence must be suppressed`);
      ok(!JSON.stringify(summary.results[0]).includes('tab='), `${kind} raw URL query must not persist`);
    }
  });

  const runStoreHealthCodexInvariantCase = async ({ key, dom, text, failPostLiveProbe = false }) => {
    const outDir = path.join(tmp, `store-health-codex-${key.toLowerCase()}`);
    const cfg = deepMerge(config, {
      outDir,
      paths: { outDir },
      ziniao: { retries: 0 },
      storeHealth: {
        screenshot: false, saveRawPageText: false, paths: ['/performance/dashboard'],
      },
      codex: { enabled: true },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    cfg.outDir = outDir;
    const pageUrl = 'https://sellercentral.amazon.com/performance/dashboard?tab=policy#card';
    let liveProbeCalls = 0;
    let codexCalls = 0;
    const zn = {
      async storeOpen() { return { storeId: `codex-${key}` }; },
      async visit() { return { url: pageUrl }; },
      async currentUrl() { return pageUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          liveProbeCalls++;
          if (failPostLiveProbe && liveProbeCalls >= 2) return { result: null };
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        return { result: { ...dom }, via: 'selftest' };
      },
      async content() { return { text }; },
      async storeClose() {},
    };
    const summary = await runStoreHealth({
      zn,
      config: cfg,
      stores: [{ key, id: key, market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet,
      opts: { slot: 'selftest' },
      codexClassifier: async () => {
        codexCalls++;
        return {
          ok: true, status: 'HEALTHY', confidence: 'high', score: 999,
          evidence: 'synthetic self-test response', reasoning: 'synthetic self-test response',
        };
      },
    });
    return { result: summary.results[0], liveProbeCalls, codexCalls };
  };

  await checkAsync('Store Health live probe 失败不能被 Codex HEALTHY 改成假绿', async () => {
    const marker = 'LIVE_PROBE_EVIDENCE_MUST_BE_SUPPRESSED';
    const { result, liveProbeCalls, codexCalls } = await runStoreHealthCodexInvariantCase({
      key: 'CODEX-LIVE-FAIL',
      failPostLiveProbe: true,
      dom: {
        landed: true, hasPolicyComplianceText: true, status: 'HEALTHY',
        statusRaw: 'Healthy', statusSource: 'status-label', cardFound: true,
        cardText: `Policy Compliance Healthy ${marker}`,
      },
      text: `Policy Compliance Healthy Account Health Rating 256 ${marker}`,
    });
    ok(liveProbeCalls >= 2, 'must fail the post-evidence live probe');
    eq(codexCalls, 0, 'unsafe evidence must not be sent to Codex');
    eq(result.status, 'ERROR', 'status');
    eq(result.ok, false, 'ok');
    eq(result.severity, 'ERROR', 'severity');
    ok(!JSON.stringify(result.evidence).includes(marker), 'unsafe DOM/text evidence must be suppressed');
  });

  await checkAsync('Store Health 单路 Healthy + Codex HEALTHY 仍是 PARTIAL_EVIDENCE', async () => {
    const { result, codexCalls } = await runStoreHealthCodexInvariantCase({
      key: 'CODEX-ONE-PATH',
      dom: {
        landed: true, hasPolicyComplianceText: true, status: 'HEALTHY',
        statusRaw: 'Healthy', statusSource: 'pagetext-window', cardFound: true,
        cardText: 'Policy Compliance Healthy',
      },
      text: 'Policy Compliance Account Health Rating',
    });
    eq(codexCalls, 1, 'eligible low-confidence business evidence should exercise Codex arbitration');
    eq(result.status, 'PARTIAL_EVIDENCE', 'status');
    eq(result.ok, false, 'ok');
    eq(result.severity, 'ERROR', 'severity');
  });

  await checkAsync('Store Health DOM+文本双路 Healthy 保持正常', async () => {
    const { result, codexCalls } = await runStoreHealthCodexInvariantCase({
      key: 'CODEX-DUAL-HEALTHY',
      dom: {
        landed: true, hasPolicyComplianceText: true, status: 'HEALTHY',
        statusRaw: 'Healthy', statusSource: 'status-label', cardFound: true,
        cardText: 'Policy Compliance Healthy Account Health Rating 256', score: 256,
      },
      text: F.TEXT_HEALTHY,
    });
    eq(codexCalls, 0, '双路一致无需 Codex 仲裁');
    eq(result.status, 'HEALTHY', 'status');
    eq(result.ok, true, 'ok');
    eq(result.severity, 'OK', 'severity');
  });

  await checkAsync('ASIN screenshot=false 时在同 URL Shadow Passkey/OTP 前 0 次业务读取', async () => {
    const root = path.join(tmp, 'asin-live-preauth');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({
      asins: [{ asin: 'B012345678', storeKey: 'S-ASIN-PASSKEY' }],
    }));
    const cfg = deepMerge(DEFAULTS, {
      ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
      asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
      storeHealth: { screenshot: false },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    cfg._root = root;
    cfg.outDir = outDir;
    const pageUrl = 'https://www.amazon.com/dp/B012345678?th=1#product';
    let businessReads = 0;
    const zn = {
      async storeOpen() { return { storeId: 'asin-shadow-passkey' }; },
      async visit() { return { url: pageUrl }; },
      async currentUrl() { return pageUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: true, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        businessReads++;
        return { result: { landed: true, hasCart: true, rating: 5 } };
      },
      async content() { businessReads++; return { text: 'Use a passkey OTP NEVER_READ_OTP_MARKER' }; },
      async storeClose() {},
    };
    const summary = await runAsinHealth({
      zn, config: cfg,
      stores: [{ key: 'S-ASIN-PASSKEY', id: 'S-ASIN-PASSKEY', name: 'S-ASIN-PASSKEY', market: 'US' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(businessReads, 0, 'live auth gate must precede ASIN DOM/content');
    eq(summary.results[0].status, 'LOGIN_REQUIRED', 'status');
    eq(summary.results[0].baselineEligible, false, 'baseline eligibility');
    ok(!JSON.stringify(summary.results[0].evidence).includes('NEVER_READ_OTP_MARKER'), 'OTP must never enter evidence');
  });

  await checkAsync('ASIN 用完整内存 URL 阻断 evidence read 中 query/fragment 变化', async () => {
    const variants = [
      ['query', 'https://www.amazon.com/dp/B012345678?th=1#product',
        'https://www.amazon.com/dp/B012345678?th=2#product'],
      ['fragment', 'https://www.amazon.com/dp/B012345678?th=1#product',
        'https://www.amazon.com/dp/B012345678?th=1#reviews'],
    ];
    for (const [kind, initialUrl, changedUrl] of variants) {
      const root = path.join(tmp, `asin-${kind}-identity`);
      const outDir = path.join(root, 'out');
      fs.mkdirSync(path.join(root, 'config'), { recursive: true });
      fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({
        asins: [{ asin: 'B012345678', storeKey: `S-ASIN-${kind}` }],
      }));
      const cfg = deepMerge(DEFAULTS, {
        ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
        asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
        storeHealth: { screenshot: false },
        alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
        crm: { enabled: false },
      });
      cfg._root = root;
      cfg.outDir = outDir;
      let current = initialUrl;
      const marker = `ASIN_${kind.toUpperCase()}_SENSITIVE`;
      const zn = {
        async storeOpen() { return { storeId: `asin-${kind}-identity` }; },
        async visit() { current = initialUrl; return { url: initialUrl }; },
        async currentUrl() { return current; },
        async execExtract(_storeId, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
            return { result: {
              probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
              liveDocument: true, traversalComplete: true,
            } };
          }
          return { result: {
            landed: true, hasCart: true, unavailable: false, rating: 4.5, titleText: marker,
          } };
        },
        async content() {
          current = changedUrl;
          return { text: `Product Add to Cart 4.5 out of 5 stars ${marker}` };
        },
        async storeClose() {},
      };
      const summary = await runAsinHealth({
        zn, config: cfg,
        stores: [{ key: `S-ASIN-${kind}`, id: `S-ASIN-${kind}`, name: `S-ASIN-${kind}`, market: 'US' }],
        logger: quiet, opts: { slot: 'selftest' },
      });
      eq(summary.results[0].status, 'ERROR', `${kind} transition status`);
      eq(summary.results[0].ok, false, `${kind} transition ok`);
      eq(summary.results[0].baselineEligible, false, `${kind} baseline eligibility`);
      ok(!JSON.stringify(summary.results[0].evidence).includes(marker), `${kind} evidence must be suppressed`);
      ok(!JSON.stringify(summary.results[0]).includes('th='), `${kind} raw URL query must not persist`);
    }
  });

  await checkAsync('ASIN 同页规范化跳转后重新读取，持续变化和错 ASIN 不得恢复正常', async () => {
    for (const mode of ['once', 'churn', 'wrong-asin']) {
      const root = path.join(tmp, `asin-fresh-identity-${mode}`);
      fs.mkdirSync(path.join(root, 'config'), { recursive: true });
      fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({
        asins: [{ asin: 'B012345678', storeKey: mode }],
      }));
      const cfg = deepMerge(DEFAULTS, {
        ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
        asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
        storeHealth: { screenshot: false, saveRawPageText: false },
        alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
        crm: { enabled: false },
      });
      cfg._root = root; cfg.outDir = path.join(root, 'out');
      const base = 'https://www.amazon.com/dp/B012345678';
      let current = base, reads = 0, opens = 0;
      const zn = {
        async storeOpen() { opens++; return { storeId: mode }; },
        async visit() { current = base; return { url: current }; },
        async currentUrl() { return current; },
        async execExtract(_id, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
          reads++;
          return { result: { asin: 'B012345678', landed: true, hasCart: true,
            rating: 4.5, unavailable: false, titleText: reads === 1 ? 'DISCARDED_PRODUCT' : 'Fresh product' } };
        },
        async content() {
          if (mode === 'churn' || reads === 1) current = mode === 'wrong-asin'
            ? 'https://www.amazon.com/dp/B087654321' : `${base}?th=${reads}`;
          return { text: `Product Add to Cart 4.5 out of 5 stars ${reads === 1 ? 'DISCARDED_PRODUCT' : 'Fresh product'}` };
        },
        async storeClose() {},
      };
      const summary = await runAsinHealth({ zn, config: cfg, stores: [{ key: mode, id: mode, market: 'US' }],
        logger: quiet, opts: { slot: 'selftest' } });
      const result = summary.results[0];
      eq(result.ok, mode === 'once', `${mode} verdict`);
      eq(reads, mode === 'once' ? 2 : mode === 'churn' ? 6 : 1, `${mode} read budget`);
      eq(opens, mode === 'churn' ? 2 : 1, `${mode} browser restart budget`);
      ok(!JSON.stringify(result).includes('DISCARDED_PRODUCT'), 'only fresh product evidence may persist');
      ok(!JSON.stringify(result).includes('?th='), 'query remains in memory only');
      if (mode === 'once') eq(result.verdictSource, 'dom+text', 'fresh success has both paths');
      else eq(result.baselineEligible, false, 'unresolved identity cannot advance baseline');
    }
  });

  check('Feedback / Reviews 低分条目包含稳定键、ASIN、时间和摘要', () => {
    const store = { key: 'S-STRUCT', name: 'Structured Store', market: 'US' };
    const feedback = feedbackCheck.judge({
      store,
      config: { _now: new Date('2026-08-26T03:00:00Z') },
      dom: {
        landed: true, lowCount: 1, total: 1,
        lowRatings: [{
          rating: 2, asin: 'B012345678', date: 'Aug 26, 2026', identifier: '123-1234567-1234567',
          title: 'Slow delivery', summary: 'Buyer feedback summary', source: 'attr:aria-label',
        }],
      },
      txt: feedbackCheck.parseText('Feedback Manager Recent Feedback B012345678 Aug 26, 2026 2 out of 5 Buyer feedback summary'),
    });
    eq(feedback.status, 'TODAY_LOW_RATING', 'feedback status');
    ok(/^feedback:[a-f0-9]{32}$/.test(feedback.items[0].itemKey), 'feedback stable item key');
    eq(feedback.items[0].asin, 'B012345678', 'feedback asin');
    ok(feedback.items[0].summary, 'feedback summary');

    const reviews = reviewsCheck.judge({
      store,
      dom: {
        landed: true, lowCount: 1, total: 1,
        lowReviews: [{ stars: 1, asin: 'B087654321', date: 'Aug 25, 2026', title: 'Broken', summary: 'Arrived broken', source: 'kat-star-rating:value' }],
      },
      txt: reviewsCheck.parseText('Customer Reviews B087654321 Aug 25, 2026 1 out of 5 stars Broken Arrived broken'),
    });
    eq(reviews.status, 'LOW_REVIEW', 'review status');
    ok(/^review:[a-f0-9]{32}$/.test(reviews.items[0].itemKey), 'review stable item key');
    eq(reviews.items[0].asin, 'B087654321', 'review asin');
  });

  await checkAsync('Reviews 等到真实评论内容出现，不读取 SPA 空壳即结束', async () => {
    let polls = 0;
    const zn = {
      async storeOpen() { return { storeId: 'review-wait' }; },
      async visit() { return { url: 'https://sellercentral.amazon.com/brand-customer-reviews' }; },
      async currentUrl() { return 'https://sellercentral.amazon.com/brand-customer-reviews'; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: { probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true } };
        }
        polls++;
        if (polls === 1) return { result: { landed: true, total: 0, lowCount: 0, lowReviews: [], emptyState: false } };
        return { result: { landed: true, total: 1, lowCount: 1, lowReviews: [{ stars: 2, asin: 'B012345678', summary: 'late content' }], emptyState: false } };
      },
      async content() {
        // Page text can expose the rating before the structured review row and
        // ASIN finish rendering. The ready gate must wait for that binding.
        return { text: 'Customer Reviews B012345678 2 out of 5 stars late content' };
      },
      async storeClose() {},
    };
    const s = await runGenericCheck({
      zn, config,
      stores: [{ key: 'S-WAIT', id: 'S-WAIT', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet,
      def: { ...reviewsCheck, id: 'reviews-wait-test', settleMs: 0, readyTimeoutMs: 600, readyPollMs: 1 },
      opts: {
        slot: 'selftest',
        reviewOwnershipByStore: new Map([['S-WAIT', {
          ready: true,
          storeAsins: new Set(['B012345678']),
          ownersByAsin: new Map([['B012345678', new Set(['S-WAIT'])]]),
          inventoryCount: 1,
          source: 'selftest',
        }]]),
      },
    });
    ok(polls >= 2, `应至少轮询 2 次，实际 ${polls}`);
    eq(s.results[0].status, 'LOW_REVIEW', 'status');
  });

  check('Outlet 的真实 DOM 活动不会被页面中的 0 results 清空', () => {
    const v = outletCheck.judge({
      store: { key: 'S1', market: 'US' },
      dom: {
        landed: true, zeroResults: true, createDealCount: 1, textMentionCount: 1,
        skus: [{ asin: 'B012345678', sku: 'SKU-1', actionFound: true, row: 'B012345678 SKU-1 Create outlet deal' }],
      },
      txt: { landed: true, zeroResults: true, mentionCount: 0 },
      prev: { metrics: { dealCount: 0, dealKeys: [] } },
    });
    eq(v.metrics.dealCount, 1, 'deal count');
    eq(v.status, 'NEW_DEAL', 'actual new DOM activity');
    eq(v.metrics.collectionStatus, 'PARTIAL_EVIDENCE', 'conflicting zero text remains partial collection');
    eq(v.baselineEligible, false, 'conflicting new activity must not replace baseline');
    ok(v.items[0].itemKey.startsWith('outlet:'), 'stable outlet key');
    const changedText = outletCheck.judge({
      store: { key: 'S1', market: 'US' },
      dom: { landed: true, zeroResults: false, createDealCount: 1, textMentionCount: 1,
        skus: [{ asin: 'B012345678', sku: 'SKU-1', actionFound: true, row: 'translated presentation text' }] },
      txt: { landed: true, zeroResults: false, mentionCount: 1 },
      prev: null,
    });
    eq(changedText.items[0].itemKey, v.items[0].itemKey, 'presentation text must not change outlet identity');
  });

  check('Ads 有未遍历分页时即使当前页无异常也不得变绿', () => {
    const txt = adsCheck.parseText(
      'Campaigns Active Campaign name Country Status A Paused Total: 20 Next',
      null,
      { url: 'https://advertising.amazon.com/cm/campaigns' },
    );
    const v = judgeAds({
      dom: { landed: true, enabled: 0, paused: 1, activeTotal: 1, stateSource: 'cell-text', paginationComplete: false },
      txt,
      config: { _currentSlot: 'ads-off' },
    });
    eq(v.status, 'PARTIAL_EVIDENCE', 'status');
    eq(v.severity, 'ERROR', 'severity');
    eq(v.metrics.paginationComplete, false, 'paginationComplete');
  });

  check('ASIN 将页面不存在/无货与登录、拦截、渲染失败分开', () => {
    const notFound = asinDetailDef.judgeAsin({
      asin: 'B012345678', dom: { landed: false, dogPage: true }, txt: { landed: false, notFound: true }, prev: null,
    });
    eq(notFound.status, 'INACTIVE_LISTING', 'page not found is excluded after two-route proof');
    eq(notFound.severity, 'OK', 'inactive page severity');
    const unavailable = asinDetailDef.judgeAsin({
      asin: 'B012345678', dom: { landed: true, unavailable: true, hasCart: false }, txt: { landed: true, unavailable: true, hasCartText: false }, prev: null,
    });
    eq(unavailable.status, 'INACTIVE_LISTING', 'two-route unavailable is excluded from active inventory');
    const login = asinDetailDef.judgeAsin({
      asin: 'B012345678', dom: { looksLikeLogin: true, landed: false }, txt: { looksLikeLogin: true, landed: false }, prev: null,
    });
    eq(login.status, 'LOGIN_REQUIRED', 'login status');
    eq(login.severity, 'ERROR', 'login is collection error');
    const render = asinDetailDef.judgeAsin({ asin: 'B012345678', dom: null, txt: null, prev: null });
    eq(render.status, 'ERROR', 'render error');
    eq(render.severity, 'ERROR', 'render severity');
    eq(isRecoverableAsinSafety({ code: 'PAGE_CHANGED_BEFORE_EVIDENCE_READ' }), true, 'transient page change retry');
    eq(isRecoverableAsinSafety({ code: 'AUTH_SENSITIVE', authSensitive: true }), false, 'auth must not use ordinary retry');
    eq(allowlistedBrowserErrorCode('err_proxy_connection_failed'), 'ERR_PROXY_CONNECTION_FAILED', 'allowlisted internal error');
    eq(allowlistedBrowserErrorCode('https://secret.example/?token=x'), null, 'arbitrary internal text must not escape');
  });

  check('ASIN 基线键包含店铺+市场+ASIN，比较日严格取前一自然日', () => {
    eq(asinStateKey('S1', 'us', 'b012345678'), 'S1:US:B012345678', 'state key');
    ok(asinStateKey('S1', 'US', 'B012345678') !== asinStateKey('S2', 'US', 'B012345678'), '不同店铺不得共用基线');
    eq(previousDateKey('2026-03-01'), '2026-02-28', 'month boundary');
    eq(previousDateKey('2024-03-01'), '2024-02-29', 'leap day');
  });

  check('VOC 等待结构化行与文本 ASIN 集合一致，不把先出现的页面文字当作详情就绪', () => {
    const text = { asinCount: 2, asins: ['B012345678', 'B087654321'], zeroResults: false };
    eq(vocCheck.ready({ dom: { rows: [], zeroResults: false }, txt: text }), false, 'text-only SPA shell');
    eq(vocCheck.ready({
      dom: { rows: [{ asin: 'B012345678' }], zeroResults: false }, txt: text,
    }), false, 'partial structured rows');
    eq(vocCheck.ready({
      dom: { rows: [{ asin: 'B012345678' }, { asin: 'B087654321' }], zeroResults: false }, txt: text,
    }), true, 'matching structured and text inventory');
    eq(vocCheck.ready({
      dom: { rows: [], zeroResults: true }, txt: { asins: [], asinCount: 0, zeroResults: true },
    }), true, 'independent zero result evidence');
    ok(vocCheck.detailSessionMaxItems >= 25, 'normal VOC inventory must not trigger proactive profile rotation');
  });

  await checkAsync('VOC 逐真实 ASIN 访问只读详情，双路完成后才登记并生成幂等键', async () => {
    const root = path.join(tmp, 'voc-details');
    const cfg = deepMerge(config, { outDir: root, paths: { outDir: root } });
    cfg.outDir = root;
    const listUrl = 'https://sellercentral.amazon.com/voice-of-the-customer';
    let current = listUrl;
    const detailVisits = [];
    let listVisits = 0;
    let detailClicks = 0;
    let storeOpenCount = 0;
    let storeCloseCount = 0;
    let rendererFailures = 0;
    let startupUrlPending = false;
    const zn = {
      async storeOpen() {
        storeOpenCount++;
        current = listUrl;
        startupUrlPending = storeOpenCount > 1;
        return { storeId: `voc-session-${storeOpenCount}` };
      },
      async visit(_storeId, url) {
        if (/asin=B076543210/.test(url) && rendererFailures < 2) {
          rendererFailures++;
          throw new Error('Timed out receiving message from renderer: 60.000');
        }
        current = url;
        if (/\?asin=/.test(url)) detailVisits.push(url);
        if (url === listUrl) listVisits++;
        return { url };
      },
      async currentUrl() {
        if (startupUrlPending) {
          startupUrlPending = false;
          return '';
        }
        return current;
      },
      async activateVocReadOnlyDetail(_storeId, asin) {
        current = `${listUrl}?asin=${asin}`;
        detailClicks++;
        return {
          activated: true, transition: 'url', openedNewTab: false,
          rowFound: true, controlFound: true, candidateCount: 1,
          controlTag: 'kat-button', clickMethod: 'webdriver-shadow', usedShadowButton: true,
        };
      },
      async releaseVocReadOnlyDetail() {},
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true,
          } };
        }
        if (String(script).includes('voc-detail/v1')) {
          const asin = /asin=(B0[A-Z0-9]{8})/.exec(current)?.[1];
          return { result: {
            landed: true, asin, asinBound: true, detailRootMatched: true,
            expectedAsinObserved: true, asins: [asin],
            cxHealth: asin === 'B012345678' ? 'Poor' : 'Good', ncxRatePct: 4.2,
            returnReasons: ['Defective item'], customerIssues: ['Ink leaked'],
            records: [{ reason: 'Defective item', date: 'Aug 26, 2026', identifier: `RET-${asin}`, customerIssue: 'Ink leaked' }],
          } };
        }
        return { result: {
          landed: true, poorCount: 0, zeroResults: false,
          headerMappedRowCount: 3, headerMappingCompleteRowCount: 3,
          rows: [
            { asin: 'B012345678', ncxRatePct: 4.2, detailUrl: `${listUrl}?asin=B012345678`, topNcxReason: 'Defective item' },
            { asin: 'B076543210', ncxRatePct: 1.5, detailUrl: `${listUrl}?asin=B076543210`, topNcxReason: 'Damaged item' },
            { asin: 'B087654321', ncxRatePct: 1.1, detailUrl: null, topNcxReason: 'Wrong item was sent' },
          ],
        } };
      },
      async content() {
        const asin = /asin=(B0[A-Z0-9]{8})/.exec(current)?.[1];
        if (asin) return { text: `Voice of the Customer ${asin} CX Health ${asin === 'B012345678' ? 'Poor' : 'Good'} NCX rate: 4.2% Return reason: Defective item Customer issue: Ink leaked Aug 26, 2026` };
        return { text: 'Voice of the Customer CX Health B012345678 B076543210 B087654321' };
      },
      async storeClose() { storeCloseCount++; },
    };
    const s = await runGenericCheck({
      zn, config: cfg,
      stores: [{ key: 'S-VOC', id: 'S-VOC', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet,
      def: {
        ...vocCheck, settleMs: 0, readyTimeoutMs: 0, detailSettleMs: 0,
        detailReadyTimeoutMs: 10, detailSessionMaxItems: 20, detailRestartDelayMs: 1,
        detailRestartReadyTimeoutMs: 20, detailRestartReadyPollMs: 1,
      },
      opts: { slot: 'selftest' },
    });
    eq(detailVisits.length + detailClicks, 3, 'detail opens');
    eq(detailClicks, 1, 'missing href must use narrowly-scoped read-only detail click');
    eq(rendererFailures, 2, 'renderer failure fixture exercises two consecutive poisoned sessions');
    eq(isRecoverableVocRendererFailure('Timed out receiving message from renderer: 60.000'), true, 'renderer classifier');
    eq(isRecoverableVocDetailFailure(
      { safe: false, emptyShell: true, code: 'EMPTY_SHELL' },
      'VOC 详情为空壳或无法确认，DOM 与文本证据已抑制',
    ), true, 'safe detail shell is retryable through a fresh bounded session');
    eq(isRecoverableVocDetailFailure(
      { safe: false, authSensitive: true, code: 'AUTH_SENSITIVE' },
      'VOC 详情为空壳或无法确认',
    ), false, 'authentication state is never retried as an ordinary shell');
    const reusable = reusableVocDetailsFromReport({
      check: 'voc', finishedAt: `${bjDateKey()}T08:00:00+08:00`,
      results: [{
        storeKey: 'S-VOC', metrics: { collectionStatus: 'PARTIAL_EVIDENCE', detailFailures: 1 },
        evidence: { dom: {
          rows: [{ asin: 'B012345678' }, { asin: 'B076543210' }, { asin: 'B087654321' }],
          details: [{
            asin: 'B012345678', error: null, safety: { safe: true, code: 'BUSINESS_PAGE' },
            dom: { landed: true, asinBound: true, detailRootMatched: true, asin: 'B012345678' },
            txt: { landed: true, asinBound: true, asin: 'B012345678' },
          }],
        } },
      }],
    }, { storeKey: 'S-VOC', asins: ['B012345678', 'B076543210', 'B087654321'], dateKey: bjDateKey() });
    eq(reusable.size, 1, 'same-day partial report reuses only strict dual-path complete details');
    eq(storeOpenCount, 3, 'two renderer failures must each restart the same store browser before succeeding');
    ok(storeCloseCount >= 2, 'each poisoned detail session must close before retry');
    eq(listVisits, 3, 'opened list page is reused and contiguous href details skip the redundant first list return');
    eq(s.results[0].metrics.registered, 3, 'registered');
    eq(s.results[0].metrics.detailFailures, 0, 'detail failures');
    eq(s.results[0].status, 'POOR_CX', 'business anomaly status');
    eq(s.results[0].severity, 'CRITICAL', 'business anomaly severity');
    ok(s.results[0].items.every((item) => /^voc-asin:[a-f0-9]{32}$/.test(item.itemKey)), 'ASIN idempotency keys');
    ok(s.results[0].items.flatMap((item) => item.records).every((record) => /^voc-record:[a-f0-9]{32}$/.test(record.itemKey)), 'record idempotency keys');
    ok(!JSON.stringify(s.results[0]).includes('?asin='), 'detail query parameters must not persist');
  });

  await checkAsync('Feedback SPA 仅在证据读取前等待完整 URL 身份稳定', async () => {
    const urls = [
      'https://sellercentral.amazon.com/feedback-manager/index.html?view=loading',
      'https://sellercentral.amazon.com/feedback-manager/index.html?view=recent',
      'https://sellercentral.amazon.com/feedback-manager/index.html?view=recent',
    ];
    let reads = 0;
    const stable = await waitForStablePageIdentity({
      zn: { async currentUrl() { return urls[Math.min(reads++, urls.length - 1)]; } },
      storeId: 'feedback-stable-url', timeoutMs: 100, pollMs: 5,
    });
    eq(stable, urls[2], 'the final full in-memory URL becomes the strict read baseline');
    eq(reads, 3, 'two equal consecutive identities are required');
    eq(canRetryEvidenceIdentity(
      { pageIdentityRetries: 2 },
      { liveSafety: { code: 'PAGE_CHANGED_DURING_EVIDENCE_READ', authSensitive: false } },
      0,
    ), true, 'a discarded SPA identity-change attempt may restart from zero');
    eq(canRetryEvidenceIdentity(
      { pageIdentityRetries: 2 },
      { liveSafety: { code: 'AUTH_SENSITIVE', authSensitive: true } },
      0,
    ), false, 'authentication states are never retried as SPA churn');
    eq(canRetryEvidenceIdentity({ pageIdentityRetries: 2 }, {
      liveSafety: { code: 'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE', authSensitive: false },
    }), true, 'a changed live probe also permits a wholly fresh gated read');
    eq(canRetryEvidenceIdentity({ pageIdentityRetries: 2 }, {
      liveSafety: { code: 'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE', authSensitive: false },
    }, 2), false, 'identity retry budget is bounded');
    eq(vocCheck.pageIdentityRetries, 2, 'VOC list hydration has the same bounded identity recovery');
  });

  await checkAsync('通用采集的 SPA 重试只接受全新双路证据，持续跳转与认证仍阻断', async () => {
    for (const mode of ['probe', 'content', 'churn', 'auth']) {
      const root = path.join(tmp, `spa-reread-${mode}`);
      const base = 'https://sellercentral.amazon.com/feedback-manager/index.html';
      let current = base, probes = 0, reads = 0, texts = 0;
      const zn = {
        async storeOpen() { return { storeId: mode }; },
        async visit() { return { url: current }; },
        async currentUrl() { return current; },
        async execExtract(_id, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
            probes++;
            if (probes === 1 && ['probe', 'auth'].includes(mode)) current = `${base}?view=ready`;
            return { result: {
              probeVersion: 1, looksLikeLogin: mode === 'auth', looksBlocked: false,
              liveDocument: true, traversalComplete: true,
            } };
          }
          reads++;
          return { result: { landed: true, marker: mode === 'content' && reads === 1 ? 'DISCARDED_OLD_DOM' : 'FRESH_DOM' } };
        },
        async content() {
          texts++;
          if (mode === 'churn' || (mode === 'content' && texts === 1)) current = `${base}?view=${texts}`;
          return { text: mode === 'content' && texts === 1 ? 'DISCARDED_OLD_TEXT' : 'FRESH_TEXT' };
        },
        async storeClose() {},
      };
      const cfg = deepMerge(config, {
        outDir: root, paths: { outDir: root }, ziniao: { retries: 0, settleMs: 0 },
        storeHealth: { screenshot: false, saveRawPageText: false },
        alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
        crm: { enabled: false },
      });
      cfg.outDir = root;
      const def = {
        id: 'spa-retry-test', no: 3, title: 'SPA', requirement: 'fresh evidence',
        paths: [base], extractor: 'spa-test-extractor', settleMs: 0, maxAttempts: 1,
        pageIdentityRetries: 2, parseText(text) { return { landed: true, marker: text }; },
        judge() { return { status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }; },
      };
      const summary = await runGenericCheck({ zn, config: cfg, stores: [{ key: mode, id: mode }],
        logger: quiet, def, opts: { slot: 'selftest' } });
      const result = summary.results[0];
      eq(result.status, mode === 'auth' ? 'LOGIN_REQUIRED' : mode === 'churn' ? 'ERROR' : 'CLEAR', mode);
      eq(reads, mode === 'auth' ? 0 : mode === 'churn' ? 3 : mode === 'content' ? 2 : 1, `${mode} bounded reads`);
      ok(!JSON.stringify(result).includes('DISCARDED_OLD_'), 'discarded evidence must not reach reports');
      ok(!JSON.stringify(result).includes('?view='), 'raw identity must not persist');
      if (result.ok) eq(result.verdictSource, 'dom+text', 'success still requires both sources');
    }
  });

  await checkAsync('VOC 详情返回列表也重试完整双路读取，持续跳转与认证仍阻断', async () => {
    for (const mode of ['probe', 'content', 'churn', 'auth']) {
      const root = path.join(tmp, `voc-return-${mode}`);
      const base = 'https://sellercentral.amazon.com/voice-of-the-customer';
      const canonical = `${base}/ref_=xx_voc_dnav_xx`;
      let current = base, returning = false, probes = 0, reads = 0, texts = 0, shots = 0;
      const zn = {
        async storeOpen() { return { storeId: mode }; },
        async currentUrl() { return current; },
        async visit() { returning = true; current = base; return { url: current }; },
        async execExtract(_id, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
            if (returning && ++probes === 1 && ['probe', 'auth'].includes(mode)) current = canonical;
            return { result: {
              probeVersion: 1, looksLikeLogin: returning && mode === 'auth', looksBlocked: false,
              liveDocument: true, traversalComplete: true,
            } };
          }
          if (returning) reads++;
          return { result: { landed: true, rows: [] } };
        },
        async content() {
          if (!returning) current = canonical;
          else {
            texts++;
            if (mode === 'content' && texts === 1) current = canonical;
            if (mode === 'churn') current = `${base}?view=${texts}`;
          }
          return { text: 'VOC ready' };
        },
        async screenshot(_id, file) {
          shots++;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, 'safe-test-image');
          return { path: file };
        },
        async storeClose() {},
      };
      const cfg = deepMerge(config, {
        outDir: root, paths: { outDir: root }, ziniao: { retries: 0, settleMs: 0 },
        storeHealth: { screenshot: true, saveRawPageText: false },
        alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
        crm: { enabled: false },
      });
      cfg.outDir = root;
      const def = {
        id: 'voc-return-test', no: 7, title: 'VOC', requirement: 'fresh list',
        paths: [base], extractor: 'list-test', detailExtractor: 'detail-test', settleMs: 0,
        maxAttempts: 1, pageIdentityRetries: 2,
        parseText() { return { landed: true }; },
        judge() { return { status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }; },
      };
      const summary = await runGenericCheck({ zn, config: cfg, stores: [{ key: mode, id: mode }],
        logger: quiet, def, opts: { slot: 'selftest' } });
      const result = summary.results[0];
      eq(result.status, mode === 'auth' ? 'LOGIN_REQUIRED' : mode === 'churn' ? 'ERROR' : 'CLEAR', mode);
      eq(reads, mode === 'auth' ? 0 : mode === 'churn' ? 3 : mode === 'content' ? 2 : 1, `${mode} bounded return reads`);
      eq(shots, result.ok ? 1 : 0, 'only a verified stable list may be captured');
      if (result.ok) eq(result.verdictSource, 'dom+text', 'both paths remain mandatory');
      else eq(result.baselineEligible, false, 'unsafe return cannot update baseline');
    }
  });

  await checkAsync('广告骨架页禁止截图并用新紫鸟会话重试一次', async () => {
    const root = path.join(tmp, 'ads-loading-fresh-session-retry');
    const cfg = deepMerge(config, {
      outDir: root, paths: { outDir: root },
      ziniao: { retries: 0, settleMs: 0, closeStoreAfterCheck: true },
      storeHealth: { screenshot: true, saveRawPageText: false },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    cfg.outDir = root;
    const pageUrl = 'https://advertising.amazon.com/campaign-manager/all-campaigns';
    let session = 0;
    let screenshots = 0;
    let closes = 0;
    const zn = {
      async storeOpen() { session++; return { storeId: `ads-session-${session}` }; },
      async visit() { return { url: pageUrl }; },
      async currentUrl() { return pageUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        return { result: { landed: true, tableReady: session > 1 } };
      },
      async content() { return { text: session > 1 ? 'campaign table ready' : 'campaign table loading' }; },
      async screenshot(_storeId, file) {
        screenshots++;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'safe-test-image');
        return { path: file };
      },
      async storeClose() { closes++; },
    };
    const def = {
      id: 'ads-loading-test', no: 8, title: 'ads loading', requirement: 'ready evidence',
      paths: [pageUrl], extractor: 'ads-loading-test-extractor', settleMs: 0, readyTimeoutMs: 0,
      screenshotRequiresReady: true, retryFreshSessionWhenNotReady: true,
      parseText(text) { return { landed: true, tableReady: /table ready/.test(text) }; },
      ready({ dom, txt }) { return dom?.tableReady === true && txt?.tableReady === true; },
      judge() { return { status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }; },
    };
    eq(shouldRetryIncompletePage(def, {
      best: {
        safety: { safe: true }, dom: { landed: true }, txt: { landed: true }, ready: false,
        readWasLiveSafe: true, landedBeforeSafety: true,
      },
    }), true, 'safe landed loading page is retryable');
    eq(shouldRetryIncompletePage(def, {
      best: {
        safety: { safe: false, code: 'ACCESS_BLOCKED' }, dom: null, txt: null, ready: false,
        readWasLiveSafe: true, landedBeforeSafety: true,
      },
    }), true, 'a block signal appearing after a safe incomplete read gets one clean-session retry');
    const summary = await runGenericCheck({
      zn, config: cfg, stores: [{ key: 'WANG', id: 'WANG' }], logger: quiet, def,
      opts: { slot: 'ads-off' },
    });
    eq(session, 2, 'exactly one fresh browser session retry');
    eq(screenshots, 1, 'loading session must not be screenshotted');
    ok(closes >= 2, 'loading and successful sessions both close');
    eq(summary.results[0].status, 'CLEAR', 'second ready session determines verdict');
    ok(!!summary.results[0].screenshot, 'ready campaign table screenshot is retained');
  });

  await checkAsync('广告只读筛选准备失败时立即关闭紫鸟会话', async () => {
    const pageUrl = 'https://advertising.amazon.com/campaign-manager/all-campaigns';
    let closes = 0;
    const zn = {
      async storeOpen() { return { storeId: 'ads-filter-failure-session' }; },
      async visit() { return { url: pageUrl }; },
      async currentUrl() { return pageUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        return { result: { landed: false } };
      },
      async selectAdvertisingCampaignNameFilter() {
        throw new Error('campaign search control unavailable');
      },
      async storeClose() { closes++; },
    };
    const def = {
      id: 'ads-filter-cleanup-test', no: 8, title: 'ads filter cleanup', requirement: 'cleanup',
      paths: [pageUrl], extractor: 'ads-filter-cleanup-extractor', settleMs: 0,
      advertisingNameFilter: true,
      parseText() { return { landed: false }; },
      judge() { return { status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }; },
    };
    const runConfig = deepMerge(config, {
      storeHealth: { screenshot: false },
      ziniao: { retries: 0, retryDelayMs: 0, closeStoreAfterCheck: true },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    const summary = await runGenericCheck({
      zn, config: runConfig,
      stores: [{ key: 'WANG', id: 'WANG', adsNameContains: '2.26' }],
      logger: quiet, def, opts: { slot: 'ads-off' },
    });
    eq(closes, 1, 'probe owns and closes a session that cannot be returned to the outer runner');
    eq(summary.results[0].status, 'ERROR', 'filter preparation failure stays a collection error');
  });

  await checkAsync('备用地址进入紫鸟内部错误页时必须覆盖早先空壳并触发新会话重试', async () => {
    const firstUrl = 'https://sellercentral.amazon.com/test-shell-one';
    const secondUrl = 'https://sellercentral.amazon.com/test-shell-two';
    let session = 0;
    let currentUrl = '';
    let closes = 0;
    const zn = {
      async storeOpen() {
        session++;
        currentUrl = firstUrl;
        return { storeId: `shell-session-${session}` };
      },
      async visit(_storeId, url) {
        currentUrl = session < 4 && url === secondUrl
          ? 'chrome-extension://fpdlgicppkpjfipgifohdoiiffnmfilp/error.html'
          : url;
        return { url: currentUrl };
      },
      async currentUrl() { return currentUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        return { result: session >= 4 ? { landed: true, total: 1 } : { landed: false, total: 0 } };
      },
      async content() { return { text: session >= 4 ? 'Target data ready' : '' }; },
      async storeClose() { closes++; },
    };
    const def = {
      id: 'internal-after-shell-test', no: 7, title: 'internal after shell', requirement: 'ready target',
      paths: [firstUrl, secondUrl], extractor: 'internal-after-shell-extractor',
      settleMs: 0, readyTimeoutMs: 0, maxAttempts: 4,
      parseText(text) { return { landed: /Target data ready/.test(text), total: /Target data ready/.test(text) ? 1 : 0 }; },
      ready({ dom, txt }) { return dom?.landed === true && txt?.landed === true; },
      judge() { return { status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }; },
    };
    const runConfig = deepMerge(config, {
      storeHealth: { screenshot: false },
      ziniao: { retries: 2, retryDelayMs: 0 },
    });
    const summary = await runGenericCheck({
      zn, config: runConfig, stores: [{ key: 'WANG', id: 'WANG' }], logger: quiet, def,
      opts: { slot: 'adhoc' },
    });
    eq(session, 4, 'definition attempt limit preserves the final fresh session');
    ok(closes >= 2, 'poisoned and successful sessions are closed');
    eq(summary.results[0].status, 'CLEAR', 'fresh session result');
  });

  await checkAsync('VOC 新标签详情关闭已恢复列表时不得重复导航 SPA', async () => {
    const root = path.join(tmp, 'voc-new-tab-list-reuse');
    const cfg = deepMerge(config, {
      outDir: root, paths: { outDir: root },
      storeHealth: { screenshot: false, saveRawPageText: false },
    });
    cfg.outDir = root;
    const listUrl = 'https://sellercentral.amazon.com/voice-of-the-customer';
    const asins = ['B012345678', 'B087654321'];
    let current = listUrl;
    let listVisits = 0;
    let activeAsin = null;
    const zn = {
      async storeOpen() { return { storeId: 'voc-new-tab' }; },
      async visit(_storeId, url) {
        current = url;
        if (url === listUrl) listVisits++;
        return { url };
      },
      async currentUrl() { return current; },
      async activateVocReadOnlyDetail(_storeId, asin) {
        activeAsin = asin;
        current = `${listUrl}?asin=${asin}`;
        return {
          activated: true, transition: 'new-tab', openedNewTab: true,
          rowFound: true, controlFound: true, candidateCount: 1,
          controlTag: 'kat-button', clickMethod: 'webdriver-shadow', usedShadowButton: true,
        };
      },
      async releaseVocReadOnlyDetail() {
        activeAsin = null;
        current = listUrl;
        return { closedNewTab: true };
      },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        if (String(script).includes('voc-detail/v1')) {
          return { result: {
            landed: true, asin: activeAsin, asinBound: true, detailRootMatched: true,
            expectedAsinObserved: true, asins: [activeAsin], cxHealth: 'Good',
            returnReasons: [], customerIssues: [], records: [],
          } };
        }
        return { result: {
          landed: true, poorCount: 0, zeroResults: false,
          headerMappedRowCount: 2, headerMappingCompleteRowCount: 2,
          rows: asins.map((asin) => ({ asin, cxHealth: 'Good', detailUrl: null })),
        } };
      },
      async content() {
        return { text: activeAsin
          ? `Voice of the Customer ${activeAsin} CX Health Good Return reason: no available records`
          : `Voice of the Customer CX Health ${asins.join(' ')}` };
      },
      async storeClose() {},
    };
    const summary = await runGenericCheck({
      zn, config: cfg,
      stores: [{ key: 'S-VOC-TAB', id: 'S-VOC-TAB', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet,
      def: { ...vocCheck, settleMs: 0, readyTimeoutMs: 0, detailSettleMs: 0, detailReadyTimeoutMs: 10 },
      opts: { slot: 'selftest' },
    });
    eq(summary.results[0].metrics.detailFailures, 0, 'new-tab detail failures');
    eq(summary.results[0].metrics.registered, 2, 'new-tab registered');
    eq(listVisits, 1, 'opened list page is reused; detail-tab lifecycle adds no list navigation');
  });

  await checkAsync('VOC 每店只保存首个安全详情失败截图，认证竞态立即删图', async () => {
    const runScenario = async ({ suffix, postCaptureAuth, asinCount }) => {
      const root = path.join(tmp, `voc-detail-diagnostic-${suffix}`);
      const cfg = deepMerge(config, {
        outDir: root, paths: { outDir: root },
        storeHealth: { screenshot: true, saveRawPageText: false },
      });
      cfg.outDir = root;
      const listUrl = 'https://sellercentral.amazon.com/voice-of-the-customer';
      const rows = ['B012345678', 'B087654321'].slice(0, asinCount).map((asin) => ({
        asin, detailUrl: `${listUrl}?asin=${asin}`, ncxRatePct: 1.2,
      }));
      let current = listUrl;
      let authOverlay = false;
      let detailCaptures = 0;
      const detailPaths = [];
      const marker = `VOC_DIAGNOSTIC_${suffix}`;
      const zn = {
        async storeOpen() { return { storeId: `voc-diagnostic-${suffix}` }; },
        async visit(_storeId, url) { current = url; authOverlay = false; return { url }; },
        async currentUrl() { return current; },
        async execExtract(_storeId, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
            return { result: {
              probeVersion: 1, looksLikeLogin: authOverlay,
              looksBlocked: false, liveDocument: true, traversalComplete: true,
            } };
          }
          if (String(script).includes('voc-detail/v1')) {
            return { result: {
              landed: false, asin: null, asins: [], pageTextLength: 321,
              diagnostics: { visibleDialogCount: 1, visibleDrawerCount: 0 },
              marker,
            } };
          }
          return { result: { landed: true, poorCount: 0, zeroResults: false, rows } };
        },
        async content() {
          return { text: /[?&]asin=/.test(current)
            ? `Voice of the Customer detail shell ${marker}`
            : `Voice of the Customer CX Health ${rows.map((row) => row.asin).join(' ')}` };
        },
        async screenshot(_storeId, file) {
          fs.writeFileSync(file, marker);
          if (file.includes('_detail_failure_')) {
            detailCaptures++;
            detailPaths.push(file);
            if (postCaptureAuth) authOverlay = true;
          }
          return { path: file };
        },
        async storeClose() {},
      };
      const summary = await runGenericCheck({
        zn, config: cfg,
        stores: [{ key: `S-${suffix}`, id: `S-${suffix}`, market: 'US', host: 'sellercentral.amazon.com' }],
        logger: quiet,
        def: {
          ...vocCheck, settleMs: 0, readyTimeoutMs: 0, detailSettleMs: 0,
          detailReadyTimeoutMs: 0, detailMaxRetries: 0,
        },
        opts: { slot: 'selftest' },
      });
      return { root, marker, detailCaptures, detailPaths, result: summary.results[0] };
    };

    const safe = await runScenario({ suffix: 'SAFE', postCaptureAuth: false, asinCount: 2 });
    eq(safe.detailCaptures, 1, '每店详情失败诊断截图数量');
    const firstPath = safe.result.items[0].detailScreenshot;
    ok(firstPath && !path.isAbsolute(firstPath), 'item 必须保存相对截图路径');
    eq(safe.result.evidence.dom.details[0].screenshot, firstPath, 'detail 与 item 截图路径一致');
    eq(safe.result.items[1].detailScreenshot, null, '第二个详情失败不得重复截图');
    ok(fs.existsSync(path.join(safe.root, firstPath)), '安全详情失败截图应保留');
    eq(safe.result.items[0].detailDiagnostics.visibleDialogCount, 1, 'modal 结构化诊断');
    eq(safe.result.items[0].detailDiagnostics.domLanded, false, 'DOM landed 诊断');
    eq(safe.result.items[0].detailDiagnostics.txtLanded, false, '文本 landed 诊断');
    ok(safe.result.items[0].detailDiagnostics.detailTextLength > 0, '仅记录文本长度');

    const auth = await runScenario({ suffix: 'AUTH', postCaptureAuth: true, asinCount: 1 });
    eq(auth.detailCaptures, 1, '认证竞态诊断截图尝试数');
    eq(auth.result.items[0].detailScreenshot, null, '认证竞态不得保留详情截图路径');
    eq(auth.result.items[0].detailDiagnostics.capturePostSafetyCode, 'AUTH_SENSITIVE', '认证竞态安全码');
    ok(auth.detailPaths.every((file) => !fs.existsSync(file)), '认证竞态 PNG 必须删除');
    ok(!JSON.stringify(auth.result.evidence).includes(auth.marker), '认证竞态不得保留详情 DOM/文本内容');
  });

  check('VOC 详情仅绑定可见详情根中的唯一目标 ASIN，列表背景不得误通过', () => {
    const runDetail = ({
      expected, modalAsin, href = 'https://sellercentral.amazon.com/voice-of-the-customer', cxText = '',
    }) => {
      const modalText = `${modalAsin} ${cxText} Return reason: Defective item Customer issue: Ink leaked`;
      const modal = {
        textContent: modalText, innerText: modalText, shadowRoot: null,
        getClientRects: () => [{ width: 400, height: 300 }],
        querySelectorAll: () => [],
      };
      const bodyText = `Voice of the Customer B012345678 B087654321 ${modalText}`;
      const body = {
        textContent: bodyText, innerText: bodyText, shadowRoot: null,
        getClientRects: () => [{ width: 900, height: 700 }],
        querySelectorAll: (selector) => selector === '*' ? [modal] : [],
      };
      const document = {
        body, title: 'VOC',
        querySelectorAll(selector) {
          if (selector === '*') return [modal];
          if (selector.includes('[role=dialog]')) return [modal];
          return [];
        },
      };
      const window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
      const script = vocDetailExtractor(expected);
      return new Function('window', 'document', 'location', 'NodeFilter', 'URL', script)(
        window, document, { href }, NodeFilter, URL,
      );
    };
    const correct = runDetail({ expected: 'B012345678', modalAsin: 'B012345678' });
    eq(correct.landed, true, 'correct modal landed');
    eq(correct.asinBound, true, 'correct modal bound');
    eq(correct.asin, 'B012345678', 'correct modal asin');
    const correctExtremeCx = runDetail({
      expected: 'B012345678', modalAsin: 'B012345678', cxText: '买家满意度状况: 极差',
    });
    eq(correctExtremeCx.cxHealth, 'Poor', 'DOM detail maps extremely bad CX to Poor');
    const wrong = runDetail({ expected: 'B012345678', modalAsin: 'B087654321' });
    eq(wrong.landed, false, 'wrong modal must fail');
    eq(wrong.asinBound, false, 'background target ASIN must not bind wrong modal');
    const wrongDespiteUrl = runDetail({
      expected: 'B012345678', modalAsin: 'B087654321',
      href: 'https://sellercentral.amazon.com/voice-of-the-customer?asin=B012345678',
    });
    eq(wrongDespiteUrl.landed, false, 'URL target must not override wrong modal ASIN');
    eq(wrongDespiteUrl.asinBound, false, 'URL target conflict must fail DOM binding');

    const globalText = vocCheck.detailParseText(
      'B012345678 B087654321 Return reason: Defective item Customer issue: Ink leaked',
      { asin: 'B012345678' }, null,
      { url: 'https://sellercentral.amazon.com/voice-of-the-customer', scoped: false },
    );
    eq(globalText.landed, false, 'global multi-ASIN text must not bind');
    eq(globalText.asin, null, 'expected ASIN must not be invented');
    const wrongTextDespiteUrl = vocCheck.detailParseText(
      'B087654321 Return reason: Defective item Customer issue: Ink leaked',
      { asin: 'B012345678' }, null,
      { url: 'https://sellercentral.amazon.com/voice-of-the-customer?asin=B012345678', scoped: true },
    );
    eq(wrongTextDespiteUrl.landed, false, 'URL target must not override wrong text ASIN');
    eq(wrongTextDespiteUrl.asinBound, false, 'URL target conflict must fail text binding');

    const incomplete = vocCheck.judge({
      store: { key: 'S-INCOMPLETE', market: 'US' },
      dom: {
        landed: true, poorCount: 0, zeroResults: false,
        headerMappedRowCount: 1, headerMappingCompleteRowCount: 1,
        rows: [{ asin: 'B012345678', topNcxReason: 'Defective item' }],
        details: [{
          asin: 'B012345678', error: 'detail conflict',
          dom: {
            landed: true, asin: 'B012345678', asinBound: true, detailRootMatched: true,
            records: [{ reason: 'Defective item', identifier: 'UNTRUSTED' }],
          },
          txt: { landed: false, asin: null, asinBound: false },
        }],
      },
      txt: { landed: true, asins: ['B012345678'], poorCount: 0 },
    });
    eq(incomplete.items[0].detailComplete, false, 'incomplete detail marker');
    eq(incomplete.items[0].records.length, 0, 'incomplete detail must not create CRM VOC records');
  });

  check('VOC 固有记录 ID 键忽略可变日期、原因和语言，无 ID 才使用语义回退', () => {
    const judgedRecord = (record) => vocCheck.judge({
      store: { key: 'S-VOC-ID', market: 'US' },
      dom: {
        landed: true, poorCount: 0, zeroResults: false,
        headerMappedRowCount: 1, headerMappingCompleteRowCount: 1,
        rows: [{ asin: 'B012345678', cxHealth: 'Good' }],
        details: [{
          asin: 'B012345678',
          dom: {
            landed: true, asin: 'B012345678', asinBound: true, detailRootMatched: true,
            cxHealth: 'Good', records: [record],
          },
          txt: { landed: true, asin: 'B012345678', asinBound: true, cxHealth: 'Good', records: [] },
        }],
      },
      txt: {
        landed: true, asins: ['B012345678'], poorCount: 0,
        cxByAsin: { B012345678: 'Good' },
      },
    }).items[0].records[0].itemKey;

    const intrinsicEnglish = judgedRecord({
      identifier: 'RETURN-IMMUTABLE-1', date: '2026-08-26', reason: 'Item defective', source: 'dom',
    });
    const intrinsicChinese = judgedRecord({
      identifier: 'RETURN-IMMUTABLE-1', date: '2026-08-27', reason: '商品存在瑕疵', source: 'text-zh',
    });
    eq(intrinsicChinese, intrinsicEnglish, 'intrinsic identifier item key');

    const fallbackBefore = judgedRecord({ date: '2026-08-26', reason: 'Item defective', source: 'dom' });
    const fallbackAfter = judgedRecord({ date: '2026-08-27', reason: '性能或品质不理想', source: 'text-zh' });
    ok(fallbackBefore !== fallbackAfter, 'semantic fallback must distinguish changed no-ID records');
  });

  check('VOC 中英文乱序表头按名称映射，噪声百分比不会污染指标', () => {
    const runTable = ({
      headers, values, bodyPrefix, prefixCells = [], tdHeader = false,
      extraHeaderSets = [], noiseHeaderSets = [], hiddenHeaderSets = [], hidePrimaryHeader = false,
      nestedRoleCells = false, shadowCellValues = false,
    }) => {
      const cells = [...prefixCells, ...values].map((text) => {
        const cell = { tagName: 'TD', textContent: text, parentElement: null, getAttribute: () => null };
        if (shadowCellValues) {
          const shadowRoot = { textContent: text, querySelectorAll: () => [] };
          const host = { shadowRoot, querySelectorAll: () => [] };
          cell.textContent = '';
          cell.querySelectorAll = (selector) => selector === '*' ? [host] : [];
        }
        return cell;
      });
      const nestedCells = nestedRoleCells ? cells.map((cell) => ({
        tagName: 'DIV', textContent: cell.textContent, parentElement: cell,
        getAttribute: (name) => name === 'role' ? 'cell' : null,
      })) : [];
      const table = {
        tagName: 'TABLE', parentElement: null,
        getAttribute: () => null,
        querySelectorAll(selector) {
          if (selector === 'tr,[role=row]') return [...headerRows, row];
          return [];
        },
      };
      const makeHeaderRow = (labels, hidden = false) => {
        const headerCells = labels.map((text) => ({
          tagName: tdHeader ? 'TD' : 'TH', textContent: text, parentElement: null,
          getAttribute: () => null,
        }));
        const headerRow = {
          tagName: 'TR', parentElement: table, textContent: labels.join(' '),
          getAttribute: () => null,
          getClientRects: () => hidden ? [] : [{}],
          querySelectorAll(selector) {
            if (selector === 'th,td,[role=columnheader],[role=cell],kat-table-cell') return headerCells;
            return [];
          },
        };
        for (const cell of headerCells) cell.parentElement = headerRow;
        return headerRow;
      };
      const headerRows = [
        makeHeaderRow(headers, hidePrimaryHeader),
        ...extraHeaderSets.map((labels) => makeHeaderRow(labels)),
        ...noiseHeaderSets.map((labels) => makeHeaderRow(labels)),
        ...hiddenHeaderSets.map((labels) => makeHeaderRow(labels, true)),
      ];
      const rowText = values.join(' ');
      const row = {
        tagName: 'TR', parentElement: table, textContent: rowText,
        getAttribute: () => null,
        querySelectorAll(selector) {
          if (selector === 'td,[role=cell],kat-table-cell') return [...cells, ...nestedCells];
          if (selector === 'a[href]') return [];
          return [];
        },
      };
      for (const cell of cells) cell.parentElement = row;
      const bodyText = `${bodyPrefix} ${rowText}`;
      const body = { innerText: bodyText, textContent: bodyText };
      const document = {
        body, title: 'VOC',
        querySelectorAll: (selector) => selector === 'tr,[role=row]' ? [...headerRows, row] : [],
      };
      const window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
      return new Function('window', 'document', 'location', 'NodeFilter', 'URL', VOC_EXTRACTOR)(
        window, document, { href: 'https://sellercentral.amazon.com/voice-of-the-customer' }, NodeFilter, URL,
      );
    };
    const zh = runTable({
      bodyPrefix: '买家之声 买家满意度状况',
      headers: ['噪声百分比', '商品名称 ASIN', '订单总数', '买家不满意率', '买家满意度状况', '退货率', '买家不满意订单数', '造成负面买家体验的反馈', '上次更新时间'],
      values: ['99%', 'Ink cartridge B012345678', '71', '7.04%', '一般', '不可用', '5', '性能或品质不理想 60%', '2026年8月25日'],
    });
    eq(zh.rows[0].ncxRatePct, 7.04, 'zh ncx rate');
    eq(zh.rows[0].ncxOrders, 5, 'zh ncx orders');
    eq(zh.rows[0].totalOrders, 71, 'zh total orders');
    eq(zh.rows[0].returnRatePct, null, 'zh unavailable return rate');
    eq(zh.rows[0].topNcxReason, '性能或品质不理想', 'zh reason synonym');
    eq(zh.headerMappingCompleteRowCount, 1, 'zh complete mapping');
    const zhTd = runTable({
      bodyPrefix: '买家之声 买家满意度状况', tdHeader: true,
      headers: ['商品名称 / ASIN', '买家不满意率', '买家不满意订单数', '订单总数', '退货率', '造成负面买家体验的反馈', '上次更新时间', '买家满意度状况'],
      values: ['墨盒 B012345678', '7.04%', '5', '71', '2.1%', '商品存在瑕疵', '2026年8月25日', '较差'],
      noiseHeaderSets: [['VOC 帮助文字', 'NCX 指标说明']],
    });
    eq(zhTd.headerMappingCompleteRowCount, 1, 'zh td header complete mapping');
    eq(zhTd.rows[0].ncxOrders, 5, 'zh td ncx orders');
    eq(zhTd.rows[0].totalOrders, 71, 'zh td total orders');
    eq(zhTd.rows[0].topNcxReason, '商品存在瑕疵', 'zh td reason');
    const realHeaders = [
      '图片', '商品名称 ASIN', 'SKU状况', '订单配送方', '买家不满意率', '买家不满意订单', '订单总数',
      '星级评定', '退货率 退货率是退货订单所占的百分比', '造成负面买家体验的主要原因', '上次更新时间', '买家满意度状况', '已显示退货标记', '操作',
    ];
    const realValues = (cxValue) => [
      '图片', '墨盒 B012345678', '可售', '亚马逊', '7.04%', '5', '71', '4.2', '2.1%',
      '商品存在瑕疵', '2026年8月25日', cxValue, '是', '查看详情',
    ];
    const realNested = runTable({
      bodyPrefix: '买家之声 买家满意度状况', tdHeader: true, nestedRoleCells: true, shadowCellValues: true,
      headers: realHeaders, values: realValues('极差'),
    });
    eq(realNested.headerMappedRowCount, 1, 'real 14-column row mapped once');
    eq(realNested.headerMappingCompleteRowCount, 1, 'real 14-column row complete');
    eq(realNested.rows[0].ncxRatePct, 7.04, 'real 14-column ncx rate');
    eq(realNested.rows[0].totalOrders, 71, 'real 14-column total orders');
    eq(realNested.rows[0].cxHealth, 'Poor', 'extremely bad maps to Poor');
    eq(realNested.poorAsins[0], 'B012345678', 'DOM emits structured poor ASIN');
    const realUnqualified = runTable({
      bodyPrefix: '买家之声 买家满意度状况', tdHeader: true,
      headers: realHeaders, values: realValues('不合格'),
    });
    eq(realUnqualified.rows[0].cxHealth, 'Poor', 'unqualified maps to Poor');
    const realExcellent = runTable({
      bodyPrefix: '买家之声 买家满意度状况', tdHeader: true,
      headers: realHeaders, values: realValues('极好'),
    });
    eq(realExcellent.rows[0].cxHealth, 'Excellent', 'extremely good maps to Excellent');
    eq(realExcellent.poorCount, 0, 'extremely good is not poor');
    const en = runTable({
      bodyPrefix: 'Voice of the Customer CX Health',
      headers: ['Noise', 'Total orders', 'Product name ASIN', 'Return rate', 'NCX orders', 'CX Health', 'Last updated', 'Top NCX reason', 'NCX rate'],
      values: ['88%', '120', 'Widget B087654321', '2.5%', '3', 'Poor', 'Aug 25, 2026', 'Defective item 75%', '1.5%'],
    });
    eq(en.rows[0].ncxRatePct, 1.5, 'en ncx rate');
    eq(en.rows[0].ncxOrders, 3, 'en ncx orders');
    eq(en.rows[0].totalOrders, 120, 'en total orders');
    eq(en.rows[0].returnRatePct, 2.5, 'en return rate');
    eq(en.headerMappingCompleteRowCount, 1, 'en complete mapping');
    const enTd = runTable({
      bodyPrefix: 'Voice of the Customer CX Health', tdHeader: true,
      headers: ['Product name / ASIN', 'NCX rate', 'NCX orders', 'Total orders', 'Return rate', 'Top NCX reason', 'Last updated', 'CX Health'],
      values: ['Widget B087654321', '1.5%', '3', '120', '2.5%', 'Defective item', 'Aug 25, 2026', 'Poor'],
    });
    eq(enTd.headerMappingCompleteRowCount, 1, 'en td header complete mapping');
    eq(enTd.rows[0].ncxRatePct, 1.5, 'en td ncx rate');
    const missing = runTable({
      bodyPrefix: 'Voice of the Customer CX Health',
      headers: ['Product name ASIN', 'NCX orders', 'Total orders', 'CX Health', 'Last updated', 'Top NCX reason', 'NCX rate'],
      values: ['Widget B087654321', '3', '120', 'Good', 'Aug 25, 2026', 'Defective item', '1.5%'],
    });
    eq(missing.rows[0].returnRatePct, null, 'missing return-rate header stays null');
    eq(missing.headerMappingCompleteRowCount, 0, 'missing header must not be declared complete');
    const incompleteVerdict = vocCheck.judge({
      store: { key: 'S-MAP', market: 'US' },
      dom: {
        ...missing,
        details: [{
          asin: 'B087654321',
          dom: { landed: true, asin: 'B087654321', asinBound: true, detailRootMatched: true },
          txt: { landed: true, asin: 'B087654321', asinBound: true },
        }],
      },
      txt: { landed: true, asins: ['B087654321'], poorCount: 0 },
    });
    eq(incompleteVerdict.status, 'PARTIAL_EVIDENCE', 'missing header verdict');
    eq(incompleteVerdict.metrics.headerMappingIncomplete, true, 'missing header metric');
    const shifted = runTable({
      bodyPrefix: 'Voice of the Customer CX Health',
      headers: ['Product name ASIN', 'NCX rate', 'NCX orders', 'Total orders', 'Return rate', 'Top NCX reason', 'Last updated', 'CX Health'],
      values: ['Widget B087654321', '1.5%', '5', '120', '2.5%', 'Defective item', 'Aug 25, 2026', 'Good'],
      prefixCells: ['sticky noise'],
    });
    eq(shifted.headerMappedRowCount, 0, 'shifted cells must reject header map');
    eq(shifted.headerMappingCompleteRowCount, 0, 'shifted cells must not declare complete');
    eq(shifted.rows[0].ncxRatePct, null, 'shifted ncx rate stays null');
    eq(shifted.rows[0].totalOrders, null, 'shifted total orders stays null');
    ok(shifted.headerMissingColumns.includes('rowAlignment'), 'shifted alignment diagnostic');
    eq(shifted.headerDiagnostics[0].headerColumnCount, 8, 'alignment diagnostic header count');
    eq(shifted.headerDiagnostics[0].dataCellCount, 9, 'alignment diagnostic data count');
    eq(shifted.headerDiagnostics[0].asinCellIndexes[0], 1, 'alignment diagnostic ASIN cell index');
    const ambiguous = runTable({
      bodyPrefix: 'Voice of the Customer CX Health', tdHeader: true,
      headers: ['Product name / ASIN', 'NCX rate', 'NCX orders', 'Total orders', 'Return rate', 'Top NCX reason', 'Last updated', 'CX Health'],
      extraHeaderSets: [['Product name / ASIN', 'NCX rate', 'NCX orders', 'Total orders', 'Return rate', 'Top NCX reason', 'Last updated', 'CX Health']],
      values: ['Widget B087654321', '1.5%', '3', '120', '2.5%', 'Defective item', 'Aug 25, 2026', 'Good'],
    });
    eq(ambiguous.headerMappedRowCount, 0, 'multiple td header candidates fail closed');
    eq(ambiguous.rows[0].ncxRatePct, null, 'ambiguous header metrics stay null');
    const duplicate = runTable({
      bodyPrefix: 'Voice of the Customer CX Health', tdHeader: true,
      headers: ['Product name / ASIN', 'NCX rate', 'NCX rate', 'Total orders', 'Return rate', 'Top NCX reason', 'Last updated', 'CX Health'],
      values: ['Widget B087654321', '1.5%', '3.5%', '120', '2.5%', 'Defective item', 'Aug 25, 2026', 'Good'],
    });
    eq(duplicate.headerMappedRowCount, 0, 'duplicate known header cells fail closed');

    const hiddenWrong = runTable({
      bodyPrefix: 'Voice of the Customer CX Health', tdHeader: true, hidePrimaryHeader: true,
      headers: ['Product name / ASIN', 'NCX rate', 'NCX orders', 'Total orders', 'Return rate', 'CX Health', 'Last updated', 'Top NCX reason'],
      values: ['Widget B087654321', '1.5%', '3', '120', '2.5%', 'Defective item', 'Aug 25, 2026', '较差'],
    });
    eq(hiddenWrong.headerMappedRowCount, 0, 'hidden responsive header candidate must be rejected');
    eq(hiddenWrong.headerMappingCompleteRowCount, 0, 'hidden header must not declare complete mapping');
    eq(hiddenWrong.rows[0].cxHealth, null, 'hidden wrong-order header must not bind CX value');

    const nonSemantic = runTable({
      bodyPrefix: 'Voice of the Customer CX Health', tdHeader: true,
      headers: ['Product name / ASIN', 'NCX rate', 'Total orders'],
      values: ['Widget B087654321', '1.5%', '120'],
    });
    eq(nonSemantic.headerMappedRowCount, 0, 'partial ordinary TD data/legend row is not a semantic header');

    const unknownCx = runTable({
      bodyPrefix: 'Voice of the Customer CX Health',
      headers: ['Product name / ASIN', 'NCX rate', 'NCX orders', 'Total orders', 'Return rate', 'Top NCX reason', 'Last updated', 'CX Health'],
      values: ['Widget B087654321', '1.5%', '3', '120', '2.5%', 'Defective item', 'Aug 25, 2026', '--'],
    });
    eq(unknownCx.headerMappedRowCount, 1, 'semantic header remains mapped');
    eq(unknownCx.headerMappingCompleteRowCount, 0, 'unparseable CX cell must not declare complete evidence');
    ok(unknownCx.headerMissingColumns.includes('cxHealthValue'), 'unparseable CX diagnostic');
  });

  check('VOC 文本路径独立识别中文 Poor，DOM 漏读时仍禁止假正常', () => {
    const summaryOnly = vocCheck.parseText(
      '买家之声 买家满意度状况 汇总 极差 4 不合格 0 商品名称 ASIN B012345678 SKU正常 订单71 良好 查看详情',
    );
    eq(summaryOnly.poorCount, 0, 'top summary labels must not mark a healthy ASIN poor');
    eq(summaryOnly.poorAsins.length, 0, 'top summary has no structured poor ASIN');
    eq(summaryOnly.cxByAsin.B012345678, 'Good', 'healthy row segment binding');
    const rowPoor = vocCheck.parseText(
      '买家之声 买家满意度状况 汇总 极差 4 不合格 0 商品名称 ASIN B087654321 SKU正常 订单71 极差 查看详情',
    );
    eq(rowPoor.poorCount, 1, 'real poor row count');
    eq(rowPoor.poorAsins[0], 'B087654321', 'real poor row ASIN');
    eq(rowPoor.cxByAsin.B087654321, 'Poor', 'real poor row canonical CX');
    const txt = vocCheck.parseText('买家之声 买家满意度状况 B087654321 较差');
    eq(txt.poorCount, 1, 'Chinese Poor text count');
    const verdict = vocCheck.judge({
      store: { key: 'S-ZH-POOR', market: 'US' },
      dom: {
        landed: true, poorCount: 0, zeroResults: false,
        headerMappedRowCount: 1, headerMappingCompleteRowCount: 1,
        rows: [{ asin: 'B087654321', cxHealth: null }],
        details: [{
          asin: 'B087654321',
          dom: { landed: true, asin: 'B087654321', asinBound: true, detailRootMatched: true },
          txt: { landed: true, asin: 'B087654321', asinBound: true },
        }],
      },
      txt,
    });
    eq(verdict.status, 'POOR_CX', 'Chinese text anomaly status');
    eq(verdict.ok, false, 'Chinese Poor must not pass');
    eq(verdict.metrics.businessStatus, 'ANOMALY', 'Chinese text business status');
    eq(verdict.metrics.poorAsins[0], 'B087654321', 'verdict exposes structured poor ASIN');
    eq(verdict.items[0].cxHealth, 'Poor', 'item uses the more severe text CX evidence');
  });

  check('VOC 真实中文退货原因同义词进入结构化记录', () => {
    for (const reason of ['商品存在瑕疵', '性能或品质不理想']) {
      const parsed = vocCheck.detailParseText(
        `B012345678 Return reason: ${reason} Customer issue: 包装损坏`,
        { asin: 'B012345678' }, null,
        { url: 'https://sellercentral.amazon.com/voice-of-the-customer', scoped: true },
      );
      ok(parsed.returnReasons.includes(reason), `missing reason: ${reason}`);
      eq(parsed.asinBound, true, `bound: ${reason}`);
    }
    for (const [rawCx, expectedCx] of [['极差', 'Poor'], ['不合格', 'Poor'], ['极好', 'Excellent']]) {
      const parsed = vocCheck.detailParseText(
        `B012345678 买家满意度状况: ${rawCx} Return reason: 商品存在瑕疵 Customer issue: 包装损坏`,
        { asin: 'B012345678' }, null,
        { url: 'https://sellercentral.amazon.com/voice-of-the-customer', scoped: true },
      );
      eq(parsed.cxHealth, expectedCx, `detail CX mapping: ${rawCx}`);
    }
  });

  await checkAsync('VOC 原生激活无实际转场时必须 DETAIL_ERROR，禁止回退 JS click', async () => {
    const root = path.join(tmp, 'voc-noop-click');
    const cfg = deepMerge(config, { outDir: root, paths: { outDir: root }, storeHealth: { screenshot: false } });
    cfg.outDir = root;
    const listUrl = 'https://sellercentral.amazon.com/voice-of-the-customer';
    let activationCalls = 0;
    let legacyOpenCalls = 0;
    const zn = {
      async storeOpen() { return { storeId: 'voc-noop' }; },
      async currentUrl() { return listUrl; },
      async activateVocReadOnlyDetail() {
        activationCalls++;
        return { activated: false, transition: 'none', rowFound: true, controlFound: true, candidateCount: 1 };
      },
      async releaseVocReadOnlyDetail() {},
      async visit() { return { url: listUrl }; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: { probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true } };
        }
        if (String(script).includes('voc-detail-open/v1')) legacyOpenCalls++;
        return { result: {
          landed: true, poorCount: 0, zeroResults: false,
          headerMappedRowCount: 1, headerMappingCompleteRowCount: 1,
          rows: [{ asin: 'B012345678', detailUrl: null }],
        } };
      },
      async content() { return { text: 'Voice of the Customer B012345678 CX Health Good' }; },
      async storeClose() {},
    };
    const summary = await runGenericCheck({
      zn, config: cfg,
      stores: [{ key: 'S-NOOP', id: 'S-NOOP', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet, def: { ...vocCheck, settleMs: 0, readyTimeoutMs: 0 }, opts: { slot: 'selftest' },
    });
    eq(activationCalls, 1, 'native activation attempts');
    eq(legacyOpenCalls, 0, 'legacy JS opener calls');
    eq(summary.results[0].status, 'DETAIL_ERROR', 'no-op status');
    eq(summary.results[0].severity, 'ERROR', 'no-op severity');
  });

  await checkAsync('CRM 损坏账本被三条 runner 隔离，主报告二次落盘且不重建账本', async () => {
    const ledgerBody = '{damaged-ledger';
    const makeConfig = (root, outDir, extra = {}) => {
      const cfg = deepMerge(DEFAULTS, {
        ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
        storeHealth: { screenshot: false, saveRawPageText: false },
        asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
        alert: {
          console: false, file: false,
          dingtalk: { enabled: false }, webhook: { enabled: false },
        },
        crm: { enabled: true, endpoint: 'http://127.0.0.1:1/crm', retries: 0, timeoutMs: 1000 },
        ...extra,
      });
      cfg._root = root;
      cfg.outDir = outDir;
      return cfg;
    };
    const damageLedger = (outDir) => {
      const file = path.join(outDir, 'channels', 'crm', 'ledger.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, ledgerBody);
      return file;
    };
    const assertIsolated = (summary, ledgerFile, label) => {
      eq(summary.crm?.ok, false, `${label} CRM ok`);
      eq(summary.crm?.channelFailure, true, `${label} channelFailure`);
      eq(summary.crm?.attempted, false, `${label} network attempted`);
      eq(summary.crm?.deliveryState, 'NOT_ATTEMPTED', `${label} delivery state`);
      eq(summary.crm?.errorCode, 'CRM_LEDGER_CORRUPT', `${label} error code`);
      eq(fs.readFileSync(ledgerFile, 'utf8'), ledgerBody, `${label} damaged ledger preserved`);
      const latest = JSON.parse(fs.readFileSync(summary.reportFiles.latest, 'utf8'));
      eq(latest.crm?.channelFailure, true, `${label} final report CRM status`);
      ok(Array.isArray(latest.results) && latest.results.length > 0, `${label} business results retained`);
    };
    const safeProbe = { result: {
      probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
      liveDocument: true, traversalComplete: true,
    } };
    const originalFetch = globalThis.fetch;
    let networkRequests = 0;
    let returnSuccessfulResponse = false;
    globalThis.fetch = async () => {
      networkRequests++;
      if (returnSuccessfulResponse) {
        return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); } };
      }
      throw new Error('CRM fetch must not run with a damaged ledger');
    };
    try {
      const genericRoot = path.join(tmp, 'crm-isolation-generic');
      const genericOut = path.join(genericRoot, 'out');
      const genericConfig = makeConfig(genericRoot, genericOut);
      const genericLedger = damageLedger(genericOut);
      const genericUrl = 'https://sellercentral.amazon.com/target';
      const generic = await runGenericCheck({
        zn: {
          async storeOpen() { return { storeId: 'crm-generic' }; },
          async visit() { return { url: genericUrl }; },
          async currentUrl() { return genericUrl; },
          async execExtract(_storeId, script) {
            if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return safeProbe;
            return { result: { landed: true, clear: true } };
          },
          async content() { return { text: 'Target page clear' }; },
          async storeClose() {},
        },
        config: genericConfig,
        stores: [{ key: 'S-CRM-GENERIC', id: 'S-CRM-GENERIC', host: 'sellercentral.amazon.com' }],
        logger: quiet,
        def: {
          id: 'crm-isolation-generic', no: 99, title: 'CRM isolation generic',
          requirement: 'business report survives channel failure', paths: ['/target'], settleMs: 0,
          extractor: 'return {landed:true,clear:true};',
          parseText: () => ({ landed: true, clear: true }),
          judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: { count: 1 } }),
        },
        opts: { slot: 'selftest' },
      });
      eq(generic.results[0].status, 'CLEAR', 'generic business result');
      assertIsolated(generic, genericLedger, 'generic');

      const storeRoot = path.join(tmp, 'crm-isolation-store');
      const storeOut = path.join(storeRoot, 'out');
      const storeConfig = makeConfig(storeRoot, storeOut);
      const storeLedger = damageLedger(storeOut);
      const storeUrl = 'https://sellercentral.amazon.com/performance/dashboard';
      const storeSummary = await runStoreHealth({
        zn: {
          async storeOpen() { return { storeId: 'crm-store' }; },
          async visit() { return { url: storeUrl }; },
          async currentUrl() { return storeUrl; },
          async execExtract(_storeId, script) {
            if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return safeProbe;
            return { result: {
              landed: true, hasPolicyComplianceText: true, status: 'HEALTHY', statusRaw: 'Healthy',
              score: 300, cardFound: true, cardText: 'Policy Compliance Healthy Account Health Rating 300',
            } };
          },
          async content() { return { text: 'Policy Compliance Healthy Account Health Rating 300' }; },
          async storeClose() {},
        },
        config: storeConfig,
        stores: [{ key: 'S-CRM-STORE', id: 'S-CRM-STORE', market: 'US', host: 'sellercentral.amazon.com' }],
        logger: quiet, opts: { slot: 'selftest' },
      });
      eq(storeSummary.results[0].status, 'HEALTHY', 'store-health business result');
      assertIsolated(storeSummary, storeLedger, 'store-health');

      const asinRoot = path.join(tmp, 'crm-isolation-asin');
      const asinOut = path.join(asinRoot, 'out');
      fs.mkdirSync(path.join(asinRoot, 'config'), { recursive: true });
      fs.writeFileSync(path.join(asinRoot, 'config', 'asins.json'), JSON.stringify({
        asins: [{ asin: 'B012345678', storeKey: 'S-CRM-ASIN', market: 'US' }],
      }));
      const asinConfig = makeConfig(asinRoot, asinOut);
      const asinLedger = damageLedger(asinOut);
      const asinUrlValue = 'https://www.amazon.com/dp/B012345678';
      const asinSummary = await runAsinHealth({
        zn: {
          async storeOpen() { return { storeId: 'crm-asin' }; },
          async visit() { return { url: asinUrlValue }; },
          async currentUrl() { return asinUrlValue; },
          async execExtract(_storeId, script) {
            if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return safeProbe;
            return { result: {
              asin: 'B012345678', landed: true, pageNotFound: false, unavailable: false, hasCart: true,
              rating: 4.5, reviewCount: 20,
            } };
          },
          async content() { return { text: 'Product details Add to Cart 4.5 out of 5 stars 20 ratings' }; },
          async storeClose() {},
        },
        config: asinConfig,
        stores: [{ key: 'S-CRM-ASIN', id: 'S-CRM-ASIN', name: 'S-CRM-ASIN', market: 'US' }],
        logger: quiet, opts: { slot: 'selftest' },
      });
      eq(asinSummary.results[0].status, 'OK', 'ASIN business result');
      assertIsolated(asinSummary, asinLedger, 'asin-health');
      eq(networkRequests, 0, 'CRM network request count');

      const auditRoot = path.join(tmp, 'crm-isolation-audit-io');
      const auditOut = path.join(auditRoot, 'out');
      const auditConfig = makeConfig(auditRoot, auditOut);
      const auditCollision = path.join(auditOut, 'channels', 'crm', `${bjDateKey()}.jsonl`);
      fs.mkdirSync(auditCollision, { recursive: true });
      returnSuccessfulResponse = true;
      const auditSummary = await runGenericCheck({
        zn: {
          async storeOpen() { return { storeId: 'crm-audit-io' }; },
          async visit() { return { url: genericUrl }; },
          async currentUrl() { return genericUrl; },
          async execExtract(_storeId, script) {
            if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return safeProbe;
            return { result: { landed: true, clear: true } };
          },
          async content() { return { text: 'Target page clear' }; },
          async storeClose() {},
        },
        config: auditConfig,
        stores: [{ key: 'S-CRM-AUDIT', id: 'S-CRM-AUDIT', host: 'sellercentral.amazon.com' }],
        logger: quiet,
        def: {
          id: 'crm-isolation-audit', no: 99, title: 'CRM audit isolation',
          requirement: 'business report survives audit I/O failure', paths: ['/target'], settleMs: 0,
          extractor: 'return {landed:true,clear:true};',
          parseText: () => ({ landed: true, clear: true }),
          judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: { count: 1 } }),
        },
        opts: { slot: 'selftest' },
      });
      eq(auditSummary.results[0].status, 'CLEAR', 'audit I/O business result');
      eq(auditSummary.crm?.channelFailure, true, 'audit I/O channel failure');
      eq(auditSummary.crm?.attempted, true, 'audit I/O network attempted');
      eq(auditSummary.crm?.deliveryState, 'UNKNOWN', 'audit I/O delivery state');
      eq(auditSummary.crm?.errorCode, 'CRM_CHANNEL_IO_ERROR', 'audit I/O error code');
      ok(fs.statSync(auditCollision).isDirectory(), 'audit collision must not be replaced');
      const auditLatest = JSON.parse(fs.readFileSync(auditSummary.reportFiles.latest, 'utf8'));
      eq(auditLatest.crm?.channelFailure, true, 'audit I/O final report CRM status');
      eq(networkRequests, 1, 'audit I/O network request count');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  check('运行锁阻止重叠任务并以 0600 原子发布进度', () => {
    const outDir = path.join(tmp, 'runtime-lock');
    const first = acquireRunLock({ outDir, label: 'selftest:first' });
    let blocked = false;
    try { acquireRunLock({ outDir, label: 'selftest:second' }); } catch (e) { blocked = e.code === 'RUN_ALREADY_ACTIVE'; }
    ok(blocked, 'second run must be blocked');
    writeRunProgress(first, { state: 'RUNNING', currentCheck: 'reviews' });
    eq(fs.statSync(first.progressFile).mode & 0o777, 0o600, 'progress mode');
    releaseRunLock(first);
    const second = acquireRunLock({ outDir, label: 'selftest:after-release' });
    releaseRunLock(second);
  });

  await checkAsync('批次顶层单项崩溃会记录 errors 与失败进度，不会 false success', async () => {
    const outDir = path.join(tmp, 'slot-fatal');
    fs.mkdirSync(path.join(outDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'state', 'performance.json'), '{broken');
    const cfg = deepMerge(config, { outDir, paths: { outDir } });
    cfg.outDir = outDir;
    const out = await runSlot({
      slot: 'selftest-fatal', zn: {}, config: cfg,
      stores: [{ key: 'S1', id: 'S1', host: 'sellercentral.amazon.com' }], logger: quiet,
      opts: { only: ['performance'] },
    });
    ok(out.errors.performance, 'top-level check error must be retained');
    const progress = JSON.parse(fs.readFileSync(path.join(outDir, 'runtime', 'run-progress.json'), 'utf8'));
    eq(progress.state, 'COMPLETED_WITH_ERRORS', 'progress state');
    ok(!fs.existsSync(path.join(outDir, 'runtime', 'run.lock')), 'lock released after failure');
  });

  await checkAsync('storeOpen 已落地业务页时不重复导航，避免紫鸟 profile 被二次加载击穿', async () => {
    const liveSafe = {
      result: {
        probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
        liveDocument: true, traversalComplete: true,
      },
    };
    const common = {
      ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
      storeHealth: { screenshot: false, saveRawPageText: false },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    };

    const genericOut = path.join(tmp, 'reuse-opened-generic');
    const genericConfig = deepMerge(config, {
      ...common, outDir: genericOut, paths: { outDir: genericOut },
    });
    let genericVisits = 0;
    const genericUrl = 'https://sellercentral.amazon.com/reuse-target';
    const genericZn = {
      async storeOpen() { return { storeId: 'reuse-generic' }; },
      async currentUrl() { return genericUrl; },
      async visit() { genericVisits++; return { url: genericUrl }; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return liveSafe;
        return { result: { landed: true, clear: true } };
      },
      async content() { return { text: 'reuse target clear' }; },
      async storeClose() {},
    };
    const generic = await runGenericCheck({
      zn: genericZn, config: genericConfig,
      stores: [{ key: 'REUSE', id: 'REUSE', host: 'sellercentral.amazon.com' }],
      logger: quiet,
      def: {
        id: 'reuse-opened', no: 99, title: 'reuse opened', requirement: 'no duplicate visit',
        paths: ['/reuse-target'], settleMs: 0, extractor: 'return {landed:true,clear:true};',
        parseText: () => ({ landed: true, clear: true }),
        judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }),
      },
      opts: { slot: 'selftest' },
    });
    eq(generic.results[0].status, 'CLEAR', 'generic verdict');
    eq(genericVisits, 0, 'generic must reuse storeOpen landing page');

    const healthOut = path.join(tmp, 'reuse-opened-health');
    const healthConfig = deepMerge(config, {
      ...common, outDir: healthOut, paths: { outDir: healthOut },
      storeHealth: {
        ...common.storeHealth,
        paths: ['/performance/dashboard'], defaultHost: 'sellercentral.amazon.com',
      },
    });
    let healthVisits = 0;
    const healthUrl = 'https://sellercentral.amazon.com/performance/dashboard';
    const healthZn = {
      async storeOpen() { return { storeId: 'reuse-health' }; },
      async currentUrl() { return healthUrl; },
      async visit() { healthVisits++; return { url: healthUrl }; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return liveSafe;
        return { result: {
          landed: true, hasPolicyComplianceText: true, cardFound: true,
          status: 'HEALTHY', statusRaw: 'Healthy', cardText: 'Policy Compliance Healthy',
        } };
      },
      async content() { return { text: 'Account Health Policy Compliance Healthy' }; },
      async storeClose() {},
    };
    const health = await runStoreHealth({
      zn: healthZn, config: healthConfig,
      stores: [{ key: 'REUSE', id: 'REUSE', market: 'US', host: 'sellercentral.amazon.com' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(health.results[0].status, 'HEALTHY', 'store health verdict');
    eq(healthVisits, 0, 'store health must reuse storeOpen landing page');
  });

  await checkAsync('Amazon Ads 先经 Seller Central 恢复店铺会话，再进入广告备选地址', async () => {
    const outDir = path.join(tmp, 'ads-seller-bootstrap');
    const cfg = deepMerge(config, {
      outDir, paths: { outDir },
      ziniao: { settleMs: 0, retries: 0, closeStoreAfterCheck: true },
      storeHealth: { screenshot: false, saveRawPageText: false },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    let current = '';
    let openedAt = '';
    const target = 'https://advertising.amazon.com/cm/campaigns';
    const zn = {
      async storeOpen(opts) { openedAt = opts.url; current = opts.url; return { storeId: 'ads-bootstrap' }; },
      async currentUrl() { return current; },
      async visit(_storeId, url) { current = url; return { url }; },
      async selectAdvertisingAccount() {},
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return { result: {
          probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
          liveDocument: true, traversalComplete: true,
        } };
        return { result: { landed: true, clear: true } };
      },
      async content() { return { text: 'campaign table clear' }; },
      async storeClose() {},
    };
    const summary = await runGenericCheck({
      zn, config: cfg,
      stores: [{ key: 'ADS-BOOT', id: 'ADS-BOOT', host: 'sellercentral.amazon.com' }],
      logger: quiet,
      def: {
        id: 'ads-bootstrap-test', no: 99, title: 'ads bootstrap', requirement: 'seller first',
        paths: [target], bootstrapPath: '/home', advertisingAccountSwitch: true,
        settleMs: 0, extractor: 'return {landed:true,clear:true};',
        parseText: () => ({ landed: true, clear: true }),
        judge: () => ({ status: 'CLEAR', ok: true, severity: 'OK', reasons: [], metrics: {} }),
      },
      opts: { slot: 'selftest' },
    });
    eq(summary.results[0].status, 'CLEAR', 'ads bootstrap verdict');
    eq(openedAt, 'https://sellercentral.amazon.com/home', 'Seller Central bootstrap URL');
  });

  process.stdout.write('\n[11] 官方 WebDriver HTTP + Selenium 传输层（纯本地 mock）\n');

  await checkAsync('WebDriver 按 updateCore → getBrowserList → startBrowser → stopBrowser 调用', async () => {
    const actions = [];
    const requestBodies = [];
    let driverOptions = null;
    let updateCoreCalls = 0;
    let quitCalled = false;
    const visitedUrls = [];
    const lifecycle = [];
    const fakeDriver = {
      manage: () => ({ setTimeouts: async () => {} }),
      get: async (url) => { visitedUrls.push(url); },
      getCurrentUrl: async () => 'https://sellercentral.amazon.com/performance/dashboard',
      executeScript: async (script) => {
        if (String(script).includes('document.body')) return 'Account Health Policy Compliance Healthy';
        return `${RESULT_MARKER}${JSON.stringify({ landed: true, status: 'HEALTHY' })}`;
      },
      takeScreenshot: async () => Buffer.from('png').toString('base64'),
      quit: async () => { quitCalled = true; lifecycle.push('driver.quit'); },
    };
    const fetchImpl = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      actions.push(body.action);
      requestBodies.push(body);
      let payload;
      if (body.action === 'getRunningInfo') payload = { statusCode: 0, browsers: [] };
      else if (body.action === 'updateCore') {
        updateCoreCalls++;
        payload = { statusCode: updateCoreCalls === 1 ? -10000 : 0, msg: 'mock core progress' };
      }
      else if (body.action === 'getBrowserList') payload = {
        statusCode: 0,
        browserList: [{ browserId: '123', browserOauth: 'enc-123', browserName: 'US-01', platform_name: 'Amazon' }],
      };
      else if (body.action === 'startBrowser') payload = {
        statusCode: 0, debuggingPort: 9222, core_version: '138.0.0.0',
        launcherPage: 'https://sellercentral.amazon.com/home',
      };
      else if (body.action === 'stopBrowser') { lifecycle.push('stopBrowser'); payload = { statusCode: 0 }; }
      else payload = { statusCode: -10000, err: 'unexpected action' };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
    const znWd = new ZiniaoWebDriver({
      config: {
        // Keep this mock platform-neutral: a macOS-only absolute path makes the
        // offline self-test fail on a correctly configured Linux collector.
        clientPath: 'ziniao-test-client', socketPort: 18888, autoStart: false,
        company: 'mock-company', username: 'mock-user', password: 'mock-password',
      },
      logger: quiet,
      fetchImpl,
      driverFactory: async (options) => { driverOptions = options; return fakeDriver; },
      sleepImpl: async () => {},
    });
    const list = await znWd.storeList();
    eq(list[0].name, 'US-01', 'store name');
    const opened = await znWd.storeOpen({
      id: '123', privacy: false, headless: true,
      url: 'https://sellercentral.amazon.com/performance/dashboard',
    });
    eq(opened.storeId, 'enc-123', 'storeId');
    const extracted = await znWd.execExtract(opened.storeId, 'return {landed:true};');
    eq(extracted.via, 'webdriver-return', 'extract transport');
    await znWd.storeClose(opened.storeId);
    ok(quitCalled, '应清理 chromedriver 会话');
    ok(actions.indexOf('updateCore') < actions.indexOf('getBrowserList'), `调用顺序错误: ${actions.join(' -> ')}`);
    eq(updateCoreCalls, 2, 'updateCore 处理中应继续轮询');
    ok(actions.includes('startBrowser') && actions.includes('stopBrowser'), `缺少启动/关闭: ${actions.join(' -> ')}`);
    const start = requestBodies.find((b) => b.action === 'startBrowser');
    eq(start.browserOauth, 'enc-123', '默认使用 getBrowserList 返回的 browserOauth');
    eq(start.privacyMode, false, 'V6 必须显式加载已有 cookies');
    eq(start.isHeadless, false, '启用 Passkey 自动登录时必须在后台 X 显示中保留原生窗口');
    eq(start.cookieTypeLoad, 0, 'cookieTypeLoad');
    eq(start.isLoadUserPlugin, false, '真机探测默认不加载用户插件');
    eq(visitedUrls.join(' -> '), 'https://sellercentral.amazon.com/home -> https://sellercentral.amazon.com/performance/dashboard', '先启动页再业务页');
    eq(lifecycle.join(' -> '), 'driver.quit -> stopBrowser', '先释放驱动再由紫鸟关闭并提交 cookies');
    eq(driverOptions.coreVersion, '138.0.0.0', '将内核版本交给驱动匹配层');
    eq(driverOptions.pageLoadStrategy, 'none', '由显式就绪和双路证据闸判断完成，不等待后台资源');
    const doctor = await znWd.doctor();
    ok(doctor.ok, 'doctor 应验证 WebDriver 授权接口，而不只是端口');
  });

  process.stdout.write('\n[12] 正式运行配置守护\n');

  check('凭据优先取环境变量，缺失时可从 macOS Keychain 恢复', () => {
    const env = loadZiniaoCredentials({
      env: { ZINIAO_COMPANY: 'c', ZINIAO_USERNAME: 'u', ZINIAO_PASSWORD: 'p' },
      platform: 'darwin',
      exec: () => { throw new Error('环境完整时不应访问 Keychain'); },
    });
    eq(env.source, 'environment', 'environment source');
    ok(env.complete, '环境凭据应完整');
    const keychain = loadZiniaoCredentials({
      env: {}, platform: 'darwin',
      exec: () => JSON.stringify({ company: 'c', username: 'u', password: 'p' }),
    });
    eq(keychain.source, 'macOS Keychain', 'keychain source');
    ok(keychain.complete, 'Keychain 凭据应完整');
    const hex = loadZiniaoCredentials({
      env: {}, platform: 'darwin',
      exec: () => Buffer.from(JSON.stringify({ company: '公司', username: 'u', password: 'p' })).toString('hex'),
    });
    ok(hex.complete, '含中文的 Keychain JSON 十六进制输出必须可恢复');
  });

  check('ASIN 正式清单忽略示例值并按店铺合并 VOC 历史', () => {
    const root = path.join(tmp, 'asin-production');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'voc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({
      asins: [
        { asin: 'B0EXAMPLE1', storeKey: 'S1', label: '示例' },
        { asin: 'B012345678', storeKey: 'S1', label: '手工真实' },
      ],
    }));
    fs.writeFileSync(path.join(outDir, 'voc', 'full.json'), JSON.stringify({
      runId: 'full', finishedAt: '2026-08-26T08:00:00+08:00',
      results: [
        { storeKey: 'S2', market: 'US', items: [{ asin: 'B087654321' }] },
        { storeKey: 'S3', market: 'US', items: [{ asin: 'B076543210' }] },
      ],
    }));
    const successfulS2Asins = Array.from({ length: 25 }, (_unused, index) => ({
      asin: `B0${String(index).padStart(8, '0')}`,
    }));
    fs.writeFileSync(path.join(outDir, 'voc', 'latest.json'), JSON.stringify({
      runId: 'partial', finishedAt: '2026-08-26T09:00:00+08:00',
      results: [{
        storeKey: 'S2', market: 'US', status: 'REGISTERED', severity: 'OK',
        metrics: { asinCount: 25, headerMappingIncomplete: false }, items: successfulS2Asins,
      }],
    }));
    fs.writeFileSync(path.join(outDir, 'voc', 'incomplete.json'), JSON.stringify({
      runId: 'incomplete', finishedAt: '2026-08-26T09:30:00+08:00',
      results: [{
        storeKey: 'S2', market: 'US', status: 'PARTIAL_EVIDENCE', severity: 'ERROR',
        metrics: { asinCount: 1, headerMappingIncomplete: true },
        items: [{ asin: 'B099999999' }],
      }],
    }));
    fs.writeFileSync(path.join(outDir, 'voc', 'failed.json'), JSON.stringify({
      runId: 'failed', finishedAt: '2026-08-26T10:00:00+08:00',
      results: [{ storeKey: 'S2', market: 'US', status: 'LOGIN_REQUIRED', severity: 'ERROR', items: [] }],
    }));
    const loaded = loadAsins({ _root: root, outDir, asinHealth: { autoDiscoverFromVoc: true } });
    eq(loaded.placeholderCount, 1, 'placeholder count');
    eq(loaded.configuredCount, 1, 'configured count');
    eq(loaded.discoveredCount, 26, '25 S2 ASINs plus the preserved S3 snapshot');
    eq(loaded.asins.length, 27, '26 discovered plus one configured ASIN');
    ok(loaded.asins.some((a) => a.storeKey === 'S3' && a.asin === 'B076543210'), 'older S3 snapshot must survive S2-only rerun');
    ok(!loaded.asins.some((a) => a.asin === 'B087654321'), 'newer S2 snapshot must replace older S2 snapshot');
    eq(loaded.asins.filter((a) => a.storeKey === 'S2').length, 25,
      'partial header mapping and later LOGIN_REQUIRED must not erase the prior 25-ASIN inventory');
    ok(!loaded.asins.some((a) => a.asin === 'B099999999'),
      'an incomplete VOC header mapping must not replace the last complete inventory');
    const latestVoc = latestStoreSnapshots({ outDir, checkId: 'voc' });
    eq(latestVoc.get('S2').results[0].status, 'LOGIN_REQUIRED',
      'dashboard latest must remain the failed collection result');
    eq(latestVoc.get('S2').results[0].items.length, 0,
      'inventory fallback must not rewrite dashboard business evidence');
    ok(!loaded.asins.some((a) => a.asin.includes('EXAMPLE')), '示例 ASIN 不得进入正式检查');
  });

  check('ASIN 低频复核和人工停检可覆盖 VOC 自动发现且保留审计状态', () => {
    const root = path.join(tmp, 'asin-monitoring-lifecycle');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'voc'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'asin-health'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({ asins: [
      {
        asin: 'B012345678', storeKey: 'S1', market: 'US', monitoring: 'weekly',
        monitoringReason: '零售页长期空壳，保留周期复核',
      },
      {
        asin: 'B087654321', storeKey: 'S1', market: 'US', monitoring: 'disabled',
        monitoringReason: '运营已确认停检',
      },
    ] }));
    fs.writeFileSync(path.join(outDir, 'voc', 'latest.json'), JSON.stringify({
      runId: 'voc-products', finishedAt: '2026-08-27T08:00:00+08:00', results: [{
        storeKey: 'S1', market: 'US', status: 'REGISTERED', severity: 'OK',
        metrics: { asinCount: 2, headerMappingIncomplete: false },
        items: [{ asin: 'B012345678' }, { asin: 'B087654321' }],
      }],
    }));
    fs.writeFileSync(path.join(outDir, 'asin-health', 'latest.json'), JSON.stringify({
      runId: 'asin-products', finishedAt: '2026-08-27T09:00:00+08:00', results: [{
        storeKey: 'S1', market: 'US', asin: 'B012345678', checkedAt: '2026-08-27T09:00:00+08:00',
        status: 'UNKNOWN', severity: 'ERROR', anomalyReasons: ['页面为空壳'],
      }],
    }));
    const cfg = { _root: root, outDir, asinHealth: { autoDiscoverFromVoc: true, recheckDays: 7 } };
    const today = loadAsins(cfg, { now: new Date('2026-08-27T12:00:00+08:00') });
    eq(today.inventory.length, 2, 'inventory count');
    eq(today.asins.length, 0, 'neither deferred nor disabled is due today');
    eq(today.deferredCount, 1, 'weekly deferred count');
    eq(today.disabledCount, 1, 'disabled count');
    eq(today.deferredAsins[0].lastStatus, 'UNKNOWN', 'last strict status remains visible');
    eq(today.deferredAsins[0].monitoringReason, '零售页长期空壳，保留周期复核', 'audit reason');
    const dashboardSplit = filterCurrentAsinResults([
      { asin: 'B012345678', storeKey: 'S1', market: 'US', severity: 'ERROR' },
      { asin: 'B087654321', storeKey: 'S1', market: 'US', severity: 'CRITICAL' },
      { asin: 'B099999999', storeKey: 'S1', market: 'US', severity: 'OK' },
    ], today, 'S1');
    eq(dashboardSplit.deferred.length, 2, 'deferred and disabled history leaves the current action queue');
    eq(dashboardSplit.current.length, 1, 'active results remain in the current action queue');
    eq(dashboardSplit.current[0].asin, 'B099999999', 'only current asset remains actionable');
    const nextWeek = loadAsins(cfg, { now: new Date('2026-09-04T12:00:00+08:00') });
    eq(nextWeek.asins.length, 1, 'weekly item becomes due after seven days');
    eq(nextWeek.asins[0].asin, 'B012345678', 'only weekly item is due');
    eq(nextWeek.disabledCount, 1, 'disabled item remains excluded');
  });

  check('ASIN 双路确认非激活后自动转为每周复核，不再每日重复访问', () => {
    const root = path.join(tmp, 'asin-auto-inactive-cadence');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'asin-health'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({ asins: [
      { asin: 'B012345678', storeKey: 'S1', market: 'US' },
      { asin: 'B087654321', storeKey: 'S1', market: 'US' },
    ] }));
    fs.writeFileSync(path.join(outDir, 'asin-health', 'latest.json'), JSON.stringify({
      runId: 'inactive-products', finishedAt: '2026-09-04T09:00:00+08:00', results: [
        { storeKey: 'S1', market: 'US', asin: 'B012345678', checkedAt: '2026-09-04T09:00:00+08:00', status: 'INACTIVE_LISTING', severity: 'OK' },
        { storeKey: 'S1', market: 'US', asin: 'B087654321', checkedAt: '2026-09-04T09:00:00+08:00', status: 'OK', severity: 'OK' },
      ],
    }));
    const cfg = { _root: root, outDir, asinHealth: { autoDiscoverFromVoc: false, recheckDays: 7 } };
    const today = loadAsins(cfg, { now: new Date('2026-09-04T12:00:00+08:00') });
    eq(today.asins.length, 1, 'only active product remains due today');
    eq(today.asins[0].asin, 'B087654321', 'active product');
    eq(today.deferredAsins.length, 1, 'inactive product is deferred');
    eq(today.deferredAsins[0].autoDeferredInactive, true, 'automatic inactive marker');
    eq(today.deferredAsins[0].nextCheckAt, '2026-09-11T01:00:00.000Z', 'weekly recheck time');
  });

  check('ASIN 单店补跑不会把其他店商品路由到所选浏览器', () => {
    const groups = groupByStore([
      { asin: 'B012345678', storeKey: 'S1' },
      { asin: 'B087654321', storeKey: 'S2' },
    ], [{ key: 'S2', name: 'S2' }]);
    eq(groups.length, 1, 'group count');
    eq(groups[0].asins.length, 1, 'selected store asin count');
    eq(groups[0].asins[0].storeKey, 'S2', 'selected store key');
  });

  check('ASIN 定向补跑只保留显式目标并拒绝无效标识', () => {
    const inventory = [
      { asin: 'B012345678', storeKey: 'S1' },
      { asin: 'B087654321', storeKey: 'S1' },
    ];
    const selected = selectAsinsForRun(inventory, ['b087654321', 'B087654321', 'B099999999']);
    eq(selected.asins.length, 1, 'targeted count');
    eq(selected.asins[0].asin, 'B087654321', 'targeted ASIN');
    eq(selected.missing.join(','), 'B099999999', 'missing target');
    let rejected = false;
    try { selectAsinsForRun(inventory, ['../bad']); } catch { rejected = true; }
    eq(rejected, true, 'invalid target must fail closed');
    const scoped = scopeAsinsToStores([
      { asin: 'B012345678', storeKey: 'S1', monitoring: 'weekly', due: false },
      { asin: 'B012345678', storeKey: 'S2', monitoring: 'active', due: true },
      { asin: 'B076543210', storeKey: null, monitoring: 'active', due: true },
    ], [{ key: 'S1' }]);
    eq(scoped.length, 2, 'targeted store scope keeps its weekly asset and an explicitly unassigned asset');
    eq(scoped[0].storeKey, 'S1', 'same ASIN in another store must not satisfy the selected store');
  });

  await checkAsync('ASIN 渲染器超时后重启店铺并在队尾重试，不连带后续商品', async () => {
    const root = path.join(tmp, 'asin-recovery');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({ asins: [
      { asin: 'B012345678', storeKey: 'S1' },
      { asin: 'B087654321', storeKey: 'S1' },
    ] }));
    const cfg = deepMerge(DEFAULTS, {
      ziniao: { settleMs: 0, closeStoreAfterCheck: true },
      asinHealth: { autoDiscoverFromVoc: false, settleMs: 0, visitTimeoutMs: 10 },
      storeHealth: { screenshot: false },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    cfg._root = root;
    cfg.outDir = outDir;
    let opens = 0;
    let visits = 0;
    const visitedUrls = [];
    const openedUrls = [];
    let currentProductUrl = 'https://www.amazon.com/dp/B012345678';
    const zn = {
      async storeOpen(opts) {
        opens++;
        openedUrls.push(opts?.url || null);
        return { storeId: `session-${opens}` };
      },
      async storeClose() {},
      async visit(_storeId, url) {
        visits++;
        visitedUrls.push(url);
        if (visits === 1) throw new Error('renderer timeout');
        currentProductUrl = url;
        return { url };
      },
      async currentUrl() { return currentProductUrl; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i.exec(currentProductUrl)?.[1]?.toUpperCase();
        return { result: { asin, landed: true, hasCart: true, rating: 4.5, unavailable: false, titleText: 'ok' } };
      },
      async content() { return { text: 'Product Add to Cart 4.5 out of 5 stars' }; },
    };
    const summary = await runAsinHealth({
      zn, config: cfg, stores: [{ key: 'S1', id: 'S1', name: 'S1', market: 'US' }], logger: quiet,
      opts: { slot: 'selftest' },
    });
    eq(opens, 2, '应在首次超时后重开一次店铺');
    eq(visitedUrls.at(-1), 'https://www.amazon.com/gp/product/B012345678', 'bounded retry uses alternate Amazon product route');
    eq(openedUrls[0], 'https://www.amazon.com/', 'initial startBrowser lands on the corresponding Amazon retail origin');
    eq(openedUrls[1], 'https://www.amazon.com/', 'retry startBrowser re-establishes the corresponding retail origin');
    eq(summary.results.length, 2, '重试不得产生重复结果');
    eq(summary.totals.ok, 2, '失败项重试成功且后续项不受影响');
  });

  await checkAsync('ASIN DOM 脚本超时单次重试，持续超时保留真实原因且身份或认证异常不重试', async () => {
    for (const mode of ['once', 'persistent', 'mismatch', 'auth']) {
      const root = path.join(tmp, `asin-dom-timeout-${mode}`);
      fs.mkdirSync(path.join(root, 'config'), { recursive: true });
      fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({ asins: [
        { asin: 'B012345678', storeKey: 'S1' }, { asin: 'B087654321', storeKey: 'S1' },
      ] }));
      const cfg = deepMerge(DEFAULTS, {
        ziniao: { settleMs: 0, closeStoreAfterCheck: true },
        asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
        storeHealth: { screenshot: true },
        alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
        crm: { enabled: false },
      });
      cfg._root = root;
      cfg.outDir = path.join(root, 'out');
      let current = '', opens = 0, targetReads = 0, shots = 0;
      const visits = [];
      const zn = {
        async storeOpen() { opens++; return { storeId: `session-${opens}` }; },
        async storeClose() {},
        async visit(_id, url) { current = url; visits.push(url); return { url }; },
        async currentUrl() { return current; },
        async execExtract(_id, script) {
          const target = current.includes('B012345678');
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return { result: {
            probeVersion: 1, looksLikeLogin: mode === 'auth' && target && targetReads > 0,
            looksBlocked: false, liveDocument: true, traversalComplete: true,
          } };
          if (target) {
            targetReads++;
            if (mode !== 'mismatch' && (mode !== 'once' || targetReads === 1)) throw new Error('script timeout');
          }
          const asin = target && mode !== 'mismatch' ? 'B012345678' : 'B087654321';
          return { result: { asin, landed: true, hasCart: true, rating: 4.5, unavailable: false, titleText: 'ok' } };
        },
        async content() { return { text: 'Product Add to Cart 4.5 out of 5 stars' }; },
        async screenshot() { shots++; throw new Error('unsafe screenshot must not be attempted'); },
      };
      const summary = await runAsinHealth({ zn, config: cfg, stores: [{ key: 'S1', id: 'S1', market: 'US' }],
        logger: quiet, opts: { slot: 'selftest' } });
      const failed = summary.results.find((r) => r.asin === 'B012345678');
      eq(summary.results.length, 2, 'no duplicate result after retry');
      eq(opens, ['once', 'persistent'].includes(mode) ? 2 : 1, 'one recovery for timeouts only');
      eq(targetReads, ['once', 'persistent'].includes(mode) ? 2 : 1, 'bounded DOM attempts');
      eq(summary.results.find((r) => r.asin === 'B087654321').status, 'OK', 'next ASIN unaffected');
      eq(failed.status, mode === 'once' ? 'OK' : mode === 'auth' ? 'LOGIN_REQUIRED' : 'ERROR', mode);
      eq(shots, 0, 'no screenshots of incomplete or mismatched product evidence');
      if (mode === 'once') {
        eq(failed.verdictSource, 'dom+text', 'retry requires new dual evidence');
        eq(visits.at(-1), 'https://www.amazon.com/gp/product/B012345678', 'retry runs at queue tail');
      } else {
        eq(failed.baselineEligible, false, 'failed read cannot update rating baseline');
        eq(failed.evidence.dom, null, 'failed evidence discarded');
        if (mode === 'persistent') {
          eq(failed.evidence.safety.code, 'ASIN_DOM_EXTRACTION_TIMEOUT', 'timeout is not misreported as wrong ASIN');
          ok(failed.anomalyReasons.some((r) => r.includes('超时')), 'operator sees actual cause');
        }
        if (mode === 'mismatch') eq(failed.evidence.safety.code, 'ASIN_DOM_IDENTITY_MISMATCH', 'real mismatch remains blocked');
      }
    }
  });

  await checkAsync('ASIN 定量轮换释放浏览器内存，失败关闭且不消耗商品重试额度', async () => {
    for (const mode of ['healthy', 'retry-after-rotation', 'open-failure', 'close-failure']) {
      const root = path.join(tmp, `asin-memory-rotation-${mode}`);
      const asins = ['B012345678', 'B087654321', 'B076543210', 'B099999999'];
      fs.mkdirSync(path.join(root, 'config'), { recursive: true });
      fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({
        asins: asins.map(asin => ({ asin, storeKey: 'S1' })),
      }));
      const cfg = deepMerge(DEFAULTS, {
        ziniao: { settleMs: 0, retryDelayMs: 0, closeStoreAfterCheck: true },
        asinHealth: { autoDiscoverFromVoc: false, settleMs: 0, sessionMaxItems: 2 },
        storeHealth: { screenshot: false },
        alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
        crm: { enabled: false },
      });
      cfg._root = root; cfg.outDir = path.join(root, 'out');
      let opens = 0, current = '', currentSession = null, failedOnce = false;
      const visits = [], perSession = new Map(), closed = [];
      const zn = {
        async storeOpen(options) {
          eq(options.id, 'S1', 'rotation retains the authorized store');
          opens++;
          if (mode === 'open-failure' && opens > 1) throw new Error('WebDriver unavailable');
          if (currentSession) throw new Error('previous browser was not released');
          currentSession = `rotation-${opens}`;
          return { storeId: currentSession };
        },
        async storeClose(id) {
          closed.push(id);
          if (mode === 'close-failure') throw new Error('stopBrowser unavailable');
          eq(id, currentSession, 'only close the active profile');
          currentSession = null;
        },
        async visit(id, url) {
          eq(id, currentSession, 'never navigate a released session');
          const n = (perSession.get(id) || 0) + 1;
          perSession.set(id, n); ok(n <= 2, 'bounded page visits prevent unbounded renderer retention');
          current = url; visits.push(url);
          if (mode === 'retry-after-rotation' && url.includes(asins[2]) && !failedOnce) {
            failedOnce = true; throw new Error('renderer timeout');
          }
          return { url };
        },
        async currentUrl() { return current; },
        async execExtract(_id, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true,
          } };
          return { result: { asin: current.match(/B0[A-Z0-9]{8}/)[0], landed: true, hasCart: true, rating: 4.5 } };
        },
        async content() { return { text: 'Product Add to Cart 4.5 out of 5 stars' }; },
      };
      const summary = await runAsinHealth({ zn, config: cfg, stores: [{ key: 'S1', id: 'S1', market: 'US' }], logger: quiet, opts: { slot: 'selftest' } });
      eq(summary.results.length, 4, 'each product is preserved exactly once');
      eq(new Set(summary.results.map(r => r.asin)).size, 4, 'no duplicate final records');
      if (mode.endsWith('failure')) {
        eq(visits.length, 2, 'release/open failure blocks all later navigations');
        eq(opens, mode === 'open-failure' ? 3 : 1, 'bounded opens, never reopen after failed release');
        ok(summary.results.slice(0, 2).every(r => r.status === 'OK'), 'completed products remain valid');
        ok(summary.results.slice(2).every(r => r.severity === 'ERROR' && r.evidence.safety.code === 'STORE_SESSION_RECOVERY_FAILED'), 'unread products never become normal');
      } else {
        eq(opens, mode === 'healthy' ? 2 : 3, 'rotation and one independent error recovery');
        ok(summary.results.every(r => r.status === 'OK'), 'all details have actual dual evidence');
        eq(visits.length, mode === 'healthy' ? 4 : 5, 'rotation does not duplicate product reads');
        eq(closed.length, opens, 'every native session is closed');
      }
    }
  });

  await checkAsync('ASIN 队尾重试耗尽后不再重建店铺会话', async () => {
    const root = path.join(tmp, 'asin-retry-budget');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({
      asins: [{ asin: 'B012345678', storeKey: 'S1' }],
    }));
    const cfg = deepMerge(DEFAULTS, {
      ziniao: { settleMs: 0, closeStoreAfterCheck: true },
      asinHealth: { autoDiscoverFromVoc: false, settleMs: 0, visitTimeoutMs: 10 },
      storeHealth: { screenshot: false },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    cfg._root = root;
    cfg.outDir = outDir;
    let opens = 0;
    let closes = 0;
    const zn = {
      async storeOpen() { opens++; return { storeId: `budget-${opens}` }; },
      async storeClose() { closes++; },
      async visit() { throw new Error('renderer timeout'); },
    };
    const summary = await runAsinHealth({
      zn, config: cfg, stores: [{ key: 'S1', id: 'S1', name: 'S1', market: 'US' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(opens, 2, 'one initial session plus one bounded recovery session');
    eq(summary.results.length, 1, 'failed ASIN appears exactly once');
    eq(summary.results[0].status, 'ERROR', 'exhausted retry stays a collection error');
    ok(closes >= 2, 'recovery and final cleanup both close the exact store session');
  });

  await checkAsync('ASIN 缺评分只重采一次，重开失败有店铺级预算且不再导航失效会话', async () => {
    for (const mode of ['rating-once', 'rating-persistent', 'reopen-once', 'reopen-persistent']) {
      const root = path.join(tmp, `asin-session-recovery-${mode}`);
      fs.mkdirSync(path.join(root, 'config'), { recursive: true });
      fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({ asins: [
        { asin: 'B012345678', storeKey: 'S1' }, { asin: 'B087654321', storeKey: 'S1' },
      ] }));
      const cfg = deepMerge(DEFAULTS, {
        ziniao: { settleMs: 0, retryDelayMs: 0, closeStoreAfterCheck: true },
        asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
        storeHealth: { screenshot: false },
        alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
        crm: { enabled: false },
      });
      cfg._root = root; cfg.outDir = path.join(root, 'out');
      let opens = 0, visits = 0, current = '';
      const rating = () => current.includes('B012345678') && mode.startsWith('rating')
        && (opens === 1 || mode === 'rating-persistent') ? null : 4.5;
      const zn = {
        async storeOpen() {
          opens++;
          if (mode.startsWith('reopen') && (opens === 2 || mode === 'reopen-persistent' && opens > 1)) throw new Error('WebDriver HTTP timeout');
          return { storeId: `S1-${opens}` };
        },
        async storeClose() {},
        async visit(_id, url) {
          visits++; current = url;
          if (mode.startsWith('reopen') && opens === 1) throw new Error('renderer timeout');
          return { url };
        },
        async currentUrl() { return current; },
        async execExtract(_id, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true,
          } };
          return { result: { asin: current.includes('B012345678') ? 'B012345678' : 'B087654321', landed: true, hasCart: true, rating: rating() } };
        },
        async content() { return { text: 'Product Add to Cart' + (rating() === null ? '' : ' 4.5 out of 5 stars') }; },
      };
      const summary = await runAsinHealth({ zn, config: cfg, stores: [{ key: 'S1', id: 'S1', market: 'US' }], logger: quiet, opts: { slot: 'selftest' } });
      eq(summary.results.length, 2, 'no missing or duplicated ASIN');
      eq(opens, mode.startsWith('reopen') ? 3 : 2, 'bounded fresh-session attempts');
      if (mode === 'reopen-persistent') {
        eq(visits, 1, 'remaining ASINs never touch the lost session');
        eq(summary.results[1].evidence.safety.code, 'STORE_SESSION_RECOVERY_FAILED', 'preserve the infrastructure cause');
        ok(summary.results.every(r => r.severity === 'ERROR' && r.baselineEligible === false), 'no synthetic healthy results');
      } else {
        eq(visits, 3, 'one queue-tail retry, other ASIN still checked');
        eq(summary.results.find(r => r.asin === 'B087654321').status, 'OK', 'remaining product stays independent');
        const target = summary.results.find(r => r.asin === 'B012345678');
        eq(target.status, mode === 'rating-persistent' ? 'UNKNOWN_RATING' : 'OK', 'retry verdict');
        if (mode === 'rating-persistent') eq(target.baselineEligible, false, 'persistent missing rating remains an error');
      }
    }
  });

  await checkAsync('ASIN 图片式 404 全流程保留双路结论，缺文字和认证变化仍失败关闭', async () => {
    for (const mode of ['confirmed', 'no-text', 'auth-after-text']) {
      const root = path.join(tmp, `asin-image-error-${mode}`);
      fs.mkdirSync(path.join(root, 'config'), { recursive: true });
      fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({ asins: [{ asin: 'B0H4ZGYZM3', storeKey: 'S1' }] }));
      const cfg = deepMerge(DEFAULTS, {
        ziniao: { settleMs: 0, closeStoreAfterCheck: true },
        asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
        storeHealth: { screenshot: false },
        alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
        crm: { enabled: false },
      });
      cfg._root = root;
      cfg.outDir = path.join(root, 'out');
      let imageReads = 0;
      const zn = {
        async storeOpen() { return { storeId: 'image-error-store' }; },
        async storeClose() {},
        async visit(_id, url) { return { url }; },
        async currentUrl() { return 'https://www.amazon.com/dp/B0H4ZGYZM3'; },
        async execExtract(_id, script) {
          if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return { result: {
            probeVersion: 1, looksLikeLogin: mode === 'auth-after-text' && imageReads > 0,
            looksBlocked: false, liveDocument: true, traversalComplete: true,
          } };
          if (script === ASIN_IMAGE_ERROR_TEXT_EXTRACTOR) {
            imageReads++;
            return { result: { text: mode === 'no-text' ? '' : "Sorry! We couldn't find that page." } };
          }
          return { result: { asin: 'B0H4ZGYZM3', title: 'Page Not Found', dogPage: true, landed: false, hasCart: false, rating: null } };
        },
        async content() { return { text: '' }; },
      };
      const summary = await runAsinHealth({ zn, config: cfg, stores: [{ key: 'S1', id: 'S1', market: 'US' }], logger: quiet, opts: { slot: 'selftest' } });
      const result = summary.results[0];
      eq(imageReads, 1, 'one independent image-wording read');
      eq(result.status, mode === 'confirmed' ? 'INACTIVE_LISTING' : mode === 'no-text' ? 'PARTIAL_EVIDENCE' : 'LOGIN_REQUIRED', mode);
      eq(result.baselineEligible, false, 'no product rating baseline from a missing page');
      eq(result.severity, mode === 'confirmed' ? 'OK' : 'ERROR', 'only dual confirmed negative is complete');
      if (mode === 'confirmed') {
        eq(result.verdictSource, 'dom+text', 'negative verdict retains both paths');
        eq(result.metrics.collectionStatus, 'COMPLETE', 'negative evidence is complete');
        eq(result.evidence.text.notFound, true, 'literal image wording reaches the independent parser');
      }
      if (mode === 'auth-after-text') {
        eq(result.evidence.dom, null, 'authentication transition discards DOM');
        eq(result.evidence.text, null, 'authentication transition discards image text');
      }
    }
  });

  await checkAsync('ASIN 空壳页抑制 DOM/文本证据与截图', async () => {
    const root = path.join(tmp, 'asin-empty-shell');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'asins.json'), JSON.stringify({
      asins: [{ asin: 'B012345678', storeKey: 'S1' }],
    }));
    const cfg = deepMerge(DEFAULTS, {
      ziniao: { settleMs: 0, closeStoreAfterCheck: true },
      asinHealth: { autoDiscoverFromVoc: false, settleMs: 0 },
      storeHealth: { screenshot: true },
      alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: false },
    });
    cfg._root = root;
    cfg.outDir = outDir;
    let screenshots = 0;
    let opens = 0;
    let visits = 0;
    const zn = {
      async storeOpen() { opens++; return { storeId: 'INTERNAL-ASIN-ID' }; },
      async visit(_id, url) { visits++; return { url }; },
      async currentUrl() { return 'https://www.amazon.com/dp/B012345678'; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          return { result: {
            probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
            liveDocument: true, traversalComplete: true,
          } };
        }
        return { result: { asin: 'B012345678', landed: false } };
      },
      async content() { return { text: '' }; },
      async screenshot() { screenshots++; return { path: null }; },
      async storeClose() {},
    };
    const s = await runAsinHealth({
      zn, config: cfg, stores: [{ key: 'S1', id: 'INTERNAL-ASIN-ID', name: 'S1', market: 'US' }],
      logger: quiet, opts: { slot: 'selftest' },
    });
    eq(s.results[0].status, 'UNKNOWN', 'status');
    eq(s.results[0].evidence.safety.code, 'EMPTY_OR_UNVERIFIED_SHELL', 'safety code');
    eq(s.results[0].evidence.dom, null, 'DOM evidence suppressed');
    eq(s.results[0].evidence.text, null, 'text evidence suppressed');
    eq(screenshots, 0, 'empty shell must not be screenshotted');
    eq(opens, 2, 'empty shell must reopen the Ziniao browser before bounded retry');
    eq(visits, 2, 'empty shell is retried exactly once after startBrowser retail-origin prewarm');
  });

  check('看板按店铺合并历史，单店补跑不会覆盖其他店铺', () => {
    const outDir = path.join(tmp, 'dashboard-history');
    const dir = path.join(outDir, 'performance', '2026-08-26');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'full.json'), JSON.stringify({
      check: 'performance', runId: 'full', finishedAt: '2026-08-26T08:00:00+08:00',
      results: [
        { storeKey: 'S1', status: 'CLEAR', severity: 'OK' },
        { storeKey: 'S2', status: 'CLEAR', severity: 'OK' },
      ],
    }));
    fs.writeFileSync(path.join(dir, 'partial.json'), JSON.stringify({
      check: 'performance', runId: 'partial', finishedAt: '2026-08-26T09:00:00+08:00',
      results: [{ storeKey: 'S1', status: 'WARNING', severity: 'WARN' }],
    }));
    const snapshots = latestStoreSnapshots({ outDir, checkId: 'performance' });
    eq(snapshots.size, 2, 'store snapshot count');
    eq(snapshots.get('S1').results[0].status, 'WARNING', '补跑店铺应更新');
    eq(snapshots.get('S2').results[0].status, 'CLEAR', '未补跑店铺应保留');
  });

  check('看板按实际采集时间阻止晚结束的旧全店批次覆盖单店补跑', () => {
    const outDir = path.join(tmp, 'dashboard-result-time-history');
    const dir = path.join(outDir, 'performance', '2026-08-26');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'targeted.json'), JSON.stringify({
      check: 'performance', runId: 'targeted',
      startedAt: '2026-08-26T11:00:00+08:00', finishedAt: '2026-08-26T11:05:00+08:00',
      results: [{
        storeKey: 'S1', status: 'RECOVERED', severity: 'OK', checkedAt: '2026-08-26T11:04:00+08:00',
      }],
    }));
    fs.writeFileSync(path.join(dir, 'slow-full.json'), JSON.stringify({
      check: 'performance', runId: 'slow-full',
      startedAt: '2026-08-26T08:00:00+08:00', finishedAt: '2026-08-26T12:00:00+08:00',
      results: [
        { storeKey: 'S1', status: 'STALE_ERROR', severity: 'ERROR', checkedAt: '2026-08-26T08:10:00+08:00' },
        { storeKey: 'S2', status: 'CLEAR', severity: 'OK', checkedAt: '2026-08-26T11:30:00+08:00' },
      ],
    }));
    const snapshots = latestStoreSnapshots({ outDir, checkId: 'performance' });
    eq(snapshots.get('S1').results[0].status, 'RECOVERED', 'later collected targeted result wins');
    eq(snapshots.get('S2').results[0].status, 'CLEAR', 'full report still supplies untouched stores');
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  process.stdout.write(`\n${'─'.repeat(52)}\n`);
  if (failures.length === 0) {
    process.stdout.write(`自检通过：${pass} 项断言全部成功\n`);
    return 0;
  }
  process.stdout.write(`自检失败：${pass} 通过，${failures.length} 失败\n`);
  for (const f of failures) process.stdout.write(`  ✗ ${f.name}: ${f.error}\n`);
  return 1;
}
