import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCrmReadApi } from '../src/lib/crm-read-api.js';
import { CHECKS } from '../src/checks/registry.js';

const NOW = new Date('2026-09-12T04:00:00Z');
const PREFIX = '/api/crm/v1/stores';
function fixture(t, allowedStoreKeys = ['A']) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-crm-read-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const stores = [
    { key: 'A', name: 'Store A', market: 'US', id: 'PRIVATE_BROWSER' },
    { key: 'B', name: 'Store B', market: 'US' },
    { key: 'DISABLED', enabled: false },
  ];
  const api = createCrmReadApi({ outDir, stores, allowedStoreKeys, now: NOW });
  const write = (check, runId, results, extra = {}, filename = `${runId}.json`) => {
    const dir = path.join(outDir, check, '2026-09-12');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, filename);
    const report = { check, runId, startedAt: '2026-09-12T01:00:00Z',
      finishedAt: '2026-09-12T01:01:00Z', results, ...extra };
    fs.writeFileSync(file, JSON.stringify(report));
    return { file, report };
  };
  const result = (overrides = {}) => ({ storeKey: 'A', storeName: 'Store A', market: 'US',
    status: 'CLEAR', severity: 'OK', ok: true, checkedAt: '2026-09-12T01:00:00Z',
    confidence: 'high', verdictSource: 'dom+text', metrics: { businessStatus: 'CLEAR', collectionStatus: 'COMPLETE' },
    evidence: { dom: { landed: true }, text: { landed: true } }, ...overrides });
  return { outDir, api, stores, write, result };
}
const dataUrl = (check, runId, suffix = '') => `${PREFIX}/A/checks/${check}/data?runId=${encodeURIComponent(runId)}${suffix}`;

test('directory and nine-check summaries enforce exact configured enabled store scope', t => {
  const { api, write, result, outDir, stores } = fixture(t, ['A', 'DISABLED', 'REMOTE']);
  write('performance', 'shared', [result(), result({ storeKey: 'B', storeName: 'PRIVATE_B' }), result({ storeKey: 'REMOTE' })]);
  assert.deepEqual(api.handle(PREFIX).body.data, [{ storeKey: 'A', storeName: 'Store A', market: 'US' }]);
  const response = api.handle(`${PREFIX}/A/results`);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.checks.length, 9);
  assert.deepEqual(response.body.data.checks.map(row => row.checkId), CHECKS.map(check => check.id));
  assert.deepEqual(response.body.data.checks.find(row => row.checkId === 'reviews').status, ['NEVER_RUN']);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_B|PRIVATE_BROWSER/);
  for (const key of ['B', 'DISABLED', 'REMOTE', 'missing']) assert.equal(api.handle(`${PREFIX}/${key}/results`).status, 404);
  assert.deepEqual(createCrmReadApi({ outDir, stores, now: NOW }).handle(PREFIX).body.data, []);
});

test('latest per-store and targeted ASIN results retain each original run and collection time', t => {
  const { api, write, result } = fixture(t);
  write('performance', 'full-store', [result()], { finishedAt: '2026-09-12T01:10:00Z' });
  write('performance', 'other-store', [result({ storeKey: 'B', status: 'PRIVATE_B' })], { finishedAt: '2026-09-12T02:10:00Z' });
  write('asin-health', 'full', [result({ asin: 'B012345678', status: 'OK' }),
    result({ asin: 'B087654321', status: 'UNKNOWN', severity: 'ERROR', ok: false })],
  { selection: { targeted: false }, finishedAt: '2026-09-12T01:05:00Z' });
  write('asin-health', 'targeted', [result({ asin: 'B087654321', status: 'PARTIAL_EVIDENCE', severity: 'ERROR', ok: false,
    checkedAt: '2026-09-12T02:00:00Z', confidence: 'conflict', metrics: { ratingConflict: true, collectionStatus: 'PARTIAL_EVIDENCE' } })],
  { selection: { targeted: true }, startedAt: '2026-09-12T02:00:00Z', finishedAt: '2026-09-12T02:05:00Z' });
  const checks = api.handle(`${PREFIX}/A/results`).body.data.checks;
  assert.equal(checks.find(row => row.checkId === 'performance').results[0].source.runId, 'full-store');
  const rows = checks.find(row => row.checkId === 'asin-health').results;
  assert.equal(rows.length, 2);
  const unchanged = rows.find(row => row.asin === 'B012345678'), updated = rows.find(row => row.asin === 'B087654321');
  assert.equal(unchanged.source.runId, 'full');
  assert.equal(unchanged.source.collectedAt, '2026-09-12T01:00:00.000Z');
  assert.equal(updated.source.runId, 'targeted');
  assert.equal(updated.status, 'PARTIAL_EVIDENCE');
  assert.equal(updated.confidence, 'conflict');
  assert.equal(updated.metrics.ratingConflict, true);
  assert.equal(updated.collectionStatus, 'PARTIAL_EVIDENCE');
});

