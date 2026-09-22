#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.js';
import { createLogger } from './lib/log.js';
import { hasConfiguredDingTalk } from './lib/alert.js';
import { redactText, sanitizeUrl } from './lib/redact.js';
import { bjDateKey, bjHuman, detectSlot } from './lib/time.js';
import { isConfigMissingError } from './lib/ziniao.js';
import { createZiniao } from './lib/ziniao-factory.js';

// Reports, locks, logs and temporary files created by this process must never
// become group/world-readable, even when the host's default umask is lax.
process.umask(0o077);

const USAGE = `亚马逊自动巡检 (紫鸟 WebDriver/Selenium + Codex)

用法:
  node src/cli.js <命令> [选项]

命令:
  run-slot <name>   跑一个批次的全部检查 (am|ads-off|pm|ads-on)
  run-check <id>    跑单个检查项 (store-health|performance|feedback|inbox|reviews|
                    asin-health|outlet|voc|ads-status)
  collection-recovery
                    执行槽次退出后留下的一次只读补采；没有补采请求时立即退出
  checks            列出 9 个检查项与排程时段
  serve             启动看板 + 接收 API（默认 4173 端口）
  store-health      第 1 项：店铺健康状态检查 (Policy Compliance)
  doctor            环境自检：紫鸟 WebDriver/CLI / 配置 / 店铺清单 / Codex
  stores            列出紫鸟里可用的店铺（用于填 config/stores.json）
  probe             真机探测：验证当前传输层与双路提取，用来校准解析
  product-upload-probe
                    只读验证指定店铺的 Seller Central 批量上传页是否就绪
  test-notify       向每条通知路由发送测试消息，验证钉钉 / Webhook / CRM 通道
  help              显示本帮助

store-health 选项:
  --store <key>     只检查指定店铺，可重复
  --asin <ASIN>     仅用于 asin-health：只补跑指定 ASIN，可重复
  --slot <name>     标注批次名（默认按北京时间自动判断 am/pm/adhoc）
  --headless        无头模式打开店铺
  --no-close        检查完不关闭店铺浏览器
  --always-notify   即使全部正常也推送一条通知
  --concurrency <n> 跨店并发数（默认取配置里的 concurrency，通常是 1=步进）
                    注意：只作用于店铺之间，单店内部步骤始终串行
  --self-test       离线自检：不连紫鸟，用内置样本验证解析与全流程
  --config <file>   指定配置文件（默认 config/config.json）
  --stores <file>   指定店铺清单（默认 config/stores.json）
  --log-level <lv>  debug|info|warn|error

probe 选项:
  --store <key>     要探测的店铺（必填）
  --url <url>       覆盖默认的 Account Health 地址
  --no-close        探测完保留浏览器窗口
  --headless        无头模式

退出码:
  0 全部正常   1 存在异常   2 执行失败(环境/配置问题)
`;

function parseArgs(argv) {
  const out = { _: [], store: [], asin: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') out.store.push(argv[++i]);
    else if (a === '--asin') out.asin.push(argv[++i]);
    else if (a === '--slot') out.slot = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--stores') out.stores = argv[++i];
    else if (a === '--log-level') out.logLevel = argv[++i];
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--headless') out.headless = true;
    else if (a === '--no-close') out.noClose = true;
    else if (a === '--always-notify') out.alwaysNotify = true;
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('-')) throw new Error(`未知选项: ${a}`);
    else out._.push(a);
  }
  return out;
}

