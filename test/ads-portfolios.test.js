import assert from 'node:assert/strict';
import test from 'node:test';
import { adsDeliveryState, effectiveCampaignState, parsePortfolioPageText, judgePortfolioAdvertising,
  verifyPortfolioPage } from '../src/lib/ads-portfolio-verdict.js';
import { ADS_PORTFOLIO_EXTRACTOR } from '../src/extractors/ads-portfolios.js';
import { e } from '../src/selftest/dom-stub.js';
import { collectPortfolioTable } from '../src/lib/ads-portfolio-collector.js';
import { POST_SCREENSHOT_SAFETY_EXTRACTOR } from '../src/lib/page-safety.js';

const listText = ['广告组合', '筛选条件', '导出', '总计: 2', '状态', '广告活动预算金额', '预算开始日期', '预算结束日期',
  '组合甲/26', '组合乙/26', '正在投放', '已暂停', '转到页面', 'Numeric', '1 - 2 / 2 结果'].join('\n');
const detailText = ['组合甲/26', '状态: 正在投放', '筛选条件', '导出', '已启动', '广告活动名称', '总计: 2', '状态', '类型', '开始日期',
  'select', '活动甲', 'select', '活动乙', '已暂停', '详细信息', '商品推广', 'Date',
  '正在投放', '详细信息', '商品推广', 'Date', '转到页面', '1 - 2 / 2 结果'].join('\n');

test('a loading portfolio shell stays retryable without raising a transport script error', () => {
  const result = new Function('document', 'window', ADS_PORTFOLIO_EXTRACTOR)(e('body'), {});
  assert.equal(result.landed, false);
  assert.equal(result.sliceComplete, false);
  assert.equal(result.error, undefined);
});

test('portfolio text reads transposed columns and ignores the parent delivering label for child campaigns', () => {
  const list = parsePortfolioPageText(listText, 'list');
  assert.equal(list.complete, true);
  assert.deepEqual(list.rows.map(r => [r.name, r.delivery]), [['组合甲/26', 'DELIVERING'], ['组合乙/26', 'PAUSED']]);
  const detail = parsePortfolioPageText(detailText, 'detail');
  assert.equal(detail.complete, true);
  assert.deepEqual(detail.rows.map(r => r.delivery), ['PAUSED', 'DELIVERING']);
  assert.equal(parsePortfolioPageText(detailText.replace('总计: 2', '总计: 25'), 'detail').complete, false);
  assert.equal(parsePortfolioPageText(detailText.replace('活动乙', 'select'), 'detail').complete, false);
  assert.equal(parsePortfolioPageText(detailText.replace('筛选条件', '筛选条件\n状态：已启用'), 'detail').complete, false,
    'a residual status filter must not make paused campaigns disappear from a normal verdict');
  assert.equal(adsDeliveryState('日期范围内正在投放的广告总数'), 'UNKNOWN');
  assert.equal(adsDeliveryState('已存档'), 'ARCHIVED');
  assert.equal(effectiveCampaignState({ statusText: '正在投放' }, { statusText: '已存档', toggle: 'PAUSED' }), 'EXCLUDED');
});

test('a delivering portfolio never overrides a paused child and contradictory child evidence remains unknown', () => {
  const parent = { statusText: '正在投放' };
  assert.equal(effectiveCampaignState(parent, { statusText: '已暂停', toggle: 'PAUSED' }), 'OFF');
  assert.equal(effectiveCampaignState(parent, { statusText: '正在投放', toggle: 'PAUSED' }), 'UNKNOWN');
  assert.equal(effectiveCampaignState(parent, { statusText: '正在投放', toggle: 'ENABLED' }), 'ON');
  assert.equal(effectiveCampaignState({ statusText: '已暂停' }, { statusText: '正在投放', toggle: 'ENABLED' }), 'OFF');
  assert.equal(effectiveCampaignState(parent, { statusText: 'Out of budget', toggle: 'ENABLED' }), 'LIMITED');
});

test('singular Chinese and English result counts are not mistaken for campaign filters', () => {
  // Observed on WANG portfolios with exactly one campaign, 2026-09-07.
  for (const count of ['1 结果', '1 个结果', '1 result', '1 results']) {
    const text = ['广告组合', '单活动组合', '状态: 正在投放', 'Search', '筛选条件', count,
      '导出', '广告活动名称', '总计: 1', '状态', '类型', '开始日期',
      'select', '单条活动', '正在投放', '详细信息', '商品推广', 'Date',
      '转到页面', '1 - 1 / 1 结果'].join('\n');
    const parsed = parsePortfolioPageText(text, 'detail');
    const dom = { ...parsed, searchValue: '', rows: [{ id: 'C1', name: '单条活动', statusText: '正在投放', toggle: 'ENABLED' }] };
    assert.equal(verifyPortfolioPage(dom, parsed), true, count);
    assert.equal(parsed.rows[0].delivery, 'DELIVERING');
    for (const filter of ['状态：已启用', '状态 = 正在投放', '预算 > 0', '1 结果 已暂停']) {
      assert.equal(verifyPortfolioPage(dom, parsePortfolioPageText(text.replace(count, count+'\n'+filter), 'detail')), false,
        'accepting a count must not accept a restrictive filter: '+filter);
    }
  }
  assert.equal(parsePortfolioPageText(listText.replace('筛选条件', '筛选条件\n2 结果'), 'list').complete, true);
});

