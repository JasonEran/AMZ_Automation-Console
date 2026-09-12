import fs from 'node:fs';
import path from 'node:path';
import { artifactPart } from './artifact-name.js';
import { redactText } from './redact.js';
import { cleanupFailureSafety, secureCleanupEvidenceSet, secureCleanupReportedEvidence, validateEvidenceArtifact } from './evidence-cleanup.js';
import { calendarDateKey, reviewsCheck } from '../checks/definitions.js';
import { classifyLivePageSafety, rawPageIdentity, verifyPageAfterScreenshot } from './page-safety.js';
import { sleep } from './time.js';

const REVIEWS_URL = 'https://sellercentral.amazon.com/brand-customer-reviews/';
const MAX_REVIEWS = 5000;
const sameStars = (values) => Array.isArray(values) && [...values].sort().join(',') === '1,2,3';

export function parseReviewsPageText(text) {
  const value = String(text || '');
  const base = reviewsCheck.parseText(value);
  const totals = [...value.matchAll(/^\s*([\d,]+)\s*(?:条评论|(?:customer )?reviews)\s*$/gim)];
  const scope = /(?:星级评定|star rating)\s*\(3\)([\s\S]{0,300}?)(?:时间段|time period)/i.exec(value);
  const selectedStars = scope ? [...scope[1].matchAll(/(?:^|\n)\s*([1-5])\s*(?:星|stars?)\s*(?=\n|$)/gi)].map((m) => Number(m[1])).sort() : [];
  return { ...base, selectedStars, resultTotal: totals.length === 1 ? Number(totals[0][1].replaceAll(',', '')) : null };
}

export function reviewsScopeVerified(dom, txt) {
  const f = dom?.filters;
  return Boolean(f && f.searchCount === 1 && f.search === '' && f.includeDone === true
    && /^(?:订单类型|order type)$/i.test(f.orderLabel || '')
    && /^(?:时间段|time period)$/i.test(f.timeLabel || '')
    && sameStars(f.selectedStars) && f.starOptions?.join(',') === '1,2,3,4,5'
    && sameStars(txt?.selectedStars));
}

export function verifyReviewsPage(dom, txt, expectedPage, excludeIds = new Set()) {
  if (!reviewsScopeVerified(dom, txt) || !Number.isSafeInteger(txt.resultTotal) || txt.resultTotal < 0 || txt.resultTotal > MAX_REVIEWS) return false;
  const p = dom.pagination;
  // An empty result still needs an explicit DOM total and independent text total.
  // A missing paginator is not evidence of zero reviews.
  if (dom.paginationCount !== 1 || !p || p.total !== txt.resultTotal || p.page !== expectedPage || ![10, 25, 50].includes(p.size)) return false;
  const wanted = Math.max(0, Math.min(p.size, p.total - (p.page - 1) * p.size));
  if (p.page < 1 || p.page > Math.max(1, Math.ceil(p.total / p.size))) return false;
  const rows = dom.reviews || [];
  if (dom.total !== wanted || dom.lowCount !== wanted || rows.length !== wanted || txt.total !== wanted || txt.lowCount !== wanted) return false;
  if (rows.some((row) => !/^R[A-Z0-9]+$/.test(row.reviewId || '') || ![1, 2, 3].includes(row.stars) || excludeIds.has(row.reviewId))) return false;
  if (new Set(rows.map((row) => row.reviewId)).size !== wanted) return false;
  const tally = (items) => [1, 2, 3].map((star) => items.filter((item) => item.stars === star).length).join(',');
  return tally(rows) === tally(txt.lowReviews || []);
}

