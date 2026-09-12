/**
 * In-page extractor for the Amazon Account Health "Policy Compliance" card.
 *
 * Runs inside the Ziniao store browser via WebDriver or the CLI fallback. It is a plain
 * function body that returns an object; the wrapper in lib/ziniao.js handles
 * serialization. Constraints:
 *   - ASCII only (it travels through argv and is asserted ASCII-only).
 *   - No template literals, no `${`, no backticks (it is embedded in String.raw).
 *   - ES5-level syntax, so it works in whatever Chrome kernel the store uses.
 *
 * Strategy: locate the "Policy Compliance" label via a TreeWalker (cheap - no
 * layout), walk up to the enclosing card, then read the status badge and the
 * Account Health Rating number out of that bounded subtree. The AHR number is
 * picked by largest rendered font-size, which distinguishes the big score
 * ("256") from the axis tick labels ("0 100 200 1000").
 */
export const POLICY_COMPLIANCE_EXTRACTOR = String.raw`
var VOCAB = [
  ["DEACTIVATED", /^(your\s+)?(account\s+)?(is\s+)?deactivat(ed|ion)$/i],
  ["DEACTIVATED", /^\u5df2\u505c\u7528$/],
  ["AT_RISK",     /^at[\s-]*risk(\s+of\s+deactivation)?$/i],
  ["AT_RISK",     /^\u6709\u98ce\u9669$/],
  ["UNHEALTHY",   /^unhealthy$/i],
  ["UNHEALTHY",   /^\u4e0d\u5065\u5eb7$/],
  ["CRITICAL",    /^critical$/i],
  ["CRITICAL",    /^\u4e25\u91cd$/],
  ["HEALTHY",     /^healthy$/i],
  ["HEALTHY",     /^\u826f\u597d$/]
];
var CONTAINS = /\b(unhealthy|healthy|critical|deactivated|at[\s-]risk)\b|\u4e0d\u5065\u5eb7|\u826f\u597d|\u4e25\u91cd|\u5df2\u505c\u7528|\u6709\u98ce\u9669/i;
var MAX_CARD_TEXT = 1500;

function norm(s) {
  // JS \s already covers NBSP (U+00A0) and the BOM, so this normalizes Amazon's
  // non-breaking spaces without needing a non-ASCII literal in this source file.
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}
function tagOf(el) {
  try { return String(el.tagName || "?").toLowerCase(); } catch (e) { return "?"; }
}
function classify(s) {
  var t = norm(s);
  if (!t || t.length > 48) return null;
  for (var i = 0; i < VOCAB.length; i++) { if (VOCAB[i][1].test(t)) return VOCAB[i][0]; }
  return null;
}
function classifyLoose(s) {
  var t = norm(s);
  var m = CONTAINS.exec(t);
  if (!m) return null;
  var w = String(m[1] || m[0]).toLowerCase().replace(/[\s-]+/g, " ");
  if (w === "unhealthy") return "UNHEALTHY";
  if (w === "healthy") return "HEALTHY";
  if (w === "critical") return "CRITICAL";
  if (w === "deactivated") return "DEACTIVATED";
  if (w === "at risk") return "AT_RISK";
  if (w === "\u826f\u597d") return "HEALTHY";
  if (w === "\u4e0d\u5065\u5eb7") return "UNHEALTHY";
  if (w === "\u4e25\u91cd") return "CRITICAL";
  if (w === "\u5df2\u505c\u7528") return "DEACTIVATED";
  if (w === "\u6709\u98ce\u9669") return "AT_RISK";
  return null;
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
var SKIP_TAGS = { script: 1, style: 1, noscript: 1, template: 1 };
function isSkipped(el) {
  try { return !!SKIP_TAGS[String(el.tagName || "").toLowerCase()]; } catch (e) { return false; }
}
function leafText(el) {
  try {
    if (isSkipped(el)) return "";
    if (el.children && el.children.length > 0) return "";
    return norm(el.textContent);
  } catch (e) { return ""; }
}
/** textContent includes inline <script> source; strip those subtrees. */
function visibleTextOf(el) {
  if (!el) return "";
  try {
    var parts = [], stack = [el];
    while (stack.length) {
      var n = stack.pop();
      if (!n) continue;
      if (n.nodeType === 3) { parts.push(String(n.nodeValue || "")); continue; }
      if (isSkipped(n)) continue;
      var kids = n.childNodes;
      if (!kids || !kids.length) { parts.push(String(n.textContent || "")); continue; }
      for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return norm(parts.join(" "));
  } catch (e) {
    try { return norm(el.textContent); } catch (e2) { return ""; }
  }
}
function fontOf(el) {
  var fs = 0, fw = 400;
  try {
    var cs = window.getComputedStyle(el);
    fs = parseFloat(cs.fontSize) || 0;
    fw = parseInt(cs.fontWeight, 10);
    if (!isFinite(fw)) fw = /bold/i.test(String(cs.fontWeight)) ? 700 : 400;
  } catch (e) {}
  return { fontSize: fs, fontWeight: fw };
}
function textNodesMatching(re, limit) {
  var res = [];
  try {
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = w.nextNode())) {
      var t = norm(n.nodeValue);
      if (t && re.test(t)) {
        res.push(n);
        if (res.length >= (limit || 20)) break;
      }
    }
  } catch (e) {}
  return res;
}

var out = {
  extractor: "policy-compliance/v1",
  url: "", title: "", readyState: "",
  hasPolicyComplianceText: false,
  looksLikeLogin: false,
  looksBlocked: false,
  status: null, statusRaw: null, statusSource: null, statusVariant: null,
  statusCandidates: [],
  score: null, scoreMax: null, scoreSource: null, scoreCandidates: [],
  cardText: null, cardFound: false,
  pageTextLength: 0,
  notes: []
};

try { out.url = String(location.href); } catch (e) {}
try { out.title = norm(document.title); } catch (e) {}
try { out.readyState = String(document.readyState); } catch (e) {}

var bodyText = "";
try { bodyText = norm(document.body ? document.body.innerText || document.body.textContent : ""); } catch (e) {}
out.pageTextLength = bodyText.length;
out.hasPolicyComplianceText = /policy\s+compliance|\u653f\u7b56\u5408\u89c4\u6027/i.test(bodyText);

var LOGIN_RE = /(sign[\s-]*in to continue|amazon sign[\s-]*in|enter your password|email or mobile phone number|two[\s-]step verification|forgot your password)/i;
var BLOCK_RE = /(enter the characters you see|robot check|to discuss automated access|sorry, something went wrong|service unavailable|http 5\d\d)/i;
out.looksLikeLogin = LOGIN_RE.test(bodyText) && !out.hasPolicyComplianceText;
out.looksBlocked = BLOCK_RE.test(bodyText) && !out.hasPolicyComplianceText;

// ---- locate the card ----------------------------------------------------
var labelNodes = textNodesMatching(/^(policy\s+compliance|\u653f\u7b56\u5408\u89c4\u6027)$/i, 8);
if (labelNodes.length === 0) {
  labelNodes = textNodesMatching(/^(policy\s+compliance\b|\u653f\u7b56\u5408\u89c4\u6027)/i, 8);
  if (labelNodes.length) out.notes.push("label matched by prefix, not exact");
}

// The label appears more than once: the tab strip carries "Product Policy
// Compliance" as well as the card. Two passes, so the tab never wins - first
// accept only an ancestry containing the rating widget (that is the real card),
// and only if no label qualifies fall back to a looser match.
var labelEl = null, card = null;

function climb(el, strict) {
  var node = el, hops = 0, fallback = null;
  while (node && hops < 14) {
    var t = "";
    try { t = norm(node.textContent); } catch (e) {}
    if (/account\s+health\s+rating|\u8d26\u6237\u72b6\u51b5\u8bc4\u7ea7/i.test(t)) return node;
    if (!strict) {
      if (t.length > 60 && classifyLoose(t)) return node;
      if (!fallback && t.length > 60) fallback = node;
    }
    node = node.parentElement;
    hops++;
  }
  return strict ? null : fallback;
}

for (var pass = 0; pass < 2 && !card; pass++) {
  for (var li = 0; li < labelNodes.length && !card; li++) {
    var el = labelNodes[li].parentElement;
    if (!el) continue;
    if (!isVisible(el)) {
      if (pass === 0) out.notes.push("skipped hidden Policy Compliance label");
      continue;
    }
    var found = climb(el, pass === 0);
    if (found) { card = found; labelEl = el; }
  }
}
if (card && labelNodes.length > 1) {
  out.notes.push("page has " + labelNodes.length + " 'Policy Compliance' labels; picked the one inside the rating card");
}

if (card) {
  out.cardFound = true;
  var ct = "";
  try { ct = visibleTextOf(card); } catch (e) {}
  out.cardText = ct.length > MAX_CARD_TEXT ? ct.slice(0, MAX_CARD_TEXT) : ct;
} else if (out.hasPolicyComplianceText) {
  out.notes.push("page contains 'Policy Compliance' but the card element was not located");
}

// Scan ONLY inside the card. Falling back to a body-wide scan is unsafe: the
// Seller Central header carries its own account-health pill ("...United States
// Healthy"), so a page-wide leaf scan reports HEALTHY on a 404 page. Reporting
// nothing and letting the caller say UNKNOWN is the only safe behaviour here.
var nodes = [];
if (card) {
  try { nodes = card.querySelectorAll("*"); } catch (e) { nodes = []; }
} else {
  out.notes.push("card not located; skipped element scans to avoid matching the nav header status pill");
}
if (nodes.length > 4000) { out.notes.push("scope too large (" + nodes.length + " nodes); results may be noisy"); }

// ---- status badge: visible leaf text first (that is what a human reads) ----
var ATTRS = ["label", "aria-label", "title", "data-status", "status", "value", "text"];
for (var i = 0; i < nodes.length && i < 4000; i++) {
  var e = nodes[i];
  if (e === labelEl) continue;
  var lt = leafText(e);
  if (!lt) continue;
  var c = classify(lt);
  if (!c) continue;
  var vis = isVisible(e);
  var f = fontOf(e);
  var cand = {
    status: c, raw: lt, source: "leaf:" + tagOf(e), visible: vis,
    fontSize: f.fontSize, fontWeight: f.fontWeight
  };
  try {
    cand.variant = e.getAttribute("variant") || e.getAttribute("state") || e.getAttribute("data-variant") || null;
  } catch (e2) { cand.variant = null; }
  out.statusCandidates.push(cand);
  if (vis && out.status === null) {
    out.status = c; out.statusRaw = lt; out.statusSource = cand.source; out.statusVariant = cand.variant;
  }
}

// ---- status badge: fall back to component attributes (kat-* web components) ----
if (out.status === null) {
  for (var j = 0; j < nodes.length && j < 4000; j++) {
    var el2 = nodes[j];
    if (!el2 || !el2.getAttribute) continue;
    for (var a = 0; a < ATTRS.length; a++) {
      var v = null;
      try { v = el2.getAttribute(ATTRS[a]); } catch (e3) { v = null; }
      if (!v) continue;
      var c2 = classify(v);
      if (!c2) continue;
      var src = "attr:" + ATTRS[a] + "@" + tagOf(el2);
      out.statusCandidates.push({ status: c2, raw: norm(v), source: src, visible: isVisible(el2) });
      if (out.status === null) {
        out.status = c2; out.statusRaw = norm(v); out.statusSource = src;
        try { out.statusVariant = el2.getAttribute("variant") || el2.getAttribute("state") || null; } catch (e4) {}
      }
    }
  }
}

// ---- status badge: last resort, scan the text right after the label ----
// Anchored fallback: only the 260 chars *after* the label, so the header pill
// cannot reach it. Kept even when the card was not located.
if (out.status === null && out.hasPolicyComplianceText) {
  var m = /(?:policy\s+compliance|\u653f\u7b56\u5408\u89c4\u6027)([\s\S]{0,260})/i.exec(bodyText);
  if (m) {
    var c3 = classifyLoose(m[1]);
    if (c3) {
      out.status = c3;
      out.statusRaw = norm(m[1]).slice(0, 80);
      out.statusSource = "pagetext-window";
      out.notes.push("status taken from a text window after the label (low precision)");
    }
  }
}

// ---- Account Health Rating score ----------------------------------------
// Scope matters more than font size here. The card also contains an "All Issues"
// table whose ten zero-counts render LARGER (24px) than the score itself (18px),
// so a card-wide font-size ranking picks 0. Anchor on the rating label instead
// and climb only until a real number appears, stopping before the issues table.
var scoreScope = card;
var ahrNodes = textNodesMatching(/^(account\s+health\s+rating|\u8d26\u6237\u72b6\u51b5\u8bc4\u7ea7)$/i, 4);
if (ahrNodes.length) {
  var an = ahrNodes[0].parentElement, ahops = 0;
  while (an && ahops < 10) {
    var at = visibleTextOf(an);
    if (/all issues|priority actions|suspected intellectual|\u6240\u6709\u95ee\u9898|\u6d89\u5acc\u4fb5\u72af\u77e5\u8bc6\u4ea7\u6743/i.test(at)) break;
    var nums = at.match(/\b\d{1,4}\b/g) || [];
    var hasReal = false;
    for (var q2 = 0; q2 < nums.length; q2++) {
      var v2 = parseInt(nums[q2], 10);
      if (v2 !== 0 && v2 !== 100 && v2 !== 200 && v2 !== 1000) { hasReal = true; break; }
    }
    scoreScope = an;
    if (hasReal) break;
    an = an.parentElement; ahops++;
  }
  out.notes.push("score scoped to the Account Health Rating widget");
}
var scoreNodes = [];
if (scoreScope) {
  try { scoreNodes = scoreScope.querySelectorAll("*"); } catch (e) { scoreNodes = []; }
}
for (var k = 0; k < scoreNodes.length && k < 4000; k++) {
  var e5 = scoreNodes[k];
  var t5 = leafText(e5);
  if (!/^[0-9]{1,4}$/.test(t5)) continue;
  var n5 = parseInt(t5, 10);
  if (!isFinite(n5) || n5 < 0 || n5 > 1000) continue;
  if (!isVisible(e5)) continue;
  var f5 = fontOf(e5);
  out.scoreCandidates.push({ value: n5, fontSize: f5.fontSize, fontWeight: f5.fontWeight, tag: tagOf(e5) });
}
if (out.scoreCandidates.length) {
  out.scoreCandidates.sort(function (x, y) {
    return (y.fontSize - x.fontSize) || (y.fontWeight - x.fontWeight) || (y.value - x.value);
  });
  var top = out.scoreCandidates[0];
  var tie = 0;
  for (var q = 0; q < out.scoreCandidates.length; q++) {
    if (Math.abs(out.scoreCandidates[q].fontSize - top.fontSize) < 0.5) tie++;
  }
  out.score = top.value;
  out.scoreSource = "font-size-rank";
  var mx = 0;
  for (var r = 0; r < out.scoreCandidates.length; r++) {
    if (out.scoreCandidates[r].value > mx) mx = out.scoreCandidates[r].value;
  }
  out.scoreMax = mx >= 1000 ? 1000 : (mx || null);
  if (tie > 1) {
    out.notes.push("score is ambiguous: " + tie + " numbers share the largest font size");
    out.scoreSource = "font-size-rank-ambiguous";
  }
  if (out.scoreCandidates.length > 24) {
    out.notes.push("many numeric leaves in scope (" + out.scoreCandidates.length + "); score may be wrong");
  }
  out.scoreCandidates = out.scoreCandidates.slice(0, 12);
}

if (out.statusCandidates.length > 12) out.statusCandidates = out.statusCandidates.slice(0, 12);
return out;
`;
