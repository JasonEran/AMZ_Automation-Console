/**
 * In-page extractors for checks 2-9.
 *
 * Shared constraints (same as policy-compliance): ASCII only, no backticks, no
 * `${`, ES5 syntax. Each returns an object; `landed` tells the runner whether we
 * actually reached the intended page; the runner treats "not landed" as an
 * anomaly rather than a pass.
 *
 * A common prelude gives every extractor the same helpers.
 */
const PRELUDE = String.raw`
function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
function tagOf(el) { try { return String(el.tagName || "?").toLowerCase(); } catch (e) { return "?"; } }
function bodyText() {
  try { return norm(document.body ? (document.body.innerText || document.body.textContent) : ""); } catch (e) { return ""; }
}
function isVisible(el) {
  try {
    if (el.getClientRects && el.getClientRects().length === 0) return false;
    var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (!cs) return true;
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  } catch (e) { return true; }
}
function leafText(el) {
  try { if (el.children && el.children.length > 0) return ""; return norm(el.textContent); } catch (e) { return ""; }
}
function allEls(root, cap) {
  try { var n = (root || document.body).querySelectorAll("*"); return n.length > (cap || 6000) ? [] : n; } catch (e) { return []; }
}
function textNodesMatching(re, limit) {
  var res = [];
  try {
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = w.nextNode())) {
      var t = norm(n.nodeValue);
      if (t && re.test(t)) { res.push(n); if (res.length >= (limit || 40)) break; }
    }
  } catch (e) {}
  return res;
}
function cardOf(el, stopRe, maxHops) {
  var node = el, hops = 0, fallback = el;
  while (node && hops < (maxHops || 10)) {
    var t = ""; try { t = norm(node.textContent); } catch (e) {}
    if (stopRe && stopRe.test(t)) return node;
    if (t.length > 120) return node;
    fallback = node; node = node.parentElement; hops++;
  }
  return fallback;
}
var LOGIN_RE = /(sign[\s-]*in to continue|amazon sign[\s-]*in|enter your password|email or mobile phone number|two[\s-]step verification)/i;
var BLOCK_RE = /(enter the characters you see|robot check|to discuss automated access|sorry, something went wrong|service unavailable)/i;
function baseOut(name) {
  var bt = bodyText();
  return {
    extractor: name, url: (function(){ try { return String(location.href); } catch(e){ return ""; } })(),
    title: (function(){ try { return norm(document.title); } catch(e){ return ""; } })(),
    pageTextLength: bt.length,
    looksLikeLogin: LOGIN_RE.test(bt), looksBlocked: BLOCK_RE.test(bt),
    landed: false, notes: [], _bt: bt
  };
}
`;

const wrap = (name, body) => `${PRELUDE}\nvar out = baseOut(${JSON.stringify(name)});\nvar BT = out._bt;\n${body}\ndelete out._bt;\nreturn out;`;

// ---------------------------------------------------- 2. performance check
/**
 * Account Health / performance dashboard: any prominent red warning means there
 * is unhandled performance work. Red is detected structurally (computed color)
 * *and* lexically (Amazon's own warning vocabulary), because either alone is
 * fragile: colour alone catches decorative red, text alone misses styled-only
 * warnings.
 */
export const PERFORMANCE_EXTRACTOR = wrap('performance/v4', String.raw`
out.landed = /account health|customer service performance|policy compliance|shipping performance|performance notification|\u8d26\u6237\u72b6\u51b5|\u5ba2\u6237\u670d\u52a1\u7ee9\u6548|\u653f\u7b56\u5408\u89c4\u6027|\u914d\u9001\u7ee9\u6548|\u7ee9\u6548\u901a\u77e5/i.test(BT);
out.redTexts = []; out.redCount = 0;
out.warnPhrases = []; out.sections = [];

var WARN_RE = /(at[\s-]?risk|unhealthy|critical|action required|requires? attention|deactivat|suspend|violation|policy warning|non[\s-]?compliant|appeal|exceeds? target|below target|did not meet|\u6709\u98ce\u9669|\u4e0d\u5065\u5eb7|\u4e25\u91cd|\u9700\u8981\u5904\u7406|\u505c\u7528|\u6682\u505c|\u8fdd\u89c4|\u8b66\u544a|\u4e0d\u5408\u89c4|\u7533\u8bc9)/i;
var ZERO_WARN_RE = /(?:violations?|policy warning|appeals?|issues?|complaints?)\s*(?:[:=\-]\s*)?\(?0(?:\b|\s*\))|(?:\u8fdd\u89c4|\u653f\u7b56\u8b66\u544a|\u7533\u8bc9|\u95ee\u9898|\u6295\u8bc9)\s*(?:[:\uff1a=\-]\s*)?0(?:\b|\s*\u6761)/i;
var RED_RE = /^rgba?\(\s*(2[0-9]{2}|1[89][0-9])\s*,\s*([0-9]|[1-9][0-9])\s*,\s*([0-9]|[1-9][0-9])\s*[,)]/;

var els = allEls(document.body, 6000);
for (var i = 0; i < els.length; i++) {
  var el = els[i];
  var t = leafText(el);
  if (!t || t.length > 160) continue;
  if (!isVisible(el)) continue;
  var isRed = false, color = "";
  try {
    var cs = window.getComputedStyle(el);
    color = String(cs.color || "");
    isRed = RED_RE.test(color.replace(/\s+/g, ""));
  } catch (e) {}
  var warn = WARN_RE.test(t) && !ZERO_WARN_RE.test(t);
  if (isRed && t.length > 1) {
    out.redCount++;
    if (out.redTexts.length < 15) out.redTexts.push({ text: t, color: color, tag: tagOf(el), matchesWarnVocab: warn });
  }
  if (warn && out.warnPhrases.length < 20) out.warnPhrases.push({ text: t, red: isRed, tag: tagOf(el) });
}

// Per-section status pills, so a human sees which of the three areas is bad.
var SECTIONS = ["Customer Service Performance", "Policy Compliance", "Shipping Performance"];
for (var s = 0; s < SECTIONS.length; s++) {
  var nodes = textNodesMatching(new RegExp("^" + SECTIONS[s] + "$", "i"), 3);
  if (!nodes.length) continue;
  var card = cardOf(nodes[0].parentElement, /account health rating|order defect|late shipment/i, 12);
  var ct = ""; try { ct = norm(card.textContent); } catch (e) {}
  var pill = null;
  var m = /\b(Healthy|At Risk|Unhealthy|Critical|Good|Fair|Poor)\b/i.exec(ct);
  if (m) pill = m[1];
  out.sections.push({ name: SECTIONS[s], pill: pill, excerpt: ct.slice(0, 200) });
}
out.hasRedWarning = out.redTexts.filter(function (r) { return r.matchesWarnVocab; }).length > 0;
// A page heading alone is not proof that the async performance data loaded.
// Normal requires an explicit zero-warning signal, or a Healthy/Good status
// paired with a real metric. These signals are retained separately so Node can
// demand the same proof from the independent page-text parser.
var PERF_ZERO_RES = [
  /(?:violations?|policy warning|appeals?|issues?|complaints?)\s*(?:[:=\-]\s*)?\(?0(?:\b|\s*\))/i,
  /(?:\u8fdd\u89c4|\u653f\u7b56\u8b66\u544a|\u7533\u8bc9|\u95ee\u9898|\u6295\u8bc9)\s*(?:[:\uff1a=\-]\s*)?0(?:\b|\s*\u6761)/i
];
var PERF_HEALTHY_RES = [
  /(?:customer service performance|policy compliance|shipping performance)\s*(?:[:=\-]\s*)?(?:healthy|good)\b/i,
  /(?:\u5ba2\u6237\u670d\u52a1\u7ee9\u6548|\u653f\u7b56\u5408\u89c4\u6027|\u914d\u9001\u7ee9\u6548)\s*(?:[:\uff1a=\-]\s*)?(?:\u5065\u5eb7|\u826f\u597d)/i
];
var PERF_METRIC_RES = [
  /(?:account health rating|order defect rate|late shipment rate|pre-fulfillment cancel rate|valid tracking rate|on-time delivery rate)\D{0,30}\d+(?:\.\d+)?\s*%?/i,
  /(?:\u8d26\u6237\u72b6\u51b5\u8bc4\u7ea7|\u8ba2\u5355\u7f3a\u9677\u7387|\u8fdf\u53d1\u7387|\u53d1\u8d27\u524d\u53d6\u6d88\u7387|\u6709\u6548\u8ffd\u8e2a\u7387|\u51c6\u65f6\u9001\u8fbe\u7387)\D{0,30}\d+(?:\.\d+)?\s*%?/i
];
var PERF_CATEGORY_COUNT_SPECS = [
  { key: "suspected_ip_violations", re: /(?:\bsuspected intellectual property violations?\b|\u6d89\u5acc\u4fb5\u72af\u77e5\u8bc6\u4ea7\u6743)/ig },
  { key: "received_ip_complaints", re: /(?:\b(?:received )?intellectual property complaints?\b|(?:\u6536\u5230\u7684)?\u77e5\u8bc6\u4ea7\u6743\u6295\u8bc9)/ig },
  { key: "product_authenticity_complaints", re: /(?:\bproduct authenticity (?:customer|buyer) complaints?\b|\u5546\u54c1\u771f\u5b9e\u6027(?:\u4e70\u5bb6|\u5ba2\u6237)\u6295\u8bc9)/ig },
  { key: "product_condition_complaints", re: /(?:\bproduct condition (?:customer|buyer) complaints?\b|\u5546\u54c1\u72b6\u51b5(?:\u4e70\u5bb6|\u5ba2\u6237)\u6295\u8bc9)/ig },
  { key: "food_product_safety_issues", re: /(?:\bfood and product safety issues?\b|\u98df\u54c1\u548c\u5546\u54c1\u5b89\u5168\u95ee\u9898)/ig },
  { key: "listing_policy_violations", re: /(?:\blisting policy violations?\b|\u4e0a\u67b6\u653f\u7b56\u8fdd\u89c4)/ig },
  { key: "restricted_product_policy_violations", re: /(?:\brestricted products? policy violations?\b|\u53d7\u9650\u5546\u54c1\u653f\u7b56\u8fdd\u89c4|\u8fdd\u53cd\u53d7\u9650\u5546\u54c1\u653f\u7b56)/ig },
  { key: "customer_reviews_policy_violations", re: /(?:\b(?:customer (?:product )?reviews?|review manipulation) policy violations?\b|(?:\u4e70\u5bb6|\u5ba2\u6237)\u5546\u54c1\u8bc4\u8bba\u653f\u7b56\u8fdd\u89c4|\u8fdd\u53cd(?:\u4e70\u5bb6|\u5ba2\u6237)\u5546\u54c1\u8bc4\u8bba\u653f\u7b56)/ig },
  { key: "other_policy_violations", re: /(?:\bother policy violations?\b|\u5176\u4ed6\u653f\u7b56\u8fdd\u89c4|\u5176\u4ed6\u8fdd\u53cd\u653f\u7b56)/ig },
  { key: "regulatory_compliance", re: /(?:\bregulatory compliance(?: (?:violations?|issues?))?\b|\u76d1\u7ba1\u5408\u89c4\u6027)/ig },
  { key: "policy_warnings", re: /(?:\bpolicy warnings?\b|\u653f\u7b56\u8b66\u544a)/ig }
];
function performanceCategoryCounts(text, source) {
  var value = norm(text), signals = [], seen = {};
  for (var pc = 0; pc < PERF_CATEGORY_COUNT_SPECS.length; pc++) {
    var spec = PERF_CATEGORY_COUNT_SPECS[pc];
    var re = new RegExp(spec.re.source, "ig"), match;
    while ((match = re.exec(value)) !== null && signals.length < 100) {
      var after = value.slice(match.index + match[0].length, match.index + match[0].length + 48);
      var countMatch = /^\s*(?:[:\uFF1A=\-\u2013\u2014]\s*)?\(?\s*(\d{1,5})\s*\)?(?:\s*\u6761)?(?!\s*(?:days?\b|\u5929|\u65e5))(?=\s|$|[,.\uFF0C\u3002;\uFF1B|\/])/i.exec(after);
      if (!countMatch) continue;
      var count = parseInt(countMatch[1], 10);
      if (!isFinite(count) || count < 0) continue;
      var dedupeKey = spec.key + "|" + count + "|" + match.index;
      if (seen[dedupeKey]) continue;
      seen[dedupeKey] = true;
      signals.push({
        key: spec.key, category: match[0], count: count, source: source,
        context: value.slice(Math.max(0, match.index - 60), match.index + match[0].length + countMatch[0].length + 80).slice(0, 240)
      });
    }
  }
  return signals;
}
out.categoryCountSignals = performanceCategoryCounts(BT, "dom-text");
out.nonzeroSignals = out.categoryCountSignals.filter(function (signal) { return signal.count > 0; });
out.zeroCountSignals = out.categoryCountSignals.filter(function (signal) { return signal.count === 0; });
out.zeroNormalSignalCount = 0; out.healthyNormalSignalCount = 0; out.metricSignalCount = 0;
for (var pz = 0; pz < PERF_ZERO_RES.length; pz++) if (PERF_ZERO_RES[pz].test(BT)) out.zeroNormalSignalCount++;
if (out.zeroCountSignals.length > out.zeroNormalSignalCount) out.zeroNormalSignalCount = out.zeroCountSignals.length;
for (var ph = 0; ph < PERF_HEALTHY_RES.length; ph++) if (PERF_HEALTHY_RES[ph].test(BT)) out.healthyNormalSignalCount++;
for (var pm = 0; pm < PERF_METRIC_RES.length; pm++) if (PERF_METRIC_RES[pm].test(BT)) out.metricSignalCount++;
out.loading = /(?:loading|please wait|\u52a0\u8f7d\u4e2d|\u8bf7\u7a0d\u5019)/i.test(BT);
out.pageComplete = out.landed && !out.loading && (
  out.nonzeroSignals.length > 0 || out.zeroNormalSignalCount > 0
  || (out.healthyNormalSignalCount > 0 && out.metricSignalCount > 0)
);
`);

// ------------------------------------------------------- 3. Recent Feedback
/**
 * Feedback Manager: find recent feedback star ratings and flag anything below 4.
 * Ratings appear either as "N out of 5" aria text or as a bare 1-5 in a rating
 * column, so both are collected and de-duplicated by row.
 */
