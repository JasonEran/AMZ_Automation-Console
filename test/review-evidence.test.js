import assert from 'node:assert/strict';
import test from 'node:test';
import {reviewEvidencePages,latestReviewEvidence,reviewDateSummary} from '../src/lib/review-evidence.js';

test('legacy reports bind only their known last-page rows and never fabricate a first-page screenshot',()=>{
  const result={check:'reviews',checkedAt:'2026-09-11T07:40:00Z',screenshot:'old.png',
    items:[{identifier:'RNEW',date:'2026年9月3日'}],evidence:{dom:{
      pages:[{page:1,count:1},{page:2,count:1}],notes:['原始截图为最后一页，结构化结果和原始文本覆盖全部低星分页。'],
      lowReviews:[{reviewId:'RNEW',date:'2026年9月3日'},{reviewId:'ROLD',date:'2026年7月7日'}]}}};
  const pages=reviewEvidencePages(result);
  assert.equal(pages.length,1);assert.equal(pages[0].page,2);assert.equal(pages[0].pages,2);
  assert.equal(pages[0].legacy,true);assert.deepEqual(pages[0].reviewIds,['ROLD']);
  assert.equal(pages[0].newestDate,'2026-07-07');assert.equal(result.screenshot,'old.png');
  assert.equal(reviewEvidencePages({...result,evidence:{dom:{pages:result.evidence.dom.pages}}}).length,0);
});

test('primary evidence follows the newest owned review even when it is not on the first brand page',()=>{
  const pages=[{page:1,pages:2,reviewIds:['ROTHER'],newestDate:'2026-09-04',screenshot:'one.png'},
    {page:2,pages:2,reviewIds:['ROWN'],newestDate:'2026-09-03',screenshot:'two.png'}];
  const result={check:'reviews',items:[{identifier:'ROWN',date:'2026-09-03'}],evidence:{dom:{pages}}};
  const actual=reviewEvidencePages(result);assert(actual.every(p=>p.legacy===false));
  assert.equal(latestReviewEvidence(result,actual).screenshot,'two.png');
  actual[1].screenshot=null;assert.equal(latestReviewEvidence(result,actual).screenshot,null);
  assert.deepEqual(reviewDateSummary([{date:'2026年7月7日'},{date:'2026-09-03'},{date:'unknown'}]),
    {newestDate:'2026-09-03',oldestDate:'2026-07-07',undatedCount:1});
});
