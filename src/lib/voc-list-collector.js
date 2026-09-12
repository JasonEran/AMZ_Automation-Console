import { approvedAmazonUrl } from './amazon-url.js';
import { classifyLivePageSafety, rawPageIdentity } from './page-safety.js';
import { redactText } from './redact.js';

const asinSet = rows => [...new Set(rows)].sort();
const rowKey = row => JSON.stringify([row.asin, row.detailUrl || '', row.raw || '']);

function vocPagination(dom, txt) {
  if (dom?.pagination) return dom.pagination;
  // A single-page VOC list can omit the pager entirely. Completeness still
  // needs the independent visible offer total to equal every structured row;
  // an absent/malformed count or a short first page cannot use this path.
  const total = txt?.listingTotal;
  if (dom?.paginationHostCount === 0 && Number.isSafeInteger(total) && total >= 0
    && dom.rows?.length === total) {
    return { page: 1, total, pageSize: Math.max(1, total), source: 'single-page-total' };
  }
  return null;
}

/** Page totals count offers, not ASINs: two SKUs can share an ASIN. */
export function verifyVocListPage(dom, txt, { page, total, pageSize } = {}) {
  const p = vocPagination(dom, txt);
  if (!p || dom?.landed !== true || txt?.landed !== true
    || !Number.isSafeInteger(p.page) || p.page < 1
    || !Number.isSafeInteger(p.pageSize) || p.pageSize < 1
    || !Number.isSafeInteger(p.total) || p.total < 0
    || txt.listingTotal !== p.total
    || (page !== undefined && p.page !== page)
    || (total !== undefined && p.total !== total)
    || (pageSize !== undefined && p.pageSize !== pageSize)) return false;
  const pages = Math.max(1, Math.ceil(p.total / p.pageSize));
  const rows = dom.rows || [];
  if (p.page > pages || rows.length !== Math.min(p.pageSize, p.total - (p.page - 1) * p.pageSize)) return false;
  if (p.total === 0) return dom.zeroResults === true && txt.zeroResults === true && !(txt.asins || []).length;
  if (!rows.every(row => /^B0[A-Z0-9]{8}$/.test(row.asin))
    || new Set(rows.map(rowKey)).size !== rows.length) return false;
  return JSON.stringify(asinSet(rows.map(row => row.asin))) === JSON.stringify(asinSet(txt.asins || []));
}

/** Bounded, read-only navigation of the exact live-observed VOC pager. */
export async function selectVocListPage(zn, storeId, targetPage, expected) {
  const before = await classifyLivePageSafety({ zn, storeId });
  const url = approvedAmazonUrl(rawPageIdentity(before));
  if (!before.safe || !url?.hostname.startsWith('sellercentral.')
    || !/^\/voice-of-the-customer(?:\/ref_?=[^/]+)?\/?$/.test(url.pathname)) {
    throw new Error('VOC 翻页前页面身份或安全校验失败');
  }
  if (!Number.isSafeInteger(targetPage) || targetPage < 1
    || targetPage > Math.ceil(expected.total / expected.pageSize)) throw new Error('VOC 目标页码无效');
  if (typeof zn.session !== 'function') throw new Error('当前传输层不支持已验证的 VOC 分页控件');
  const { By } = await import('selenium-webdriver');
  const { driver } = zn.session(storeId);
  const hosts = await driver.findElements(By.css('#listing-table-pagination kat-pagination'));
  if (hosts.length !== 1) throw new Error('VOC 分页控件不唯一');
  const host = hosts[0];
  for (const [attribute, value] of [['page', expected.page], ['items-per-page', expected.pageSize], ['total-items', expected.total]]) {
    if (await host.getAttribute(attribute) !== String(value)) throw new Error('VOC 翻页前列表总数或页码已变化');
  }
  const shadow = await host.getShadowRoot();
  // Native Selenium can reach this closed shadow root; no synthetic events or
  // arbitrary page script is used to change the selected page.
  const selector = targetPage === expected.page + 1
    ? '[part="pagination-nav-right"]' : `li[data-page="${targetPage}"]`;
  const controls = await shadow.findElements(By.css(selector));
  if (controls.length !== 1 || !await controls[0].isDisplayed() || !await controls[0].isEnabled()
    || await controls[0].getAttribute('tabindex') !== '0') throw new Error('VOC 目标分页控件不可用');
  const preClick = await classifyLivePageSafety({ zn, storeId });
  if (!preClick.safe || rawPageIdentity(preClick) !== rawPageIdentity(before)) throw new Error('VOC 翻页前页面身份已变化');
  await controls[0].click();
}