export const FEEDBACK_EXTRACTOR = wrap('feedback/v1', String.raw`
out.landed = /feedback manager|recent feedback|feedback rating|buyer feedback|\u53cd\u9988\u7ba1\u7406\u5668|\u6700\u65b0\u53cd\u9988|\u53cd\u9988\u8bc4\u7ea7/i.test(BT);
out.ratings = []; out.lowCount = 0; out.total = 0; out.average = null; out.aggregateRating = null; out.emptyState = false; out.loading = false;

function feedbackMeta(ctx) {
  var c = norm(ctx), asin = /\b(B0[A-Z0-9]{8})\b/i.exec(c);
  var dt = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i.exec(c);
  if (!dt) dt = /\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b/.exec(c);
  if (!dt) dt = /\b\d{1,2}[-\/]\d{1,2}[-\/]\d{4}\b/.exec(c);
  if (!dt) dt = /\d{4}\s*\u5e74\s*\d{1,2}\s*\u6708\s*\d{1,2}\s*\u65e5/.exec(c);
  var id = /(?:order|feedback)\s*(?:id|number|#)?\s*[:#]?\s*([A-Z0-9-]{8,30})/i.exec(c);
  var title = null;
  return { asin: asin ? asin[1].toUpperCase() : null, date: dt ? dt[0] : null, identifier: id ? id[1] : null, title: title };
}
function feedbackCard(el) {
  var node = el, best = el, hops = 0;
  while (node && hops < 10) {
    var t = ""; try { t = norm(node.textContent); } catch (e) {}
    var nodes = [node], descendants = allEls(node, 300), signals = 0;
    for (var fi = 0; fi < descendants.length; fi++) nodes.push(descendants[fi]);
    for (var fj = 0; fj < nodes.length; fj++) {
      var candidate = nodes[fj], found = false, attrs = ["aria-label", "title", "alt", "data-rating", "label"];
      if (tagOf(candidate) === "kat-star-rating") {
        var candidateValue = null; try { candidateValue = candidate.getAttribute("value"); } catch (fkv) {}
        if (candidateValue && /^[1-5](\.\d)?$/.test(norm(candidateValue))) found = true;
      }
      for (var fa = 0; fa < attrs.length; fa++) {
        var fv = null; try { fv = candidate.getAttribute(attrs[fa]); } catch (fe) {}
        if (fv && /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5/i.test(fv)) { found = true; break; }
      }
      if (found) signals++;
    }
    if (signals > 1) break;
    if (signals === 1 && t.length <= 1800) best = node;
    if (t.length > 1800) break;
    node = node.parentElement; hops++;
  }
  return best;
}

function amazonFulfillmentFeedback(ctx) {
  var value = norm(ctx);
  return /fulfilled by amazon[\s\S]{0,260}(?:take|takes|taken|accept|assume|bear)[\s\S]{0,100}responsib/i.test(value)
    || /amazon[\s\S]{0,140}(?:take|takes|taken|accept|assume|bear)[\s\S]{0,100}responsib[\s\S]{0,180}fulfill/i.test(value)
    || /\u4e9a\u9a6c\u900a[\s\S]{0,180}(?:\u914d\u9001|\u7269\u6d41)[\s\S]{0,100}\u8d1f\u8d23/i.test(value)
    || /(?:\u914d\u9001|\u7269\u6d41)[\s\S]{0,180}\u4e9a\u9a6c\u900a[\s\S]{0,100}\u8d1f\u8d23/i.test(value);
}

function pushRating(v, src, ctx, el) {
  var n = parseFloat(v);
  if (!isFinite(n) || n < 1 || n > 5) return;
  var c = norm(ctx).slice(0, 1000), meta = feedbackMeta(c), title = null;
  if (!meta.date && !meta.identifier && /(?:\d[\d,]*\s+total ratings?|feedback histogram|\u53cd\u9988\u6570\u91cf|\u53cd\u9988\u767e\u5206\u6bd4)/i.test(c)) {
    out.aggregateRating = n;
    return;
  }
  if (el) {
    try {
      var h = feedbackCard(el).querySelector("h1,h2,h3,h4,strong,[data-testid*=title]");
      title = h ? norm(h.textContent).slice(0, 240) : null;
    } catch (e) {}
  }
  out.ratings.push({
    rating: n, source: src, context: c, summary: c.slice(0, 500),
    asin: meta.asin, date: meta.date, identifier: meta.identifier, title: title,
    amazonFulfillmentExcluded: amazonFulfillmentFeedback(c)
  });
}

// aria-label / title style: "3 out of 5 stars"
var els = allEls(document.body, 6000);
for (var i = 0; i < els.length; i++) {
  var el = els[i];
  try {
    var loadingTag = tagOf(el), loadingRole = norm(el.getAttribute("role")), loadingBusy = norm(el.getAttribute("aria-busy"));
    var loadingMeta = norm((el.getAttribute("class") || "") + " " + (el.getAttribute("id") || "") + " " + (el.getAttribute("data-testid") || ""));
    if (isVisible(el) && (loadingRole === "progressbar" || loadingBusy === "true" || /spinner|loading|loader/i.test(loadingTag + " " + loadingMeta))) out.loading = true;
  } catch (loadingError) {}
  // The current Feedback Manager renders its aggregate and row ratings with
  // Katal custom elements.  Their numeric rating lives in the host value
  // attribute and is not necessarily repeated in light-DOM text/ARIA.
  if (tagOf(el) === "kat-star-rating") {
    var kv = null; try { kv = el.getAttribute("value"); } catch (ke) {}
    if (kv && /^[1-5](\.\d)?$/.test(norm(kv))) {
      var kfc = feedbackCard(el), kfct = ""; try { kfct = norm(kfc.textContent); } catch (ke0) {}
      pushRating(norm(kv), "kat-star-rating:value", kfct || kv, el);
      continue;
    }
  }
  var attrs = ["aria-label", "title", "alt", "data-rating", "label"];
  for (var a = 0; a < attrs.length; a++) {
    var v = null; try { v = el.getAttribute(attrs[a]); } catch (e) {}
    if (!v) continue;
    var m = /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5/i.exec(v);
    var fc = feedbackCard(el), fct = ""; try { fct = norm(fc.textContent); } catch (e0) {}
    if (m) { pushRating(m[1], "attr:" + attrs[a], fct || v, el); break; }
    if (/^[1-5](\.\d)?$/.test(norm(v)) && /rating|star/i.test(attrs[a] + " " + tagOf(el))) {
      pushRating(norm(v), "attr:" + attrs[a], fct || v, el);
      break;
    }
  }
}

// Text is a fallback only. Counting both attributes and the same visible text
// would double every feedback record.
if (out.ratings.length === 0) {
  var re = /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5/gi, mm;
  while ((mm = re.exec(BT)) !== null) {
    // Full-page text can place ratings after all row bodies.  It proves the
    // count and severity, but it cannot safely identify a neighbouring row.
    var textContext = BT.slice(Math.max(0, mm.index - 360), Math.min(BT.length, mm.index + mm[0].length + 420));
    pushRating(mm[1], "pagetext", textContext, null);
    if (out.ratings.length > 200) break;
  }
}

// Star-count rows rendered as repeated glyphs are not reliable; note if we saw none.
out.total = out.ratings.length;
var low = out.ratings.filter(function (r) { return r.rating < 4; });
out.lowCount = low.length;
out.lowRatings = low.slice(0, 20);
if (out.total) {
  var sum = 0;
  for (var k = 0; k < out.ratings.length; k++) sum += out.ratings[k].rating;
  out.average = Math.round((sum / out.total) * 100) / 100;
} else if (out.landed) {
  out.notes.push("landed on Feedback Manager but found no parsable star ratings");
}
var explicitFeedbackEmpty = /no (?:recent )?feedback|0\s+(?:feedback|results)|\u6682\u65e0\u53cd\u9988|\u6ca1\u6709\u53cd\u9988|0\s*\u6761\u7ed3\u679c/i.test(BT);
var recentGridReady = /(?:recent feedback[\s\S]{0,240}date[\s\S]{0,120}rating[\s\S]{0,160}order id|\u6700\u65b0\u53cd\u9988[\s\S]{0,240}\u65e5\u671f[\s\S]{0,120}\u8bc4\u7ea7[\s\S]{0,160}\u8ba2\u5355\u7f16\u53f7)/i.test(BT);
out.emptyState = explicitFeedbackEmpty || (out.landed && recentGridReady && !out.loading && out.total === 0);
if (out.ratings.length > 40) out.ratings = out.ratings.slice(0, 40);
`);

// ----------------------------------------------------- 4. Customer Reviews
/** Brand customer reviews: flag any review below 4 stars. */
export const REVIEWS_EXTRACTOR = wrap('reviews/v2', String.raw`
out.landed = /customer reviews|brand customer reviews|review|star rating|\u4e70\u5bb6\u8bc4\u8bba|\u661f\u7ea7\u8bc4\u5b9a/i.test(BT);
out.reviews = []; out.lowCount = 0; out.total = 0; out.average = null; out.emptyState = false;

function reviewCard(el) {
  // Real card boundaries remain reliable even when the review body is long.
  var exact = el;
  for (var ex = 0; exact && ex < 12; ex++, exact = exact.parentElement) {
    var testId = exact.getAttribute ? exact.getAttribute("data-testid") : "";
    if (/^review-R[A-Z0-9]+$/.test(testId || "")) return exact;
  }
  var node = el, best = el, hops = 0;
  while (node && hops < 12) {
    var t = ""; try { t = norm(node.textContent); } catch (e) {}
    var nodes = [node], descendants = allEls(node, 350), signals = 0;
    for (var ri = 0; ri < descendants.length; ri++) nodes.push(descendants[ri]);
    for (var rj = 0; rj < nodes.length; rj++) {
      var candidate = nodes[rj], found = false;
      var isKat = tagOf(candidate) === "kat-star-rating";
      if (isKat) {
        var rcls = "", rvalue = null;
        try { rcls = String(candidate.getAttribute("class") || ""); rvalue = candidate.getAttribute("value"); } catch (re0) {}
        found = /reviewRating/i.test(rcls) && !!rvalue;
      }
      if (!isKat && !found) {
        var rattrs = ["aria-label", "title", "alt", "data-rating"];
        for (var ra = 0; ra < rattrs.length; ra++) {
          var rav = null; try { rav = candidate.getAttribute(rattrs[ra]); } catch (re1) {}
          if (rav && /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5\s*(?:star)?/i.test(rav)) { found = true; break; }
        }
      }
      if (found) signals++;
    }
    if (signals > 1) break;
    if (signals === 1 && t.length <= 2400) best = node;
    if (t.length > 2400) break;
    node = node.parentElement; hops++;
  }
  return best;
}
function reviewMeta(ctx) {
  var c = norm(ctx), asin = /(?:^|[^A-Z0-9])(B0[A-Z0-9]{8})(?![A-Z0-9])/i.exec(c);
  var parentAsin = /(?:parent\s*asin|\u7236\s*asin)\s*[:\uff1a]?\s*(B0[A-Z0-9]{8})/i.exec(c);
  var childAsin = /(?:child\s*asin|\u5b50\s*asin)\s*[:\uff1a]?\s*(B0[A-Z0-9]{8})/i.exec(c);
  var brand = /(?:brand|\u54c1\u724c)\s*[:\uff1a]?\s*([A-Z0-9][A-Z0-9 .&'_-]{0,60}?)(?=\s+(?:parent|child|asin|\u7236|\u5b50)|$)/i.exec(c);
  var dt = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i.exec(c);
  if (!dt) dt = /\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b/.exec(c);
  if (!dt) dt = /\d{4}\s*\u5e74\s*\d{1,2}\s*\u6708\s*\d{1,2}\s*\u65e5/.exec(c);
  var id = /(?:review)\s*(?:id|number|#)?\s*[:#]?\s*([A-Z0-9-]{8,30})/i.exec(c);
  var author = /review by\s+(.{1,80}?)\s+on\s+(?=(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?))/i.exec(c);
  if (!author) author = /^(.{1,80}?)\s*\u4e8e\s*\d{4}\s*\u5e74/i.exec(c);
  var authorText = author ? norm(author[1]).replace(/^.*(?:\u6807\u8bb0\u4e3a\u5df2\u5b8c\u6210|mark(?:ed)? as (?:done|complete)|completed)\s*/i, "") : null;
  return {
    asin: asin ? asin[1].toUpperCase() : null,
    parentAsin: parentAsin ? parentAsin[1].toUpperCase() : null,
    childAsin: childAsin ? childAsin[1].toUpperCase() : null,
    brand: brand ? norm(brand[1]).slice(0, 80) : null,
    author: authorText ? authorText.slice(0, 80) : null,
    date: dt ? dt[0] : null, identifier: id ? id[1] : null
  };
}

function add(stars, src, ctx, asin, el) {
  var n = parseFloat(stars);
  if (!isFinite(n) || n < 1 || n > 5) return;
  var full = norm(ctx), c = full.slice(0, 1400), meta = reviewMeta(full), title = null, reviewId = null;
  if (el) {
    var card = reviewCard(el), cardId = card.getAttribute("data-testid") || "";
    if (/^review-R[A-Z0-9]+$/.test(cardId)) {
      reviewId = cardId.slice(7);
      var details = allEls(card, 1000);
      for (var di = 0; di < details.length; di++) {
        if (details[di].getAttribute("id") === reviewId + "-title") title = norm(details[di].textContent).slice(0, 240);
      }
    }
    try {
      var h = reviewCard(el).querySelector("[data-testid*=title],.reviewTitle,[class*=reviewTitle],h1,h2,h3,h4,strong");
      if (!title) title = h ? norm(h.textContent).slice(0, 240) : null;
    } catch (e) {}
  }
  out.reviews.push({
    stars: n, source: src, asin: asin || meta.childAsin || meta.parentAsin || meta.asin || null,
    parentAsin: meta.parentAsin, childAsin: meta.childAsin, brand: meta.brand,
    author: meta.author,
    context: c, summary: c.slice(0, 500), title: title,
    date: meta.date, identifier: meta.identifier, reviewId: reviewId
  });
}

var ASIN_RE = /(?:^|[^A-Z0-9])(B0[A-Z0-9]{8})(?![A-Z0-9])/;
var els = allEls(document.body, 6000);
for (var i = 0; i < els.length; i++) {
  var el = els[i];
  // Current Seller Central renders the actual review score as
  // <kat-star-rating class="reviewRating" value="N">. Other star-rating
  // elements in the same card describe the product aggregate, not the review.
  if (tagOf(el) === "kat-star-rating") {
    var cls = "", rv = null;
    try { cls = String(el.getAttribute("class") || ""); rv = el.getAttribute("value"); } catch (e0) {}
    if (/reviewRating/i.test(cls) && rv) {
      var rrow = reviewCard(el);
      var rtxt = ""; try { rtxt = norm(rrow.textContent); } catch (e1) {}
      var ram = ASIN_RE.exec(rtxt);
      add(rv, "kat-star-rating:value", rtxt, ram ? ram[1] : null, el);
    }
    continue;
  }
  var attrs = ["aria-label", "title", "alt", "data-rating"];
  for (var a = 0; a < attrs.length; a++) {
    var v = null; try { v = el.getAttribute(attrs[a]); } catch (e) {}
    if (!v) continue;
    var m = /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5\s*(?:star)?/i.exec(v);
    if (!m) continue;
    var row = reviewCard(el);
    var rt = ""; try { rt = norm(row.textContent); } catch (e) {}
    var am = ASIN_RE.exec(rt);
    add(m[1], "attr:" + attrs[a], rt, am ? am[1] : null, el);
    break;
  }
}

if (out.reviews.length === 0) {
  var re = /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5/gi, mm;
  while ((mm = re.exec(BT)) !== null) {
    // Count-only fallback: flattened page text cannot prove which row owns a
    // trailing score, so never attach a nearby ASIN or summary here.
    add(mm[1], "pagetext", "", null, null);
    if (out.reviews.length > 200) break;
  }
}

out.total = out.reviews.length;
var low = out.reviews.filter(function (r) { return r.stars < 4; });
out.lowCount = low.length;
out.lowReviews = low;
if (out.total) {
  var sum = 0;
  for (var k = 0; k < out.reviews.length; k++) sum += out.reviews[k].stars;
  out.average = Math.round((sum / out.total) * 100) / 100;
} else if (out.landed) {
  out.notes.push("landed on reviews page but found no parsable star ratings");
}
out.emptyState = /no (?:customer )?reviews|0\s+(?:reviews|results)|\u6682\u65e0\u8bc4\u8bba|\u6ca1\u6709\u8bc4\u8bba|0\s*\u6761\u7ed3\u679c/i.test(BT);
// Pagination and the filter toolbar are separate from review prose.
// Read only observed structural controls; do not infer scope from star rows.
out.pagination = null; out.paginationCount = 0;
out.filters = { searchCount: 0, search: null, selectedStars: [], starOptions: [], starsLabel: null,
  orderLabel: null, timeLabel: null, includeDoneLabel: null, includeDone: false };
for (var fi = 0; fi < els.length; fi++) {
  var fe = els[fi], ft = tagOf(fe), fid = fe.getAttribute("id") || "";
  if (ft === "kat-pagination") {
    out.paginationCount++;
    out.pagination = { total: Number(fe.getAttribute("total-items")), size: Number(fe.getAttribute("items-per-page")), page: Number(fe.getAttribute("page")) };
  }
  if (fe.getAttribute("data-testid") === "search-box-input") { out.filters.searchCount++; out.filters.search = String(fe.value || ""); }
  if (fid === "stars-filter") out.filters.starsLabel = norm(fe.textContent);
  if (fid === "orderStatus-filter") out.filters.orderLabel = norm(fe.textContent);
  if (fid === "timePeriod-filter") out.filters.timeLabel = norm(fe.textContent);
  if (fid === "includeDone-close") out.filters.includeDone = true;
  if (fid === "includeDone-filter") {
    out.filters.includeDoneLabel = norm(fe.textContent);
    out.filters.includeDoneClass = fe.getAttribute("class");
  }
  var starItem = /^stars-item-([1-5])$/.exec(fid);
  if (starItem) {
    var sn = Number(starItem[1]), choices = allEls(fe, 20);
    out.filters.starOptions.push(sn);
    for (var ci = 0; ci < choices.length; ci++) {
      if (tagOf(choices[ci]) === "button" && choices[ci].getAttribute("value")) out.filters.selectedStars.push(sn);
    }
  }
}
out.filters.selectedStars.sort(); out.filters.starOptions.sort();
`);