async function gate(zn, storeId) {
  const safety = await classifyLivePageSafety({ zn, storeId });
  let correct = false;
  try {
    const url = new URL(rawPageIdentity(safety));
    correct = url.protocol === 'https:' && url.hostname === 'sellercentral.amazon.com' && !url.port && !url.username && !url.password
      && url.pathname.replace(/\/$/, '') === '/brand-customer-reviews';
  } catch { /* fail closed */ }
  if (!safety.safe || !correct) {
    const error = new Error(`Reviews 页面身份校验失败：${safety.code}`);
    // Preserve transport/authentication failures so the shared runner can
    // recognize a poisoned ZiNiao browser and perform its bounded restart.
    // A wrong but otherwise safe Amazon page is a separate identity failure.
    error.safety = !safety.safe ? safety
      : { ...safety, safe: false, code: 'REVIEWS_PAGE_IDENTITY_MISMATCH' };
    throw error;
  }
  return safety;
}

async function elements(zn, storeId, selector) {
  await gate(zn, storeId);
  return zn.session(storeId).driver.executeScript('return Array.prototype.slice.call(document.querySelectorAll(arguments[0]));', selector);
}
async function control(zn, storeId, selector) {
  const found = await elements(zn, storeId, selector);
  if (found.length !== 1 || !await found[0].isDisplayed() || !await found[0].isEnabled()) throw new Error('Reviews 只读筛选或分页控件不唯一/不可用');
  return found[0];
}
async function click(zn, storeId, selector) {
  const before = await gate(zn, storeId);
  const element = await control(zn, storeId, selector);
  await gate(zn, storeId);
  await element.click();
  const after = await gate(zn, storeId);
  if (new URL(rawPageIdentity(before)).origin !== new URL(rawPageIdentity(after)).origin) throw new Error('Reviews 筛选期间账户页面变化');
  await sleep(400);
}
const SEARCH = 'input[data-testid="search-box-input"]';
async function openStars(zn, storeId) {
  if (!(await elements(zn, storeId, '#filter-list-menu-stars')).length) await click(zn, storeId, '#stars-filter');
}
async function setScope(zn, storeId) {
  const driver = zn.session(storeId).driver;
  const { Key } = await import('selenium-webdriver');
  // Clear only the review toolbar's readonly filters, never row action links.
  const clear = await driver.executeScript('var bars=document.querySelectorAll("[data-testid=manage-reviews-top-bar-view]"),out=[];if(bars.length!==1)return out;var links=bars[0].querySelectorAll("kat-link");for(var i=0;i<links.length;i++){if(/^(?:清除筛选条件|clear filters)$/i.test(links[i].getAttribute("label")||""))out.push(links[i]);}return out;');
  if (clear.length > 1) throw new Error('Reviews 清除筛选控件不唯一');
  if (clear.length) { await gate(zn, storeId); await clear[0].click(); await sleep(1000); }
  const search = await control(zn, storeId, SEARCH);
  if (await search.getAttribute('value')) {
    await search.sendKeys(Key.chord(process.platform === 'darwin' ? Key.COMMAND : Key.CONTROL, 'a'), Key.BACK_SPACE, Key.ENTER);
    await sleep(1000);
  }
  await openStars(zn, storeId);
  for (const star of [1, 2, 3]) {
    const selected = await elements(zn, storeId, `#stars-item-${star} button[value]`);
    if (!selected.length) await click(zn, storeId, `#stars-item-${star} kat-button`);
  }
  await click(zn, storeId, SEARCH); // close the filter popup without changing its selection
  if (!(await elements(zn, storeId, '#includeDone-close')).length) await click(zn, storeId, '#includeDone-filter');
  await openStars(zn, storeId);
}
async function goPage(zn, storeId, page) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 500) throw new Error('Reviews 页码超过采集上限');
  await click(zn, storeId, SEARCH);
  const input = await control(zn, storeId, 'input[type="number"][min="1"]');
  const { Key } = await import('selenium-webdriver');
  await gate(zn, storeId);
  await input.clear(); await input.sendKeys(String(page), Key.ENTER);
  await sleep(1200);
  await openStars(zn, storeId);
}