test('English UCM pagination and Filter by retain independent counts and reject restrictive filters', () => {
  // Observed in the chen-rui account on 2026-09-09. English UCM uses "of"
  // and non-breaking spaces in the footer, and "Filter by" in the toolbar.
  for (const kind of ['list', 'detail']) {
    const id = kind === 'list' ? 'ALL_PORTFOLIOS' : 'SINGLE_PORTFOLIO';
    const search = kind === 'list' ? '26' : '';
    const names = ['Item A/26', 'Item B/26'];
    const statuses = ['Delivering', 'Paused'];
    const makeDom = footer => {
      const cells = names.flatMap((name, index) => [
        e('div', { 'data-e2e-index': `cellIndex_${index}_2`, 'data-udt-column-id': 'name-cell' }, {},
          e('a', { id: `P${index}`, 'data-e2e-id': 'entityNameRenderer' }, {}, name)),
        e('div', { 'data-e2e-index': `cellIndex_${index}_0`, 'data-udt-column-id': 'status-cell' }, {}, statuses[index]),
        e('div', { 'data-e2e-index': `cellIndex_${index}_1`, 'data-udt-column-id': 'state-cell' }, {},
          e('button', { role: 'switch', 'aria-checked': String(index === 0) })),
      ]);
      const body = e('body', {}, {}, e('input', { id: `UCM-CM-APP:${id}:searchInput`, value: search }),
        e('div', { id, 'data-e2e-id': 'dataTableWrapper' }, {}, ...cells,
          e('div', { 'data-e2e-id': 'tablePagination' }, {},
            e('input', { id: `UCM-CM-APP:${id}:pagination-input`, value: '1' }), footer+' Results per page: 50')));
      return new Function('document', 'window', ADS_PORTFOLIO_EXTRACTOR)(body, { getComputedStyle: el => el.style });
    };
    const pageText = footer => ['Portfolios', 'Filter by', '2 results', 'Export',
      kind === 'list' ? 'Portfolios' : 'Campaign name', 'Total: 2', 'Status', 'Impressions', '1,234',
      ...(kind === 'list' ? names : names.flatMap(name => ['Select', name])),
      ...statuses, 'Go to page', 'Numeric', footer, 'Results per page: 50'].join('\n');
    for (const footer of ['1 - 2\u00a0of\u00a02\u00a0results', '1 – 2 of 2 results', '1 - 2 / 2 results']) {
      const dom = makeDom(footer), txt = parsePortfolioPageText(pageText(footer), kind);
      assert.equal(verifyPortfolioPage(dom, txt, { expectedSearch: search }), true, `${kind}: ${footer}`);
      assert.equal(dom.paginationText, (footer+' Results per page: 50').replace(/\s+/g, ' '));
      assert.equal(txt.filterLabel, 'Filter by');
      assert.deepEqual(txt.rows.map(r => r.name), names);
      assert.deepEqual([dom.start, dom.end, dom.total, txt.start, txt.end, txt.total], [1, 2, 2, 1, 2, 2]);
      for (const restrictive of ['Status: Enabled', 'Delivering', 'Budget > 0', '2 results Paused']) {
        const filtered = parsePortfolioPageText(pageText(footer).replace('2 results\nExport', '2 results\n'+restrictive+'\nExport'), kind);
        assert.equal(verifyPortfolioPage(dom, filtered, { expectedSearch: search }), false, restrictive);
      }
      assert.equal(verifyPortfolioPage(dom, parsePortfolioPageText(pageText(footer).replace('Total: 2', 'Total: 3'), kind), { expectedSearch: search }), false);
      assert.equal(verifyPortfolioPage(dom, parsePortfolioPageText(pageText(footer).replace('Paused', 'Unrecognized status'), kind), { expectedSearch: search }), false);
    }
    for (const footer of ['1 - 2 out of 2 results', '1 - 2 of2 results', '1 - 2 / results']) {
      assert.equal(makeDom(footer).sliceComplete, false);
      assert.equal(parsePortfolioPageText(pageText(footer), kind).complete, false);
    }
    const partial = parsePortfolioPageText(pageText('1 - 50 of 75 results').replace('Total: 2', 'Total: 75'), kind);
    assert.equal(partial.sliceComplete, true);
    assert.equal(partial.complete, false, 'visible rows alone cannot certify complete pagination');
  }
  assert(!/[^\x00-\x7f]/.test(ADS_PORTFOLIO_EXTRACTOR));
});