async function cmdDoctor({ config, stores, storesMissing, storesPath, logger }) {
  logger.plain('');
  logger.plain(`环境自检 · ${bjHuman()} 北京时间`);
  logger.plain('─'.repeat(52));

  const zn = createZiniao({ config, logger });
  let fatal = false;
  const mode = String(config.ziniao.mode || 'webdriver').toLowerCase();

  // 1. selected transport present?
  try {
    const v = await zn.version();
    logger.plain(`✓ 紫鸟传输模式: ${mode} · ${v}`);
  } catch (e) {
    logger.plain(`✗ 紫鸟传输层: ${redactText(e.message)}`);
    fatal = true;
  }

  // 2. WebDriver HTTP or CLI bridge configuration
  if (!fatal) {
    const doc = await zn.doctor();
    for (const line of doc.text.split('\n')) logger.plain(`    ${line}`);
    if (!doc.ok) {
      fatal = true;
    }
    if (mode !== 'webdriver') {
      if (/config not found/i.test(doc.text)) {
        logger.plain('');
        logger.plain('✗ 紫鸟 CLI 尚未初始化 —— 这会让所有 store/page 命令直接失败。');
        logger.plain('    请先执行: ziniao-cli config init');
        fatal = true;
      }
      try {
        const tools = await zn.bridgeTools();
        logger.plain(`✓ ZClaw Bridge 工具数: ${Array.isArray(tools) ? tools.length : '?'}`);
      } catch (e) {
        logger.plain(`✗ ZClaw Bridge: ${redactText(e.message)}（紫鸟浏览器是否已启动？）`);
        fatal = true;
      }
    }
  }

  // 3. config + store list
  logger.plain(config._configFromExample
    ? `⚠ 正在使用 config.example.json（还没创建 ${config._configPath}）`
    : `✓ 配置文件: ${config._configPath}`);
  if (storesMissing) {
    logger.plain(`✗ 店铺清单缺失: ${storesPath}`);
    logger.plain('    执行: cp config/stores.example.json config/stores.json 后填入真实店铺');
    fatal = true;
  } else if (!stores.length) {
    logger.plain(`✗ 店铺清单为空或全部 enabled=false: ${storesPath}`);
    fatal = true;
  } else {
    logger.plain(`✓ 待检查店铺 ${stores.length} 个: ${stores.map((s) => s.key).join(', ')}`);
  }

  const { loadAsins } = await import('./checks/asin-health.js');
  try {
    const asinConfig = loadAsins(config);
    if (asinConfig.missing || !asinConfig.asins.length) {
      logger.plain(`✗ ASIN 清单${asinConfig.missing ? '缺失' : '为空'}: ${asinConfig.file}`);
      logger.plain('    第 5 项需要: cp config/asins.example.json config/asins.json 后填入真实 ASIN');
      fatal = true;
    } else {
      logger.plain(`✓ 第 5 项待检查 ASIN ${asinConfig.asins.length} 个`);
    }
  } catch (e) {
    logger.plain(`✗ ASIN 清单不可用: ${redactText(e.message)}`);
    fatal = true;
  }

  // 4. notification + CRM wiring
  const dt = config.alert.dingtalk;
  logger.plain(hasConfiguredDingTalk(config)
    ? `✓ 钉钉报警已启用${Array.isArray(dt.channels) && dt.channels.length ? `（${dt.channels.filter((channel) => channel.enabled).length} 个路由通道）` : ''}`
    : '⚠ 钉钉报警未启用（异常只会打印并写入本地 alerts 文件）');
  logger.plain(config.crm.enabled && config.crm.endpoint ? `✓ CRM 导入: ${sanitizeUrl(config.crm.endpoint)}` : '⚠ CRM 自动导入未启用（仍会生成 out/ 下的 csv/json 供手动导入）');

  // 5. codex
  if (config.codex.enabled) {
    const { execFile } = await import('node:child_process');
    const v = await new Promise((r) =>
      execFile(config.codex.bin, ['--version'], { timeout: 20000 }, (e, so) => r(e ? null : String(so).trim())),
    );
    logger.plain(v ? `✓ Codex 兜底判定: ${v}` : `⚠ Codex 兜底已启用但找不到 ${config.codex.bin}`);
  } else {
    logger.plain('⚠ Codex 兜底判定已关闭（解析失败时只会报 UNKNOWN 并告警）');
  }

  // 6. schedule
  logger.plain(`✓ 排程时段（北京时间）: ${config.schedule.slots.map((s) => `${s.name}=${s.at}`).join(', ')}`);
  logger.plain(`  当前判定批次: ${detectSlot(config.schedule.slots)}`);
  logger.plain(`✓ 输出目录: ${config.outDir}`);

  logger.plain('─'.repeat(52));
  logger.plain(fatal ? '结论: 尚不能正式运行，请先修复上面标 ✗ 的项。' : '结论: 环境就绪，可以执行 npm run am');
  return fatal ? 2 : 0;
}

