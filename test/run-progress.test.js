import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { acquireRunLock, releaseRunLock, writeRunProgress, runCheckById } from '../src/checks/run.js';
import { applyProgressEvent, createProgressCells, normalizeRunProgress, readRuntimeProgress } from '../src/lib/run-progress.js';
import { DEFAULTS, deepMerge } from '../src/lib/config.js';
import { DASHBOARD_HTML } from '../src/web/dashboard.js';

const now = Date.now();
const at = new Date(now).toISOString();
const stores = [{ key: 'A' }, { key: 'B' }];
const initial = (ids = ['store-health', 'performance']) => ({
  state: 'RUNNING', checkIds: ids, startedAt: at, heartbeatAt: at,
  cells: createProgressCells(ids, stores),
});
const view = (raw) => normalizeRunProgress(raw, { alive: true, now });
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('progress follows queued, concurrent running and completed stores without mixing checks', () => {
  let raw = initial();
  raw = applyProgressEvent(raw, { type: 'check-start', check: 'store-health' }, at);
  for (const storeKey of ['A', 'B']) raw = applyProgressEvent(raw, { type: 'store', phase: 'started', check: 'store-health', storeKey }, at);
  assert.equal(view(raw).store, 'A、B');
  assert.equal(view(raw).percent, 0);
  raw = applyProgressEvent(raw, { type: 'store', phase: 'completed', check: 'store-health', storeKey: 'A', severity: 'CRITICAL' }, at);
  assert.equal(view(raw).store, 'B');
  assert.equal(view(raw).percent, 25);
  assert.equal(view(raw).cells.find((cell) => cell.check === 'performance' && cell.storeKey === 'A').state, 'QUEUED');
  raw = applyProgressEvent(raw, { type: 'check-complete', check: 'store-health', results: stores.map((store) => ({ storeKey: store.key, severity: 'OK' })) }, at);
  raw = applyProgressEvent(raw, { type: 'check-start', check: 'performance' }, at);
  assert.equal(view(raw).percent, 50);
  assert.equal(raw.currentUnit, null);
  assert.equal(raw.completedUnits, 0);
});

test('ASIN product progress uses its own denominator and retry completions are idempotent', () => {
  let raw = initial(['asin-health']);
  raw = applyProgressEvent(raw, { type: 'asin-plan', check: 'asin-health', stores: [{ storeKey: 'A', total: 100 }, { storeKey: 'B', total: 5 }] }, at);
  raw = applyProgressEvent(raw, { type: 'store', phase: 'started', check: 'asin-health', storeKey: 'A' }, at);
  for (let i = 0; i < 50; i++) raw = applyProgressEvent(raw, { type: 'asin', phase: 'completed', check: 'asin-health', storeKey: 'A', asin: `B0${String(i).padStart(8, '0')}` }, at);
  assert.equal(view(raw).percent, 25);
  assert.equal(view(raw).total, 2);
  raw = applyProgressEvent(raw, { type: 'asin', phase: 'completed', check: 'asin-health', storeKey: 'A', asin: 'B000000000' }, at);
  assert.equal(view(raw).cells[0].completed, 50);
  raw = applyProgressEvent(raw, { type: 'store', phase: 'completed', check: 'asin-health', storeKey: 'A', severity: 'ERROR' }, at);
  assert.equal(view(raw).cells[0].state, 'ERROR');
  assert.equal(view(raw).percent, 50);
  assert.doesNotMatch(JSON.stringify(view(raw)), /completedAsins/);
});

test('skipped stores and business findings finish execution without being labelled healthy', () => {
  let raw = initial(['asin-health']);
  raw = applyProgressEvent(raw, { type: 'asin-plan', check: 'asin-health', stores: [{ storeKey: 'A', total: 1 }] }, at);
  assert.equal(view(raw).cells[1].state, 'SKIPPED');
  raw = applyProgressEvent(raw, { type: 'check-complete', check: 'asin-health', results: [{ storeKey: 'A', status: 'NO_CART', severity: 'CRITICAL' }] }, at);
  const result = view({ ...raw, state: 'COMPLETED_WITH_FINDINGS' });
  assert.equal(result.active, false);
  assert.equal(result.percent, 100);
  assert.equal(result.cells[0].severity, 'CRITICAL');
  assert.equal(result.cells[1].state, 'SKIPPED');
});

