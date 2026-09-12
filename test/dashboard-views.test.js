import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildMonitoringRecommendations,
  buildOperationalViews,
  evidenceCompleteness,
  operationalViewCatalog,
} from '../src/lib/dashboard-views.js';

const checks = [
  ['store-health', 1, '店铺健康'], ['performance', 2, '绩效'],
  ['feedback', 3, 'Feedback'], ['reviews', 4, 'Reviews'],
  ['asin-health', 5, 'ASIN'], ['outlet', 6, 'Outlet'],
  ['voc', 7, 'VOC'], ['ads-status', 8, '广告'], ['inbox', 9, 'Inbox'],
].map(([id, no, title]) => ({ id, no, title, state: 'OK', actionState: 'NORMAL' }));

function cell(overrides = {}) {
  return {
    state: 'OK', stateLabel: '正常', actionState: 'NORMAL', actionLabel: '正常',
    status: 'CLEAR', reasons: [], results: [], stale: false, ...overrides,
  };
}

function result(overrides = {}) {
  return {
    subject: 'STORE-A', storeKey: 'STORE-A', status: 'CLEAR', severity: 'OK',
    evidence: { dom: { available: true }, text: { available: true } }, ...overrides,
  };
}

test('seven operational views group only their assigned checks', () => {
  const cells = Object.fromEntries(checks.map((check) => [check.id, cell({
    results: [result({ status: check.id === 'store-health' ? 'HEALTHY' : 'CLEAR' })],
  })]));
  cells.reviews = cell({
    state: 'CRITICAL', actionState: 'BUSINESS', status: 'LOW_REVIEW',
    results: [result({ status: 'LOW_REVIEW', severity: 'CRITICAL' })],
  });
  cells.inbox = cell({
    state: 'WARN', actionState: 'BUSINESS', status: 'NEW_BUYER_MESSAGE',
    results: [result({ status: 'NEW_BUYER_MESSAGE', severity: 'WARN' })],
  });
  const views = buildOperationalViews({
    stores: [{ key: 'STORE-A', name: 'Store A', market: 'US', state: 'CRITICAL', actionState: 'BUSINESS', cells }],
    checks,
    monitoringRecommendations: [{ asin: 'B012345678', recommendation: 'KEEP_DAILY' }],
    upload: { enabled: true, authorized: false },
  });

  assert.deepEqual(Object.keys(views), operationalViewCatalog().map((view) => view.id));
  assert.deepEqual(views['store-risk'].checkIds, ['store-health', 'performance']);
  assert.deepEqual(views['customer-voice'].checkIds, ['feedback', 'inbox', 'reviews', 'voc']);
  assert.deepEqual(views['product-status'].checkIds, ['asin-health', 'outlet']);
  assert.deepEqual(views['ads-watch'].checkIds, ['ads-status']);
  assert.equal(views['customer-voice'].state, 'CRITICAL');
  assert.equal(views['customer-voice'].actionState, 'BUSINESS');
  // Inbox sits between Feedback and Reviews and an unread message is business work.
  const voiceCells = views['customer-voice'].stores[0].checks;
  assert.deepEqual(voiceCells.map((item) => item.checkId), ['feedback', 'inbox', 'reviews', 'voc']);
  const inboxCell = voiceCells[1];
  assert.equal(inboxCell.checkNo, 9);
  assert.equal(inboxCell.state, 'WARN');
  assert.equal(inboxCell.actionState, 'BUSINESS');
  assert.equal(views['product-status'].monitoringRecommendations.length, 1);
  assert.equal(views['upload-center'].authorized, false);
  assert.equal(views['upload-center'].api, '/api/product-uploads');
});