/** readPage performs independent DOM/text reads with the live safety gates. */
export async function collectVocList({ initialEvidence, readPage, selectPage, maxPages = 40, logger }) {
  let current = initialEvidence;
  const pages = [];
  const fail = error => {
    logger?.warn?.(`[voc] 分页证据未完整：${redactText(error)}`);
    return {
      ...current, ready: false,
      dom: current.dom ? { ...current.dom, listCoverage: { complete: false, pagesRead: pages.length, error: redactText(error) } } : null,
    };
  };
  try {
    const first = vocPagination(current.dom, current.txt);
    if (!verifyVocListPage(current.dom, current.txt)) return fail('VOC 当前页的条数、总数或 DOM/文本 ASIN 集合不一致');
    const total = first.total, pageSize = first.pageSize, count = Math.max(1, Math.ceil(total / pageSize));
    if (count > maxPages) return fail('VOC 页数超出安全上限');
    if (first.page !== 1) {
      await selectPage(1, first);
      current = await readPage({ page: 1, total, pageSize });
    }
    const seenRows = new Set();
    for (let page = 1; page <= count; page++) {
      if (current.liveSafety?.safe !== true) return current;
      if (!verifyVocListPage(current.dom, current.txt, { page, total, pageSize })) {
        return fail('VOC 分页未完成或翻页期间列表总数发生变化');
      }
      for (const row of current.dom.rows) {
        const key = rowKey(row);
        if (seenRows.has(key)) return fail('VOC 翻页重复出现相同商品记录，不能确认列表完整');
        seenRows.add(key);
      }
      pages.push(current);
      logger?.info?.(`[voc] 已核对第 ${page}/${count} 页，累计 ${seenRows.size}/${total} 条商品记录`);
      if (page < count) {
        await selectPage(page + 1, { page, total, pageSize });
        current = await readPage({ page: page + 1, total, pageSize });
      }
    }
    const rows = pages.flatMap(p => p.dom.rows);
    if (rows.length !== total) return fail('VOC 全部分页的记录总数不一致');
    const asins = asinSet(pages.flatMap(p => p.txt.asins));
    const poorAsins = asinSet(pages.flatMap(p => [...(p.dom.poorAsins || []), ...(p.txt.poorAsins || [])]));
    return {
      ...current, ready: true,
      pageText: pages.map(p => p.pageText).join('\n\n'),
      dom: {
        ...current.dom, rows, poorAsins, poorCount: poorAsins.length,
        headerMappedRowCount: pages.reduce((n, p) => n + Number(p.dom.headerMappedRowCount || 0), 0),
        headerMappingCompleteRowCount: pages.reduce((n, p) => n + Number(p.dom.headerMappingCompleteRowCount || 0), 0),
        headerMissingColumns: [...new Set(pages.flatMap(p => p.dom.headerMissingColumns || []))],
        listCoverage: { complete: true, total, rowCount: rows.length, asinCount: asins.length, pagesRead: pages.length, pageSize,
          ...(first.source ? { source: first.source } : {}) },
      },
      txt: {
        ...current.txt, asins, asinCount: asins.length, poorAsins, poorCount: poorAsins.length,
        cxRows: pages.flatMap(p => p.txt.cxRows || []),
        cxByAsin: Object.assign({}, ...pages.map(p => p.txt.cxByAsin || {})),
        listCoverage: { complete: true, total, pagesRead: pages.length },
      },
    };
  } catch (error) {
    return fail(error?.message || String(error));
  }
}