export async function waitForReviewsPage({ read, reopen, page, ids = new Set(), timeoutMs = 45000, wait = sleep }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    // Applying a filter can finish loading after the popup was opened and
    // remount it closed. Re-open the observed readonly menu on each poll so
    // both paths can verify the actual three selections after hydration.
    await reopen();
    last = await read();
    if (verifyReviewsPage(last.dom, last.txt, page, ids)) return last;
    await wait(1200);
  } while (Date.now() < deadline);
  const error = new Error('Reviews 未取得完整同页双路证据：' + JSON.stringify({ page, actualPage: last?.dom?.pagination?.page,
    total: last?.txt?.resultTotal, dom: last?.dom?.total, text: last?.txt?.total, scope: reviewsScopeVerified(last?.dom, last?.txt) }));
  error.reviewEvidence = last;
  throw error;
}

async function readPage({ zn, storeId, page, ids, timeoutMs }) {
  return waitForReviewsPage({ page, ids, timeoutMs, reopen: () => openStars(zn, storeId), read: async () => {
    const before = await gate(zn, storeId);
    const dom = (await zn.execExtract(storeId, reviewsCheck.extractor)).result;
    const pageText = (await zn.content(storeId, { format: 'text' })).text || '';
    const txt = parseReviewsPageText(pageText);
    const safety = await gate(zn, storeId);
    if (rawPageIdentity(before) !== rawPageIdentity(safety)) throw new Error('Reviews 双路读取期间页面变化');
    return { dom, txt, pageText, safety };
  } });
}

/** Dependency seams allow pagination, duplicate detection and failure coverage
 * to be tested without contacting Amazon or modifying production state. */
export async function collectReviewsPages({ read, move, capture, logger }) {
  const ids = new Set(), pages = [], reviews = [], textReviews = [], rawPages = [];
  let expected = null, last;
  for (let page = 1; page <= 500; page++) {
    last = await read(page, ids);
    if (!verifyReviewsPage(last.dom, last.txt, page, ids)) throw new Error('Reviews 分页证据不完整或出现重复评论');
    const p = last.dom.pagination;
    if (expected === null) expected = { total: p.total, size: p.size };
    if (p.total !== expected.total || p.size !== expected.size) throw new Error('Reviews 翻页期间总数或每页条数变化，需重新采集');
    reviews.push(...last.dom.reviews); textReviews.push(...last.txt.lowReviews);
    rawPages.push(`PAGE ${page} / ${Math.max(1, Math.ceil(p.total / p.size))}\n${last.pageText || ''}`);
    last.dom.reviews.forEach((row) => ids.add(row.reviewId));
    const dates=last.dom.reviews.map(row=>calendarDateKey(row.date)).filter(Boolean).sort();
    const pageInfo={ page, pages: Math.max(1, Math.ceil(p.total / p.size)), total: p.total,
      count: last.dom.total, textCount: last.txt.total, complete: true,
      reviewIds: last.dom.reviews.map(row=>row.reviewId),
      oldestDate: dates[0] || null, newestDate: dates.at(-1) || null,
      undatedCount: last.dom.reviews.length - dates.length };
    const artifact=capture ? await capture(last,pageInfo) : {};
    pages.push({ ...pageInfo, ...artifact });
    logger?.info(`[reviews] 1～3 星已读取 ${reviews.length}/${p.total}（第 ${page} 页）`);
    if (page === Math.max(1, Math.ceil(p.total / p.size))) {
      if (reviews.length !== p.total) throw new Error('Reviews 累计数与筛选结果总数不一致');
      return { reviews, textReviews, pages, rawPages, total: p.total, last };
    }
    await move(page + 1);
  }
  throw new Error('Reviews 超过 500 页，不能判为正常');
}

