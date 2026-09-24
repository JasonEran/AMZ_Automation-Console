import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DEFAULTS, deepMerge } from '../src/lib/config.js';
import { storeConcurrencyLimit } from '../src/lib/check-runner.js';

test('ads-status concurrency stays off the global store cap', () => {
  const config = deepMerge(DEFAULTS, {
    ziniao: { concurrency: 1 },
    adsStatus: { concurrency: 2 },
  });
  assert.equal(storeConcurrencyLimit({
    checkId: 'ads-status', config, opts: { concurrency: config.ziniao.concurrency },
  }), 2);
  for (const checkId of ['store-health', 'performance', 'reviews', 'asin-health', 'inbox']) {
    assert.equal(storeConcurrencyLimit({
      checkId, config, opts: { concurrency: config.ziniao.concurrency },
    }), 1, checkId);
  }
});

test('a missing or invalid ads cap falls back to the global cap', () => {
  const config = deepMerge(DEFAULTS, { ziniao: { concurrency: 1 }, adsStatus: { concurrency: 0 } });
  assert.equal(storeConcurrencyLimit({ checkId: 'ads-status', config, opts: { concurrency: 1 } }), 1);
  assert.equal(storeConcurrencyLimit({
    checkId: 'ads-status',
    config: { ziniao: { concurrency: 1 } },
    opts: { concurrency: 1 },
  }), 1);
});

test('the measured visit pause is 200 ms and the other waits stay', () => {
  const src = fs.readFileSync(new URL('../src/lib/ads-portfolio-collector.js', import.meta.url), 'utf8');
  const visitStart = src.indexOf('const visit = async');
  const visitEnd = src.indexOf('await visit(LIST_URL)');
  assert.ok(visitStart > 0 && visitEnd > visitStart);
  const visit = src.slice(visitStart, visitEnd);
  assert.match(visit, /await sleep\(200\);/);
  assert.doesNotMatch(visit, /await sleep\(2000\)/);
  assert.match(src, /await sleep\(2000\);/);
  assert.match(src, /timeoutMs = 45000/);
  assert.match(src, /verifyPortfolioPage/);
});