// -------------------------------------------------------- 5. ASIN health check
/**
 * Runs on a public product detail page (not Seller Central): can the page open,
 * is there an add-to-cart control, and what is the current star rating? The
 * rating is compared against the previous Beijing calendar day's baseline on the Node side.
 */
export const ASIN_IMAGE_ERROR_TEXT_EXTRACTOR = String.raw`
var text = [];
if (/^page not found$/i.test(String(document.title || "").trim())
    && !document.getElementById("productTitle")) {
  var images = document.querySelectorAll("img[alt]");
  for (var i = 0; i < images.length && i < 50; i++) {
    var el = images[i];
    var rects = el.getClientRects();
    var style = window.getComputedStyle(el);
    if (!rects.length || style.display === "none" || style.visibility === "hidden"
        || style.visibility === "collapse" || Number(style.opacity) === 0) continue;
    var alt = String(el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
    if (alt) text.push(alt.slice(0, 1000));
  }
}
return {text: text.join("\n")};
`;

export const ASIN_DETAIL_EXTRACTOR = wrap('asin-detail/v1', String.raw`
out.landed = false;
out.asin = null; out.titleText = null; out.rating = null; out.reviewCount = null;
out.hasCart = false; out.cartSelector = null; out.buyable = false;
out.unavailable = false; out.dogPage = false;

try {
  var m = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i.exec(location.href);
  if (m) out.asin = m[1].toUpperCase();
} catch (e) {}

out.dogPage = /sorry!?\s*we couldn.t find that page|page not found|looking for something\?|\u627e\u4e0d\u5230\u8be5\u9875\u9762|\u9875\u9762\u4e0d\u5b58\u5728/i.test(BT);
// Amazon's image-only error page has no rendered body text. The document
// title supplies DOM evidence; the independent image-alt read must still
// corroborate it before the verdict may exclude this listing.
if (!out.dogPage && /^page not found$/i.test(out.title)
    && !document.getElementById("productTitle")) out.dogPage = true;
var UNAVAILABLE_RE = /currently unavailable|out of stock|we don.t know when or if this item will be back|\u5f53\u524d\u65e0\u8d27|\u6682\u65f6\u7f3a\u8d27/i;
var pageUnavailable = UNAVAILABLE_RE.test(BT);
var scopedUnavailable = false;
var scopedAvailabilityFound = false;
var AVAILABILITY_IDS = ["availability", "outOfStock", "availabilityInsideBuyBox_feature_div", "availability-message"];
for (var a = 0; a < AVAILABILITY_IDS.length; a++) {
  var av = null;
  try { av = document.getElementById ? document.getElementById(AVAILABILITY_IDS[a]) : null; } catch (e) {}
  if (!av || !isVisible(av)) continue;
  var avText = norm(av.textContent || av.innerText || "");
  if (!avText) continue;
  scopedAvailabilityFound = true;
  if (UNAVAILABLE_RE.test(avText)) {
    scopedUnavailable = true;
    out.unavailableSource = "#" + AVAILABILITY_IDS[a];
    break;
  }
}

var t = document.getElementById ? document.getElementById("productTitle") : null;
if (t) { out.titleText = norm(t.textContent).slice(0, 200); }
out.landed = !!(out.titleText || /add to cart|buy now|add to basket|product details|about this item|customer reviews|currently unavailable|\u52a0\u5165\u8d2d\u7269\u8f66|\u7acb\u5373\u8d2d\u4e70|\u5546\u54c1\u4fe1\u606f|\u5173\u4e8e\u6b64\u5546\u54c1|\u4e70\u5bb6\u8bc4\u8bba|\u5f53\u524d\u65e0\u8d27/i.test(BT)) && !out.dogPage;

// Add-to-cart control: id first (stable on Amazon), then a text scan.
var CART_IDS = ["add-to-cart-button", "add-to-cart-button-ubb", "buy-now-button", "submit.add-to-cart"];
for (var i = 0; i < CART_IDS.length; i++) {
  var el = null;
  try { el = document.getElementById(CART_IDS[i]) || document.querySelector("[name='" + CART_IDS[i] + "']"); } catch (e) {}
  if (el && isVisible(el)) { out.hasCart = true; out.cartSelector = "#" + CART_IDS[i]; break; }
}
if (!out.hasCart) {
  var btns = [];
  try { btns = document.querySelectorAll("input[type=submit],button,span.a-button-inner,a.a-button-text"); } catch (e) {}
  for (var b = 0; b < btns.length && b < 800; b++) {
    var bt2 = norm(btns[b].textContent || btns[b].value || "");
    if (/^(add to cart|add to basket|buy now|\u52a0\u5165\u8d2d\u7269\u8f66|\u7acb\u5373\u8d2d\u4e70)$/i.test(bt2) && isVisible(btns[b])) {
      out.hasCart = true; out.cartSelector = "text:" + bt2; break;
    }
  }
}
// Whole-page text often contains "Currently unavailable" in recommendations.
// Treat that fallback as the main offer only when no visible cart exists. A
// scoped main availability node remains authoritative if it conflicts.
out.unavailable = scopedUnavailable || (!out.hasCart && pageUnavailable);
if (!out.unavailable && pageUnavailable && out.hasCart) out.notes.push("ignored unscoped unavailable text because the main offer has a visible cart");
out.availabilityScoped = scopedAvailabilityFound;
out.buyable = out.hasCart && !out.unavailable;

// Star rating: prefer the aria text next to the review link.
var rm = /(\d(?:\.\d)?)\s*out of\s*5\s*stars/i.exec(BT);
if (rm) out.rating = parseFloat(rm[1]);
var cm = /([\d,]+)\s*(?:global\s*)?ratings?/i.exec(BT);
if (!cm) cm = /([\d,]+)\s*(?:\u4e2a)?\u8bc4\u5206/.exec(BT);
if (cm) out.reviewCount = parseInt(cm[1].replace(/,/g, ""), 10);
if (out.rating === null) out.notes.push("no star rating found on the detail page");
`);

// --------------------------------------------------- 6. Outlet deal monitoring
/**
 * Manage Inventory Health filtered to OUTLET_DEAL: count the rows offering
 * "Create outlet deal". New eligible SKUs versus the previous run are what the
 * requirement calls a new activity.
 */