test('legacy progress reads actual coordinator fields and recognises completed findings', () => {
  const old = { state: 'RUNNING', totalChecks: 8, completedChecks: 2, storeTotal: 6, completedUnits: 3, currentCheck: 'feedback', heartbeatAt: at };
  assert.equal(view(old).total, 48);
  assert.equal(view(old).completed, 15);
  assert.equal(view(old).check, 'feedback');
  assert.equal(view({ ...old, state: 'COMPLETED_WITH_FINDINGS' }).percent, 100);
  assert.equal(view({ ...old, state: 'COMPLETED_WITH_ERRORS' }).active, false);
});

test('stale heartbeat is delayed, and missing or replaced process lease stops every spinner', (t) => {
  const root = temp(t);
  const lease = acquireRunLock({ outDir: root, label: 'check:feedback' });
  let raw = initial(['feedback']);
  raw = applyProgressEvent(raw, { type: 'store', phase: 'started', check: 'feedback', storeKey: 'A' }, at);
  writeRunProgress(lease, { ...raw, heartbeatAt: new Date(now - 40000).toISOString() });
  assert.equal(readRuntimeProgress(root, { now }).active, true);
  assert.equal(readRuntimeProgress(root, { now }).delayed, true);
  releaseRunLock(lease);
  const stopped = readRuntimeProgress(root, { now });
  assert.equal(stopped.state, 'INTERRUPTED');
  assert.equal(stopped.active, false);
  assert.ok(stopped.cells.every((cell) => cell.state === 'INTERRUPTED'));
  const replacement = acquireRunLock({ outDir: root, label: 'check:feedback' });
  t.after(() => releaseRunLock(replacement));
  assert.equal(readRuntimeProgress(root).active, false, 'same PID/label with a new lease cannot resurrect a prior task');
});

test('a new run clears all old check IDs, counts and per-store state', (t) => {
  const root = temp(t);
  const first = acquireRunLock({ outDir: root, label: 'slot:am' });
  writeRunProgress(first, { ...initial(), completedUnits: 999, fatalError: 'OLD_RUN' });
  const firstId = readRuntimeProgress(root).runId;
  releaseRunLock(first);
  const second = acquireRunLock({ outDir: root, label: 'check:ads-status' });
  t.after(() => releaseRunLock(second));
  writeRunProgress(second, { state: 'RUNNING', currentCheck: 'ads-status', checkIds: ['ads-status'], cells: createProgressCells(['ads-status'], [{ key: 'B' }]) });
  const raw = JSON.parse(fs.readFileSync(second.progressFile));
  assert.equal(raw.completedUnits, undefined);
  assert.equal(raw.fatalError, undefined);
  assert.equal(raw.cells.length, 1);
  assert.notEqual(raw.runId, firstId);
  assert.equal(fs.statSync(second.progressFile).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(readRuntimeProgress(root)), /leaseToken|"pid"|OLD_RUN/);
});

