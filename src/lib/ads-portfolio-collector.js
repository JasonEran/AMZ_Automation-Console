import { adsCheck } from '../checks/definitions.js';
import { ADS_PORTFOLIO_EXTRACTOR } from '../extractors/ads-portfolios.js';
import { adsDeliveryState, judgePortfolioAdvertising, parsePortfolioPageText, verifyPortfolioPage } from './ads-portfolio-verdict.js';
import { classifyLivePageSafety, classifyPageSafety, isTransientEmptyDocumentSafety, rawPageIdentity } from './page-safety.js';
import { sleep } from './time.js';

const LIST_URL = 'https://advertising.amazon.com/cm/portfolios';
const ROOT_WALK = 'var roots=[document],seen=[],all=[];for(var r=0;r<roots.length&&r<120;r++){if(seen.indexOf(roots[r])>=0)continue;seen.push(roots[r]);var ns=roots[r].querySelectorAll("*");for(var i=0;i<ns.length&&all.length<50000;i++){all.push(ns[i]);if(ns[i].shadowRoot)roots.push(ns[i].shadowRoot);}}';
const PAGINATION_CONTROL = ROOT_WALK
  + 'var hits=[];for(var j=0;j<all.length;j++){var e=all[j];if(e.tagName!=="INPUT"||e.getAttribute("id")!==arguments[0])continue;'
  + 'var p=e,inside=false;for(var d=0;p&&d<8;d++){if(p.getAttribute&&p.getAttribute("data-e2e-id")==="tablePagination")inside=true;p=p.parentElement;}'
  + 'if(inside)hits.push(e);}return hits;';
const SEARCH_CONTROL = ROOT_WALK
  + 'var hits=[];for(var i=0;i<all.length;i++){var e=all[i];if(e.tagName==="INPUT"&&e.getAttribute("type")==="search"&&e.getAttribute("id")===arguments[0])hits.push(e);}return hits;';
const SCROLL_TABLE = ROOT_WALK
  + 'var tables=[];for(var i=0;i<all.length;i++){var e=all[i];if(e.getAttribute("data-e2e-id")==="dataTableWrapper"&&e.getAttribute("id")===arguments[0])tables.push(e);}'
  + 'if(tables.length!==1)return null;var ns=tables[0].querySelectorAll("*");var result=[];for(var j=0;j<ns.length;j++){var e=ns[j];'
  + 'if(e.getAttribute("role")==="grid"&&e.getAttribute("aria-readonly")==="true"){e.scrollTop=arguments[1];result.push({top:e.scrollTop,max:Math.max(0,e.scrollHeight-e.clientHeight)});}}return result;';

function targetMatches(url, kind, portfolioId) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'advertising.amazon.com' && !parsed.port
      && !parsed.username && !parsed.password
      && parsed.pathname.replace(/\/$/, '') === (kind === 'list' ? '/cm/portfolios' : `/cm/portfolios/${portfolioId}`);
  } catch { return false; }
}

class UnsafePortfolioPage extends Error {
  constructor(safety) { super(`广告组合页面安全校验失败：${safety.code}`); this.safety = safety; }
}

async function gate(zn, storeId, kind, portfolioId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const safety = await classifyLivePageSafety({ zn, storeId });
    if (!targetMatches(rawPageIdentity(safety), kind, portfolioId)) {
      if (!safety.safe) throw new UnsafePortfolioPage(safety);
      throw new UnsafePortfolioPage({ ...safety, safe: false, code: 'ADS_PORTFOLIO_IDENTITY_MISMATCH' });
    }
    if (isTransientEmptyDocumentSafety(safety) && attempt < 2) {
      await sleep(500);
      continue; // No table read or control access until a new full gate passes.
    }
    if (!safety.safe) throw new UnsafePortfolioPage(safety);
    return safety;
  }
}