test('custom portfolio metric columns and totals are not parsed as portfolio names', () => {
  // Real XCAI layout: configurable Impressions header and aggregate precede
  // the pinned name column; metrics are interleaved with delivery cells.
  const text = ['广告组合', '筛选条件', '3 个结果', '导出', '总计: 3',
    '状态', '广告活动预算金额', '展示次数', '14,958',
    '组合甲/1.5', '组合乙/1.5', '组合丙/1.5',
    '正在投放', '2,127', '已暂停', '1,306', '正在投放', '750',
    '转到页面', '1 - 3 / 3 结果'].join('\n');
  const parsed = parsePortfolioPageText(text, 'list');
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.rows.map(r => r.name), ['组合甲/1.5', '组合乙/1.5', '组合丙/1.5']);
  const dom = { ...parsed, searchValue: '1.5', rows: parsed.rows.map((r, i) => ({ ...r, id: `P${i}` })) };
  assert.equal(verifyPortfolioPage(dom, parsed, { expectedSearch: '1.5' }), true);
  const lupingLayout = text.replace('广告活动预算金额\n展示次数\n14,958', '展示次数\n点击量\nCTR\n19,119\n118\n0.62%');
  assert.deepEqual(parsePortfolioPageText(lupingLayout, 'list').rows, parsed.rows,
    'multiple configured columns and mixed numeric/percentage totals preserve the name column');
  const unknown = parsePortfolioPageText(text.replace('已暂停', '待审核的新状态'), 'list');
  assert.equal(unknown.complete, false);
  assert.equal(verifyPortfolioPage(dom, unknown, { window: true, expectedSearch: '1.5' }), false,
    'a missing/unknown delivery label cannot silently remove a DOM row');
  const partial = parsePortfolioPageText(text.replace('总计: 3', '总计: 50').replace('1 - 3 / 3', '1 - 50 / 50'), 'list');
  assert.equal(partial.sliceComplete, true);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.rows, parsed.rows, 'virtual windows use visible rows, not footer page size');
});

test('an explicit empty portfolio needs a heading in the same campaign app and unfiltered page text', () => {
  const message = '您的广告组合中没有广告活动';
  const text = ['广告组合', '空组合', '状态: 正在投放', 'Search', '筛选条件', '导出',
    '已启动', '广告活动名称', '-', '状态', '展示次数', '-', message,
    '请将广告活动添加到您的广告组合，以管理您的广告活动支出', '添加广告活动'].join('\n');
  const makeDom = (inside = true, search = '') => e('body', {}, {},
    e('input', { id: 'UCM-CM-APP:SINGLE_PORTFOLIO:searchInput', value: search }),
    e('div', { id: 'cm-app' }, {},
      e('div', { id: 'SINGLE_PORTFOLIO', 'data-e2e-id': 'dataTableWrapper' }),
      ...(inside ? [e('h4', {}, {}, message)] : [])),
    ...(!inside ? [e('h4', {}, {}, message)] : []));
  const read = body => new Function('document', 'window', ADS_PORTFOLIO_EXTRACTOR)(body, { getComputedStyle: el => el.style });
  const dom = read(makeDom());
  const txt = parsePortfolioPageText(text, 'detail');
  assert.equal(dom.empty, true);
  assert.equal(verifyPortfolioPage(dom, txt), true);
  assert.equal(dom.total, 0);
  assert.equal(txt.total, 0);
  assert.equal(read(makeDom(false)).complete, false, 'an outside message is not scoped to the same campaign app');
  assert.equal(read(makeDom(true, 'cached')).complete, false, 'a residual search cannot prove a genuinely empty portfolio');
  const duplicate=makeDom();
  duplicate.querySelectorAll('*').find(el=>el.getAttribute('id')==='cm-app').append(e('h4', {}, {}, message));
  assert.equal(read(duplicate).complete, false, 'ambiguous duplicate empty headings must fail closed');
  assert.equal(parsePortfolioPageText(text.replace(message, '加载中'), 'detail').complete, false);
  assert.equal(verifyPortfolioPage(dom, parsePortfolioPageText(text.replace('筛选条件', '筛选条件\n状态：已启用'), 'detail')), false);
  assert.equal(parsePortfolioPageText(text, 'list').complete, false);
  const portfolio = { id: 'P0', name: '空组合', statusText: '正在投放', campaigns: [] };
  const verdict = judgePortfolioAdvertising({
    dom: { complete: true, portfolios: [portfolio] },
    txt: { complete: true, portfolios: [{ ...portfolio, delivery: 'DELIVERING' }] },
    config: { _currentSlot: 'ads-on' },
  });
  assert.equal(verdict.status, 'SHOULD_BE_ON', 'all-empty scope must not be reported as all campaigns on');
});

