import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { storeHistoryDays, validHistoryDate, historyRecordsPage } from '../src/lib/dashboard-history.js';

test('daily history uses the store collection time, retains every run, and isolates stores', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-history-days-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'reviews'); fs.mkdirSync(dir);
  const write = (id, checkedAt, finishedAt, items = []) => fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({
    check: 'reviews', runId: id, finishedAt,
    results: [{ storeKey: 'A', checkedAt, items }, { storeKey: 'B', checkedAt: finishedAt, items: [{ title: 'other store' }] }],
  }));
  write('night', '2026-09-06T15:59:59Z', '2026-09-06T16:05:00Z', [{ date: '2026-08-20', title: 'late review' }]);
  write('morning', '2026-09-07T00:00:00Z', '2026-09-07T00:01:00Z');
  write('rerun', '2026-09-07T02:00:00Z', '2026-09-07T02:01:00Z');
  const days = storeHistoryDays({ outDir: root, checkId: 'reviews', storeKey: 'A', now: new Date('2026-09-07T12:00:00Z') });
  assert.deepEqual(days.map((day) => [day.date, day.runs.map((run) => run.runId)]), [
    ['2026-09-06', ['night']], ['2026-09-07', ['morning', 'rerun']],
  ]);
  assert.equal(days[0].runs[0].results[0].items[0].date, '2026-08-20');
  assert.ok(days.flatMap((day) => day.runs).every((run) => run.results.length === 1 && run.results[0].storeKey === 'A'));
  assert.deepEqual(storeHistoryDays({ outDir: root, checkId: 'reviews', storeKey: 'missing' }), []);
});

test('history item pagination reaches beyond 500 records, including empty result records', () => {
  const items = Array.from({ length: 523 }, (_, n) => ({ title: 'review-' + n }));
  const run = { results: [{ storeKey: 'A', items }, { storeKey: 'A', status: 'UNKNOWN', items: [] }] };
  const all = [];
  for (let page = 1; page <= 27; page++) all.push(...historyRecordsPage(run, page).records);
  assert.equal(all.length, 524);
  assert.equal(all[522].item.title, 'review-522');
  assert.equal(all[523].item, null);
  assert.equal(all[523].result.status, 'UNKNOWN');
  assert.equal(historyRecordsPage(run, 900).page, 27);
  assert.deepEqual(historyRecordsPage(null).records, []);
});

test('history date validation rejects malformed and impossible calendar dates', () => {
  for (const date of ['2026-02-29', '2026-09-31', '../reviews', '2026-9-7', null]) assert.equal(validHistoryDate(date), false);
  for (const date of ['2024-02-29', '2026-09-07']) assert.equal(validHistoryDate(date), true);
});
