import { calendarDateKey, reviewsByDate } from '../checks/definitions.js';

export const isReviewResult = result => result.check === 'reviews' || Array.isArray(result.evidence?.dom?.lowReviews);

export function reviewDateSummary(items = []) {
  const dates=items.map(item=>calendarDateKey(item.date)).filter(Boolean).sort();
  return {newestDate:dates.at(-1)||null,oldestDate:dates[0]||null,undatedCount:items.length-dates.length};
}

/** Existing evidence remains immutable. Only the old collector's explicit
 * last-page note permits associating a legacy screenshot with that page. */
export function reviewEvidencePages(result) {
  if(!isReviewResult(result))return [];
  const dom=result.evidence?.dom||{},pages=dom.pages||[];
  if(pages.some(page=>Object.hasOwn(page,'screenshot'))){
    return pages.map(page=>({...page,legacy:false}));
  }
  if(!result.screenshot || !pages.length || !dom.notes?.some(note=>note.includes('原始截图为最后一页')))return [];
  const last=pages.at(-1),offset=pages.slice(0,-1).reduce((sum,page)=>sum+page.count,0);
  const rows=(dom.lowReviews||[]).slice(offset,offset+last.count);
  return [{...last,pages:pages.length,screenshot:result.screenshot,capturedAt:result.checkedAt,
    reviewIds:rows.map(row=>row.reviewId||row.identifier).filter(Boolean),
    ...reviewDateSummary(rows),legacy:true}];
}

export function latestReviewEvidence(result,pages) {
  const item=reviewsByDate(result.items||[])[0];
  // If the newest owned review has no screenshot, do not substitute an older
  // row's image and label it as the newest review's evidence.
  const corresponding=pages.find(page=>page.reviewIds?.includes(item?.identifier||item?.reviewId));
  return corresponding || [...pages].sort((a,b)=>(b.newestDate||'').localeCompare(a.newestDate||''))[0] || null;
}