test('cross-page verdict requires complete dual coverage and exact parent/child identity', () => {
  const dom = { landed: true, complete: true, nameContains: '26', portfolios: [{ id: 'P1', name: '组合甲/26', statusText: '正在投放',
    campaigns: [{ id: 'C1', name: '活动甲', statusText: '已暂停', toggle: 'PAUSED' }] }] };
  const txt = { landed: true, complete: true, portfolios: [{ id: 'P1', name: '组合甲/26', delivery: 'DELIVERING',
    campaigns: [{ id: 'C1', name: '活动甲', delivery: 'PAUSED' }] }] };
  assert.equal(judgePortfolioAdvertising({ dom, txt, config: { _currentSlot: 'ads-off' } }).status, 'ALL_OFF');
  assert.equal(judgePortfolioAdvertising({ dom, txt, config: { _currentSlot: 'ads-on' } }).status, 'SHOULD_BE_ON');
  const limitedDom = structuredClone(dom), limitedText = structuredClone(txt);
  Object.assign(limitedDom.portfolios[0].campaigns[0], { statusText: 'Out of budget', toggle: 'ENABLED' });
  limitedText.portfolios[0].campaigns[0].delivery = 'OUT_OF_BUDGET';
  assert.equal(judgePortfolioAdvertising({ dom: limitedDom, txt: limitedText, config: { _currentSlot: 'ads-off' } }).status, 'SHOULD_BE_OFF');
  assert.equal(judgePortfolioAdvertising({ dom, txt: { ...txt, complete: false } }).status, 'PARTIAL_EVIDENCE');
  const wrong = structuredClone(txt);
  wrong.portfolios[0].campaigns[0].id = 'C2';
  assert.equal(judgePortfolioAdvertising({ dom, txt: wrong }).status, 'PARTIAL_EVIDENCE');
  const parsed = parsePortfolioPageText(listText, 'list');
  const page = { ...parsed, rows: parsed.rows.map((r, i) => ({ ...r, id: `P${i}` })) };
  assert.equal(verifyPortfolioPage(page, parsed), true);
  assert.equal(verifyPortfolioPage({ ...page, total: 3 }, parsed), false);
  const missing = structuredClone(page);
  missing.rows[1].name = '其他组合';
  assert.equal(verifyPortfolioPage(missing, parsed), false);
});

test('English empty portfolio requires the exact scoped heading and independent unfiltered text', () => {
  // chen-rui AKLWDMOP1R7AE, 2026-09-09: an empty metric chart also says
  // "No data available", which alone says nothing about the campaign list.
  const message = 'There are no campaigns in your portfolio';
  const text = ['Portfolios', 'Empty portfolio', 'Status: Delivering', 'No data available',
    'Please try adjusting your filters to see performance data', 'Search', 'Filter by', 'Export',
    'Active', 'Campaign name', '-', 'Status', 'Type', 'Start date', message, 'Add campaigns'].join('\n');
  const body = (heading = message, search = '', inside = true) => e('body', {}, {},
    e('input', { id: 'UCM-CM-APP:SINGLE_PORTFOLIO:searchInput', value: search }),
    e('div', { id: 'cm-app' }, {},
      e('div', { id: 'SINGLE_PORTFOLIO', 'data-e2e-id': 'dataTableWrapper' }),
      ...(inside ? [e('h4', {}, {}, heading)] : [])),
    ...(!inside ? [e('h4', {}, {}, heading)] : []));
  const read = root => new Function('document', 'window', ADS_PORTFOLIO_EXTRACTOR)(root, { getComputedStyle: el => el.style });
  const dom = read(body()), txt = parsePortfolioPageText(text, 'detail');
  assert.equal(verifyPortfolioPage(dom, txt), true);
  assert.equal(dom.empty, true);
  assert.equal(txt.empty, true);
  assert.equal(dom.total, 0);
  for (const heading of ['Loading', 'No data available', 'Add campaigns']) {
    assert.equal(read(body(heading)).complete, false);
    assert.equal(parsePortfolioPageText(text.replace(message, heading), 'detail').complete, false);
  }
  assert.equal(read(body(message, 'cached')).complete, false);
  assert.equal(read(body(message, '', false)).complete, false);
  const duplicate = body();
  duplicate.querySelectorAll('*').find(el => el.getAttribute('id') === 'cm-app').append(e('h4', {}, {}, message));
  assert.equal(read(duplicate).complete, false);
  assert.equal(verifyPortfolioPage(dom, parsePortfolioPageText(text.replace('Filter by', 'Filter by\nStatus: Enabled'), 'detail')), false);
  assert.equal(verifyPortfolioPage(dom, parsePortfolioPageText(text.replace('Campaign name', 'Metrics'), 'detail')), false);
  assert.equal(parsePortfolioPageText(text, 'list').complete, false);
});

