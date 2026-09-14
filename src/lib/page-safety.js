import { sanitizeUrl } from './redact.js';
import { approvedAmazonUrl, isApprovedAmazonRetailHostname } from './amazon-url.js';

// Authentication pages may contain account identifiers, a Ziniao-filled OTP,
// or native Passkey state. URL checks intentionally run before DOM/text reads.
const AUTH_URL_RE = /(?:\/ap\/(?:signin|cvf|challenge|mfa|verify|register)|\/signin(?:[/?#]|$)|\/login(?:[/?#]|$)|openid|oauth|sso|passkey|webauthn|two[\s_-]*step|verification|\botp\b)/i;
const BLOCKED_URL_RE = /(?:captcha|robot[-_/ ]?check|automated[-_/ ]?access)/i;
const AUTH_TEXT_RE = /(?:amazon\s+sign[\s-]*in|email or mobile phone number|enter your password|use your passkey|sign in with (?:a )?passkey|two[\s-]*step verification|verification code|one[\s-]*time (?:password|code)|\botp\b|验证码|一次性密码|通行密钥)/i;
const BLOCKED_TEXT_RE = /(?:robot check|enter the characters you see|automated access|sorry, we just need to make sure)/i;

function presentUrl(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Keep the complete browser URL available only while a probe is in memory. A
// Symbol/non-enumerable property cannot cross JSON/report boundaries, while it
// still lets the collector distinguish query-only and fragment-only page
// changes. Persisted `currentUrl` remains sanitized below.
const RAW_PAGE_URL = Symbol('amzguard.rawPageUrl');

function rememberRawPageUrl(result, value) {
  Object.defineProperty(result, RAW_PAGE_URL, {
    value: presentUrl(value), enumerable: false, configurable: false, writable: false,
  });
  return result;
}

export function rawPageIdentity(result) {
  return presentUrl(result?.[RAW_PAGE_URL]);
}

// A changed identity invalidates the entire read. Callers may start a fresh
// gated read, never reuse the discarded DOM/text or weaken URL equality.
export function canRetryPageIdentity(safety, attempt = 0, limit = 0) {
  return attempt < Math.max(0, Number(limit) || 0)
    && safety?.authSensitive !== true
    && safety?.blocked !== true
    && [
      'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE',
      'PAGE_CHANGED_BEFORE_EVIDENCE_READ',
      'PAGE_CHANGED_DURING_EVIDENCE_READ',
    ].includes(String(safety?.code || ''));
}

/**
 * ZiNiao/Chromium can replace a failed navigation with one of its own internal
 * extension error pages. This is a poisoned browser session, not an Amazon
 * business result. Callers may restart that same ZiNiao store browser and retry
 * once, while all other unapproved hosts remain non-retryable.
 */
export function isRecoverableBrowserInternalSafety(result) {
  if (result?.code === 'CURRENT_URL_UNAVAILABLE') return true;
  if (result?.code !== 'UNAPPROVED_AMAZON_HOST') return false;
  const current = rawPageIdentity(result) || presentUrl(result?.currentUrl);
  return /^(?:chrome-extension|chrome-error):\/\//i.test(current);
}

// Only a completed safety probe that positively observed a detached, empty
// document can be retried as page loading. A missing/failed probe, auth UI,
// traversal gap or unknown host is never reclassified as harmless loading.
export function isTransientEmptyDocumentSafety(result) {
  return result?.code === 'LIVE_SAFETY_PROBE_UNAVAILABLE'
    && result.transientEmptyDocument === true
    && result.authSensitive === false && result.blocked === false;
}

export function isAuthenticationUrl(value) {
  const url = presentUrl(value);
  return !!url && AUTH_URL_RE.test(url);
}

export function isAuthenticationEvidence({ currentUrl, dom, txt, pageText } = {}) {
  if (isAuthenticationUrl(currentUrl)) return true;
  if (dom?.looksLikeLogin || txt?.looksLikeLogin) return true;
  return AUTH_TEXT_RE.test(String(pageText || '').slice(0, 16000));
}

export function isBlockedEvidence({ currentUrl, dom, txt, pageText } = {}) {
  if (BLOCKED_URL_RE.test(presentUrl(currentUrl))) return true;
  if (dom?.looksBlocked || txt?.looksBlocked) return true;
  return BLOCKED_TEXT_RE.test(String(pageText || '').slice(0, 16000));
}

export function classifyUrlSafety(currentUrl) {
  const actual = presentUrl(currentUrl);
  if (!actual) return rememberRawPageUrl({
    safe: false, code: 'CURRENT_URL_UNAVAILABLE', authSensitive: false, blocked: false, currentUrl: null,
  }, actual);
  if (!approvedAmazonUrl(actual)) {
    return rememberRawPageUrl({
      safe: false, code: 'UNAPPROVED_AMAZON_HOST', authSensitive: false,
      blocked: false, unapprovedHost: true, currentUrl: sanitizeUrl(actual),
    }, actual);
  }
  if (BLOCKED_URL_RE.test(actual)) {
    return rememberRawPageUrl({
      safe: false, code: 'ACCESS_BLOCKED', authSensitive: true, blocked: true, currentUrl: sanitizeUrl(actual),
    }, actual);
  }
  if (isAuthenticationUrl(actual)) {
    return rememberRawPageUrl({
      safe: false, code: 'AUTH_SENSITIVE', authSensitive: true, blocked: false, currentUrl: sanitizeUrl(actual),
    }, actual);
  }
  return rememberRawPageUrl({
    safe: true, code: 'URL_ALLOWED', authSensitive: false, blocked: false, currentUrl: sanitizeUrl(actual),
  }, actual);
}

function isBusinessEvidence(dom, txt) {
  return Boolean(
    dom?.landed === true || txt?.landed === true ||
    dom?.hasPolicyComplianceText === true || txt?.hasPolicyComplianceText === true ||
    dom?.pageNotFound === true || txt?.pageNotFound === true ||
    dom?.dogPage === true || txt?.dogPage === true ||
    dom?.notFound === true || txt?.notFound === true ||
    dom?.unavailable === true || txt?.unavailable === true,
  );
}

// Runs inside the already-open Ziniao-owned page before/after sensitive reads
// and screenshots. It returns booleans and bounded counters only: no input
// value, OTP, account identifier or page text crosses the WebDriver/CLI
// boundary. The counters let operators distinguish a traversal budget from an
// unreadable visible frame without weakening the fail-closed decision.
function buildLiveSafetyExtractor(rootBudget) {
  return [
  'var roots=[document],seen=[],traversalComplete=true,accessibleTraversalComplete=true,mainDocumentTraversalComplete=true,discoveredElements=0,scannedElements=0,elementBudget=50000,rootBudget=' + rootBudget + ',nodeBudget=5000,unreadableFrameBudget=8,traversalErrorCount=0,nonFrameTraversalErrorCount=0,unreadableFrameErrorCount=0,visibleFrameCount=0,unreadableVisibleFrameCount=0,opaqueOverlayFrameCount=0,opaqueAuthHintCount=0,opaqueBlockedHintCount=0,rootBudgetExceeded=false,elementBudgetExceeded=false,nodeBudgetExceeded=false,unreadableFrameBudgetExceeded=false;',
  'var nonFrameError=function(){traversalComplete=false;accessibleTraversalComplete=false;traversalErrorCount++;nonFrameTraversalErrorCount++;};',
  'var frameVisible=function(el){try{if(el.hidden===true)return false;var st=el.style||null;if(st){var d=String(st.display||"").toLowerCase(),v=String(st.visibility||"").toLowerCase(),o=String(st.opacity||"");if(d==="none"||v==="hidden"||v==="collapse"||(o!==""&&Number(o)===0))return false;}var owner=el.ownerDocument||document,varView=owner&&owner.defaultView,cs=varView&&typeof varView.getComputedStyle==="function"?varView.getComputedStyle(el):null;if(cs){var cd=String(cs.display||"").toLowerCase(),cv=String(cs.visibility||"").toLowerCase(),co=String(cs.opacity||"");if(cd==="none"||cv==="hidden"||cv==="collapse"||(co!==""&&Number(co)===0))return false;}if(typeof el.getClientRects==="function"){var rects=el.getClientRects();if(!rects||rects.length===0)return false;}if(typeof el.getBoundingClientRect==="function"){var rect=el.getBoundingClientRect();if(rect&&(Number(rect.width)<=0||Number(rect.height)<=0))return false;}return true;}catch(e){nonFrameError();return true;}};',
  'var frameRisk=function(el){try{var attrs=["id","name","title","aria-label","src"],meta="",ai;for(ai=0;ai<attrs.length;ai++){meta+=" "+String((el.getAttribute&&el.getAttribute(attrs[ai]))||"");}if(/(?:^|[^a-z0-9])(?:auth(?:entication)?|oauth|openid|login|sign[\\s_-]*in|passkey|webauthn|mfa|otp|verification)(?:[^a-z0-9]|$)|(?:\\u767b\\u5f55|\\u9a8c\\u8bc1\\u7801)/i.test(meta))opaqueAuthHintCount++;if(/(?:^|[^a-z0-9])(?:captcha|robot[\\s_-]*check|automated[\\s_-]*access|blocked)(?:[^a-z0-9]|$)|(?:\\u9a8c\\u8bc1\\u7801)/i.test(meta))opaqueBlockedHintCount++;var rect=typeof el.getBoundingClientRect==="function"?el.getBoundingClientRect():null,owner=el.ownerDocument||document,view=owner&&owner.defaultView,vw=Number(view&&view.innerWidth)||Number(owner&&owner.documentElement&&owner.documentElement.clientWidth)||0,vh=Number(view&&view.innerHeight)||Number(owner&&owner.documentElement&&owner.documentElement.clientHeight)||0,overlay=false,cur=el,depth=0;while(cur&&depth<8){var role=String((cur.getAttribute&&cur.getAttribute("role"))||"").toLowerCase(),modal=String((cur.getAttribute&&cur.getAttribute("aria-modal"))||"").toLowerCase(),cn=String((cur.getAttribute&&(cur.getAttribute("class")||cur.getAttribute("id")))||"").toLowerCase();if(role==="dialog"||modal==="true"||/(?:modal|dialog|overlay)/.test(cn)){overlay=true;break;}cur=cur.parentElement;depth++;}if(!rect||vw<=0||vh<=0){overlay=true;}else{var rw=Math.max(0,Number(rect.width)||0),rh=Math.max(0,Number(rect.height)||0),cs=view&&typeof view.getComputedStyle==="function"?view.getComputedStyle(el):null,pos=String((cs&&cs.position)||(el.style&&el.style.position)||"").toLowerCase();if((rw>=vw*0.75&&rh>=vh*0.75)||(pos==="fixed"&&rw>=vw*0.5&&rh>=vh*0.5))overlay=true;}if(overlay)opaqueOverlayFrameCount++;}catch(e){nonFrameError();opaqueOverlayFrameCount++;}};',
  'for(var r=0;r<roots.length&&r<rootBudget;r++){var root=roots[r];if(seen.indexOf(root)>=0)continue;seen.push(root);var all=[];try{all=root.querySelectorAll("*");discoveredElements+=all.length;}catch(e){nonFrameError();if(root===document)mainDocumentTraversalComplete=false;}var remaining=elementBudget-scannedElements;if(remaining<0)remaining=0;var take=all.length<remaining?all.length:remaining;for(var a=0;a<take;a++){var el=all[a];try{if(el.shadowRoot&&roots.indexOf(el.shadowRoot)<0)roots.push(el.shadowRoot);var tag=String(el.tagName||"").toLowerCase();if((tag==="iframe"||tag==="frame")&&frameVisible(el)){visibleFrameCount++;frameRisk(el);var frameDoc=null,frameReadFailed=false;try{frameDoc=el.contentDocument||null;if(!frameDoc&&el.contentWindow)frameDoc=el.contentWindow.document||null;}catch(e2){traversalComplete=false;traversalErrorCount++;unreadableFrameErrorCount++;frameReadFailed=true;}if(frameDoc&&frameDoc.documentElement){if(roots.indexOf(frameDoc)<0)roots.push(frameDoc);}else{traversalComplete=false;unreadableVisibleFrameCount++;if(!frameReadFailed){traversalErrorCount++;unreadableFrameErrorCount++;}if(unreadableVisibleFrameCount>unreadableFrameBudget)unreadableFrameBudgetExceeded=true;}}}catch(e3){nonFrameError();if(root===document)mainDocumentTraversalComplete=false;}}scannedElements+=take;if(take<all.length){traversalComplete=false;accessibleTraversalComplete=false;elementBudgetExceeded=true;if(root===document)mainDocumentTraversalComplete=false;}}if(roots.length>rootBudget){traversalComplete=false;accessibleTraversalComplete=false;rootBudgetExceeded=true;}',
  'var one=function(s){for(var r=0;r<seen.length;r++){try{var n=seen[r].querySelector(s);if(n)return n;}catch(e){nonFrameError();}}return null;};',
  'var auth=!!one("#ap_email,#ap_password,#auth-mfa-otpcode,input[autocomplete=one-time-code],input[type=password],[data-testid*=passkey],[data-test*=passkey]");',
  'var blocked=!!one("#captchacharacters,form[action*=validateCaptcha],img[src*=captcha],[id*=robot-check],[class*=robot-check]");',
  'var nodes=[];for(var r=0;r<seen.length;r++){var found=[];try{found=seen[r].querySelectorAll("[role=dialog],button,[role=button],h1,h2,label,kat-button,kat-modal");}catch(e3){nonFrameError();}for(var f=0;f<found.length;f++){if(nodes.indexOf(found[f])<0){if(nodes.length>=nodeBudget){traversalComplete=false;accessibleTraversalComplete=false;nodeBudgetExceeded=true;break;}nodes.push(found[f]);}}}',
  'for(var i=0;i<nodes.length;i++){',
  ' var n=nodes[i];var t=String((n.getAttribute&&(n.getAttribute("aria-label")||n.getAttribute("label")))||n.innerText||n.textContent||"").replace(/\\s+/g," ").trim();',
  ' if(/(?:use (?:a )?passkey to (?:sign|log) in|sign in with (?:a )?passkey|verification code|two-step verification|robot check|enter the characters you see)/i.test(t)){auth=auth||!/robot check|characters you see/i.test(t);blocked=blocked||/robot check|characters you see/i.test(t);}',
  ' if(/(?:\\u4f7f\\u7528(?:(?:\\u901a\\u884c)?\\u5bc6\\u94a5|passkey)\\u767b\\u5f55|\\u63a5(?:\\u53d7|\\u6536)\\u9a8c\\u8bc1\\u7801|\\u4e24\\u6b65\\u9a8c\\u8bc1|\\u9a8c\\u8bc1\\u7801)/i.test(t)){auth=true;}',
  '}',
  'return {probeVersion:2,looksLikeLogin:auth===true,looksBlocked:blocked===true,liveDocument:!!document.documentElement,traversalComplete:traversalComplete===true,accessibleTraversalComplete:accessibleTraversalComplete===true,mainDocumentTraversalComplete:mainDocumentTraversalComplete===true,discoveredRootCount:roots.length,scannedRootCount:seen.length,discoveredElementCount:discoveredElements,scannedElementCount:scannedElements,candidateNodeCount:nodes.length,visibleFrameCount:visibleFrameCount,unreadableVisibleFrameCount:unreadableVisibleFrameCount,traversalErrorCount:traversalErrorCount,nonFrameTraversalErrorCount:nonFrameTraversalErrorCount,unreadableFrameErrorCount:unreadableFrameErrorCount,opaqueOverlayFrameCount:opaqueOverlayFrameCount,opaqueAuthHintCount:opaqueAuthHintCount,opaqueBlockedHintCount:opaqueBlockedHintCount,rootBudget:rootBudget,elementBudget:elementBudget,nodeBudget:nodeBudget,unreadableFrameBudget:unreadableFrameBudget,rootBudgetExceeded:rootBudgetExceeded===true,elementBudgetExceeded:elementBudgetExceeded===true,nodeBudgetExceeded:nodeBudgetExceeded===true,unreadableFrameBudgetExceeded:unreadableFrameBudgetExceeded===true};',
  ].join('\n');
}

export const POST_SCREENSHOT_SAFETY_EXTRACTOR = buildLiveSafetyExtractor(512);
// The bulk-upload preview uses a larger component tree. Only this exact entry
// gets a higher root limit; every root must still be traversed successfully.
const PRODUCT_BULK_SAFETY_URL = 'https://sellercentral.amazon.com/product-search/bulk';
const PRODUCT_BULK_SAFETY_EXTRACTOR = buildLiveSafetyExtractor(2048);

const LIVE_PROBE_COUNT_FIELDS = Object.freeze([
  'discoveredRootCount', 'scannedRootCount', 'discoveredElementCount', 'scannedElementCount', 'candidateNodeCount',
  'visibleFrameCount', 'unreadableVisibleFrameCount', 'traversalErrorCount',
  'nonFrameTraversalErrorCount', 'unreadableFrameErrorCount', 'opaqueOverlayFrameCount',
  'opaqueAuthHintCount', 'opaqueBlockedHintCount',
  'rootBudget', 'elementBudget', 'nodeBudget', 'unreadableFrameBudget',
]);
const LIVE_PROBE_FLAG_FIELDS = Object.freeze([
  'accessibleTraversalComplete', 'mainDocumentTraversalComplete',
  'rootBudgetExceeded', 'elementBudgetExceeded', 'nodeBudgetExceeded', 'unreadableFrameBudgetExceeded',
]);

function sanitizedLiveProbeDiagnostics(live) {
  if (!live || typeof live !== 'object') return null;
  const diagnostics = {};
  for (const field of LIVE_PROBE_COUNT_FIELDS) {
    const value = live[field];
    if (Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000) diagnostics[field] = value;
  }
  for (const field of LIVE_PROBE_FLAG_FIELDS) {
    if (typeof live[field] === 'boolean') diagnostics[field] = live[field];
  }
  return Object.keys(diagnostics).length ? diagnostics : null;
}

function liveProbeDiagnosticField(live) {
  const diagnostics = sanitizedLiveProbeDiagnostics(live);
  return diagnostics ? { liveProbeDiagnostics: diagnostics } : {};
}

function unreadableFramesAreOnlyTraversalGap(live) {
  if (!live || typeof live !== 'object' || live.probeVersion !== 2) return false;
  const diagnostics = sanitizedLiveProbeDiagnostics(live);
  if (!diagnostics) return false;
  const unreadable = diagnostics.unreadableVisibleFrameCount;
  const requiredCounts = [
    'discoveredRootCount', 'scannedRootCount', 'discoveredElementCount', 'scannedElementCount',
    'candidateNodeCount', 'visibleFrameCount', 'unreadableVisibleFrameCount', 'traversalErrorCount',
    'nonFrameTraversalErrorCount', 'unreadableFrameErrorCount', 'opaqueOverlayFrameCount',
    'opaqueAuthHintCount', 'opaqueBlockedHintCount',
    'rootBudget', 'elementBudget', 'nodeBudget', 'unreadableFrameBudget',
  ];
  return requiredCounts.every((field) => Number.isSafeInteger(diagnostics[field]))
    && unreadable > 0
    && diagnostics.visibleFrameCount >= unreadable
    && diagnostics.traversalErrorCount === unreadable
    && diagnostics.unreadableFrameErrorCount === unreadable
    && diagnostics.nonFrameTraversalErrorCount === 0
    && diagnostics.opaqueOverlayFrameCount === 0
    && diagnostics.opaqueAuthHintCount === 0
    && diagnostics.opaqueBlockedHintCount === 0
    && diagnostics.accessibleTraversalComplete === true
    && diagnostics.mainDocumentTraversalComplete === true
    && diagnostics.unreadableFrameBudgetExceeded === false
    && unreadable <= diagnostics.unreadableFrameBudget
    && diagnostics.discoveredRootCount === diagnostics.scannedRootCount
    && diagnostics.discoveredElementCount === diagnostics.scannedElementCount
    && diagnostics.scannedRootCount <= diagnostics.rootBudget
    && diagnostics.scannedElementCount <= diagnostics.elementBudget
    && diagnostics.candidateNodeCount < diagnostics.nodeBudget
    && diagnostics.rootBudgetExceeded === false
    && diagnostics.elementBudgetExceeded === false
    && diagnostics.nodeBudgetExceeded === false;
}

function publicAmazonProductAsin(value) {
  const parsed = approvedAmazonUrl(value);
  if (!parsed || !isApprovedAmazonRetailHostname(parsed.hostname)) return null;
  const match = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i.exec(parsed.pathname);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Decide whether evidence may be retained. Missing current URL and a rendered
 * shell without business evidence both fail closed. The returned object holds
 * only safe metadata and may be persisted.
 */
export function classifyPageSafety({ currentUrl, dom, txt, pageText } = {}) {
  const urlSafety = classifyUrlSafety(currentUrl);
  const actual = presentUrl(currentUrl);
  if (!urlSafety.safe) return rememberRawPageUrl({ ...urlSafety, emptyShell: false }, actual);
  if (isBlockedEvidence({ currentUrl: actual, dom, txt, pageText })) {
    return rememberRawPageUrl({
      safe: false,
      code: 'ACCESS_BLOCKED',
      authSensitive: true,
      blocked: true,
      emptyShell: false,
      currentUrl: sanitizeUrl(actual),
    }, actual);
  }
  if (isAuthenticationEvidence({ currentUrl: actual, dom, txt, pageText })) {
    return rememberRawPageUrl({
      safe: false,
      code: 'AUTH_SENSITIVE',
      authSensitive: true,
      blocked: false,
      emptyShell: false,
      currentUrl: sanitizeUrl(actual),
    }, actual);
  }
  if (!isBusinessEvidence(dom, txt)) {
    return rememberRawPageUrl({
      safe: false,
      code: 'EMPTY_OR_UNVERIFIED_SHELL',
      authSensitive: false,
      blocked: false,
      emptyShell: true,
      currentUrl: sanitizeUrl(actual),
    }, actual);
  }
  return rememberRawPageUrl({
    safe: true,
    code: 'BUSINESS_PAGE',
    authSensitive: false,
    blocked: false,
    emptyShell: false,
    currentUrl: sanitizeUrl(actual),
  }, actual);
}

/** Read the live post-navigation URL without reading DOM text or credentials. */
export async function currentPageUrl(zn, storeId, navigation = null) {
  if (typeof zn?.currentUrl === 'function') {
    const value = await zn.currentUrl(storeId);
    return presentUrl(value);
  }
  if (typeof zn?.getCurrentUrl === 'function') {
    const value = await zn.getCurrentUrl(storeId);
    return presentUrl(value);
  }
  // Mocks and older adapters may already return the browser's live URL from
  // visit(). Never fall back to the requested target URL.
  return presentUrl(navigation?.url || navigation?.currentUrl);
}

/**
 * Inspect only the live URL plus boolean authentication/block selectors. This
 * gate intentionally does not require business evidence, so it can safely
 * authorize a diagnostic screenshot of a broken/empty business-page shell.
 */
async function classifyLivePageSafetyWithPolicy({
  zn, storeId, allowIsolatedFramesOnProductRead = false,
  enforceProductAsin = null,
} = {}) {
  let currentUrl = '';
  try { currentUrl = await currentPageUrl(zn, storeId); } catch { /* fail closed below */ }
  const urlSafety = classifyUrlSafety(currentUrl);
  if (!urlSafety.safe) return rememberRawPageUrl({ ...urlSafety, emptyShell: false }, currentUrl);
  if (enforceProductAsin !== null) {
    const expectedAsin = String(enforceProductAsin || '').trim().toUpperCase();
    const actualAsin = publicAmazonProductAsin(currentUrl);
    if (!/^[A-Z0-9]{10}$/.test(expectedAsin) || actualAsin !== expectedAsin) {
      return rememberRawPageUrl({
        safe: false, code: 'ASIN_URL_IDENTITY_MISMATCH', authSensitive: false,
        blocked: false, emptyShell: false, identityMismatch: true,
        currentUrl: urlSafety.currentUrl,
      }, currentUrl);
    }
  }
  if (typeof zn?.execExtract !== 'function') {
    return rememberRawPageUrl({
      safe: false, code: 'LIVE_SAFETY_PROBE_UNAVAILABLE', authSensitive: false,
      blocked: false, emptyShell: false, liveProbeUnavailable: true,
      currentUrl: urlSafety.currentUrl,
    }, currentUrl);
  }
  let live = null;
  try {
    const extractor = currentUrl === PRODUCT_BULK_SAFETY_URL && approvedAmazonUrl(currentUrl)
      ? PRODUCT_BULK_SAFETY_EXTRACTOR : POST_SCREENSHOT_SAFETY_EXTRACTOR;
    live = (await zn.execExtract(storeId, extractor, {
      timeoutMs: 10000, varName: '__ZN_POST_SCREENSHOT_SAFETY__',
    }))?.result || null;
  } catch { /* fail closed below */ }
  const diagnosticField = liveProbeDiagnosticField(live);
  let afterProbeUrl = '';
  try { afterProbeUrl = await currentPageUrl(zn, storeId); } catch { /* fail closed below */ }
  const afterProbeUrlSafety = classifyUrlSafety(afterProbeUrl);
  if (!afterProbeUrlSafety.safe || !afterProbeUrl || afterProbeUrl !== currentUrl) {
    return rememberRawPageUrl({
      ...(afterProbeUrlSafety.safe ? afterProbeUrlSafety : urlSafety),
      safe: false,
      code: 'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE',
      authSensitive: afterProbeUrlSafety.authSensitive === true
        || live?.looksLikeLogin === true || live?.looksBlocked === true,
      blocked: afterProbeUrlSafety.blocked === true || live?.looksBlocked === true,
      emptyShell: false,
      currentUrl: afterProbeUrlSafety.currentUrl || urlSafety.currentUrl,
      pageChangedDuringLiveProbe: true,
      ...diagnosticField,
    }, afterProbeUrl || currentUrl);
  }
  const validProbe = [1, 2].includes(live?.probeVersion)
    && typeof live.looksLikeLogin === 'boolean'
    && typeof live.looksBlocked === 'boolean'
    && typeof live.traversalComplete === 'boolean'
    && (live.probeVersion !== 2 || typeof live.accessibleTraversalComplete === 'boolean');
  if (!validProbe || live.liveDocument !== true) {
    return rememberRawPageUrl({
      safe: false, code: 'LIVE_SAFETY_PROBE_UNAVAILABLE',
      authSensitive: live?.looksLikeLogin === true || live?.looksBlocked === true,
      blocked: live?.looksBlocked === true, emptyShell: !live?.liveDocument, liveProbeUnavailable: true,
      transientEmptyDocument: validProbe && live.liveDocument === false
        && live.looksLikeLogin === false && live.looksBlocked === false
        && live.traversalComplete === true && live.accessibleTraversalComplete === true
        && live.discoveredElementCount === 0 && live.scannedElementCount === 0
        && live.candidateNodeCount === 0 && live.traversalErrorCount === 0,
      currentUrl: urlSafety.currentUrl,
      ...diagnosticField,
    }, currentUrl);
  }
  if (live.looksBlocked) {
    return rememberRawPageUrl({
      safe: false, code: 'ACCESS_BLOCKED', authSensitive: true, blocked: true,
      emptyShell: false, currentUrl: urlSafety.currentUrl, ...diagnosticField,
    }, currentUrl);
  }
  if (live.looksLikeLogin) {
    return rememberRawPageUrl({
      safe: false, code: 'AUTH_SENSITIVE', authSensitive: true, blocked: false,
      emptyShell: false, currentUrl: urlSafety.currentUrl, ...diagnosticField,
    }, currentUrl);
  }
  if (!live.traversalComplete) {
    const unreadableFramesOnly = unreadableFramesAreOnlyTraversalGap(live);
    if (
      allowIsolatedFramesOnProductRead === true
      && unreadableFramesOnly
    ) {
      return rememberRawPageUrl({
        safe: true, code: 'ASIN_MAIN_DOCUMENT_READABLE_WITH_OPAQUE_FRAMES',
        authSensitive: false, blocked: false, emptyShell: false,
        currentUrl: urlSafety.currentUrl,
        mainDocumentReadable: true, screenshotSafe: false,
        opaqueFramesPresent: true, isolatedUnreadableFrames: true,
        ...diagnosticField,
      }, currentUrl);
    }
    return rememberRawPageUrl({
      safe: false, code: 'LIVE_SAFETY_PROBE_INCOMPLETE', authSensitive: false,
      blocked: false, emptyShell: false, liveProbeUnavailable: true,
      traversalIncomplete: true, unreadableFramesOnly,
      currentUrl: urlSafety.currentUrl, ...diagnosticField,
    }, currentUrl);
  }
  return rememberRawPageUrl({
    safe: true, code: 'LIVE_PAGE_NON_SENSITIVE', authSensitive: false,
    blocked: false, emptyShell: false, currentUrl: urlSafety.currentUrl, ...diagnosticField,
  }, currentUrl);
}

/** Strict live gate used by every screenshot and every non-product collector. */
export async function classifyLivePageSafety({ zn, storeId } = {}) {
  return classifyLivePageSafetyWithPolicy({ zn, storeId });
}

/**
 * Narrow ASIN read gate. It can isolate inaccessible cross-origin frames only
 * on a public Amazon product-detail URL, only with the v2 probe proving the
 * accessible document complete and the opaque frames neither auth-like nor an
 * overlay. Screenshot callers must always use classifyLivePageSafety above.
 */
export async function classifyAsinProductReadSafety({ zn, storeId, expectedAsin } = {}) {
  const capabilities = zn?.securityCapabilities;
  const officialMainDocumentText = capabilities?.officialZiniaoWebDriverHttp === true
    && capabilities?.mainDocumentTextOnly === true;
  return classifyLivePageSafetyWithPolicy({
    zn, storeId,
    allowIsolatedFramesOnProductRead: officialMainDocumentText,
    enforceProductAsin: expectedAsin,
  });
}

/**
 * Close the screenshot TOCTOU window by verifying the live page again after
 * the image bytes have been produced. A different business URL is rejected as
 * well: the screenshot must correspond to the exact evidence page that was
 * judged immediately before capture.
 */
export async function verifyPageAfterScreenshot({
  zn, storeId, expectedUrl, dom, txt, pageText,
} = {}) {
  const liveSafety = await classifyLivePageSafety({ zn, storeId });
  if (!liveSafety.safe) return liveSafety;
  const liveRawUrl = rawPageIdentity(liveSafety);
  const safety = classifyPageSafety({
    currentUrl: liveRawUrl,
    dom,
    txt,
    pageText,
  });
  if (!safety.safe) return safety;
  const expected = presentUrl(expectedUrl);
  if (!expected || rawPageIdentity(safety) !== expected) {
    return rememberRawPageUrl({
      ...safety,
      safe: false,
      code: 'PAGE_CHANGED_DURING_SCREENSHOT',
      pageChangedDuringScreenshot: true,
    }, liveRawUrl);
  }
  return safety;
}

export const PAGE_SAFETY_CODES = Object.freeze({
  SAFE: 'BUSINESS_PAGE',
  AUTH: 'AUTH_SENSITIVE',
  BLOCKED: 'ACCESS_BLOCKED',
  SHELL: 'EMPTY_OR_UNVERIFIED_SHELL',
  URL_MISSING: 'CURRENT_URL_UNAVAILABLE',
  HOST: 'UNAPPROVED_AMAZON_HOST',
  CHANGED: 'PAGE_CHANGED_DURING_SCREENSHOT',
  LIVE_PROBE: 'LIVE_SAFETY_PROBE_UNAVAILABLE',
  LIVE_PROBE_INCOMPLETE: 'LIVE_SAFETY_PROBE_INCOMPLETE',
});