export const OUTLET_EXTRACTOR = wrap('outlet/v5', String.raw`
out.landed = /inventory (health|age)|manage inventory|outlet|recommended action|\u7ba1\u7406.*\u5e93\u5b58|\u5e93\u5b58\u72b6\u51b5|\u5965\u7279\u83b1\u65af|\u5efa\u8bae\u64cd\u4f5c/i.test(BT);
out.createDealCount = 0; out.skus = []; out.actionLabels = []; out.ignoredFilterControlCount = 0;
out.ambiguousActionCount = 0; out.ambiguousActions = []; out.duplicateActionCount = 0;
out.zeroResultNodeCount = 0; out.ambiguousZeroResultNodeCount = 0; out.ignoredFilterZeroCount = 0;
out.zeroCandidates = []; out.reportedTotal = null; out.reportedTotalReliable = false; out.reportedTotalSourceCount = 0; out.reportedTotalConflict = false;
out.zeroResults = /0\s*results|did not return any results|0\s*\u6761\u7ed3\u679c|\u672a\u8fd4\u56de\u4efb\u4f55\u7ed3\u679c|\u65e0\u7ed3\u679c/i.test(BT);

var LINK_RE = /^(create outlet deal|create an outlet deal|outlet deal|\u521b\u5efa\u5965\u7279\u83b1\u65af\u9650\u65f6\u4fc3\u9500)$/i;
var ZERO_NODE_RE = /^(?:0\s*results?|0\s*\u6761\u7ed3\u679c|your query did not return any results|\u672a\u8fd4\u56de\u4efb\u4f55\u7ed3\u679c|\u65e0\u7ed3\u679c)$/i;
var TOTAL_NODE_RE = /^(?:total(?:\s+results?)?\s*[:\-]?\s*(\d+)|(\d+)\s+results?|\u5171\s*(\d+)\s*\u6761\u7ed3\u679c|\u603b\u8ba1\s*[:\uff1a]\s*(\d+)|(\d+)\s*\u6761\u7ed3\u679c|\d+\s*[~\uff5e]\s*\d+\s*[,\uff0c]\s*\u5171\s*(\d+))$/i;
var FILTER_META_RE = /(?:^|[-_ ])(?:selected[-_ ]?)?(?:filter|facet|chip|token)s?(?:$|[-_ ])/i;
var RESULT_META_RE = /(?:^|[-_ ])(?:result|results|table|grid|data-grid|product-list|inventory-list|inventory-table)(?:$|[-_ ])/i;
var SELECTED_FILTER_TEXT_RE = /selected filters?|filter criteria|\u5df2\u9009\u7b5b\u9009\u6761\u4ef6/i;

function outletParent(node) {
  try { if (node && node.parentElement) return node.parentElement; } catch (e) {}
  try { var root = node && node.getRootNode ? node.getRootNode() : null; if (root && root.host) return root.host; } catch (e2) {}
  return null;
}
function outletMeta(node) {
  try {
    return norm((node.getAttribute("id") || "") + " " + (node.getAttribute("class") || "") + " "
      + (node.getAttribute("data-testid") || "") + " " + (node.getAttribute("data-test") || "") + " "
      + (node.getAttribute("role") || ""));
  } catch (e) { return ""; }
}
function outletContext(el) {
  var node = outletParent(el), hops = 0, filterLike = false, resultLike = false, trail = [];
  while (node && hops < 10) {
    var tag = tagOf(node), meta = outletMeta(node), nt = "";
    try { nt = norm(node.textContent); } catch (e) {}
    if (trail.length < 6) trail.push({ tag: tag, meta: meta.slice(0, 160) });
    if (FILTER_META_RE.test(meta) || (nt.length > 0 && nt.length <= 400 && SELECTED_FILTER_TEXT_RE.test(nt))) {
      filterLike = true; break;
    }
    var role = "";
    try { role = norm(node.getAttribute("role")); } catch (eRole) {}
    // 2026-09-29 FENG inventory: the "1~1, total" counter is in the table
    // footer, a sibling of the table inside the captured region wrapper.
    if (/^(?:table|thead|tbody|tfoot)$/.test(tag) || /^(?:table|grid|rowgroup)$/i.test(meta)
        || RESULT_META_RE.test(meta)
        || (role === "region" && /(?:^|[-_ ])wrapper(?:$|[-_ ])/.test(meta) && /(?:^|[-_ ])has-footer(?:$|[-_ ])/.test(meta))) {
      resultLike = true; break;
    }
    if (tag === "main" || tag === "body" || nt.length > 800) break;
    node = outletParent(node); hops++;
  }
  return { filterLike: filterLike, resultLike: resultLike, trail: trail };
}
function outletRow(el) {
  var node = el, hops = 0;
  while (node && hops < 14) {
    var tag = tagOf(node), role = "", meta = outletMeta(node);
    try { role = norm(node.getAttribute("role")); } catch (e) {}
    if (tag === "tr" || /^(?:row|listitem)$/i.test(role)
        || /(?:^|[-_ ])(?:table-)?row(?:$|[-_ ])|(?:^|[-_ ])(?:product|inventory)-(?:item|card)(?:$|[-_ ])/i.test(meta)) return node;
    node = outletParent(node); hops++;
  }
  return null;
}
function outletDeepText(root) {
  if (!root) return "";
  var queue = [root], seen = [], parts = [], nodeCount = 0;
  for (var qi = 0; qi < queue.length && qi < 80 && nodeCount < 6000; qi++) {
    var qr = queue[qi];
    if (!qr || seen.indexOf(qr) >= 0) continue;
    seen.push(qr);
    var qt = "";
    try { qt = norm(qr.innerText || qr.textContent); } catch (e0) {}
    if (qt) parts.push(qt);
    var qnodes = [];
    try { qnodes = qr.querySelectorAll("*"); } catch (e1) {}
    nodeCount += qnodes.length;
    for (var qn = 0; qn < qnodes.length && nodeCount < 6000; qn++) {
      try {
        var qel = qnodes[qn], qet = norm((qel.innerText || qel.textContent || "") + " "
          + ((qel.getAttribute && qel.getAttribute("aria-label")) || "") + " "
          + ((qel.getAttribute && qel.getAttribute("data-asin")) || "") + " "
          + ((qel.getAttribute && qel.getAttribute("data-sku")) || "") + " "
          + ((qel.getAttribute && qel.getAttribute("href")) || ""));
        if (qet) parts.push(qet);
        if (qnodes[qn].shadowRoot && queue.indexOf(qnodes[qn].shadowRoot) < 0) queue.push(qnodes[qn].shadowRoot);
      } catch (e2) {}
    }
  }
  return norm(parts.join(" "));
}

// Walk light DOM, every readable open shadow root and same-origin frame.  A
// visible unreadable frame, traversal error or node/root budget overflow makes
// the scan incomplete, so a zero result can never become a false green.
var els = [], roots = [], rootIndex = 0, OUTLET_NODE_CAP = 50000, OUTLET_ROOT_CAP = 512;
out.scanComplete = true; out.unreadableFrameCount = 0;
if (document.body) roots.push(document.body); else out.scanComplete = false;
while (rootIndex < roots.length && rootIndex < OUTLET_ROOT_CAP && out.scanComplete) {
  var outletRoot = roots[rootIndex++], outletNodes = [];
  try { outletNodes = outletRoot.querySelectorAll("*"); } catch (e0) { out.scanComplete = false; break; }
  if (els.length + outletNodes.length > OUTLET_NODE_CAP) { out.scanComplete = false; break; }
  for (var oi = 0; oi < outletNodes.length; oi++) {
    var outletEl = outletNodes[oi]; els.push(outletEl);
    try { if (outletEl.shadowRoot && roots.indexOf(outletEl.shadowRoot) < 0) roots.push(outletEl.shadowRoot); } catch (e1) { out.scanComplete = false; }
    if (/^(?:iframe|frame)$/.test(tagOf(outletEl))) {
      try {
        var frameDoc = outletEl.contentDocument;
        if (frameDoc && frameDoc.body) {
          if (roots.indexOf(frameDoc.body) < 0) roots.push(frameDoc.body);
        } else if (isVisible(outletEl)) {
          out.unreadableFrameCount++; out.scanComplete = false;
        }
      } catch (e2) {
        if (isVisible(outletEl)) { out.unreadableFrameCount++; out.scanComplete = false; }
      }
    }
  }
}
if (rootIndex < roots.length || roots.length > OUTLET_ROOT_CAP) out.scanComplete = false;
out.scannedNodeCount = els.length; out.traversedRootCount = rootIndex; out.discoveredRootCount = roots.length;

var seenOutletKeys = {};
for (var i = 0; i < els.length; i++) {
  var el = els[i];
  var t = leafText(el);
  if (!t) continue;
  if (ZERO_NODE_RE.test(t) && isVisible(el)) {
    var zctx = outletContext(el);
    if (zctx.filterLike) out.ignoredFilterZeroCount++;
    else if (zctx.resultLike) out.zeroResultNodeCount++;
    else out.ambiguousZeroResultNodeCount++;
    if (out.zeroCandidates.length < 10) {
      out.zeroCandidates.push({ text: t.slice(0, 100), filterLike: zctx.filterLike, resultLike: zctx.resultLike, trail: zctx.trail });
    }
  }
  var totalNode = TOTAL_NODE_RE.exec(t);
  if (totalNode && isVisible(el)) {
    var totalCtx = outletContext(el), totalValue = parseInt(totalNode[1] || totalNode[2] || totalNode[3] || totalNode[4] || totalNode[5] || totalNode[6], 10);
    if (totalValue > 0 && totalCtx.resultLike && !totalCtx.filterLike) {
      out.reportedTotalSourceCount++;
      if (out.reportedTotal === null) out.reportedTotal = totalValue;
      else if (out.reportedTotal !== totalValue) out.reportedTotalConflict = true;
    }
  }
  if (!LINK_RE.test(t)) continue;
  if (!isVisible(el)) continue;
  var row = outletRow(el), rowFound = !!row;
  var rt = "";
  try { rt = outletDeepText(row || outletParent(el)); } catch (e3) {}
  var asin = /\b(B0[A-Z0-9]{8})\b/.exec(rt);
  var sku = /\b(?:SKU|MSKU)[:\s]+([A-Za-z0-9._-]{3,40})\b/i.exec(rt);
  var offer = /\b(?:offer|fnsku)\s*(?:id)?[:\s]+([A-Za-z0-9._-]{3,80})\b/i.exec(rt);
  var control = el, controlHops = 0, controlTag = tagOf(control), controlRole = "";
  while (control && controlHops < 5) {
    try { controlRole = norm(control.getAttribute("role")); } catch (e4) { controlRole = ""; }
    controlTag = tagOf(control);
    if (/^(?:a|button)$/.test(controlTag) || /^(?:button|link)$/i.test(controlRole) || /^kat-(?:button|link)/.test(controlTag)) break;
    if (control === row) break;
    control = outletParent(control); controlHops++;
  }
  var href = "", disabled = false;
  try {
    href = String(control && control.getAttribute ? (control.getAttribute("href") || "") : "");
    disabled = !!(control && control.hasAttribute && (control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true"));
  } catch (e5) {}
  var interactive = !!control && (/^(?:a|button)$/.test(controlTag) || /^(?:button|link)$/i.test(controlRole) || /^kat-(?:button|link)/.test(controlTag));
  var actionCtx = outletContext(el);
  if (actionCtx.filterLike && !rowFound && !asin && !sku && !offer) {
    out.ignoredFilterControlCount++;
    continue;
  }
  if (!interactive || disabled || !rowFound || (!asin && !sku && !offer)) {
    out.ambiguousActionCount++;
    if (out.ambiguousActions.length < 10) {
      out.ambiguousActions.push({
        tag: controlTag, role: controlRole || null, rowFound: rowFound,
        filterLike: actionCtx.filterLike, interactive: interactive, disabled: disabled,
        asin: asin ? asin[1] : null, sku: sku ? sku[1] : null, offerId: offer ? offer[1] : null,
        context: rt.slice(0, 220), contextTail: rt.slice(Math.max(0, rt.length - 220)),
        trail: actionCtx.trail,
      });
    }
    continue;
  }
  var actionKey = norm((asin ? asin[1] : "") + "|" + (sku ? sku[1] : "") + "|" + (offer ? offer[1] : "")).toLowerCase();
  if (seenOutletKeys[actionKey]) { out.duplicateActionCount++; continue; }
  seenOutletKeys[actionKey] = true;
  out.createDealCount++;
  if (out.actionLabels.length < 5) out.actionLabels.push(t);
  if (out.skus.length < 60) {
    out.skus.push({
      asin: asin ? asin[1] : null,
      sku: sku ? sku[1] : null,
      offerId: offer ? offer[1] : null,
      actionHref: href || null,
      actionFound: true,
      row: rt.slice(0, 220),
    });
  }
}
// Page text is supporting evidence only.  Node-side judging never creates a
// new business activity without a stable DOM row key.
if (out.reportedTotal !== null && out.reportedTotal > 0 && !out.reportedTotalConflict) out.zeroResults = false;
var tm = BT.match(/create (?:an )?outlet deal|\u521b\u5efa\u5965\u7279\u83b1\u65af\u9650\u65f6\u4fc3\u9500/gi);
out.textMentionCount = out.zeroResults ? 0 : (tm ? tm.length : 0);
out.reportedTotalReliable = !out.zeroResults && out.scanComplete && !out.reportedTotalConflict
  && out.reportedTotalSourceCount > 0 && out.reportedTotal !== null;
out.hasNextPage = false;
for (var on = 0; on < els.length && on < OUTLET_NODE_CAP; on++) {
  var nextTag = tagOf(els[on]);
  if (!/^(?:a|button|kat-button|kat-link)$/.test(nextTag)) continue;
  var ont = norm(els[on].textContent), ona = "", ond = false;
  try {
    ona = norm(els[on].getAttribute("aria-label"));
    ond = els[on].hasAttribute("disabled") || els[on].getAttribute("aria-disabled") === "true";
  } catch (e6) {}
  if (/^(?:next|\u4e0b\u4e00\u9875)$/i.test(ont) || /next page|\u4e0b\u4e00\u9875/i.test(ona)) {
    if (!ond && isVisible(els[on])) out.hasNextPage = true;
  }
}
out.loading = /(?:loading|please wait|\u52a0\u8f7d\u4e2d|\u8bf7\u7a0d\u5019)/i.test(BT);
out.zeroResultsReliable = out.zeroResults && out.reportedTotal === null && out.zeroResultNodeCount > 0 && out.scanComplete;
out.paginationComplete = (out.zeroResultsReliable && out.scanComplete && out.ambiguousActionCount === 0) || (
  out.reportedTotalReliable && out.createDealCount > 0 && out.reportedTotal === out.createDealCount
    && out.ambiguousActionCount === 0 && !out.hasNextPage
);
out.pageComplete = out.landed && !out.loading && out.paginationComplete;
if (out.landed && out.createDealCount === 0 && out.textMentionCount === 0) {
  out.notes.push("no 'Create outlet deal' action found (may simply mean no eligible SKUs)");
}
`);

// ------------------------------------------------------------------ 7. VOC
/**
 * Voice of the Customer: read the per-ASIN CX health rows and the return/NCX
 * counts that back them. This is the registration source for return records.
 */