async function moveView({ zn, storeId, kind, portfolioId, page = null, top = null, search = null }) {
  const before = await gate(zn, storeId, kind, portfolioId);
  const tableId = kind === 'list' ? 'ALL_PORTFOLIOS' : 'SINGLE_PORTFOLIO';
  const driver = zn.session(storeId).driver;
  let scroll = null;
  if (search !== null) {
    if (typeof search !== 'string' || search.length > 40 || /[\u0000-\u001f\u007f]/.test(search)) throw new Error('广告组合搜索值无效');
    const elements = await driver.executeScript(SEARCH_CONTROL, `UCM-CM-APP:${tableId}:searchInput`);
    if (elements?.length !== 1 || !(await elements[0].isDisplayed()) || !(await elements[0].isEnabled())) {
      throw new Error('广告组合搜索控件不唯一或不可用');
    }
    const { Key } = await import('selenium-webdriver');
    const current = await gate(zn, storeId, kind, portfolioId);
    if (rawPageIdentity(current) !== rawPageIdentity(before)) throw new Error('广告组合清除搜索前地址发生变化');
    const keys = [Key.chord(process.platform === 'darwin' ? Key.COMMAND : Key.CONTROL, 'a'), Key.BACK_SPACE];
    if (search) keys.push(search);
    await elements[0].sendKeys(...keys, Key.ENTER);
  } else if (page !== null) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error('广告组合页码超出允许范围');
    const elements = await driver.executeScript(PAGINATION_CONTROL, `UCM-CM-APP:${tableId}:pagination-input`);
    if (elements?.length !== 1 || !(await elements[0].isDisplayed()) || !(await elements[0].isEnabled())) {
      throw new Error('广告组合分页控件不唯一或不可用');
    }
    const { Key } = await import('selenium-webdriver');
    const current = await gate(zn, storeId, kind, portfolioId);
    if (rawPageIdentity(current) !== rawPageIdentity(before)) throw new Error('广告组合翻页前地址发生变化');
    await elements[0].clear();
    await elements[0].sendKeys(String(page), Key.ENTER);
  } else {
    scroll = await driver.executeScript(SCROLL_TABLE, tableId, Math.max(0, Math.min(250000, Number(top) || 0)));
    if (!scroll?.length) throw new Error('广告组合只读表格滚动区不可用');
  }
  const after = await gate(zn, storeId, kind, portfolioId);
  if (rawPageIdentity(after) !== rawPageIdentity(before)) throw new Error('广告组合视图调整期间地址发生变化');
  await sleep(600);
  return scroll;
}

async function readWindow({ zn, storeId, kind, portfolioId, expectedStart, expectedPage, excludeIds, expectedSearch = '', timeoutMs = 45000 }) {
  let deadline = Date.now() + timeoutMs;
  let diagnostics = '';
  let searchReset = false;
  let lastEvidence = null;
  let repeatedRecords = false;
  do {
    const before = await gate(zn, storeId, kind, portfolioId);
    const dom = (await zn.execExtract(storeId, ADS_PORTFOLIO_EXTRACTOR)).result;
    const pageText = (await zn.content(storeId, { format: 'text' })).text || '';
    const after = await gate(zn, storeId, kind, portfolioId);
    if (rawPageIdentity(before) === rawPageIdentity(after)) {
      const actualSearch = dom?.searchValue ?? (dom?.searchEmpty ? '' : null);
      if (dom?.kind === kind && dom.searchCount === 1 && actualSearch !== expectedSearch && !searchReset) {
        // Apply the portfolio name scope on the list; clear every child table
        // search so campaigns without the portfolio's name suffix are included.
        await moveView({ zn, storeId, kind, portfolioId, search: expectedSearch });
        await sleep(2000);
        searchReset = true;
        deadline = Date.now() + timeoutMs;
        continue;
      }
      const txt = parsePortfolioPageText(pageText, kind);
      lastEvidence = { kind, portfolioId, dom, txt, pageText, safety: after };
      repeatedRecords = Boolean(excludeIds && dom?.rows?.some((row) => excludeIds.has(row.id)));
      if (dom?.kind === kind && (!expectedStart || dom.start === expectedStart)
        && (!expectedPage || dom.page === expectedPage) && !repeatedRecords
        && verifyPortfolioPage(dom, txt, { window: true, expectedSearch })
        && (!expectedSearch || dom.rows.every((row) => row.name.toLowerCase().includes(expectedSearch.toLowerCase())))) {
        return { dom, txt, pageText, safety: after };
      }
      diagnostics = JSON.stringify({ kind, portfolioId, paginationText: dom?.paginationText?.slice(0, 200), filterLabel: txt.filterLabel,
        domRows: dom?.rows?.length, textRows: txt.rows.length, start: dom?.start,
        end: dom?.end, total: dom?.total, page: dom?.page, searchEmpty: dom?.searchEmpty, searchCount: dom?.searchCount,
        domComplete: dom?.sliceComplete, textComplete: txt.sliceComplete, scopeVerified: txt.scopeVerified,
        notReadyReason: dom?.notReadyReason });
    }
    await sleep(1500);
  } while (Date.now() < deadline);
  const error = new Error(repeatedRecords ? '广告组合翻页出现重复记录，无法证明覆盖完整'
    : `广告组合表格未取得同页双路完整证据 ${diagnostics}`);
  error.portfolioEvidence = lastEvidence;
  throw error;
}