test('later-finishing full ASIN batch cannot roll back a newer targeted result', t => {
  const { api, write, result } = fixture(t);
  write('asin-health', 'targeted', [result({ asin: 'B012345678', checkedAt: '2026-09-12T02:00:00Z', status: 'NO_CART', severity: 'CRITICAL' })],
    { selection: { targeted: true }, finishedAt: '2026-09-12T02:05:00Z' });
  write('asin-health', 'long-full', [result({ asin: 'B012345678', status: 'OK' }), result({ asin: 'B087654321', status: 'OK' })],
    { selection: { targeted: false }, startedAt: '2026-09-12T00:00:00Z', finishedAt: '2026-09-12T03:00:00Z' });
  const rows = api.handle(`${PREFIX}/A/results`).body.data.checks.find(row => row.checkId === 'asin-health').results;
  assert.equal(rows.find(row => row.asin === 'B012345678').source.runId, 'targeted');
  assert.equal(rows.find(row => row.asin === 'B087654321').source.runId, 'long-full');
});

test('data paginates every saved review past 500, retains publication dates and only explicit page links', t => {
  const { api, write, result } = fixture(t);
  const items = Array.from({ length: 523 }, (_, index) => ({ identifier: `R${index}`, stars: 1,
    asin: 'B012345678', date: '2026-08-01', title: `Review ${index}`, author: 'Private Buyer' }));
  write('reviews', 'reviews-large', [result({ status: 'RECORDED_LOW_REVIEW', items,
    evidence: { dom: { landed: true, pages: [{ page: 11, pages: 11, reviewIds: ['R522'], capturedAt: '2026-09-12T01:00:00Z',
      screenshot: '/Users/private/evidence.png' }] }, text: { landed: true } } }),
  result({ storeKey: 'B', items: [{ title: 'PRIVATE_OTHER_STORE' }] })]);
  let snapshotId;
  const records = [];
  for (let page = 1; page <= 6; page++) {
    const response = api.handle(dataUrl('reviews', 'reviews-large', `&page=${page}${snapshotId ? `&snapshotId=${snapshotId}` : ''}`));
    assert.equal(response.status, 200);
    snapshotId ||= response.body.metadata.snapshotId;
    assert.equal(response.body.pagination.total, 523);
    records.push(...response.body.data);
  }
  assert.equal(records.length, 523);
  assert.equal(records.at(-1).item.identifier, 'R522');
  assert.equal(records.at(-1).item.date, '2026-08-01');
  assert.deepEqual(records.at(-1).reviewPages, [{ page: 11, pages: 11, capturedAt: '2026-09-12T01:00:00.000Z' }]);
  assert.deepEqual(records[0].reviewPages, []);
  assert.doesNotMatch(JSON.stringify(records), /Private Buyer|PRIVATE_OTHER_STORE|\/Users\/private|screenshot/);
  const pastEnd = api.handle(dataUrl('reviews', 'reviews-large', '&page=999'));
  assert.deepEqual(pastEnd.body.data, []);
  assert.equal(pastEnd.body.pagination.page, 999);
  assert.equal(pastEnd.body.pagination.hasMore, false);
});

