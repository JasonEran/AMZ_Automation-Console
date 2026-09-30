import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PAGE_READ_WAIT_MS, executeCollectionRecovery, isRetryableCollectionFailure,
  manualArgv, planSlotRecovery, readZiniaoClientLog, recoveryExitCode,
  startupNetworkState, writeRecoveryRequest, claimAndRunRecovery,
} from '../src/lib/collection-recovery.js';
import { COLLECTION_UNITS } from '../src/lib/ziniao-restart.js';

const slots = [
  { name: 'am', at: '08:00' },
  { name: 'ads-off', at: '11:20' },
  { name: 'pm', at: '15:30' },
  { name: 'ads-on', at: '18:30' },
];
const openWindow = new Date('2026-09-22T01:10:00.000Z');
const tightWindow = new Date('2026-09-22T03:16:00.000Z');
const log = [
  'LUPING startup BLACK_AND_WHITE',
  'LUPING get plugin id',
  'JUNJUN BLACK_AND_WHITE',
  'JUNJUN NETWORK',
  'JUNJUN open browser',
].join('\n');

const row = (extra) => ({ storeKey: 'LUPING', storeName: 'LUPING', ok: false, severity: 'ERROR', ...extra });

function plan(slot, checks, { now = openWindow, logText = log, lockHeld = false } = {}) {
  return planSlotRecovery({ slot, slotOut: { checks, errors: {} }, slots, now, logText, lockHeld });
}

test('startup log distinguishes a shop that never reached NETWORK', () => {
  assert.equal(startupNetworkState(log, ['LUPING']), 'before-network');
  assert.equal(startupNetworkState(log, ['JUNJUN']), 'reached');
  assert.equal(startupNetworkState(log, ['FENG']), 'unknown');
  assert.equal(startupNetworkState('LUPING BLACK_AND_WHITE\nNETWORK', ['LUPING']), 'before-network');
  assert.equal(startupNetworkState('LUPING BLACK_AND_WHITE\nLUPING NETWORK', ['LUPING']), 'reached');
});

test('collected business verdicts are not recovery units', () => {
  const decision = plan('pm', {
    voc: { results: [row({ check: 'voc', status: 'POOR_CX', metrics: { collectionStatus: 'COMPLETE' } })] },
    reviews: { results: [row({ check: 'reviews', storeKey: 'JUNJUN', status: 'LOW_REVIEW', metrics: { collectionStatus: 'COMPLETE' } })] },
    'asin-health': { results: [
      row({ check: 'asin-health', asin: 'B0FZJYXSWV', status: 'RATING_DROP', metrics: { collectionStatus: 'COMPLETE', ratingDelta: -0.2 } }),
      row({ check: 'asin-health', storeKey: 'WANG', asin: 'B0FNCJQVX3', status: 'INACTIVE_LISTING', metrics: { collectionStatus: 'COMPLETE' } }),
    ] },
    'ads-status': { results: [row({
      check: 'ads-status', storeKey: 'FENG', status: 'MAJORITY_OFF', slot: 'ads-off',
      metrics: { collectionStatus: 'COMPLETE', unknown: 0 },
    })] },
  });
  assert.equal(decision.arm, false);
  assert.equal(decision.reason, 'nothing-to-retry');
  assert.equal(decision.plan.units.length, 0);
  assert.equal(decision.plan.restartZiniao, false);
});

test('collection failures become one manual-unit spec each and unknown statuses stay closed', () => {
  const decision = plan('am', {
    feedback: { results: [row({ check: 'feedback', status: 'LOGIN_REQUIRED', metrics: { collectionStatus: 'ERROR' } })] },
    voc: { results: [row({ check: 'voc', storeKey: 'JUNJUN', storeName: 'JUNJUN', status: 'DETAIL_ERROR', metrics: { collectionStatus: 'ERROR' } })] },
    'asin-health': { results: [
      row({ check: 'asin-health', asin: 'B0GZYT73F1', status: 'ERROR', metrics: {}, evidence: { safety: { code: 'LIVE_SAFETY_PROBE_INCOMPLETE' } } }),
      row({ check: 'asin-health', storeKey: 'FENG', asin: 'B0GFKHLCMN', status: 'UNKNOWN_RATING', metrics: { collectionStatus: 'PARTIAL_EVIDENCE' } }),
      row({ check: 'asin-health', storeKey: 'FENG', asin: 'B0OKAY0001', status: 'OK', ok: true, metrics: { collectionStatus: 'COMPLETE' } }),
    ] },
    'ads-status': { results: [row({
      check: 'ads-status', storeKey: 'FENG', status: 'PARTIAL_EVIDENCE', slot: 'ads-off',
      metrics: { collectionStatus: 'PARTIAL_EVIDENCE', unknown: 16, campaignCount: 19 },
    })] },
  });
  assert.equal(decision.arm, true);
  assert.equal(decision.plan.restartZiniao, false);
  assert.equal(decision.plan.waitMs, PAGE_READ_WAIT_MS);
  assert.deepEqual(decision.plan.units.map((unit) => unit.spec).sort(), [
    'asin-health-B0GFKHLCMN:FENG',
    'asin-health-B0GZYT73F1:LUPING',
    'feedback:LUPING',
    'voc:JUNJUN',
  ]);
  assert.equal(decision.plan.units.every((unit) => unit.kind === 'page-read'), true);
  assert.equal(decision.plan.skipped.unknownStatus, 1);
  assert.equal(manualArgv('product-upload-probe:FENG'), null);
  assert.equal(manualArgv('asin-health:LUPING'), null);
  assert.equal(manualArgv('am:LUPING'), null);
  assert.deepEqual(manualArgv('asin-health-B0GZYT73F1:LUPING'), ['run-check', 'asin-health', '--store', 'LUPING', '--asin', 'B0GZYT73F1']);
  assert.deepEqual(manualArgv('ads-status-off:FENG'), ['run-check', 'ads-status', '--store', 'FENG', '--slot', 'ads-off']);
});