async function cmdStores({ config, logger }) {
  const zn = createZiniao({ config, logger });
  let list;
  try {
    list = await zn.storeList({ all: true });
  } catch (e) {
    logger.error(`获取店铺列表失败: ${redactText(e.message)}`);
    if (isConfigMissingError(e)) {
      logger.error(String(config.ziniao.mode).toLowerCase() === 'webdriver'
        ? '请先设置 ZINIAO_COMPANY / ZINIAO_USERNAME / ZINIAO_PASSWORD'
        : '请先执行: ziniao-cli config init');
    }
    return 2;
  }
  if (!list.length) {
    logger.warn('紫鸟返回了空的店铺列表');
    return 1;
  }
  logger.plain('');
  logger.plain(`紫鸟可用店铺 ${list.length} 个：`);
  logger.plain('');
  logger.plain(`${'店铺名称'.padEnd(36)} 平台`);
  logger.plain('─'.repeat(58));
  for (const s of list) {
    logger.plain(`${String(s.name ?? '').padEnd(36)} ${s.platform ?? ''}`);
  }
  logger.plain('');
  logger.plain('请使用上面的店铺名称配置 config/stores.json；紫鸟内部标识不会输出。');
  return 0;
}

async function cmdStoreHealth({ config, stores, storesMissing, storesPath, logger, args }) {
  if (args.selfTest) {
    const { selfTest } = await import('./selftest/index.js');
    return selfTest({ logger });
  }

  if (storesMissing || !stores.length) {
    logger.error(
      storesMissing
        ? `店铺清单不存在: ${storesPath}\n    执行: cp config/stores.example.json config/stores.json 后填入真实店铺`
        : `店铺清单里没有启用的店铺: ${storesPath}`,
    );
    return 2;
  }

  let selected = stores;
  if (args.store.length) {
    const want = new Set(args.store);
    selected = stores.filter((s) => want.has(s.key) || want.has(s.name) || want.has(s.id));
    const missing = [...want].filter(
      (w) => !stores.some((s) => s.key === w || s.name === w || s.id === w),
    );
    if (missing.length) logger.warn(`清单里找不到这些店铺，已忽略: ${missing.join(', ')}`);
    if (!selected.length) {
      logger.error('--store 过滤后没有可检查的店铺');
      return 2;
    }
  }

  if (args.headless) config.ziniao.headless = true;
  if (args.noClose) config.ziniao.closeStoreAfterCheck = false;
  if (Number.isFinite(args.concurrency)) {
    if (args.concurrency < 1) {
      logger.error('--concurrency 必须 >= 1');
      return 2;
    }
    config.ziniao.concurrency = args.concurrency;
  }

  const zn = createZiniao({ config, logger });

  // Fail fast and loudly on the selected transport.
  try {
    await zn.version();
    if (typeof zn.ensureCredentials === 'function') await zn.ensureCredentials();
  } catch (e) {
    logger.error(`紫鸟传输层不可用: ${redactText(e.message)}`);
    return 2;
  }

  let summary;
  try {
    const { runCheckById } = await import('./checks/run.js');
    summary = await runCheckById({
      id: 'store-health', zn, config, stores: selected, logger,
      opts: { slot: args.slot, alwaysNotify: !!args.alwaysNotify },
    });
  } catch (e) {
    logger.error(`检查执行失败: ${redactText(e.stack || e.message)}`);
    return 2;
  }

  const t = summary.totals;
  logger.plain('');
  logger.plain('═'.repeat(52));
  logger.plain(`店铺健康检查完成 · 批次 ${summary.slot} · ${summary.startedAt}`);
  logger.plain(`  执行方式: ${summary.execution.mode === 'concurrent' ? `跨店并发 ${summary.execution.concurrencyLimit}（实测峰值 ${summary.execution.peakActive}）` : '步进'} · 耗时 ${(summary.durationMs / 1000).toFixed(1)}s`);
  logger.plain(`  正常 ${t.healthy} / 异常 ${t.abnormal} / 无法判定 ${t.undetermined}（共 ${t.total}）`);
  logger.plain(`  报表: ${summary.reportFiles.html}`);
  logger.plain(`  CRM CSV: ${summary.reportFiles.csv}`);
  logger.plain('═'.repeat(52));

  // Every store failing to even open is an environment problem, not a finding.
  if (t.total > 0 && t.errors === t.total) return 2;
  return t.abnormal > 0 ? 1 : 0;
}