test('VOC expands all nested saved records without the dashboard 200-record truncation', t => {
  const { api, write, result } = fixture(t);
  const records = Array.from({ length: 421 }, (_, index) => ({ identifier: `ORDER-${index}`, date: '2026-08-12',
    returnReason: `Reason ${index}`, customerIssue: `Issue ${index}` }));
  write('voc', 'voc-large', [result({ items: [{ asin: 'B012345678', cxHealth: 'Poor', records,
    returnReasons: Array.from({ length: 251 }, (_, index) => `reason-${index}`), detailComplete: false, detailStatus: 'PARTIAL_EVIDENCE' }] })]);
  const all = [1, 2, 3].flatMap(page => api.handle(dataUrl('voc', 'voc-large', `&page=${page}&pageSize=200`)).body.data);
  assert.equal(all.length, 422);
  assert.equal(all[0].recordType, 'voc-asin');
  assert.equal(all[0].item.returnReasons.length, 251);
  assert.equal(Object.hasOwn(all[0].item, 'records'), false);
  assert.equal(all.at(-1).recordType, 'voc-record');
  assert.equal(all.at(-1).recordIndex, 420);
  assert.equal(all.at(-1).parentAsin, 'B012345678');
  assert.equal(all.at(-1).item.identifier, 'ORDER-420');
});

test('public business fields remove identities, contacts, secrets, raw content and internal paths', t => {
  const { api, write, result } = fixture(t);
  write('feedback', 'private', [result({ browserOauth: 'PRIVATE_OAUTH', rawTextFile: '/etc/private',
    screenshot: '/Users/private/a.png', error: 'PRIVATE_ERROR', anomalyReasons: ['Customer Jane Buyer: token=PRIVATE_TOKEN https://example.test/a?token=PRIVATE_URL'],
    metrics: { lowCount: 1, unknownField: 'PRIVATE_UNKNOWN', password: 'PRIVATE_PASS', customerName: 'Jane Buyer' },
    evidence: { dom: { landed: true, raw: 'PRIVATE_DOM' }, text: { landed: true, context: 'PRIVATE_TEXT' } },
    items: [{ identifier: '123-1234567-1234567', author: 'Jane Buyer', email: 'jane@private.test',
      phone: '1234567890', title: 'Feedback', summary: 'Jane Buyer wrote jane@private.test, phone: 1234567890. /Users/private/a.png',
      body: 'PRIVATE_BODY', bodyraw: 'PRIVATE_BODYRAW', raw: 'PRIVATE_RAW', context: 'PRIVATE_CONTEXT',
      customerName: 'Jane Buyer', itemKey: 'PRIVATE_INTERNAL_KEY', secret: 'PRIVATE_SECRET' }] })]);
  const response = api.handle(dataUrl('feedback', 'private'));
  assert.equal(response.status, 200);
  const text = JSON.stringify(response.body.data);
  assert.doesNotMatch(text, /PRIVATE_|Jane Buyer|jane@private\.test|1234567890|\/Users\/private|\/etc\/private/);
  assert.equal(response.body.data[0].item.identifier, '123-1234567-1234567');
  assert.match(text, /https:\/\/example\.test\/a/);
  assert.equal(response.body.data[0].result.metrics.lowCount, 1);
});

test('Inbox suppresses all message entities, identifiers, free text and screenshots despite hostile saved fields', t => {
  const { api, write, result } = fixture(t);
  write('inbox', 'inbox-private', [result({ status: 'NEW_BUYER_MESSAGE', severity: 'WARN', ok: false,
    anomalyReasons: ['PRIVATE_REASON'], notes: ['PRIVATE_NOTE'], screenshot: '/private/message.png',
    metrics: { unreadCount: 3, oldestUnreadAt: '2026-09-01', date: '2026-09-12', countsAgree: false,
      identifier: 'PRIVATE_ORDER', messageId: 'PRIVATE_MESSAGE', subject: 'PRIVATE_SUBJECT',
      businessStatus: 'ANOMALY', collectionStatus: 'PARTIAL_EVIDENCE' },
    evidence: { dom: { landed: true, notes: ['PRIVATE_EVIDENCE'], unreadRows: [{ identifier: 'PRIVATE_ID' }] }, text: { landed: true } },
    items: [{ date: '2026-09-01', identifier: '123-1234567-1234567', source: 'PRIVATE_SOURCE', body: 'PRIVATE_BODY' }] })]);
  for (const response of [api.handle(dataUrl('inbox', 'inbox-private')), api.handle(`${PREFIX}/A/results`)]) {
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.body.data), /PRIVATE_|123-1234567-1234567|message\.png/);
  }
  const record = api.handle(dataUrl('inbox', 'inbox-private')).body.data[0];
  assert.equal(record.recordType, 'check-result');
  assert.equal(Object.hasOwn(record, 'item'), false);
  assert.equal(record.result.metrics.unreadCount, 3);
  assert.equal(record.result.metrics.oldestUnreadAt, '2026-09-01');
  assert.equal(record.result.metrics.countsAgree, false);
  assert.equal(record.result.collectionStatus, 'PARTIAL_EVIDENCE');
});

