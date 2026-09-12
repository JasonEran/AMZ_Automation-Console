import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calendarDateKey, reviewsByDate, reviewsCheck } from '../src/checks/definitions.js';
import { REVIEWS_EXTRACTOR } from '../src/extractors/checks.js';
import { e, makeEnv, NodeFilter } from '../src/selftest/dom-stub.js';
import { collectReviewsPages, judgeScopedReviews, parseReviewsPageText, verifyReviewsPage, waitForReviewsPage, probeReviews, sameReviewsEvidencePage, saveReviewsPageEvidence } from '../src/lib/reviews-collector.js';
import { classifyUrlSafety, isRecoverableBrowserInternalSafety, POST_SCREENSHOT_SAFETY_EXTRACTOR } from '../src/lib/page-safety.js';

function filters() {
  return { searchCount: 1, search: '', selectedStars: [1, 2, 3], starOptions: [1, 2, 3, 4, 5],
    orderLabel: '订单类型', timeLabel: '时间段', includeDone: true };
}

test('reviews preserves browser failure reasons for recovery without reading unsafe pages', async () => {
  for (const [url, recovery] of [
    ['chrome-extension://fcpbjhckgaeahjlhdgbdijpnkeigndfe/error.html', true],
    ['chrome-error://chromewebdata/', true],
    ['https://outside.example/error', false],
    ['https://sellercentral.amazon.com/ap/signin', false],
    ['https://sellercentral.amazon.com/home', false],
  ]) {
    const zn = {
      async storeOpen() { return { storeId: 'S' }; },
      async currentUrl() { return url; },
      async execExtract(_id, script) {
        assert.equal(script, POST_SCREENSHOT_SAFETY_EXTRACTOR);
        assert.equal(url, 'https://sellercentral.amazon.com/home', 'unsafe URLs must not read DOM');
        return { result: { probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true } };
      },
      session() { assert.fail('no review controls on unsafe or wrong pages'); },
      async content() { assert.fail('no business text from unsafe pages'); },
      async screenshot() { assert.fail('no screenshot from unsafe pages'); },
    };
    const p = await probeReviews({ zn, store: { key: 'S', name: 'Store' }, config: { ziniao: {} }, logger: {} });
    assert.equal(p.best.safety.safe, false);
    assert.equal(isRecoverableBrowserInternalSafety(p.best.safety), recovery, url);
    assert.equal(p.best.dom, null); assert.equal(p.best.txt, null); assert.equal(p.screenshot, null);
    if (url.endsWith('/home')) assert.equal(p.best.safety.code, 'REVIEWS_PAGE_IDENTITY_MISMATCH');
    if (url.endsWith('/ap/signin')) assert.equal(p.best.safety.authSensitive, true);
  }
});
function page(number, total = 12) {
  const count = Math.max(0, Math.min(10, total - (number - 1) * 10));
  const reviews = Array.from({ length: count }, (_, index) => ({
    reviewId: 'RREVIEW' + ((number - 1) * 10 + index), stars: index % 3 + 1,
    asin: 'B012345678', date: '2026-07-01', author: 'Buyer ' + index, source: 'kat-star-rating:value',
  }));
  const pageText = total + ' 条评论\n星级评定 (3)\n3 星\n2 星\n1 星\n时间段\n'
    + reviews.map((row) => row.stars + ' out of 5 stars').join('\n');
  return { dom: { filters: filters(), paginationCount: 1, pagination: { total, size: 10, page: number },
    total: count, lowCount: count, reviews, lowReviews: reviews }, txt: parseReviewsPageText(pageText), pageText };
}

test('reviews collects every low-star page and validates the independent counts', async () => {
  const moves = [];
  const result = await collectReviewsPages({ read: async (number) => page(number), move: async (number) => moves.push(number) });
  assert.equal(result.total, 12); assert.equal(result.reviews.length, 12);
  assert.deepEqual(moves, [2]); assert.equal(result.pages.length, 2);
  assert.equal(verifyReviewsPage(page(1).dom, page(1).txt, 1), true);
  const empty = page(1, 0);
  assert.equal(verifyReviewsPage(empty.dom, empty.txt, 1), true);
  assert.equal(verifyReviewsPage({ ...empty.dom, paginationCount: 0 }, empty.txt, 1), false);
});