test('an incomplete campaign is collected as a business limitation, never as delivering or a parser failure', () => {
  for (const label of ['不完整', 'Incomplete']) {
    assert.equal(adsDeliveryState(label), 'INCOMPLETE');
    const parsed = parsePortfolioPageText(detailText.replace('已暂停', label), 'detail');
    assert.equal(parsed.complete, true);
    assert.deepEqual(parsed.rows.map(r => r.delivery), ['INCOMPLETE', 'DELIVERING'], 'the next row must not shift into the incomplete row');
    const name = (i, id, text) => e('div', { 'data-e2e-index': `cellIndex_${i}_2`, 'data-udt-column-id': 'name-cell' }, {},
      e('a', { id, 'data-e2e-id': 'entityNameRenderer' }, {}, text));
    const row = (i, status) => [name(i, `C${i}`, i ? '活动乙' : '活动甲'),
      e('div', { 'data-e2e-index': `cellIndex_${i}_1`, 'data-udt-column-id': 'state-cell' }, {}, e('button', { role: 'switch', 'aria-checked': 'true' })),
      e('div', { 'data-e2e-index': `cellIndex_${i}_3`, 'data-udt-column-id': 'status-cell' }, {}, status+' 详细信息')];
    const body = e('body', {}, {}, e('input', { id: 'UCM-CM-APP:SINGLE_PORTFOLIO:searchInput', value: '' }),
      e('div', { id: 'SINGLE_PORTFOLIO', 'data-e2e-id': 'dataTableWrapper' }, {}, ...row(0, label), ...row(1, '正在投放'),
        e('div', { 'data-e2e-id': 'tablePagination' }, {}, e('input', { id: 'UCM-CM-APP:SINGLE_PORTFOLIO:pagination-input', value: '1' }),
          '1 - 2 / 2 结果 每页显示的结果数： 50')));
    const dom = new Function('document', 'window', ADS_PORTFOLIO_EXTRACTOR)(body, { getComputedStyle: el => el.style });
    assert.equal(verifyPortfolioPage(dom, parsed), true);
    const portfolio = { id: 'P1', name: '组合', statusText: '正在投放', campaigns: dom.rows };
    const peer = { id: 'P1', name: '组合', delivery: 'DELIVERING', campaigns: parsed.rows.map((r, i) => ({ ...r, id: `C${i}` })) };
    for (const slot of ['ads-on', 'ads-off']) {
      const v = judgePortfolioAdvertising({ dom: { complete: true, portfolios: [portfolio] }, txt: { complete: true, portfolios: [peer] }, config: { _currentSlot: slot } });
      assert.equal(v.baselineEligible, true);
      assert.equal(v.metrics.collectionStatus, 'COMPLETE');
      assert.equal(v.metrics.limited, 1);
      assert.equal(v.severity, slot === 'ads-on' ? 'WARN' : 'CRITICAL');
      assert.equal(v.items.find(r => r.campaignId === 'C0').effective, 'LIMITED');
    }
    assert.equal(effectiveCampaignState(portfolio, { statusText: label, toggle: 'PAUSED' }), 'OFF');
    assert.equal(effectiveCampaignState(portfolio, { statusText: label, toggle: null }), 'UNKNOWN');
    assert.equal(parsePortfolioPageText(detailText.replace('已暂停', '尚未识别的新状态'), 'detail').complete, false);
  }
  assert(!/[^\x00-\x7f]/.test(ADS_PORTFOLIO_EXTRACTOR), 'injected extractor remains ASCII');
});

