const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

export function adsDeliveryState(value) {
  const text = clean(value);
  if (/^(?:正在投放|投放中|Delivering)$/i.test(text)) return 'DELIVERING';
  if (/^(?:已暂停|暂停|Paused)$/i.test(text)) return 'PAUSED';
  if (/^(?:已归档|已存档|Archived)$/i.test(text)) return 'ARCHIVED';
  if (/^(?:已结束|Ended)$/i.test(text)) return 'ENDED';
  if (/^(?:不完整|Incomplete)$/i.test(text)) return 'INCOMPLETE';
  if (/^(?:已安排|Scheduled)$/i.test(text)) return 'SCHEDULED';
  if (/^(?:预算耗尽|预算已用完|预算用尽|超出预算|Out of budget|Budget exhausted)$/i.test(text)) return 'OUT_OF_BUDGET';
  if (/^(?:未投放|未在投放|不符合投放条件|广告组合未投放|广告组合已暂停|Not delivering|Ineligible|Portfolio not delivering|Portfolio paused)$/i.test(text)) return 'NOT_DELIVERING';
  return 'UNKNOWN';
}

export function parsePortfolioPageText(text, kind) {
  const lines = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  const totalIndex = lines.findIndex((line) => /^(?:总计|Total)\s*[:：]\s*[\d,]+$/i.test(line));
  const rangeIndex = lines.findIndex((line) => /^\d[\d,]*\s*[-–]\s*\d[\d,]*\s*(?:\/|\bof\b)\s*\d[\d,]*\s*(?:结果|results?)\s*$/i.test(line));
  const result = { landed: false, kind, rows: [], total: null, start: null, end: null, complete: false };
  const controls = totalIndex < 0 ? lines : lines.slice(0, totalIndex);
  const filterIndex = controls.findLastIndex((line) => /^(?:筛选条件|Filters|Filter by)$/i.test(line));
  const exportIndex = controls.findIndex((line, index) => index > filterIndex && /^(?:导出|Export)$/i.test(line));
  result.filterLabel = filterIndex >= 0 ? controls[filterIndex] : null;
  result.scopeVerified = filterIndex >= 0 && exportIndex > filterIndex
    // Amazon uses "1 结果" for one row and "14 个结果" for multiple rows.
    // Both are counts, not active filters; other toolbar text stays rejected.
    && controls.slice(filterIndex + 1, exportIndex).every((line) => /^[\d,]+\s*(?:(?:个\s*)?结果|results?)$/i.test(line));
  // Empty portfolios render an explicit empty state instead of totals and
  // pagination. Absence of rows alone is never evidence of an empty portfolio.
  if (kind === 'detail' && totalIndex < 0 && rangeIndex < 0
    && lines.some((line) => /^(?:广告活动名称|Campaign name)$/i.test(line))
    && lines.some((line) => /^(?:您的广告组合中没有广告活动|There are no campaigns in your portfolio)$/i.test(line))) {
    return { ...result, landed: true, total: 0, start: 0, end: 0, empty: true,
      sliceComplete: result.scopeVerified, complete: result.scopeVerified };
  }
  if (totalIndex < 0 || rangeIndex <= totalIndex) return result;
  const total = Number(lines[totalIndex].replace(/[^\d]/g, ''));
  const nums = lines[rangeIndex].match(/[\d,]+/g).map((n) => Number(n.replace(/,/g, '')));
  const [start, end, rangeTotal] = nums;
  if (total !== rangeTotal || start < 0 || end < start || end > total) return result;
  const count = total === 0 ? 0 : end - start + 1;
  Object.assign(result, { total, start, end });
  let body = lines.slice(totalIndex + 1, rangeIndex);
  let names = [], statusLines = [];
  if (kind === 'list') {
    const firstStatus = body.findIndex((line) => adsDeliveryState(line) !== 'UNKNOWN');
    statusLines = firstStatus < 0 ? [] : body.slice(firstStatus).filter((line) => adsDeliveryState(line) !== 'UNKNOWN');
    // UCM renders column headers/aggregate metrics before the pinned name
    // column. Those columns are user-configurable (e.g. Impressions + 14,958),
    // so a fixed header allowlist mistakes them for portfolio names. The
    // contiguous name column ends immediately before the delivery column;
    // its visible row count comes from independently read delivery labels.
    // verifyPortfolioPage still requires every DOM name/status and the same
    // row count, so an unknown/missing status cannot hide a portfolio.
    names = firstStatus < 0 || statusLines.length === 0 ? []
      : body.slice(Math.max(0, firstStatus - statusLines.length), firstStatus);
  } else {
    let lastNameIndex = -1;
    for (let index = 0; index < body.length - 1; index++) {
      if (body[index].toLowerCase() === 'select') {
        names.push(body[index + 1]);
        lastNameIndex = index + 1;
      }
    }
    statusLines = body.slice(lastNameIndex + 1).filter((line) => adsDeliveryState(line) !== 'UNKNOWN');
  }
  result.rows = names.map((name, index) => ({ name, delivery: adsDeliveryState(statusLines[index]), statusText: statusLines[index] || null }));
  result.landed = kind === 'list'
    ? /广告组合|Portfolios/i.test(lines.slice(0, totalIndex).join(' '))
    : /广告活动名称|Campaign name/i.test(lines.slice(0, totalIndex).join(' '));
  result.sliceComplete = result.landed && result.scopeVerified && (names.length > 0 || total === 0) && names.length <= count && statusLines.length === names.length
    && (total === 0 ? start === 0 && end === 0 : start >= 1)
    && result.rows.every((row) => row.name && row.delivery !== 'UNKNOWN');
  result.complete = result.sliceComplete && names.length === count;
  return result;
}