test('store-health publishes a running cell before opening the browser and finishes its lease', async (t) => {
  const root = temp(t);
  const config = deepMerge(DEFAULTS, {
    ziniao: { retries: 0, settleMs: 0, closeStoreAfterCheck: true },
    storeHealth: { screenshot: false, saveRawPageText: false },
    codex: { enabled: false }, alert: { console: false, file: false, dingtalk: { enabled: false }, webhook: { enabled: false } },
    crm: { enabled: false },
  });
  config.outDir = root;
  let observed = false;
  const zn = {
    async storeOpen() {
      const p = readRuntimeProgress(root);
      assert.equal(p.active, true); assert.equal(p.store, 'A'); assert.equal(p.cells[0].state, 'RUNNING');
      observed = true;
      throw new Error('Intentional test browser failure');
    },
    async storeClose() {},
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  await runCheckById({ id: 'store-health', config, stores: [{ key: 'A', id: 'A' }], zn, logger });
  assert.equal(observed, true);
  const completed = readRuntimeProgress(root);
  assert.equal(completed.state, 'COMPLETED_WITH_ERRORS');
  assert.equal(completed.percent, 100);
  assert.equal(completed.cells[0].state, 'ERROR');
  assert.equal(completed.active, false);
  assert.equal(fs.existsSync(path.join(root, 'runtime/run.lock')), false);
});

function frontend() {
  const original = /<script>([\s\S]*?)<\/script>/.exec(DASHBOARD_HTML)[1];
  const boundary = original.indexOf("  q('#refresh').addEventListener");
  const script = original.slice(0, boundary) + `
    globalThis.testUI={executionCell,renderProgress,renderSystemProgress,setData:function(value){data=value},disconnect:function(){progressDisconnected=true}};
  })();`;
  const elements = new Map();
  const element = () => ({ textContent: '', innerHTML: '', className: '', style: {}, attributes: {}, hidden: false,
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; } });
  const context = vm.createContext({ console, Date, Intl, document: { querySelector(selector) {
    if (!elements.has(selector)) { const el = element(); el.parentElement = element(); elements.set(selector, el); }
    return elements.get(selector);
  } } });
  vm.runInContext(script, context);
  return { ui: context.testUI, elements };
}

test('progress UI keeps business history, animates only running cells and stops on interruption', () => {
  const { ui, elements } = frontend();
  let raw = initial(['performance']);
  raw = applyProgressEvent(raw, { type: 'check-start', check: 'performance' }, at);
  raw = applyProgressEvent(raw, { type: 'store', phase: 'started', check: 'performance', storeKey: 'A' }, at);
  const data = { checks: [{ id: 'performance', title: '绩效检查' }], stores, progress: view(raw) };
  ui.setData(data); ui.renderProgress();
  assert.match(elements.get('#runTitle').textContent, /巡检正在运行.*绩效检查/);
  const old = { state: 'CRITICAL', stateLabel: '业务异常' };
  const active = ui.executionCell('A', 'performance', old);
  assert.equal(active.busy, true); assert.match(active.html, /e-RUNNING/); assert.match(active.html, /上次：业务异常/);
  assert.match(ui.executionCell('B', 'performance', old).html, /e-QUEUED/);
  assert.doesNotMatch(ui.executionCell('A', 'feedback', old).html, /run-spinner/);
  data.progress = normalizeRunProgress(raw, { alive: false, now });
  ui.renderProgress();
  assert.match(elements.get('#runTitle').textContent, /任务已中断/);
  assert.equal(ui.executionCell('A', 'performance', old).busy, false);
  assert.doesNotMatch(ui.executionCell('A', 'performance', old).html, /e-RUNNING/);
});

test('progress UI shows network loss and a new collection failure without painting it green', () => {
  const { ui, elements } = frontend();
  let raw = initial(['performance']);
  raw = applyProgressEvent(raw, { type: 'store', phase: 'started', check: 'performance', storeKey: 'A' }, at);
  const data = { checks: [], stores, progress: view(raw) }; ui.setData(data); ui.disconnect(); ui.renderProgress();
  assert.match(elements.get('#runConnection').textContent, /连接中断/);
  assert.match(ui.executionCell('A', 'performance', { state: 'OK', stateLabel: '正常' }).className, /execution-delayed/);
  raw = applyProgressEvent(raw, { type: 'store', phase: 'completed', check: 'performance', storeKey: 'A', severity: 'ERROR' }, at);
  data.progress = view(raw);
  const error = ui.executionCell('A', 'performance', { state: 'OK', stateLabel: '正常' });
  assert.match(error.className, /s-ERROR/); assert.equal(error.busy, false);
});