test('UCM extraction joins split table cells by row index, never by raw DOM order', () => {
  const name = (index, id, label) => e('div', { 'data-e2e-index': `cellIndex_${index}_2`, 'data-udt-column-id': 'name-cell' }, {},
    e('a', { id, 'data-e2e-id': 'entityNameRenderer' }, {}, label));
  const state = (index, enabled) => e('div', { 'data-e2e-index': `cellIndex_${index}_1`, 'data-udt-column-id': 'state-cell' }, {},
    e('button', { role: 'switch', 'aria-checked': String(enabled) }));
  const delivery = (index, status) => e('div', { 'data-e2e-index': `cellIndex_${index}_0`, 'data-udt-column-id': 'status-cell' }, {}, status);
  const pagination = e('div', { 'data-e2e-id': 'tablePagination' }, {},
    e('input', { id: 'UCM-CM-APP:SINGLE_PORTFOLIO:pagination-input', value: '1' }),
    '1 - 2 / 2 结果 每页显示的结果数： 50');
  const table = e('div', { id: 'SINGLE_PORTFOLIO', 'data-e2e-id': 'dataTableWrapper' }, {},
    state(0, false), name(0, 'C1', '活动甲'), state(1, true), name(1, 'C2', '活动乙'),
    delivery(1, '正在投放 详细信息'), delivery(0, '已暂停 详细信息'), pagination);
  const body = e('body', {}, {},
    e('div', { id: 'UCM-CM-APP:SINGLE_PORTFOLIO:searchInput' }, {},
      e('input', { id: 'UCM-CM-APP:SINGLE_PORTFOLIO:searchInput', value: '' })), table);
  const read = () => new Function('document', 'window', ADS_PORTFOLIO_EXTRACTOR)(body, { getComputedStyle: (el) => el.style });
  const result = read();
  assert.equal(result.complete, true);
  assert.equal(result.searchCount, 1, 'component wrapper IDs must not count as search inputs');
  assert.deepEqual(result.rows.map(r => [r.id, r.statusText, r.toggle]), [['C1', '已暂停', 'PAUSED'], ['C2', '正在投放', 'ENABLED']]);
  assert.equal(verifyPortfolioPage(result, parsePortfolioPageText(detailText, 'detail')), true);
  const archivedBody = e('body', {}, {},
    e('input', { id: 'UCM-CM-APP:SINGLE_PORTFOLIO:searchInput', value: '' }),
    e('div', { id: 'SINGLE_PORTFOLIO', 'data-e2e-id': 'dataTableWrapper' }, {},
      name(0, 'C3', '历史活动'), state(0, false), delivery(0, '已存档'),
      e('div', { 'data-e2e-id': 'tablePagination' }, {},
        e('input', { id: 'UCM-CM-APP:SINGLE_PORTFOLIO:pagination-input', value: '1' }),
        '1 - 1 / 1 结果 每页显示的结果数： 50')));
  const archived = new Function('document', 'window', ADS_PORTFOLIO_EXTRACTOR)(archivedBody, { getComputedStyle: (el) => el.style });
  assert.equal(archived.complete, true);
  assert.equal(archived.rows[0].statusText, '已存档');
  table.append(name(2, 'C1', '活动甲'));
  assert.equal(read().complete, false, 'duplicate or incomplete row must not pass');
});

test('portfolio collection verifies exact scope, clears child searches, covers virtualized pages, and rejects duplicates', async () => {
  for (const mode of ['clear', 'duplicate', 'scope']) {
    const duplicate = mode === 'duplicate', scoped = mode === 'scope';
    let page = 1, top = 0, pageChanges = 0;
    let search = scoped ? 'old' : '26', searchClears = 0;
    let stalePageWindows = 0;
    const count = () => page === 1 ? 50 : 25;
    const rows = () => {
      const first = Math.min(Math.floor(top / 50), Math.max(0, count() - 25));
      return Array.from({ length: Math.min(25, count()) }, (_, k) => {
        const index = first + k;
        const id = `P${(duplicate || stalePageWindows > 0 ? 0 : (page - 1) * 50) + index}`;
        return { id, index, name: `${id}/26`, statusText: '正在投放', toggle: null };
      });
    };
    const field = { async isDisplayed() { return true; }, async isEnabled() { return true; }, async clear() {},
      async sendKeys(value) { page = Number(value); top = 0; pageChanges++; stalePageWindows = 1; } };
    const searchField = { async isDisplayed() { return true; }, async isEnabled() { return true; },
      async sendKeys(...keys) {
        assert.equal(keys.length, scoped ? 4 : 3);
        assert.equal(keys[0], (process.platform === 'darwin' ? '\uE03D' : '\uE009') + 'a\uE000');
        assert.equal(keys[1], '\uE003');
        if (scoped) assert.equal(keys[2], '26');
        assert.equal(keys.at(-1), '\uE007');
        search = scoped ? '26' : ''; searchClears++;
      } };
    const zn = {
      async currentUrl() { return 'https://advertising.amazon.com/cm/portfolios'; },
      session() { return { driver: { async executeScript(script, _id, value) {
        if (script.includes('e.getAttribute("type")==="search"')) {
          assert.equal(_id, 'UCM-CM-APP:ALL_PORTFOLIOS:searchInput');
          return [searchField];
        }
        if (script.includes('var hits=[]')) return [field];
        assert(script.includes('e.scrollTop=arguments[1]'), 'only scroll/pagination scripts are allowed');
        top = Math.min(value, Math.max(0, (count() - 25) * 50));
        return [{ top, max: Math.max(0, (count() - 25) * 50) }];
      } } }; },
      async execExtract(_id, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) return { result: {
          probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true,
        } };
        return { result: { landed: true, kind: 'list', complete: count() === 25 && search === (scoped ? '26' : ''), sliceComplete: search === (scoped ? '26' : ''),
          searchCount: 1, searchEmpty: !search, searchValue: search,
          total: 75, start: (page - 1) * 50 + 1, end: page === 1 ? 50 : 75, page, rows: rows(), grids: [{ top }] } };
      },
      async content() {
        const visible = rows();
        if (stalePageWindows > 0) stalePageWindows--;
        return { text: ['广告组合', '筛选条件', '导出', '总计: 75', '状态', '广告活动预算金额', '预算开始日期', '预算结束日期',
          ...visible.map(r => r.name), ...visible.map(r => r.statusText), '转到页面',
          `${(page - 1) * 50 + 1} - ${page === 1 ? 50 : 75} / 75 结果`].join('\n') };
      },
    };
    const read = () => collectPortfolioTable({ zn, storeId: 'S1', kind: 'list', logger: { info() {} }, readTimeoutMs: duplicate ? 1000 : 5000, nameContains: scoped ? '26' : '' });
    if (duplicate) await assert.rejects(read, /重复记录/);
    else {
      const result = await read();
      assert.equal(result.dom.length, 75);
      assert.equal(new Set(result.dom.map(r => r.id)).size, 75);
      assert.equal(result.txt.length, 75);
      assert.equal(pageChanges, 1);
    }
    assert.equal(searchClears, 1);
  }
});