export function verifyPortfolioPage(dom, txt, { window = false, expectedSearch = '' } = {}) {
  if (!dom?.landed || !(window ? dom.sliceComplete : dom.complete) || !txt?.landed || !(window ? txt.sliceComplete : txt.complete)
    || (dom.searchValue ?? '') !== expectedSearch
    || dom.kind !== txt.kind || dom.total !== txt.total || dom.start !== txt.start || dom.end !== txt.end
    || dom.rows.length !== txt.rows.length) return false;
  return dom.rows.every((row, index) => row.id && row.name === txt.rows[index].name
    && adsDeliveryState(row.statusText) === txt.rows[index].delivery
    && txt.rows[index].delivery !== 'UNKNOWN');
}

export function effectiveCampaignState(portfolio, campaign) {
  const parent = adsDeliveryState(portfolio.statusText);
  const child = adsDeliveryState(campaign.statusText);
  if (parent === 'UNKNOWN' || child === 'UNKNOWN') return 'UNKNOWN';
  if (['ARCHIVED', 'ENDED'].includes(child) || ['ARCHIVED', 'ENDED'].includes(parent)) return 'EXCLUDED';
  if (parent === 'PAUSED') return 'OFF';
  if (child === 'PAUSED') return campaign.toggle === 'PAUSED' ? 'OFF' : 'UNKNOWN';
  if (['OUT_OF_BUDGET', 'NOT_DELIVERING', 'INCOMPLETE', 'SCHEDULED'].includes(child)) {
    return campaign.toggle === 'PAUSED' ? 'OFF' : campaign.toggle === 'ENABLED' ? 'LIMITED' : 'UNKNOWN';
  }
  if (child === 'DELIVERING') {
    if (campaign.toggle !== 'ENABLED') return 'UNKNOWN';
    return parent === 'DELIVERING' ? 'ON' : 'LIMITED';
  }
  return 'UNKNOWN';
}