test('startBrowser timeout before NETWORK restarts Ziniao once and does not wait on the same session', () => {
  const timeout = row({
    check: 'asin-health', asin: 'B0FQNW76WS', status: 'ERROR',
    error: 'startBrowser 超时 紫鸟 WebDriver HTTP 服务不可用 The operation was aborted due to timeout',
  });
  const decision = plan('am', { 'asin-health': { results: [timeout] } });
  assert.equal(decision.arm, true);
  assert.equal(decision.plan.restartZiniao, true);
  assert.equal(decision.plan.waitMs, 0);
  assert.equal(decision.plan.units[0].kind, 'start-browser-before-network');
  assert.equal(decision.plan.units[0].spec, 'asin-health-B0FQNW76WS:LUPING');

  const reached = plan('am', { 'asin-health': { results: [timeout] } }, { logText: 'LUPING BLACK_AND_WHITE\nLUPING NETWORK' });
  assert.equal(reached.plan.restartZiniao, false);
  assert.equal(reached.plan.units[0].kind, 'start-browser-reached');

  const unknown = plan('am', { 'asin-health': { results: [timeout] } }, { logText: '' });
  assert.equal(unknown.arm, false);
  assert.equal(unknown.plan.skipped.unconfirmedStart, 1);

  const safety = plan('pm', { 'asin-health': { results: [row({
    check: 'asin-health', asin: 'B0GZYT73F1', status: 'ERROR',
    anomalyReasons: ['页面安全扫描不完整，禁止采集与截图'],
    evidence: { safety: { code: 'LIVE_SAFETY_PROBE_INCOMPLETE' } },
  })] } });
  assert.equal(safety.plan.restartZiniao, false);
  assert.equal(safety.plan.units[0].kind, 'page-read');
  assert.equal(isRetryableCollectionFailure(row({ status: 'BLOCKED', metrics: { collectionStatus: 'ERROR' } })), false);
  assert.equal(isRetryableCollectionFailure(row({ status: 'NOT_CONFIGURED' })), false);
  assert.equal(isRetryableCollectionFailure(row({ status: 'ERROR', error: 'SECURITY_CLEANUP_FAILED' })), false);
});

test('a slot that would overlap the next timer is left failed and visible', () => {
  const decision = plan('am', {
    feedback: { results: [row({ check: 'feedback', status: 'LOGIN_REQUIRED' })] },
  }, { now: tightWindow });
  assert.equal(decision.arm, false);
  assert.equal(decision.reason, 'next-slot-too-close');
  assert.match(decision.message, /失败结果保持可见/);
});