test('a different portfolio URL blocks table reading and all view changes', async () => {
  const zn = {
    async currentUrl() { return 'https://advertising.amazon.com/cm/portfolios/P2'; },
    async execExtract(_id, script) {
      assert.equal(script, POST_SCREENSHOT_SAFETY_EXTRACTOR);
      return { result: { probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true } };
    },
    session() { assert.fail('wrong portfolio must not access page controls'); },
    async content() { assert.fail('wrong portfolio must not read table text'); },
  };
  await assert.rejects(collectPortfolioTable({ zn, storeId: 'S1', kind: 'detail', portfolioId: 'P1', logger: { info() {} } }), /IDENTITY_MISMATCH/);
});

function majorityFixture({ on = 0, off = 0, limited = 0, excluded = 0, unknown = 0 } = {}) {
  const campaigns = [];
  for (const [count, statusText, toggle] of [[on, 'Delivering', 'ENABLED'], [off, 'Paused', 'PAUSED'],
    [limited, 'Out of budget', 'ENABLED'], [excluded, 'Archived', 'PAUSED'], [unknown, 'New unknown state', 'ENABLED']]) {
    for (let i = 0; i < count; i++) campaigns.push({ id: `C${campaigns.length}`, name: `Campaign ${campaigns.length}`, statusText, toggle });
  }
  const portfolio = { id: 'P1', name: 'Portfolio', statusText: 'Delivering', campaigns };
  return { dom: { complete: true, portfolios: [portfolio] }, txt: { complete: true, portfolios: [{
    id: 'P1', name: 'Portfolio', delivery: 'DELIVERING', campaigns: campaigns.map(c => ({ id: c.id, name: c.name, delivery: adsDeliveryState(c.statusText) })),
  }] } };
}

test('majority rule is symmetric per store and retains minority campaign identities without alerting', () => {
  for (const slot of ['ads-on', 'ads-off']) {
    const fixture = majorityFixture(slot === 'ads-on' ? { on: 9, off: 1 } : { on: 1, off: 9 });
    const v = judgePortfolioAdvertising({ ...fixture, config: { _currentSlot: slot } });
    assert.equal(v.status, slot === 'ads-on' ? 'MAJORITY_ON' : 'MAJORITY_OFF');
    assert.equal(v.ok, true);
    assert.equal(v.severity, 'OK');
    assert.equal(v.metrics.matchingPercent, 90);
    assert.equal(v.metrics.recordedExceptionCount, 1);
    assert.equal(v.metrics.businessStatus, 'RECORDED');
    assert.equal(v.items.length, 10, 'retain every observation in the report');
    assert.equal(v.items[0].disposition, 'RECORDED_EXCEPTION', 'minority details appear first');
    assert.equal(v.items[0].campaignId, slot === 'ads-on' ? 'C9' : 'C0');
    const opposite = judgePortfolioAdvertising({ ...fixture, config: { _currentSlot: slot === 'ads-on' ? 'ads-off' : 'ads-on' } });
    assert.equal(opposite.severity, 'CRITICAL');
    assert.equal(opposite.metrics.recordedExceptionCount, 0, 'archiving is reevaluated every check, never a permanent exemption');
    assert.equal(opposite.items.filter(c => c.disposition === 'ACTION_REQUIRED').length, 9);
  }
});