test('reviews captures each verified page before moving, with exact row IDs and publication dates', async () => {
  const steps=[];
  const result=await collectReviewsPages({read:async n=>{steps.push('read'+n);const p=page(n);
    for(const row of p.dom.reviews)row.date=n===1?'2026年9月3日':'July 7, 2026';return p;},
    capture:async (snapshot,info)=>{steps.push('capture'+info.page);assert.equal(info.reviewIds[0],snapshot.dom.reviews[0].reviewId);return {screenshot:'page'+info.page+'.png'};},
    move:async n=>steps.push('move'+n)});
  assert.deepEqual(steps,['read1','capture1','move2','read2','capture2']);
  assert.deepEqual(result.pages.map(p=>[p.page,p.pages,p.newestDate,p.screenshot]),[[1,2,'2026-09-03','page1.png'],[2,2,'2026-07-07','page2.png']]);
  assert.equal(result.pages[0].reviewIds.length,10);assert.equal(result.pages[1].reviewIds.length,2);
});

test('unchanged URL cannot bind a screenshot after the page, row order or review content changes', () => {
  const expected=page(1).dom;
  assert.equal(sameReviewsEvidencePage(expected,structuredClone(expected)),true);
  assert.equal(sameReviewsEvidencePage(expected,page(2).dom),false);
  for(const key of ['reviewId','date','asin','stars','context']){
    const changed=structuredClone(expected);changed.reviews[0][key]='changed';
    assert.equal(sameReviewsEvidencePage(expected,changed),false,key);
  }
  const reversed=structuredClone(expected);reversed.reviews.reverse();
  assert.equal(sameReviewsEvidencePage(expected,reversed),false);
  assert.equal(sameReviewsEvidencePage(expected,null),false);
});

test('page screenshots survive exact row verification and are removed on a same-URL pagination race',async t=>{
  const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'amzguard-review-shots-'));
  t.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));
  for(const race of [false,true]){
    let captured=false,saved;
    const url='https://sellercentral.amazon.com/brand-customer-reviews/';
    const last={...page(1),safety:classifyUrlSafety(url)};
    const button={isDisplayed:async()=>true,isEnabled:async()=>true,click:async()=>{}};
    const zn={currentUrl:async()=>url,session:()=>({driver:{executeScript:async()=>[button]}}),
      execExtract:async (_id,script)=>({result:script===POST_SCREENSHOT_SAFETY_EXTRACTOR
        ?{probeVersion:1,looksLikeLogin:false,looksBlocked:false,liveDocument:true,traversalComplete:true}
        :race&&captured?page(2).dom:last.dom}),
      screenshot:async(_id,file)=>{captured=true;saved=file;fs.writeFileSync(file,'fixture-only');return {path:file};}};
    const run=()=>saveReviewsPageEvidence({zn,storeId:'S',store:{key:'S'},config:{outDir,storeHealth:{screenshot:true}},dirs:{shots:path.join(outDir,'shots')},stamp:String(race),last,page:1,logger:{warn(){}}});
    if(race){await assert.rejects(run(),error=>error.safety.code==='REVIEWS_EVIDENCE_PAGE_CHANGED');assert.equal(fs.existsSync(saved),false);}
    else{const result=await run();assert.equal(result.screenshot,saved);assert.match(saved,/_p1\.png$/);assert.ok(result.capturedAt);assert.equal(fs.statSync(saved).mode&0o777,0o600);}
  }
});