async function cmdProbe({ config, stores, storesMissing, storesPath, logger, args }) {
  if (storesMissing || !stores.length) {
    logger.error(`店铺清单不可用: ${storesPath}（先 cp config/stores.example.json config/stores.json 并填入店铺）`);
    return 2;
  }
  if (!args.store.length) {
    logger.error('probe 需要指定店铺: node src/cli.js probe --store <key>');
    logger.error(`可选: ${stores.map((s) => s.key).join(', ')}`);
    return 2;
  }
  const store = stores.find((s) => args.store.includes(s.key) || args.store.includes(s.name) || args.store.includes(s.id));
  if (!store) {
    logger.error(`清单里找不到指定店铺；可选安全别名: ${stores.map((s) => s.key).join(', ')}`);
    return 2;
  }

  const mode = String(config.ziniao.mode || 'webdriver').toLowerCase();
  const runProbe = mode === 'webdriver'
    ? (await import('./tools/probe-webdriver.js')).runWebDriverProbe
    : (await import('./tools/probe.js')).runProbe;
  const zn = createZiniao({ config, logger });

  logger.plain('');
  logger.plain(`真机探测: ${store.key}（${mode === 'webdriver' ? '官方 WebDriver HTTP + Selenium' : '旧 CLI/ZClaw'}）`);
  logger.plain('─'.repeat(52));

  let out;
  try {
    out = await runProbe({
      zn, config, store, logger,
      opts: { url: args.url, noClose: !!args.noClose, headless: !!args.headless },
    });
  } catch (e) {
    logger.error(`探测失败: ${redactText(e.stack || e.message)}`);
    return 2;
  }

  const f = out.report.findings;
  logger.plain('');
  logger.plain('─'.repeat(52));
  logger.plain('探测结论:');
  const yn = (v) => (v === true ? '✓' : v === false ? '✗' : '—');
  if (mode === 'webdriver') {
    logger.plain(`  ${yn(f.transportReady)} WebDriver HTTP + Selenium 就绪`);
    logger.plain(`  ${yn(f.navigationOk)} Selenium 页面导航`);
  } else {
    logger.plain(`  ${yn(f.bridgeAlive)} ZClaw Bridge 连通`);
  }
  logger.plain(`  ${yn(f.sessionMapped)} 紫鸟店铺会话已映射（内部标识不输出）`);
  logger.plain(`  ${yn(f.execReturnsValue)} page exec 会回传返回值`);
  if (mode !== 'webdriver') {
    logger.plain(`  ${yn(f.markerViaReturn)} marker 经返回值回收`);
    logger.plain(`  ${yn(f.markerViaWindow)} marker 经 window 回收`);
  }
  logger.plain(`  ${yn(f.extractorOk)} 路径 A：DOM 提取${f.extractorVia ? ` (via ${f.extractorVia})` : ''}`);
  logger.plain(`  ${yn(f.contentHasPolicyCompliance)} 路径 B：页面文本含 Policy Compliance${f.contentTextLength ? ` (${f.contentTextLength} 字符)` : ''}`);
  logger.plain(`  ${yn(f.screenshotWritten)} 截图落盘`);
  if (f.extractorOk && f.extractorResult) {
    const r = f.extractorResult;
    logger.plain('');
    logger.plain(`  提取结果: status=${r.status} score=${r.score} source=${r.statusSource} cardFound=${r.cardFound}`);
  }
  if (out.report.recommendations.length) {
    logger.plain('');
    logger.plain('建议:');
    for (const rec of out.report.recommendations) logger.plain(`  · ${rec}`);
  }
  logger.plain('');
  logger.plain(`完整探测报告: ${out.file}`);
  logger.plain('─'.repeat(52));

  if (mode === 'webdriver' && !f.transportReady) return 2;
  return f.extractorOk || f.contentHasPolicyCompliance ? 0 : 1;
}