export function judgePortfolioAdvertising({ dom, txt, config }) {
  const slot = config?._currentSlot || 'adhoc';
  const portfolios = dom?.portfolios || [];
  let complete = dom?.complete === true && txt?.complete === true && portfolios.length > 0
    && portfolios.length === txt?.portfolios?.length;
  const items = [];
  const portfolioIds = new Set(), campaignIds = new Set();
  for (const portfolio of portfolios) {
    if (!portfolio.id || portfolioIds.has(portfolio.id)) complete = false;
    portfolioIds.add(portfolio.id);
    const peer = txt?.portfolios?.find((p) => p.id === portfolio.id);
    if (!peer || peer.name !== portfolio.name || peer.delivery !== adsDeliveryState(portfolio.statusText)
      || peer.campaigns.length !== portfolio.campaigns.length) complete = false;
    for (const campaign of portfolio.campaigns) {
      if (!campaign.id || campaignIds.has(campaign.id)) complete = false;
      campaignIds.add(campaign.id);
      const textRow = peer?.campaigns.find((c) => c.id === campaign.id);
      const dual = textRow?.name === campaign.name && textRow?.delivery === adsDeliveryState(campaign.statusText);
      const effective = dual ? effectiveCampaignState(portfolio, campaign) : 'UNKNOWN';
      if (effective === 'UNKNOWN') complete = false;
      items.push({ portfolioId: portfolio.id, portfolioName: portfolio.name,
        portfolioStatus: portfolio.statusText, campaignId: campaign.id, campaignName: campaign.name,
        campaignStatus: campaign.statusText, toggle: campaign.toggle, effective });
    }
  }
  const enabled = items.filter((item) => item.effective === 'ON').length;
  const paused = items.filter((item) => item.effective === 'OFF').length;
  const excluded = items.filter((item) => item.effective === 'EXCLUDED').length;
  const limited = items.filter((item) => item.effective === 'LIMITED').length;
  const unknown = items.filter((item) => item.effective === 'UNKNOWN').length;
  const total = enabled + paused + limited;
  const scheduled = slot === 'ads-on' || slot === 'ads-off';
  const matching = slot === 'ads-on' ? enabled : slot === 'ads-off' ? paused : null;
  const exceptionCount = scheduled ? total - matching : 0;
  const majorityMatches = scheduled && total > 0 && matching * 2 > total;
  const tied = scheduled && total > 0 && matching * 2 === total;
  const bad = scheduled && (exceptionCount * 2 > total || (slot === 'ads-on' && total === 0));
  const recordedExceptionCount = complete && majorityMatches ? exceptionCount : 0;
  const reasons = [];
  if (!complete) reasons.push('广告组合与组合内活动的双路证据或分页覆盖不完整，无法确认多数状态；本次不自动留档');
  if (complete && scheduled && total) {
    const expected = slot === 'ads-on' ? '开启且可投放' : '关闭';
    if (majorityMatches) reasons.push(`${matching}/${total} 个活动符合${expected}预期（超过 50%），店铺正常${exceptionCount ? `；其余 ${exceptionCount} 个仅留档` : ''}`);
    else if (tied) reasons.push(`符合与不符合${expected}预期的活动各占 50%，尚无明确多数，请运营关注`);
    else reasons.push(`${exceptionCount}/${total} 个活动不符合${expected}预期（超过 50%），需要运营处理`);
  }
  if (limited) reasons.push(`${limited} 个活动已启用但投放受限，不计为正常开启或已关闭${recordedExceptionCount ? '；随少数例外留档' : ''}`);
  if (slot === 'ads-on' && !total) reasons.push('匹配组合中未确认任何可参与监测的活动');
  for (const item of items) {
    const matches = item.effective === (slot === 'ads-on' ? 'ON' : 'OFF');
    item.disposition = item.effective === 'EXCLUDED' ? 'EXCLUDED'
      : !complete ? 'UNVERIFIED' : !scheduled ? 'OBSERVED' : matches ? 'MATCHED'
        : majorityMatches ? 'RECORDED_EXCEPTION' : tied ? 'ATTENTION' : 'ACTION_REQUIRED';
  }
  const priority = (item) => item.effective === 'UNKNOWN' ? 0
    : item.effective === 'LIMITED' || item.effective === (slot === 'ads-off' ? 'ON' : 'OFF') ? 1 : 2;
  items.sort((a, b) => priority(a) - priority(b));
  return {
    status: !complete ? 'PARTIAL_EVIDENCE' : bad ? slot === 'ads-off' ? 'SHOULD_BE_OFF' : 'SHOULD_BE_ON'
      : tied ? 'ADS_SPLIT' : slot === 'ads-off' ? exceptionCount ? 'MAJORITY_OFF' : 'ALL_OFF'
        : slot === 'ads-on' ? exceptionCount ? 'MAJORITY_ON' : 'ALL_ON' : 'ADS_OBSERVED',
    ok: complete && !bad && !tied, severity: !complete ? 'ERROR' : bad ? 'CRITICAL' : tied ? 'WARN' : 'OK',
    confidence: complete ? 'high' : 'low', source: 'dom+text', reasons,
    metrics: { source: 'portfolio+campaign', expected: slot, nameContains: dom?.nameContains,
      portfolioCount: portfolios.length, campaignCount: items.length, enabled, paused, total, excluded, limited, unknown,
      majorityRule: '符合预期超过 50%', matching, matchingPercent: total && scheduled ? Math.round(matching * 10000 / total) / 100 : null,
      exceptionCount, recordedExceptionCount,
      businessStatus: bad ? 'ANOMALY' : tied ? 'ATTENTION' : recordedExceptionCount ? 'RECORDED' : 'CLEAR',
      paginationComplete: complete, collectionStatus: complete ? 'COMPLETE' : 'PARTIAL_EVIDENCE' },
    items, notes: ['每店独立按活动数判断多数，已结束或归档的活动不计入分母；少数例外仅在本站留档，后续每次重新判断。',
      '组合状态与活动状态分别核对；历史花费和展示量不用于推断当前开关。'], baselineEligible: complete,
  };
}