test('review dates sort newest first without changing source dates or dropping unknown dates', () => {
  const items=[{date:'2026年7月7日'},{date:null},{date:'September 3, 2026'},{date:'2026-02-30'},{date:'2026/09/02'}];
  const sorted=reviewsByDate(items);
  assert.deepEqual(sorted.map(r=>r.date),['September 3, 2026','2026/09/02','2026年7月7日',null,'2026-02-30']);
  assert.equal(items[0].date,'2026年7月7日');assert.equal(sorted[0],items[2]);
  assert.equal(calendarDateKey('2026-02-30'),null);assert.equal(calendarDateKey('2024年2月29日'),'2024-02-29');
});

test('reviews rejects restrictive filters, unchanged pages, duplicates, missing stars and count changes', async () => {
  for (const patch of [{ search: 'B012345678' }, { includeDone: false }, { timeLabel: '本周' },
    { orderLabel: '由我销售' }, { selectedStars: [1, 2, 4] }, { starOptions: [] }]) {
    const snapshot = page(1); snapshot.dom.filters = { ...filters(), ...patch };
    assert.equal(verifyReviewsPage(snapshot.dom, snapshot.txt, 1), false);
  }
  const first = page(1);
  assert.equal(verifyReviewsPage(first.dom, first.txt, 2), false);
  assert.equal(verifyReviewsPage(first.dom, { ...first.txt, selectedStars: [] }, 1), false);
  assert.equal(verifyReviewsPage(first.dom, { ...first.txt, total: 9 }, 1), false);
  await assert.rejects(collectReviewsPages({ read: async () => page(1), move: async () => {} }), /分页证据/);
  await assert.rejects(collectReviewsPages({ read: async (number) => page(number, number === 1 ? 12 : 13), move: async () => {} }), /总数/);
  const repeat = page(2); repeat.dom.reviews[0].reviewId = first.dom.reviews[0].reviewId;
  await assert.rejects(collectReviewsPages({ read: async (number) => number === 1 ? first : repeat, move: async () => {} }), /重复/);
});

test('reviews extractor binds long review cards and retains all 50 low-star rows', () => {
  const cards = Array.from({ length: 50 }, (_, index) => e('div', { 'data-testid': 'review-RTEST' + index }, {},
    e('div', {}, {}, e('kat-star-rating', { class: 'reviewRating', value: '2' }), 'Review by Alice on September 1, 2026'),
    e('div', { id: 'RTEST' + index + '-title' }, {}, 'Stopped working'),
    e('div', {}, {}, 'Long review content. '.repeat(300)),
    e('div', { class: 'asinDetail' }, {}, 'Parent ASIN B012345678 Child ASIN B012345678 Brand EXAMPLE',
      e('kat-star-rating', { value: '4.9' })),
  ));
  const body = e('body', {}, {}, 'Customer Reviews', cards);
  const env = makeEnv(body, { href: 'https://sellercentral.amazon.com/brand-customer-reviews/' });
  const dom = new Function('window', 'document', 'location', 'NodeFilter', REVIEWS_EXTRACTOR)(env.window, env.document, env.location, NodeFilter);
  assert.equal(dom.total, 50); assert.equal(dom.lowReviews.length, 50); assert.equal(dom.lowCount, 50);
  for (const [index, row] of dom.lowReviews.entries()) {
    assert.equal(row.reviewId, 'RTEST' + index); assert.equal(row.asin, 'B012345678');
    assert.equal(row.parentAsin, 'B012345678'); assert.equal(row.title, 'Stopped working');
    assert.equal(row.author, 'Alice'); assert.equal(row.date, 'September 1, 2026');
  }
  assert.equal(/[^\x00-\x7F]/.test(REVIEWS_EXTRACTOR), false);
  assert.doesNotMatch(REVIEWS_EXTRACTOR, /\b(?:const|let)\s|=>/);
});

function aggregate(items, complete = true) {
  return { landed: true, total: items.length, resultTotal: items.length, lowCount: items.length,
    lowReviews: items, reviews: items, emptyState: !items.length, selectedStars: [1, 2, 3], coverageComplete: complete,
    pages: [{ page: 1, complete }] };
}
const store = { key: 'A', market: 'US' };