async function cmdProductUploadProbe({ config, stores, storesMissing, storesPath, logger, args }) {
  if (storesMissing || !stores.length) {
    logger.error(`店铺清单不可用: ${storesPath}`);
    return 2;
  }
  if (args.store.length !== 1) {
    logger.error('product-upload-probe 必须且只能指定一个店铺: --store <key>');
    return 2;
  }
  const store = stores.find((item) => (
    item.key === args.store[0] || item.name === args.store[0] || item.id === args.store[0]
  ));
  if (!store) {
    logger.error(`清单里找不到指定店铺；可选安全别名: ${stores.map((item) => item.key).join(', ')}`);
    return 2;
  }
  if (String(config.ziniao?.mode || 'webdriver').toLowerCase() !== 'webdriver') {
    logger.error('商品上传页探针只允许紫鸟官方 WebDriver HTTP 模式');
    return 2;
  }

  const zn = createZiniao({ config, logger });
  try {
    await zn.version();
    if (typeof zn.ensureCredentials === 'function') await zn.ensureCredentials();
    const { runProductUploadProbe } = await import('./tools/probe-product-upload.js');
    await runProductUploadProbe({ config, store, logger, zn });
    return 0;
  } catch (error) {
    logger.error(`商品上传页探针执行失败: ${redactText(error?.message || error)}`);
    return 2;
  }
}

async function cmdChecks({ config, logger }) {
  const { CHECKS, CHECK_TOTAL, SLOTS } = await import('./checks/registry.js');
  logger.plain('');
  logger.plain(`${CHECK_TOTAL} 项检查:`);
  for (const c of CHECKS) {
    logger.plain(`  ${String(c.no).padStart(2)}. ${c.title.padEnd(18)} [${c.id}]`);
    logger.plain(`      ${c.requirement}`);
  }
  logger.plain('');
  logger.plain('排程时段（北京时间）:');
  for (const s of SLOTS) {
    logger.plain(`  ${s.at}  ${s.label.padEnd(14)} → ${s.checks.length} 项: ${s.checks.join(', ')}`);
  }
  logger.plain('');
  logger.plain(`输出目录: ${config.outDir}`);
  return 0;
}

