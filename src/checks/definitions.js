import {
  ADS_EXTRACTOR, ADS_LINK_EXTRACTOR, ASIN_DETAIL_EXTRACTOR, FEEDBACK_EXTRACTOR, INBOX_EXTRACTOR,
  INBOX_LINK_EXTRACTOR, OUTLET_EXTRACTOR, PERFORMANCE_EXTRACTOR, REVIEWS_EXTRACTOR,
  vocDetailExtractor, VOC_EXTRACTOR,
} from '../extractors/checks.js';
import { createHash } from 'node:crypto';
import { bjDateKey } from '../lib/time.js';
import { verifyVocListPage } from '../lib/voc-list-collector.js';

/**
 * Definitions for checks 2-9: where to look, how to read the page in Node as a
 * second opinion, and how to judge.
 *
 * Judgement contract: return {status, ok, severity, reasons, metrics, items}.
 * The rule inherited from item 1 applies throughout — if a check cannot read
 * what it needs, it reports a problem rather than passing quietly. The runner
 * enforces the "did we even land on the page" half of that.
 */

const n = (v) => (Number.isFinite(v) ? v : null);

const clean = (v, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

function legacyStableItemKey(kind, store, item) {
  const intrinsicVocId = kind === 'voc-record'
    ? clean(item.identifier || item.recordId || item.returnId, 240)
    : null;
  const identityParts = intrinsicVocId ? [
    kind,
    store?.key || store?.name || '',
    store?.market || '',
    item.asin || '',
    intrinsicVocId,
  ] : [
    kind,
    store?.key || store?.name || '',
    store?.market || '',
    item.asin || '',
    item.sku || '',
    item.offerId || item.relatedId || item.orderId || '',
    item.identifier || item.recordId || '',
    item.date || item.updatedAt || '',
    item.rating ?? item.stars ?? '',
    item.reason || item.returnReason || '',
    item.title || '',
    item.summary || item.context || item.raw || '',
  ];
  const identity = identityParts.map((v) => clean(v, 240) || '').join('|').toLowerCase();
  return `${kind}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function stableItemKey(kind, store, item) {
  if (kind !== 'review' && kind !== 'feedback') return legacyStableItemKey(kind, store, item);
  const storeIdentity = store?.key || store?.name || '';
  const identifier = clean(item.identifier || item.reviewId || item.feedbackId, 120);
  const asin = clean(item.parentAsin || item.asin || item.childAsin, 10);
  const date = clean(item.date, 80);
  const score = item.rating ?? item.stars ?? '';
  const author = clean(item.author, 120);
  const title = clean(item.title, 240);
  // Never use the mutable summary/context as event identity.  Without an
  // Amazon id, require enough row-local facts to avoid silently archiving two
  // different low ratings on the same product.
  if (!identifier && !(asin && date && (author || title))) return null;
  const identity = [kind, storeIdentity, store?.market || '', identifier || '', asin || '', date || '', score, author || '', title || '']
    .map((v) => clean(v, 240) || '').join('|').toLowerCase();
  return `${kind}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function contextFields(value) {
  const context = clean(value, 1000) || '';
  const genericAsin = /(?:^|[^A-Z0-9])(B0[A-Z0-9]{8})(?![A-Z0-9])/i.exec(context)?.[1]?.toUpperCase() || null;
  const parentAsin = /(?:parent\s*asin|父\s*asin)\s*[:：]?\s*(B0[A-Z0-9]{8})/i.exec(context)?.[1]?.toUpperCase() || null;
  const childAsin = /(?:child\s*asin|子\s*asin)\s*[:：]?\s*(B0[A-Z0-9]{8})/i.exec(context)?.[1]?.toUpperCase() || null;
  const brand = /(?:brand|品牌)\s*[:：]?\s*([A-Z0-9][A-Z0-9 .&'_-]{0,60}?)(?=\s+(?:parent|child|asin|父|子)|$)/i.exec(context)?.[1]?.trim() || null;
  const date = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i.exec(context)?.[0]
    || /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.exec(context)?.[0]
    || /\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/.exec(context)?.[0]
    || /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/.exec(context)?.[0]
    || null;
  const identifier = /(?:order|feedback|review)\s*(?:id|#|number)?\s*[:#]?\s*([A-Z0-9-]{8,30})/i.exec(context)?.[1]
    || /(?:订单|反馈|评论)(?:编号|ID)?\s*[:：]?\s*([A-Z0-9-]{8,30})/i.exec(context)?.[1]
    || null;
  return { context, asin: genericAsin || parentAsin || childAsin, parentAsin, childAsin, brand, date, identifier };
}

function legacyContextFields(value) {
  const context = clean(value, 1000) || '';
  return {
    asin: /\b(B0[A-Z0-9]{8})\b/i.exec(context)?.[1]?.toUpperCase() || null,
    date: contextFields(context).date,
    identifier: contextFields(context).identifier,
  };
}

function normalizeReviewItem(kind, item, store, scoreKey) {
  const rawContext = item?.context || item?.summary || item?.raw || '';
  const fields = contextFields(rawContext);
  const legacyFields = legacyContextFields(rawContext);
  const parentAsin = clean(item?.parentAsin || fields.parentAsin, 10);
  const childAsin = clean(item?.childAsin || fields.childAsin, 10);
  const out = {
    [scoreKey]: n(item?.[scoreKey] ?? item?.rating ?? item?.stars),
    asin: clean(item?.asin || parentAsin || childAsin || fields.asin, 10),
    parentAsin,
    childAsin,
    brand: clean(item?.brand || fields.brand, 100),
    author: clean(item?.author, 120),
    title: clean(item?.title, 240),
    summary: clean(item?.summary || fields.context, 500),
    date: clean(item?.date || fields.date, 80),
    identifier: clean(item?.reviewId || item?.identifier || fields.identifier, 100),
    storeKey: store?.key || null,
    storeName: store?.name || null,
    source: clean(item?.source, 80),
  };
  out.itemKey = stableItemKey(kind, store, out);
  Object.defineProperty(out, 'previousItemKeys', { enumerable: false, value: item?.reviewId ? [
    stableItemKey(kind, store, { ...out, identifier: item?.identifier || fields.identifier, title: null }),
    stableItemKey(kind, store, { ...out, identifier: item?.identifier || fields.identifier }),
  ].filter(Boolean) : [] });
  const legacyView = {
    ...out,
    asin: clean(item?.asin || legacyFields.asin, 10),
    date: clean(item?.date || legacyFields.date, 80),
    identifier: clean(item?.identifier || legacyFields.identifier, 100),
  };
  Object.defineProperty(out, 'legacyItemKey', {
    value: legacyStableItemKey(kind, store, legacyView), enumerable: false,
  });
  return out;
}

function mergeLowItems(kind, domItems, textItems, store, scoreKey) {
  const structured = (domItems || []).filter((item) => item && !(item.source || '').startsWith('pagetext'));
  // DOM rows own structured identity.  Flattened page text is the independent
  // severity/count path only and must never create a second copy of the same
  // review or bind a nearby ASIN.
  const source = structured.length ? structured : (textItems || []);
  const merged = new Map();
  let unkeyedIndex = 0;
  for (const raw of source) {
    const item = normalizeReviewItem(kind, raw, store, scoreKey);
    if (item[scoreKey] === null || item[scoreKey] >= 4) continue;
    const key = item.itemKey || `unkeyed:${unkeyedIndex++}`;
    const prior = merged.get(key);
    if (!prior) merged.set(key, item);
  }
  return kind === 'review' ? [...merged.values()] : [...merged.values()].slice(0, 200);
}

const MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9], ['oct', 10],
  ['october', 10], ['nov', 11], ['november', 11], ['dec', 12], ['december', 12],
]);

export function calendarDateKey(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  let match = /^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)$/.exec(text)
    || /^(\d{4})\s*年\s*([01]?\d)\s*月\s*([0-3]?\d)\s*日$/.exec(text);
  let year;
  let month;
  let day;
  if (match) {
    [, year, month, day] = match;
  } else {
    match = /^([A-Za-z]+)\s+([0-3]?\d),?\s+(\d{4})$/.exec(text);
    if (match) {
      year = match[3]; month = MONTHS.get(match[1].toLowerCase()); day = match[2];
    } else {
      match = /^([01]?\d)[-/]([0-3]?\d)[-/](\d{4})$/.exec(text);
      if (match) { year = match[3]; month = match[1]; day = match[2]; }
    }
  }
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Keep the source date and event identity intact; unknown dates remain visible
// after dated reviews instead of being replaced by the collection date.
export function reviewsByDate(items = []) {
  return [...items].sort((a, b) => (calendarDateKey(b.date) || '').localeCompare(calendarDateKey(a.date) || ''));
}

function feedbackDatedRows(source) {
  return (source || []).map((item) => (typeof item === 'number' ? { rating: item } : item || {})).map((item) => ({
    ...item,
    rating: n(item.rating),
    dateKey: calendarDateKey(item.date),
    amazonFulfillmentExcluded: item.amazonFulfillmentExcluded === true || (() => {
      const value = `${item.context || ''} ${item.summary || ''}`.replace(/\s+/g, ' ');
      return /fulfilled by amazon[\s\S]{0,260}(?:take|takes|taken|accept|assume|bear)[\s\S]{0,100}responsib/i.test(value)
        || /amazon[\s\S]{0,140}(?:take|takes|taken|accept|assume|bear)[\s\S]{0,100}responsib[\s\S]{0,180}fulfill/i.test(value)
        || /\u4e9a\u9a6c\u900a[\s\S]{0,180}(?:\u914d\u9001|\u7269\u6d41)[\s\S]{0,100}\u8d1f\u8d23/i.test(value)
        || /(?:\u914d\u9001|\u7269\u6d41)[\s\S]{0,180}\u4e9a\u9a6c\u900a[\s\S]{0,100}\u8d1f\u8d23/i.test(value);
    })(),
  })).filter((item) => item.rating !== null);
}

function businessEventDelta(items, prev, observedCount, legacyPreviousKeys = []) {
  const currentKeys = [...new Set((items || []).map((item) => clean(item?.itemKey, 80)).filter(Boolean))];
  const storedKeys = Array.isArray(prev?.metrics?.observedBusinessItemKeys)
    ? prev.metrics.observedBusinessItemKeys.map((key) => clean(key, 80)).filter(Boolean)
    : [];
  // Upgrade compatibility: older VOC state already retained the exact Poor
  // ASIN set but predates event keys. Seed only the conservative "Poor" key;
  // a current Very Poor status therefore remains a new/worsened event.
  const previousKeys = new Set(storedKeys.length ? storedKeys : legacyPreviousKeys.map((key) => clean(key, 80)).filter(Boolean));
  const aliases = new Map((items || []).filter((item) => item?.itemKey).map((item) => [item.itemKey, [item.legacyItemKey, ...(item.previousItemKeys || [])]]));
  const freshKeys = currentKeys.filter((key) => !previousKeys.has(key) && !(aliases.get(key) || []).some((alias) => previousKeys.has(alias)));
  // An unkeyed anomaly can never be silently archived: without a stable
  // identity we cannot prove it is the same historical record.
  const unkeyedCount = Math.max(0, Number(observedCount || 0) - currentKeys.length);
  const newCount = Math.min(Number(observedCount || 0), freshKeys.length + unkeyedCount);
  return {
    currentKeys,
    freshKeys: new Set(freshKeys),
    newCount,
    recordedCount: Math.max(0, Number(observedCount || 0) - newCount),
  };
}

// ------------------------------------------------------------------ 2. 绩效
const PERF_WARN =
  /(at[\s-]?risk|unhealthy|action required|requires? attention|deactivat|suspend|policy warning|violations?|non[\s-]?compliant|有风险|不健康|需要处理|停用|暂停|政策警告|违规|不合规)/i;
// Amazon's Account Health Assurance enrollment card contains words such as
// "deactivate/停用" inside an explicit promise not to deactivate the account.
// It is positive informational copy, not an account warning. Keep this narrow:
// the assurance label and a negation must both precede the action word.
const PERF_BENIGN_ASSURANCE =
  /(?:account health assurance|账户状况保障计划)[\s\S]{0,260}(?:will not|won['’]?t|不会)[\s\S]{0,60}(?:deactivat|suspend|停用|暂停)/i;
// Account Health exposes these as category rows. A number is actionable only
// when it is immediately attached to a known row label; unrelated figures such
// as the help text's "last 180 days" must never become violation counts.
const PERF_CATEGORY_COUNT_SPECS = [
  { key: 'suspected_ip_violations', pattern: '\\bsuspected intellectual property violations?\\b|涉嫌侵犯知识产权' },
  { key: 'received_ip_complaints', pattern: '\\b(?:received )?intellectual property complaints?\\b|(?:收到的)?知识产权投诉' },
  { key: 'product_authenticity_complaints', pattern: '\\bproduct authenticity (?:customer|buyer) complaints?\\b|商品真实性(?:买家|客户)投诉' },
  { key: 'product_condition_complaints', pattern: '\\bproduct condition (?:customer|buyer) complaints?\\b|商品状况(?:买家|客户)投诉' },
  { key: 'food_product_safety_issues', pattern: '\\bfood and product safety issues?\\b|食品和商品安全问题' },
  { key: 'listing_policy_violations', pattern: '\\blisting policy violations?\\b|上架政策违规' },
  { key: 'restricted_product_policy_violations', pattern: '\\brestricted products? policy violations?\\b|受限商品政策违规|违反受限商品政策' },
  { key: 'customer_reviews_policy_violations', pattern: '\\b(?:customer (?:product )?reviews?|review manipulation) policy violations?\\b|(?:买家|客户)商品评论政策违规|违反(?:买家|客户)商品评论政策' },
  { key: 'other_policy_violations', pattern: '\\bother policy violations?\\b|其他政策违规|其他违反政策' },
  { key: 'regulatory_compliance', pattern: '\\bregulatory compliance(?: (?:violations?|issues?))?\\b|监管合规性' },
  { key: 'policy_warnings', pattern: '\\bpolicy warnings?\\b|政策警告' },
];
const PERF_ZERO_SIGNALS = [
  /(?:violations?|policy warning|appeals?|issues?|complaints?)\s*(?:[:=\-]\s*)?\(?0(?:\b|\s*\))/i,
  /(?:违规|政策警告|申诉|问题|投诉)\s*(?:[:：=\-]\s*)?0(?:\b|\s*条)/i,
];
const PERF_HEALTHY_SIGNALS = [
  /(?:customer service performance|policy compliance|shipping performance)\s*(?:[:=\-]\s*)?(?:healthy|good)\b/i,
  /(?:客户服务绩效|政策合规性|配送绩效)\s*(?:[:：=\-]\s*)?(?:健康|良好)/i,
];
const PERF_METRIC_SIGNALS = [
  /(?:account health rating|order defect rate|late shipment rate|pre-fulfillment cancel rate|valid tracking rate|on-time delivery rate)\D{0,30}\d+(?:\.\d+)?\s*%?/i,
  /(?:账户状况评级|订单缺陷率|迟发率|发货前取消率|有效追踪率|准时送达率)\D{0,30}\d+(?:\.\d+)?\s*%?/i,
];

function performanceCategoryCountSignals(text, source) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const signals = [];
  const seen = new Set();
  for (const spec of PERF_CATEGORY_COUNT_SPECS) {
    const re = new RegExp(
      `(${spec.pattern})\\s*(?:[:：=\\-–—]\\s*)?\\(?\\s*(\\d{1,5})\\s*\\)?(?:\\s*条)?(?!\\s*(?:days?\\b|天|日))(?=\\s|$|[,.，。;；|/])`,
      'gi',
    );
    let match;
    while ((match = re.exec(t)) !== null && signals.length < 100) {
      const count = Number.parseInt(match[2], 10);
      if (!Number.isSafeInteger(count) || count < 0) continue;
      const dedupeKey = `${spec.key}|${count}|${match.index}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      signals.push({
        key: spec.key,
        category: clean(match[1], 120),
        count,
        source,
        context: clean(t.slice(Math.max(0, match.index - 60), match.index + match[0].length + 80), 240),
      });
    }
  }
  return signals.sort((a, b) => a.context.localeCompare(b.context));
}

function performanceTextSignals(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const categoryCountSignals = performanceCategoryCountSignals(t, 'page-text');
  const nonzeroSignals = categoryCountSignals.filter((signal) => signal.count > 0);
  const zeroCountSignals = categoryCountSignals.filter((signal) => signal.count === 0);
  const zeroNormalSignalCount = Math.max(
    zeroCountSignals.length,
    PERF_ZERO_SIGNALS.filter((re) => re.test(t)).length,
  );
  const healthyNormalSignalCount = PERF_HEALTHY_SIGNALS.filter((re) => re.test(t)).length;
  const metricSignalCount = PERF_METRIC_SIGNALS.filter((re) => re.test(t)).length;
  const loading = /loading|please wait|加载中|请稍候/i.test(t);
  return {
    categoryCountSignals,
    nonzeroSignals,
    zeroCountSignals,
    zeroNormalSignalCount,
    healthyNormalSignalCount,
    metricSignalCount,
    loading,
    pageComplete: !loading && (
      nonzeroSignals.length > 0 || zeroNormalSignalCount > 0
      || (healthyNormalSignalCount > 0 && metricSignalCount > 0)
    ),
  };
}

export const performanceCheck = {
  id: 'performance',
  no: 2,
  title: '绩效未处理检查',
  requirement: 'performance/dashboard 只要仍存在非零违规、限制、风险或标红告警就持续异常；仅页面明确清除后恢复正常，不做自动归档',
  paths: ['/performance/dashboard', '/performance/dashboard?ref=ah_home'],
  settleMs: 1200,
  readyTimeoutMs: 30000,
  readyPollMs: 2000,
  ready({ dom, txt }) {
    const explicitNonzero = [...(dom?.nonzeroSignals || []), ...(txt?.nonzeroSignals || [])]
      .some((signal) => Number.isSafeInteger(signal?.count) && signal.count > 0);
    const redWarn = dom?.hasRedWarning === true
      || (dom?.redTexts || []).some((r) => r.matchesWarnVocab === true);
    const badPill = (dom?.sections || []).some(
      (s) => s.pill && !/^(healthy|good|健康|良好)$/i.test(s.pill),
    );
    return explicitNonzero || redWarn || badPill || (n(txt?.warnCount) ?? 0) > 0
      || (dom?.pageComplete === true && txt?.pageComplete === true);
  },
  extractor: PERFORMANCE_EXTRACTOR,
  parseText(text) {
    const t = String(text).replace(/\s+/g, ' ');
    const hits = [];
    const re = new RegExp(PERF_WARN.source, 'gi');
    let m;
    while ((m = re.exec(t)) !== null && hits.length < 20) {
      // Account Health lists category names such as "Policy Violations 0".
      // A zero-count navigation/category label is evidence of no open issue,
      // not a warning merely because its name contains "violation".
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 16);
      if (/^\s*(?:[:：=-]\s*)?\(?0(?:\b|\s*\))/.test(after)) continue;
      const context = t.slice(Math.max(0, m.index - 80), m.index + m[0].length + 120);
      const assuranceContext = t.slice(Math.max(0, m.index - 260), m.index + m[0].length + 120);
      if (PERF_BENIGN_ASSURANCE.test(assuranceContext)) continue;
      if (/(?:learn (?:more )?about|help (?:page|center)|how to (?:avoid|resolve|appeal)|(?:last|past|previous)\s+180\s+days|了解(?:有关)?|帮助(?:页面|中心)|过去\s*180\s*天)/i.test(context)) continue;
      hits.push(t.slice(Math.max(0, m.index - 70), m.index + 70).trim());
    }
    const landed = /account health|customer service performance|policy compliance|shipping performance|账户状况|客户服务绩效|政策合规性|配送绩效/i.test(t);
    const signals = performanceTextSignals(t);
    return {
      landed,
      warnHits: hits,
      warnCount: hits.length,
      ...signals,
      pageComplete: landed && signals.pageComplete,
      looksLikeLogin: /amazon sign[\s-]*in|email or mobile phone number/i.test(t),
    };
  },
  judge({ dom, txt, store }) {
    // Red *and* warning vocabulary together is the signal. Red alone is often
    // decorative; warning words alone can come from help text.
    const redWarn = (dom?.redTexts || []).filter((r) => r.matchesWarnVocab);
    const redWarningFlag = dom?.hasRedWarning === true;
    const badPills = (dom?.sections || []).filter(
      (s) => s.pill && !/^(healthy|good|健康|良好)$/i.test(s.pill),
    );
    const domNonzero = (dom?.nonzeroSignals || []).filter(
      (signal) => Number.isSafeInteger(signal?.count) && signal.count > 0,
    );
    const textNonzero = (txt?.nonzeroSignals || []).filter(
      (signal) => Number.isSafeInteger(signal?.count) && signal.count > 0,
    );
    const explicitByKey = new Map();
    for (const signal of [...domNonzero, ...textNonzero]) {
      const key = `${clean(signal.key, 120) || clean(signal.category, 120) || 'unknown'}|${signal.count}`;
      const prior = explicitByKey.get(key);
      if (prior) prior.routes.push(signal.source || (domNonzero.includes(signal) ? 'dom' : 'page-text'));
      else explicitByKey.set(key, { ...signal, routes: [signal.source || (domNonzero.includes(signal) ? 'dom' : 'page-text')] });
    }
    const explicitNonzero = [...explicitByKey.values()];
    const textWarn = txt?.warnCount || 0;
    const domComplete = dom?.pageComplete === true;
    const textComplete = txt?.pageComplete === true;
    const bothComplete = domComplete && textComplete;

    const performanceEventItems = [
      ...explicitNonzero.map((signal) => ({
        itemKey: stableItemKey('performance', store, {
          identifier: clean(signal.key || signal.category, 120), reason: String(signal.count),
        }),
      })),
      ...redWarn.map((warning) => ({
        itemKey: stableItemKey('performance-red', store, { summary: clean(warning.text, 240) }),
      })),
      ...badPills.map((section) => ({
        itemKey: stableItemKey('performance-section', store, {
          identifier: clean(section.name, 120), reason: clean(section.pill, 120),
        }),
      })),
    ];
    const hardSignalCount = explicitNonzero.length + redWarn.length + badPills.length
      + (redWarningFlag && !redWarn.length ? 1 : 0);
    const currentEventKeys = [...new Set(
      performanceEventItems.map((item) => clean(item.itemKey, 80)).filter(Boolean),
    )];
    const rawHard = hardSignalCount > 0;

    const reasons = [];
    for (const signal of explicitNonzero.slice(0, 10)) {
      const routes = [...new Set(signal.routes)].join(' + ');
      reasons.push(`明确非零违规：${signal.category || signal.key} = ${signal.count}（${routes}）`);
    }
    for (const r of redWarn.slice(0, 6)) reasons.push(`标红提示：${r.text}`);
    if (redWarningFlag && !redWarn.length) reasons.push('DOM 检测到带绩效告警语义的标红提示');
    for (const s of badPills) reasons.push(`${s.name} = ${s.pill}`);
    if (!explicitNonzero.length && !redWarningFlag && !redWarn.length && !badPills.length && textWarn > 0) {
      reasons.push(`页面文本出现 ${textWarn} 处绩效告警词（未确认标红），建议人工确认`);
    }

    const hard = rawHard;
    const soft = !hard && textWarn > 0;
    if (!rawHard && !soft && !bothComplete) {
      reasons.push('绩效页仅确认标题落地，DOM 与页面文本未各自取得明确零违规或健康指标，不能判定正常');
    }
    return {
      status: hard ? 'ATTENTION_REQUIRED' : soft ? 'REVIEW_SUGGESTED'
        : bothComplete ? 'CLEAR' : 'PARTIAL_EVIDENCE',
      ok: !rawHard && !soft && bothComplete,
      severity: hard ? 'CRITICAL' : soft ? 'WARN' : bothComplete ? 'OK' : 'ERROR',
      confidence: explicitNonzero.length > 0 || bothComplete ? 'high' : rawHard || soft ? 'medium' : 'low',
      reasons,
      metrics: {
        redWarnings: redWarn.length,
        redTotal: n(dom?.redCount) ?? 0,
        badSections: badPills.length,
        textWarnings: textWarn,
        nonzeroViolationSignals: explicitNonzero.length,
        domNonzeroViolationSignals: domNonzero.length,
        textNonzeroViolationSignals: textNonzero.length,
        domComplete,
        textComplete,
        normalEvidenceComplete: bothComplete,
        domZeroNormalSignals: n(dom?.zeroNormalSignalCount) ?? 0,
        textZeroNormalSignals: n(txt?.zeroNormalSignalCount) ?? 0,
        domHealthyNormalSignals: n(dom?.healthyNormalSignalCount) ?? 0,
        textHealthyNormalSignals: n(txt?.healthyNormalSignalCount) ?? 0,
        domMetricSignals: n(dom?.metricSignalCount) ?? 0,
        textMetricSignals: n(txt?.metricSignalCount) ?? 0,
        activeBusinessEventCount: hardSignalCount,
        observedBusinessItemKeys: currentEventKeys,
        businessStatus: hard ? 'ANOMALY' : soft ? 'REVIEW' : 'CLEAR',
      },
      items: explicitNonzero.map((signal) => ({
        type: 'nonzero-violation', key: signal.key, category: signal.category,
        count: signal.count, source: [...new Set(signal.routes)].join('+'), context: signal.context,
      })).concat(redWarn.map((r) => ({ type: 'red', text: r.text }))).concat(
        badPills.map((s) => ({ type: 'section', text: `${s.name}: ${s.pill}` })),
      ),
      notes: dom?.notes || [],
      baselineEligible: bothComplete,
    };
  },
};

// -------------------------------------------------------------- 3. Feedback
export const feedbackCheck = {
  id: 'feedback',
  no: 3,
  title: 'Recent Feedback 检查',
  requirement: '仅检查北京时间当天 Feedback；当天低于 4 分提醒，双路确认的亚马逊物流责任记录除外',
  paths: ['/feedback-manager/index.html', '/feedback-manager'],
  settleMs: 1200,
  // feedback-manager is an SPA and can append its view query shortly after
  // navigation. Establish the final full URL identity before the strict
  // evidence-read TOCTOU gate; any later query/fragment change still blocks.
  urlStabilizeMs: 2500,
  urlStabilizePollMs: 300,
  pageIdentityRetries: 2,
  // Feedback Manager can remain a navigation-only SPA shell for tens of
  // seconds on a cold ZiNiao profile. Wait for real rating/empty evidence.
  readyTimeoutMs: 60000,
  readyPollMs: 2000,
  // The empty Recent Feedback grid is rendered before its async rows. Even
  // when no visible spinner is exposed to accessibility APIs, hold a bounded
  // observation window so the blank table shell cannot become a false CLEAR.
  readyMinWaitMs: 12000,
  screenshotRequiresReady: true,
  retryFreshSessionWhenNotReady: true,
  ready({ dom, txt }) {
    // A normal verdict requires two independent evidence routes.  Keep
    // polling when only one route can see the asynchronously rendered stars.
    return ((n(dom?.total) ?? 0) > 0 && (n(txt?.total) ?? 0) > 0)
      || (dom?.emptyState === true && txt?.emptyState === true);
  },
  extractor: FEEDBACK_EXTRACTOR,
  parseText(text) {
    const t = String(text).replace(/\s+/g, ' ');
    const ratings = [];
    const ratingItems = [];
    const dateMatches = [];
    const dateRe = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b|\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/gi;
    let dateMatch;
    while ((dateMatch = dateRe.exec(t)) !== null && dateMatches.length < 500) {
      dateMatches.push({ value: dateMatch[0], index: dateMatch.index });
    }
    const re = /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5/gi;
    let m;
    let aggregateRating = null;
    while ((m = re.exec(t)) !== null && ratings.length < 200) {
      const v = parseFloat(m[1]);
      if (v >= 1 && v <= 5) {
        const nearest = [...dateMatches].sort((a, b) => Math.abs(a.index - m.index) - Math.abs(b.index - m.index))[0];
        const closeDate = nearest && Math.abs(nearest.index - m.index) <= 500 ? nearest.value : null;
        const context = t.slice(Math.max(0, m.index - 320), Math.min(t.length, m.index + m[0].length + 320));
        if (!closeDate && /(?:\d[\d,]*\s+total ratings?|feedback histogram|反馈数量|反馈百分比)/i.test(context)) {
          aggregateRating = v;
          continue;
        }
        ratings.push(v);
        const fields = contextFields(context);
        ratingItems.push({
          rating: v, source: 'pagetext-row', context, summary: context,
          asin: fields.asin, date: closeDate, identifier: fields.identifier,
          amazonFulfillmentExcluded: /fulfilled by amazon[\s\S]{0,260}(?:take|takes|taken|accept|assume|bear)[\s\S]{0,100}responsib/i.test(context)
            || /amazon[\s\S]{0,140}(?:take|takes|taken|accept|assume|bear)[\s\S]{0,100}responsib[\s\S]{0,180}fulfill/i.test(context)
            || /亚马逊[\s\S]{0,180}(?:配送|物流)[\s\S]{0,100}负责/i.test(context)
            || /(?:配送|物流)[\s\S]{0,180}亚马逊[\s\S]{0,100}负责/i.test(context),
        });
      }
    }
    const landed = /feedback manager|recent feedback|feedback rating|buyer feedback|反馈管理器|最新反馈|反馈评级/i.test(t);
    const loading = /loading|please wait|加载中|请稍候/i.test(t);
    const explicitEmpty = /no (?:recent )?feedback|0\s+(?:feedback|results)|暂无反馈|没有反馈|0\s*条结果/i.test(t);
    const recentGridReady = /(?:recent feedback[\s\S]{0,240}date[\s\S]{0,120}rating[\s\S]{0,160}order id|最新反馈[\s\S]{0,240}日期[\s\S]{0,120}评级[\s\S]{0,160}订单编号)/i.test(t);
    return {
      landed,
      total: ratings.length,
      lowCount: ratings.filter((r) => r < 4).length,
      ratings: ratings.slice(0, 40),
      ratingItems: ratingItems.slice(0, 100),
      lowRatings: ratingItems.filter((r) => r.rating < 4).slice(0, 100),
      aggregateRating,
      loading,
      emptyState: explicitEmpty || (landed && recentGridReady && !loading && ratingItems.length === 0),
      looksLikeLogin: /amazon sign[\s-]*in/i.test(t),
    };
  },
  judge({ dom, txt, store, config }) {
    const today = bjDateKey(config?._now || new Date());
    const domRows = feedbackDatedRows(dom?.ratings?.length ? dom.ratings : dom?.lowRatings);
    const txtRows = feedbackDatedRows(txt?.ratingItems?.length ? txt.ratingItems : txt?.lowRatings);
    const domTodayAll = domRows.filter((item) => item.dateKey === today);
    const txtTodayAll = txtRows.filter((item) => item.dateKey === today);
    const domToday = domTodayAll.filter((item) => !item.amazonFulfillmentExcluded);
    const txtToday = txtTodayAll.filter((item) => !item.amazonFulfillmentExcluded);
    const domExcludedLow = domTodayAll.filter((item) => item.rating < 4 && item.amazonFulfillmentExcluded).length;
    const txtExcludedLow = txtTodayAll.filter((item) => item.rating < 4 && item.amazonFulfillmentExcluded).length;
    const excludedLow = Math.min(domExcludedLow, txtExcludedLow);
    const exclusionCountsAgree = domExcludedLow === txtExcludedLow;
    const domUnknownLow = domRows.filter((item) => item.rating < 4 && !item.dateKey && !item.amazonFulfillmentExcluded).length;
    const txtUnknownLow = txtRows.filter((item) => item.rating < 4 && !item.dateKey && !item.amazonFulfillmentExcluded).length;
    const unknownDateLow = Math.max(domUnknownLow, txtUnknownLow);
    const domLow = domToday.filter((item) => item.rating < 4).length;
    const txtLow = txtToday.filter((item) => item.rating < 4).length;
    // Take the higher same-day count: missing a new negative is costlier than
    // asking an operator to reconcile a count mismatch.
    const low = Math.max(domLow, txtLow);
    const total = Math.max(domToday.length, txtToday.length);
    const todayDomLowItems = domRows.filter((item) => item.rating < 4 && item.dateKey === today);
    const todayTextLowItems = txtRows.filter((item) => item.rating < 4 && item.dateKey === today);
    const lowItems = mergeLowItems('feedback', todayDomLowItems, todayTextLowItems, store, 'rating');
    const structuredCount = lowItems.filter((item) => item.itemKey && calendarDateKey(item.date) === today).length;
    const structuredComplete = low === structuredCount && domLow === low;
    const confirmedEmpty = dom?.emptyState === true && txt?.emptyState === true;
    const domDateScopeComplete = dom?.emptyState === true || (domRows.some((item) => item.dateKey) && domUnknownLow === 0);
    const textDateScopeComplete = txt?.emptyState === true || (txtRows.some((item) => item.dateKey) && txtUnknownLow === 0);
    const bothRatingEvidence = domDateScopeComplete && textDateScopeComplete;
    const sameDayCountsAgree = domToday.length === txtToday.length && domLow === txtLow;
    const normalProven = confirmedEmpty || (bothRatingEvidence && sameDayCountsAgree && exclusionCountsAgree);
    const reasons = [];
    if (low > 0) reasons.push(`${today} 当天出现 ${low} 条低于 4 分的 Feedback`);
    for (const r of lowItems.slice(0, 5)) {
      reasons.push(`${r.rating} 分${r.asin ? ` (${r.asin})` : ''}：${String(r.summary || '').slice(0, 80)}`);
    }
    if (unknownDateLow > 0) reasons.push(`发现 ${unknownDateLow} 条低分 Feedback 缺少可解析日期，不能跨天忽略`);
    if (excludedLow > 0) reasons.push(`已排除 ${excludedLow} 条由页面明确标识为亚马逊物流负责的当日低分 Feedback`);
    if (!exclusionCountsAgree) reasons.push('两条证据对亚马逊物流责任标识数量不一致，未一致的低分仍保留为异常');
    if (!confirmedEmpty && !bothRatingEvidence) reasons.push('DOM 与页面文本尚未同时取得带日期的 Feedback 记录，不能确认当天无差评');
    else if (!confirmedEmpty && !sameDayCountsAgree) reasons.push('DOM 与页面文本的当天 Feedback 数量不一致，不能确认当天结果完整');
    if (low > 0 && !structuredComplete) reasons.push(`当天 ${low} 条低分中仅 ${structuredCount} 条完成稳定日期/记录绑定；未绑定条目保留异常`);

    return {
      status: low > 0 ? 'TODAY_LOW_RATING' : normalProven ? 'CLEAR' : total ? 'PARTIAL_EVIDENCE' : 'UNKNOWN',
      ok: low === 0 && normalProven,
      severity: low > 0 ? 'CRITICAL' : normalProven ? 'OK' : 'ERROR',
      confidence: normalProven && structuredComplete ? 'high' : low > 0 ? 'medium' : 'low',
      reasons,
      metrics: {
        date: today, lowCount: low, todayTotal: total,
        historicalIgnoredCount: Math.max(0, Math.max(
          domRows.length - domTodayAll.length,
          txtRows.length - txtTodayAll.length,
        )),
        amazonFulfillmentExcludedLowCount: excludedLow,
        domAmazonFulfillmentExcludedLowCount: domExcludedLow,
        textAmazonFulfillmentExcludedLowCount: txtExcludedLow,
        amazonFulfillmentExclusionEvidenceAgree: exclusionCountsAgree,
        unknownDateLowCount: unknownDateLow,
        businessStatus: low > 0 ? 'ANOMALY' : 'CLEAR',
        total, average: n(dom?.average) ?? n(txt?.average), confirmedEmpty, bothRatingEvidence,
        sameDayCountsAgree, structuredCount, structuredComplete,
      },
      items: lowItems,
      notes: dom?.notes || [],
    };
  },
};

// --------------------------------------------------- 9. Inbox 买家新消息
const INBOX_LANDED_RE = /buyer[\s-]*seller messag|message center|messages|inbox|买家消息|卖家消息|消息中心|收件箱/i;
const INBOX_EMPTY_RE = /no (?:new |unread )?messages|you have no messages|there are no messages|no messages (?:that )?(?:need|needing|require)s? a? ?(?:response|reply)|inbox is empty|0 messages|没有需要回复的消息|没有待回复的消息|暂无消息|没有消息|收件箱为空|无消息/i;
// The v3 metrics card states the pending count verbatim ("需要回复 0"), which is
// the most reliable signal on the page: it is Amazon's own number, not a row
// count we inferred.
const INBOX_PENDING_DECLARED_RE = /(?:需要回复|待回复|response needed|responses? needed|needs response)\s*[:：(（]?\s*(\d{1,4})(?!\s*(?:%|天|days?))/i;
// The page header carries a metrics date range ("8月5日 - 2026年9月4日的全球通信
// 指标"); its dates must never be mistaken for message rows.
const INBOX_METRICS_CONTEXT_RE = /指标|metrics|全球通信|global communication/i;
const INBOX_HEADER_RE = /(?:from[\s\S]{0,160}subject|subject[\s\S]{0,160}(?:date|received)|most recent message|发件人[\s\S]{0,160}主题|主题[\s\S]{0,160}日期|最近消息)/i;
const INBOX_MARKER_RE = /(?:^|[^a-z])unread(?:[^a-z]|$)|mark as (?:read|unread)|未读|已读|标为已读/i;
const INBOX_NEEDS_RESPONSE_RE = /needs? (?:a )?(?:response|reply)|awaiting (?:your )?(?:response|reply)|response required|reply needed|待回复|需要回复|未回复/i;
const INBOX_DATE_RE = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b|\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/gi;

function inboxUnreadItems(dom, store) {
  const rows = Array.isArray(dom?.unreadRows) ? dom.unreadRows : [];
  const items = [];
  const seen = new Set();
  for (const row of rows) {
    // Deliberately narrow: no buyer name, subject or message body is retained.
    const item = {
      date: clean(row?.date, 80),
      unread: true,
      needsResponse: row?.needsResponse === true,
      identifier: clean(row?.identifier, 40),
      source: clean(row?.source, 40),
      storeKey: store?.key || null,
      storeName: store?.name || null,
    };
    item.itemKey = stableItemKey('inbox', store, item);
    const key = item.itemKey || `unkeyed:${items.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= 40) break;
  }
  return items;
}

export const inboxCheck = {
  id: 'inbox',
  no: 9,
  title: 'Inbox 买家消息检查',
  requirement: 'Inbox 出现未读/待回复的买家消息即需运营处理；只读列表，绝不打开会话',
  // The live UI is messaging v3; the old /messaging/inbox route only renders the
  // surrounding navigation. `fi=responseNeeded` is Amazon's own "needs reply"
  // filter, so the filtered view *is* the business signal: every listed row is a
  // buyer message awaiting a reply, and an empty filtered list means nothing is
  // pending. Unfiltered v3 and the legacy route stay as bounded fallbacks.
  paths: [
    '/messaging/inbox-v3?fi=responseNeeded',
    '/messaging/inbox-v3',
    '/messaging/inbox',
  ],
  // A cold deep link leaves the messaging app unmounted: only Seller Central's
  // navigation renders and no message table exists in any document. Bootstrap
  // through Seller Central and follow the page's own read-only messaging link,
  // exactly like the ads check reaches Campaign Manager. The direct paths above
  // stay as bounded fallbacks.
  bootstrapPath: '/home',
  linkExtractor: INBOX_LINK_EXTRACTOR,
  // Messaging v3 is a two-pane layout: on the default ~930px ZiNiao window the
  // list pane sits outside the viewport and never renders, which is why an
  // otherwise healthy page yielded no rows at all.
  minWindowWidth: 1600,
  minWindowHeight: 1000,
  navigationLink: { labels: ['买家与卖家消息服务', '买家消息', '收件箱', 'Buyer-Seller Messaging', 'Message Center'] },
  preferFollowedLink: true,
  settleMs: 1200,
  // Messaging is an SPA that appends its view query after navigation, exactly
  // like Feedback Manager, so establish the final URL identity before the
  // strict evidence-read gate.
  urlStabilizeMs: 2500,
  urlStabilizePollMs: 300,
  pageIdentityRetries: 2,
  // Real-machine evidence (messaging v3, both filtered and unfiltered): when the
  // list does not reach a readable document, no extra waiting and no fresh ZiNiao
  // session changes that. Fail fast so the 08:00/15:30 batches keep their
  // schedule; the verdict stays fail-closed (采集待修复), never a false green.
  readyTimeoutMs: 25000,
  readyPollMs: 2000,
  readyMinWaitMs: 8000,
  // Deliberately allow the screenshot even when the parser is not ready: the
  // page renders for a human even when its rows are unreachable from script, so
  // the operator can eyeball the inbox from the dashboard while the parser is
  // still being calibrated. The page-safety gate still suppresses any
  // login/captcha/interstitial frame.
  screenshotRequiresReady: false,
  retryFreshSessionWhenNotReady: false,
  extractor: INBOX_EXTRACTOR,
  ready({ dom, txt }) {
    if (dom?.emptyState === true && txt?.emptyState === true) return true;
    // Filtered "needs reply" view: rows counted (or an empty list rendered) on
    // the DOM side, with the text side showing the same filter context.
    if (dom?.responseNeededFilter === true && n(dom?.unreadCount) !== null) {
      return (n(txt?.totalRows) ?? 0) > 0 || txt?.emptyState === true || txt?.filterLabelPresent === true;
    }
    // Both routes must be able to quantify unread state before we stop polling.
    return n(dom?.unreadCount) !== null && n(txt?.unreadCount) !== null
      && (n(dom?.totalRows) ?? 0) > 0 && (n(txt?.totalRows) ?? 0) > 0;
  },
  parseText(text) {
    const t = String(text).replace(/\s+/g, ' ');
    const landed = INBOX_LANDED_RE.test(t);
    const loading = /loading|please wait|加载中|请稍候/i.test(t);
    const declaredMatch = /(?:unread|未读)[^0-9]{0,12}(\d{1,4})/i.exec(t)
      || /(\d{1,4})[^0-9]{0,12}(?:unread|未读)/i.exec(t);
    const declaredUnread = declaredMatch ? Number(declaredMatch[1]) : null;
    const needsResponseRe = new RegExp(INBOX_NEEDS_RESPONSE_RE.source, 'gi');
    let needsResponsePhrases = 0;
    while (needsResponseRe.exec(t) !== null && needsResponsePhrases < 200) needsResponsePhrases++;
    const dateRe = new RegExp(INBOX_DATE_RE.source, 'gi');
    const dates = [];
    let dateMatch;
    while ((dateMatch = dateRe.exec(t)) !== null && dates.length < 200) dates.push(dateMatch[0]);
    const markerVocabulary = INBOX_MARKER_RE.test(t);
    const filterLabelPresent = /需要回复|待回复|response needed|needs (?:a )?response|awaiting (?:your )?(?:response|reply)/i.test(t);
    const declaredPendingMatch = INBOX_PENDING_DECLARED_RE.exec(t);
    const declaredPending = declaredPendingMatch ? Number(declaredPendingMatch[1]) : null;
    const explicitEmpty = INBOX_EMPTY_RE.test(t);
    const gridReady = INBOX_HEADER_RE.test(t);
    const emptyState = explicitEmpty || (landed && gridReady && !loading && dates.length === 0);
    // Priority: Amazon's own pending number, then an explicit empty state. Row
    // counts are a last resort because the page's metrics header also carries a
    // date range that looks like a row to a flattened-text parser.
    const unreadCount = declaredPending !== null ? declaredPending
      : emptyState ? 0
        : declaredUnread !== null ? declaredUnread : null;
    // The left-nav filters ("全部 / 需要回复 / 已发送消息 / 已解决") are page chrome.
    // Counting those labels reported a phantom buyer message for every store, so
    // a phrase alone never becomes a count: only a declared number or an
    // explicit empty state does.
    const chromeOnly = landed && !gridReady && !explicitEmpty && dates.length === 0
      && declaredUnread === null && declaredPending === null;
    return {
      landed,
      loading,
      declaredUnread,
      declaredPending,
      needsResponsePhrases,
      unreadCount,
      markerVocabulary,
      filterLabelPresent,
      gridReady,
      chromeOnly,
      totalRows: dates.length,
      dates: dates.slice(0, 60),
      emptyState,
      looksLikeLogin: /amazon sign[\s-]*in|email or mobile phone number/i.test(t),
      looksBlocked: /robot check|enter the characters you see/i.test(t),
    };
  },
  judge({ dom, txt, store, config }) {
    const today = bjDateKey(config?._now || new Date());
    const domUnread = n(dom?.unreadCount);
    // The persisted URL is stripped of its query, so the text route cannot see
    // the filter itself. When the DOM proves we are in Amazon's "needs reply"
    // view and the text shows that same filter context, the flattened text's
    // dated rows are an independent count of the pending messages.
    const filterView = dom?.responseNeededFilter === true;
    const textFilterCorroborated = filterView
      && (txt?.filterLabelPresent === true || txt?.emptyState === true);
    // Row counts are the last resort: only when neither route has a declared
    // number nor an explicit empty state.
    const txtUnread = n(txt?.unreadCount)
      ?? (textFilterCorroborated && n(txt?.declaredPending) === null && txt?.emptyState !== true
        ? n(txt?.totalRows) : null);
    const bothKnown = domUnread !== null && txtUnread !== null;
    const countsAgree = bothKnown && domUnread === txtUnread;
    // Missing a new buyer message costs more than asking an operator to
    // reconcile a count mismatch, so take the higher of the two routes.
    const unread = Math.max(domUnread ?? 0, txtUnread ?? 0);
    const items = inboxUnreadItems(dom, store);
    const datedItems = items.filter((item) => calendarDateKey(item.date));
    const todayUnread = datedItems.filter((item) => calendarDateKey(item.date) === today).length;
    const oldestUnreadAt = datedItems
      .map((item) => calendarDateKey(item.date))
      .sort()[0] || null;
    const confirmedEmpty = dom?.emptyState === true && txt?.emptyState === true;
    const paginationComplete = dom?.paginationComplete === true;
    const rowsSeen = (n(dom?.totalRows) ?? 0) > 0 || (n(txt?.totalRows) ?? 0) > 0;
    // The message table is not always part of the main document. When neither
    // route can see rows, say so explicitly instead of leaving an operator with
    // an unexplained technical red.
    const listOutsideMainDocument = dom?.landed === true
      && (n(dom?.totalRows) ?? 0) === 0 && dom?.emptyState !== true
      && (txt?.chromeOnly === true || (n(dom?.visibleFrameCount) ?? 0) > 0);
    // Normal needs proof: either both routes say the inbox is empty, or both
    // quantify zero unread on a listing we know is complete.
    const normalProven = confirmedEmpty
      || (bothKnown && domUnread === 0 && txtUnread === 0 && paginationComplete);

    const reasons = [];
    if (unread > 0) {
      reasons.push(`Inbox 出现 ${unread} 条未读/待回复的买家消息，需运营在 24 小时内回复`);
      if (todayUnread > 0) reasons.push(`其中 ${today} 当天新增 ${todayUnread} 条`);
      if (oldestUnreadAt && oldestUnreadAt !== today) reasons.push(`最早未回复消息日期为 ${oldestUnreadAt}`);
      if (!countsAgree) reasons.push(`DOM 与页面文本的未读数量不一致（DOM ${domUnread ?? '未知'} / 文本 ${txtUnread ?? '未知'}），已取较大值`);
    } else if (!normalProven) {
      if (listOutsideMainDocument) {
        reasons.push('Inbox 消息列表未出现在主文档，只读到导航与筛选文案（列表疑似嵌套文档/iframe），未取得可判定的未读证据');
        reasons.push('左侧“需要回复”等筛选项属于页面导航，不作为买家消息计数');
      }
      if (!bothKnown) {
        reasons.push(domUnread === null && txtUnread === null
          ? '两条证据路径都未取得可量化的未读状态，不能确认 Inbox 没有新消息'
          : domUnread === null
            ? 'DOM 路径未找到未读状态标识，不能据此确认没有新消息'
            : '页面文本未提供可量化的未读计数，不能据此确认没有新消息');
      } else if (!paginationComplete) {
        reasons.push('未能确认已读完 Inbox 列表全部分页，第一页 0 条未读不足以判定正常');
      }
    }
    if (dom?.boldRowCount > 0 && unread === 0) {
      reasons.push(`列表存在 ${dom.boldRowCount} 行加粗样式但无未读标识，加粗不作为未读依据，请人工复核截图`);
    }

    return {
      status: unread > 0 ? 'NEW_BUYER_MESSAGE'
        : normalProven ? 'CLEAR'
          : rowsSeen ? 'PARTIAL_EVIDENCE' : 'UNKNOWN',
      ok: unread === 0 && normalProven,
      severity: unread > 0 ? 'WARN' : normalProven ? 'OK' : 'ERROR',
      confidence: unread > 0
        ? (countsAgree ? 'high' : 'medium')
        : normalProven ? 'high' : 'low',
      reasons,
      metrics: {
        unreadCount: unread,
        domUnreadCount: domUnread,
        textUnreadCount: txtUnread,
        countsAgree,
        todayUnreadCount: todayUnread,
        todayUnreadCountSource: 'dom',
        oldestUnreadAt,
        domNeedsResponseRows: n(dom?.needsResponseCount),
        textNeedsResponsePhrases: n(txt?.needsResponsePhrases),
        domDeclaredUnread: n(dom?.declaredUnread),
        textDeclaredUnread: n(txt?.declaredUnread),
        badgeCount: n(dom?.badgeCount),
        totalRows: n(dom?.totalRows), textRows: n(txt?.totalRows),
        boldRowCount: n(dom?.boldRowCount),
        markerVocabulary: dom?.markerVocabulary === true && txt?.markerVocabulary === true,
        visibleFrameCount: n(dom?.visibleFrameCount),
        frameContentReadable: dom?.frameContentReadable ?? null,
        responseNeededFilter: filterView,
        filterEvidence: clean(dom?.filterEvidence, 40),
        textFilterCorroborated,
        listOutsideMainDocument,
        textChromeOnly: txt?.chromeOnly === true,
        confirmedEmpty,
        paginationComplete,
        date: today,
        businessStatus: unread > 0 ? 'ANOMALY' : 'CLEAR',
        collectionStatus: normalProven || unread > 0 ? 'COMPLETE' : 'PARTIAL_EVIDENCE',
      },
      items,
      notes: dom?.notes || [],
    };
  },
};

// --------------------------------------------------------------- 4. Reviews
export const reviewsCheck = {
  id: 'reviews',
  no: 4,
  title: 'Customer Reviews 检查',
  requirement: '品牌评论源中，本店有效 ASIN 出现低于 4 星的评价即为异常；范围外商品不归入本店结果',
  paths: ['/brand-customer-reviews', '/brand-customer-reviews/ref=xx_crvws_dnav_xx'],
  // The reviews SPA often paints its shell several seconds before the list.
  // Wait for the data rows so a fully loaded screenshot cannot coexist with an
  // UNKNOWN verdict captured from the earlier empty shell.
  settleMs: 1200,
  readyTimeoutMs: 45000,
  readyPollMs: 2500,
  // A hydrated header plus a perpetual loading spinner is not review
  // evidence. Never preserve that shell as the screenshot, and make room for
  // one genuinely fresh ZiNiao profile even when earlier attempts were spent
  // recovering Chromium internal pages.
  screenshotRequiresReady: true,
  retryFreshSessionWhenNotReady: true,
  maxAttempts: 4,
  ready({ dom, txt }) {
    if (dom?.emptyState === true && txt?.emptyState === true) return true;
    const domTotal = n(dom?.total) ?? 0;
    const textTotal = n(txt?.total) ?? 0;
    if (domTotal <= 0 || textTotal <= 0) return false;
    const domLow = n(dom?.lowCount) ?? 0;
    const textLow = n(txt?.lowCount) ?? 0;
    const observedLow = Math.max(domLow, textLow);
    if (observedLow === 0) return true;
    const structuredLow = (dom?.lowReviews || []).filter((item) => (
      n(item?.stars) !== null && n(item?.stars) < 4
      && /^[A-Z0-9]{10}$/.test(clean(item?.asin, 10)?.toUpperCase() || '')
    )).length;
    return domLow === textLow && structuredLow === observedLow;
  },
  extractor: REVIEWS_EXTRACTOR,
  parseText(text) {
    const t = String(text).replace(/\s+/g, ' ');
    const stars = [];
    const reviews = [];
    const re = /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5/gi;
    let m;
    while ((m = re.exec(t)) !== null && stars.length < 200) {
      const v = parseFloat(m[1]);
      if (v >= 1 && v <= 5) {
        stars.push(v);
        reviews.push({ stars: v, source: 'pagetext' });
      }
    }
    return {
      landed: /customer reviews|brand customer reviews|star rating|买家评论|星级评定/i.test(t),
      total: stars.length,
      lowCount: stars.filter((s) => s < 4).length,
      lowReviews: reviews.filter((r) => r.stars < 4).slice(0, 100),
      emptyState: /no (?:customer )?reviews|0\s+(?:reviews|results)|暂无评论|没有评论|0\s*条结果/i.test(t),
      looksLikeLogin: /amazon sign[\s-]*in/i.test(t),
    };
  },
  judge({ dom, txt, store, prev, reviewOwnership }) {
    const domLow = n(dom?.lowCount) ?? 0;
    const txtLow = n(txt?.lowCount) ?? 0;
    const brandLow = Math.max(domLow, txtLow);
    const total = Math.max(n(dom?.total) ?? 0, n(txt?.total) ?? 0);
    const brandLowItems = mergeLowItems('review', dom?.lowReviews, txt?.lowReviews, store, 'stars');
    const structuredCount = brandLowItems.filter((item) => item.itemKey && item.asin).length;
    const structuredComplete = brandLow === structuredCount && domLow === brandLow;
    const confirmedEmpty = dom?.emptyState === true && txt?.emptyState === true;
    const bothRatingEvidence = (n(dom?.total) ?? 0) > 0 && (n(txt?.total) ?? 0) > 0;
    const ownershipFiltered = Boolean(reviewOwnership);
    const storeAsins = reviewOwnership?.storeAsins instanceof Set ? reviewOwnership.storeAsins : new Set();
    const ownersByAsin = reviewOwnership?.ownersByAsin instanceof Map ? reviewOwnership.ownersByAsin : new Map();
    const ownedItems = [];
    const otherStoreItems = [];
    const outOfScopeItems = [];
    const pendingItems = [];
    for (const item of brandLowItems) {
      if (!ownershipFiltered) {
        ownedItems.push(item);
        continue;
      }
      const candidates = [...new Set([item.asin, item.parentAsin, item.childAsin]
        .map((value) => clean(value, 10)?.toUpperCase())
        .filter((value) => /^[A-Z0-9]{10}$/.test(value)))];
      const ownedAsin = candidates.find((asin) => storeAsins.has(asin));
      if (ownedAsin) {
        const owners = ownersByAsin.get(ownedAsin) || new Set([store?.key].filter(Boolean));
        ownedItems.push({
          ...item,
          previousItemKeys: item.previousItemKeys, legacyItemKey: item.legacyItemKey,
          ownership: 'OWNED',
          ownershipAsin: ownedAsin,
          ownershipSource: reviewOwnership.source || 'asin-inventory',
          sharedOwnership: owners.size > 1,
        });
        continue;
      }
      const mappedAsin = candidates.find((asin) => (ownersByAsin.get(asin)?.size ?? 0) > 0);
      if (mappedAsin && reviewOwnership?.ready === true && storeAsins.size > 0) {
        otherStoreItems.push({ item, asin: mappedAsin });
      } else if (candidates.length && reviewOwnership?.ready === true && storeAsins.size > 0) {
        // A complete, non-empty inventory for this Seller account is the
        // ownership boundary. Brand pages may retain historical products or
        // products belonging to an external Seller account; a structured ASIN
        // absent from this store's scope must not become this store's alert.
        outOfScopeItems.push({ item, asins: candidates });
      } else {
        pendingItems.push({ item, asins: candidates });
      }
    }
    const storeLow = ownershipFiltered ? ownedItems.length : brandLow;
    const ownershipReady = !ownershipFiltered || reviewOwnership?.ready === true;
    const ownershipComplete = brandLow === 0 || (!ownershipFiltered
      ? structuredComplete
      : ownershipReady && storeAsins.size > 0 && structuredComplete && pendingItems.length === 0);
    const collectionFailed = brandLow > 0 && !ownershipComplete;
    const events = businessEventDelta(ownedItems, prev, storeLow);
    const newLow = storeLow > 0 && events.newCount > 0;
    const recordedLow = storeLow > 0 && events.newCount === 0 && bothRatingEvidence;
    const reasons = [];
    if (newLow) reasons.push(`本店商品出现 ${events.newCount} 条首次发现的低于 4 星 Review（本店 ${storeLow} 条，品牌页 ${brandLow} 条）`);
    else if (recordedLow) reasons.push(`本店 ${storeLow} 条低星 Review 已在首次发现时提醒并归档，本次无新增记录`);
    else if (storeLow > 0) reasons.push(`本店商品出现 ${storeLow} 条低于 4 星的 Review`);
    for (const r of ownedItems.filter((item) => !recordedLow && (
      events.freshKeys.has(item.itemKey) || events.currentKeys.length === 0
    )).slice(0, 5)) {
      reasons.push(`${r.stars} 星${r.asin ? ` (${r.asin})` : ''}：${String(r.summary || '').slice(0, 80)}`);
    }
    if (!total && !confirmedEmpty) reasons.push('等待真实评论内容后仍未解析到任何星级，无法确认是否有低星（请人工复核截图）');
    else if (brandLow === 0 && !bothRatingEvidence && !confirmedEmpty) reasons.push('只有一条证据路径解析到评论星级，不能据此下正常结论');
    if (brandLow > 0 && !structuredComplete) reasons.push(`品牌页 ${brandLow} 条低星中仅 ${structuredCount} 条完成稳定评论行/ASIN 绑定；未绑定条目保留采集异常`);
    if (ownershipFiltered && reviewOwnership?.ready !== true && brandLow > 0) {
      reasons.push('本店 ASIN 归属清单不可用，无法把品牌级评论可靠归属到店铺');
    }
    if (pendingItems.length) {
      const pendingAsins = [...new Set(pendingItems.flatMap((entry) => entry.asins))];
      reasons.push(`品牌页有 ${pendingItems.length} 条低星的店铺归属待核验${pendingAsins.length ? `（${pendingAsins.join('、')}）` : '（未绑定 ASIN）'}，不能算作本店正常或业务异常`);
    }

    const normalProven = bothRatingEvidence || confirmedEmpty;
    const collectionComplete = normalProven && ownershipComplete;
    const notes = [...(dom?.notes || [])];
    if (ownershipFiltered && otherStoreItems.length) {
      notes.push(`已从本店业务结果排除 ${otherStoreItems.length} 条确认属于其他店铺 ASIN 的品牌级低星评论`);
    }
    if (ownershipFiltered && outOfScopeItems.length) {
      notes.push(`已从本店业务结果排除 ${outOfScopeItems.length} 条不在本店有效 ASIN 清单中的品牌级低星评论`);
    }

    return {
      status: newLow || (storeLow > 0 && !recordedLow) ? 'LOW_REVIEW'
        : collectionFailed ? 'REVIEW_OWNERSHIP_UNKNOWN'
          : recordedLow ? 'RECORDED_LOW_REVIEW'
          : normalProven ? 'CLEAR' : total ? 'PARTIAL_EVIDENCE' : 'UNKNOWN',
      ok: !collectionFailed && (recordedLow || (storeLow === 0 && normalProven)),
      severity: newLow || (storeLow > 0 && !recordedLow) ? 'CRITICAL'
        : collectionFailed ? 'ERROR'
          : recordedLow || normalProven ? 'OK' : 'ERROR',
      confidence: domLow === txtLow && ownershipComplete ? 'high' : 'medium',
      reasons,
      metrics: {
        lowCount: storeLow, ownedLowCount: storeLow, brandLowCount: brandLow,
        excludedOtherStoreCount: otherStoreItems.length, ownershipPendingCount: pendingItems.length,
        excludedOutOfScopeCount: outOfScopeItems.length,
        ownershipPendingAsins: [...new Set(pendingItems.flatMap((entry) => entry.asins))],
        ownershipInventoryCount: Number(reviewOwnership?.inventoryCount ?? 0),
        ownershipFiltered, ownershipReady, ownershipComplete,
        ownershipSource: reviewOwnership?.source || (ownershipFiltered ? 'unavailable' : 'legacy-unscoped'),
        newLowCount: events.newCount, recordedLowCount: events.recordedCount,
        observedBusinessItemKeys: [...new Set([
          ...(Array.isArray(prev?.metrics?.observedBusinessItemKeys) ? prev.metrics.observedBusinessItemKeys : []),
          ...events.currentKeys,
        ])],
        businessStatus: newLow ? 'ANOMALY' : recordedLow ? 'RECORDED' : 'CLEAR',
        collectionStatus: collectionComplete ? 'COMPLETE' : 'PARTIAL_EVIDENCE',
        total, average: n(dom?.average), confirmedEmpty, bothRatingEvidence,
        structuredCount, structuredComplete,
      },
      items: reviewsByDate(ownedItems),
      notes,
      baselineEligible: !collectionFailed,
    };
  },
};

// ------------------------------------------------------------ 6. 奥特莱斯
const OUTLET_FILTER_CONTROL_RE = /selected filters?|filter criteria|recommendation filter|筛选条件|已选筛选条件/i;

function stableOutletRow(row) {
  return Boolean(clean(row?.asin, 10) || clean(row?.sku, 80) || clean(row?.offerId, 120));
}

function outletActionRows(dom) {
  return (dom?.skus || []).filter((row) => {
    if (row?.actionFound !== true) return false;
    // Selected-filter chrome can repeat the exact action label.  Suppress it
    // only when its own captured context proves it is a filter and it has no
    // stable product identity.  Ambiguous or identified rows remain visible to
    // the judge and therefore cannot be converted into a false green result.
    return !(OUTLET_FILTER_CONTROL_RE.test(clean(row?.row, 500)) && !stableOutletRow(row));
  });
}

function outletRowIdentity(row) {
  return [clean(row?.asin, 10), clean(row?.sku, 80), clean(row?.offerId, 120)]
    .filter(Boolean).join('|').toLowerCase();
}

function uniqueOutletActionRows(dom) {
  const seen = new Set();
  return outletActionRows(dom).filter((row) => {
    const identity = outletRowIdentity(row);
    if (!identity) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export const outletCheck = {
  id: 'outlet',
  no: 6,
  title: '奥特莱斯监控',
  requirement: 'Create outlet deal 出现新活动即需提醒',
  paths: [
    '/inventoryplanning/manageinventoryhealth?sort_column=product_details&sort_direction=asc&sort_column_sub=msku&RECOMMENDATION=OUTLET_DEAL',
  ],
  settleMs: 1200,
  // Some accounts replace Manage Inventory Health with /manage/fba-inventory and
  // then rewrite the recommendation query (`recommendation` -> `~recommendation`).
  // Wait until that redirect stops, and re-read if it still moves during the probe.
  urlStabilizeMs: 15000,
  urlStabilizePollMs: 400,
  pageIdentityRetries: 2,
  readyTimeoutMs: 30000,
  readyPollMs: 2000,
  ready({ dom, txt }) {
    const domRows = uniqueOutletActionRows(dom);
    const domZero = domRows.length === 0 && dom?.zeroResultsReliable === true
      && dom?.scanComplete === true && (n(dom?.ambiguousActionCount) ?? 0) === 0
      && dom?.pageComplete === true && dom?.paginationComplete === true;
    const textZero = txt?.zeroResults === true
      && txt?.pageComplete === true && txt?.paginationComplete === true;
    if (domZero && textZero) return true;
    const domCount = n(dom?.createDealCount);
    const textCount = n(txt?.mentionCount);
    return dom?.pageComplete === true && dom?.paginationComplete === true
      && txt?.pageComplete === true && txt?.paginationComplete === true
      && domCount !== null && domCount > 0 && textCount === domCount;
  },
  extractor: OUTLET_EXTRACTOR,
  parseText(text) {
    const t = String(text).replace(/\s+/g, ' ');
    const resultCounts = [...t.matchAll(/\b(\d+)\s+results?\b|(\d+)\s*条结果/gi)]
      .map((match) => Number(match[1] ?? match[2])).filter(Number.isFinite);
    const positiveResultCount = resultCounts.filter((count) => count > 0).sort((a, b) => b - a)[0] ?? null;
    const zeroResults = positiveResultCount === null
      && /0\s*results|did not return any results|0\s*条结果|未返回任何结果|无结果/i.test(t);
    const hits = t.match(/create (?:an )?outlet deal|创建奥特莱斯限时促销/gi) || [];
    const filterHits = t.match(/(?:selected filters?|filter criteria|已选筛选条件)[^]{0,120}(?:create (?:an )?outlet deal|创建奥特莱斯限时促销)/gi) || [];
    const totalMatch = /(?:total(?:\s+results?)?\s*[:\-]?\s*)(\d+)|\b(\d+)\s+results?\b/i.exec(t)
      || /共\s*(\d+)\s*条结果/.exec(t)
      || /总计\s*[:：]\s*(\d+)/.exec(t);
    const reportedTotal = positiveResultCount ?? (totalMatch ? Number(totalMatch[1] ?? totalMatch[2]) : null);
    const hasNextLabel = /\bnext(?:\s+page)?\b|下一页/i.test(t);
    const nextDisabled = /(?:next(?:\s+page)?|下一页)[^]{0,60}(?:disabled|unavailable|不可用|已禁用)|(?:disabled|不可用|已禁用)[^]{0,60}(?:next(?:\s+page)?|下一页)/i.test(t);
    const hasNextPage = hasNextLabel && !nextDisabled;
    const loading = /loading|please wait|加载中|请稍候/i.test(t);
    const mentionCount = zeroResults ? 0 : Math.max(hits.length - filterHits.length, 0);
    const activityReliable = !zeroResults && mentionCount > 0
      && reportedTotal !== null && reportedTotal === mentionCount;
    const reportedTotalReliable = false;
    const paginationComplete = zeroResults || (activityReliable && !hasNextPage);
    const landed = /inventory (health|age)|manage inventory|outlet|管理.*库存|库存状况|奥特莱斯/i.test(t);
    return {
      landed,
      mentionCount,
      filterMentionCount: filterHits.length,
      zeroResults,
      reportedTotal,
      hasNextPage,
      loading,
      activityReliable,
      reportedTotalReliable,
      paginationComplete,
      pageComplete: landed && !loading && paginationComplete,
      looksLikeLogin: /amazon sign[\s-]*in/i.test(t),
    };
  },
  judge({ dom, txt, prev, store }) {
    const rawActionableRows = (dom?.skus || []).filter((s) => s?.actionFound === true);
    const filteredActionableRows = outletActionRows(dom);
    const actionableRows = uniqueOutletActionRows(dom);
    const ignoredFilterControlCount = rawActionableRows.length - filteredActionableRows.length
      + (n(dom?.ignoredFilterControlCount) ?? 0);
    const ambiguousActionCount = n(dom?.ambiguousActionCount) ?? 0;
    const duplicateActionCount = filteredActionableRows.length - actionableRows.length
      + (n(dom?.duplicateActionCount) ?? 0);
    const domActivity = actionableRows.length;
    const stableActionableRows = actionableRows.filter(
      (s) => clean(s.asin, 10) || clean(s.sku, 80) || clean(s.offerId, 120),
    );
    // A global "0 results" string may belong to a filter widget while a real
    // Create outlet deal action is present in the table. A structural action
    // always wins; zero is accepted only when no actionable row was found.
    const domZero = domActivity === 0 && dom?.zeroResultsReliable === true
      && dom?.scanComplete === true && ambiguousActionCount === 0
      && dom?.pageComplete === true && dom?.paginationComplete === true;
    const textZero = txt?.zeroResults === true
      && txt?.pageComplete === true && txt?.paginationComplete === true;
    const confirmedZero = domZero && textZero;
    const domObservedActivity = confirmedZero ? 0 : domActivity;
    const textActivity = confirmedZero ? 0 : n(txt?.mentionCount) ?? 0;
    const textActivityReliable = confirmedZero || txt?.activityReliable === true;
    const items = actionableRows.map((s) => {
      const base = {
        asin: clean(s.asin, 10), sku: clean(s.sku, 80), offerId: clean(s.offerId, 120),
        row: clean(s.row, 500), actionHref: clean(s.actionHref, 500),
      };
      return { ...base, storeKey: store?.key || null, itemKey: stableItemKey('outlet', store, base) };
    });
    const keys = [...new Set(items
      .filter((s) => s.asin || s.sku || s.offerId)
      .map((s) => s.itemKey))];
    const businessEvidenceCount = confirmedZero ? 0 : keys.length;
    const count = confirmedZero ? 0 : keys.length;
    const stableRowsComplete = actionableRows.length > 0
      && actionableRows.every((s) => clean(s.asin, 10) || clean(s.sku, 80) || clean(s.offerId, 120))
      && keys.length === actionableRows.length;
    const domReportedTotal = n(dom?.reportedTotal);
    const textReportedTotal = n(txt?.reportedTotal);
    const domReportedTotalReliable = dom?.reportedTotalReliable === true;
    const textReportedTotalReliable = txt?.reportedTotalReliable === true;
    const textCountCorroboratesDom = txt?.landed === true && txt?.loading !== true
      && txt?.hasNextPage !== true
      && textReportedTotal !== null && textReportedTotal > 0
      && textReportedTotal === domActivity;
    const domPositiveComplete = dom?.pageComplete === true && dom?.paginationComplete === true
      && dom?.hasNextPage !== true && domActivity > 0
      && n(dom?.createDealCount) === domActivity
      && ((domReportedTotalReliable && domReportedTotal === domActivity) || textCountCorroboratesDom)
      && stableRowsComplete;
    const textPositiveComplete = txt?.landed === true && txt?.loading !== true
      && txt?.hasNextPage !== true
      && ((textActivityReliable && textActivity > 0 && textReportedTotal === textActivity)
        || textCountCorroboratesDom);
    const positiveComplete = domPositiveComplete && textPositiveComplete
      && (textActivity > 0 ? domActivity === textActivity : textCountCorroboratesDom);
    const evidenceComplete = confirmedZero || positiveComplete;
    const prevKeys = new Set(prev?.metrics?.dealKeys || []);
    const isFirstRun = !prev;
    // Totals are retained as diagnostics only. New business activity is proven
    // exclusively by stable set difference; a full-page count can never create
    // or amplify NEW_DEAL.
    const reportedTotalsAgree = dom?.landed === true && txt?.landed === true
      && domReportedTotalReliable
      && dom?.zeroResults !== true && txt?.zeroResults !== true
      && domReportedTotal !== null && textReportedTotal !== null
      && domReportedTotal === textReportedTotal;
    const reportedTotalGrowth = 0;
    const observedCount = count;
    // "New activity" means an SKU that was not eligible last run. On the very
    // first run there is no baseline, so report the count without crying "new".
    const fresh = isFirstRun ? [] : keys.filter((k) => !prevKeys.has(k));
    const freshCount = isFirstRun ? 0 : fresh.length;
    const evidenceConflict = (domObservedActivity > 0 && textZero)
      || (textActivity > 0 && domZero)
      || (domObservedActivity > 0 && textActivity > 0 && domObservedActivity !== textActivity)
      || ambiguousActionCount > 0
      || dom?.scanComplete !== true
      || (!confirmedZero && !positiveComplete);

    const reasons = [];
    if (freshCount) reasons.push(
      fresh.length
        ? `出现 ${freshCount} 个新的可创建奥特莱斯活动：${fresh.slice(0, 10).join(', ')}`
        : `可创建奥特莱斯活动数量增加 ${prevCount} → ${observedCount}（双路总数证据，需复核具体 SKU）`,
    );
    else if (isFirstRun && count > 0) reasons.push(`首次运行，记录基线：当前有 ${count} 个可创建活动（本次不报警）`);
    if (evidenceConflict) {
      if (domActivity > 0) {
        reasons.push('DOM 找到真实活动行，但文本路径未确认相同完整活动集合，已保留活动并标记证据冲突');
      } else if (textActivity > 0) {
        reasons.push('文本路径发现活动数量，但 DOM 未找到可稳定标识的活动行，不能据此更新活动基线');
      } else if (domZero !== textZero) {
        reasons.push('只有一条证据路径明确显示 0 条结果，不能据此确认没有奥特莱斯活动');
      } else {
        reasons.push('奥特莱斯列表已落地，但双路均未取得明确 0 条结果或完整活动集合');
      }
    }
    if (!confirmedZero && (dom?.hasNextPage === true || txt?.hasNextPage === true)) {
      reasons.push('奥特莱斯列表存在未遍历的下一页，当前活动集合不完整');
    }
    if (!confirmedZero && actionableRows.length > 0 && !stableRowsComplete) {
      reasons.push('部分奥特莱斯活动行缺少稳定 ASIN/SKU/Offer 标识或标识重复，不能建立可靠集合基线');
    }
    if (ambiguousActionCount > 0) {
      reasons.push(`发现 ${ambiguousActionCount} 个无法绑定到稳定商品行的疑似奥特莱斯操作，需人工复核`);
    }
    if (dom?.scanComplete !== true) reasons.push('奥特莱斯 DOM 扫描未完整完成，不能确认活动集合或零结果');
    if (!evidenceComplete) {
      return {
        status: freshCount ? 'NEW_DEAL' : 'PARTIAL_EVIDENCE', ok: false,
        severity: freshCount ? 'WARN' : 'ERROR', confidence: 'conflict',
        reasons,
        metrics: {
          dealCount: observedCount, newCount: freshCount, dealKeys: keys.slice(0, 200), baseline: isFirstRun,
          confirmedZero, evidenceComplete, evidenceConflict,
          domActivity: domObservedActivity, textActivity, textActivityReliable, businessEvidenceCount,
          domReportedTotal, textReportedTotal, reportedTotalsAgree, reportedTotalGrowth,
          textCountCorroboratesDom,
          domReportedTotalReliable, textReportedTotalReliable,
          ignoredFilterControlCount, ambiguousActionCount, duplicateActionCount,
          scanComplete: dom?.scanComplete === true,
          domComplete: domPositiveComplete, textComplete: textPositiveComplete,
          paginationComplete: false, collectionStatus: 'PARTIAL_EVIDENCE',
        },
        items: items.slice(0, 200), notes: dom?.notes || [], baselineEligible: false,
      };
    }

    return {
      status: freshCount ? 'NEW_DEAL' : 'NO_CHANGE',
      ok: freshCount === 0,
      severity: freshCount ? 'WARN' : 'OK',
      confidence: 'high',
      reasons,
      metrics: {
        dealCount: observedCount, newCount: freshCount, dealKeys: keys.slice(0, 200), baseline: isFirstRun,
        confirmedZero, evidenceComplete, evidenceConflict: false,
        domActivity: domObservedActivity, textActivity, textActivityReliable, businessEvidenceCount,
        domReportedTotal, textReportedTotal, reportedTotalsAgree, reportedTotalGrowth,
        textCountCorroboratesDom,
        domReportedTotalReliable, textReportedTotalReliable,
        ignoredFilterControlCount, ambiguousActionCount, duplicateActionCount,
        scanComplete: dom?.scanComplete === true,
        domComplete: confirmedZero || domPositiveComplete,
        textComplete: confirmedZero || textPositiveComplete,
        paginationComplete: true, collectionStatus: 'COMPLETE',
      },
      items: items.slice(0, 200).map((s) => ({ ...s, isNew: fresh.includes(s.itemKey) })),
      notes: dom?.notes || [],
      baselineEligible: true,
    };
  },
};

// ------------------------------------------------------------------- 7. VOC
const VOC_REASON_RE = /(defective item|damaged item|wrong item(?: was sent)?|performance or quality not adequate|not as described|missing (?:parts?|components?)|inaccurate website description|arrived (?:late|damaged)|unwanted item|quality issue|商品有缺陷|商品存在瑕疵|商品损坏|错发商品|性能或质量不佳|性能或品质不理想|描述不符|缺少部件)/i;
const VOC_CX_RE = /\b(Very Poor|Poor|Fair|Good|Very Good|Excellent)\b|极差|不合格|非常差|较差|一般|良好|优秀|极好/i;

function canonicalVocCx(value) {
  const match = VOC_CX_RE.exec(String(value || ''));
  if (!match) return null;
  const raw = match[1] || match[0];
  if (/^Very Poor$/i.test(raw) || raw === '非常差') return 'Very Poor';
  if (/^Poor$/i.test(raw) || /^(?:极差|不合格|较差)$/.test(raw)) return 'Poor';
  if (/^Fair$/i.test(raw) || raw === '一般') return 'Fair';
  if (/^Good$/i.test(raw) || raw === '良好') return 'Good';
  if (/^Very Good$/i.test(raw)) return 'Very Good';
  if (/^Excellent$/i.test(raw) || /^(?:优秀|极好)$/.test(raw)) return 'Excellent';
  return null;
}

function worstVocCx(values) {
  const rank = { 'Very Poor': 0, Poor: 1, Fair: 2, Good: 3, 'Very Good': 4, Excellent: 5 };
  let result = null;
  for (const value of values || []) {
    const canonical = canonicalVocCx(value);
    if (canonical && (result === null || rank[canonical] < rank[result])) result = canonical;
  }
  return result;
}

function parseVocCxRows(text) {
  const raw = String(text || '');
  const asinRe = /\bB0[A-Z0-9]{8}\b/gi;
  const hits = [];
  let match;
  while ((match = asinRe.exec(raw)) !== null && hits.length < 500) {
    hits.push({ asin: match[0].toUpperCase(), index: match.index, end: asinRe.lastIndex });
  }
  const order = [];
  const byAsin = new Map();
  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index];
    if (!byAsin.has(hit.asin)) {
      byAsin.set(hit.asin, { asin: hit.asin, cxHealth: null, source: 'asin-segment' });
      order.push(hit.asin);
    }
    const next = hits[index + 1]?.index ?? raw.length;
    const segment = raw.slice(hit.end, Math.min(next, hit.end + 1600));
    const statuses = [];
    const cxRe = new RegExp(VOC_CX_RE.source, 'gi');
    let cxMatch;
    while ((cxMatch = cxRe.exec(segment)) !== null && statuses.length < 20) statuses.push(cxMatch[0]);
    const observed = worstVocCx(statuses);
    if (observed) {
      const row = byAsin.get(hit.asin);
      row.cxHealth = worstVocCx([row.cxHealth, observed]);
    }
  }
  return order.map((asin) => byAsin.get(asin));
}

function parseVocDetailText(text, expectedAsin = null, { url = '', scoped = false } = {}) {
  const raw = String(text || '');
  const t = raw.replace(/\s+/g, ' ').trim();
  expectedAsin = String(expectedAsin || '').toUpperCase() || null;
  const asins = [...new Set((t.match(/\bB0[A-Z0-9]{8}\b/gi) || []).map((value) => value.toUpperCase()))];
  let urlObserved = false;
  try {
    urlObserved = !!expectedAsin
      && new RegExp(`(?:^|[^A-Z0-9])${expectedAsin}(?:[^A-Z0-9]|$)`).test(decodeURIComponent(String(url || '')).toUpperCase());
  } catch { /* invalid URL evidence is ignored */ }
  const uniqueTextBinding = !!expectedAsin && asins.length === 1 && asins[0] === expectedAsin;
  const urlOnlyBinding = !!expectedAsin && urlObserved && asins.length === 0;
  const asinBound = !!expectedAsin && (urlOnlyBinding || uniqueTextBinding);
  const asin = asinBound ? expectedAsin : (!expectedAsin && asins.length === 1 ? asins[0] : null);
  const detailVocabulary = /return reason|customer issue|customer problem|customer feedback|ncx details?|return details?|退货原因|客户问题|买家反馈|相关记录/i.test(t);
  const cxObserved = /(?:CX Health|客户体验状况|买家满意度状况)\s*[:：]?\s*(Very Poor|Poor|Fair|Good|Very Good|Excellent|极差|不合格|非常差|较差|一般|良好|优秀|极好)/i.exec(t)?.[1] || null;
  const cxHealth = canonicalVocCx(cxObserved);
  const ncxRatePct = /(?:NCX rate|买家不满意率)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i.exec(t)?.[1];
  const returnRatePct = /(?:return rate|退货率)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i.exec(t)?.[1];
  const returnReasons = [];
  const records = [];
  const re = new RegExp(VOC_REASON_RE.source, 'gi');
  let m;
  while ((m = re.exec(t)) !== null && returnReasons.length < 100) {
    const reason = clean(m[0], 180);
    if (reason && !returnReasons.some((r) => r.toLowerCase() === reason.toLowerCase())) returnReasons.push(reason);
    const context = clean(t.slice(Math.max(0, m.index - 240), m.index + 500), 740);
    const fields = contextFields(context);
    records.push({ reason, date: fields.date, identifier: fields.identifier, summary: context, source: 'pagetext' });
  }
  const customerIssues = [];
  const issueRe = /(?:customer issue|customer problem|buyer comment|customer feedback|买家问题|客户问题|买家反馈)\s*[:：]?\s*([^|]{3,240})/gi;
  while ((m = issueRe.exec(t)) !== null && customerIssues.length < 100) customerIssues.push(clean(m[1], 240));
  return {
    landed: !!asin && asinBound && detailVocabulary,
    asin,
    asins,
    asinBound,
    expectedAsinObserved: asinBound,
    bindingSource: urlOnlyBinding ? 'url' : uniqueTextBinding ? (scoped ? 'scoped-text' : 'unique-page-text') : null,
    cxHealth,
    ncxRatePct: ncxRatePct === undefined ? null : Number(ncxRatePct),
    returnRatePct: returnRatePct === undefined ? null : Number(returnRatePct),
    returnReasons: returnReasons.filter(Boolean),
    customerIssues: customerIssues.filter(Boolean),
    records,
    abnormalTrend: /(?:return|ncx).{0,50}(?:increas|spike|higher than|worsen)|(?:退货|不满意).{0,40}(?:上升|激增|异常|恶化)/i.test(t),
    looksLikeLogin: /amazon sign[\s-]*in|email or mobile phone number/i.test(t),
  };
}

export const vocCheck = {
  id: 'voc',
  no: 7,
  title: '客户登记 (VOC)',
  requirement: 'Voice of the Customer 逐 ASIN 登记退货记录',
  paths: ['/voice-of-the-customer', '/voice-of-the-customer/ref=xx_voc_dnav_xx'],
  settleMs: 1200,
  urlStabilizeMs: 2500,
  urlStabilizePollMs: 300,
  pageIdentityRetries: 2,
  // A cold WANG profile has been observed to reach the approved VOC URL
  // before its ASIN table hydrates. Allow one final clean-session recovery
  // after the ordinary renderer retries, while still failing closed on shells.
  readyTimeoutMs: 90000,
  readyPollMs: 2500,
  retryFreshSessionWhenNotReady: true,
  maxAttempts: 4,
  ready({ dom, txt }) {
    if (dom?.listCoverageRequired === true) return verifyVocListPage(dom, txt);
    if (dom?.zeroResults === true && txt?.zeroResults === true) return true;
    const domAsins = [...new Set((dom?.rows || [])
      .map((row) => String(row?.asin || '').toUpperCase())
      .filter((asin) => /^B0[A-Z0-9]{8}$/.test(asin)))];
    const textAsins = [...new Set((txt?.asins || [])
      .map((asin) => String(asin || '').toUpperCase())
      .filter((asin) => /^B0[A-Z0-9]{8}$/.test(asin)))];
    // The page text can expose ASIN strings before the asynchronous table rows
    // and detail controls exist. Do not accept that SPA shell as ready: VOC
    // detail collection is driven only by structured rows, and normal requires
    // the independently parsed text set to corroborate the same inventory.
    return domAsins.length > 0
      && domAsins.length === textAsins.length
      && domAsins.every((asin) => textAsins.includes(asin));
  },
  extractor: VOC_EXTRACTOR,
  detailExtractor: (row) => vocDetailExtractor(row?.asin),
  // Keep a healthy ZiNiao session for the normal 20–25 item VOC inventory.
  // Production evidence showed that proactively reopening this profile every
  // eight rows caused the extension error page; real renderer/internal-page
  // failures still trigger an immediate bounded same-store restart.
  detailSessionMaxItems: 50,
  detailMaxRetries: 4,
  detailOpenTimeoutMs: 20000,
  detailVisitTimeoutMs: 20000,
  detailExecTimeoutMs: 30000,
  detailRestartReadyTimeoutMs: 20000,
  detailRestartReadyPollMs: 750,
  detailReady({ dom, txt, row }) {
    const domMatches = !!row?.asin && dom?.asinBound === true && dom?.detailRootMatched === true && dom?.asin === row.asin;
    const txtMatches = !!row?.asin && txt?.asinBound === true && txt?.asin === row.asin;
    return dom?.landed === true && txt?.landed === true
      && domMatches && txtMatches;
  },
  detailParseText(text, row, _store, context = {}) {
    return parseVocDetailText(text, row?.asin || null, context);
  },
  parseText(text) {
    const raw = String(text || '');
    const t = raw.replace(/\s+/g, ' ');
    const asins = [...new Set((t.match(/\bB0[A-Z0-9]{8}\b/gi) || []).map((asin) => asin.toUpperCase()))];
    const cxRows = parseVocCxRows(raw);
    const cxByAsin = Object.fromEntries(cxRows.filter((row) => row.cxHealth).map((row) => [row.asin, row.cxHealth]));
    const poorAsins = cxRows.filter((row) => /poor/i.test(row.cxHealth || '')).map((row) => row.asin);
    const listingTotals = [...raw.matchAll(/(?:^|\n)\s*([0-9][0-9,]*)\s+Offer Listings\s*(?=\n|$)/gi)]
      .map(match => Number(match[1].replace(/,/g, '')));
    return {
      landed: /voice of the customer|customer experience|cx health|ncx|买家之声|买家满意度状况|买家不满意率/i.test(t),
      asinCount: asins.length,
      listingTotal: listingTotals.length === 1 ? listingTotals[0] : null,
      asins,
      cxRows,
      cxByAsin,
      poorAsins,
      poorCount: poorAsins.length,
      zeroResults: /\b0\s+(?:offer )?listings|\b0\s*results|暂无商品|\b0\s*条结果/i.test(t),
      looksLikeLogin: /amazon sign[\s-]*in/i.test(t),
    };
  },
  judge({ dom, txt, store, prev }) {
    const rows = dom?.rows || [];
    const detailEvidence = dom?.details || [];
    const asins = [...new Set([
      ...rows.map((r) => r.asin),
      ...(txt?.asins || []),
    ].filter((asin) => /^B0[A-Z0-9]{8}$/.test(String(asin || ''))))];
    const rowByAsin = new Map(rows.map((r) => [r.asin, r]));
    const detailByAsin = new Map(detailEvidence.map((d) => [d.asin, d]));
    const items = [];
    let detailFailures = 0;
    let registered = 0;
    let poor = 0;
    const poorAsinSet = new Set();
    let abnormalTrends = 0;

    for (const asin of asins) {
      const row = rowByAsin.get(asin) || { asin, source: 'text-only' };
      const detail = detailByAsin.get(asin) || null;
      const domAsinMatches = detail?.dom?.asinBound === true && detail?.dom?.detailRootMatched === true && detail?.dom?.asin === asin;
      const txtAsinMatches = detail?.txt?.asinBound === true && detail?.txt?.asin === asin;
      const detailComplete = detail?.dom?.landed === true && detail?.txt?.landed === true
        && domAsinMatches && txtAsinMatches;
      if (detailComplete) registered++;
      else detailFailures++;

      const cxHealth = worstVocCx([
        detail?.dom?.cxHealth, detail?.txt?.cxHealth, row.cxHealth, txt?.cxByAsin?.[asin],
      ]);
      const isPoor = /poor/i.test(cxHealth || '');
      if (isPoor) { poor++; poorAsinSet.add(asin); }
      const abnormalTrend = detail?.dom?.abnormalTrend === true || detail?.txt?.abnormalTrend === true;
      if (abnormalTrend) abnormalTrends++;
      const returnReasons = [...new Set([
        ...(detail?.dom?.returnReasons || []), ...(detail?.txt?.returnReasons || []),
        ...(row.topNcxReason ? [row.topNcxReason] : []),
      ].map((v) => clean(v, 240)).filter(Boolean))];
      const customerIssues = [...new Set([
        ...(detail?.dom?.customerIssues || []), ...(detail?.txt?.customerIssues || []),
      ].map((v) => clean(v, 500)).filter(Boolean))];
      const recordCandidates = [];
      if (detailComplete) {
        for (const raw of [...(detail?.dom?.records || []), ...(detail?.txt?.records || [])]) {
          const rec = {
            asin,
            date: clean(raw?.date, 80),
            identifier: clean(raw?.identifier || raw?.recordId || raw?.returnId, 120),
            returnReason: clean(raw?.reason || raw?.returnReason, 240),
            customerIssue: clean(raw?.customerIssue || raw?.summary, 500),
            source: clean(raw?.source, 80),
          };
          const same = recordCandidates.find((prior) => (
            rec.identifier && prior.identifier && rec.identifier === prior.identifier
          ) || (
            rec.returnReason && prior.returnReason
            && rec.returnReason.toLowerCase() === prior.returnReason.toLowerCase()
            && (rec.date || '') === (prior.date || '')
            && (!rec.identifier || !prior.identifier)
          ));
          if (same) {
            same.identifier ||= rec.identifier;
            same.customerIssue ||= rec.customerIssue;
            same.date ||= rec.date;
            same.source = [same.source, rec.source].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('+');
          } else recordCandidates.push(rec);
        }
        if (!recordCandidates.length && returnReasons.length) {
          for (const returnReason of returnReasons) {
            const rec = { asin, date: clean(row.updatedAt, 80), identifier: null, returnReason, customerIssue: null, source: 'voc-row' };
            recordCandidates.push(rec);
          }
        }
      }
      for (const rec of recordCandidates) rec.itemKey = stableItemKey('voc-record', store, rec);
      const item = {
        asin,
        storeKey: store?.key || null,
        cxHealth,
        ncxRatePct: n(detail?.dom?.ncxRatePct) ?? n(detail?.txt?.ncxRatePct) ?? n(row.ncxRatePct),
        ncxOrders: n(row.ncxOrders),
        totalOrders: n(row.totalOrders),
        returnRatePct: n(detail?.dom?.returnRatePct) ?? n(detail?.txt?.returnRatePct) ?? n(row.returnRatePct),
        returnReasons,
        customerIssues,
        records: recordCandidates,
        updatedAt: clean(row.updatedAt, 80),
        abnormalTrend,
        detailComplete,
        detailStatus: detailComplete ? 'COMPLETE' : detail?.error ? 'ERROR' : detail ? 'PARTIAL_EVIDENCE' : 'MISSING_DETAIL_LINK',
        detailError: clean(detail?.error, 240),
        detailScreenshot: detail?.screenshot || null,
        detailDiagnostics: detail?.diagnostics || null,
      };
      item.itemKey = stableItemKey('voc-asin', store, { asin });
      items.push(item);
    }

    for (const asin of [...(dom?.poorAsins || []), ...(txt?.poorAsins || [])]) {
      if (/^B0[A-Z0-9]{8}$/.test(String(asin || ''))) poorAsinSet.add(String(asin));
    }
    poor = Math.max(poor, poorAsinSet.size, n(dom?.poorCount) ?? 0, n(txt?.poorCount) ?? 0);
    const confirmedEmpty = asins.length === 0 && dom?.zeroResults === true && txt?.zeroResults === true;
    const headerMappingIncomplete = rows.length > 0
      && Number(dom?.headerMappingCompleteRowCount || 0) !== rows.length;
    const listCoverageIncomplete = (dom?.listCoverageRequired === true || txt?.listingTotal != null)
      && !(dom?.listCoverage?.complete === true && txt?.listCoverage?.complete === true
        && dom.listCoverage.total === txt.listCoverage.total
        && dom.listCoverage.total === rows.length
        && dom.listCoverage.pagesRead === txt.listCoverage.pagesRead);
    const businessEventItems = [];
    for (const asin of poorAsinSet) {
      const item = items.find((candidate) => candidate.asin === asin);
      businessEventItems.push({
        asin,
        itemKey: stableItemKey('voc-cx', store, { asin, reason: item?.cxHealth || 'Poor' }),
      });
    }
    for (const item of items.filter((candidate) => candidate.abnormalTrend)) {
      businessEventItems.push({
        asin: item.asin,
        itemKey: stableItemKey('voc-trend', store, { asin: item.asin }),
      });
    }
    const legacyPoorKeys = prev?.status === 'POOR_CX'
      && prev?.metrics?.collectionStatus === 'COMPLETE'
      && Array.isArray(prev?.metrics?.poorAsins)
      ? prev.metrics.poorAsins
        .filter((asin) => /^B0[A-Z0-9]{8}$/.test(String(asin || '')))
        .map((asin) => stableItemKey('voc-cx', store, { asin: String(asin), reason: 'Poor' }))
      : [];
    const events = businessEventDelta(businessEventItems, prev, poor + abnormalTrends, legacyPoorKeys);
    const newBusinessBad = (poor > 0 || abnormalTrends > 0) && events.newCount > 0;
    const reasons = [];
    if (newBusinessBad) {
      if (poor > 0) reasons.push(`${poor} 个 ASIN 的 CX Health 为 Poor/Very Poor，其中 ${events.newCount} 个业务事件为首次发现`);
      if (abnormalTrends > 0) reasons.push(`${abnormalTrends} 个 ASIN 出现异常退货/NCX 趋势`);
    } else if (poor > 0 || abnormalTrends > 0) {
      reasons.push(`${poor + abnormalTrends} 个 VOC 业务事件已在首次发现时提醒并归档，本次无新增或恶化`);
    }
    if (detailFailures > 0) reasons.push(`${detailFailures}/${asins.length} 个真实 ASIN 的只读详情未获得 DOM+文本双路完整证据`);
    if (headerMappingIncomplete) reasons.push('VOC 列表表头无法完整映射，未可靠定位的指标已置空，禁止按固定列偏移猜测');
    if (listCoverageIncomplete) reasons.push(`VOC 列表分页覆盖未核验完整：${dom?.listCoverage?.error || '尚未完成全部页码与总数的双路核对'}`);
    if (!asins.length && !confirmedEmpty) reasons.push('页面已打开但未解析到 ASIN，且双路未确认零结果，不能宣称登记完成');

    const businessBad = poor > 0 || abnormalTrends > 0;
    const allDetailsFailed = asins.length > 0 && detailFailures === asins.length;
    const collectionBad = detailFailures > 0 || headerMappingIncomplete || listCoverageIncomplete || (!asins.length && !confirmedEmpty);
    const recordedBusiness = businessBad && !newBusinessBad && !collectionBad;
    const status = collectionBad
      ? allDetailsFailed || !asins.length ? 'DETAIL_ERROR' : 'PARTIAL_EVIDENCE'
      : newBusinessBad ? 'POOR_CX'
        : recordedBusiness ? 'RECORDED_BUSINESS_EVENT'
          : confirmedEmpty ? 'EMPTY' : 'REGISTERED';
    const severity = collectionBad ? 'ERROR' : newBusinessBad ? 'CRITICAL' : 'OK';
    return {
      status,
      ok: !collectionBad && (!businessBad || recordedBusiness),
      severity,
      confidence: !collectionBad && dom && txt ? 'high' : 'low',
      reasons,
      metrics: {
        asinCount: asins.length, poorCount: poor, poorAsins: [...poorAsinSet], abnormalTrendCount: abnormalTrends,
        registered, detailFailures, confirmedEmpty, headerMappingIncomplete,
        listCoverageIncomplete, listCoverage: dom?.listCoverage || null,
        headerMappedRowCount: n(dom?.headerMappedRowCount) ?? 0,
        headerMappingCompleteRowCount: n(dom?.headerMappingCompleteRowCount) ?? 0,
        newBusinessEventCount: events.newCount,
        recordedBusinessEventCount: events.recordedCount,
        observedBusinessItemKeys: events.currentKeys,
        businessStatus: newBusinessBad ? 'ANOMALY' : recordedBusiness ? 'RECORDED' : 'CLEAR',
        collectionStatus: collectionBad ? (allDetailsFailed || !asins.length ? 'ERROR' : 'PARTIAL_EVIDENCE') : 'COMPLETE',
      },
      items,
      notes: dom?.notes || [],
      baselineEligible: !collectionBad,
    };
  },
};

// -------------------------------------------------------------- 8. 广告开关
function adsDomFilterView(view, kind) {
  const enabled = n(view?.enabled) ?? 0;
  const paused = n(view?.paused) ?? 0;
  const reportedTotal = n(view?.reportedTotal);
  const filterKind = String(view?.filterKind || (
    view?.enabledFilter ? 'ENABLED' : view?.pausedFilter ? 'PAUSED' : ''
  )).toUpperCase();
  const source = String(view?.stateSource || '');
  const rowReliable = /^(?:aria-checked|aria-label|cell-text|filter-total)$/.test(source);
  const count = kind === 'ENABLED' ? enabled : paused;
  const emptyFlag = kind === 'ENABLED' ? view?.emptyEnabledFilter : view?.emptyPausedFilter;
  return {
    filterKind, enabled, paused, reportedTotal, source,
    positive: filterKind === kind && rowReliable && count > 0,
    empty: filterKind === kind && emptyFlag === true && reportedTotal === 0
      && view?.paginationComplete === true,
  };
}

function adsTextFilterView(view, kind) {
  const enabled = n(view?.enabledWords) ?? 0;
  const paused = n(view?.pausedWords) ?? 0;
  const total = n(view?.totalHint);
  const filterKind = String(view?.filterKind || (
    view?.enabledFilter ? 'ENABLED' : view?.pausedFilter ? 'PAUSED' : ''
  )).toUpperCase();
  const count = kind === 'ENABLED' ? enabled : paused;
  return {
    filterKind, enabled, paused, total,
    positive: filterKind === kind && view?.structured === true && count > 0 && total !== null && total > 0,
    empty: filterKind === kind && view?.structured === true && view?.emptyTable === true
      && total === 0 && view?.pageComplete === true,
  };
}

function judgeAdsOnSweep(dom, txt, keyword) {
  const enabledDomRaw = dom?.stateViews?.enabled || null;
  const enabledTxtRaw = txt?.stateViews?.enabled || null;
  const pausedDomRaw = dom?.stateViews?.paused || null;
  const pausedTxtRaw = txt?.stateViews?.paused || null;
  const enabledDom = adsDomFilterView(enabledDomRaw, 'ENABLED');
  const enabledTxt = adsTextFilterView(enabledTxtRaw, 'ENABLED');
  const pausedDom = adsDomFilterView(pausedDomRaw, 'PAUSED');
  const pausedTxt = adsTextFilterView(pausedTxtRaw, 'PAUSED');
  const noEnabledCampaigns = enabledDom.empty || enabledTxt.empty;
  const pausedFound = pausedDom.positive || pausedTxt.positive;
  const complete = enabledDom.positive && enabledTxt.positive && pausedDom.empty && pausedTxt.empty;
  const enabled = Math.max(
    enabledDom.enabled, enabledTxt.enabled,
    enabledDom.reportedTotal ?? 0, enabledTxt.total ?? 0,
  );
  const paused = Math.max(
    pausedDom.paused, pausedTxt.paused,
    pausedDom.reportedTotal ?? 0, pausedTxt.total ?? 0,
  );
  const reasons = [];
  if (noEnabledCampaigns) reasons.push('应全部开启，但至少一条可靠的“已启用”筛选证据显示活动为 0');
  if (pausedFound) reasons.push(`应全部开启，但只读“已暂停”筛选仍发现 ${paused || 1} 个活动；截图保留该异常视图，系统未修改广告状态`);
  if (!noEnabledCampaigns && !pausedFound && !complete) {
    const sweepError = dom?.stateSweepError || txt?.stateSweepError;
    reasons.push(sweepError
      ? `广告状态双筛选未完成：${clean(sweepError, 180)}`
      : '“已启用”存在性与“已暂停”为 0 尚未同时获得 DOM+页面文本双路证据');
  }
  const bad = noEnabledCampaigns || pausedFound;
  return {
    status: bad ? 'SHOULD_BE_ON' : complete ? 'ALL_ON' : 'PARTIAL_EVIDENCE',
    ok: !bad && complete,
    severity: bad ? 'CRITICAL' : complete ? 'OK' : 'ERROR',
    confidence: complete ? 'high' : bad ? 'medium' : 'low',
    reasons,
    metrics: {
      enabled, paused, total: enabled + paused, expected: 'ads-on',
      nameContains: keyword,
      nameFilterVerified: true,
      stateSource: 'enabled+paused-filter-sweep',
      enabledDomPositive: enabledDom.positive, enabledTextPositive: enabledTxt.positive,
      enabledDomEmpty: enabledDom.empty, enabledTextEmpty: enabledTxt.empty,
      pausedDomPositive: pausedDom.positive, pausedTextPositive: pausedTxt.positive,
      pausedDomEmpty: pausedDom.empty, pausedTextEmpty: pausedTxt.empty,
      paginationComplete: complete,
      collectionStatus: complete ? 'COMPLETE' : 'PARTIAL_EVIDENCE',
      businessStatus: bad ? 'ANOMALY' : 'CLEAR',
    },
    items: (pausedDomRaw?.campaigns || []).filter((item) => item.state === 'PAUSED').slice(0, 40),
    notes: [...(enabledDomRaw?.notes || []), ...(pausedDomRaw?.notes || [])],
    baselineEligible: complete,
  };
}

export const adsCheck = {
  id: 'ads-status',
  no: 8,
  title: '广告开关检查',
  requirement: '按店铺广告名称特征筛选；11:20 应全部关闭，18:30 应全部开启',
  paths: [
    'https://advertising.amazon.com/cm/campaigns',
    '/home',
  ],
  bootstrapPath: '/home',
  linkExtractor: ADS_LINK_EXTRACTOR,
  navigationLink: { labels: ['广告活动管理', 'Campaign Manager', 'Advertising campaigns'] },
  preferFollowedLink: true,
  advertisingAccountSwitch: true,
  advertisingNameFilter: true,
  advertisingStateSweep: true,
  screenshotRequiresReady: true,
  retryFreshSessionWhenNotReady: true,
  settleMs: 4000,
  // Amazon Ads commonly paints coachmarks and a table skeleton before the
  // campaign filter/table becomes usable. The screenshot gate below keeps
  // that intermediate UI out of evidence; allow the real table to finish.
  readyTimeoutMs: 90000,
  readyPollMs: 2500,
  ready({ dom, txt, config }) {
    const nameFilters = [dom?.nameFilter, txt?.nameFilter].filter(Boolean);
    if (!nameFilters.length || nameFilters.some((filter) => filter.verified !== true)
      || new Set(nameFilters.map((filter) => filter.keyword)).size !== 1) return false;
    const slot = config?._currentSlot || 'adhoc';
    if (slot === 'ads-off') {
      const domKind = String(dom?.filterKind || (dom?.enabledFilter ? 'ENABLED' : '')).toUpperCase();
      const txtKind = String(txt?.filterKind || (txt?.enabledFilter ? 'ENABLED' : '')).toUpperCase();
      if (domKind === 'ENABLED' && txtKind === 'ENABLED') {
        const d = adsDomFilterView(dom, 'ENABLED');
        const t = adsTextFilterView(txt, 'ENABLED');
        return d.positive || t.positive || (d.empty && t.empty);
      }
    }
    if (slot === 'ads-on') {
      const domKind = String(dom?.filterKind || (dom?.enabledFilter ? 'ENABLED' : dom?.pausedFilter ? 'PAUSED' : '')).toUpperCase();
      const txtKind = String(txt?.filterKind || (txt?.enabledFilter ? 'ENABLED' : txt?.pausedFilter ? 'PAUSED' : '')).toUpperCase();
      if (domKind && domKind === txtKind && ['ENABLED', 'PAUSED'].includes(domKind)) {
        const d = adsDomFilterView(dom, domKind);
        const t = adsTextFilterView(txt, txtKind);
        return (d.positive && t.positive) || (d.empty && t.empty);
      }
    }
    const domEnabled = n(dom?.enabled) ?? 0;
    const domPaused = n(dom?.paused) ?? 0;
    const domTotal = n(dom?.activeTotal) ?? (domEnabled + domPaused);
    const domState = String(dom?.stateSource || '');
    const domReliable = (/^(aria-checked|aria-label|cell-text)$/.test(domState) && domTotal > 0)
      || /^(empty-enabled-filter|empty-paused-filter|empty-campaign-table)$/.test(domState)
      || (dom?.landed === true && n(dom?.reportedTotal) === 0 && domTotal === 0
        && dom?.paginationComplete === true);
    const domComplete = domReliable && dom?.paginationComplete === true
      && domEnabled + domPaused === domTotal;
    const textEnabled = n(txt?.enabledWords) ?? 0;
    const textPaused = n(txt?.pausedWords) ?? 0;
    const textTotal = n(txt?.totalHint);
    const textComplete = txt?.structured === true && txt?.pageComplete === true
      && textTotal !== null && textEnabled + textPaused === textTotal;
    return domComplete && textComplete
      && domTotal === textTotal && domEnabled === textEnabled && domPaused === textPaused;
  },
  extractor: ADS_EXTRACTOR,
  parseText(text, _store, context = {}) {
    const t = String(text).replace(/\s+/g, ' ');
    let advertisingHost = false;
    try { advertisingHost = new URL(context.url || '').hostname === 'advertising.amazon.com'; } catch { /* false */ }
    // Start at the actual table header. Some Chinese console builds prepend the
    // selected "进行中" filter immediately before it; including that token in
    // tableText inflated the enabled count by one (for example 9 states / 8
    // reported campaigns).
    const tableStart = t.search(/Active\s+Campaign name\s+Country\s+Status|广告活动名称\s+国家\s*\/\s*地区\s+状态/i);
    const tail = tableStart >= 0 ? t.slice(tableStart) : '';
    const totalMatch = /\bTotal:\s*(\d+)\b/i.exec(tail) || /总计\s*[:：]\s*(\d+)/.exec(tail) || /共\s*(\d+)\s*条结果/.exec(tail);
    let totalValue = totalMatch ? Number(totalMatch[1]) : null;
    const tableEnd = totalMatch ? tail.indexOf(totalMatch[0]) + totalMatch[0].length : tail.length;
    const tableText = tail ? tail.slice(0, tableEnd) : '';
    const enabledFilter = /进行中\s*[:：]\s*已启用|status\s*[:：]\s*enabled/i.test(t);
    const pausedFilter = /进行中\s*[:：]\s*已暂停|status\s*[:：]\s*paused/i.test(t);
    const emptyMarker = /无可用数据|no data available/i.test(tail);
    const emptyWithoutFooter = advertisingHost && tableStart >= 0 && emptyMarker
      && (enabledFilter || pausedFilter) && totalValue === null;
    if (emptyWithoutFooter) totalValue = 0;
    const structured = advertisingHost && tableStart >= 0 && (!!totalMatch || emptyWithoutFooter);
    // The live console may render the zero-count footer before the empty-state
    // illustration, so search the whole table tail rather than truncating at
    // "Total: 0".
    const emptyTable = structured && totalValue === 0 && emptyMarker;
    const enabledWords = emptyTable ? 0 : (structured
      ? (tableText.match(/\b(?:delivering|enabled)\b|进行中/gi) || []).length
      : (t.match(/\benabled\b|进行中/gi) || []).length);
    const pausedWords = structured
      ? (tableText.match(/\bpaused\b|已暂停|暂停投放/gi) || []).length
      : (t.match(/\bpaused\b|已暂停|暂停投放/gi) || []).length;
    const observedStates = enabledWords + pausedWords;
    const hasNextPage = /\bnext\b|下一页/i.test(tail)
      && !/(?:next|下一页)[^]{0,80}(?:disabled|不可用)/i.test(tail);
    return {
      landed: advertisingHost && /campaign|sponsored products|advertising|impressions|广告活动|活动管理|广告组|展示量/i.test(t),
      enabledWords,
      pausedWords,
      totalHint: totalValue,
      structured,
      emptyTable,
      enabledFilter,
      pausedFilter,
      filterKind: enabledFilter ? 'ENABLED' : pausedFilter ? 'PAUSED' : null,
      observedStates,
      hasNextPage,
      pageComplete: structured && (emptyTable || (totalValue === observedStates && !hasNextPage)),
      looksLikeLogin: /amazon sign[\s-]*in/i.test(t),
      nameFilter: context.adsNameFilter ? { ...context.adsNameFilter } : null,
    };
  },
  /**
   * The expected state comes from the run slot: `ads-off` (11:20) wants every
   * campaign paused, `ads-on` (18:30) wants every campaign enabled. Any other
   * slot is an informational read with no pass/fail.
   */
  judge({ dom, txt, config, store }) {
    const slot = config?._currentSlot || 'adhoc';
    const keyword = String(store?.adsNameContains || '').trim();
    const nameFilters = [dom?.nameFilter, txt?.nameFilter].filter(Boolean);
    const nameFilterVerified = Boolean(keyword && nameFilters.length
      && nameFilters.every((filter) => filter.verified === true && filter.keyword === keyword));
    if (!nameFilterVerified) {
      return {
        status: 'PARTIAL_EVIDENCE', ok: false, severity: 'ERROR', confidence: 'low',
        reasons: [keyword
          ? `广告名称“包含 ${keyword}”筛选未获得精确复核，拒绝把全账户广告当作目标范围`
          : '店铺未配置广告名称特征，拒绝检查全账户广告'],
        metrics: { nameContains: keyword || null, nameFilterVerified: false, expected: slot },
        items: [], notes: dom?.notes || [], baselineEligible: false,
      };
    }
    if (slot === 'ads-on' && (dom?.stateViews || txt?.stateViews)) {
      return judgeAdsOnSweep(dom, txt, keyword);
    }
    const domEnabled = n(dom?.enabled) ?? 0;
    const domPaused = n(dom?.paused) ?? 0;
    const domTotal = n(dom?.activeTotal) ?? (domEnabled + domPaused);
    const textEnabled = n(txt?.enabledWords) ?? 0;
    const textPaused = n(txt?.pausedWords) ?? 0;
    const textTotal = n(txt?.totalHint) ?? (textEnabled + textPaused);
    const textStructured = txt?.structured === true && textTotal >= 0;
    const textComplete = textStructured && txt?.pageComplete === true;
    const domReportedTotal = n(dom?.reportedTotal);
    const domEmptyComplete = dom?.landed === true && domReportedTotal === 0
      && domTotal === 0 && dom?.paginationComplete === true;
    const domStateSource = String(dom?.stateSource || '');
    const domSourceReliable = (
      /^(aria-checked|aria-label|cell-text|filter-total)$/.test(domStateSource) && domTotal > 0
    ) || /^(empty-enabled-filter|empty-paused-filter|empty-campaign-table)$/.test(domStateSource)
      || domEmptyComplete;
    const domCountConflict = domSourceReliable && (
      domEnabled + domPaused > domTotal
      || (dom?.paginationComplete === true && domEnabled + domPaused !== domTotal)
    );
    const textCountConflict = textStructured && (
      textEnabled + textPaused > textTotal
      || (txt?.pageComplete === true && textEnabled + textPaused !== textTotal)
    );
    // A source cannot be complete when its state counts exceed its own total.
    // This also protects callers that provide a stale/incorrect pageComplete
    // flag instead of relying on parseText's calculation.
    const domComplete = domSourceReliable && !domCountConflict && dom?.paginationComplete === true;
    const safeTextComplete = textComplete && !textCountConflict;
    const sourceTotalConflict = domSourceReliable && textStructured && domTotal !== textTotal;
    const sourceStateConflict = domSourceReliable && textStructured
      && (domEnabled !== textEnabled || domPaused !== textPaused);
    const countConflict = domCountConflict || textCountConflict || sourceTotalConflict || sourceStateConflict;

    // Do not build a synthetic row by taking the maximum of each state from
    // different sources. Pick one coherent source snapshot for display while
    // retaining all raw source counts below. Anomaly detection still checks
    // every reliable source independently.
    const sources = [];
    if (domSourceReliable) sources.push({
      key: 'dom', enabled: domEnabled, paused: domPaused, total: domTotal,
      complete: domComplete, coherent: !domCountConflict,
      emptyEnabledFilter: dom?.emptyEnabledFilter === true && domTotal === 0,
    });
    if (textStructured) sources.push({
      key: 'text', enabled: textEnabled, paused: textPaused, total: textTotal,
      complete: safeTextComplete, coherent: !textCountConflict,
      emptyEnabledFilter: txt?.enabledFilter === true && textTotal === 0,
    });
    const priority = (source) => {
      const anomalyCount = slot === 'ads-off' ? source.enabled : slot === 'ads-on' ? source.paused : 0;
      const anomaly = anomalyCount > 0 || (slot === 'ads-on' && source.enabled === 0);
      return [anomaly ? 1 : 0, source.complete ? 1 : 0, source.coherent ? 1 : 0,
        anomalyCount, source.total, source.key === 'dom' ? 1 : 0];
    };
    const higherPriority = (left, right) => {
      const a = priority(left);
      const b = priority(right);
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
      }
      return false;
    };
    let aggregate = sources[0] || {
      key: 'none', enabled: 0, paused: 0, total: 0, complete: false, coherent: true,
      emptyEnabledFilter: false,
    };
    for (const source of sources.slice(1)) if (higherPriority(source, aggregate)) aggregate = source;
    const enabled = aggregate.enabled;
    const paused = aggregate.paused;
    // In a source-internal conflict the exact total is unknown. Use the
    // observed-state lower bound for a valid display ratio, and expose the
    // untouched source total plus this adjustment in metrics.
    const total = Math.max(aggregate.total, enabled + paused);
    const aggregateTotalAdjusted = total !== aggregate.total;
    const bothComplete = domComplete && safeTextComplete && !sourceTotalConflict && !sourceStateConflict;
    const reasons = [];
    const metrics = {
      enabled, paused, total, expected: slot,
      nameContains: keyword, nameFilterVerified,
      stateSource: [domSourceReliable ? dom?.stateSource : null, textStructured ? 'text-campaign-table' : null].filter(Boolean).join('+') || 'low-precision',
      domEnabled, domPaused, domTotal, textEnabled, textPaused, textTotal,
      domReliable: domSourceReliable, textReliable: textStructured,
      domComplete, textComplete: safeTextComplete, paginationComplete: bothComplete,
      aggregateSource: aggregate.key,
      aggregateTotalAdjusted,
      countConflict, domCountConflict, textCountConflict, sourceTotalConflict, sourceStateConflict,
      zeroEnabledSources: sources.filter((source) => source.enabled === 0).map((source) => source.key),
    };

    if (!domSourceReliable && !textStructured) {
      return {
        status: 'PARTIAL_EVIDENCE', ok: false, severity: 'ERROR',
        reasons: ['只解析到筛选器/推荐卡中的低精度状态词，未确认广告活动表，不能据此下正常结论'],
        metrics, items: [], notes: dom?.notes || [], baselineEligible: false,
      };
    }

    if (slot === 'ads-off') {
      const bad = sources.some((source) => source.enabled > 0);
      if (bad) reasons.push(`应全部关闭，但仍有 ${enabled}/${total} 个广告活动处于开启状态`);
      if (countConflict) reasons.push(bad
        ? '广告活动计数证据不一致；开启异常已按可靠路径保留，精确数量需复核'
        : '广告活动计数证据不一致，精确数量需复核，不能确认已全部关闭');
      else if (!bothComplete) reasons.push('广告活动存在未遍历分页或双路总数不一致，不能确认已全部关闭');
      return {
        status: bad ? 'SHOULD_BE_OFF' : bothComplete ? 'ALL_OFF' : 'PARTIAL_EVIDENCE',
        ok: !bad && bothComplete,
        severity: bad ? 'CRITICAL' : bothComplete ? 'OK' : 'ERROR',
        confidence: bothComplete ? 'high' : 'low',
        reasons, metrics,
        items: (dom?.campaigns || []).filter((c) => c.state === 'ENABLED').slice(0, 40),
        notes: dom?.notes || [],
        baselineEligible: bothComplete,
      };
    }
    if (slot === 'ads-on') {
      const noEnabledCampaigns = sources.some((source) => source.enabled === 0);
      const bad = sources.some((source) => source.paused > 0) || noEnabledCampaigns;
      if (noEnabledCampaigns) reasons.push('应全部开启，但至少一条可靠活动表证据显示已启用活动为 0');
      else if (bad) reasons.push(`应全部开启，但仍有 ${paused}/${total} 个广告活动处于关闭状态`);
      if (countConflict) reasons.push(bad
        ? '广告活动计数证据不一致；关闭异常已按可靠路径保留，精确数量需复核'
        : '广告活动计数证据不一致，精确数量需复核，不能确认已全部开启');
      else if (txt?.enabledFilter || dom?.enabledFilter) reasons.push('当前仅为“已启用”筛选，未独立排除暂停活动，不能确认已全部开启');
      else if (!bothComplete) reasons.push('广告活动存在未遍历分页或双路总数不一致，不能确认已全部开启');
      const completeForOn = bothComplete && !txt?.enabledFilter && !dom?.enabledFilter;
      return {
        status: bad ? 'SHOULD_BE_ON' : completeForOn ? 'ALL_ON' : 'PARTIAL_EVIDENCE',
        ok: !bad && completeForOn,
        severity: bad ? 'CRITICAL' : completeForOn ? 'OK' : 'ERROR',
        confidence: completeForOn ? 'high' : 'low',
        reasons, metrics,
        items: (dom?.campaigns || []).filter((c) => c.state === 'PAUSED').slice(0, 40),
        notes: dom?.notes || [],
        baselineEligible: completeForOn,
      };
    }
    reasons.push(`非规定时段（${slot}），仅记录状态：开启 ${enabled} / 关闭 ${paused}`);
    if (countConflict) reasons.push('广告活动计数证据冲突，非规定时段也不能记录为正常');
    else if (!bothComplete) reasons.push('广告活动分页或双路证据不完整，非规定时段也不能记录为正常');
    return {
      status: bothComplete ? 'INFO' : 'PARTIAL_EVIDENCE', ok: bothComplete,
      severity: bothComplete ? 'OK' : 'ERROR', confidence: bothComplete ? 'high' : 'low',
      reasons, metrics, items: [], notes: dom?.notes || [], baselineEligible: bothComplete,
    };
  },
};

// -------------------------------------------------------- 5. ASIN 常规检查
/**
 * Item 5 is the odd one out: it visits public product detail pages rather than a
 * Seller Central page, one URL per ASIN, and compares each ASIN's rating with
 * yesterday's. It therefore has its own runner in checks/asin-health.js and only
 * the extractor plus judgement live here.
 */
export const asinDetailDef = {
  id: 'asin-health',
  no: 5,
  title: 'ASIN 常规检查',
  requirement: '先确认 ASIN 仍激活/可售；仅对在售商品检查购物车与评分变化',
  extractor: ASIN_DETAIL_EXTRACTOR,
  parseText(text) {
    const t = String(text).replace(/\s+/g, ' ');
    const rm = /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5\s*(?:stars?|星)?/i.exec(t);
    const notFound = /we couldn.t find that page|page not found|looking for something\?|找不到该页面|页面不存在/i.test(t);
    const hasCartText = /add to cart|add to basket|buy now|加入购物车|立即购买/i.test(t);
    // Product pages include recommendations and carousels in body text. An
    // unscoped "Currently unavailable" is only reliable when the page has no
    // purchase control; the DOM extractor separately inspects the main offer's
    // scoped availability node and can still raise an anomaly by itself.
    const pageUnavailable = /currently unavailable|out of stock|we don.t know when or if this item will be back|当前无货|暂时缺货/i.test(t);
    const unavailable = pageUnavailable && !hasCartText;
    const cm = /([\d,]+)\s*(?:global\s*)?ratings?/i.exec(t) || /([\d,]+)\s*(?:个)?评分/.exec(t);
    return {
      landed: !notFound && (hasCartText || unavailable || /product details|about this item|customer reviews|商品信息|关于此商品|买家评论/i.test(t)),
      hasCartText,
      rating: rm ? parseFloat(rm[1]) : null,
      reviewCount: cm ? Number(cm[1].replace(/,/g, '')) : null,
      unavailable,
      pageUnavailable,
      notFound,
      looksLikeLogin: /amazon sign[\s-]*in|email or mobile phone number|enter your password/i.test(t),
      looksBlocked: /robot check|enter the characters you see|automated access|service unavailable/i.test(t),
    };
  },
  judgeAsin({ dom, txt, prev, asin }) {
    const reasons = [];
    const loginRequired = dom?.looksLikeLogin === true || txt?.looksLikeLogin === true;
    const blocked = dom?.looksBlocked === true || txt?.looksBlocked === true;
    const pageNotFound = dom?.dogPage === true || txt?.notFound === true;
    const unavailable = dom?.unavailable === true || txt?.unavailable === true;
    const domInactive = dom?.dogPage === true || dom?.unavailable === true;
    // Flattened page text can contain a recommendation's Add to Cart button,
    // so parseText intentionally will not call the whole page unavailable in
    // that case. When DOM has already scoped the unavailable message to the
    // main offer, the independent page-text occurrence corroborates that same
    // state without letting an unrelated recommendation create a false pass.
    const scopedUnavailableCorroborated = dom?.unavailable === true
      && dom?.availabilityScoped === true && txt?.pageUnavailable === true;
    const textInactive = txt?.notFound === true || txt?.unavailable === true || scopedUnavailableCorroborated;
    const listingInactive = domInactive && textInactive;
    const listingStateConflict = domInactive !== textInactive;
    const opened = !!(dom?.landed || txt?.landed);
    const domCart = typeof dom?.hasCart === 'boolean' ? dom.hasCart : null;
    const txtCart = typeof txt?.hasCartText === 'boolean' ? txt.hasCartText : null;
    const hasCart = domCart !== null && txtCart !== null
      ? domCart && txtCart
      : !!(domCart ?? txtCart);
    const domRating = n(dom?.rating);
    const txtRating = n(txt?.rating);
    const ratingConflict = domRating !== null && txtRating !== null
      && Math.abs(domRating - txtRating) > 0.001;
    const rating = domRating !== null && txtRating !== null
      ? Math.min(domRating, txtRating)
      : domRating ?? txtRating;
    const prevRating = n(prev?.rating);
    const delta = rating !== null && prevRating !== null ? Math.round((rating - prevRating) * 100) / 100 : null;

    if (loginRequired) reasons.push('商品页会话要求登录，属于采集/会话故障，不能当作商品异常');
    else if (blocked) reasons.push('商品页出现 Robot Check/访问拦截，属于采集故障');
    else if (listingInactive) reasons.push('DOM 与页面文本均确认 ASIN 已不存在或不可售，本批排除后续商品健康判断');
    else if (pageNotFound) reasons.push('链接打不开（Page Not Found），但双路状态尚未一致');
    else if (!opened) reasons.push('两条证据均无法确认商品页已正常渲染，属于采集失败');
    if (listingStateConflict) reasons.push('DOM 与页面文本对 ASIN 激活/可售状态判断冲突，不能自动纳入或排除');
    if (opened && !listingInactive && !unavailable && !hasCart) reasons.push('购物车按钮不存在（可能失去购买资格 / 无 Buy Box）');
    if (domCart !== null && txtCart !== null && domCart !== txtCart) {
      reasons.push('DOM 与页面文本对购物车状态判定冲突，按更严重结果处理');
    }
    if (ratingConflict && !listingInactive) {
      reasons.push(`DOM 与页面文本评分冲突（${domRating} vs ${txtRating}），已保留较低值但不能判定正常`);
    }
    if (unavailable && !listingInactive) reasons.push('商品显示 Currently unavailable，但尚未取得双路非激活证据');
    if (!listingInactive && delta !== null && delta < 0) reasons.push(`评分下降 ${prevRating} → ${rating} (${delta})`);
    if (!listingInactive && rating === null) reasons.push('未取到评分，无法与前一日对比');

    const ratingMissing = opened && !listingInactive && !unavailable && hasCart && rating === null;
    const collectionError = loginRequired || blocked || (!opened && !pageNotFound) || ratingMissing || listingStateConflict;
    const critical = !listingInactive && !listingStateConflict
      && (pageNotFound || unavailable || (opened && !hasCart));
    const evidenceError = collectionError || (!listingInactive && ratingConflict);
    const warn = !evidenceError && !critical && ((delta !== null && delta < 0) || rating === null);
    const status = loginRequired ? 'LOGIN_REQUIRED'
      : blocked ? 'BLOCKED'
        : listingInactive ? 'INACTIVE_LISTING'
          : listingStateConflict ? 'PARTIAL_EVIDENCE'
            : pageNotFound ? 'PAGE_NOT_FOUND'
          : !opened ? 'ERROR'
            : unavailable ? 'UNAVAILABLE'
              : !hasCart ? 'NO_CART'
                : delta !== null && delta < 0 ? 'RATING_DROP'
                  : ratingConflict ? 'PARTIAL_EVIDENCE'
                  : rating === null ? 'UNKNOWN_RATING' : 'OK';

    return {
      asin,
      status,
      ok: listingInactive || (!evidenceError && !critical && !warn),
      severity: listingInactive ? 'OK' : critical ? 'CRITICAL' : evidenceError ? 'ERROR' : warn ? 'WARN' : 'OK',
      confidence: listingStateConflict || (!listingInactive && ratingConflict) ? 'conflict' : dom && txt ? 'high' : 'low',
      reasons,
      metrics: {
        opened, hasCart, rating, domRating, textRating: txtRating, ratingConflict,
        prevRating, ratingDelta: delta,
        prevRatingDate: prev?.baselineDate || null,
        reviewCount: n(dom?.reviewCount) ?? n(txt?.reviewCount),
        domReviewCount: n(dom?.reviewCount),
        textReviewCount: n(txt?.reviewCount),
        unavailable,
        pageNotFound,
        listingActive: !listingInactive,
        listingState: listingInactive ? 'INACTIVE_OR_UNSELLABLE' : listingStateConflict ? 'UNKNOWN' : 'ACTIVE_OR_SELLABLE',
        listingStateConflict,
        scopedUnavailableCorroborated,
        checkSkipped: listingInactive,
        businessStatus: critical || (!listingInactive && delta !== null && delta < 0) ? 'ANOMALY' : 'CLEAR',
        collectionStatus: listingStateConflict || (!listingInactive && ratingConflict) || ratingMissing ? 'PARTIAL_EVIDENCE'
          : collectionError ? 'ERROR' : 'COMPLETE',
      },
      title: dom?.titleText || null,
      baselineEligible: !listingInactive && !collectionError && !ratingConflict && rating !== null,
    };
  },
};

export const GENERIC_CHECKS = [performanceCheck, feedbackCheck, inboxCheck, reviewsCheck, outletCheck, vocCheck, adsCheck];
export const GENERIC_BY_ID = Object.fromEntries(GENERIC_CHECKS.map((c) => [c.id, c]));