test('delayed old reviews alert on first discovery, retain over 200 items, and cannot clear on partial coverage', () => {
  const items = Array.from({ length: 225 }, (_, n) => ({ stars: 2, reviewId: 'RDELAY' + n, asin: 'B012345678', date: '2026-07-01', author: 'Alice', source: 'dom' }));
  const dom = aggregate(items), txt = aggregate(items.map((item) => ({ stars: item.stars, source: 'pagetext' })));
  const fresh = judgeScopedReviews({ dom, txt, store });
  assert.equal(fresh.metrics.newLowCount, 225); assert.equal(fresh.items.length, 225);
  assert.equal(fresh.baselineEligible, true); assert.equal(fresh.severity, 'CRITICAL');
  const repeated = judgeScopedReviews({ dom, txt, store, prev: { metrics: fresh.metrics } });
  assert.equal(repeated.metrics.newLowCount, 0); assert.equal(repeated.status, 'RECORDED_LOW_REVIEW');
  const partial = judgeScopedReviews({ dom: { ...dom, coverageComplete: false }, txt, store, prev: { metrics: fresh.metrics } });
  assert.equal(partial.ok, false); assert.equal(partial.baselineEligible, false); assert.equal(partial.severity, 'ERROR');
  const noScope = judgeScopedReviews({ dom: { total: 10, lowCount: 0 }, txt: { total: 10, lowCount: 0 }, store });
  assert.equal(noScope.ok, false); assert.equal(noScope.severity, 'ERROR');
});

test('review ID upgrade preserves prior event identity with store ownership filtering', () => {
  const priorRow = { stars: 2, asin: 'B012345678', parentAsin: 'B012345678', date: '2026-07-01', author: 'Alice', title: null, source: 'dom' };
  const reviewOwnership = { ready: true, storeAsins: new Set(['B012345678']), ownersByAsin: new Map([['B012345678', new Set(['A'])]]) };
  const prior = reviewsCheck.judge({ dom: aggregate([priorRow]), txt: aggregate([{ stars: 2 }]), store, reviewOwnership });
  const upgraded = { ...priorRow, reviewId: 'RREAL123', title: 'Stopped working' };
  const verdict = judgeScopedReviews({ dom: aggregate([upgraded]), txt: aggregate([{ stars: 2 }]), store, reviewOwnership, prev: { metrics: prior.metrics } });
  assert.equal(verdict.metrics.newLowCount, 0); assert.equal(verdict.status, 'RECORDED_LOW_REVIEW');
});

test('a previously discovered review remains archived after an intervening empty collection', () => {
  const row = { stars: 1, reviewId: 'RRETURNED', asin: 'B012345678', date: '2026-07-01', author: 'Alice', source: 'dom' };
  const first = judgeScopedReviews({ dom: aggregate([row]), txt: aggregate([{ stars: 1 }]), store });
  const empty = judgeScopedReviews({ dom: aggregate([]), txt: aggregate([]), store, prev: { metrics: first.metrics } });
  const returned = judgeScopedReviews({ dom: aggregate([row]), txt: aggregate([{ stars: 1 }]), store, prev: { metrics: empty.metrics } });
  assert.equal(returned.metrics.newLowCount, 0);
  assert.equal(returned.status, 'RECORDED_LOW_REVIEW');
});

test('reviews reopens a filter popup remounted closed by delayed list hydration', async () => {
  let opens = 0, reads = 0;
  const result = await waitForReviewsPage({ page: 1, reopen: async () => { opens++; }, wait: async () => {},
    read: async () => { const snapshot = page(1); reads++; if (reads === 1) { snapshot.dom.filters.selectedStars = []; snapshot.dom.filters.starOptions = []; snapshot.txt.selectedStars = []; } return snapshot; },
  });
  assert.equal(opens, 2); assert.equal(reads, 2);
  assert.equal(verifyReviewsPage(result.dom, result.txt, 1), true);
});