test('strict majority requires over half, ties need attention, and ended campaigns cannot dilute the denominator', () => {
  for (const slot of ['ads-on', 'ads-off']) {
    for (const matching of [49, 50, 51, 100]) {
      const fixture = majorityFixture({ on: slot === 'ads-on' ? matching : 100 - matching,
        off: slot === 'ads-off' ? matching : 100 - matching, excluded: 150 });
      const v = judgePortfolioAdvertising({ ...fixture, config: { _currentSlot: slot } });
      assert.equal(v.metrics.total, 100);
      assert.equal(v.metrics.excluded, 150);
      assert.equal(v.metrics.matchingPercent, matching);
      assert.equal(v.severity, matching > 50 ? 'OK' : matching === 50 ? 'WARN' : 'CRITICAL');
      assert.equal(v.metrics.recordedExceptionCount, matching > 50 ? 100 - matching : 0);
      if (matching === 50) assert.equal(v.status, 'ADS_SPLIT');
      if (matching === 100) assert.equal(v.status, slot === 'ads-on' ? 'ALL_ON' : 'ALL_OFF');
    }
  }
});

test('majority never masks missing pages, unknown states, dual-path conflicts or delivery limitations', () => {
  const fixture = majorityFixture({ on: 99, off: 1 });
  const duplicate = structuredClone(fixture);
  duplicate.dom.portfolios[0].campaigns[1] = structuredClone(duplicate.dom.portfolios[0].campaigns[0]);
  duplicate.txt.portfolios[0].campaigns[1] = structuredClone(duplicate.txt.portfolios[0].campaigns[0]);
  for (const broken of [
    { ...fixture, txt: { ...fixture.txt, complete: false } },
    majorityFixture({ on: 99, unknown: 1 }),
    { ...fixture, txt: { ...fixture.txt, portfolios: [] } },
    duplicate,
  ]) {
    const v = judgePortfolioAdvertising({ ...broken, config: { _currentSlot: 'ads-on' } });
    assert.equal(v.status, 'PARTIAL_EVIDENCE');
    assert.equal(v.severity, 'ERROR');
    assert.equal(v.metrics.recordedExceptionCount, 0);
    assert(!v.items.some(c => c.disposition === 'RECORDED_EXCEPTION'));
  }
  for (const slot of ['ads-on', 'ads-off']) {
    const v = judgePortfolioAdvertising({ ...majorityFixture({ [slot === 'ads-on' ? 'on' : 'off']: 9, limited: 1 }), config: { _currentSlot: slot } });
    assert.equal(v.severity, 'OK');
    assert.equal(v.metrics.limited, 1);
    assert.equal(v.items[0].effective, 'LIMITED');
    assert.equal(v.items[0].disposition, 'RECORDED_EXCEPTION');
    assert.equal(judgePortfolioAdvertising({ ...majorityFixture({ limited: 9, on: 1 }), config: { _currentSlot: slot } }).severity, 'CRITICAL');
  }
});

test('portfolio gate waits for a detached document without reading business data, with a bounded fail-closed retry', async () => {
  for (const mode of ['transient', 'persistent', 'auth']) {
    let probes = 0, tableReads = 0, textReads = 0;
    const zn = {
      async currentUrl() { return 'https://advertising.amazon.com/cm/portfolios/P1'; },
      async execExtract(_id, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          probes++;
          return { result: { probeVersion: 2, looksLikeLogin: mode === 'auth', looksBlocked: false,
            liveDocument: mode === 'transient' && probes > 1, traversalComplete: true,
            accessibleTraversalComplete: true, discoveredElementCount: 0, scannedElementCount: 0,
            candidateNodeCount: 0, traversalErrorCount: 0 } };
        }
        tableReads++;
        assert(probes >= 2, 'do not read table while document is detached');
        return { result: { landed: true, kind: 'detail', empty: true, complete: true, sliceComplete: true,
          searchValue: '', searchCount: 1, rows: [], total: 0, start: 0, end: 0, page: 1 } };
      },
      async content() { textReads++; return { text: '筛选条件\n导出\n广告活动名称\n您的广告组合中没有广告活动' }; },
      session() { assert.fail('this read needs no controls'); },
    };
    const read = () => collectPortfolioTable({ zn, storeId: 'S1', kind: 'detail', portfolioId: 'P1', logger: { info() {} } });
    if (mode === 'transient') { assert.equal((await read()).total, 0); assert.equal(tableReads, 1); assert.equal(textReads, 1); }
    else { await assert.rejects(read, /LIVE_SAFETY_PROBE_UNAVAILABLE/); assert.equal(tableReads, 0); assert.equal(textReads, 0); assert.equal(probes, mode === 'auth' ? 1 : 3); }
  }
});
