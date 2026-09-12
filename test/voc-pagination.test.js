import assert from 'node:assert/strict';
import test from 'node:test';
import { collectVocList, selectVocListPage, verifyVocListPage } from '../src/lib/voc-list-collector.js';
import { vocCheck } from '../src/checks/definitions.js';
import { VOC_EXTRACTOR } from '../src/extractors/checks.js';
import { e, makeEnv, NodeFilter } from '../src/selftest/dom-stub.js';
import { POST_SCREENSHOT_SAFETY_EXTRACTOR } from '../src/lib/page-safety.js';

const A = 'B012345678', B = 'B087654321';
const row = (asin, sku) => ({ asin, raw: `${asin} ${sku}`, detailUrl: `https://sellercentral.amazon.com/voice-of-the-customer/details?asin=${asin}&sku=${sku}`, cxHealth: 'Good' });
const page = (number, rows, total = 3, pageSize = 2) => ({
  liveSafety: { safe: true }, ready: true, pageText: `VOC\n${total} Offer Listings\n${rows.map(r => r.asin).join('\n')}`,
  dom: { landed: true, listCoverageRequired: true, rows, pagination: { page: number, total, pageSize }, headerMappingCompleteRowCount: rows.length },
  txt: { landed: true, asins: [...new Set(rows.map(r => r.asin))], listingTotal: total },
});
const first = () => page(1, [row(A, 'SKU1'), row(A, 'SKU2')]);
const second = () => page(2, [row(B, 'SKU3')]);

test('VOC parses the observed offer count independently and extracts closed-shadow host attributes', () => {
  assert.equal(vocCheck.parseText('买家之声\n43 Offer Listings\n图片').listingTotal, 43);
  assert.equal(vocCheck.parseText('Voice of the Customer\n1,234 Offer Listings\nASIN').listingTotal, 1234);
  assert.equal(vocCheck.parseText('VOC\n43 Offer Listings\n42 Offer Listings').listingTotal, null);
  assert.equal(vocCheck.parseText('VOC 43 Offer Listings maybe').listingTotal, null);
  assert.equal(vocCheck.parseText('Voice of the Customer\n20 Offer Listings').zeroResults, false);
  const host = e('kat-pagination', { page: '1', 'items-per-page': '25', 'total-items': '43' });
  const body = e('body', {}, {}, 'Voice of the Customer', e('div', { id: 'listing-table-pagination' }, {}, host));
  const env = makeEnv(body);
  env.document.querySelectorAll = selector => body.querySelectorAll(selector);
  const run = () => new Function('document', 'window', 'location', 'NodeFilter', VOC_EXTRACTOR)(env.document, env.window, env.location, NodeFilter);
  assert.deepEqual(run().pagination, { page: 1, pageSize: 25, total: 43 });
  host.attrs['total-items'] = '';
  assert.equal(run().pagination, null);
  assert.equal(run().listCoverageRequired, true);
  assert.equal(/[^\x00-\x7f]/.test(VOC_EXTRACTOR), false);
});

test('VOC collects every offer across pages while retaining multiple SKUs of one ASIN', async () => {
  const clicked = [];
  const result = await collectVocList({ initialEvidence: first(), selectPage: async p => clicked.push(p), readPage: async () => second() });
  assert.deepEqual(clicked, [2]);
  assert.equal(result.dom.rows.length, 3);
  assert.equal(result.dom.headerMappingCompleteRowCount, 3);
  assert.deepEqual(result.txt.asins, [A, B]);
  assert.deepEqual(result.dom.listCoverage, { complete: true, total: 3, rowCount: 3, asinCount: 2, pagesRead: 2, pageSize: 2 });
  result.dom.details = [A, B].map(asin => ({ asin, dom: { landed: true, asinBound: true, detailRootMatched: true, asin }, txt: { landed: true, asinBound: true, asin } }));
  assert.equal(vocCheck.judge({ ...result, store: { key: 'test' } }).metrics.collectionStatus, 'COMPLETE');
  result.dom.listCoverage.complete = false;
  assert.equal(vocCheck.judge({ ...result, store: { key: 'test' } }).severity, 'ERROR', 'details alone cannot conceal missing list pages');
});

test('VOC rejects changing totals, repeated pages, duplicate offers and one-sided text evidence', async () => {
  for (const next of [first(), page(2, [row(B, 'SKU3')], 4), page(2, [row(A, 'SKU1')]), { ...second(), txt: { landed: true, asins: [A], listingTotal: 3 } }]) {
    const result = await collectVocList({ initialEvidence: first(), selectPage: async () => {}, readPage: async () => next });
    assert.notEqual(result.dom.listCoverage?.complete, true);
    assert.equal(result.ready, false);
  }
  const duplicate = page(1, [row(A, 'SKU1'), row(A, 'SKU1')], 2);
  assert.equal(verifyVocListPage(duplicate.dom, duplicate.txt), false);
  assert.equal(verifyVocListPage(first().dom, { ...first().txt, listingTotal: null }), false);
});