export const VOC_EXTRACTOR = wrap('voc/v1', String.raw`
out.landed = /voice of the customer|customer experience|cx health|ncx|\u4e70\u5bb6\u4e4b\u58f0|\u4e70\u5bb6\u6ee1\u610f\u5ea6\u72b6\u51b5|\u4e70\u5bb6\u4e0d\u6ee1\u610f\u7387/i.test(BT);
out.rows = []; out.poorCount = 0; out.poorAsins = []; out.totalNcx = 0; out.zeroResults = false;
out.headerMappedRowCount = 0; out.headerMappingCompleteRowCount = 0; out.headerMissingColumns = []; out.headerDiagnostics = [];
// Observed VOC pagination host (2026-09-10); its controls live in a closed
// shadow root, but page/count attributes are independently readable here.
out.listCoverageRequired = true;
out.pagination = null;
var vocPagers = deepQuery(document, "#listing-table-pagination kat-pagination", 5);
out.paginationHostCount = vocPagers.length;
if (vocPagers.length === 1) {
  var vp = vocPagers[0];
  var vpPage = vp.getAttribute("page"), vpSize = vp.getAttribute("items-per-page"), vpTotal = vp.getAttribute("total-items");
  if (/^[1-9][0-9]*$/.test(vpPage || "") && /^[1-9][0-9]*$/.test(vpSize || "") && /^(0|[1-9][0-9]*)$/.test(vpTotal || "")) {
    out.pagination = { page: Number(vpPage), pageSize: Number(vpSize), total: Number(vpTotal) };
  }
}

var CX_RE = /\b(Very Poor|Poor|Fair|Good|Very Good|Excellent)\b|\u6781\u5dee|\u4e0d\u5408\u683c|\u975e\u5e38\u5dee|\u8f83\u5dee|\u4e00\u822c|\u826f\u597d|\u4f18\u79c0|\u6781\u597d/i;
var REASON_RE = /(defective item|damaged item|wrong item(?: was sent)?|performance or quality not adequate|not as described|missing (?:parts?|components?)|inaccurate website description|arrived (?:late|damaged)|unwanted item|\u5546\u54c1\u6709\u7f3a\u9677|\u5546\u54c1\u5b58\u5728\u7455\u75b5|\u5546\u54c1\u635f\u574f|\u9519\u53d1\u5546\u54c1|\u6027\u80fd\u6216\u8d28\u91cf\u4e0d\u4f73|\u6027\u80fd\u6216\u54c1\u8d28\u4e0d\u7406\u60f3|\u63cf\u8ff0\u4e0d\u7b26|\u7f3a\u5c11\u90e8\u4ef6)/i;
function parentAcrossShadow(node) {
  if (!node) return null;
  try { if (node.parentElement) return node.parentElement; } catch (e) {}
  try { var root = node.getRootNode ? node.getRootNode() : null; if (root && root.host && root.host !== node) return root.host; } catch (e2) {}
  return null;
}
function deepQuery(root, selector, cap) {
  var roots = [root], seenRoots = [], result = [], limit = cap || 3000;
  for (var ri = 0; ri < roots.length && ri < 80; ri++) {
    var rr = roots[ri]; if (!rr || seenRoots.indexOf(rr) >= 0) continue; seenRoots.push(rr);
    var matches = []; try { matches = rr.querySelectorAll(selector); } catch (e) {}
    for (var mi = 0; mi < matches.length && result.length < limit; mi++) if (result.indexOf(matches[mi]) < 0) result.push(matches[mi]);
    var all = []; try { all = rr.querySelectorAll("*"); } catch (e2) {}
    for (var ai = 0; ai < all.length && ai < 4000; ai++) {
      try { if (all[ai].shadowRoot && roots.indexOf(all[ai].shadowRoot) < 0) roots.push(all[ai].shadowRoot); } catch (e3) {}
    }
  }
  return result;
}
function vocDeepText(node) {
  var text = ""; try { text = norm(node.innerText || node.textContent); } catch (e) {}
  var roots = deepQuery(node, "*", 3000);
  for (var i = 0; i < roots.length; i++) {
    try { if (roots[i].shadowRoot) text = norm(text + " " + (roots[i].shadowRoot.textContent || "")); } catch (e2) {}
  }
  try { if (node.shadowRoot) text = norm(text + " " + (node.shadowRoot.textContent || "")); } catch (e3) {}
  return text;
}
function tableFor(row) {
  var node = row, hops = 0;
  while (node && hops < 12) {
    var tag = tagOf(node), role = "";
    try { role = norm(node.getAttribute("role")).toLowerCase(); } catch (e) {}
    if (tag === "table" || tag === "kat-table" || role === "table" || role === "grid") return node;
    node = parentAcrossShadow(node); hops++;
  }
  return null;
}
function vocHeaderKey(text) {
  var value = norm(text);
  if (/(?:product name.*asin|asin.*product name|\u5546\u54c1\u540d\u79f0.*asin|asin.*\u5546\u54c1\u540d\u79f0)/i.test(value)) return "asin";
  if (/^(?:ncx rate|customer dissatisfaction rate|negative customer experience rate|\u4e70\u5bb6\u4e0d\u6ee1\u610f\u7387)$/i.test(value)) return "ncxRate";
  if (/^(?:ncx orders?|dissatisfied orders?|customer dissatisfaction orders?|\u4e70\u5bb6\u4e0d\u6ee1\u610f\u8ba2\u5355(?:\u6570)?)$/i.test(value)) return "ncxOrders";
  if (/^(?:total orders?|order total|\u8ba2\u5355\u603b\u6570)$/i.test(value)) return "totalOrders";
  if (/^(?:return rate\b|\u9000\u8d27\u7387(?:\s|$))/i.test(value)) return "returnRate";
  if (/(?:top.*(?:negative|ncx).*(?:reason|feedback)|negative customer experience.*feedback|\u9020\u6210\u8d1f\u9762\u4e70\u5bb6\u4f53\u9a8c\u7684(?:\u53cd\u9988|\u4e3b\u8981\u539f\u56e0)|\u4e3b\u8981.*(?:\u9000\u8d27|\u4e0d\u6ee1\u610f).*\u539f\u56e0)/i.test(value)) return "topReason";
  if (/^(?:last updated|last update|\u4e0a\u6b21\u66f4\u65b0(?:\u65f6\u95f4)?)$/i.test(value)) return "updatedAt";
  if (/^(?:cx health|customer experience health|buyer satisfaction status|\u4e70\u5bb6\u6ee1\u610f\u5ea6\u72b6\u51b5)$/i.test(value)) return "cxHealth";
  return null;
}
function buildVocHeaderMap(headers) {
  var map = { asin: -1, ncxRate: -1, ncxOrders: -1, totalOrders: -1, returnRate: -1, topReason: -1, updatedAt: -1, cxHealth: -1 };
  var known = 0;
  for (var i = 0; i < headers.length; i++) {
    var key = vocHeaderKey(headers[i]);
    if (!key) continue;
    if (map[key] >= 0) return null;
    map[key] = i; known++;
  }
  if (map.asin < 0 || known < 3) return null;
  map.missing = [];
  var required = ["ncxRate", "ncxOrders", "totalOrders", "returnRate", "topReason", "updatedAt", "cxHealth"];
  for (var k = 0; k < required.length; k++) if (map[required[k]] < 0) map.missing.push(required[k]);
  map.complete = map.missing.length === 0;
  map.columnCount = headers.length;
  map.labels = headers.slice(0, 30);
  return map;
}
var vocHeaderTables = [], vocHeaderValues = [];
function vocIsCell(node) {
  var tag = tagOf(node), role = "";
  try { role = norm(node.getAttribute("role")).toLowerCase(); } catch (e) {}
  return tag === "td" || tag === "th" || tag === "kat-table-cell" || role === "cell" || role === "columnheader";
}
function vocCellOwnedByRow(row, cell) {
  var node = cell, hops = 0;
  while (node && hops < 12) {
    node = parentAcrossShadow(node); hops++;
    if (node === row) return true;
    if (!node) break;
    var tag = tagOf(node), role = "";
    try { role = norm(node.getAttribute("role")).toLowerCase(); } catch (e) {}
    if (tag === "tr" || tag === "kat-table-row" || role === "row") return false;
    if (vocIsCell(node)) return false;
  }
  return false;
}
function vocOwnedCells(row, selector) {
  var found = deepQuery(row, selector, 120), owned = [];
  for (var i = 0; i < found.length && i < 80; i++) {
    if (vocCellOwnedByRow(row, found[i]) && isVisible(found[i]) && owned.indexOf(found[i]) < 0) owned.push(found[i]);
  }
  return owned;
}
function vocHeaderCells(row) { return vocOwnedCells(row, "th,td,[role=columnheader],[role=cell],kat-table-cell"); }
function vocDataCells(row) { return vocOwnedCells(row, "td,[role=cell],kat-table-cell"); }
function vocCxValue(text) {
  var match = CX_RE.exec(norm(text)); if (!match) return null;
  var value = match[1] || match[0];
  if (/^(?:Very Poor)$/i.test(value) || /\u975e\u5e38\u5dee/.test(value)) return "Very Poor";
  if (/^(?:Poor)$/i.test(value) || /\u6781\u5dee|\u4e0d\u5408\u683c|\u8f83\u5dee/.test(value)) return "Poor";
  if (/^(?:Fair)$/i.test(value) || /\u4e00\u822c/.test(value)) return "Fair";
  if (/^(?:Good)$/i.test(value) || /\u826f\u597d/.test(value)) return "Good";
  if (/^(?:Very Good)$/i.test(value)) return "Very Good";
  if (/^(?:Excellent)$/i.test(value) || /\u4f18\u79c0|\u6781\u597d/.test(value)) return "Excellent";
  return null;
}
function vocSemanticHeader(row, cells, map) {
  if (!row || !isVisible(row)) return false;
  for (var i = 0; i < cells.length; i++) {
    var tag = tagOf(cells[i]), role = "";
    try { role = norm(cells[i].getAttribute("role")).toLowerCase(); } catch (e) {}
    if (tag === "th" || role === "columnheader") return true;
  }
  // Legacy Seller Central tables sometimes render their one complete header
  // row with TD/KAT cells. Accept that shape only when every required label is
  // present; partial ordinary data/legend rows are never promoted to headers.
  return map && map.complete === true;
}
function vocHeaderMap(row) {
  var table = tableFor(row);
  if (!table) return null;
  var cached = vocHeaderTables.indexOf(table);
  if (cached >= 0) return vocHeaderValues[cached];
  var headerRows = deepQuery(table, "tr,[role=row]", 200);
  var katHeaderRows = deepQuery(table, "kat-table-row", 200);
  for (var kr = 0; kr < katHeaderRows.length; kr++) if (headerRows.indexOf(katHeaderRows[kr]) < 0) headerRows.push(katHeaderRows[kr]);
  var candidates = [];
  for (var hr = 0; hr < headerRows.length && hr < 200; hr++) {
    var headerRowText = vocDeepText(headerRows[hr]);
    if (/\bB0[A-Z0-9]{8}\b/i.test(headerRowText)) continue;
    var cells = vocHeaderCells(headerRows[hr]);
    var rowHeaders = [];
    for (var hc = 0; hc < cells.length && hc < 80; hc++) rowHeaders.push(norm(cells[hc].textContent));
    var candidate = buildVocHeaderMap(rowHeaders);
    if (candidate && vocSemanticHeader(headerRows[hr], cells, candidate)) candidates.push(candidate);
  }
  var map = null;
  if (candidates.length === 1) map = candidates[0];
  vocHeaderTables.push(table); vocHeaderValues.push(map);
  return map;
}
function mappedCell(cells, index) { return index >= 0 && index < cells.length ? vocDeepText(cells[index]) : ""; }
function mappedPct(text) { var m = /(\d+(?:\.\d+)?)\s*%/.exec(text); return m ? parseFloat(m[1]) : null; }
function mappedInt(text) {
  var cleaned = norm(text).replace(/[,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  var value = parseInt(cleaned, 10); return isFinite(value) ? value : null;
}
function vocHref(row, asin) {
  var links = [];
  links = deepQuery(row, "a[href]", 80);
  var fallback = "";
  for (var x = 0; x < links.length && x < 80; x++) {
    var h = "", label = "";
    try { h = String(links[x].getAttribute("href") || ""); label = norm(links[x].textContent); } catch (e2) {}
    if (!h || /^javascript:/i.test(h)) continue;
    if (!fallback && h.indexOf(asin) >= 0 && !/(?:\/dp\/|\/gp\/product\/)/i.test(h)) fallback = h;
    if (/voice.?of.?the.?customer|customer.?experience|cx-health|ncx|detail/i.test(h + " " + label)
        && !/(?:\/dp\/|\/gp\/product\/)/i.test(h)) return h;
  }
  return fallback;
}
function absoluteVocHref(href) {
  if (!href) return null;
  try { return String(new URL(href, location.href).href); } catch (e) { return null; }
}
var trs = [];
trs = deepQuery(document, "tr,[role=row]", 500);
var katRows = deepQuery(document, "kat-table-row", 500);
for (var kri = 0; kri < katRows.length && trs.length < 500; kri++) if (trs.indexOf(katRows[kri]) < 0) trs.push(katRows[kri]);
for (var i = 0; i < trs.length && i < 500; i++) {
  var rt = "";
  try { rt = vocDeepText(trs[i]); } catch (e) {}
  if (!rt || rt.length < 8) continue;
  var asin = /\b(B0[A-Z0-9]{8})\b/.exec(rt);
  if (!asin) continue;
  var cx = null;
  var cells = [], cellTexts = [];
  cells = vocDataCells(trs[i]);
  for (var ci = 0; ci < cells.length && ci < 40; ci++) cellTexts.push(norm(cells[ci].textContent));
  var headerMap = vocHeaderMap(trs[i]);
  if (headerMap) {
    var mappedAsins = (mappedCell(cells, headerMap.asin).toUpperCase().match(/\bB0[A-Z0-9]{8}\b/g) || []);
    var mappedAsinSeen = {}, mappedAsinUnique = [];
    for (var mai = 0; mai < mappedAsins.length; mai++) if (!mappedAsinSeen[mappedAsins[mai]]) { mappedAsinSeen[mappedAsins[mai]] = true; mappedAsinUnique.push(mappedAsins[mai]); }
    if (cells.length !== headerMap.columnCount || mappedAsinUnique.length !== 1 || mappedAsinUnique[0] !== asin[1]) {
      if (out.headerMissingColumns.indexOf("rowAlignment") < 0) out.headerMissingColumns.push("rowAlignment");
      if (out.headerDiagnostics.length < 3) {
        var asinCellIndexes = [];
        var cellShape = [];
        for (var di = 0; di < cells.length && di < 40; di++) {
          var dtext = mappedCell(cells, di), dspan = 1, daria = null;
          if (/\bB0[A-Z0-9]{8}\b/i.test(dtext)) asinCellIndexes.push(di);
          try { dspan = parseInt(cells[di].getAttribute("colspan") || cells[di].colSpan || "1", 10) || 1; } catch (de1) {}
          try { daria = cells[di].getAttribute("aria-colindex") || null; } catch (de2) {}
          cellShape.push({ index: di, tag: tagOf(cells[di]), colSpan: dspan, ariaColIndex: daria, hasAsin: /\bB0[A-Z0-9]{8}\b/i.test(dtext) });
        }
        out.headerDiagnostics.push({
          asin: asin[1], headerColumnCount: headerMap.columnCount, dataCellCount: cells.length,
          headerAsinIndex: headerMap.asin, mappedAsins: mappedAsinUnique,
          asinCellIndexes: asinCellIndexes, headerLabels: headerMap.labels || [], cellShape: cellShape
        });
      }
      headerMap = null;
    }
  }
  var ncxRate = headerMap ? mappedPct(mappedCell(cells, headerMap.ncxRate)) : null;
  var returnRate = headerMap ? mappedPct(mappedCell(cells, headerMap.returnRate)) : null;
  var topReasonText = headerMap ? mappedCell(cells, headerMap.topReason) : "";
  var reason = REASON_RE.exec(topReasonText);
  var counts = rt.match(/\b\d{1,6}\b/g) || [];
  var ncxOrders = headerMap ? mappedInt(mappedCell(cells, headerMap.ncxOrders)) : null;
  var totalOrders = headerMap ? mappedInt(mappedCell(cells, headerMap.totalOrders)) : null;
  var updatedAt = headerMap ? (mappedCell(cells, headerMap.updatedAt) || null) : null;
  var mappedCx = headerMap ? vocCxValue(mappedCell(cells, headerMap.cxHealth)) : null;
  if (headerMap) cx = mappedCx;
  if (headerMap) {
    out.headerMappedRowCount++;
    if (headerMap.complete && mappedCx) out.headerMappingCompleteRowCount++;
    else if (headerMap.complete && !mappedCx && out.headerMissingColumns.indexOf("cxHealthValue") < 0) out.headerMissingColumns.push("cxHealthValue");
    for (var hm = 0; hm < headerMap.missing.length; hm++) if (out.headerMissingColumns.indexOf(headerMap.missing[hm]) < 0) out.headerMissingColumns.push(headerMap.missing[hm]);
  }
  var detailHref = absoluteVocHref(vocHref(trs[i], asin[1]));
  var row = {
    asin: asin[1],
    cxHealth: cx || null,
    ncxRatePct: ncxRate,
    ncxOrders: ncxOrders,
    totalOrders: totalOrders,
    returnRatePct: returnRate,
    topNcxReason: reason ? reason[1] : null,
    updatedAt: updatedAt,
    detailUrl: detailHref,
    numbers: counts.slice(0, 8),
    raw: rt.slice(0, 300)
  };
  out.rows.push(row);
  if (cx && /poor/i.test(cx)) { out.poorCount++; out.poorAsins = out.poorAsins || []; out.poorAsins.push(asin[1]); }
  if (out.rows.length >= 200) break;
}
// Current Seller Central may render the VOC grid with nested custom elements
// instead of tr/role=row. Fall back to visible ASIN text nodes and walk upward
// to the smallest useful record container.
if (out.rows.length === 0) {
  var anodes = textNodesMatching(/\bB0[A-Z0-9]{8}\b/i, 200);
  var seenAsin = {};
  for (var a = 0; a < anodes.length && out.rows.length < 200; a++) {
    var at = norm(anodes[a].nodeValue);
    var am = /\b(B0[A-Z0-9]{8})\b/.exec(at);
    if (!am || seenAsin[am[1]]) continue;
    var ae = anodes[a].parentElement, hops = 0, best = at;
    while (ae && hops < 12) {
      var et = ""; try { et = norm(ae.textContent); } catch (e2) {}
      if (et.indexOf(am[1]) >= 0 && et.length <= 900) best = et;
      if (et.length > 900) break;
      ae = ae.parentElement; hops++;
    }
    var acx = vocCxValue(best);
    var acounts = best.match(/\b\d{1,6}\b/g) || [];
    var adetail = absoluteVocHref(vocHref(anodes[a].parentElement || ae, am[1]));
    out.rows.push({
      asin: am[1], cxHealth: acx || null,
      ncxRatePct: null,
      ncxOrders: null, totalOrders: null, returnRatePct: null,
      topNcxReason: null,
      updatedAt: null, detailUrl: adetail,
      numbers: acounts.slice(0, 8), raw: best.slice(0, 300)
    });
    if (acx && /poor/i.test(acx)) { out.poorCount++; out.poorAsins = out.poorAsins || []; out.poorAsins.push(am[1]); }
    seenAsin[am[1]] = true;
  }
}
out.zeroResults = /\b0\s+(?:offer )?listings|\b0\s*results|\u6682\u65e0\u5546\u54c1|\b0\s*\u6761\u7ed3\u679c/i.test(BT);
if (out.landed && out.rows.length === 0) {
  out.notes.push("landed on VOC but no ASIN rows parsed; the page may be a summary view");
}
`);

/** Read-only VOC ASIN detail page. The runner visits only hrefs discovered in
 * the VOC list or an exact View-details control. The expected ASIN is used only
 * to select evidence that is actually present in a visible detail root/URL; it
 * is never copied into the result as invented evidence. */