test('recovery restarts Ziniao only for a confirmed pre-NETWORK timeout, then runs each spec once', async () => {
  const decision = plan('am', {
    feedback: { results: [row({ check: 'feedback', status: 'LOGIN_REQUIRED' })] },
    'asin-health': { results: [row({
      check: 'asin-health', asin: 'B0FQNW76WS', status: 'ERROR',
      error: 'startBrowser 超时 WebDriver HTTP 服务不可用 aborted due to timeout',
    })] },
  });
  assert.equal(decision.plan.restartZiniao, true);
  assert.equal(decision.plan.waitMs, PAGE_READ_WAIT_MS);
  const calls = [];
  let slept = 0;
  let restarts = 0;
  const outcome = await executeCollectionRecovery(decision.plan, {
    now: () => openWindow,
    readLog: () => log,
    lockReason: () => null,
    sleep: async (ms) => { slept += ms; },
    restart: async () => { restarts += 1; },
    portOpenImpl: async () => true,
    runSpec: async (spec) => { calls.push(spec); return { status: spec.startsWith('feedback') ? 2 : 0 }; },
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(restarts, 1);
  assert.equal(slept, PAGE_READ_WAIT_MS);
  assert.deepEqual(calls, ['asin-health-B0FQNW76WS:LUPING', 'feedback:LUPING']);
  assert.equal(outcome.results.filter((item) => item.spec === 'feedback:LUPING')[0].status, 2);
  assert.equal(calls.filter((spec) => spec === 'feedback:LUPING').length, 1);
  assert.equal(recoveryExitCode(outcome), 2);
});

test('a safety-probe plan does not restart Ziniao, and a failed restart does not open Amazon', async () => {
  const afternoon = new Date('2026-09-22T08:50:00.000Z');
  const safety = plan('pm', { 'asin-health': { results: [row({
    check: 'asin-health', asin: 'B0GZYT73F1', status: 'ERROR',
    evidence: { safety: { code: 'LIVE_SAFETY_PROBE_INCOMPLETE' } },
  })] } }, { now: afternoon });
  let restarts = 0;
  const calls = [];
  await executeCollectionRecovery(safety.plan, {
    now: () => afternoon,
    readLog: () => log,
    sleep: async () => {},
    restart: async () => { restarts += 1; },
    portOpenImpl: async () => true,
    runSpec: async (spec) => { calls.push(spec); return { status: 0 }; },
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(restarts, 0);
  assert.deepEqual(calls, ['asin-health-B0GZYT73F1:LUPING']);

  const stuck = plan('am', { 'asin-health': { results: [row({
    check: 'asin-health', asin: 'B0FQNW76WS', status: 'ERROR',
    error: 'startBrowser 超时 WebDriver HTTP 服务不可用 aborted due to timeout',
  })] } });
  const blocked = await executeCollectionRecovery(stuck.plan, {
    now: () => openWindow,
    readLog: () => log,
    sleep: async () => {},
    restart: async () => { throw new Error('polkit denied'); },
    portOpenImpl: async () => true,
    runSpec: async () => { throw new Error('must not open Amazon after a failed restart'); },
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(blocked.reason, 'restart-failed');
  assert.equal(blocked.restartedZiniao, false);
});

test('request files reject product upload and are consumed once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const decision = plan('ads-off', { 'ads-status': { results: [row({
    check: 'ads-status', storeKey: 'XCAI', status: 'ERROR', slot: 'ads-off',
    error: '页面文本获取失败: timeout', metrics: { collectionStatus: 'ERROR', unknown: 0 },
  })] } });
  writeRecoveryRequest(dir, decision.plan);
  const calls = [];
  const outcome = await claimAndRunRecovery({
    outDir: dir,
    logger: { info() {}, warn() {}, error() {} },
    now: () => openWindow,
    readLog: () => '',
    lockReason: () => null,
    sleep: async () => {},
    restart: async () => { throw new Error('ads page failure must not restart Ziniao'); },
    runSpec: async (spec) => { calls.push(spec); return { status: 1 }; },
  });
  assert.deepEqual(calls, ['ads-status-off:XCAI']);
  assert.equal(outcome.restartedZiniao, false);
  assert.equal(recoveryExitCode(outcome), 1);
  assert.equal(fs.existsSync(path.join(dir, 'runtime', 'collection-recovery.request')), false);
  const idle = await claimAndRunRecovery({
    outDir: dir, logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(idle.action, 'idle');
  const tampered = { ...decision.plan, units: [{ spec: 'product-upload-probe:XCAI', kind: 'page-read', storeKey: 'XCAI' }] };
  const rejected = await executeCollectionRecovery(tampered, {
    now: () => openWindow,
    restart: async () => { throw new Error('tampered plan must not restart'); },
    runSpec: async () => { throw new Error('tampered plan must not run'); },
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(rejected.reason, 'invalid-plan');
});

test('client log reads stay inside the Ziniao instance directory', () => {
  assert.throws(() => readZiniaoClientLog({ homeDir: '/tmp', logDir: '/etc' }), /允许的实例目录/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-ziniao-home-'));
  const logDir = path.join(home, '.config', 'ziniaobrowser', 'instances', 'userdata1', 'logs', 'client');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'main.log'), 'LUPING BLACK_AND_WHITE\n');
  assert.match(readZiniaoClientLog({ homeDir: home }), /LUPING BLACK_AND_WHITE/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('slot failure starts a separate recovery unit that is not itself a Ziniao restart blocker', () => {
  for (const name of ['am', 'pm', 'ads-off', 'ads-on']) {
    const source = fs.readFileSync(path.join('deploy/systemd', `amzguard-store-health-${name}.service`), 'utf8');
    assert.match(source, /^OnFailure=amzguard-collection-recovery\.service$/m);
  }
  const recovery = fs.readFileSync(path.join('deploy/systemd/amzguard-collection-recovery.service'), 'utf8');
  assert.match(recovery, /^ExecStart=.*collection-recovery$/m);
  assert.doesNotMatch(recovery, /^Requires=amzguard-ziniao\.service$/m);
  assert.doesNotMatch(recovery, /product-upload/);
  assert.equal(COLLECTION_UNITS.includes('amzguard-collection-recovery.service'), false);
  assert.equal(COLLECTION_UNITS.includes('amzguard-store-health-am.service'), true);
  const install = fs.readFileSync(path.join('deploy/install-linux.sh'), 'utf8');
  assert.match(install, /amzguard-collection-recovery\.service/);
});