async function cmdRun({ config, stores, storesMissing, storesPath, logger, args, mode }) {
  const { runCheckById, runSlot } = await import('./checks/run.js');
  const { getCheck, CHECK_TOTAL, SLOTS } = await import('./checks/registry.js');
  const target = args._[1];

  if (mode === 'slot' && !target) {
    logger.error(`用法: node src/cli.js run-slot <${SLOTS.map((s) => s.name).join('|')}>`);
    return 2;
  }
  if (mode === 'check' && !target) {
    logger.error('用法: node src/cli.js run-check <检查项 id>（用 `node src/cli.js checks` 查看）');
    return 2;
  }
  if (mode === 'slot' && !SLOTS.some((s) => s.name === target)) {
    logger.error(`未知批次 ${target}，可选: ${SLOTS.map((s) => s.name).join(', ')}`);
    return 2;
  }
  if (mode === 'check' && !getCheck(target)) {
    logger.error(`未知检查项 ${target}，用 \`node src/cli.js checks\` 查看可选值`);
    return 2;
  }

  if (storesMissing || !stores.length) {
    logger.error(
      storesMissing
        ? `店铺清单不存在: ${storesPath}\n    执行: cp config/stores.example.json config/stores.json 后填入真实店铺`
        : `店铺清单里没有启用的店铺: ${storesPath}`,
    );
    return 2;
  }

  let selected = stores;
  if (args.store.length) {
    const want = new Set(args.store);
    selected = stores.filter((s) => want.has(s.key) || want.has(s.name) || want.has(s.id));
    if (!selected.length) {
      logger.error('--store 过滤后没有可检查的店铺');
      return 2;
    }
  }

  if (args.headless) config.ziniao.headless = true;
  if (args.noClose) config.ziniao.closeStoreAfterCheck = false;
  if (Number.isFinite(args.concurrency) && args.concurrency >= 1) config.ziniao.concurrency = args.concurrency;

  const zn = createZiniao({ config, logger });
  try {
    await zn.version();
    if (typeof zn.ensureCredentials === 'function') await zn.ensureCredentials();
  } catch (e) {
    logger.error(`紫鸟传输层不可用: ${redactText(e.message)}`);
    return 2;
  }

  const opts = { concurrency: config.ziniao.concurrency, asin: args.asin };
  let summaries;
  let slotHadFatal = false;
  let slotRecovery = null;
  if (mode === 'slot') {
    const out = await runSlot({ slot: target, zn, config, stores: selected, logger, opts });
    summaries = Object.values(out.checks);
    slotHadFatal = Object.keys(out.errors).length > 0;
    for (const [id, err] of Object.entries(out.errors)) logger.error(`[${id}] ${redactText(err)}`);
    out.slot = target;
    slotRecovery = out;
  } else {
    summaries = [await runCheckById({ id: target, zn, config, stores: selected, logger, opts: { ...opts, slot: args.slot || 'adhoc' } })];
  }

  // When collection and dashboard live on different machines, ship each summary
  // over. No-op when AMZGUARD_INGEST is unset (the same-box case).
  const { pushToDashboard } = await import('./lib/ingest.js');
  for (const s of summaries) {
    if (s && !s.skipped) await pushToDashboard({ summary: s, logger });
  }

  logger.plain('');
  logger.plain('='.repeat(58));
  let anyProblem = false;
  let anyInfrastructureFailure = slotHadFatal;
  let anyRan = false;
  for (const s of summaries) {
    if (!s) continue;
    if (s.skipped) {
      logger.plain(`  [${s.checkNo}/${CHECK_TOTAL}] ${s.checkTitle}: 跳过（${s.skipReason}）`);
      continue;
    }
    anyRan = true;
    const t = s.totals || {};
    if (t.abnormal > 0) anyProblem = true;
    if ((t.errors ?? 0) > 0 || (t.notConfigured ?? 0) > 0) anyInfrastructureFailure = true;
    logger.plain(`  [${s.checkNo}/${CHECK_TOTAL}] ${s.checkTitle}: 正常 ${t.ok ?? 0} / 异常 ${t.abnormal ?? 0}（共 ${t.total ?? 0}）`);
  }
  logger.plain('='.repeat(58));
  logger.plain(`看板: http://127.0.0.1:${process.env.PORT || 4173}/  （或 npm run serve 启动）`);

  if (mode === 'slot' && slotRecovery && anyInfrastructureFailure) {
    try {
      const { collectorLockReason } = await import('./lib/ziniao-restart.js');
      const recovery = await import('./lib/collection-recovery.js');
      let logText = '';
      try { logText = recovery.readZiniaoClientLog(); }
      catch (error) { logger.warn(`[recovery] 未能读取紫鸟启动日志，startBrowser 超时不会触发重启。${redactText(error?.message || error)}`); }
      const decision = recovery.planSlotRecovery({
        slot: target,
        slotOut: slotRecovery,
        slots: config.schedule?.slots || [],
        logText,
        lockHeld: Boolean(collectorLockReason(config.outDir)),
      });
      logger.warn(`[recovery] ${decision.message}`);
      if (decision.arm) recovery.writeRecoveryRequest(config.outDir, decision.plan);
    } catch (error) {
      logger.error(`[recovery] 未能提交自动补采，失败结果保持可见。${redactText(error?.message || error)}`);
    }
  }

  if (!anyRan) return 2;
  if (anyInfrastructureFailure) return 2;
  return anyProblem ? 1 : 0;
}