const VOC_DETAIL_BODY = String.raw`
var EXPECTED_ASIN = __EXPECTED_ASIN__;
out.asin = null; out.asins = []; out.cxHealth = null; out.ncxRatePct = null; out.returnRatePct = null;
out.returnReasons = []; out.customerIssues = []; out.records = []; out.abnormalTrend = false;
out.asinBound = false; out.detailRootMatched = false; out.expectedAsinObserved = false;
out.diagnostics = { visibleDialogCount: 0, visibleDrawerCount: 0, detailAsinCount: 0, surfaceType: null, urlAsinObserved: false };
var DETAIL_RE = /return reason|customer issue|customer problem|customer feedback|ncx details?|return details?|\u9000\u8d27\u539f\u56e0|\u5ba2\u6237\u95ee\u9898|\u4e70\u5bb6\u53cd\u9988|\u76f8\u5173\u8bb0\u5f55/i;
function uniqueAsins(text) {
  var found = String(text || "").toUpperCase().match(/\bB0[A-Z0-9]{8}\b/g) || [], seen = {}, result = [];
  for (var i = 0; i < found.length && result.length < 300; i++) if (!seen[found[i]]) { seen[found[i]] = true; result.push(found[i]); }
  return result;
}
function deepText(el) {
  var text = "";
  try { text = norm(el.innerText || el.textContent); } catch (e) {}
  var nodes = [];
  try { nodes = el.querySelectorAll("*"); } catch (e2) {}
  for (var i = 0; i < nodes.length && i < 2500; i++) {
    try { if (nodes[i].shadowRoot) text = norm(text + " " + (nodes[i].shadowRoot.textContent || "")); } catch (e3) {}
  }
  try { if (el.shadowRoot) text = norm(text + " " + (el.shadowRoot.textContent || "")); } catch (e4) {}
  return text;
}
var roots = [document], seenRoots = [];
for (var ri = 0; ri < roots.length && ri < 80; ri++) {
  var rr = roots[ri]; if (seenRoots.indexOf(rr) >= 0) continue; seenRoots.push(rr);
  var rootNodes = []; try { rootNodes = rr.querySelectorAll("*"); } catch (er1) {}
  for (var rn = 0; rn < rootNodes.length && rn < 2500; rn++) {
    try { if (rootNodes[rn].shadowRoot && roots.indexOf(rootNodes[rn].shadowRoot) < 0) roots.push(rootNodes[rn].shadowRoot); } catch (er2) {}
  }
}
var surfaces = [], seenSurfaces = [];
function addSurfaces(selector, type) {
  for (var r = 0; r < roots.length; r++) {
    var nodes = []; try { nodes = roots[r].querySelectorAll(selector); } catch (e) {}
    for (var i = 0; i < nodes.length && i < 500; i++) {
      if (seenSurfaces.indexOf(nodes[i]) >= 0 || !isVisible(nodes[i])) continue;
      seenSurfaces.push(nodes[i]);
      var text = deepText(nodes[i]);
      surfaces.push({ el: nodes[i], type: type, text: text, asins: uniqueAsins(text) });
      if (type === "dialog") out.diagnostics.visibleDialogCount++;
      if (type === "drawer") out.diagnostics.visibleDrawerCount++;
    }
  }
}
addSurfaces("[role=dialog],[aria-modal=true],kat-modal,[data-testid*=modal]", "dialog");
addSurfaces("[role=complementary],kat-drawer,[data-testid*=drawer]", "drawer");
addSurfaces("[data-testid*=detail],[id*=detail],[class*=detail],tr,[role=row],kat-table-row", "inline");
addSurfaces("main,[role=main]", "main");
if (document.body && seenSurfaces.indexOf(document.body) < 0) surfaces.push({ el: document.body, type: "main", text: deepText(document.body), asins: uniqueAsins(deepText(document.body)) });
var urlHasExpected = false;
if (EXPECTED_ASIN) {
  try { urlHasExpected = new RegExp("(?:^|[^A-Z0-9])" + EXPECTED_ASIN + "(?:[^A-Z0-9]|$)").test(decodeURIComponent(String(location.href || "")).toUpperCase()); } catch (eu) {}
}
out.diagnostics.urlAsinObserved = urlHasExpected;
var chosen = null;
for (var si = 0; si < surfaces.length; si++) {
  var surface = surfaces[si];
  if (!DETAIL_RE.test(surface.text)) continue;
  var rootHasExactExpected = EXPECTED_ASIN && surface.asins.length === 1 && surface.asins[0] === EXPECTED_ASIN;
  var urlOnlyExpected = urlHasExpected && surface.asins.length === 0;
  var fullPageBound = surface.type === "main" && (urlOnlyExpected || rootHasExactExpected);
  if (EXPECTED_ASIN ? (rootHasExactExpected && surface.type !== "main") || fullPageBound : surface.asins.length === 1) { chosen = surface; break; }
}
var DT = chosen ? chosen.text : "";
out.asins = chosen ? chosen.asins : [];
var chosenExactExpected = !!chosen && !!EXPECTED_ASIN && chosen.asins.length === 1 && chosen.asins[0] === EXPECTED_ASIN;
var chosenUrlOnlyExpected = !!chosen && !!EXPECTED_ASIN && urlHasExpected && chosen.asins.length === 0;
out.asin = chosen && EXPECTED_ASIN && (chosenExactExpected || chosenUrlOnlyExpected) ? EXPECTED_ASIN : (chosen && chosen.asins[0] ? chosen.asins[0] : null);
out.expectedAsinObserved = chosenExactExpected || chosenUrlOnlyExpected;
out.asinBound = !!out.asin && (!EXPECTED_ASIN || out.expectedAsinObserved);
out.detailRootMatched = !!chosen;
out.diagnostics.detailAsinCount = out.asins.length;
out.diagnostics.surfaceType = chosen ? chosen.type : null;
out.landed = out.detailRootMatched && out.asinBound && DETAIL_RE.test(DT);
var cx = /(?:CX Health|\u5ba2\u6237\u4f53\u9a8c\u72b6\u51b5|\u4e70\u5bb6\u6ee1\u610f\u5ea6\u72b6\u51b5)\s*[:\uff1a]?\s*(Very Poor|Poor|Fair|Good|Very Good|Excellent|\u6781\u5dee|\u4e0d\u5408\u683c|\u975e\u5e38\u5dee|\u8f83\u5dee|\u4e00\u822c|\u826f\u597d|\u4f18\u79c0|\u6781\u597d)/i.exec(DT);
if (cx) {
  var cxv = cx[1];
  if (/^(?:Very Poor)$/i.test(cxv) || /\u975e\u5e38\u5dee/.test(cxv)) out.cxHealth = "Very Poor";
  else if (/^(?:Poor)$/i.test(cxv) || /\u6781\u5dee|\u4e0d\u5408\u683c|\u8f83\u5dee/.test(cxv)) out.cxHealth = "Poor";
  else if (/^(?:Fair)$/i.test(cxv) || /\u4e00\u822c/.test(cxv)) out.cxHealth = "Fair";
  else if (/^(?:Good)$/i.test(cxv) || /\u826f\u597d/.test(cxv)) out.cxHealth = "Good";
  else if (/^(?:Very Good)$/i.test(cxv)) out.cxHealth = "Very Good";
  else if (/^(?:Excellent)$/i.test(cxv) || /\u4f18\u79c0|\u6781\u597d/.test(cxv)) out.cxHealth = "Excellent";
}
var nr = /(?:NCX rate|\u4e70\u5bb6\u4e0d\u6ee1\u610f\u7387)\s*[:\uff1a]?\s*(\d+(?:\.\d+)?)\s*%/i.exec(DT);
if (nr) out.ncxRatePct = parseFloat(nr[1]);
var rr = /(?:return rate|\u9000\u8d27\u7387)\s*[:\uff1a]?\s*(\d+(?:\.\d+)?)\s*%/i.exec(DT);
if (rr) out.returnRatePct = parseFloat(rr[1]);
var REASON_RE = /(defective item|damaged item|wrong item(?: was sent)?|performance or quality not adequate|not as described|missing (?:parts?|components?)|inaccurate website description|arrived (?:late|damaged)|unwanted item|\u5546\u54c1\u6709\u7f3a\u9677|\u5546\u54c1\u5b58\u5728\u7455\u75b5|\u5546\u54c1\u635f\u574f|\u9519\u53d1\u5546\u54c1|\u6027\u80fd\u6216\u8d28\u91cf\u4e0d\u4f73|\u6027\u80fd\u6216\u54c1\u8d28\u4e0d\u7406\u60f3|\u63cf\u8ff0\u4e0d\u7b26|\u7f3a\u5c11\u90e8\u4ef6)/i;
var seenReasons = {};
var containers = [];
try { containers = chosen ? chosen.el.querySelectorAll("tr,[role=row],[data-testid*=return],[data-testid*=issue]") : []; } catch (e2) {}
for (var i = 0; i < containers.length && i < 1000; i++) {
  var ct = ""; try { ct = norm(containers[i].textContent); } catch (e3) {}
  if (!ct || ct.length < 3) continue;
  var reason = REASON_RE.exec(ct);
  var issue = /(?:customer issue|customer problem|buyer comment|customer feedback|\u4e70\u5bb6\u95ee\u9898|\u5ba2\u6237\u95ee\u9898|\u4e70\u5bb6\u53cd\u9988)\s*[:\uff1a]?\s*(.{3,240})/i.exec(ct);
  if (reason && !seenReasons[String(reason[1]).toLowerCase()]) {
    out.returnReasons.push(reason[1]); seenReasons[String(reason[1]).toLowerCase()] = true;
  }
  if (issue && out.customerIssues.length < 100) out.customerIssues.push(issue[1].slice(0, 240));
  if ((reason || issue) && out.records.length < 200) {
    var dt = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i.exec(ct);
    if (!dt) dt = /\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b/.exec(ct);
    var id = /(?:order|return|record)\s*(?:id|number|#)?\s*[:#]?\s*([A-Z0-9-]{8,30})/i.exec(ct);
    out.records.push({
      reason: reason ? reason[1] : null, customerIssue: issue ? issue[1].slice(0, 240) : null,
      date: dt ? dt[0] : null, identifier: id ? id[1] : null,
      summary: ct.slice(0, 500), source: "dom-row"
    });
  }
}
// Custom-element layouts may expose only text. Preserve all distinct reasons.
var tre = new RegExp(REASON_RE.source, "gi"), tm;
while ((tm = tre.exec(DT)) !== null && out.returnReasons.length < 100) {
  var key = String(tm[1]).toLowerCase();
  if (!seenReasons[key]) { out.returnReasons.push(tm[1]); seenReasons[key] = true; }
}
out.abnormalTrend = /(?:return|ncx).{0,50}(?:increas|spike|higher than|worsen)|(?:\u9000\u8d27|\u4e0d\u6ee1\u610f).{0,40}(?:\u4e0a\u5347|\u6fc0\u589e|\u5f02\u5e38|\u6076\u5316)/i.test(DT);
if (out.landed && out.returnReasons.length === 0 && out.customerIssues.length === 0) {
  out.notes.push("VOC detail opened but no return reason or customer issue was parsed");
}
`;

export function vocDetailExtractor(asin) {
  var target = /^B0[A-Z0-9]{8}$/.test(String(asin || '').toUpperCase()) ? String(asin).toUpperCase() : '';
  return wrap('voc-detail/v1', VOC_DETAIL_BODY.replace('__EXPECTED_ASIN__', JSON.stringify(target)));
}

export const VOC_DETAIL_EXTRACTOR = vocDetailExtractor('');

// ------------------------------------------------------ 8. advertising status
// Seller Central's campaign-manager URL contains an account-specific entity
// context. Discover the signed-in navigation link instead of guessing a stale
// path. The Chinese label is encoded so the argv-injected script stays ASCII.
export const ADS_LINK_EXTRACTOR = wrap('ads-link/v1', String.raw`
out.href = "";
var nav = allEls(document.body, 6000);
for (var li = 0; li < nav.length; li++) {
  if (tagOf(nav[li]) !== "a") continue;
  var lt = norm(nav[li].textContent);
  var lh = "";
  try { lh = String(nav[li].getAttribute("href") || ""); } catch (e) {}
  if (!lh) continue;
  if (/campaign manager|advertising campaigns|\u5e7f\u544a\u6d3b\u52a8\u7ba1\u7406/i.test(lt) || /advertising\.amazon\.|\/advertising\//i.test(lh)) {
    if (/^https?:\/\//i.test(lh)) out.href = lh;
    else if (/^\/\//.test(lh)) out.href = String(location.protocol || "https:") + lh;
    else if (/^\//.test(lh)) out.href = String(location.protocol || "https:") + "//" + String(location.host || "") + lh;
    else out.href = lh;
    break;
  }
}
out.landed = !!out.href;
`);

/**
 * Campaign manager: count enabled vs paused campaigns. The requirement is a
 * configured per-store name scope ("all off" by 11:20, "all on" by 18:30),
 * so only counts inside that pre-verified scope matter.
 */