test('runs date filters use each result collection day and retain cross-midnight runs', t => {
  const { api, write, result } = fixture(t);
  write('reviews', 'night', [result({ checkedAt: '2026-09-10T15:59:59Z', items: [{ date: '2026-08-01' }] })],
    { startedAt: '2026-09-10T15:00:00Z', finishedAt: '2026-09-10T16:10:00Z' });
  const response = api.handle(`${PREFIX}/A/checks/reviews/runs?from=2026-09-10&to=2026-09-10`);
  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].runId, 'night');
  assert.deepEqual(response.body.data[0].collectionDates, ['2026-09-10']);
  assert.equal(api.handle(`${PREFIX}/A/checks/reviews/runs?from=2026-09-11`).body.pagination.total, 0);
  const data = api.handle(dataUrl('reviews', 'night'));
  assert.equal(data.body.metadata.generatedAt, NOW.toISOString());
  assert.equal(data.body.data[0].result.source.collectedAt, '2026-09-10T15:59:59.000Z');
  assert.equal(data.body.data[0].result.source.stale, true);
  assert.equal(data.body.data[0].result.actionState, 'COLLECTION');
  assert.equal(data.body.data[0].item.date, '2026-08-01');
});

test('duplicate identical files deduplicate, conflicting copies fail closed, and snapshot binding detects replacement', t => {
  const { api, write, result } = fixture(t);
  const saved = write('performance', 'same-run', [result()]);
  const duplicate = path.join(path.dirname(saved.file), 'copy.json');
  fs.writeFileSync(duplicate, JSON.stringify(saved.report));
  assert.equal(api.handle(`${PREFIX}/A/checks/performance/runs`).body.pagination.total, 1);
  const first = api.handle(dataUrl('performance', 'same-run'));
  const snapshotId = first.body.metadata.snapshotId;
  const changed = { ...saved.report, results: [result({ status: 'UNKNOWN', severity: 'ERROR', ok: false })] };
  fs.writeFileSync(duplicate, JSON.stringify(changed));
  assert.equal(api.handle(dataUrl('performance', 'same-run')).body.error.code, 'REPORT_CONFLICT');
  assert.equal(api.handle(`${PREFIX}/A/results`).status, 409);
  fs.unlinkSync(duplicate);
  fs.writeFileSync(saved.file, JSON.stringify(changed));
  const replacement = api.handle(dataUrl('performance', 'same-run', `&snapshotId=${snapshotId}`));
  assert.equal(replacement.status, 409);
  assert.equal(replacement.body.error.code, 'SNAPSHOT_CHANGED');
  assert.equal(api.handle(dataUrl('performance', 'same-run')).body.data[0].result.status, 'UNKNOWN');
});

test('legacy saved reports get stable opaque selection IDs and explicit fallback timestamp provenance', t => {
  const { api, write, result } = fixture(t);
  write('performance', 'unused', [result({ checkedAt: null })], { runId: undefined }, 'legacy-file.json');
  const runs = api.handle(`${PREFIX}/A/checks/performance/runs`).body.data;
  assert.match(runs[0].runId, /^legacy:[a-f0-9]{64}$/);
  assert.equal(runs[0].runIdSource, 'legacy-report');
  assert.equal(api.handle(`${PREFIX}/A/checks/performance/runs`).body.data[0].runId, runs[0].runId);
  const row = api.handle(dataUrl('performance', runs[0].runId)).body.data[0];
  assert.equal(row.result.source.timeSource, 'report.finishedAt');
  assert.equal(row.result.source.checkedAt, null);
  assert.doesNotMatch(JSON.stringify(row), /legacy-file\.json|amzguard-crm-read-/);
});