test('VOC starts from page one, bounds traversal and preserves unsafe-page suppression', async () => {
  const clicked = [];
  const result = await collectVocList({ initialEvidence: second(), selectPage: async p => clicked.push(p), readPage: async expected => expected.page === 1 ? first() : second() });
  assert.deepEqual(clicked, [1, 2]);
  assert.equal(result.dom.listCoverage.complete, true);
  const bounded = await collectVocList({ initialEvidence: first(), maxPages: 1, selectPage: async () => assert.fail('no click beyond bound') });
  assert.equal(bounded.dom.listCoverage.complete, false);
  const unsafe = { liveSafety: { safe: false, authSensitive: true }, dom: null, txt: null, pageText: '', ready: false };
  assert.equal(await collectVocList({ initialEvidence: first(), selectPage: async () => {}, readPage: async () => unsafe }), unsafe);
  const threw = await collectVocList({ initialEvidence: first(), selectPage: async () => { throw new Error('pager unavailable'); } });
  assert.equal(threw.dom.listCoverage.complete, false);
});

test('VOC zero results require pagination count and both independent empty states', async () => {
  const empty = page(1, [], 0);
  assert.equal(verifyVocListPage(empty.dom, empty.txt), false);
  empty.dom.zeroResults = empty.txt.zeroResults = true;
  const result = await collectVocList({ initialEvidence: empty });
  assert.equal(result.dom.listCoverage.complete, true);
  assert.equal(vocCheck.judge({ ...result, store: { key: 'test' } }).status, 'EMPTY');
});

test('a single VOC page without a pager still requires the independent total to match every offer', async () => {
  const single = page(1, [row(A, 'SKU1'), row(B, 'SKU2')], 2);
  single.dom.pagination = null;
  single.dom.paginationHostCount = 0;
  const result = await collectVocList({ initialEvidence: single, selectPage: async () => assert.fail('no pagination is needed') });
  assert.equal(result.dom.listCoverage.complete, true);
  assert.equal(result.dom.listCoverage.source, 'single-page-total');
  for (const total of [null, 3, 0]) assert.equal(verifyVocListPage(single.dom, { ...single.txt, listingTotal: total }), false);
  for (const hosts of [1, 2, undefined]) assert.equal(verifyVocListPage({ ...single.dom, paginationHostCount: hosts }, single.txt), false,
    'missing pagination is distinct from an ambiguous or malformed existing pager');
});

test('VOC navigation clicks only the verified pager and stops on changed counts or auth', async () => {
  let clicks = 0, auth = false, suffix = '';
  const attributes = { page: '1', 'items-per-page': '25', 'total-items': '43' };
  const control = { isDisplayed: async () => true, isEnabled: async () => true,
    getAttribute: async key => key === 'tabindex' ? '0' : null, click: async () => { clicks++; } };
  const zn = {
    currentUrl: async () => 'https://sellercentral.amazon.com/voice-of-the-customer'+suffix,
    execExtract: async (_store, script) => {
      assert.equal(script, POST_SCREENSHOT_SAFETY_EXTRACTOR);
      return { result: { probeVersion: 1, looksLikeLogin: auth, looksBlocked: false, liveDocument: true, traversalComplete: true } };
    },
    session: () => ({ driver: { findElements: async locator => {
      assert.equal(locator.value, '#listing-table-pagination kat-pagination');
      return [{ getAttribute: async key => attributes[key], getShadowRoot: async () => ({ findElements: async inner => {
        assert.equal(inner.value, '[part="pagination-nav-right"]'); return [control];
      } }) }];
    } } }),
  };
  const expected = { page: 1, pageSize: 25, total: 43 };
  await selectVocListPage(zn, 'store', 2, expected);
  assert.equal(clicks, 1);
  suffix = '/ref_=xx_voc_dnav_xx';
  await selectVocListPage(zn, 'store', 2, expected);
  assert.equal(clicks, 2, 'canonical Seller Central navigation suffix remains the approved VOC list');
  attributes['total-items'] = '44';
  await assert.rejects(selectVocListPage(zn, 'store', 2, expected), /已变化/);
  attributes['total-items'] = '43'; auth = true;
  await assert.rejects(selectVocListPage(zn, 'store', 2, expected), /安全校验失败/);
  assert.equal(clicks, 2);
});