export const ADS_EXTRACTOR = wrap('ads/v1', String.raw`
var ADS_HOST = false;
try { ADS_HOST = String(location.hostname || "").toLowerCase() === "advertising.amazon.com"; } catch (e) {}
out.landed = ADS_HOST && /campaign|sponsored products|advertising|ad group|impressions|\u5e7f\u544a\u6d3b\u52a8|\u6d3b\u52a8\u7ba1\u7406|\u5e7f\u544a\u7ec4|\u5c55\u793a\u91cf/i.test(BT);
out.enabled = 0; out.paused = 0; out.archived = 0; out.totalRows = 0;
out.campaigns = []; out.stateSource = null; out.emptyEnabledFilter = false; out.emptyPausedFilter = false;
out.filterVerified = false;
var filterChipText = "", filterChip = null;
function adsDeepElements(root, cap) {
  var roots = [root || document], seenRoots = [], result = [];
  for (var ri = 0; ri < roots.length && ri < 120 && result.length < (cap || 8000); ri++) {
    var rr = roots[ri];
    if (!rr || seenRoots.indexOf(rr) >= 0) continue;
    seenRoots.push(rr);
    var nodes = [];
    try {
      if (rr === document && document.body) nodes = document.body.querySelectorAll("*");
      else nodes = rr.querySelectorAll("*");
    } catch (ignore) {}
    for (var ai = 0; ai < nodes.length && result.length < (cap || 8000); ai++) {
      var node = nodes[ai];
      if (result.indexOf(node) < 0) result.push(node);
      try { if (node.shadowRoot && roots.indexOf(node.shadowRoot) < 0) roots.push(node.shadowRoot); } catch (ignore2) {}
    }
  }
  return result;
}
function adsComposedParent(el) {
  try {
    if (el.parentElement) return el.parentElement;
    var root = el.getRootNode ? el.getRootNode() : null;
    return root && root.host ? root.host : null;
  } catch (ignore) { return null; }
}
function adsOutsideCampaignRow(el) {
  var p = el, hops = 0;
  while (p && hops < 24) {
    var tag = tagOf(p), role = "";
    try { role = String(p.getAttribute("role") || "").toLowerCase(); } catch (ignore) {}
    if (tag === "tr" || tag === "kat-table-row" || role === "row") return false;
    p = adsComposedParent(p); hops++;
  }
  return true;
}
function adsDeepText(el) {
  var parts = [], nodes = adsDeepElements(el, 3000);
  try { parts.push(el.innerText || el.textContent || ""); } catch (ignore) {}
  for (var di = 0; di < nodes.length; di++) {
    var leaf = nodes[di];
    try {
      if ((!leaf.children || leaf.children.length === 0) && norm(leaf.textContent)) parts.push(leaf.textContent);
    } catch (ignore2) {}
  }
  return norm(parts.join(" "));
}
var adsAll = adsDeepElements(document, 10000);
try {
  filterChip = document.getElementById("globalBetaAllCampaigns:filterTag-state");
  var filterChipButton = filterChip && filterChip.querySelector("button");
  if (filterChipButton && isVisible(filterChipButton)) {
    filterChipText = norm(filterChipButton.innerText || filterChipButton.textContent || filterChipButton.getAttribute("title"));
    out.filterVerified = true;
  }
} catch (e0) {}
if (!out.filterVerified) {
  var semanticFilters = [];
  for (var fi = 0; fi < adsAll.length && fi < 10000; fi++) {
    var fc = adsAll[fi], ft = "", ftag = tagOf(fc), frole = "";
    try {
      frole = String(fc.getAttribute("role") || "").toLowerCase();
      ft = norm(fc.innerText || fc.textContent || fc.getAttribute("aria-label") || fc.getAttribute("label"));
    } catch (ignore3) {}
    var interactive = /^(button|kat-button|select|kat-select|kat-dropdown)$/.test(ftag) || /^(button|combobox)$/.test(frole);
    if (!interactive || !isVisible(fc) || !adsOutsideCampaignRow(fc)) continue;
    if (/^(?:Status|State|Active|Campaign status|Delivery status|\u72b6\u6001|\u8fdb\u884c\u4e2d|\u5e7f\u544a\u6d3b\u52a8\u72b6\u6001|\u6295\u653e\u72b6\u6001|\u8fd0\u884c\u72b6\u6001)\s*[:\uff1a]\s*(?:Enabled|Paused|\u5df2\u542f\u7528|\u5df2\u6682\u505c)$/i.test(ft)) {
      if (semanticFilters.indexOf(ft) < 0) semanticFilters.push(ft);
    }
  }
  if (semanticFilters.length === 1) {
    filterChipText = semanticFilters[0];
    out.filterVerified = true;
  }
}
out.enabledFilter = out.filterVerified
  ? /(?:^|[:\uff1a]\s*)(?:\u5df2\u542f\u7528|Enabled)$/i.test(filterChipText)
  : /\u8fdb\u884c\u4e2d\s*[:\uff1a]\s*\u5df2\u542f\u7528|status\s*[:\uff1a]\s*enabled/i.test(BT);
out.pausedFilter = out.filterVerified
  ? /(?:^|[:\uff1a]\s*)(?:\u5df2\u6682\u505c|Paused)$/i.test(filterChipText)
  : /\u8fdb\u884c\u4e2d\s*[:\uff1a]\s*\u5df2\u6682\u505c|status\s*[:\uff1a]\s*paused/i.test(BT);
out.filterKind = out.enabledFilter ? "ENABLED" : out.pausedFilter ? "PAUSED" : null;
out.reportedTotal = null; out.hasNextPage = false; out.paginationComplete = false;

var ON_RE = /^(enabled|delivering|active|running|\u8fdb\u884c\u4e2d|\u6295\u653e\u4e2d|\u5df2\u542f\u7528)$/i;
var OFF_RE = /^(paused|inactive|disabled|\u5df2\u6682\u505c|\u6682\u505c\u6295\u653e|\u5df2\u5173\u95ed)$/i;
var ARCH_RE = /^(archived|\u5df2\u5f52\u6863)$/i;

function record(name, state) {
  if (out.campaigns.length < 80) out.campaigns.push({ name: String(name || "").slice(0, 120), state: state });
}

// Pass 1: toggle / status controls inside campaign rows.
var trs = [], seenRows = {}, campaignNames = {};
for (var tri = 0; tri < adsAll.length && tri < 10000; tri++) {
  var trTag = tagOf(adsAll[tri]), trRole = "";
  try { trRole = String(adsAll[tri].getAttribute("role") || "").toLowerCase(); } catch (ignore4) {}
  if (trTag === "tr" || trTag === "kat-table-row" || trRole === "row") trs.push(adsAll[tri]);
}
// The live AG Grid renders each campaign as separate pinned-name and center-
// status rows with the same row-id. Their status/date text can be identical
// across many different campaigns; text is not a campaign identity.
for (var nri = 0; nri < trs.length && nri < 1200; nri++) {
  var nameRowId = trs[nri].getAttribute("row-id");
  if (!nameRowId) continue;
  var nameCells = adsDeepElements(trs[nri], 500);
  for (var nci = 0; nci < nameCells.length; nci++) {
    if (nameCells[nci].getAttribute("col-id") === "name") {
      campaignNames["id:" + nameRowId] = norm(nameCells[nci].innerText || nameCells[nci].textContent);
      break;
    }
  }
}
function adsStateControl(el, row) {
  var p = el, hops = 0;
  while (p && p !== row && hops++ < 20) {
    var column = p.getAttribute && p.getAttribute("col-id");
    if (column === "ag-Grid-SelectionColumn") return false;
    p = adsComposedParent(p);
  }
  return true;
}
for (var i = 0; i < trs.length && i < 1200; i++) {
  var row = trs[i];
  var rt = "";
  try { rt = adsDeepText(row); } catch (e) {}
  if (!rt || rt.length < 4) continue;
  // Never count the table header's current-filter/status label as a campaign.
  if (/\u5e7f\u544a\u6d3b\u52a8\u540d\u79f0.*(?:\u56fd\u5bb6|\u5730\u533a).*\u72b6\u6001|campaign name.*country.*status|\u5168\u9009.*\u5e7f\u544a\u6d3b\u52a8\u540d\u79f0|select all.*campaign name/i.test(rt)) continue;
  var state = null;

  // aria-checked on a switch is the most reliable signal when present.
  var sw = null, rowNodes = adsDeepElements(row, 500);
  for (var si = 0; si < rowNodes.length && si < 500; si++) {
    var sr = "", st = tagOf(rowNodes[si]), sty = "";
    try { sr = String(rowNodes[si].getAttribute("role") || "").toLowerCase(); sty = String(rowNodes[si].getAttribute("type") || "").toLowerCase(); } catch (ignore5) {}
    if (adsStateControl(rowNodes[si], row) && (sr === "switch" || rowNodes[si].getAttribute && rowNodes[si].getAttribute("aria-checked") !== null || (st === "input" && sty === "checkbox"))) { sw = rowNodes[si]; break; }
  }
  if (sw) {
    var ac = null;
    var al = "";
    try { ac = sw.getAttribute("aria-checked"); } catch (e) {}
    try { al = norm(sw.getAttribute("aria-label")); } catch (e0) {}
    if (ac === "true") state = "ENABLED";
    else if (ac === "false") state = "PAUSED";
    else if (ON_RE.test(al)) state = "ENABLED";
    else if (OFF_RE.test(al)) state = "PAUSED";
    if (state) out.stateSource = out.stateSource || (ac === "true" || ac === "false" ? "aria-checked" : "aria-label");
  }

  if (!state) {
    var cells = rowNodes;
    for (var c = 0; c < cells.length && c < 60; c++) {
      var ct = leafText(cells[c]);
      if (!ct) continue;
      if (ON_RE.test(ct)) { state = "ENABLED"; break; }
      if (OFF_RE.test(ct)) { state = "PAUSED"; break; }
      if (ARCH_RE.test(ct)) { state = "ARCHIVED"; break; }
    }
    if (state) out.stateSource = out.stateSource || "cell-text";
  }
  if (!state) continue;

  var rowId = row.getAttribute("row-id");
  var rowKey = (rowId ? "id:" + rowId : "text:" + rt.slice(0, 240)) + "|" + state;
  if (seenRows[rowKey]) continue;
  seenRows[rowKey] = true;

  out.totalRows++;
  if (state === "ENABLED") out.enabled++;
  else if (state === "PAUSED") out.paused++;
  else out.archived++;
  record((rowId && campaignNames["id:" + rowId]) || rt.slice(0, 100), state);
}

// Pass 2: the 2026 console omits the total footer for an empty filtered table.
// Bind the empty marker to the campaign table tail and require the exact
// WebDriver-verified filter chip; a generic dashboard card saying "no data"
// must never prove that the campaign result set is empty.
var campaignTableStart = BT.search(/\u5e7f\u544a\u6d3b\u52a8\u540d\u79f0\s+\u56fd\u5bb6\s*\/\s*\u5730\u533a\s+\u72b6\u6001|campaign name\s+country\s+status/i);
var campaignTableTail = campaignTableStart >= 0 ? BT.slice(campaignTableStart) : "";
var verifiedEmptyCampaignTable = out.filterVerified && campaignTableStart >= 0
  && /\u65e0\u53ef\u7528\u6570\u636e|no data available/i.test(campaignTableTail);
if (out.totalRows === 0 && out.landed && verifiedEmptyCampaignTable && out.enabledFilter) {
  out.stateSource = "empty-enabled-filter";
  out.emptyEnabledFilter = true;
}
if (out.totalRows === 0 && out.landed && verifiedEmptyCampaignTable && out.pausedFilter) {
  out.stateSource = "empty-paused-filter";
  out.emptyPausedFilter = true;
}
if (out.totalRows === 0 && out.landed && !out.emptyEnabledFilter && !out.emptyPausedFilter) {
  var en = BT.match(/\benabled\b|\u8fdb\u884c\u4e2d/gi), pa = BT.match(/\bpaused\b|\u5df2\u6682\u505c|\u6682\u505c\u6295\u653e/gi);
  out.enabled = en ? en.length : 0;
  out.paused = pa ? pa.length : 0;
  out.totalRows = out.enabled + out.paused;
  out.stateSource = out.totalRows ? "pagetext-count" : null;
  out.notes.push("no campaign rows parsed; fell back to counting status words (low precision)");
}
out.activeTotal = out.enabled + out.paused;
// Totals above the campaign table belong to account analytics/recommendation
// cards. Only the footer inside the already anchored campaign-table tail can
// describe the name + state filtered result set.
var totalMatch = /\bTotal:\s*(\d+)\b/i.exec(campaignTableTail) || /\u603b\u8ba1\s*[:\uff1a]\s*(\d+)/.exec(campaignTableTail) || /\u5171\s*(\d+)\s*\u6761\u7ed3\u679c/.exec(campaignTableTail);
if (totalMatch) out.reportedTotal = parseInt(totalMatch[1], 10);
else if (out.emptyEnabledFilter || out.emptyPausedFilter) out.reportedTotal = 0;
// A verified status-filter chip plus its result total is a structural DOM
// existence proof even when the virtualized table exposes no ordinary rows.
// It is intentionally limited to the two exact read-only filter values.
if ((out.totalRows === 0 || out.stateSource === "pagetext-count") && out.filterVerified && out.reportedTotal !== null && out.reportedTotal > 0) {
  if (out.filterKind === "ENABLED") out.enabled = out.reportedTotal;
  else if (out.filterKind === "PAUSED") out.paused = out.reportedTotal;
  if (out.filterKind === "ENABLED" || out.filterKind === "PAUSED") {
    out.totalRows = out.reportedTotal;
    out.activeTotal = out.enabled + out.paused;
    out.stateSource = "filter-total";
  }
}
var nextControls = [];
try { nextControls = document.querySelectorAll("button,a,[role=button]"); } catch (e4) {}
for (var ni = 0; ni < nextControls.length && ni < 1000; ni++) {
  var nt = norm(nextControls[ni].textContent), nal = "", disabled = false;
  try {
    nal = norm(nextControls[ni].getAttribute("aria-label"));
    disabled = nextControls[ni].hasAttribute("disabled") || nextControls[ni].getAttribute("aria-disabled") === "true";
  } catch (e5) {}
  if (/^(next|\u4e0b\u4e00\u9875)$/i.test(nt) || /next page|\u4e0b\u4e00\u9875/i.test(nal)) {
    if (!disabled && isVisible(nextControls[ni])) out.hasNextPage = true;
  }
}
out.paginationComplete = out.emptyEnabledFilter || out.emptyPausedFilter || (out.reportedTotal !== null && out.reportedTotal === out.activeTotal && !out.hasNextPage);
`);

// ------------------------------------------------------ 9. Inbox 买家消息
/**
 * Discover the Buyer-Seller Messaging entry from Seller Central, the same way
 * the ads check discovers Campaign Manager. A cold deep link to
 * /messaging/inbox leaves the messaging app unmounted (only the surrounding
 * navigation renders), so the runner bootstraps through Seller Central and
 * follows this link instead.
 */
export const INBOX_LINK_EXTRACTOR = wrap('inbox-link/v1', String.raw`
out.href = "";
var nav = allEls(document.body, 6000);
for (var li = 0; li < nav.length; li++) {
  if (tagOf(nav[li]) !== "a") continue;
  var lt = norm(nav[li].textContent);
  var lh = "";
  try { lh = String(nav[li].getAttribute("href") || ""); } catch (e) {}
  if (!lh) continue;
  if (/buyer[\s-]*seller messag|message center|^inbox$|\u4e70\u5bb6\u4e0e\u5356\u5bb6\u6d88\u606f|\u4e70\u5bb6\u6d88\u606f|\u6d88\u606f\u4e2d\u5fc3|\u6536\u4ef6\u7bb1/i.test(lt)
    || /\/messaging(?:\/|\?|$)|communication-manager/i.test(lh)) {
    if (/^https?:\/\//i.test(lh)) out.href = lh;
    else if (/^\/\//.test(lh)) out.href = String(location.protocol || "https:") + lh;
    else if (/^\//.test(lh)) out.href = String(location.protocol || "https:") + "//" + String(location.host || "") + lh;
    else out.href = lh;
    break;
  }
}
out.landed = !!out.href;
`);

/**
 * Buyer-Seller Messaging inbox: does this store have unread / awaiting-reply
 * buyer messages?
 *
 * Strictly list-only. Opening a message thread would mark it read on Amazon —
 * a state change — so this extractor never clicks anything and only reads the
 * inbox listing.
 *
 * `unreadCount` stays null unless the page actually exposes read-state
 * vocabulary (an "Unread" marker/filter, or an explicit awaiting-response
 * label). Deriving "0 unread" from the mere absence of a marker we have never
 * seen would manufacture a green verdict, so absence is reported as "cannot
 * tell" and the Node-side judge escalates it.
 *
 * Privacy: rows contribute only a date, the read/response flags and a visible
 * order id. Buyer names, subjects and message bodies are never collected.
 */