test('unsafe saved run IDs are selectable through opaque IDs without exposing paths or credentials', t => {
  const { api, write, result } = fixture(t);
  write('performance', 'unused', [result()], { runId: '/Users/private/run?token=PRIVATE_SECRET' }, 'unsafe-id.json');
  const runs = api.handle(`${PREFIX}/A/checks/performance/runs`).body.data;
  assert.match(runs[0].runId, /^opaque:[a-f0-9]{64}$/);
  assert.equal(runs[0].runIdSource, 'opaque-report-id');
  const data = api.handle(dataUrl('performance', runs[0].runId));
  assert.equal(data.status, 200);
  assert.doesNotMatch(JSON.stringify([runs, data]), /PRIVATE_SECRET|\/Users\/private/);
});

test('uncertain or conflicting saved verdicts never present as normal and preserve recorded values', t => {
  const { api, write, result } = fixture(t);
  write('reviews', 'bad-status', [result({ status: 'UNKNOWN' })]);
  write('feedback', 'bad-evidence', [result({ evidence: { dom: { error: 'PRIVATE_ERROR' }, text: { landed: true } } })]);
  write('asin-health', 'bad-conflict', [result({ asin: 'B012345678', status: 'OK', metrics: { ratingConflict: true } })]);
  const checks = api.handle(`${PREFIX}/A/results`).body.data.checks;
  for (const id of ['reviews', 'feedback', 'asin-health']) {
    const check = checks.find(row => row.checkId === id), row = check.results[0];
    assert.equal(check.severity, 'ERROR');
    assert.equal(row.recordedSeverity, 'OK');
    assert.equal(row.recordedOk, true);
    assert.equal(row.ok, false);
    assert.equal(row.presentationAdjusted, true);
    assert.equal(row.actionState, 'COLLECTION');
  }
  assert.equal(checks.find(row => row.checkId === 'reviews').results[0].status, 'UNKNOWN');
  assert.equal(checks.find(row => row.checkId === 'feedback').results[0].evidence.dom.available, false);
});

test('unknown status labels and legacy archived performance stay actionable while confirmed inactive ASINs remain valid negative reads', t => {
  const { api, write, result } = fixture(t);
  write('reviews', 'unknown-new-label', [result({ status: 'FUTURE_STATUS' })]);
  write('performance', 'legacy-archived', [result({ status: 'RECORDED_PERFORMANCE_EVENT' })]);
  write('asin-health', 'inactive', [result({ asin: 'B012345678', status: 'INACTIVE_LISTING',
    metrics: { listingActive: false, collectionStatus: 'COMPLETE' },
    evidence: { dom: { landed: false }, text: { landed: false } } })]);
  const checks = api.handle(`${PREFIX}/A/results`).body.data.checks;
  const unknown = checks.find(row => row.checkId === 'reviews').results[0];
  assert.equal(unknown.status, 'FUTURE_STATUS');
  assert.equal(unknown.recordedSeverity, 'OK');
  assert.equal(unknown.severity, 'ERROR');
  const performance = checks.find(row => row.checkId === 'performance').results[0];
  assert.equal(performance.severity, 'CRITICAL');
  assert.equal(performance.ok, false);
  assert.equal(performance.recordedOk, true);
  const inactive = checks.find(row => row.checkId === 'asin-health').results[0];
  assert.equal(inactive.severity, 'OK');
  assert.equal(inactive.ok, true);
  assert.equal(inactive.presentationAdjusted, false);
});

