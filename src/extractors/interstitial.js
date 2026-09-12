/**
 * Interstitial handlers.
 *
 * A real run turned up two blockers that sit between `page visit` and the page
 * we actually want:
 *
 *  1. Multi-marketplace accounts land on a "Select an account" chooser instead
 *     of the dashboard. Three of seven live stores did this.
 *  2. The chooser (and the whole console) may be in Chinese, so matching has to
 *     cover both languages.
 *
 * Clicking is done in-page with JS rather than `page click --selector`, because
 * the CLI only accepts a CSS selector and the chooser's markup is unknown, while
 * matching on visible text works in either language.
 *
 * ASCII-only, like every injected script; CJK names are \u-escaped.
 */

/** market code -> the marketplace's name in English and Chinese */
export const MARKET_NAMES = {
  "US": ["United States", "\u7f8e\u56fd"],
  "CA": ["Canada", "\u52a0\u62ff\u5927"],
  "MX": ["Mexico", "\u58a8\u897f\u54e5"],
  "BR": ["Brazil", "\u5df4\u897f"],
  "UK": ["United Kingdom", "\u82f1\u56fd"],
  "GB": ["United Kingdom", "\u82f1\u56fd"],
  "DE": ["Germany", "\u5fb7\u56fd"],
  "FR": ["France", "\u6cd5\u56fd"],
  "IT": ["Italy", "\u610f\u5927\u5229"],
  "ES": ["Spain", "\u897f\u73ed\u7259"],
  "NL": ["Netherlands", "\u8377\u5170"],
  "SE": ["Sweden", "\u745e\u5178"],
  "PL": ["Poland", "\u6ce2\u5170"],
  "TR": ["Turkey", "\u571f\u8033\u5176"],
  "JP": ["Japan", "\u65e5\u672c"],
  "AU": ["Australia", "\u6fb3\u5927\u5229\u4e9a"],
  "SG": ["Singapore", "\u65b0\u52a0\u5761"],
  "AE": ["United Arab Emirates", "\u963f\u62c9\u4f2f\u8054\u5408\u914b\u957f\u56fd"],
  "SA": ["Saudi Arabia", "\u6c99\u7279\u963f\u62c9\u4f2f"],
  "IN": ["India", "\u5370\u5ea6"],
  "EG": ["Egypt", "\u57c3\u53ca"]
};

const PICKER_DETECT = String.raw`
var BT = "";
try { BT = String((document.body && (document.body.innerText || document.body.textContent)) || "").replace(/\s+/g, " ").trim(); } catch (e) {}
var IS_PICKER = /(select an account|switch between your available accounts|\u9009\u62e9\u8d26\u6237)/i.test(BT);
`;

/**
 * Build a script that detects the account chooser and clicks the wanted
 * marketplace. Returns {isPicker, clicked, matched, candidates, notes}.
 */
/** JSON.stringify keeps CJK literal; the injected script must stay ASCII. */
function jsonAscii(s) {
  return JSON.stringify(s).replace(/[\u0080-\uFFFF]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function buildAccountPickerScript(market) {
  const names = MARKET_NAMES[String(market || 'US').toUpperCase()] || MARKET_NAMES.US;
  const list = names.map(jsonAscii).join(', ');
  return `
${PICKER_DETECT}
var WANT = [${list}];
var out = { isPicker: IS_PICKER, clicked: false, matched: null, candidates: [], notes: [] };
if (!IS_PICKER) { return out; }

function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
// "(pending registration)" / "\u5f85\u6ce8\u518c" marketplaces are not open to this account.
var PENDING = /(pending registration|\\u5f85\\u6ce8\\u518c)/i;

var nodes = [];
try { nodes = document.querySelectorAll("a,button,li,td,div,span,[role=button],[role=link],[role=option]"); } catch (e) {}
for (var i = 0; i < nodes.length && i < 4000; i++) {
  var el = nodes[i];
  var t = norm(el.innerText || el.textContent);
  if (!t || t.length > 60) continue;
  if (PENDING.test(t)) {
    if (out.candidates.length < 30) out.candidates.push({ text: t, pending: true });
    continue;
  }
  var hit = false;
  for (var w = 0; w < WANT.length; w++) { if (t === WANT[w]) { hit = true; break; } }
  if (!hit) continue;
  if (out.candidates.length < 30) out.candidates.push({ text: t, pending: false });
  try {
    var rects = el.getClientRects ? el.getClientRects() : [];
    if (!rects.length) { out.notes.push("matched but not visible: " + t); continue; }
  } catch (e2) {}
  try {
    el.click();
    out.clicked = true;
    out.matched = t;
    break;
  } catch (e3) {
    out.notes.push("click threw on: " + t);
  }
}
if (!out.clicked && !out.matched) {
  out.notes.push("account chooser detected but no clickable entry matched " + WANT.join(" / "));
}
return out;
`;
}