export const INBOX_EXTRACTOR = wrap('inbox/v1', String.raw`
out.landed = /buyer[\s-]*seller messag|message center|messages|inbox|\u4e70\u5bb6\u6d88\u606f|\u5356\u5bb6\u6d88\u606f|\u6d88\u606f\u4e2d\u5fc3|\u6536\u4ef6\u7bb1/i.test(BT);
// Amazon's own "needs reply" filter (fi=responseNeeded on messaging v3). In that
// view every listed row is a buyer message awaiting a reply, so rows are the
// signal and read-state markers are not required. Read from the live URL only.
out.responseNeededFilter = false;
try { out.responseNeededFilter = /[?&]fi=responseneeded\b/i.test(String(location.href || "")); } catch (efi) {}
try { out.messagingV3 = /\/messaging\/inbox-v3\b/i.test(String(location.href || "")); } catch (ev3) { out.messagingV3 = false; }
out.unreadCount = null; out.unreadRows = []; out.totalRows = 0; out.datedRows = 0;
out.needsResponseCount = 0; out.boldRowCount = 0; out.markerVocabulary = false;
out.badgeCount = null; out.declaredUnread = null; out.emptyState = false; out.loading = false;
out.hasNextPage = false; out.pageRange = null; out.paginationComplete = false;

var UNREAD_RE = /(?:^|[^a-z])unread(?:[^a-z]|$)|\u672a\u8bfb/i;
var READ_STATE_RE = /(?:^|[^a-z])(?:unread|mark as read|mark as unread)(?:[^a-z]|$)|\u672a\u8bfb|\u5df2\u8bfb|\u6807\u4e3a\u5df2\u8bfb/i;
var NEEDS_RESPONSE_RE = /needs? (?:a )?(?:response|reply)|awaiting (?:your )?(?:response|reply)|response required|reply needed|\u5f85\u56de\u590d|\u9700\u8981\u56de\u590d|\u672a\u56de\u590d/i;
var ROW_DATE_RE = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b|\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b|\b\d{1,2}[-\/]\d{1,2}[-\/]\d{4}\b|\d{4}\s*\u5e74\s*\d{1,2}\s*\u6708\s*\d{1,2}\s*\u65e5/;
var ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b/;
var EMPTY_RE = /no (?:new |unread )?messages|you have no messages|there are no messages|no messages (?:that )?(?:need|needing|require)s? a? ?(?:response|reply)|inbox is empty|0 messages|\u6ca1\u6709\u9700\u8981\u56de\u590d\u7684\u6d88\u606f|\u6ca1\u6709\u5f85\u56de\u590d\u7684\u6d88\u606f|\u6682\u65e0\u6d88\u606f|\u6ca1\u6709\u6d88\u606f|\u6536\u4ef6\u7bb1\u4e3a\u7a7a|\u65e0\u6d88\u606f/i;
var HEADER_RE = /(?:from[\s\S]{0,160}subject|subject[\s\S]{0,160}(?:date|received)|most recent message|\u53d1\u4ef6\u4eba[\s\S]{0,160}\u4e3b\u9898|\u4e3b\u9898[\s\S]{0,160}\u65e5\u671f|\u6700\u8fd1\u6d88\u606f)/i;
var PENDING_DECLARED_RE = /(?:\u9700\u8981\u56de\u590d|\u5f85\u56de\u590d|response needed|responses? needed|needs response)\s*[:\uff1a(\uff08]?\s*(\d{1,4})(?!\s*(?:%|\u5929|days?))/i;
var METRICS_CONTEXT_RE = /\u6307\u6807|metrics|\u5168\u7403\u901a\u4fe1|global communication/i;

function inboxMeta(el) {
  var names = ["class", "id", "data-testid", "data-test", "role", "aria-label", "title"], meta = "", mi, mv;
  for (mi = 0; mi < names.length; mi++) {
    mv = null;
    try { mv = el.getAttribute(names[mi]); } catch (e) {}
    if (mv) meta += " " + mv;
  }
  return norm(meta);
}
function inboxRowLike(el, meta) {
  var tag = tagOf(el);
  if (tag === "tr" || tag === "kat-table-row") return true;
  if (/(?:^|\s)row(?:\s|$)/i.test(meta)) return true;
  return /(?:message|conversation|thread)[-_ ]?(?:row|item|card|list-item|listitem)/i.test(meta);
}
function inboxBoldLeaf(el) {
  var weight = "";
  try {
    var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    weight = norm(cs ? cs.fontWeight : "");
  } catch (e) { return false; }
  if (/^(?:bold|bolder)$/i.test(weight)) return true;
  var numeric = parseInt(weight, 10);
  return isFinite(numeric) && numeric >= 600;
}
function inboxRecordedAncestor(el, rows) {
  var node = el ? el.parentElement : null, hops = 0, ri;
  while (node && hops < 24) {
    for (ri = 0; ri < rows.length; ri++) if (rows[ri].node === node) return true;
    node = node.parentElement;
    hops++;
  }
  return false;
}

// Seller Central's messaging UI renders its list inside KAT web components, so
// a plain document walk sees only the surrounding navigation. Traverse open
// shadow roots too (same approach as the ads extractor's deep walk). Read-only:
// this only enumerates nodes, it never activates a control.
function inboxDeepElements(root, cap) {
  var roots = [root || document], seenRoots = [], result = [], ri, di, nodes;
  for (ri = 0; ri < roots.length && ri < 200 && result.length < (cap || 8000); ri++) {
    var rr = roots[ri];
    if (!rr || seenRoots.indexOf(rr) >= 0) continue;
    seenRoots.push(rr);
    nodes = [];
    try {
      if (rr === document && document.body) nodes = document.body.querySelectorAll("*");
      else if (rr.querySelectorAll) nodes = rr.querySelectorAll("*");
    } catch (ide) {}
    for (di = 0; di < nodes.length && result.length < (cap || 8000); di++) {
      var node = nodes[di];
      if (result.indexOf(node) < 0) result.push(node);
      try { if (node.shadowRoot && roots.indexOf(node.shadowRoot) < 0) roots.push(node.shadowRoot); } catch (ide2) {}
    }
  }
  out.shadowRootCount = seenRoots.length - 1;
  return result;
}
function inboxDeepDescendants(el, cap) {
  var result = [], roots = [el], ri, di, nodes, seen = [];
  for (ri = 0; ri < roots.length && ri < 60 && result.length < (cap || 400); ri++) {
    var rr = roots[ri];
    if (!rr || seen.indexOf(rr) >= 0) continue;
    seen.push(rr);
    nodes = [];
    try { if (rr.querySelectorAll) nodes = rr.querySelectorAll("*"); } catch (idd) {}
    for (di = 0; di < nodes.length && result.length < (cap || 400); di++) {
      var child = nodes[di];
      if (result.indexOf(child) < 0) result.push(child);
      try { if (child.shadowRoot && roots.indexOf(child.shadowRoot) < 0) roots.push(child.shadowRoot); } catch (idd2) {}
    }
  }
  return result;
}

out.shadowRootCount = 0;
var els = inboxDeepElements(document, 8000);
var rows = [], i, j;
for (i = 0; i < els.length; i++) {
  var el = els[i], meta = inboxMeta(el), leaf = leafText(el);
  try {
    var role = norm(el.getAttribute("role")), busy = norm(el.getAttribute("aria-busy"));
    if (isVisible(el) && (role === "progressbar" || busy === "true" || /spinner|loading|loader/i.test(tagOf(el) + " " + meta))) out.loading = true;
  } catch (e0) {}
  if (READ_STATE_RE.test(meta) || (leaf && READ_STATE_RE.test(leaf))) out.markerVocabulary = true;
  if (out.declaredUnread === null && leaf) {
    var declaredLeaf = /(?:unread|\u672a\u8bfb)[^0-9]{0,12}(\d{1,4})/i.exec(leaf) || /(\d{1,4})[^0-9]{0,12}(?:unread|\u672a\u8bfb)/i.exec(leaf);
    if (declaredLeaf) {
      var declaredValue = parseInt(declaredLeaf[1], 10);
      if (isFinite(declaredValue) && declaredValue >= 0 && declaredValue <= 9999) out.declaredUnread = declaredValue;
    }
  }
  if (out.badgeCount === null && leaf && /^\d{1,4}$/.test(leaf) && /unread|badge|notification|\u672a\u8bfb|\u6d88\u606f/i.test(meta)) {
    var badgeValue = parseInt(leaf, 10);
    if (isFinite(badgeValue)) out.badgeCount = badgeValue;
  }
  if (!inboxRowLike(el, meta)) continue;
  if (!isVisible(el)) continue;
  if (inboxRecordedAncestor(el, rows)) continue;
  var rowText = "";
  try { rowText = norm(el.textContent); } catch (e1) {}
  if (!rowText || rowText.length > 1200) continue;
  var unreadAttr = UNREAD_RE.test(meta), bold = false;
  var descendants = inboxDeepDescendants(el, 400);
  for (j = 0; j < descendants.length; j++) {
    var d = descendants[j], dMeta = inboxMeta(d), dLeaf = leafText(d);
    if (UNREAD_RE.test(dMeta)) unreadAttr = true;
    if (READ_STATE_RE.test(dMeta) || (dLeaf && READ_STATE_RE.test(dLeaf))) out.markerVocabulary = true;
    if (!bold && dLeaf && inboxBoldLeaf(d)) bold = true;
  }
  rows.push({
    node: el, text: rowText, hasDate: ROW_DATE_RE.test(rowText),
    unreadAttr: unreadAttr, needsResponse: NEEDS_RESPONSE_RE.test(rowText), bold: bold
  });
  if (rows.length >= 200) break;
}

// Markup-agnostic fallback: every message row carries a date. When the tag and
// class heuristics above match nothing (Amazon re-skins this list), anchor on
// date-bearing leaves and climb to their row container. Same idea the feedback
// extractor uses for star ratings.
if (rows.length === 0) {
  for (i = 0; i < els.length; i++) {
    var dateLeaf = leafText(els[i]);
    if (!dateLeaf || dateLeaf.length > 60 || !ROW_DATE_RE.test(dateLeaf)) continue;
    if (!isVisible(els[i])) continue;
    var container = cardOf(els[i], ORDER_RE, 8), containerText = "";
    try { containerText = norm(container.textContent); } catch (ecl) {}
    if (!containerText || containerText.length > 1200) continue;
    if (METRICS_CONTEXT_RE.test(containerText)) continue;
    if (inboxRecordedAncestor(container, rows)) continue;
    var duplicate = false;
    for (j = 0; j < rows.length; j++) if (rows[j].node === container) { duplicate = true; break; }
    if (duplicate) continue;
    var fallbackUnread = UNREAD_RE.test(inboxMeta(container));
    rows.push({
      node: container, text: containerText, hasDate: true,
      unreadAttr: fallbackUnread, needsResponse: NEEDS_RESPONSE_RE.test(containerText), bold: false
    });
    if (rows.length >= 200) break;
  }
  if (rows.length > 0) out.rowSource = "date-anchored";
} else {
  out.rowSource = "row-markup";
}

out.totalRows = rows.length;
for (i = 0; i < rows.length; i++) {
  if (rows[i].hasDate) out.datedRows++;
  if (rows[i].bold) out.boldRowCount++;
  if (rows[i].needsResponse) out.needsResponseCount++;
  // Bold text alone is a rendering convention, not proof of unread state, so it
  // is reported as an indicator and never counted as an unread message. In the
  // "needs reply" filtered view the row's presence is itself the evidence.
  if (!out.responseNeededFilter && !rows[i].unreadAttr && !rows[i].needsResponse) continue;
  var dateHit = ROW_DATE_RE.exec(rows[i].text), orderHit = ORDER_RE.exec(rows[i].text);
  if (out.unreadRows.length < 40) out.unreadRows.push({
    date: dateHit ? dateHit[0] : null, unread: true,
    needsResponse: rows[i].needsResponse || out.responseNeededFilter === true,
    identifier: orderHit ? orderHit[1] : null,
    source: out.responseNeededFilter && !rows[i].unreadAttr ? "dom-response-needed-filter"
      : rows[i].unreadAttr ? "dom-unread-marker" : "dom-needs-response"
  });
}

// Structural signals must also be looked for inside the shadow trees, but the
// composed text may contain buyer names and message subjects, so it is used
// only in-page for these regex tests and its derived counters. It is never
// returned, logged or persisted.
var DT = "";
for (i = 0; i < els.length && DT.length < 60000; i++) {
  var dtLeaf = leafText(els[i]);
  if (dtLeaf) DT += " " + dtLeaf;
}
DT = norm(DT);
out.deepTextLength = DT.length;
out.deepHeaderPresent = HEADER_RE.test(DT);
out.deepEmptyPhrase = EMPTY_RE.test(DT);
out.deepMarkerVocabulary = READ_STATE_RE.test(DT);
var deepDeclared = /(?:unread|\u672a\u8bfb)[^0-9]{0,12}(\d{1,4})/i.exec(DT) || /(\d{1,4})[^0-9]{0,12}(?:unread|\u672a\u8bfb)/i.exec(DT);
out.deepDeclaredUnread = deepDeclared ? parseInt(deepDeclared[1], 10) : null;
var deepDateRe = new RegExp(ROW_DATE_RE.source, "gi"), deepDateHit, deepDates = 0;
while ((deepDateHit = deepDateRe.exec(DT)) !== null && deepDates < 500) deepDates++;
out.deepDatedMatches = deepDates;

var explicitEmpty = EMPTY_RE.test(BT) || out.deepEmptyPhrase;
var gridReady = HEADER_RE.test(BT) || out.deepHeaderPresent;
if (out.deepMarkerVocabulary) out.markerVocabulary = true;
if (out.declaredUnread === null && out.deepDeclaredUnread !== null) out.declaredUnread = out.deepDeclaredUnread;
out.emptyState = explicitEmpty || (out.landed && gridReady && !out.loading && rows.length === 0);

var rangeHit = /\b(\d{1,4})\s*[-\u2013]\s*(\d{1,4})\s+of\s+(\d{1,5})\b/i.exec(BT)
  || /\b(\d{1,4})\s*[-\u2013]\s*(\d{1,4})\s+of\s+(\d{1,5})\b/i.exec(DT);
if (rangeHit) out.pageRange = { from: parseInt(rangeHit[1], 10), to: parseInt(rangeHit[2], 10), total: parseInt(rangeHit[3], 10) };
var nextControls = [];
try { nextControls = document.querySelectorAll("button,a,[role=button]"); } catch (e2) {}
for (i = 0; i < nextControls.length && i < 1000; i++) {
  var nextText = norm(nextControls[i].textContent), nextLabel = "", nextDisabled = false;
  try {
    nextLabel = norm(nextControls[i].getAttribute("aria-label"));
    nextDisabled = nextControls[i].hasAttribute("disabled") || nextControls[i].getAttribute("aria-disabled") === "true";
  } catch (e3) {}
  if (/^(next|\u4e0b\u4e00\u9875)$/i.test(nextText) || /next page|\u4e0b\u4e00\u9875/i.test(nextLabel)) {
    if (!nextDisabled && isVisible(nextControls[i])) out.hasNextPage = true;
  }
}
if (!out.hasNextPage && /\bnext page\b|\u4e0b\u4e00\u9875/i.test(BT) && !out.pageRange) out.hasNextPage = true;
// "No next control" only proves the listing is complete once a listing exists.
// On a page whose table lives in a nested document there are no rows at all,
// and calling that complete would let an empty read look finished.
out.paginationComplete = out.emptyState === true
  || ((rows.length > 0 || out.datedRows > 0)
    && (out.pageRange !== null ? out.pageRange.to >= out.pageRange.total : !out.hasNextPage));

// Seller Central renders the message table in a nested document on some
// accounts. Count visible frames and whether they are same-origin readable so
// the operator sees why nothing could be judged. Booleans and counts only: no
// frame content is read here.
out.visibleFrameCount = 0; out.frameContentReadable = null;
var frameNodes = [];
try { frameNodes = document.querySelectorAll("iframe,frame"); } catch (ef0) {}
for (i = 0; i < frameNodes.length && i < 60; i++) {
  if (!isVisible(frameNodes[i])) continue;
  out.visibleFrameCount++;
  var frameDoc = null;
  try { frameDoc = frameNodes[i].contentDocument || (frameNodes[i].contentWindow ? frameNodes[i].contentWindow.document : null); } catch (ef1) { frameDoc = null; }
  var readable = !!(frameDoc && frameDoc.documentElement);
  out.frameContentReadable = out.frameContentReadable === null ? readable : (out.frameContentReadable || readable);
}

// In the "needs reply" filtered view the row count is the pending-message count
// and a rendered-but-empty list is a proven zero. Elsewhere a number is only
// reported when the page states it or exposes read-state markers.
var pendingHit = PENDING_DECLARED_RE.exec(BT) || PENDING_DECLARED_RE.exec(DT);
out.declaredPending = pendingHit ? parseInt(pendingHit[1], 10) : null;
// Amazon states the pending count on the page; prefer it over any count
// we infer from rows, then an explicit empty state, then row counting.
if (out.declaredPending !== null) {
  out.unreadCount = out.declaredPending;
  out.filterEvidence = "declared-pending-count";
  if (out.declaredPending === 0) out.paginationComplete = true;
} else if (out.responseNeededFilter === true && (rows.length > 0 || out.emptyState === true)) {
  out.unreadCount = out.unreadRows.length;
  out.filterEvidence = rows.length > 0 ? "response-needed-rows" : "response-needed-empty";
} else if (out.declaredUnread !== null) out.unreadCount = out.declaredUnread;
else if (out.unreadRows.length > 0) out.unreadCount = out.unreadRows.length;
else if (out.emptyState === true) out.unreadCount = 0;
else if (out.markerVocabulary === true && out.landed === true && rows.length > 0) out.unreadCount = 0;
if (out.responseNeededFilter === true && (rows.length > 0 || out.emptyState === true)) {
  out.paginationComplete = out.emptyState === true
    || (out.pageRange !== null ? out.pageRange.to >= out.pageRange.total : !out.hasNextPage);
}
if (out.landed && rows.length > 0 && out.unreadCount === null) {
  out.notes.push("inbox rows present but no read-state marker found; unread count is undetermined");
}
if (out.landed && rows.length === 0 && out.emptyState !== true) {
  out.notes.push("inbox listing rows not found in this document; visible frames: " + out.visibleFrameCount);
}
`);