test('legacy OK without an ok flag and independent ad conflicts cannot appear normal', t => {
  const { api, write, result } = fixture(t);
  write('feedback', 'legacy-no-ok', [result({ ok: undefined, evidence: {} })]);
  write('ads-status', 'ad-conflicts', ['sourceStateConflict', 'sourceTotalConflict', 'domCountConflict', 'textCountConflict']
    .map(field => result({ status: 'ALL_OFF', metrics: { [field]: true } })));
  const checks = api.handle(`${PREFIX}/A/results`).body.data.checks;
  const feedback = checks.find(row => row.checkId === 'feedback').results[0];
  assert.equal(feedback.recordedOk, null);
  for (const row of [feedback, ...checks.find(check => check.checkId === 'ads-status').results]) {
    assert.equal(row.recordedSeverity, 'OK');
    assert.equal(row.severity, 'ERROR');
    assert.equal(row.ok, false);
    assert.equal(row.actionState, 'COLLECTION');
  }
});

test('valid report batches above ten thousand results remain reachable on the final data page', t => {
  const { api, write, result } = fixture(t);
  write('performance', 'large-batch', Array.from({ length: 10001 }, (_, index) => result({
    items: [{ identifier: `EVENT-${index}` }],
  })));
  const response = api.handle(dataUrl('performance', 'large-batch', '&page=51&pageSize=200'));
  assert.equal(response.status, 200);
  assert.equal(response.body.pagination.total, 10001);
  assert.equal(response.body.pagination.pages, 51);
  assert.equal(response.body.pagination.hasMore, false);
  assert.equal(response.body.metadata.ignoredReports, 0);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].resultIndex, 10000);
  assert.equal(response.body.data[0].item.identifier, 'EVENT-10000');
});

test('query and path validation rejects ambiguity, unbounded pages and invented latest runs', t => {
  const { api } = fixture(t);
  const base = `${PREFIX}/A/checks/reviews`;
  for (const url of [
    `${PREFIX}?page=1`, `${PREFIX}/A/results?unknown=x`, `${base}/runs?page=1&page=2`,
    `${base}/runs?page=0`, `${base}/runs?page=1e2`, `${base}/runs?page=1000001`, `${base}/runs?pageSize=201`,
    `${base}/runs?pageSize=0`, `${base}/runs?from=2026-02-29`, `${base}/runs?to=`,
    `${base}/runs?from=2026-09-12&to=2026-09-11`, `${base}/data`, `${base}/data?runId=`,
    `${base}/data?runId=x&runId=y`, `${base}/data?runId=x&snapshotId=bad`, `${PREFIX}/%ZZ/results`,
  ]) assert.equal(api.handle(url).status, 400, url);
  for (const url of [`${PREFIX}/B/checks/reviews/runs`, `${PREFIX}/A/checks/intelligence/runs`,
    `${base}/data?runId=LATEST_EFFECTIVE_BY_STORE`, '/api/intelligence', `${PREFIX}/A/checks/..%2F..%2Fusers/runs`]) {
    assert.equal(api.handle(url).status, 404, url);
  }
});

test('reading endpoints neither changes saved files nor follows report symlinks', t => {
  const { api, write, result, outDir } = fixture(t);
  const { file } = write('performance', 'read-only', [result()]);
  const before = { content: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs };
  const outside = path.join(outDir, 'private-source.json');
  fs.writeFileSync(outside, JSON.stringify({ runId: 'PRIVATE_SYMLINK', results: [result()] }));
  fs.symlinkSync(outside, path.join(path.dirname(file), 'linked.json'));
  fs.writeFileSync(path.join(path.dirname(file), 'broken.json'), '{');
  write('performance', 'future', [result()], { finishedAt: '2030-01-01T00:00:00Z' });
  const beforeNames = fs.readdirSync(path.dirname(file)).sort();
  const responses = [api.handle(PREFIX), api.handle(`${PREFIX}/A/results`),
    api.handle(`${PREFIX}/A/checks/performance/runs`), api.handle(dataUrl('performance', 'read-only'))];
  assert.ok(responses.every(response => response.status === 200));
  assert.doesNotMatch(JSON.stringify(responses), /PRIVATE_SYMLINK/);
  assert.equal(responses[2].body.pagination.total, 1);
  assert.equal(responses[2].body.metadata.ignoredReports, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), before.content);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), beforeNames);
  assert.equal(responses[3].body.metadata.collectionTriggered, false);
});
