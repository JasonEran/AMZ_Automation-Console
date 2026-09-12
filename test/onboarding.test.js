import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECK_IDS } from '../src/checks/registry.js';
import { OPERATOR_LESSONS, normalizeTourRecord } from '../src/web/onboarding.js';

test('operator curriculum covers all nine checks once and includes evidence, upload and handoff', () => {
  const ids = OPERATOR_LESSONS.map((lesson) => lesson.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(OPERATOR_LESSONS.flatMap((lesson) => lesson.checks || []).sort(), [...CHECK_IDS].sort());
  for (const topic of ['evidence', 'upload', 'handoff', 'account', 'routine']) assert.ok(ids.includes(topic));
});

test('saved learning progress discards stale, duplicate and unknown lesson records', () => {
  const normalized = normalizeTourRecord({ version: 1, current: 'deleted-lesson', completed: ['risk', 'risk', 'unknown', null, 'voice'] }, OPERATOR_LESSONS);
  assert.equal(normalized.current, 'overview');
  assert.deepEqual(normalized.completed, ['risk', 'voice']);
  for (const value of [null, 'broken', { version: 0, current: 'risk', completed: ['voice'] }]) {
    assert.deepEqual(normalizeTourRecord(value, OPERATOR_LESSONS), { version: 1, current: 'overview', completed: [] });
  }
});

test('resume preserves the actual current lesson without marking skipped lessons complete', () => {
  const record = { version: 1, current: 'upload', completed: ['overview', 'risk'] };
  const normalized = normalizeTourRecord(record, OPERATOR_LESSONS);
  assert.deepEqual(normalized, record);
  normalized.completed.push('upload');
  assert.deepEqual(record.completed, ['overview', 'risk'], 'normalization must not mutate stored input');
  assert.equal(normalized.completed.includes('voice'), false);
});