function mergeWindow(domRows, textRows, window) {
  for (let index = 0; index < window.dom.rows.length; index++) {
    const row = window.dom.rows[index];
    const text = { ...window.txt.rows[index], id: row.id };
    const prior = domRows.get(row.id);
    if (prior && (prior.name !== row.name || prior.statusText !== row.statusText || prior.toggle !== row.toggle || prior.index !== row.index)) {
      throw new Error('广告组合在滚动读取期间发生排序或状态变化，已丢弃本次汇总');
    }
    domRows.set(row.id, row);
    textRows.set(row.id, text);
  }
}

export async function collectPortfolioTable({ zn, storeId, kind, portfolioId = null, logger, readTimeoutMs = 45000, nameContains = '' }) {
  const allDom = [], allText = [], ids = new Set();
  const read = (options = {}) => readWindow({ zn, storeId, kind, portfolioId,
    timeoutMs: readTimeoutMs, excludeIds: ids, expectedSearch: kind === 'list' ? nameContains : '', ...options });
  let start = 1, expectedTotal = null, last = null;
  for (let page = 1; page <= 100; page++) {
    last = await read({ expectedStart: page === 1 ? null : start });
    if (page === 1 && last.dom.start !== 1 && last.dom.total !== 0) {
      const oldIds = new Set(last.dom.rows.map((row) => row.id));
      await moveView({ zn, storeId, kind, portfolioId, page: 1 });
      last = await read({ expectedPage: 1, expectedStart: 1, excludeIds: oldIds });
    }
    if (last.dom.grids?.some((grid) => grid.top > 0)) {
      await moveView({ zn, storeId, kind, portfolioId, top: 0 });
      last = await read({ expectedPage: page, expectedStart: start });
    }
    if (expectedTotal === null) expectedTotal = last.dom.total;
    if (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0 || expectedTotal > 5000 || last.dom.total !== expectedTotal) {
      throw new Error('广告组合翻页期间总数变化或超过读取上限');
    }
    const wanted = expectedTotal === 0 ? 0 : last.dom.end - last.dom.start + 1;
    const pageDom = new Map(), pageText = new Map();
    mergeWindow(pageDom, pageText, last);
    let previousTop = -1;
    for (let step = 1; pageDom.size < wanted && step <= 100; step++) {
      const scroll = await moveView({ zn, storeId, kind, portfolioId, top: step * 500 });
      const top = Math.max(...scroll.map((r) => r.top));
      if (top === previousTop) throw new Error('广告组合表格已滚动到底，但仍有未读取记录');
      previousTop = top;
      last = await read({ expectedStart: start, expectedPage: page });
      if (last.dom.total !== expectedTotal) throw new Error('广告组合滚动期间总数变化');
      mergeWindow(pageDom, pageText, last);
    }
    const ordered = [...pageDom.values()].sort((a, b) => a.index - b.index);
    if (ordered.length !== wanted || ordered.some((row, index) => index && row.index !== ordered[index - 1].index + 1)) {
      throw new Error('广告组合当前页记录存在缺口');
    }
    for (const row of ordered) {
      if (ids.has(row.id)) throw new Error('广告组合翻页出现重复记录，无法证明覆盖完整');
      ids.add(row.id); allDom.push(row); allText.push(pageText.get(row.id));
    }
    if (last.dom.end === expectedTotal) {
      if (allDom.length !== expectedTotal) throw new Error('广告组合累计记录数与页脚总数不一致');
      return { dom: allDom, txt: allText, total: expectedTotal, last };
    }
    start = last.dom.end + 1;
    logger.info(`[ads-status] ${kind === 'list' ? '广告组合' : portfolioId} 已读取 ${allDom.length}/${expectedTotal}，继续下一页`);
    await moveView({ zn, storeId, kind, portfolioId, page: page + 1 });
    await moveView({ zn, storeId, kind, portfolioId, top: 0 });
  }
  throw new Error('广告组合分页超过 100 页，停止汇总');
}