test('unknown raw/action states fail closed as collection failures', () => {
  const cells = Object.fromEntries(checks.map((check) => [check.id, cell()]));
  cells.performance = cell({ state: 'SOMETHING_NEW', actionState: 'MYSTERY', status: 'UNKNOWN' });
  const views = buildOperationalViews({
    stores: [{ key: 'STORE-A', state: 'SOMETHING_NEW', actionState: 'MYSTERY', cells }],
    checks,
  });
  const performance = views['store-risk'].stores[0].checks.find((item) => item.checkId === 'performance');
  assert.equal(performance.state, 'ERROR');
  assert.equal(performance.actionState, 'COLLECTION');
  assert.equal(views.overview.stores[0].state, 'ERROR');
  assert.equal(views.overview.stores[0].actionState, 'COLLECTION');
});

test('evidence completeness refuses to treat OK without DOM and text as complete', () => {
  const complete = result();
  const partial = result({ asin: 'B012345678', evidence: { dom: { available: true }, text: { available: false } } });
  const summary = evidenceCompleteness([{
    key: 'STORE-A',
    cells: { reviews: { results: [complete, partial] } },
  }]);
  assert.equal(summary.state, 'ERROR');
  assert.equal(summary.complete, 1);
  assert.equal(summary.partial, 1);
  assert.equal(summary.normalWithoutDualEvidence, 1);
  assert.equal(summary.percent, 50);
});

test('ASIN history only recommends manual verification or lower frequency after repeated absence', () => {
  const reports = ['PAGE_NOT_FOUND', 'UNAVAILABLE', 'UNAVAILABLE'].map((status, index) => ({
    finishedAt: `2026-08-${String(20 + index).padStart(2, '0')}T08:00:00+08:00`,
    results: [{
      asin: 'B012345678', storeKey: 'STORE-A', market: 'US', status, severity: 'CRITICAL',
    }],
  }));
  const rows = buildMonitoringRecommendations({
    history: reports,
    inventory: [{ asin: 'B012345678', storeKey: 'STORE-A', market: 'US', monitoring: 'active' }],
  });
  assert.equal(rows[0].consecutiveUnavailable, 3);
  assert.equal(rows[0].recommendation, 'MANUAL_VERIFY_OR_CONSIDER_WEEKLY');
  assert.equal(rows[0].automaticChange, false);
  assert.equal(rows[0].readOnly, true);
  assert.doesNotMatch(JSON.stringify(rows[0]), /auto.*(?:disable|stop)|停检/i);
});

test('ASIN recovery and collection errors cannot be mistaken for a scope change', () => {
  const base = [
    { finishedAt: '2026-08-20T08:00:00+08:00', results: [{ asin: 'B012345678', storeKey: 'A', status: 'UNAVAILABLE', severity: 'CRITICAL' }] },
    { finishedAt: '2026-08-21T08:00:00+08:00', results: [{ asin: 'B012345678', storeKey: 'A', status: 'PAGE_NOT_FOUND', severity: 'CRITICAL' }] },
    { finishedAt: '2026-08-22T08:00:00+08:00', results: [{ asin: 'B012345678', storeKey: 'A', status: 'OK', severity: 'OK' }] },
    { finishedAt: '2026-08-22T08:00:00+08:00', results: [{ asin: 'B087654321', storeKey: 'A', status: 'UNAVAILABLE', severity: 'CRITICAL' }] },
    { finishedAt: '2026-08-23T08:00:00+08:00', results: [{ asin: 'B087654321', storeKey: 'A', status: 'PARTIAL_EVIDENCE', severity: 'ERROR' }] },
  ];
  const rows = buildMonitoringRecommendations({ history: base });
  assert.equal(rows.find((row) => row.asin === 'B012345678').recommendation, 'RECOVERED');
  assert.equal(rows.find((row) => row.asin === 'B087654321').recommendation, 'FIX_COLLECTION_FIRST');
  assert.equal(rows.find((row) => row.asin === 'B087654321').consecutiveUnavailable, 0);
});

test('server exposes authenticated read-only view routes', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /p === '\/api\/views'/);
  assert.match(source, /p\.startsWith\('\/api\/view\/'\)/);
  assert.match(source, /buildMonitoringRecommendations/);
});