export function judgeScopedReviews(args) {
  const verdict = reviewsCheck.judge(args);
  const dom = args.dom, txt = args.txt;
  const complete = dom?.coverageComplete === true && txt?.coverageComplete === true
    && sameStars(dom.selectedStars) && sameStars(txt.selectedStars)
    && dom.resultTotal === dom.total && txt.resultTotal === txt.total && dom.total === txt.total;
  verdict.metrics = { ...verdict.metrics, selectedStars: [1, 2, 3], paginationComplete: complete,
    pagesCollected: dom?.pages?.length || 0, resultTotal: dom?.resultTotal ?? null,
    collectionStatus: complete && verdict.metrics.collectionStatus === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL_EVIDENCE' };
  verdict.notes.push(complete ? '已筛选 1、2、3 星，覆盖所有时间、订单类型及已完成记录；按首次发现去重，不按评价发表日期忽略旧评价。Amazon 最多 72 小时的展示延迟仍适用。' : '目标为 1～3 星的完整范围，本次未完成筛选或分页验证。');
  verdict.baselineEligible = complete && verdict.baselineEligible;
  if (!complete) {
    verdict.ok = false;
    verdict.reasons.push('低星筛选或分页覆盖未完成，不能确认正常，也不更新归档基线');
    if (verdict.severity !== 'CRITICAL') { verdict.status = 'PARTIAL_EVIDENCE'; verdict.severity = 'ERROR'; }
  }
  return verdict;
}

// The URL stays unchanged while this SPA paginates. Bind a screenshot to its
// exact ordered review rows as well as the normal authentication/URL gates.
export function sameReviewsEvidencePage(expected, actual) {
  const identity=dom=>JSON.stringify({pagination:dom?.pagination,rows:(dom?.reviews||[]).map(row=>
    [row.reviewId,row.stars,row.asin,row.parentAsin,row.childAsin,row.date,row.title,row.context])});
  return Boolean(expected?.pagination && actual?.pagination && identity(expected)===identity(actual));
}

export async function saveReviewsPageEvidence({ zn, storeId, store, config, dirs, stamp, last, page, logger }) {
  let screenshot = null, capturedAt = null;
  await click(zn, storeId, SEARCH);
  const before = await gate(zn, storeId);
  if (rawPageIdentity(before) !== rawPageIdentity(last.safety)) throw new Error('Reviews 留存证据前页面变化');
  if (config.storeHealth.screenshot && dirs?.shots) {
    fs.mkdirSync(dirs.shots, { recursive: true, mode: 0o700 });
    const domBefore=(await zn.execExtract(storeId,reviewsCheck.extractor)).result;
    if(!sameReviewsEvidencePage(last.dom,domBefore))throw new Error('Reviews 截图前评论页已变化，拒绝关联错误证据');
    const target = path.join(dirs.shots, `reviews_${artifactPart(store.key)}_${stamp}_p${page}.png`);
    let shot, screenshotThrew = false;
    try { capturedAt=new Date().toISOString(); shot = await zn.screenshot(storeId, target, { fullPage: config.storeHealth.fullPageScreenshot }); }
    catch (error) { screenshotThrew = true; logger.warn(`[reviews/${store.key}] 截图失败：${redactText(error.message)}`); }
    const after = await verifyPageAfterScreenshot({ zn, storeId, expectedUrl: rawPageIdentity(before),
      dom: last.dom, txt: last.txt, pageText: last.pageText });
    let domAfter=null;
    if(after.safe)try{domAfter=(await zn.execExtract(storeId,reviewsCheck.extractor)).result;}catch{/* unverified screenshot is removed below */}
    const samePage=sameReviewsEvidencePage(last.dom,domAfter);
    if (after.safe && samePage && shot?.path && path.resolve(shot.path) === path.resolve(target)
      && validateEvidenceArtifact({ file: target, outDir: config.outDir }).ok) {
      screenshot = target; fs.chmodSync(target, 0o600);
    } else {
      const cleaned = screenshotThrew ? secureCleanupEvidenceSet({ files: [target], outDir: config.outDir })
        : secureCleanupReportedEvidence({ expectedFile: target, reportedFile: shot?.path, outDir: config.outDir });
      if (!cleaned.ok || !after.safe || !samePage) {
        const error = new Error('Reviews 截图后安全校验失败');
        error.safety = !cleaned.ok ? cleanupFailureSafety(after) : !samePage && after.safe
          ? {...after,safe:false,code:'REVIEWS_EVIDENCE_PAGE_CHANGED'} : after;
        throw error;
      }
    }
  }
  return {screenshot,capturedAt:screenshot?capturedAt:null};
}

async function saveReviewsRawText({ zn, storeId, store, config, dirs, stamp, rawPages }) {
  let rawTextFile=null;
  await gate(zn, storeId);
  if (config.storeHealth.saveRawPageText && dirs?.raw) {
    fs.mkdirSync(dirs.raw, { recursive: true, mode: 0o700 });
    rawTextFile = path.join(dirs.raw, `reviews_${artifactPart(store.key)}_${stamp}.txt`);
    fs.writeFileSync(rawTextFile, redactText(rawPages.join('\n\n')), { mode: 0o600 });
  }
  return rawTextFile;
}

export async function probeReviews({ zn, store, config, logger, dirs, stamp }) {
  if (typeof zn.session !== 'function') throw new Error('Reviews 低星分页采集需要紫鸟官方 WebDriver');
  let storeId;
  try {
    const opened = await zn.storeOpen({ id: store.id || undefined, name: store.id ? undefined : store.name,
      market: store.market, url: REVIEWS_URL, headless: config.ziniao.headless, timeoutMs: config.ziniao.openTimeoutMs });
    storeId = opened.storeId;
    const deadline = Date.now() + 45000;
    while (!(await elements(zn, storeId, '#stars-filter')).length && Date.now() < deadline) await sleep(1200);
    await gate(zn, storeId); await setScope(zn, storeId);
    const collected = await collectReviewsPages({
      read: (page, ids) => readPage({ zn, storeId, page, ids, timeoutMs: 45000 }),
      move: (page) => goPage(zn, storeId, page), logger,
      capture: (last,pageInfo) => saveReviewsPageEvidence({zn,storeId,store,config,dirs,stamp,last,page:pageInfo.page,logger}),
    });
    const { reviews, textReviews, total, pages, last, rawPages } = collected;
    const rawTextFile = await saveReviewsRawText({ zn, storeId, store, config, dirs, stamp, rawPages });
    const screenshot=[...pages].sort((a,b)=>(b.newestDate||'').localeCompare(a.newestDate||''))
      .find(page=>page.screenshot)?.screenshot || null;
    const common = { landed: true, total, lowCount: total, resultTotal: total, emptyState: total === 0,
      selectedStars: [1, 2, 3], coverageComplete: true };
    return { storeId, trail: pages.map((page) => ({ ...page })), screenshot, rawTextFile,
      best: { url: last.safety.currentUrl, dom: { ...common, selectedStars: [1, 2, 3], lowReviews: reviews, pages: pages.map((page) => ({ ...page })), notes: ['逐页保存原始截图并绑定评论 ID；评价发表日期与本次采集时间分别保留。'], average: null },
        txt: { ...common, selectedStars: [1, 2, 3], lowReviews: textReviews, pages: pages.map((page) => ({ ...page })) }, pageText: '', safety: last.safety,
        ready: true, readWasLiveSafe: true, landedBeforeSafety: true } };
  } catch (error) {
    if (error.safety && storeId) return { storeId, trail: [], screenshot: null, rawTextFile: null,
      best: { url: error.safety.currentUrl, safety: error.safety, dom: null, txt: null, pageText: '', ready: false } };
    if (storeId) try { await zn.storeClose(storeId); } catch { /* close before retry */ }
    throw error;
  }
}

export const scopedReviewsCheck = {
  ...reviewsCheck, probe: probeReviews, parseText: parseReviewsPageText, judge: judgeScopedReviews,
  requirement: '筛选 1、2、3 星并读完全部分页，按本店有效 ASIN 归属和首次发现判定；不以评价发表日期排除延迟出现的低星',
};