export async function probePortfolioAdvertising({ zn, store, config, logger }) {
  if (typeof zn.session !== 'function') throw new Error('广告组合双页面采集需要紫鸟官方 WebDriver 传输层');
  const keyword = String(store.adsNameContains || '').trim();
  if (!keyword) throw new Error('未配置广告组合名称特征');
  let storeId;
  const trail = [];
  try {
    const opened = await zn.storeOpen({ id: store.id || undefined, name: store.id ? undefined : store.name,
      market: store.market, url: 'https://sellercentral.amazon.com/home', headless: config.ziniao.headless,
      timeoutMs: config.ziniao.openTimeoutMs });
    storeId = opened.storeId;
    const visit = async (url) => {
      await zn.visit(storeId, url, { timeoutMs: 120000 });
      await sleep(2000);
      await zn.selectAdvertisingAccount?.(storeId, { timeoutMs: 45000 });
    };
    await visit(LIST_URL);
    const list = await collectPortfolioTable({ zn, storeId, kind: 'list', logger, nameContains: keyword });
    const selected = list.dom.filter((row) => row.name.toLowerCase().includes(keyword.toLowerCase()));
    if (!selected.length) throw new Error('未找到匹配名称特征的广告组合，拒绝扩大到全账户');
    const portfolios = [], textPortfolios = [];
    let last = list.last;
    for (const [index, row] of selected.entries()) {
      if (!/^[A-Za-z0-9]+$/.test(row.id)) throw new Error('广告组合标识无效');
      await visit(`${LIST_URL}/${row.id}`);
      const detail = await collectPortfolioTable({ zn, storeId, kind: 'detail', portfolioId: row.id, logger });
      portfolios.push({ ...row, campaigns: detail.dom });
      const textRow = list.txt.find((r) => r.id === row.id);
      textPortfolios.push({ ...textRow, campaigns: detail.txt });
      trail.push({ portfolioId: row.id, portfolioName: row.name, campaigns: detail.total, complete: true });
      logger.info(`[ads-status/${store.key}] 已核对组合 ${index + 1}/${selected.length}：${row.name}，${detail.total} 个活动`);
      last = detail.last;
    }
    // A parent can be paused while its children retain enabled switches.
    // Re-read the parent inventory/status after the child traversal so an
    // operator's mid-run change cannot be silently combined with old parents.
    await visit(LIST_URL);
    const finalList = await collectPortfolioTable({ zn, storeId, kind: 'list', logger, nameContains: keyword });
    const finalSelected = finalList.dom.filter((row) => row.name.toLowerCase().includes(keyword.toLowerCase()));
    if (finalSelected.length !== selected.length || selected.some((row) => {
      const current = finalSelected.find((r) => r.id === row.id);
      return !current || current.name !== row.name || adsDeliveryState(current.statusText) !== adsDeliveryState(row.statusText);
    })) throw new Error('广告活动读取期间组合范围或状态变化，需重新采集');
    last = finalList.last;
    const dom = { landed: true, complete: true, nameContains: keyword, portfolios };
    const txt = { landed: true, complete: true, portfolios: textPortfolios };
    const safety = classifyPageSafety({ currentUrl: rawPageIdentity(last.safety), dom, txt, pageText: last.pageText });
    return { storeId, trail, screenshot: null, rawTextFile: null,
      best: { url: safety.currentUrl, dom, txt, pageText: '', safety, ready: true, readWasLiveSafe: true, landedBeforeSafety: true } };
  } catch (error) {
    if (error instanceof UnsafePortfolioPage && storeId && !isTransientEmptyDocumentSafety(error.safety)) {
      return { storeId, trail: [], screenshot: null, rawTextFile: null,
        best: { url: error.safety.currentUrl, dom: null, txt: null, pageText: '', safety: error.safety, ready: false } };
    }
    if (storeId) try { await zn.storeClose(storeId); } catch { /* compensate before retry */ }
    throw error;
  }
}

export const adsPortfolioCheck = {
  ...adsCheck,
  requirement: '按组合名称限定范围，联合核对组合与活动；每店超过 50% 符合时段预期即正常，少数例外留档，多数不符告警',
  probe: probePortfolioAdvertising,
  judge: judgePortfolioAdvertising,
  retryFreshSessionWhenNotReady: false,
  maxAttempts: 2,
};