async function cmdCollectionRecovery({ config, logger }) {
  const { claimAndRunRecovery, recoveryExitCode, readZiniaoClientLog } = await import('./lib/collection-recovery.js');
  const { collectorLockReason, restartZiniaoService } = await import('./lib/ziniao-restart.js');
  const outcome = await claimAndRunRecovery({
    outDir: config.outDir,
    logger,
    readLog: () => {
      try { return readZiniaoClientLog(); }
      catch (error) {
        logger.warn(`[recovery] 未能读取紫鸟启动日志。${redactText(error?.message || error)}`);
        return '';
      }
    },
    lockReason: () => collectorLockReason(config.outDir),
    restart: () => restartZiniaoService({ outDir: config.outDir }),
  });
  if (outcome.action === 'idle') logger.info('[recovery] 没有待执行的补采请求。');
  else logger.warn(`[recovery] 补采结束 action=${outcome.action} reason=${outcome.reason || '-'} restart=${outcome.restartedZiniao ? 'yes' : 'no'}`);
  return recoveryExitCode(outcome);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 2;
  }

  const cmd = args._[0] || 'help';
  if (args.help || cmd === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const { config, stores, storesPath, storesMissing } = loadConfig({
    configFile: args.config,
    storesFile: args.stores,
  });

  const logFile = path.join(config.outDir, 'logs', `${bjDateKey()}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logger = createLogger({ level: args.logLevel || config.logLevel, file: logFile });

  try {
    switch (cmd) {
      case 'store-health':
      case 'health':
        return await cmdStoreHealth({ config, stores, storesMissing, storesPath, logger, args });
      case 'doctor':
        return await cmdDoctor({ config, stores, storesMissing, storesPath, logger });
      case 'stores':
        return await cmdStores({ config, logger });
      case 'checks':
        return await cmdChecks({ config, logger });
      case 'run-slot':
        return await cmdRun({ config, stores, storesMissing, storesPath, logger, args, mode: 'slot' });
      case 'run-check':
        return await cmdRun({ config, stores, storesMissing, storesPath, logger, args, mode: 'check' });
      case 'collection-recovery':
        return await cmdCollectionRecovery({ config, logger });
      case 'serve':
        await import('./server.js');
        return await new Promise(() => {}); // server owns the process from here
      case 'probe':
        return await cmdProbe({ config, stores, storesMissing, storesPath, logger, args });
      case 'product-upload-probe':
        return await cmdProductUploadProbe({ config, stores, storesMissing, storesPath, logger, args });
      case 'test-notify':
        return await (await import('./tools/test-notify.js')).runTestNotify({ config, logger, args });
      default:
        process.stderr.write(`未知命令: ${cmd}\n\n${USAGE}`);
        return 2;
    }
  } finally {
    await logger.close();
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    process.stderr.write(`致命错误: ${redactText(e?.stack || e)}\n`);
    process.exit(2);
  },
);
