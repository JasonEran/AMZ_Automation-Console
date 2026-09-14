import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  buildExtractorScript,
  parseJsonLoose,
  RESULT_MARKER,
  ZiniaoError,
} from './ziniao.js';
import { approvedAmazonUrl, assertApprovedAmazonUrl } from './amazon-url.js';
import { loadZiniaoCredentials } from './credentials.js';
import { SECURITY_CLEANUP_FAILED } from './evidence-cleanup.js';
import { classifyLivePageSafety, classifyUrlSafety } from './page-safety.js';
import { redactText } from './redact.js';
import { sanitizeZiniaoWebDriverLogs } from './ziniao-log-sanitizer.js';
import { normalizeProductUploadStatusRow } from './product-upload-status.js';

/**
 * Official Ziniao WebDriver transport.
 *
 * The Ziniao client owns browser/profile/proxy creation. This adapter only:
 *   1. starts the client in --run_type=web_driver --ipc_type=http mode;
 *   2. calls updateCore/getBrowserList/startBrowser/stopBrowser on localhost;
 *   3. attaches Selenium to the debuggingPort returned by startBrowser.
 *
 * It intentionally implements the same small surface as `Ziniao` (the
 * ziniao-cli/ZClaw adapter), so all nine check runners can share the same
 * orchestration and conservative verdict rules.
 */

const SUCCESS = 0;
const CORE_PROCESSING = -10000;
const PRODUCT_BULK_UPLOAD_PATH = '/product-search/bulk';

export function isApprovedProductBulkUploadUrl(value) {
  const parsed = approvedAmazonUrl(value);
  return Boolean(
    parsed
    && parsed.hostname.toLowerCase() === 'sellercentral.amazon.com'
    && parsed.port === ''
    && parsed.search === ''
    && parsed.hash === ''
    && parsed.pathname === PRODUCT_BULK_UPLOAD_PATH,
  );
}

export function isApprovedProductUploadSubmitLabel(value) {
  const label = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return new Set([
    'upload', 'upload file', 'upload your file', 'upload inventory file', 'submit file',
    '\u4e0a\u4f20', '\u4e0a\u4f20\u6587\u4ef6', '\u4e0a\u4f20\u5546\u54c1\u6587\u4ef6', '\u63d0\u4ea4\u6587\u4ef6',
    // Observed on the US bulk page in Chinese, 2026-09-12. Keep generic
    // "Submit" disallowed; only the exact product-upload action is approved.
    '\u63d0\u4ea4\u5546\u54c1',
  ]).has(label);
}

async function productUploadSubmitControlLabel(control, readiness = null) {
  const label = String(
    (await control.getText()) || (await control.getAttribute('aria-label'))
    || (await control.getAttribute('label')) || (await control.getAttribute('value')) || '',
  ).replace(/\s+/g, ' ').trim();
  if (!isApprovedProductUploadSubmitLabel(label)) return '';
  if (readiness) readiness.approvedLabels++;
  if (!await control.isDisplayed()) {
    if (readiness) readiness.notDisplayed++;
    return '';
  }
  if (!await control.isEnabled()) {
    if (readiness) readiness.nativeDisabled++;
    return '';
  }
  // KAT custom-element hosts can pass the native WebDriver enabled check even
  // while their own disabled state is set. Read that state without changing it.
  const disabled = await control.getAttribute('disabled');
  const ariaDisabled = String((await control.getAttribute('aria-disabled')) || '').trim().toLowerCase();
  if (disabled !== null) {
    if (readiness) readiness.disabledAttribute++;
    return '';
  }
  if (ariaDisabled && ariaDisabled !== 'false') {
    if (readiness) readiness.ariaDisabled++;
    return '';
  }
  return label;
}

// Observed in Amazon's FederatedBulkListings / AmazonTemplatePreview UI.
// These IDs identify one upload workflow; they do not approve generic Submit
// buttons elsewhere on the page. Never edit cells, select rows or invoke the
// application's internal submission methods while traversing this workflow.
const PRODUCT_UPLOAD_PREVIEW_MODAL = '#bulk-upload-page kat-modal.amazon-template-preview[visible]:not([visible="false"])';
const PRODUCT_UPLOAD_PREVIEW_SELECTORS = Object.freeze({
  open: '#bulk-upload-page kat-button#open-upload-preview-btn[data-testid="upload-preview-btn"]',
  submit: `${PRODUCT_UPLOAD_PREVIEW_MODAL} .online-spreadsheet-root kat-button#submit-button`,
  confirm: `${PRODUCT_UPLOAD_PREVIEW_MODAL} .online-spreadsheet-root kat-modal#submit-products-confirmation-modal[visible]:not([visible="false"]) kat-button#submit-products-confirmation-submit-with-errors-btn`,
});
const PRODUCT_UPLOAD_TOUR_OVERLAY = '.react-joyride__overlay[data-test-id="overlay"]';

async function visibleProductUploadElements(driver, By, selector) {
  const visible = [];
  for (const element of await driver.findElements(By.css(selector))) {
    if (await element.isDisplayed()) visible.push(element);
  }
  return visible;
}

async function dismissProductUploadPreviewTour(zn, storeId, driver, By, Key, state) {
  const overlays = await visibleProductUploadElements(driver, By, PRODUCT_UPLOAD_TOUR_OVERLAY);
  if (!overlays.length) return;
  if (overlays.length !== 1 || state.escapeSent) {
    throw new ZiniaoError('上传预览导览遮罩不唯一或再次出现，已停止操作', { code: 'UPLOAD_PREVIEW_TOUR_BLOCKED' });
  }
  const previewRoot = `${PRODUCT_UPLOAD_PREVIEW_MODAL} .online-spreadsheet-root`;
  const inspectPreview = async () => {
    if (!isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) throw new ZiniaoError('关闭上传导览前后页面地址发生变化');
    const modals = await visibleProductUploadElements(driver, By, PRODUCT_UPLOAD_PREVIEW_MODAL);
    const grids = await visibleProductUploadElements(driver, By, `${previewRoot} #online-spreadsheet-workbook`);
    const confirmations = await visibleProductUploadElements(driver, By, `${previewRoot} kat-modal#submit-products-confirmation-modal[visible]:not([visible="false"])`);
    if (modals.length !== 1 || grids.length !== 1 || confirmations.length) {
      throw new ZiniaoError('上传预览或业务确认状态不允许关闭导览', { code: 'UPLOAD_PREVIEW_TOUR_BLOCKED' });
    }
    return { modalId: await modals[0].getId(), gridId: await grids[0].getId() };
  };
  const original = await inspectPreview();
  const samePreview = async () => {
    const current = await inspectPreview();
    if (current.modalId !== original.modalId || current.gridId !== original.gridId) {
      throw new ZiniaoError('关闭导览期间上传预览发生变化');
    }
  };
  const beforeSafety = await classifyLivePageSafety({ zn, storeId });
  if (!beforeSafety.safe) throw new ZiniaoError('关闭上传导览前完整页面安全检查未通过');
  await samePreview();
  const currentOverlays = await visibleProductUploadElements(driver, By, PRODUCT_UPLOAD_TOUR_OVERLAY);
  if (currentOverlays.length !== 1 || await currentOverlays[0].getId() !== await overlays[0].getId()) {
    throw new ZiniaoError('上传导览在关闭前发生变化');
  }
  if (!isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) throw new ZiniaoError('关闭上传导览前页面地址发生变化');
  // Amazon's ProductTour explicitly enables Escape. Use its normal keyboard
  // dismissal; never remove an overlay or retry an intercepted submit click.
  // This allowance is consumed before the key action, across prepare/submit.
  state.escapeSent = true;
  await driver.actions().sendKeys(Key.ESCAPE).perform();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await samePreview();
    const remaining = await visibleProductUploadElements(driver, By, PRODUCT_UPLOAD_TOUR_OVERLAY);
    if (!remaining.length) {
      const afterSafety = await classifyLivePageSafety({ zn, storeId });
      if (!afterSafety.safe) throw new ZiniaoError('关闭上传导览后完整页面安全检查未通过');
      await samePreview();
      return;
    }
    if (remaining.length !== 1) throw new ZiniaoError('关闭上传导览后出现多个遮罩');
    await zn.sleep(250);
  }
  throw new ZiniaoError('上传预览导览未关闭，已停止提交', { code: 'UPLOAD_PREVIEW_TOUR_BLOCKED' });
}

async function productUploadPreviewControl(driver, By, action) {
  const selector = PRODUCT_UPLOAD_PREVIEW_SELECTORS[action];
  if (!selector) throw new ZiniaoError('未知的上传预览操作');
  if (action === 'submit') {
    const previewRoot = `${PRODUCT_UPLOAD_PREVIEW_MODAL} .online-spreadsheet-root`;
    const blockers = await driver.findElements(By.css(`${previewRoot} kat-progress,${previewRoot} #onlineSpreadsheetErrorBanner,${previewRoot} #allSkuFailedToLoadBanner,${previewRoot} .submit-in-progress-spinner-wrapper`));
    for (const blocker of blockers) if (await blocker.isDisplayed()) return null;
    const grids = await driver.findElements(By.css(`${previewRoot} #online-spreadsheet-workbook`));
    if (grids.length !== 1 || !await grids[0].isDisplayed()) return null;
  }
  const controls = await driver.findElements(By.css(selector));
  const ready = [];
  for (const control of controls) {
    // Detached controls may disappear while introspection finishes. A read
    // failure must not make another control eligible or trigger a click.
    if (!await control.isDisplayed() || !await control.isEnabled()) continue;
    const disabled = await control.getAttribute('disabled');
    const ariaDisabled = String(await control.getAttribute('aria-disabled') || '').toLowerCase().trim();
    const loadingAttribute = await control.getAttribute('loading');
    const loading = String(loadingAttribute ?? '').toLowerCase().trim();
    if (disabled !== null || (ariaDisabled && ariaDisabled !== 'false')
      || (loadingAttribute !== null && loading !== 'false')) continue;
    const label = String(await control.getAttribute('label') || await control.getText() || '').replace(/\s+/g, ' ').trim();
    if (label) ready.push({ control, label });
  }
  if (ready.length > 1) throw new ZiniaoError('上传预览操作控件不唯一，已拒绝点击');
  return ready[0] || null;
}

export function productUploadReceiptReference(value) {
  const url = approvedAmazonUrl(value);
  if (!url || url.hostname !== 'sellercentral.amazon.com' || url.port || url.hash
    || url.pathname !== '/listing/status'
    || url.searchParams.getAll('reference_id').length !== 1
    || url.searchParams.getAll('account_id').length !== 1
    || !url.searchParams.get('account_id')) return null;
  const batchId = url.searchParams.get('reference_id');
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(batchId || '') ? batchId : null;
}

async function readProductUploadReceipt(driver, batchId, expectedFileName) {
  // The status app marks the row matching reference_id AND account_id with
  // this class. Read only its visible batch and file-name cells, including
  // KAT's shadow DOM; do not inspect its action payloads or other history rows.
  const receipt = await driver.executeScript(
    'var batch=arguments[0],name=arguments[1],tables=document.querySelectorAll("#submission-status-table");'
    + 'if(tables.length!==1||String(tables[0].tagName).toLowerCase()!=="kat-data-table")return null;var table=tables[0],roots=[table],seen=[],nodes=0,cells=[];if(table.shadowRoot)roots.push(table.shadowRoot);'
    + 'for(var r=0;r<roots.length&&r<256&&nodes<12000;r++){var root=roots[r];if(seen.indexOf(root)>=0)continue;seen.push(root);'
    + 'var all=root.querySelectorAll("*");for(var i=0;i<all.length;i++){if(++nodes>12000)return null;'
    + 'var el=all[i];if(el.shadowRoot&&roots.indexOf(el.shadowRoot)<0)roots.push(el.shadowRoot);'
    + 'var id=el.getAttribute("data-cy-id")||"";if(/^(?:feed-batch-id|feed-batch-link|file-name-and-date):row-[0-9]+$/.test(id))cells.push(el);}}'
    + 'if(roots.length>256||nodes>=12000)return null;var matched=[];'
    + 'function visible(el){if(el.getClientRects().length===0)return false;var cur=el,depth=0;'
    + 'while(cur&&depth++<256){var st=getComputedStyle(cur);if(cur.hidden===true||st.display==="none"||st.visibility==="hidden"||st.visibility==="collapse"||Number(st.opacity)===0)return false;'
    + 'var root=cur.getRootNode();cur=cur.parentElement||(root&&root.host)||null;}return !cur;}'
    + 'if(!visible(table))return null;'
    + 'for(var c=0;c<cells.length;c++){var cell=cells[c],key=cell.getAttribute("data-cy-id")||"";'
    + 'if(!/^feed-batch-(?:id|link):row-[0-9]+$/.test(key)||!visible(cell)||!cell.classList.contains("latest-submission-table-row"))continue;'
    + 'if(String(cell.innerText||cell.textContent||"").trim()!==batch)continue;'
    + 'var row=key.match(/row-[0-9]+$/)[0],files=cells.filter(function(x){return x.getAttribute("data-cy-id")==="file-name-and-date:"+row&&visible(x)&&x.classList.contains("latest-submission-table-row");});'
    + 'if(files.length!==1)continue;var names=files[0].querySelectorAll(".file-name-content > b");'
    + 'if(names.length!==1||!visible(names[0])||String(names[0].textContent||"").trim()!==name)continue;matched.push(row);}'
    + 'return matched.length===1?{version:1,source:"AMAZON_UPLOAD_STATUS_ROW",batchId:batch,fileNameMatched:true,latestRowMatched:true}:null;',
    batchId, expectedFileName,
  );
  return receipt?.version === 1 && receipt.source === 'AMAZON_UPLOAD_STATUS_ROW'
    && receipt.batchId === batchId && receipt.fileNameMatched === true && receipt.latestRowMatched === true
    ? { version: 1, source: 'AMAZON_UPLOAD_STATUS_ROW', batchId, fileNameMatched: true, latestRowMatched: true } : null;
}

async function findProductUploadFileInputs(driver, By) {
  if (typeof driver.executeScript !== 'function') {
    return driver.findElements(By.css('input[type="file"]'));
  }
  const result = await driver.executeScript(
    'var roots=[document],seen=[],out=[],nodesSeen=0,maxRoots=240,maxNodes=60000;'
    + 'for(var ri=0;ri<roots.length&&ri<maxRoots&&nodesSeen<maxNodes;ri+=1){'
    + 'var root=roots[ri];if(seen.indexOf(root)>=0)continue;seen.push(root);'
    + 'var files=[];try{files=root.querySelectorAll("input[type=file]");}catch(e){return {complete:false,elements:[]};}'
    + 'for(var fi=0;fi<files.length;fi+=1)if(out.indexOf(files[fi])<0)out.push(files[fi]);'
    + 'var all=[];try{all=root.querySelectorAll("*");}catch(e2){return {complete:false,elements:[]};}'
    + 'for(var ai=0;ai<all.length&&nodesSeen<maxNodes;ai+=1){nodesSeen+=1;'
    + 'try{if(all[ai].shadowRoot&&roots.indexOf(all[ai].shadowRoot)<0)roots.push(all[ai].shadowRoot);}catch(e3){}}}'
    + 'return {complete:roots.length<=maxRoots&&nodesSeen<maxNodes,elements:out,rootCount:seen.length};',
  );
  if (!result || result.complete !== true || !Array.isArray(result.elements)) {
    throw new ZiniaoError('\u6279\u91cf\u4e0a\u4f20\u9875\u6587\u4ef6\u63a7\u4ef6\u7ed3\u6784\u904d\u5386\u4e0d\u5b8c\u6574');
  }
  return result.elements;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusCodeOf(payload) {
  const n = Number(payload?.statusCode);
  return Number.isFinite(n) ? n : null;
}

function cleanError(payload) {
  const value = payload?.err || payload?.LastError || payload?.statusMsg || payload?.msg || '未知异常';
  if (typeof value === 'string') return redactText(value.trim());
  try { return redactText(JSON.stringify(value)); } catch { return redactText(String(value).trim()); }
}

function credentialsFrom(config) {
  const resolved = loadZiniaoCredentials();
  return {
    credentials: {
      company: resolved.credentials.company || config.company || '',
      username: resolved.credentials.username || config.username || '',
      password: resolved.credentials.password || config.password || '',
    },
    source: resolved.source,
  };
}

function missingCredentialNames(credentials) {
  return [
    ['company', 'ZINIAO_COMPANY'],
    ['username', 'ZINIAO_USERNAME'],
    ['password', 'ZINIAO_PASSWORD'],
  ].filter(([key]) => !credentials[key]).map(([, env]) => env);
}

function startCommand(clientPath, socketPort) {
  const common = ['--run_type=web_driver', '--ipc_type=http', `--port=${socketPort}`];
  if (process.platform === 'darwin') return { file: 'open', args: ['-a', clientPath, '--args', ...common] };
  if (process.platform === 'linux') return { file: clientPath, args: ['--no-sandbox', ...common] };
  if (process.platform === 'win32') return { file: clientPath, args: common };
  throw new ZiniaoError(`WebDriver 模式暂不支持系统 ${process.platform}`);
}

export function hasOrdinaryZiniaoProcess(processList, clientPath) {
  const needle = String(clientPath || '').trim().toLowerCase();
  if (!needle) return false;
  return String(processList || '').split(/\r?\n/).some((line) => {
    const command = line.trim().toLowerCase();
    return command.includes(needle) && !command.includes('--run_type=web_driver');
  });
}

export async function otpInputIsReady(driver, input) {
  if (!input) return false;
  // Never read or return the OTP. Readiness is inferred only from browser-side
  // boolean UI/constraint state, and Selenium receives exactly one boolean.
  // Some Amazon MFA inputs are not marked required and have no placeholder.
  // Temporarily enable the native required constraint, inspect only its
  // valueMissing boolean, then restore the element exactly as it was.
  return (await driver.executeScript(
    'var e=arguments[0];if(!e||typeof e.matches!=="function")return false;'
    + 'try{if(e.disabled===true)return false;var aria="";'
    + 'if(typeof e.getAttribute==="function")aria=String(e.getAttribute("aria-invalid")||"").toLowerCase();'
    + 'if(aria&&aria!=="false")return false;var placeholderReady=false;'
    + 'if(typeof e.hasAttribute==="function"&&e.hasAttribute("placeholder")){'
    + 'try{placeholderReady=!e.matches(":placeholder-shown");}catch(ignore){placeholderReady=false;}}'
    + 'var originalValidity=e.validity;'
    + 'if(originalValidity&&originalValidity["valid"]===false&&originalValidity["valueMissing"]!==true)return false;'
    + 'var originalRequired=e.required===true,hadRequired=false,constraintReady=false,constraintValid=true;'
    + 'try{hadRequired=typeof e.hasAttribute==="function"&&e.hasAttribute("required");'
    + 'if(!originalRequired)e.required=true;var validity=e.validity;'
    + 'constraintReady=!!(e.willValidate===true&&validity&&validity["valueMissing"]===false);'
    + 'constraintValid=!(validity&&validity["valid"]===false);'
    + '}finally{if(!originalRequired){e.required=false;'
    + 'if(!hadRequired&&typeof e.removeAttribute==="function")e.removeAttribute("required");}}'
    + 'if(!placeholderReady&&!constraintReady)return false;'
    + 'if(!constraintValid)return false;return true;'
    + '}catch(ignore){return false;}',
    input,
  )) === true;
}

const MUTATING_OR_UNKNOWN_ACTION_RE = /(?:save|submit|create|delete|remove|enable|disable|pause|resume|edit|manage|add account|sign out|log out|forgot|password|recover|register|sign up|保存|提交|创建|删除|移除|启用|停用|暂停|恢复|编辑|管理|添加账户|退出|忘记|密码|找回|注册)/i;
const VOC_ASIN_RE = /\bB0[A-Z0-9]{8}\b/g;
const VOC_DETAIL_ACTION_RE = /^(?:view details|see details|details|查看详情)$/i;

function normalizedUiText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function observedAsins(value) {
  return [...new Set((String(value || '').toUpperCase().match(VOC_ASIN_RE) || []))];
}

function approvedSellerCentralSameOriginUrl(value, beforeUrl) {
  const target = approvedAmazonUrl(value, { base: beforeUrl });
  const before = approvedAmazonUrl(beforeUrl);
  if (!target || !before || target.origin !== before.origin) return null;
  if (!/^sellercentral\./i.test(target.hostname) || !/^sellercentral\./i.test(before.hostname)) return null;
  return target;
}

function isKnownVocReadOnlyRoute(value) {
  const parsed = approvedAmazonUrl(value);
  return !!parsed && /(?:voice-of-the-customer|customer-experience|cx-health|(?:^|[\/_-])ncx(?:[\/_-]|$))/i.test(parsed.pathname);
}

function vocUrlObservesAsin(value, asin) {
  const target = String(asin || '').toUpperCase();
  if (!/^B0[A-Z0-9]{8}$/.test(target)) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(String(value || '')).toUpperCase();
  } catch {
    decoded = String(value || '').toUpperCase();
  }
  return new RegExp(`(?:^|[^A-Z0-9])${target}(?:[^A-Z0-9]|$)`).test(decoded);
}

export function isApprovedVocDetailAction({ asin, rowText, label, href, beforeUrl } = {}) {
  const targetAsin = String(asin || '').toUpperCase();
  const exactRowAsins = observedAsins(rowText);
  const exactLabel = normalizedUiText(label);
  if (!/^B0[A-Z0-9]{8}$/.test(targetAsin) || exactRowAsins.length !== 1 || exactRowAsins[0] !== targetAsin) return false;
  if (!VOC_DETAIL_ACTION_RE.test(exactLabel) || MUTATING_OR_UNKNOWN_ACTION_RE.test(exactLabel)) return false;
  if (!href) return true;
  const parsed = approvedSellerCentralSameOriginUrl(href, beforeUrl);
  return !!parsed && (parsed.pathname === approvedAmazonUrl(beforeUrl)?.pathname || isKnownVocReadOnlyRoute(parsed.href));
}

// Runs only inside the already-approved Ziniao-owned Seller Central page and
// returns booleans/counts. No page text, labels, URLs or form values cross the
// WebDriver boundary.
const VOC_DETAIL_SURFACE_PROBE = [
  '/* amzguard-voc-detail-surface/v1 */',
  'var expected=String(arguments[0]||"").toUpperCase();',
  'var norm=function(v){return String(v==null?"":v).replace(/\\s+/g," ").trim();};',
  'var visible=function(el){try{if(!el||!el.getClientRects||el.getClientRects().length===0)return false;var s=window.getComputedStyle?window.getComputedStyle(el):null;return !s||(s.display!=="none"&&s.visibility!=="hidden"&&parseFloat(s.opacity||"1")!==0);}catch(e){return false;}};',
  'var roots=[document],seenRoots=[];',
  'for(var ri=0;ri<roots.length&&ri<80;ri++){var rr=roots[ri];if(seenRoots.indexOf(rr)>=0)continue;seenRoots.push(rr);var all=[];try{all=rr.querySelectorAll("*");}catch(e1){}for(var ai=0;ai<all.length&&ai<2500;ai++){try{if(all[ai].shadowRoot&&roots.indexOf(all[ai].shadowRoot)<0)roots.push(all[ai].shadowRoot);}catch(e2){}}}',
  'var deepText=function(el){var out="";try{out=norm(el.innerText||el.textContent);}catch(e3){}try{if(el.shadowRoot)out=norm(out+" "+(el.shadowRoot.textContent||""));}catch(e4){}return out;};',
  'var detailRe=/(?:return reason|customer issue|customer problem|customer feedback|ncx details?|return details?|\\u9000\\u8d27\\u539f\\u56e0|\\u5ba2\\u6237\\u95ee\\u9898|\\u4e70\\u5bb6\\u53cd\\u9988|\\u76f8\\u5173\\u8bb0\\u5f55)/i;',
  'var dialogs=0,drawers=0,inlineExpected=false,expectedInSurface=false;',
  'var scan=function(selector,kind){for(var r=0;r<roots.length;r++){var nodes=[];try{nodes=roots[r].querySelectorAll(selector);}catch(e5){}for(var n=0;n<nodes.length&&n<300;n++){if(!visible(nodes[n]))continue;var t=deepText(nodes[n]).toUpperCase();if(kind==="dialog")dialogs++;if(kind==="drawer")drawers++;var aa=t.match(/\\bB0[A-Z0-9]{8}\\b/g)||[],uniq=[];for(var u=0;u<aa.length;u++)if(uniq.indexOf(aa[u])<0)uniq.push(aa[u]);if(expected&&uniq.length===1&&uniq[0]===expected&&detailRe.test(t)){expectedInSurface=true;if(kind==="inline")inlineExpected=true;}}}};',
  'scan("[role=dialog],[aria-modal=true],kat-modal,[data-testid*=modal]","dialog");',
  'scan("[role=complementary],kat-drawer,[data-testid*=drawer]","drawer");',
  'scan("[data-testid*=detail],[id*=detail],[class*=detail],tr,[role=row],kat-table-row","inline");',
  'return {probeVersion:1,visibleDialogCount:dialogs,visibleDrawerCount:drawers,inlineExpected:inlineExpected,expectedInSurface:expectedInSurface};',
].join('\n');

const VOC_SCOPED_DETAIL_TEXT = [
  '/* amzguard-voc-scoped-detail-text/v1 */',
  'var expected=String(arguments[0]||"").toUpperCase();',
  'var roots=[document],seenRoots=[];for(var ri=0;ri<roots.length&&ri<80;ri++){var rr=roots[ri];if(seenRoots.indexOf(rr)>=0)continue;seenRoots.push(rr);var all=[];try{all=rr.querySelectorAll("*");}catch(e1){}for(var ai=0;ai<all.length&&ai<2500;ai++){try{if(all[ai].shadowRoot&&roots.indexOf(all[ai].shadowRoot)<0)roots.push(all[ai].shadowRoot);}catch(e2){}}}',
  'var auth=false,blocked=false;for(var sr=0;sr<roots.length;sr++){try{auth=auth||!!roots[sr].querySelector("#ap_email,#ap_password,#auth-mfa-otpcode,input[autocomplete=one-time-code],input[type=password],[data-testid*=passkey],[data-test*=passkey]");blocked=blocked||!!roots[sr].querySelector("#captchacharacters,form[action*=validateCaptcha],img[src*=captcha],[id*=robot-check],[class*=robot-check]");}catch(e0){auth=true;}}',
  'var safetyNodes=[];for(var sr2=0;sr2<roots.length;sr2++){var sf=[];try{sf=roots[sr2].querySelectorAll("[role=dialog],button,[role=button],h1,h2,label,kat-button,kat-modal");}catch(e00){auth=true;}for(var sfi=0;sfi<sf.length&&safetyNodes.length<1000;sfi++)if(safetyNodes.indexOf(sf[sfi])<0)safetyNodes.push(sf[sfi]);}for(var sn=0;sn<safetyNodes.length&&sn<500;sn++){var st="";try{st=String((safetyNodes[sn].getAttribute&&(safetyNodes[sn].getAttribute("aria-label")||safetyNodes[sn].getAttribute("label")))||safetyNodes[sn].innerText||safetyNodes[sn].textContent||"").replace(/\\s+/g," ").trim();}catch(e01){}if(/(?:use (?:a )?passkey to (?:sign|log) in|sign in with (?:a )?passkey|verification code|two-step verification|robot check|enter the characters you see)/i.test(st)){auth=auth||!/robot check|characters you see/i.test(st);blocked=blocked||/robot check|characters you see/i.test(st);}if(/(?:\\u4f7f\\u7528(?:(?:\\u901a\\u884c)?\\u5bc6\\u94a5|passkey)\\u767b\\u5f55|\\u63a5(?:\\u53d7|\\u6536)\\u9a8c\\u8bc1\\u7801|\\u4e24\\u6b65\\u9a8c\\u8bc1|\\u9a8c\\u8bc1\\u7801)/i.test(st))auth=true;}if(auth||blocked)return {probeVersion:1,sensitive:true,text:"",source:null};',
  'var norm=function(v){return String(v==null?"":v).replace(/\\s+/g," ").trim();};',
  'var visible=function(el){try{if(!el||!el.getClientRects||el.getClientRects().length===0)return false;var s=window.getComputedStyle?window.getComputedStyle(el):null;return !s||(s.display!=="none"&&s.visibility!=="hidden"&&parseFloat(s.opacity||"1")!==0);}catch(e){return false;}};',
  'var deepText=function(el){var out="";try{out=norm(el.innerText||el.textContent);}catch(e3){}var nodes=[];try{nodes=el.querySelectorAll("*");}catch(e4){}for(var i=0;i<nodes.length&&i<2500;i++){try{if(nodes[i].shadowRoot)out=norm(out+" "+(nodes[i].shadowRoot.textContent||""));}catch(e5){}}try{if(el.shadowRoot)out=norm(out+" "+(el.shadowRoot.textContent||""));}catch(e6){}return out;};',
  'var detailRe=/(?:return reason|customer issue|customer problem|customer feedback|ncx details?|return details?|\\u9000\\u8d27\\u539f\\u56e0|\\u5ba2\\u6237\\u95ee\\u9898|\\u4e70\\u5bb6\\u53cd\\u9988|\\u76f8\\u5173\\u8bb0\\u5f55)/i;',
  'var asins=function(t){var a=String(t||"").toUpperCase().match(/\\bB0[A-Z0-9]{8}\\b/g)||[],u=[];for(var i=0;i<a.length;i++)if(u.indexOf(a[i])<0)u.push(a[i]);return u;};var exact=function(t){var u=asins(t);return u.length===1&&u[0]===expected;};',
  'var selectors=["[role=dialog],[aria-modal=true],kat-modal,[data-testid*=modal]","[role=complementary],kat-drawer,[data-testid*=drawer]","[data-testid*=detail],[id*=detail],[class*=detail],tr,[role=row],kat-table-row"];',
  'for(var si=0;si<selectors.length;si++){for(var r=0;r<roots.length;r++){var nodes=[];try{nodes=roots[r].querySelectorAll(selectors[si]);}catch(e7){}for(var n=0;n<nodes.length&&n<500;n++){if(!visible(nodes[n]))continue;var t=deepText(nodes[n]);if(exact(t)&&detailRe.test(t))return {probeVersion:1,sensitive:false,text:t,source:si===0?"dialog":si===1?"drawer":"inline"};}}}',
  'var href="";try{href=decodeURIComponent(String(location.href||"")).toUpperCase();}catch(e8){}var urlBound=expected&&new RegExp("(?:^|[^A-Z0-9])"+expected+"(?:[^A-Z0-9]|$)").test(href);if(urlBound){var main=null;try{main=document.querySelector("main,[role=main]")||document.body;}catch(e9){main=document.body;}var mt=main?deepText(main):"",ma=asins(mt);if(detailRe.test(mt)&&(ma.length===0||(ma.length===1&&ma[0]===expected)))return {probeVersion:1,sensitive:false,text:mt,source:"url-main"};}',
  'return {probeVersion:1,sensitive:false,text:"",source:null};',
].join('\n');

export function isApprovedAccountSwitcherExpander({ label, ariaExpanded } = {}) {
  const text = String(label || '').trim();
  if (!/^false$/i.test(String(ariaExpanded || ''))) return false;
  if (MUTATING_OR_UNKNOWN_ACTION_RE.test(text)) return false;
  const exactLabel = /^(?:marketplaces?|select marketplace|choose marketplace|market|select market|country\s*\/\s*region|account|站点|选择站点|商城|选择商城|国家\s*\/\s*地区|账户)$/i.test(text);
  // The caller already limits candidates to explicit aria-expanded controls.
  // An unfamiliar label must never become clickable merely because a future
  // page reuses an id, data-test value or aria-controls target.
  return exactLabel;
}

export function isApprovedExistingAccountLink({ label, href } = {}) {
  const text = String(label || '').trim();
  const target = String(href || '').trim();
  if (!text || !target || text.length > 200 || MUTATING_OR_UNKNOWN_ACTION_RE.test(`${text} ${target}`)) return false;
  const parsed = approvedAmazonUrl(target, { base: 'https://www.amazon.com' });
  if (!parsed || parsed.port) return false;
  if (!/^\/ap\/signin(?:\/|$)/i.test(parsed.pathname)) return false;
  // A saved-account card must expose a masked/full account identity. A generic
  // sign-in/help link is not sufficient proof and therefore fails closed.
  return /@|\b(?:\*{2,}|x{2,})\d{2,4}\b/i.test(text);
}

export function isApprovedAmazonLoginAction(kind, label) {
  const text = String(label || '').trim();
  const patterns = {
    continue: /^(?:continue|next|继续|下一步)$/i,
    passkey: /^(?:使用(?:通行密钥|密钥|passkey)登录|use (?:a )?passkey to (?:sign|log) in|sign in with (?:a )?passkey)$/i,
    sendOtp: /^(?:发送一次性密码|发送验证码|send (?:the )?(?:one-time password|verification code|code))$/i,
    acceptOtp: /^(?:接受验证码|接收验证码|获取验证码|accept (?:the )?verification code|get (?:the )?verification code|receive (?:the )?(?:verification )?code)$/i,
    signIn: /^(?:sign in|log in|登录|登入)$/i,
    selectAccount: /^(?:select account|选择账户)$/i,
  };
  if (!text) return false;
  // “一次性密码” contains the ordinary Chinese word for password, but this
  // one exact Amazon MFA action was explicitly approved by the store owner.
  // Do the narrow match before the generic password-action rejection; all
  // other unknown/password labels remain denied.
  if (kind === 'sendOtp') return patterns.sendOtp.test(text) === true;
  if (MUTATING_OR_UNKNOWN_ACTION_RE.test(text)) return false;
  return patterns[kind]?.test(text) === true;
}

function validPort(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function loopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost') return '127.0.0.1';
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return '::1';
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255) && Number(ipv4[1]) === 127) return host;
  const mapped = /^::ffff:(127(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped && mapped[1].split('.').every((part) => Number(part) <= 255)) return host;
  return null;
}

/** Convert the official response into a Selenium debugger address without ever
 * allowing the driver to connect to a remote host. Numeric ports are explicitly
 * anchored to 127.0.0.1; address-shaped responses must themselves be loopback. */
export function parseLoopbackDebuggingEndpoint(value) {
  const numericPort = validPort(value);
  if (numericPort !== null) {
    return { host: '127.0.0.1', port: numericPort, address: `127.0.0.1:${numericPort}` };
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[?#]/.test(raw)) return null;

  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.pathname !== '/') return null;
  const host = loopbackHost(parsed.hostname);
  const port = validPort(parsed.port);
  if (!host || port === null) return null;
  const addressHost = host.includes(':') ? `[${host}]` : host;
  return { host, port, address: `${addressHost}:${port}` };
}

async function defaultDriverFactory({ debuggingAddress, driverPath, pageLoadTimeoutMs, pageLoadStrategy }) {
  const [{ Builder }, chrome] = await Promise.all([
    import('selenium-webdriver'),
    import('selenium-webdriver/chrome.js'),
  ]);
  const strategy = ['normal', 'eager', 'none'].includes(pageLoadStrategy) ? pageLoadStrategy : 'none';
  const options = new chrome.Options()
    .debuggerAddress(debuggingAddress)
    .setPageLoadStrategy(strategy);
  const builder = new Builder().forBrowser('chrome').setChromeOptions(options);
  if (driverPath) builder.setChromeService(new chrome.ServiceBuilder(driverPath));
  const driver = await builder.build();
  await driver.manage().setTimeouts({
    pageLoad: pageLoadTimeoutMs,
    script: Math.max(30000, pageLoadTimeoutMs),
  });
  return driver;
}

function resolveDriverPath(browserPath, configuredPath = '') {
  if (configuredPath) return configuredPath;
  if (!browserPath) return '';
  let dir = String(browserPath);
  const base = path.basename(dir).toLowerCase();
  if (base === 'superbrowser' || base === 'superbrowser.exe' || base === 'chrome' || base === 'chrome.exe') {
    dir = path.dirname(dir);
  } else {
    try {
      if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
    } catch { /* the response may point to a path not mounted in this process */ }
  }
  const driverName = process.platform === 'win32' ? 'webdriver.exe' : 'webdriver';
  const candidates = [
    path.join(dir, driverName),
    path.join(dir, 'ziniaobrowser.app', 'Contents', 'MacOS', driverName),
    path.join(dir, 'superbrowser.app', 'Contents', 'MacOS', driverName),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

export class ZiniaoWebDriver {
  constructor({ config = {}, logger = console, fetchImpl = globalThis.fetch, execFileImpl = execFile, driverFactory, sleepImpl = sleep } = {}) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.execFileImpl = execFileImpl;
    this.driverFactory = driverFactory || defaultDriverFactory;
    this.sleep = sleepImpl;
    this.socketPort = Number(config.socketPort || 18888);
    this.baseUrl = `http://127.0.0.1:${this.socketPort}`;
    this.timeoutMs = Math.max(120000, Number(config.httpTimeoutMs || 120000));
    const resolvedCredentials = credentialsFrom(config);
    this.credentials = resolvedCredentials.credentials;
    this.credentialSource = resolvedCredentials.source;
    this.clientLogDir = config.clientLogDir || '';
    this.clientLogPlatform = config.clientLogPlatform || process.platform;
    this.sessions = new Map();
    this.clientStartedByUs = false;
    this.coreReady = false;
    this.securityCapabilities = Object.freeze({
      officialZiniaoWebDriverHttp: true,
      mainDocumentTextOnly: true,
    });
  }

  async version() {
    return `ziniao-webdriver-http (${this.baseUrl})`;
  }

  async request(action, extra = {}, { timeoutMs = this.timeoutMs, includeCredentials = true } = {}) {
    const body = {
      ...(includeCredentials ? this.credentials : {}),
      action,
      requestId: randomUUID(),
      ...extra,
    };
    const sanitizeClientLogs = () => {
      if (!includeCredentials) return;
      try {
        sanitizeZiniaoWebDriverLogs({
          credentials: this.credentials,
          homeDir: process.env.HOME,
          logDir: this.clientLogDir,
          platform: this.clientLogPlatform,
        });
      } catch (error) {
        throw new ZiniaoError(`紫鸟客户端凭据日志脱敏失败: ${redactText(error.message)}`, { action });
      }
    };
    sanitizeClientLogs();
    let response;
    let raw;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      raw = await response.text();
    } catch (e) {
      throw new ZiniaoError(`紫鸟 WebDriver HTTP 服务不可用 (${this.baseUrl}): ${e.message}`, { action });
    } finally {
      sanitizeClientLogs();
    }
    const payload = parseJsonLoose(raw);
    if (!response.ok || !payload) {
      throw new ZiniaoError(`紫鸟 WebDriver ${action} 返回无效响应: HTTP ${response.status}`, {
        action,
        response: redactText(raw).slice(0, 2000),
      });
    }
    return payload;
  }

  async ping() {
    try {
      const payload = await this.request('getRunningInfo', {}, { timeoutMs: 5000, includeCredentials: false });
      return statusCodeOf(payload) === SUCCESS;
    } catch {
      return false;
    }
  }

  async startClient() {
    if (await this.ping()) return false;
    if (!this.config.autoStart) {
      throw new ZiniaoError(`紫鸟 WebDriver HTTP 服务未启动 (${this.baseUrl})，且 webdriver.autoStart=false`);
    }
    const clientPath = this.config.clientPath;
    if (!clientPath) throw new ZiniaoError('未配置 webdriver.clientPath');
    if (path.isAbsolute(clientPath) && !fs.existsSync(clientPath)) {
      throw new ZiniaoError(`紫鸟客户端不存在: ${clientPath}`);
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const processList = await new Promise((resolve) => {
        this.execFileImpl('ps', ['-axo', 'command='], { encoding: 'utf8' }, (error, stdout = '') => {
          resolve(error ? '' : String(stdout || ''));
        });
      });
      if (hasOrdinaryZiniaoProcess(processList, clientPath)) {
        throw new ZiniaoError('检测到普通紫鸟主进程仍在运行。请先从紫鸟客户端正常退出，再启动 WebDriver HTTP 模式');
      }
    }
    const cmd = startCommand(clientPath, this.socketPort);
    this.logger.info?.(`启动紫鸟 WebDriver 客户端: ${cmd.file} ${cmd.args.join(' ')}`);
    await new Promise((resolve, reject) => {
      const child = this.execFileImpl(cmd.file, cmd.args, { windowsHide: false }, (err) => {
        // A long-lived GUI process normally does not invoke this callback until
        // exit. Immediate spawn/launch failures do, and must not be swallowed.
        if (err && !this.clientStartedByUs) reject(err);
      });
      child?.unref?.();
      this.clientStartedByUs = true;
      resolve();
    }).catch((e) => {
      throw new ZiniaoError(`启动紫鸟客户端失败: ${e.message}`);
    });

    const deadline = Date.now() + Math.max(10000, Number(this.config.startTimeoutMs || 60000));
    while (Date.now() < deadline) {
      if (await this.ping()) return true;
      await this.sleep(1000);
    }
    throw new ZiniaoError(`紫鸟客户端已拉起，但 ${this.baseUrl} 在等待期内没有就绪`);
  }

  async ensureCredentials() {
    const missing = missingCredentialNames(this.credentials);
    if (missing.length) {
      throw new ZiniaoError(`WebDriver 凭据未配置：请在本机设置 ${missing.join(', ')}（不要写入仓库）`);
    }
  }

  async ensureCore() {
    if (this.coreReady) return;
    await this.ensureCredentials();
    await this.startClient();
    const deadline = Date.now() + Math.max(120000, Number(this.config.coreTimeoutMs || 600000));
    let last = null;
    while (Date.now() < deadline) {
      last = await this.request('updateCore');
      const code = statusCodeOf(last);
      if (code === SUCCESS) {
        this.coreReady = true;
        return;
      }
      if (code !== CORE_PROCESSING) {
        throw new ZiniaoError(`updateCore 失败 (${code}): ${cleanError(last)}`, { payload: last });
      }
      this.logger.info?.(`紫鸟内核准备中: ${cleanError(last)}`);
      await this.sleep(Math.max(1000, Number(this.config.corePollMs || 2000)));
    }
    throw new ZiniaoError(`updateCore 超时: ${cleanError(last)}`, { payload: last });
  }

  async doctor() {
    const lines = [];
    const missing = missingCredentialNames(this.credentials);
    if (missing.length) lines.push(`✗ WebDriver 凭据缺失: ${missing.join(', ')}`);
    else lines.push(`✓ WebDriver 凭据可用，来源: ${this.credentialSource}（值未显示）`);

    const clientPath = this.config.clientPath || '';
    if (clientPath && (!path.isAbsolute(clientPath) || fs.existsSync(clientPath))) {
      lines.push(`✓ 紫鸟客户端: ${clientPath}`);
    } else {
      lines.push(`✗ 紫鸟客户端路径无效: ${clientPath || '(未配置)'}`);
    }

    const alive = await this.ping();
    lines.push(alive
      ? `✓ WebDriver HTTP 服务: ${this.baseUrl}`
      : `✗ WebDriver HTTP 服务未启动: ${this.baseUrl}（先完全退出普通紫鸟主进程，再以 WebDriver 模式启动）`);
    lines.push(`✓ HTTP 超时: ${this.timeoutMs}ms（官方要求 >=120000ms）`);

    let authorized = false;
    if (alive && !missing.length) {
      try {
        const payload = await this.request('updateCore');
        const code = statusCodeOf(payload);
        if (code === SUCCESS || code === CORE_PROCESSING) {
          authorized = true;
          lines.push(code === SUCCESS
            ? '✓ WebDriver 登录权限与内核接口可用'
            : `✓ WebDriver 登录权限可用，内核仍在处理中: ${cleanError(payload)}`);
        } else {
          lines.push(`✗ WebDriver 登录/权限验证失败 (${code}): ${cleanError(payload)}`);
        }
      } catch (e) {
        lines.push(`✗ WebDriver 登录/权限验证失败: ${e.message}`);
      }
    }

    return {
      ok: !missing.length && !!clientPath
        && (!path.isAbsolute(clientPath) || fs.existsSync(clientPath))
        && alive && authorized,
      text: lines.join('\n'),
    };
  }

  async storeList() {
    await this.ensureCore();
    const payload = await this.request('getBrowserList');
    const code = statusCodeOf(payload);
    if (code !== SUCCESS) throw new ZiniaoError(`getBrowserList 失败 (${code}): ${cleanError(payload)}`, { payload });
    return (payload.browserList || []).map((item) => ({
      id: String(item.browserId || item.browserOauth || ''),
      browserOauth: item.browserOauth || null,
      name: item.browserName || '',
      platform: item.platform_name || '',
      siteId: item.siteId || null,
      raw: item,
    }));
  }

  async storeResolve({ name, id }) {
    const list = await this.storeList();
    const hit = id
      ? list.find((s) => String(s.id) === String(id) || String(s.browserOauth) === String(id))
      : list.find((s) => s.name === name);
    if (!hit) throw new ZiniaoError(`紫鸟店铺不存在: ${name || '[店铺 ID 已隐藏]'}`);
    return { raw: hit.raw, storeId: hit.id, storeName: hit.name };
  }

  async storeOpen({ name, id, market = '', url: openUrl, headless = false, privacy = false, timeoutMs } = {}) {
    await this.ensureCore();
    let ref = null;
    if (id) {
      // Numeric IDs are preferred by the official API. If this is an encrypted
      // browserOauth, resolve it from the list and send the matching field.
      const list = await this.storeList();
      ref = list.find((s) => String(s.id) === String(id) || String(s.browserOauth) === String(id)) || null;
    } else if (name) {
      const list = await this.storeList();
      ref = list.find((s) => s.name === name) || null;
    }
    if (!ref && !id) throw new ZiniaoError(`紫鸟店铺不存在: ${name}`);

    // The official high-level flow uses browserOauth. Although the API also
    // documents browserId, current macOS V6 can resolve that ID in the list yet
    // fail OpenBrowser with "ContainerId is missing". Prefer the encrypted ID
    // returned by getBrowserList, with an opt-out for clients where numeric ID
    // is known to work.
    const preferOauth = this.config.preferBrowserOauth !== false && !!ref?.browserOauth;
    const browserId = preferOauth
      ? null
      : (ref?.raw?.browserId || (/^\d+$/.test(String(id || '')) ? String(id) : null));
    const browserOauth = preferOauth
      ? ref.browserOauth
      : (ref?.browserOauth || (!browserId ? String(id || '') : null));
    // Amazon's Ziniao-assisted Passkey flow uses a native Chromium chooser.
    // A genuinely headless store browser has no native window for xdotool to
    // confirm, even when the collector itself runs inside an invisible Xvfb
    // desktop. Keep headless available only when automatic login is disabled.
    const effectiveHeadless = !!headless && this.config.autoLoginAmazon === false;
    if (headless && !effectiveHeadless) {
      this.logger.info?.(`[${ref?.name || name || '店铺'}] 自动登录需要原生窗口，已在后台 X 显示中关闭 headless`);
    }
    const startArgs = {
      ...(browserId ? { browserId } : { browserOauth }),
      isHeadless: effectiveHeadless,
      isWaitPluginUpdate: 0,
      isWebDriverReadOnlyMode: 0,
      privacyMode: !!privacy,
      cookieTypeLoad: 0,
      cookieTypeSave: 0,
      runMode: '1',
      isLoadUserPlugin: false,
      pluginIdType: 1,
      notPromptForDownload: 1,
      windowRatio: Number(this.config.windowRatio ?? 100),
    };
    let payload;
    try {
      payload = await this.request('startBrowser', startArgs, {
        timeoutMs: Math.max(this.timeoutMs, Number(timeoutMs || 180000)),
      });
    } catch (e) {
      // The HTTP call can time out after the native profile has started only
      // halfway. Without an explicit cleanup that stale profile blocks every
      // later retry for the same shop. Use the documented stopBrowser action
      // to make the runner's next attempt genuinely self-healing.
      if (/timeout|timed out|aborted/i.test(String(e?.message || e))) {
        this.logger.warn?.(`[${ref?.name || name || '店铺'}] startBrowser 超时，清理可能残留的店铺进程后重试`);
        try {
          await this.request('stopBrowser', {
            ...(browserId ? { browserId } : { browserOauth }),
            duplicate: 0,
          }, { timeoutMs: 30000 });
        } catch { /* the original timeout remains the authoritative error */ }
      }
      throw e;
    }
    const code = statusCodeOf(payload);
    if (code !== SUCCESS) throw new ZiniaoError(`startBrowser 失败 (${code}): ${cleanError(payload)}`, { payload });
    if (!payload.debuggingPort) throw new ZiniaoError('startBrowser 成功但未返回 debuggingPort', { payload });
    const debuggingEndpoint = parseLoopbackDebuggingEndpoint(payload.debuggingPort);
    if (!debuggingEndpoint) {
      // startBrowser has already created a profile. Clean it up without ever
      // passing the untrusted endpoint to Selenium or including its value in an
      // exception/log/report.
      try {
        await this.request('stopBrowser', {
          ...(browserId ? { browserId } : { browserOauth }),
          duplicate: payload.duplicate || 0,
        });
      } catch { /* fail closed is authoritative; cleanup is best-effort */ }
      throw new ZiniaoError('startBrowser 返回的调试端点不是本机 loopback，已拒绝 Selenium 连接');
    }

    const storeId = String(browserId || browserOauth || ref?.id || name);
    const driverPath = resolveDriverPath(payload.browserPath, this.config.driverPath || '');
    if (!driverPath) {
      this.logger.warn?.(`未在 ${payload.browserPath || 'startBrowser 响应'} 中找到内核自带 webdriver，将交给 Selenium Manager 匹配 core_version=${payload.core_version || payload.coreVersion || '?'}`);
    }
    let driver = null;
    let sessionRegistered = false;
    try {
      driver = await this.driverFactory({
        debuggingPort: debuggingEndpoint.port,
        debuggingAddress: debuggingEndpoint.address,
        coreVersion: payload.core_version || payload.coreVersion,
        coreType: payload.core_type || payload.coreType,
        browserPath: payload.browserPath || '',
        driverPath,
        pageLoadTimeoutMs: Number(this.config.pageLoadTimeoutMs || 120000),
        pageLoadStrategy: ['normal', 'eager', 'none'].includes(this.config.pageLoadStrategy)
          ? this.config.pageLoadStrategy : 'none',
      });
      this.sessions.set(storeId, {
        storeId,
        name: ref?.name || name || null,
        market: String(market || ''),
        browserId,
        browserOauth,
        duplicate: payload.duplicate || 0,
        driver,
        raw: payload,
      });
      sessionRegistered = true;
      if (openUrl) {
        // The official Ziniao demo visits launcherPage before running platform
        // tasks. Deep-linking immediately can bypass profile/session bootstrap.
        const launcherPage = String(payload.launcherPage || '').trim();
        if (this.config.openLauncherPageBeforeTarget !== false && launcherPage && launcherPage !== openUrl) {
          try {
            await this.visit(storeId, launcherPage, { timeoutMs });
            const settleMs = Math.max(0, Number(this.config.launcherSettleMs ?? 2000));
            if (settleMs) await this.sleep(settleMs);
          } catch (e) {
            // A launcher failure must not suppress the real target attempt. The
            // check runner will still classify an unresolved/login page as bad.
            this.logger.warn?.(`店铺启动页打开失败，继续尝试目标页: ${e.message}`);
          }
        }
        await this.visit(storeId, openUrl, { timeoutMs });
        if (this.config.autoLoginAmazon !== false) {
          try {
            const restored = await this.restoreAmazonLogin(storeId);
            if (restored) await this.visit(storeId, openUrl, { timeoutMs });
            const selected = await this.selectAmazonAccount(storeId, market || 'US');
            if (selected) await this.visit(storeId, openUrl, { timeoutMs });
          } catch (e) {
            // Login recovery is best-effort. Conservative check verdicts still
            // turn the remaining login page into LOGIN_REQUIRED/UNKNOWN.
            this.logger.warn?.(`Amazon 自动登录恢复失败: ${e.message}`);
          }
        }
      }
      return {
        storeId,
        storeName: ref?.name || name || null,
        debuggingPort: debuggingEndpoint.port,
        coreVersion: payload.core_version || payload.coreVersion || null,
        driverPath: driverPath || null,
        raw: payload,
      };
    } catch (error) {
      // startBrowser has already created a native ZiNiao profile at this
      // point. If Selenium attachment or the launch/target navigation fails,
      // the caller has not received storeId and therefore cannot close it.
      // Compensate here so one transient renderer failure cannot leave a
      // duplicate profile that poisons every later check in the same slot.
      if (sessionRegistered) {
        try { await this.storeClose(storeId); } catch { /* original error remains authoritative */ }
      } else {
        try { await driver?.quit(); } catch { /* best-effort before official stopBrowser */ }
        try {
          await this.request('stopBrowser', {
            ...(browserId ? { browserId } : { browserOauth }),
            duplicate: payload.duplicate || 0,
          }, { timeoutMs: 30000 });
        } catch { /* original error remains authoritative */ }
      }
      throw error;
    }
  }

  session(storeId) {
    const s = this.sessions.get(String(storeId));
    if (!s) throw new ZiniaoError('找不到已启动的 WebDriver 店铺会话（标识已隐藏）');
    return s;
  }

  async runNativeCommand(args, { env = process.env } = {}) {
    return new Promise((resolve, reject) => {
      this.execFileImpl('xdotool', args, { env, encoding: 'utf8' }, (err, stdout = '', stderr = '') => {
        if (err) {
          reject(new ZiniaoError(`xdotool ${args[0]} 失败: ${String(stderr || err.message).trim()}`));
          return;
        }
        resolve(String(stdout || ''));
      });
    });
  }

  async nativeWindow(session) {
    if (process.platform !== 'linux') {
      throw new ZiniaoError(`原生窗口自动确认当前仅在 Linux 采集主机启用（当前 ${process.platform}）`);
    }
    const display = process.env.DISPLAY || this.config.display || '';
    if (!display) throw new ZiniaoError('原生窗口自动确认缺少 DISPLAY');

    const windowName = String(session.name || '').trim();
    if (!windowName) throw new ZiniaoError('无法确定紫鸟店铺窗口名称');
    const escaped = windowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const env = { ...process.env, DISPLAY: display };
    const raw = await this.runNativeCommand(['search', '--onlyvisible', '--name', `^${escaped}$`], { env });
    const windows = raw.trim().split(/\s+/).filter(Boolean);
    if (!windows.length) throw new ZiniaoError(`未找到可见的紫鸟店铺窗口: ${windowName}`);
    const windowId = windows[windows.length - 1];
    const geometry = await this.runNativeCommand(['getwindowgeometry', '--shell', windowId], { env });
    const width = Number(geometry.match(/(?:^|\n)WIDTH=(\d+)/)?.[1]);
    const height = Number(geometry.match(/(?:^|\n)HEIGHT=(\d+)/)?.[1]);
    if (!width || !height) throw new ZiniaoError('无法读取紫鸟店铺窗口尺寸');
    return { env, windowId, width, height };
  }

  async clickNativePasskey(session) {
    const { env, windowId, width, height } = await this.nativeWindow(session);

    const xRatio = Math.min(0.9, Math.max(0.1, Number(this.config.passkeyDialogXRatio ?? 0.5)));
    const yRatio = Math.min(0.9, Math.max(0.1, Number(this.config.passkeyDialogYRatio ?? 0.613)));
    await this.runNativeCommand([
      'mousemove', '--sync', '--window', windowId,
      String(Math.round(width * xRatio)), String(Math.round(height * yRatio)),
      'click', '1',
    ], { env });
  }

  async clickNativeElement(session, element) {
    const { env, windowId, width, height } = await this.nativeWindow(session);
    const metrics = await session.driver.executeScript(
      'var r=arguments[0].getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,innerWidth:window.innerWidth,innerHeight:window.innerHeight};',
      element,
    );
    if (!metrics?.width || !metrics?.height) throw new ZiniaoError('目标控件没有可点击区域');
    const chromeX = Math.max(0, (width - Number(metrics.innerWidth || width)) / 2);
    const chromeY = Math.max(0, height - Number(metrics.innerHeight || height));
    const x = Math.round(chromeX + Number(metrics.x) + Number(metrics.width) / 2);
    const y = Math.round(chromeY + Number(metrics.y) + Number(metrics.height) / 2);
    this.logger.debug?.(`[${session.name || '店铺'}] 原生控件点击坐标已校准 (${x},${y})`);
    await this.runNativeCommand([
      'mousemove', '--sync', '--window', windowId, String(x), String(y), 'click', '1',
    ], { env });
  }

  async vocDetailSurfaceProbe(driver, asin) {
    const value = await driver.executeScript(VOC_DETAIL_SURFACE_PROBE, String(asin || '').toUpperCase());
    if (value?.probeVersion !== 1) throw new ZiniaoError('VOC 只读详情结构探针不可用');
    return {
      visibleDialogCount: Math.max(0, Number(value.visibleDialogCount) || 0),
      visibleDrawerCount: Math.max(0, Number(value.visibleDrawerCount) || 0),
      inlineExpected: value.inlineExpected === true,
      expectedInSurface: value.expectedInSurface === true,
    };
  }

  async vocReadOnlyDetailText(storeId, asin) {
    const { driver } = this.session(storeId);
    const targetAsin = String(asin || '').toUpperCase();
    if (!/^B0[A-Z0-9]{8}$/.test(targetAsin)) throw new ZiniaoError('VOC 详情文本目标 ASIN 无效');
    const current = String(await driver.getCurrentUrl() || '');
    const safety = classifyUrlSafety(current);
    if (!safety.safe || !approvedSellerCentralSameOriginUrl(current, current)) {
      throw new ZiniaoError('VOC 详情文本读取前页面不是已批准的 Seller Central 页面');
    }
    const liveSafety = await classifyLivePageSafety({ zn: this, storeId });
    if (!liveSafety.safe) throw new ZiniaoError('VOC 详情文本读取前检测到认证、拦截或不可验证页面');
    const result = await driver.executeScript(VOC_SCOPED_DETAIL_TEXT, targetAsin);
    if (result?.probeVersion !== 1 || result.sensitive === true) {
      throw new ZiniaoError('VOC 详情文本结构探针被认证/拦截页面阻断');
    }
    return {
      text: String(result.text || ''),
      scoped: !!result.source,
      source: /^(?:dialog|drawer|inline|url-main)$/.test(String(result.source || '')) ? result.source : null,
    };
  }

  async vocSearchContexts(root, By) {
    const contexts = [root];
    if (typeof root?.getShadowRoot === 'function') {
      try {
        const ownShadow = await root.getShadowRoot();
        if (ownShadow) contexts.push(ownShadow);
      } catch { /* ordinary light-DOM root */ }
    }
    for (let index = 0; index < contexts.length && index < 80; index++) {
      const context = contexts[index];
      let hosts = [];
      try {
        hosts = await context.findElements(By.css(
          'kat-table,kat-table-head,kat-table-body,kat-table-row,kat-table-cell',
        ));
      } catch { /* fail closed */ }
      for (const host of hosts.slice(0, 500)) {
        if (typeof host.getShadowRoot !== 'function') continue;
        try {
          const shadow = await host.getShadowRoot();
          if (shadow && !contexts.includes(shadow)) contexts.push(shadow);
        } catch { /* closed/no shadow root */ }
      }
    }
    return contexts;
  }

  async findVocReadOnlyDetailControl(driver, asin, beforeUrl) {
    const { By } = await import('selenium-webdriver');
    const pageContexts = await this.vocSearchContexts(driver, By);
    const rows = [];
    for (const context of pageContexts) {
      let found = [];
      try { found = await context.findElements(By.css('tr,[role="row"],kat-table-row,[data-testid*="row"]')); } catch { /* fail closed */ }
      for (const row of found.slice(0, 1000)) if (!rows.includes(row)) rows.push(row);
    }
    const targetAsin = String(asin || '').toUpperCase();
    const candidates = [];
    let rowFound = false;
    let controlFound = false;
    for (const row of rows.slice(0, 1000)) {
      let rowText = '';
      try { rowText = normalizedUiText(await row.getText()); } catch { continue; }
      const rowAsins = observedAsins(rowText);
      if (rowAsins.length !== 1 || rowAsins[0] !== targetAsin) continue;
      rowFound = true;
      let displayed = false;
      try { displayed = await row.isDisplayed(); } catch { /* fail closed */ }
      if (!displayed) continue;
      const rowContexts = await this.vocSearchContexts(row, By);
      const controls = [];
      for (const context of rowContexts) {
        let found = [];
        try { found = await context.findElements(By.css('a,button,kat-button,kat-link,[role="button"]')); } catch { /* fail closed */ }
        for (const control of found.slice(0, 100)) if (!controls.includes(control)) controls.push(control);
      }
      for (const control of controls.slice(0, 100)) {
        let shown = false;
        let enabled = false;
        try {
          shown = await control.isDisplayed();
          enabled = await control.isEnabled();
        } catch { /* fail closed */ }
        if (!shown || !enabled) continue;
        const labels = [];
        try { labels.push(normalizedUiText(await control.getText())); } catch { /* optional */ }
        for (const attribute of ['aria-label', 'label']) {
          try { labels.push(normalizedUiText(await control.getAttribute(attribute))); } catch { /* optional */ }
        }
        const label = labels.find((value) => VOC_DETAIL_ACTION_RE.test(value)) || '';
        if (!label) continue;
        controlFound = true;
        let disabled = null;
        let ariaDisabled = null;
        let href = '';
        let tag = '';
        try {
          disabled = await control.getAttribute('disabled');
          ariaDisabled = await control.getAttribute('aria-disabled');
          href = normalizedUiText(await control.getAttribute('href'));
          tag = normalizedUiText(await control.getTagName()).toLowerCase();
        } catch { /* required validation below fails closed where relevant */ }
        if (disabled !== null || /^true$/i.test(String(ariaDisabled || ''))) continue;
        if (!isApprovedVocDetailAction({ asin: targetAsin, rowText, label, href, beforeUrl })) continue;
        candidates.push({ control, rowTextLength: rowText.length, rowAsinCount: rowAsins.length, label, href, tag });
      }
    }
    if (!candidates.length) return { rowFound, controlFound, candidateCount: 0, candidate: null };
    if (candidates.length !== 1) return { rowFound, controlFound, candidateCount: candidates.length, candidate: null };
    return { rowFound, controlFound, candidateCount: 1, candidate: candidates[0] };
  }

  async clickVocReadOnlyControl(session, candidate) {
    const { By } = await import('selenium-webdriver');
    const host = candidate.control;
    let clickTarget = host;
    let usedShadowButton = false;
    if (candidate.tag === 'kat-button' && typeof host.getShadowRoot === 'function') {
      try {
        const shadow = await host.getShadowRoot();
        const internals = await shadow.findElements(By.css('button,a,[role="button"]'));
        const approved = [];
        for (const element of internals.slice(0, 20)) {
          let shown = false;
          let enabled = false;
          try { shown = await element.isDisplayed(); enabled = await element.isEnabled(); } catch { /* fail closed */ }
          if (!shown || !enabled) continue;
          const labels = [];
          try { labels.push(normalizedUiText(await element.getText())); } catch { /* optional */ }
          for (const attribute of ['aria-label', 'label']) {
            try { labels.push(normalizedUiText(await element.getAttribute(attribute))); } catch { /* optional */ }
          }
          if (labels.some((value) => VOC_DETAIL_ACTION_RE.test(value))) approved.push(element);
        }
        if (approved.length === 1) clickTarget = approved[0];
        else if (approved.length === 0 && internals.length === 1) clickTarget = internals[0];
        usedShadowButton = clickTarget !== host;
      } catch { /* a closed/no shadow root is clicked through its validated host */ }
    }
    await clickTarget.click();
    return { method: usedShadowButton ? 'webdriver-shadow' : 'webdriver', usedShadowButton };
  }

  async closeUnexpectedVocHandles(driver, created, originHandle) {
    for (const handle of created) {
      try {
        await driver.switchTo().window(handle);
        await driver.close();
      } catch { /* best effort; origin switch below is authoritative */ }
    }
    const remaining = await driver.getAllWindowHandles();
    if (!remaining.includes(originHandle)) throw new ZiniaoError('VOC 标签页清理后无法恢复原列表标签页');
    await driver.switchTo().window(originHandle);
  }

  /**
   * Activate exactly one read-only VOC "View details" control. This method is
   * intentionally narrower than a generic click API: both the row ASIN and the
   * localized action label must match exact allowlists. Success means an actual
   * new safe tab, a safe VOC URL transition, or a newly visible detail surface
   * was observed; a synthetic click return value alone is never success.
   */
  async activateVocReadOnlyDetail(storeId, asin, { timeoutMs = 20000 } = {}) {
    const session = this.session(storeId);
    const { driver } = session;
    // A freshly attached ZiNiao browser inherits the transport-wide 120s
    // script timeout. VOC detail controls are independently retried through a
    // fresh store session, so cap their native WebDriver operations here; this
    // prevents one poisoned renderer from occupying several minutes before
    // the bounded recovery can run.
    if (typeof driver.manage === 'function') {
      const boundedTimeoutMs = Math.max(5000, Math.min(30000, Number(timeoutMs || 20000)));
      await driver.manage().setTimeouts({
        pageLoad: boundedTimeoutMs,
        script: Math.max(30000, boundedTimeoutMs),
      });
    }
    const targetAsin = String(asin || '').toUpperCase();
    if (!/^B0[A-Z0-9]{8}$/.test(targetAsin)) throw new ZiniaoError('VOC 详情目标 ASIN 无效');
    if (session.vocDetailContext) await this.releaseVocReadOnlyDetail(storeId);
    const beforeUrl = String(await driver.getCurrentUrl() || '');
    const beforeSafety = classifyUrlSafety(beforeUrl);
    if (!beforeSafety.safe || !approvedSellerCentralSameOriginUrl(beforeUrl, beforeUrl) || !isKnownVocReadOnlyRoute(beforeUrl)) {
      throw new ZiniaoError('VOC 详情点击前页面不是已批准的只读 VOC 页面');
    }
    const originHandle = await driver.getWindowHandle();
    const beforeHandles = new Set(await driver.getAllWindowHandles());
    const beforeSurface = await this.vocDetailSurfaceProbe(driver, targetAsin);
    const lookupDeadline = Date.now() + Math.max(1000, Number(timeoutMs || 20000));
    let lookup = null;
    do {
      lookup = await this.findVocReadOnlyDetailControl(driver, targetAsin, beforeUrl);
      if (lookup.candidate) break;
      if (Date.now() >= lookupDeadline) break;
      await this.sleep(500);
    } while (Date.now() < lookupDeadline);
    if (!lookup?.candidate) {
      return {
        activated: false, transition: 'none', rowFound: lookup?.rowFound === true,
        controlFound: lookup?.controlFound === true, candidateCount: Number(lookup?.candidateCount || 0),
      };
    }

    const candidate = lookup.candidate;
    const preClickLiveSafety = await classifyLivePageSafety({ zn: this, storeId });
    const preClickUrl = String(await driver.getCurrentUrl() || '');
    if (!preClickLiveSafety.safe || preClickUrl !== beforeUrl) {
      throw new ZiniaoError('VOC 详情点击前页面发生变化或出现认证/拦截覆盖层，已安全终止');
    }
    const click = await this.clickVocReadOnlyControl(session, candidate);
    const observationDeadline = Date.now() + Math.max(500, Number(timeoutMs || 20000));
    let lastSurface = beforeSurface;
    do {
      const handles = await driver.getAllWindowHandles();
      const created = handles.filter((handle) => !beforeHandles.has(handle));
      if (created.length > 1) {
        session.vocDetailContext = { originHandle, detailHandle: null, detailHandles: [...created], beforeUrl };
        await this.closeUnexpectedVocHandles(driver, created, originHandle);
        session.vocDetailContext = null;
        throw new ZiniaoError('VOC 详情点击产生多个未知标签页，已安全终止');
      }
      if (created.length === 1) {
        const detailHandle = created[0];
        session.vocDetailContext = { originHandle, detailHandle, detailHandles: [detailHandle], beforeUrl };
        await driver.switchTo().window(detailHandle);
        let current = '';
        try { current = String(await driver.getCurrentUrl() || ''); } catch { /* attaching */ }
        if (current && current !== 'about:blank') {
          const safety = classifyUrlSafety(current);
          if (!safety.safe || !approvedSellerCentralSameOriginUrl(current, beforeUrl)) {
            await this.closeUnexpectedVocHandles(driver, created, originHandle);
            session.vocDetailContext = null;
            throw new ZiniaoError('VOC 详情新标签页不是已批准的只读 Amazon 页面');
          }
          lastSurface = await this.vocDetailSurfaceProbe(driver, targetAsin);
          if (vocUrlObservesAsin(current, targetAsin) || lastSurface.expectedInSurface) {
            const postLiveSafety = await classifyLivePageSafety({ zn: this, storeId });
            if (!postLiveSafety.safe) {
              await this.closeUnexpectedVocHandles(driver, created, originHandle);
              session.vocDetailContext = null;
              throw new ZiniaoError('VOC 详情新标签页出现认证、拦截或不可验证覆盖层');
            }
            return {
              activated: true, transition: 'new-tab', openedNewTab: true,
              rowFound: true, controlFound: true, candidateCount: lookup.candidateCount,
              controlTag: candidate.tag || null, hasHref: !!candidate.href,
              clickMethod: click.method, usedShadowButton: click.usedShadowButton,
              handleCountBefore: beforeHandles.size, handleCountAfter: handles.length,
            };
          }
        }
      } else {
        const current = String(await driver.getCurrentUrl() || '');
        if (current !== beforeUrl) {
          const safety = classifyUrlSafety(current);
          if (!safety.safe || !approvedSellerCentralSameOriginUrl(current, beforeUrl)) {
            throw new ZiniaoError('VOC 详情跳转不是已批准的只读 Amazon 页面');
          }
          lastSurface = await this.vocDetailSurfaceProbe(driver, targetAsin);
          if (vocUrlObservesAsin(current, targetAsin) || lastSurface.expectedInSurface) {
            const postLiveSafety = await classifyLivePageSafety({ zn: this, storeId });
            if (!postLiveSafety.safe) throw new ZiniaoError('VOC 详情跳转后出现认证、拦截或不可验证覆盖层');
            session.vocDetailContext = { originHandle, detailHandle: null, detailHandles: [], beforeUrl };
            return {
              activated: true, transition: 'url', openedNewTab: false,
              rowFound: true, controlFound: true, candidateCount: lookup.candidateCount,
              controlTag: candidate.tag || null, hasHref: !!candidate.href,
              clickMethod: click.method, usedShadowButton: click.usedShadowButton,
              handleCountBefore: beforeHandles.size, handleCountAfter: handles.length,
            };
          }
        } else {
          lastSurface = await this.vocDetailSurfaceProbe(driver, targetAsin);
        }
        const surfaceTransition = (
          lastSurface.expectedInSurface === true && beforeSurface.expectedInSurface !== true
          && (
            lastSurface.visibleDialogCount > beforeSurface.visibleDialogCount
            || lastSurface.visibleDrawerCount > beforeSurface.visibleDrawerCount
            || (lastSurface.inlineExpected && !beforeSurface.inlineExpected)
          )
        );
        if (surfaceTransition) {
          const postLiveSafety = await classifyLivePageSafety({ zn: this, storeId });
          if (!postLiveSafety.safe) throw new ZiniaoError('VOC 详情弹层出现认证、拦截或不可验证覆盖层');
          session.vocDetailContext = { originHandle, detailHandle: null, detailHandles: [], beforeUrl };
          const transition = lastSurface.visibleDialogCount > beforeSurface.visibleDialogCount
            ? 'dialog' : lastSurface.visibleDrawerCount > beforeSurface.visibleDrawerCount ? 'drawer' : 'inline';
          return {
            activated: true, transition, openedNewTab: false,
            rowFound: true, controlFound: true, candidateCount: lookup.candidateCount,
            controlTag: candidate.tag || null, hasHref: !!candidate.href,
            clickMethod: click.method, usedShadowButton: click.usedShadowButton,
            handleCountBefore: beforeHandles.size, handleCountAfter: handles.length,
            visibleDialogCount: lastSurface.visibleDialogCount,
            visibleDrawerCount: lastSurface.visibleDrawerCount,
          };
        }
      }
      if (Date.now() >= observationDeadline) break;
      await this.sleep(250);
    } while (Date.now() < observationDeadline);

    const remaining = (await driver.getAllWindowHandles()).filter((handle) => !beforeHandles.has(handle));
    if (remaining.length) {
      session.vocDetailContext = { originHandle, detailHandle: null, detailHandles: [...remaining], beforeUrl };
      await this.closeUnexpectedVocHandles(driver, remaining, originHandle);
    }
    session.vocDetailContext = null;
    return {
      activated: false, transition: 'none', rowFound: true, controlFound: true,
      candidateCount: lookup.candidateCount, controlTag: candidate.tag || null,
      hasHref: !!candidate.href, clickMethod: click.method,
      usedShadowButton: click.usedShadowButton,
      handleCountBefore: beforeHandles.size,
      handleCountAfter: (await driver.getAllWindowHandles()).length,
      visibleDialogCount: lastSurface.visibleDialogCount,
      visibleDrawerCount: lastSurface.visibleDrawerCount,
    };
  }

  async releaseVocReadOnlyDetail(storeId) {
    const session = this.session(storeId);
    const { driver } = session;
    const context = session.vocDetailContext;
    if (!context) return { closedNewTab: false };
    const detailHandles = [...new Set([
      ...(Array.isArray(context.detailHandles) ? context.detailHandles : []),
      ...(context.detailHandle ? [context.detailHandle] : []),
    ])].filter((handle) => handle && handle !== context.originHandle);
    if (!detailHandles.length) {
      session.vocDetailContext = null;
      return { closedNewTab: false };
    }
    const handles = await driver.getAllWindowHandles();
    for (const detailHandle of detailHandles) {
      if (!handles.includes(detailHandle)) continue;
      await driver.switchTo().window(detailHandle);
      await driver.close();
    }
    const remaining = await driver.getAllWindowHandles();
    if (!remaining.includes(context.originHandle)) {
      throw new ZiniaoError('VOC 详情标签页关闭后无法恢复原列表标签页');
    }
    await driver.switchTo().window(context.originHandle);
    const current = String(await driver.getCurrentUrl() || '');
    const safety = classifyUrlSafety(current);
    if (!safety.safe || current !== context.beforeUrl || !isKnownVocReadOnlyRoute(current)) {
      throw new ZiniaoError('VOC 详情标签页关闭后原页面不再是已批准的只读 VOC 页面');
    }
    session.vocDetailContext = null;
    return { closedNewTab: true };
  }

  async followNavigationLink(storeId, { labels = [], timeoutMs = 30000 } = {}) {
    const session = this.session(storeId);
    const { driver } = session;
    const { By } = await import('selenium-webdriver');
    const wanted = labels.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    const links = await driver.findElements(By.css('a'));
    let target = null;
    for (const link of links) {
      const text = String(await link.getText() || '').trim().toLowerCase();
      if (text && wanted.some((label) => text.includes(label)) && await link.isDisplayed()) {
        target = link;
        break;
      }
    }
    if (!target) throw new ZiniaoError(`未找到导航入口: ${labels.join(' / ')}`);

    const beforeUrl = await driver.getCurrentUrl();
    assertApprovedAmazonUrl(beforeUrl);
    const targetHref = String(await target.getAttribute('href') || '').trim();
    if (!targetHref) throw new ZiniaoError('导航入口缺少可验证的 Amazon HTTPS 地址');
    assertApprovedAmazonUrl(targetHref, { base: beforeUrl });
    const beforeHandles = new Set(await driver.getAllWindowHandles());
    try {
      await target.click();
    } catch (e) {
      if (!/click intercepted|not interactable/i.test(String(e?.message || e))) throw e;
      await this.clickNativeElement(session, target);
    }
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs || 30000));
    while (Date.now() < deadline) {
      const handles = await driver.getAllWindowHandles();
      const created = handles.find((handle) => !beforeHandles.has(handle));
      if (created) await driver.switchTo().window(created);
      let current = '';
      try { current = await driver.getCurrentUrl(); } catch { /* tab may still be attaching */ }
      if (current && current !== 'about:blank' && (created || current !== beforeUrl)) {
        assertApprovedAmazonUrl(current);
        return current;
      }
      await this.sleep(250);
    }
    throw new ZiniaoError('点击导航入口后未发生页面跳转');
  }

  /**
   * Amazon Ads can redirect a valid Ziniao profile to Amazon's account
   * switcher before opening Campaign Manager. Select the already-signed-in
   * account; never type or read marketplace credentials here.
   */
  async selectAdvertisingAccount(storeId, { timeoutMs = 30000 } = {}) {
    const session = this.session(storeId);
    const { driver } = session;
    const { By } = await import('selenium-webdriver');
    let current = await driver.getCurrentUrl();
    const parsed = approvedAmazonUrl(current);
    if (!parsed || parsed.port) return null;
    const mayBeAdsSwitcher = (
      /(^|\.)amazon\.com$/i.test(parsed.hostname)
      && /\/ap\/signin/i.test(parsed.pathname)
      && /advertising\.amazon\.com/i.test(current)
    );
    if (!mayBeAdsSwitcher) return null;

    // The outer Amazon sign-in document finishes loading before the saved
    // account card is painted. Wait for that card instead of treating the
    // initial empty shell as a normal sign-in page.
    const switcherDeadline = Date.now() + Math.min(12000, Math.max(3000, Number(timeoutMs || 30000)));
    let body = '';
    while (Date.now() < switcherDeadline) {
      try {
        current = await driver.getCurrentUrl();
        const now = approvedAmazonUrl(current);
        if (!now || now.port) throw new ZiniaoError('Amazon Ads 登录流程跳转到未批准的非 Amazon 页面');
        if (now.hostname === 'advertising.amazon.com') return current;
        body = String(await driver.executeScript(
          'return document.body ? (document.body.innerText || document.body.textContent || "") : "";',
        ) || '');
        if (/切换账户|switch account/i.test(body)) break;
      } catch (e) {
        if (e instanceof ZiniaoError) throw e;
        // The approved Amazon sign-in shell can replace itself asynchronously.
      }
      await this.sleep(250);
    }
    if (!/切换账户|switch account/i.test(body)) return null;

    // The heading and the saved-account card are rendered by different async
    // stages. Poll the approved account links as well: a one-shot scan races
    // the card paint and turns a healthy session into LOGIN_REQUIRED.
    const accountPollWindowMs = Math.min(12000, Math.max(3000, Number(timeoutMs || 30000)));
    const maxAccountPolls = Math.min(80, Math.max(12, Math.ceil(accountPollWindowMs / 250)));
    let target = null;
    for (let attempt = 0; attempt < maxAccountPolls; attempt++) {
      current = await driver.getCurrentUrl();
      const now = approvedAmazonUrl(current);
      if (!now || now.port) throw new ZiniaoError('Amazon Ads 登录流程跳转到未批准的非 Amazon 页面');
      if (now.hostname === 'advertising.amazon.com') return current;

      const approvedAccounts = [];
      try {
        const links = await driver.findElements(By.css('a'));
        for (const link of links) {
          let text = '';
          let href = '';
          try {
            if (!(await link.isDisplayed())) continue;
            text = String(await link.getText() || '').trim();
            href = String(await link.getAttribute('href') || '');
          } catch { continue; }
          if (isApprovedExistingAccountLink({ label: text, href })) approvedAccounts.push(link);
        }
      } catch {
        // The sign-in shell can replace the whole link tree between paints.
      }
      if (approvedAccounts.length > 1) {
        throw new ZiniaoError('Amazon Ads 账户选择页存在多个已登录账户，无法安全确定目标');
      }
      if (approvedAccounts.length === 1) {
        target = approvedAccounts[0];
        break;
      }
      await this.sleep(250);
    }
    if (!target) throw new ZiniaoError('Amazon Ads 账户选择页没有可证明安全的已登录账户卡');

    const controlLabel = async (control) => String(
      (await control.getText())
      || (await control.getAttribute('value'))
      || (await control.getAttribute('aria-label'))
      || '',
    ).trim();
    const findVisibleControl = async (approved) => {
      const controls = await driver.findElements(By.css('button,a,[role="button"],input[type="submit"]'));
      for (const control of controls) {
        try {
          if (!(await control.isDisplayed()) || !(await control.isEnabled())) continue;
          const label = await controlLabel(control);
          if (approved(label)) return control;
        } catch { /* stale control while the sign-in shell updates */ }
      }
      return null;
    };
    const clickControl = async (control) => {
      try {
        await control.click();
      } catch (e) {
        if (!/click intercepted|not interactable|stale element/i.test(String(e?.message || e))) throw e;
        await driver.executeScript('arguments[0].click();', control);
      }
    };

    await clickControl(target);
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs || 30000));
    let acceptedPasskey = false;
    let submittedPassword = false;
    let acceptedOtp = false;
    let submittedOtp = false;
    while (Date.now() < deadline) {
      try {
        const next = await driver.getCurrentUrl();
        const parsed = approvedAmazonUrl(next);
        if (!parsed || parsed.port) throw new ZiniaoError('Amazon Ads 登录流程跳转到未批准的非 Amazon 页面');
        if (parsed.hostname === 'advertising.amazon.com') {
          this.logger.info?.(`[${session.name || '店铺'}] 已自动选择 Amazon Ads 账户`);
          return next;
        }

        // Ziniao paints an in-page Passkey card over Amazon's password page.
        // Accept it, then submit the already-filled password without reading it.
        if (/\/ap\/signin/i.test(parsed.pathname)) {
          if (!acceptedPasskey) {
            const passkey = await findVisibleControl((label) => isApprovedAmazonLoginAction('passkey', label));
            if (passkey) {
              await clickControl(passkey);
              acceptedPasskey = true;
              await this.sleep(800);
              continue;
            }
            // Do not click a calibrated screen coordinate merely because a
            // password field exists. If the approved Passkey control cannot
            // be identified in DOM, fail closed and let the operator review.
          }
          if (acceptedPasskey && !submittedPassword) {
            const submits = await driver.findElements(By.css('#signInSubmit'));
            const submit = submits[0] || null;
            if (
              submit
              && await submit.isDisplayed()
              && await submit.isEnabled()
              && isApprovedAmazonLoginAction('signIn', await controlLabel(submit))
            ) {
              await clickControl(submit);
              submittedPassword = true;
              await this.sleep(800);
              continue;
            }
          }
        }

        if (/\/ap\/mfa/i.test(parsed.pathname)) {
          if (!acceptedOtp) {
            const accept = await findVisibleControl((label) => isApprovedAmazonLoginAction('acceptOtp', label));
            if (accept) {
              await clickControl(accept);
              acceptedOtp = true;
              await this.sleep(500);
              continue;
            }
          }
          if (!submittedOtp) {
            const inputs = await driver.findElements(By.css('#auth-mfa-otpcode'));
            const otp = inputs[0] || null;
            if (await otpInputIsReady(driver, otp)) {
              const submits = await driver.findElements(By.css('#auth-signin-button'));
              const submit = submits[0] || null;
              if (
                submit
                && await submit.isDisplayed()
                && await submit.isEnabled()
                && isApprovedAmazonLoginAction('signIn', await controlLabel(submit))
              ) {
                await clickControl(submit);
                submittedOtp = true;
                await this.sleep(800);
                continue;
              }
            }
          }
        }
      } catch (e) {
        if (e instanceof ZiniaoError) throw e;
        // The approved Amazon page can briefly detach during navigation.
      }
      await this.sleep(250);
    }
    throw new ZiniaoError('Amazon Ads 账户选择后未进入广告控制台');
  }

  /**
   * Dismiss only the known Amazon Ads coachmarks that can cover the campaign
   * filter bar. The close control must be inside a short container carrying a
   * known tutorial sentence; a generic X/Close elsewhere is never eligible.
   * This changes no campaign state and runs only on the approved Ads page.
   */
  async dismissAdvertisingCoachmarks(storeId) {
    const session = this.session(storeId);
    const { driver } = session;
    const { By } = await import('selenium-webdriver');
    const current = String(await driver.getCurrentUrl() || '');
    const parsed = approvedAmazonUrl(current);
    if (
      !parsed || parsed.port || parsed.hostname !== 'advertising.amazon.com'
      || !/campaign-manager|campaigns/i.test(parsed.pathname)
    ) throw new ZiniaoError('Amazon Ads 新手引导处理前页面不是已批准的广告活动页');
    const preSafety = await classifyLivePageSafety({ zn: this, storeId });
    if (!preSafety.safe) throw new ZiniaoError('Amazon Ads 新手引导处理前检测到认证、拦截或不可验证页面');

    const controls = await driver.findElements(By.css('button,[role="button"],kat-button'));
    const candidates = [];
    for (const control of controls.slice(0, 1200)) {
      try {
        if (!(await control.isDisplayed()) || !(await control.isEnabled())) continue;
        const label = String(
          (await control.getText())
          || (await control.getAttribute('aria-label'))
          || (await control.getAttribute('title'))
          || (await control.getAttribute('label'))
          || '',
        ).replace(/\s+/g, ' ').trim();
        if (!/^(?:x|\u00d7|close|dismiss|\u5173\u95ed)$/i.test(label)) continue;
        const context = String(await driver.executeScript(
          'var e=arguments[0],p=e,d=0,t="";while(p&&p!==document.body&&d<7){'
          + 't=String(p.innerText||p.textContent||"").replace(/\\s+/g," ").trim();'
          + 'if(t&&t.length<=700&&/(?:\\u5bfc\\u822a\\u73b0\\u5df2\\u6298\\u53e0|\\u663e\\u793a\\u5168\\u5bbd\\u6548\\u679c\\u56fe\\u8868|navigation (?:is |has been )?now collapsed|show full[- ]width (?:performance )?charts?)/i.test(t))return t;'
          + 'p=p.parentElement;d++;}return "";',
          control,
        ) || '');
        if (context) candidates.push(control);
      } catch { /* coachmark can detach while another one closes */ }
    }
    if (candidates.length > 4) {
      throw new ZiniaoError(`Amazon Ads 新手引导关闭控件数量异常（${candidates.length}），拒绝点击`);
    }
    let dismissed = 0;
    for (const control of candidates) {
      const gate = await classifyLivePageSafety({ zn: this, storeId });
      if (!gate.safe) throw new ZiniaoError('Amazon Ads 新手引导关闭前页面安全状态变化');
      try {
        await control.click();
        dismissed++;
        await this.sleep(200);
      } catch (e) {
        if (!/stale|detached|not interactable/i.test(String(e?.message || e))) throw e;
      }
    }
    if (dismissed) this.logger.info?.(`[${session.name || '店铺'}] 已关闭 ${dismissed} 个 Amazon Ads 只读新手引导浮层`);
    return dismissed;
  }

  /**
   * Apply the Campaign Manager name search before reading any status counts.
   * Only one visible search/text input whose presentation explicitly names
   * campaigns is eligible; campaign-row controls and ambiguous inputs fail
   * closed. This changes the local table view only, never an ad state.
   */
  async selectAdvertisingCampaignNameFilter(storeId, keyword, { timeoutMs = 20000 } = {}) {
    const wanted = String(keyword || '').trim();
    if (!wanted || wanted.length > 40 || /[\u0000-\u001f\u007f]/.test(wanted)) {
      throw new ZiniaoError('Amazon Ads 广告名称特征须为 1-40 个可见字符');
    }
    const session = this.session(storeId);
    const { driver } = session;
    const { Key } = await import('selenium-webdriver');
    const approvedPage = async () => {
      const parsed = approvedAmazonUrl(await driver.getCurrentUrl());
      if (!parsed || parsed.port || parsed.hostname !== 'advertising.amazon.com'
        || !/campaign-manager|campaigns/i.test(parsed.pathname)) {
        throw new ZiniaoError('Amazon Ads 名称筛选前页面不是已批准的广告活动页');
      }
    };
    const findCandidate = async () => {
      const inputs = await driver.executeScript(
        'var roots=[document],seen=[],out=[];for(var ri=0;ri<roots.length&&ri<120;ri++){var r=roots[ri];'
        + 'if(!r||seen.indexOf(r)>=0)continue;seen.push(r);var all=[];try{all=r.querySelectorAll("*");}catch(ignore){}'
        + 'for(var i=0;i<all.length&&i<7000;i++){var e=all[i],tag=String(e.tagName||"").toLowerCase();'
        + 'try{if(e.shadowRoot&&roots.indexOf(e.shadowRoot)<0)roots.push(e.shadowRoot);}catch(ignore2){}'
        + 'if(tag==="input")out.push(e);}}return out;',
      );
      const candidates = [];
      for (const input of (Array.isArray(inputs) ? inputs : []).slice(0, 1500)) {
        try {
          if (!(await input.isDisplayed()) || !(await input.isEnabled())) continue;
          const type = String(await input.getAttribute('type') || 'text').toLowerCase();
          if (!['search', 'text'].includes(type)) continue;
          const presentation = String(await driver.executeScript(
            'var e=arguments[0],p=e,d=0,a=[];while(p&&d<5){if(p.getAttribute){a.push(p.getAttribute("aria-label")||"");'
            + 'a.push(p.getAttribute("placeholder")||"");a.push(p.getAttribute("label")||"");a.push(p.getAttribute("title")||"");'
            + 'a.push(p.getAttribute("name")||"");a.push(p.getAttribute("id")||"");a.push(p.getAttribute("data-testid")||"");}'
            + 'var r=null;try{r=p.getRootNode&&p.getRootNode();}catch(ignore){}p=p.parentElement||(r&&r.host)||null;d++;}'
            + 'return a.join(" ").replace(/\\s+/g," ").trim();', input,
          ) || '').slice(0, 500);
          if (!/(?:campaign|广告活动)[^]{0,80}(?:name|search|find|名称|搜索|查找)|(?:search|find|搜索|查找)[^]{0,80}(?:campaign|广告活动)/i.test(presentation)) continue;
          const outsideRow = await driver.executeScript(
            'var p=arguments[0],d=0;while(p&&d<24){var r=String(p.getAttribute&&p.getAttribute("role")||"").toLowerCase();'
            + 'if(String(p.tagName||"").toLowerCase()==="tr"||r==="row")return false;var root=null;'
            + 'try{root=p.getRootNode&&p.getRootNode();}catch(ignore){}p=p.parentElement||(root&&root.host)||null;d++;}return true;',
            input,
          );
          if (outsideRow === true) candidates.push(input);
        } catch { /* input can repaint while Campaign Manager hydrates */ }
      }
      if (candidates.length > 1) throw new ZiniaoError(`Amazon Ads 名称筛选输入框不唯一（${candidates.length}），拒绝输入`);
      return candidates[0] || null;
    };

    await approvedPage();
    const gate = await classifyLivePageSafety({ zn: this, storeId });
    if (!gate.safe) throw new ZiniaoError('Amazon Ads 名称筛选前检测到认证、拦截或不可验证页面');
    await this.dismissAdvertisingCoachmarks(storeId);
    // The search field is part of the lazy campaign-table surface and is not
    // hydrated while the large analytics overview remains at the top. A
    // bounded scroll is presentation-only and cannot change campaign state.
    await driver.executeScript(
      'var d=document.documentElement;window.scrollTo(0,Math.max(0,Math.min(d.scrollHeight-window.innerHeight,Math.floor(d.scrollHeight*0.55))));return true;',
    );
    await this.sleep(800);
    const postRevealGate = await classifyLivePageSafety({ zn: this, storeId });
    if (!postRevealGate.safe) throw new ZiniaoError('Amazon Ads 名称筛选区域显示后页面安全状态异常');
    const deadline = Date.now() + Math.max(3000, Number(timeoutMs || 20000));
    let input = null;
    while (!input && Date.now() < deadline) {
      await approvedPage();
      input = await findCandidate();
      if (!input) await this.sleep(250);
    }
    if (!input) throw new ZiniaoError('未找到唯一且可验证的 Amazon Ads 广告活动名称搜索框');
    const currentValue = String(await input.getAttribute('value') || '');
    if (currentValue !== wanted) {
      await input.sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE);
      await input.sendKeys(wanted);
    }
    while (Date.now() < deadline) {
      await approvedPage();
      const value = String(await input.getAttribute('value') || '');
      if (value === wanted) {
        await this.sleep(750);
        return { keyword: wanted, verified: true, changed: currentValue !== wanted };
      }
      await this.sleep(200);
    }
    throw new ZiniaoError('Amazon Ads 名称筛选值未能稳定为指定特征');
  }

  async verifyAdvertisingCampaignNameFilter(storeId, keyword) {
    return this.selectAdvertisingCampaignNameFilter(storeId, keyword, { timeoutMs: 15000 });
  }

  /**
   * Select one read-only Campaign Manager status filter. This deliberately
   * targets the filter bar's exact radio ids and never a campaign-row switch,
   * so it cannot enable, pause or otherwise mutate an advertising campaign.
   */
  async selectAdvertisingCampaignState(storeId, state, { timeoutMs = 20000 } = {}) {
    const targetState = String(state || '').toUpperCase();
    if (!['ENABLED', 'PAUSED'].includes(targetState)) {
      throw new ZiniaoError('Amazon Ads 状态筛选只允许 ENABLED 或 PAUSED');
    }
    const session = this.session(storeId);
    const { driver } = session;
    const { By } = await import('selenium-webdriver');
    const target = {
      ENABLED: { labels: /^(?:已启用|Enabled)$/i, other: 'PAUSED' },
      PAUSED: { labels: /^(?:已暂停|Paused)$/i, other: 'ENABLED' },
    }[targetState];
    const optionId = `globalBetaAllCampaigns:filter:state:option-${targetState}`;
    const otherId = `globalBetaAllCampaigns:filter:state:option-${target.other}`;
    const optionName = 'globalBetaAllCampaigns:filter:state:option';
    const chipId = 'globalBetaAllCampaigns:filterTag-state';
    const deadline = Date.now() + Math.max(3000, Number(timeoutMs || 20000));
    let semanticTrigger = null;
    let stateFilterDiagnostics = [];

    const controlLabel = async (control) => {
      const webdriverText = String(
        (await control.getText())
        || (await control.getAttribute('value'))
        || (await control.getAttribute('aria-label'))
        || (await control.getAttribute('title'))
        || (await control.getAttribute('label'))
        || '',
      ).replace(/\s+/g, ' ').trim();
      if (webdriverText) return webdriverText;
      // KAT web components can expose an empty WebDriver text value while the
      // open shadow leaf has visible text. Read only presentation text; never
      // return input values or page-wide content from this fallback.
      return String(await driver.executeScript(
        'var e=arguments[0];return e?String(e.innerText||e.textContent||"").replace(/\\s+/g," ").trim():"";',
        control,
      ) || '').replace(/\s+/g, ' ').trim();
    };

    const approvedPage = async () => {
      const current = String(await driver.getCurrentUrl() || '');
      const parsed = approvedAmazonUrl(current);
      if (
        !parsed || parsed.port || parsed.hostname !== 'advertising.amazon.com'
        || !/campaign-manager|campaigns/i.test(parsed.pathname)
      ) throw new ZiniaoError('Amazon Ads 状态筛选前页面不是已批准的广告活动页');
      return current;
    };
    const chipState = async () => {
      const fixed = await driver.executeScript(
        'var c=document.getElementById(arguments[0]);var b=c&&c.querySelector("button");'
        + 'return b?String(b.innerText||b.textContent||b.getAttribute("title")||"").replace(/\\s+/g," ").trim():"";',
        chipId,
      );
      if (String(fixed || '').trim()) return String(fixed).trim();
      const dynamicFixed = await driver.executeScript(
        'var roots=[document],seen=[],hits=[];for(var ri=0;ri<roots.length&&ri<120;ri++){var r=roots[ri];'
        + 'if(!r||seen.indexOf(r)>=0)continue;seen.push(r);var all=[];try{all=r.querySelectorAll("[id]");}catch(ignore){}'
        + 'for(var i=0;i<all.length&&i<4000;i++){var e=all[i],id=String(e.id||"");'
        + 'try{if(e.shadowRoot&&roots.indexOf(e.shadowRoot)<0)roots.push(e.shadowRoot);}catch(ignore2){}'
        + 'if(!/:filterTag-state$/.test(id))continue;var b=null;try{b=e.querySelector("button");}catch(ignore3){}'
        + 'if(b&&hits.indexOf(b)<0)hits.push(b);}}if(hits.length!==1)return "";var b=hits[0];'
        + 'return String(b.innerText||b.textContent||b.getAttribute("title")||"").replace(/\\s+/g," ").trim();',
      );
      if (String(dynamicFixed || '').trim()) return String(dynamicFixed).trim();
      if (semanticTrigger) {
        try {
          const triggerText = await controlLabel(semanticTrigger);
          if (/(?:^|[:：]\s*)(?:已启用|已暂停|Enabled|Paused)$/i.test(triggerText)) return triggerText;
        } catch { /* semantic trigger can repaint after Apply */ }
      }
      // Some new builds keep the trigger caption as just "Status" and render
      // the selected value in a sibling KAT chip. Require one exact visible
      // filter presentation outside campaign rows; row switches are excluded.
      const semantic = await driver.executeScript(
        'var roots=[document],seen=[],hits=[];for(var ri=0;ri<roots.length&&ri<120;ri++){var r=roots[ri];'
        + 'if(!r||seen.indexOf(r)>=0)continue;seen.push(r);var all=[];try{all=r.querySelectorAll("*");}catch(ignore){}'
        + 'for(var i=0;i<all.length&&i<5000;i++){var e=all[i],tag=String(e.tagName||"").toLowerCase(),role=String(e.getAttribute&&e.getAttribute("role")||"").toLowerCase();'
        + 'try{if(e.shadowRoot&&roots.indexOf(e.shadowRoot)<0)roots.push(e.shadowRoot);}catch(ignore2){}'
        + 'if(!/^(?:a|button|kat-button|kat-tag|kat-chip|select|kat-select|kat-dropdown)$/.test(tag)&&!(/^(?:button|combobox)$/.test(role)))continue;'
        + 'var t=String((e.getAttribute&&(e.getAttribute("aria-label")||e.getAttribute("label")||e.getAttribute("title")))||e.innerText||e.textContent||"").replace(/\s+/g," ").trim();'
        + 'if(!/^(?:Status|State|Active|Active status|Campaign status|Delivery status|\\u72b6\\u6001|\\u8fdb\\u884c\\u4e2d|\\u5e7f\\u544a\\u6d3b\\u52a8\\u72b6\\u6001|\\u6295\\u653e\\u72b6\\u6001|\\u8fd0\\u884c\\u72b6\\u6001)\\s*[:\\uff1a]\\s*(?:Enabled|Paused|\\u5df2\\u542f\\u7528|\\u5df2\\u6682\\u505c)$/i.test(t))continue;'
        + 'var p=e,d=0,outside=true;while(p&&d<20){var pr=String(p.getAttribute&&p.getAttribute("role")||"").toLowerCase();if(String(p.tagName||"").toLowerCase()==="tr"||pr==="row"){outside=false;break;}'
        + 'var root=null;try{root=p.getRootNode&&p.getRootNode();}catch(ignore3){}p=p.parentElement||(root&&root.host)||null;d++;}if(outside&&hits.indexOf(t)<0)hits.push(t);}}return hits.length===1?hits[0]:"";',
      );
      return String(semantic || '').trim();
    };
    const stateMatches = (text, wanted) => wanted === 'ENABLED'
      ? /(?:^|[:：]\s*)(?:已启用|Enabled)$/i.test(String(text || '').trim())
      : /(?:^|[:：]\s*)(?:已暂停|Paused)$/i.test(String(text || '').trim());

    const resolveSemanticStateOptions = async () => {
      const nodes = await driver.executeScript(
        'var roots=[document],seen=[],out=[];for(var ri=0;ri<roots.length&&ri<120;ri++){var r=roots[ri];'
        + 'if(!r||seen.indexOf(r)>=0)continue;seen.push(r);var all=[];try{all=r.querySelectorAll("*");}catch(ignore){}'
        + 'for(var i=0;i<all.length&&i<5000;i++){var e=all[i],tag=String(e.tagName||"").toLowerCase(),'
        + 'role=String(e.getAttribute&&e.getAttribute("role")||"").toLowerCase(),type=String(e.getAttribute&&e.getAttribute("type")||"").toLowerCase();'
        + 'if(tag==="label"||(tag==="input"&&type==="radio")||role==="radio"||tag==="kat-radio-button"||tag==="kat-radio")out.push(e);'
        + 'try{if(e.shadowRoot&&roots.indexOf(e.shadowRoot)<0)roots.push(e.shadowRoot);}catch(ignore2){}}}return out;',
      );
      const candidates = { ENABLED: [], PAUSED: [] };
      for (const node of (Array.isArray(nodes) ? nodes : []).slice(0, 1000)) {
        try {
          if (!(await node.isDisplayed()) || !(await node.isEnabled())) continue;
          const text = String(await controlLabel(node) || '').replace(/\s+/g, ' ').trim();
          const kind = /^(?:已启用|Enabled)$/i.test(text) ? 'ENABLED'
            : /^(?:已暂停|Paused)$/i.test(text) ? 'PAUSED' : '';
          if (!kind) continue;
          const outsideCampaignRow = await driver.executeScript(
            'var p=arguments[0],d=0;while(p&&d<20){var r=String(p.getAttribute&&p.getAttribute("role")||"").toLowerCase();'
            + 'if(String(p.tagName||"").toLowerCase()==="tr"||r==="row")return false;'
            + 'var root=null;try{root=p.getRootNode&&p.getRootNode();}catch(ignore){}p=p.parentElement||(root&&root.host)||null;d++;}return true;',
            node,
          );
          if (outsideCampaignRow !== true) continue;
          const input = await driver.executeScript(
            'var e=arguments[0],tag=String(e&&e.tagName||"").toLowerCase(),type=String(e&&e.getAttribute&&e.getAttribute("type")||"").toLowerCase();'
            + 'if((tag==="input"&&type==="radio")||String(e&&e.getAttribute&&e.getAttribute("role")||"").toLowerCase()==="radio")return e;'
            + 'var id=e&&e.getAttribute&&e.getAttribute("for"),root=e&&e.getRootNode&&e.getRootNode(),i=null;'
            + 'if(id){try{i=root&&root.getElementById&&root.getElementById(id);}catch(ignore){}try{if(!i)i=document.getElementById(id);}catch(ignore2){}}'
            + 'if(!i){try{i=e.querySelector("input[type=radio],[role=radio]")||(e.shadowRoot&&e.shadowRoot.querySelector("input[type=radio],[role=radio]"));}catch(ignore3){}}return i;',
            node,
          );
          if (!input) continue;
          const inputType = String(await input.getAttribute('type') || '').toLowerCase();
          const inputRole = String(await input.getAttribute('role') || '').toLowerCase();
          if (inputType !== 'radio' && inputRole !== 'radio') continue;
          const inputName = String(await input.getAttribute('name') || '');
          const inputKey = typeof input.getId === 'function' ? String(await input.getId() || '') : '';
          if (inputKey && candidates[kind].some((candidate) => candidate.inputKey === inputKey)) continue;
          candidates[kind].push({ clickControl: node, input, inputName, inputKey });
        } catch { /* status popover can repaint while options are inspected */ }
      }
      if (candidates.ENABLED.length !== 1 || candidates.PAUSED.length !== 1) return null;
      const enabled = candidates.ENABLED[0];
      const paused = candidates.PAUSED[0];
      const sameNamedGroup = enabled.inputName && enabled.inputName === paused.inputName;
      const samePopover = await driver.executeScript(
        'function chain(e){var a=[],d=0;while(e&&d<20){a.push(e);var r=null;try{r=e.getRootNode&&e.getRootNode();}catch(ignore){}e=e.parentElement||(r&&r.host)||null;d++;}return a;}'
        + 'var a=chain(arguments[0]),b=chain(arguments[1]);for(var i=0;i<a.length;i++){if(a[i]===document.body)break;'
        + 'if(b.indexOf(a[i])>=0)return true;}return false;',
        enabled.clickControl, paused.clickControl,
      );
      if (!sameNamedGroup && samePopover !== true) return null;
      return { ENABLED: enabled, PAUSED: paused };
    };

    const resolveStateFilterTrigger = async () => {
      let fixed = await driver.executeScript(
        'var c=document.getElementById(arguments[0]);return c&&c.querySelector("button");', chipId,
      );
      if (!fixed) {
        fixed = await driver.executeScript(
          'var roots=[document],seen=[],hits=[];for(var ri=0;ri<roots.length&&ri<120;ri++){var r=roots[ri];'
          + 'if(!r||seen.indexOf(r)>=0)continue;seen.push(r);var all=[];try{all=r.querySelectorAll("[id]");}catch(ignore){}'
          + 'for(var i=0;i<all.length&&i<4000;i++){var e=all[i],id=String(e.id||"");'
          + 'try{if(e.shadowRoot&&roots.indexOf(e.shadowRoot)<0)roots.push(e.shadowRoot);}catch(ignore2){}'
          + 'if(!/:filterTag-state$/.test(id))continue;var b=null;try{b=e.querySelector("button");}catch(ignore3){}'
          + 'if(b&&hits.indexOf(b)<0)hits.push(b);}}return hits.length===1?hits[0]:null;',
        );
      }
      if (fixed && await fixed.isDisplayed() && await fixed.isEnabled()) return fixed;

      // Newer Campaign Manager builds no longer expose the legacy chip id.
      // Accept only one clearly identified status-filter popup trigger outside
      // campaign rows. Campaign switches carry aria-checked and are rejected.
      const directControls = await driver.findElements(By.css(
        'button,[role="button"],kat-button,select,[role="combobox"],kat-select,kat-dropdown',
      ));
      const shadowControls = await driver.executeScript(
        'var roots=[document],seen=[],out=[];for(var ri=0;ri<roots.length&&ri<80;ri++){'
        + 'var r=roots[ri];if(!r||seen.indexOf(r)>=0)continue;seen.push(r);var c=[];'
        + 'try{c=r.querySelectorAll("*");}catch(e){}for(var ci=0;ci<c.length&&out.length<1200;ci++){'
        + 'var e=c[ci],tag=String(e.tagName||"").toLowerCase(),role=String(e.getAttribute&&e.getAttribute("role")||"").toLowerCase();'
        + 'var t=String((e.getAttribute&&(e.getAttribute("aria-label")||e.getAttribute("label")||e.getAttribute("title")))||e.innerText||e.textContent||"").replace(/\\s+/g," ").trim();'
        + 'var interactive=/^(?:button|kat-button|select|kat-select|kat-dropdown)$/.test(tag)||/^(?:button|combobox)$/.test(role);'
        + 'var stateLike=t.length>0&&t.length<=120&&/^(?:Status|State|Active|Active status|Campaign status|Delivery status|\\u72b6\\u6001|\\u8fdb\\u884c\\u4e2d|\\u5e7f\\u544a\\u6d3b\\u52a8\\u72b6\\u6001|\\u6295\\u653e\\u72b6\\u6001|\\u8fd0\\u884c\\u72b6\\u6001)(?:\\s*[:\\uff1a].*)?$/i.test(t);'
        + 'if(interactive||stateLike){var chosen=e;if(!interactive){var p=e,d=0;while(p&&d<8){'
        + 'var pt=String(p.tagName||"").toLowerCase(),pr=String(p.getAttribute&&p.getAttribute("role")||"").toLowerCase();'
        + 'if(/^(?:button|kat-button|select|kat-select|kat-dropdown)$/.test(pt)||/^(?:button|combobox)$/.test(pr)){chosen=p;break;}'
        + 'var root=null;try{root=p.getRootNode&&p.getRootNode();}catch(ignore){}p=p.parentElement||(root&&root.host)||null;d++;}}'
        + 'if(out.indexOf(chosen)<0)out.push(chosen);}}'
        + 'var a=[];try{a=r.querySelectorAll("*");}catch(e2){}for(var ai=0;ai<a.length&&ai<5000;ai++){'
        + 'try{if(a[ai].shadowRoot&&roots.indexOf(a[ai].shadowRoot)<0)roots.push(a[ai].shadowRoot);}catch(e3){}}}'
        + 'return out;',
      );
      const controls = Array.isArray(shadowControls) ? shadowControls : directControls;
      const candidates = [];
      const diagnostics = [];
      for (const control of controls.slice(0, 1200)) {
        try {
          if (!(await control.isDisplayed()) || !(await control.isEnabled())) continue;
          const label = String(await controlLabel(control) || '').replace(/\s+/g, ' ').trim();
          const id = String(await control.getAttribute('id') || '').slice(0, 120);
          const testId = String(await control.getAttribute('data-testid') || '').slice(0, 120);
          const ariaControls = String(await control.getAttribute('aria-controls') || '').slice(0, 120);
          const attrs = [id, testId, ariaControls].filter(Boolean).join(' ');
          const popup = String(await control.getAttribute('aria-haspopup') || '').toLowerCase();
          const expanded = String(await control.getAttribute('aria-expanded') || '').toLowerCase();
          const role = String(await control.getAttribute('role') || '').toLowerCase();
          const tag = typeof control.getTagName === 'function'
            ? String(await control.getTagName() || '').toLowerCase() : '';
          const rawHref = tag === 'a' ? String(await driver.executeScript(
            'return arguments[0]&&arguments[0].getAttribute("href")||"";', control,
          ) || '').trim() : '';
          const checked = await control.getAttribute('aria-checked');
          const sort = await control.getAttribute('aria-sort');
          const inertFilterHref = /^(?:#|javascript:(?:void\(0\);?|;?))$/i.test(rawHref);
          let safeFilterAnchor = tag === 'a' && (!rawHref || inertFilterHref);
          if (tag === 'a' && rawHref && !inertFilterHref) {
            try {
              const resolvedHref = new URL(rawHref, await driver.getCurrentUrl());
              const approvedHref = approvedAmazonUrl(resolvedHref.toString());
              safeFilterAnchor = !!approvedHref && !approvedHref.port
                && approvedHref.hostname === 'advertising.amazon.com'
                && /campaign-manager|campaigns/i.test(approvedHref.pathname);
            } catch { safeFilterAnchor = false; }
          }
          const popupProof = ['true', 'menu', 'listbox', 'dialog'].includes(popup)
            || ['true', 'false'].includes(expanded)
            || role === 'combobox' || ['select', 'kat-select', 'kat-dropdown'].includes(tag)
            || safeFilterAnchor
            || /(?:filter.*(?:state|status)|(?:state|status).*filter)/i.test(attrs);
          const outsideCampaignRow = await driver.executeScript(
            'for(var p=arguments[0];p&&p!==document.body;p=p.parentElement){'
            + 'var r=String(p.getAttribute&&p.getAttribute("role")||"").toLowerCase();'
            + 'if(String(p.tagName||"").toLowerCase()==="tr"||r==="row")return false;}return true;',
            control,
          );
          if (
            diagnostics.length < 12
            && (popupProof || /status|state|active|filter|\u72b6\u6001|\u8fdb\u884c\u4e2d|\u7b5b\u9009/i.test(label))
          ) diagnostics.push({
            label: label.slice(0, 80), id, testId, ariaControls, popup, expanded, role, tag,
            hrefKind: !rawHref ? 'none' : rawHref === '#' ? 'fragment'
              : inertFilterHref ? 'inert' : 'other',
            safeFilterAnchor,
            hasChecked: checked !== null, hasSort: sort !== null,
            outsideCampaignRow: outsideCampaignRow === true,
          });
          const exactLabel = /^(?:Status|State|Active|Active status|Campaign status|Delivery status|\u72b6\u6001|\u8fdb\u884c\u4e2d|\u5e7f\u544a\u6d3b\u52a8\u72b6\u6001|\u6295\u653e\u72b6\u6001|\u8fd0\u884c\u72b6\u6001)(?:\s*[:\uff1a]\s*(?:All|\u5168\u90e8|Enabled|Paused|\u5df2\u542f\u7528|\u5df2\u6682\u505c))?$/i.test(label);
          if (!exactLabel || !popupProof || checked !== null || sort !== null) continue;
          if (outsideCampaignRow === true) candidates.push(control);
        } catch { /* controls can repaint while the table hydrates */ }
      }
      stateFilterDiagnostics = diagnostics;
      if (candidates.length > 1) {
        throw new ZiniaoError(`Amazon Ads 状态筛选入口不唯一（${candidates.length}），拒绝点击`);
      }
      if (candidates.length === 1) semanticTrigger = candidates[0];
      return candidates[0] || null;
    };

    await approvedPage();
    const preSafety = await classifyLivePageSafety({ zn: this, storeId });
    if (!preSafety.safe) throw new ZiniaoError('Amazon Ads 状态筛选前检测到认证、拦截或不可验证页面');
    const dismissedCoachmarks = await this.dismissAdvertisingCoachmarks(storeId);
    if (dismissedCoachmarks > 0) {
      await approvedPage();
      await this.sleep(500);
      const postCoachmarkSafety = await classifyLivePageSafety({ zn: this, storeId });
      if (!postCoachmarkSafety.safe) throw new ZiniaoError('Amazon Ads 新手引导关闭后页面安全状态异常');
    }

    // The 2026 Campaign Manager paints its campaign table below a large
    // analytics overview and does not hydrate the filter bar until that area
    // enters the viewport. Reveal only the exact read-only table header. When
    // the header text is already present but enclosed by a closed component,
    // a bounded midpoint scroll triggers the same lazy render. This never
    // clicks a campaign row, switch, or mutation control.
    const tableReveal = await driver.executeScript(
      'var roots=[document],seen=[],hits=[];for(var ri=0;ri<roots.length&&ri<120;ri++){var r=roots[ri];'
      + 'if(!r||seen.indexOf(r)>=0)continue;seen.push(r);var all=[];try{all=r.querySelectorAll("*");}catch(ignore){}'
      + 'for(var i=0;i<all.length&&i<6000;i++){var e=all[i];try{if(e.shadowRoot&&roots.indexOf(e.shadowRoot)<0)roots.push(e.shadowRoot);}catch(ignore2){}'
      + 'var t=String(e.innerText||e.textContent||"").replace(/\\s+/g," ").trim();'
      + 'if(/^(?:Campaign name|\\u5e7f\\u544a\\u6d3b\\u52a8\\u540d\\u79f0)$/i.test(t)&&e.getClientRects&&e.getClientRects().length)hits.push(e);}}'
      + 'if(hits.length){hits.sort(function(a,b){return a.childElementCount-b.childElementCount;});'
      + 'hits[0].scrollIntoView({block:"center",inline:"nearest"});return "header";}'
      + 'var body=String(document.body&&(document.body.innerText||document.body.textContent)||"");'
      + 'if(/Campaign name|\\u5e7f\\u544a\\u6d3b\\u52a8\\u540d\\u79f0/i.test(body)){var d=document.documentElement;'
      + 'window.scrollTo(0,Math.max(0,Math.min(d.scrollHeight-window.innerHeight,Math.floor(d.scrollHeight*0.55))));return "midpoint";}'
      + 'return "none";',
    );
    if (tableReveal !== 'none') {
      await this.sleep(800);
      await approvedPage();
      const postRevealSafety = await classifyLivePageSafety({ zn: this, storeId });
      if (!postRevealSafety.safe) throw new ZiniaoError('Amazon Ads 活动表显示后页面安全状态异常');
    }
    if (stateMatches(await chipState(), targetState)) {
      return { state: targetState, changed: false };
    }

    let trigger = null;
    while (Date.now() < deadline && !trigger) {
      await approvedPage();
      const candidate = await resolveStateFilterTrigger();
      if (candidate && await candidate.isDisplayed() && await candidate.isEnabled()) trigger = candidate;
      if (!trigger) await this.sleep(250);
    }
    if (!trigger || !(await trigger.isDisplayed()) || !(await trigger.isEnabled())) {
      throw new ZiniaoError(`Amazon Ads 状态筛选标签不可用（安全诊断 ${JSON.stringify(stateFilterDiagnostics)}）`);
    }
    const existingChip = String(await chipState() || '');
    if (!existingChip || existingChip.length > 160) {
      throw new ZiniaoError('Amazon Ads 状态筛选标签为空或超出安全长度');
    }
    try {
      await trigger.click();
    } catch (e) {
      if (!/click intercepted|not interactable/i.test(String(e?.message || e))) throw e;
      await this.clickNativeElement(session, trigger);
    }

    let targetLabel = null;
    let targetInput = null;
    let otherInput = null;
    let semanticPairVerified = false;
    while (Date.now() < deadline && !targetLabel) {
      await approvedPage();
      const labels = await driver.findElements(By.css('label'));
      const targetLabels = [];
      const otherLabels = [];
      for (const label of labels.slice(0, 1000)) {
        try {
          if (!(await label.isDisplayed()) || !(await label.isEnabled())) continue;
          const forId = String(await label.getAttribute('for') || '');
          const text = String(await label.getText() || '').replace(/\s+/g, ' ').trim();
          if (forId === optionId && target.labels.test(text)) targetLabels.push(label);
          if (forId === otherId && /^(?:已启用|已暂停|Enabled|Paused)$/i.test(text)) otherLabels.push(label);
        } catch { /* filter popover can repaint while opening */ }
      }
      const inputs = await driver.findElements(By.id(optionId));
      const otherInputs = await driver.findElements(By.id(otherId));
      if (targetLabels.length === 1 && otherLabels.length === 1 && inputs.length === 1 && otherInputs.length === 1) {
        const input = inputs[0];
        const legacyOtherInput = otherInputs[0];
        const validInput = String(await input.getAttribute('type') || '').toLowerCase() === 'radio'
          && String(await input.getAttribute('name') || '') === optionName
          && String(await input.getAttribute('value') || '').toUpperCase() === targetState
          && await input.isEnabled();
        const validOther = String(await legacyOtherInput.getAttribute('type') || '').toLowerCase() === 'radio'
          && String(await legacyOtherInput.getAttribute('name') || '') === optionName
          && String(await legacyOtherInput.getAttribute('value') || '').toUpperCase() === target.other;
        if (validInput && validOther) {
          targetLabel = targetLabels[0];
          targetInput = input;
          otherInput = legacyOtherInput;
          semanticPairVerified = true;
        }
      }
      if (!targetLabel) {
        const semantic = await resolveSemanticStateOptions();
        if (semantic) {
          targetLabel = semantic[targetState].clickControl;
          targetInput = semantic[targetState].input;
          otherInput = semantic[target.other].input;
          semanticPairVerified = true;
        }
      }
      if (!targetLabel) await this.sleep(200);
    }
    if (!targetLabel) throw new ZiniaoError('Amazon Ads 状态筛选弹层缺少唯一、可验证的目标单选项');

    // Click only the label bound to the exact validated read-only radio. If
    // the custom label swallows the WebDriver event, click that same radio
    // element directly; campaign-row switches have different ids/names and
    // can never enter this branch.
    try {
      await targetLabel.click();
    } catch (e) {
      if (!/click intercepted|not interactable/i.test(String(e?.message || e))) throw e;
    }
    await this.sleep(200);
    let initiallySelected = await driver.executeScript(
      'var i=arguments[0];return !!(i&&((String(i.type||"").toLowerCase()==="radio"&&i.checked)||i.getAttribute("aria-checked")==="true"));',
      targetInput,
    );
    if (initiallySelected !== true) {
      const inputType = String(await targetInput?.getAttribute('type') || '').toLowerCase();
      const inputRole = String(await targetInput?.getAttribute('role') || '').toLowerCase();
      const stillValid = semanticPairVerified && (inputType === 'radio' || inputRole === 'radio')
        && await targetInput.isEnabled();
      if (!stillValid) throw new ZiniaoError('Amazon Ads 目标状态单选框校验失效，拒绝点击');
      await driver.executeScript('arguments[0].click();', targetInput);
      await this.sleep(200);
      initiallySelected = await driver.executeScript(
        'var i=arguments[0];return !!(i&&((String(i.type||"").toLowerCase()==="radio"&&i.checked)||i.getAttribute("aria-checked")==="true"));',
        targetInput,
      );
    }
    let applyAttempted = false;
    let applyExactObserved = 0;
    let applyBoundObserved = 0;
    let lastSelected = false;
    let lastChipMatched = false;
    while (Date.now() < deadline) {
      await approvedPage();
      const selected = await driver.executeScript(
        'var i=arguments[0];return !!(i&&((String(i.type||"").toLowerCase()==="radio"&&i.checked)||i.getAttribute("aria-checked")==="true"));',
        targetInput,
      );
      const currentChip = await chipState();
      lastSelected = selected === true;
      lastChipMatched = stateMatches(currentChip, targetState);
      if (stateMatches(currentChip, targetState) && (selected === true || applyAttempted)) {
        const postSafety = await classifyLivePageSafety({ zn: this, storeId });
        if (!postSafety.safe) throw new ZiniaoError('Amazon Ads 状态筛选后检测到认证、拦截或不可验证页面');
        return { state: targetState, changed: true };
      }
      if (selected === true && !applyAttempted) {
        // Some Campaign Manager builds stage the radio selection and require
        // an Apply action. Bind that action to the exact ancestor containing
        // both verified status radios; a global editor/save action can never
        // satisfy this containment proof.
        const controls = await driver.findElements(By.css(
          'button,[role="button"],kat-button,input[type="button"],input[type="submit"]',
        ));
        const exactApply = [];
        const boundApply = [];
        for (const control of controls.slice(0, 1000)) {
          try {
            if (!(await control.isDisplayed()) || !(await control.isEnabled())) continue;
            const label = String(
              (await control.getText())
              || (await control.getAttribute('value'))
              || (await control.getAttribute('aria-label'))
              || (await control.getAttribute('label'))
              || '',
            ).replace(/\s+/g, ' ').trim();
            if (!/^(?:Apply|Apply filter|Apply filters|\u5e94\u7528|\u5e94\u7528\u7b5b\u9009)$/i.test(label)) continue;
            const bound = await driver.executeScript(
              'var c=arguments[0],a=arguments[1],b=arguments[2];'
              + 'if(!c||!a||!b)return false;for(var p=a;p&&p!==document.body;p=p.parentElement){'
              + 'if(typeof p.contains==="function"&&p.contains(b)&&p.contains(c))return true;}return false;',
              control, targetInput, otherInput,
            );
            exactApply.push(control);
            if (bound === true) boundApply.push(control);
          } catch { /* filter popover can repaint after radio selection */ }
        }
        applyExactObserved = exactApply.length;
        applyBoundObserved = boundApply.length;
        if (boundApply.length > 1 || exactApply.length > 1) {
          throw new ZiniaoError('Amazon Ads 状态筛选存在多个同容器“应用筛选”控件，拒绝点击');
        }
        let applyControl = boundApply[0] || null;
        if (!applyControl && exactApply.length === 1 && semanticPairVerified) {
          // Portalled popovers may attach their footer directly under body,
          // leaving no non-body common ancestor. In that case require the
          // exact ENABLED and PAUSED radio labels to still be uniquely visible
          // before accepting the one exact Apply-filter action.
          const visibleStateLabels = [];
          for (const label of await driver.findElements(By.css('label'))) {
            try {
              if (!(await label.isDisplayed()) || !(await label.isEnabled())) continue;
              const forId = String(await label.getAttribute('for') || '');
              const text = String(await label.getText() || '').replace(/\s+/g, ' ').trim();
              if (
                (forId === optionId || forId === otherId)
                && /^(?:\u5df2\u542f\u7528|\u5df2\u6682\u505c|Enabled|Paused)$/i.test(text)
              ) visibleStateLabels.push(forId);
            } catch { /* popover repaint */ }
          }
          if (
            (new Set(visibleStateLabels).size === 2 && visibleStateLabels.length === 2)
            || semanticPairVerified
          ) {
            applyControl = exactApply[0];
          }
        }
        if (applyControl) {
          try {
            await applyControl.click();
          } catch (e) {
            if (!/click intercepted|not interactable/i.test(String(e?.message || e))) throw e;
            await driver.executeScript('arguments[0].click();', applyControl);
          }
          applyAttempted = true;
          await this.sleep(350);
          continue;
        }
      }
      await this.sleep(250);
    }
    throw new ZiniaoError(
      `Amazon Ads 状态筛选后未观察到目标筛选生效（安全计数 ${JSON.stringify({
        selected: lastSelected, chipMatched: lastChipMatched, applyAttempted,
        applyExactObserved, applyBoundObserved,
      })}）`,
    );
  }

  /**
   * Recover an expired Amazon Seller Central session without marketplace
   * credentials. Ziniao fills the account/password and OTP; this method only
   * advances the approved Passkey flow and submits a freshly filled OTP.
   */
  async restoreAmazonLogin(storeId) {
    const session = this.session(storeId);
    const { driver } = session;
    const { By } = await import('selenium-webdriver');
    const timeoutMs = Math.max(30000, Number(this.config.amazonLoginTimeoutMs || 90000));
    const deadline = Date.now() + timeoutMs;

    const authState = async () => {
      const parsed = approvedAmazonUrl(await driver.getCurrentUrl());
      if (!parsed || parsed.port || !/^sellercentral\.amazon\./i.test(parsed.hostname)) return 'other';
      if (/^\/ap\/mfa(?:\/|$)/i.test(parsed.pathname)) return 'mfa';
      if (/^\/ap\/signin(?:\/|$)/i.test(parsed.pathname)) return 'signin';
      return 'authenticated';
    };
    const find = async (selector) => {
      const elements = await driver.findElements(By.css(selector));
      return elements[0] || null;
    };
    const findOtpInput = async () => {
      const elements = await driver.findElements(By.css(
        '#auth-mfa-otpcode,input[autocomplete="one-time-code"]',
      ));
      const visible = [];
      for (const element of elements.slice(0, 20)) {
        try { if (await element.isDisplayed()) visible.push(element); } catch { /* MFA shell repaint */ }
      }
      if (visible.length > 1) {
        throw new ZiniaoError('Amazon 两步验证页存在多个验证码输入框，拒绝读取或提交');
      }
      return visible[0] || null;
    };
    const controlLabel = async (control) => String(
      (await control.getText())
      || (await control.getAttribute('value'))
      || (await control.getAttribute('aria-label'))
      || (await control.getAttribute('label'))
      || '',
    ).trim();
    const amazonButtonWrapperLabel = async (control) => {
      try {
        return String(await driver.executeScript(
          '/* amzguard-amazon-button-wrapper-label-v1 */'
          + 'var e=arguments[0],p=e&&e.closest?e.closest(".a-button"):null,'
          + 't=p&&p.querySelector?p.querySelector(".a-button-text"):null;'
          + 'return t?String(t.textContent||"").replace(/\\s+/g," ").trim():"";',
          control,
        ) || '').trim();
      } catch { return ''; }
    };
    const clickControl = async (control) => {
      try {
        await control.click();
      } catch (e) {
        if (!/click intercepted|not interactable|stale element/i.test(String(e?.message || e))) throw e;
        await driver.executeScript('arguments[0].click();', control);
      }
    };
    const findApprovedControl = async (kind, { allowDisabled = false } = {}) => {
      const controls = await driver.findElements(By.css(
        'button,a,[role="button"],input[type="submit"],kat-button',
      ));
      // Ziniao can paint the approved Passkey/OTP actions inside an open
      // shadow root. Selenium's document-level findElements does not cross
      // that boundary, so collect only the same allow-listed control shapes
      // from open shadow roots. Inputs and page text are deliberately never
      // returned by this probe.
      try {
        const shadowControls = await driver.executeScript(
          '/* amzguard-open-shadow-login-controls-v1 */'
          + 'var out=[],roots=[],seen=[],all=document.querySelectorAll("*");'
          + 'for(var i=0;i<all.length&&i<5000;i++){try{if(all[i].shadowRoot)roots.push(all[i].shadowRoot);}catch(ignore){}}'
          + 'for(var r=0;r<roots.length&&r<200;r++){var root=roots[r];if(seen.indexOf(root)>=0)continue;seen.push(root);'
          + 'var nodes=[];try{nodes=root.querySelectorAll("button,a,[role=button],input[type=submit],kat-button");}catch(ignore2){}'
          + 'for(var n=0;n<nodes.length&&out.length<500;n++)out.push(nodes[n]);'
          + 'var nested=[];try{nested=root.querySelectorAll("*");}catch(ignore3){}'
          + 'for(var j=0;j<nested.length&&j<5000;j++){try{if(nested[j].shadowRoot)roots.push(nested[j].shadowRoot);}catch(ignore4){}}}'
          + 'return out;',
        );
        if (Array.isArray(shadowControls)) controls.push(...shadowControls);
      } catch {
        // Closed/opaque roots are intentionally not pierced. The ordinary
        // document controls remain available and unknown UI fails closed.
      }
      const approved = [];
      for (const control of controls.slice(0, 500)) {
        try {
          if (!(await control.isDisplayed())) continue;
          if (!allowDisabled && !(await control.isEnabled())) continue;
          let label = await controlLabel(control);
          if (!isApprovedAmazonLoginAction(kind, label)) label = await amazonButtonWrapperLabel(control);
          if (isApprovedAmazonLoginAction(kind, label)) approved.push({ control, label });
        } catch { /* sign-in shell can replace controls while being inspected */ }
      }
      if (approved.length > 1) {
        throw new ZiniaoError(`Amazon 登录页存在多个已批准的${kind}控件，无法安全确定目标`);
      }
      return approved[0]?.control || null;
    };
    const findExistingAccount = async () => {
      const links = await driver.findElements(By.css('a'));
      const approved = [];
      for (const link of links.slice(0, 300)) {
        try {
          if (!(await link.isDisplayed()) || !(await link.isEnabled())) continue;
          const label = String(await link.getText() || '').trim();
          const href = String(await link.getAttribute('href') || '').trim();
          if (isApprovedExistingAccountLink({ label, href })) approved.push(link);
        } catch { /* sign-in shell can replace account cards asynchronously */ }
      }
      if (approved.length > 1) {
        throw new ZiniaoError('Amazon 登录页存在多个已登录账户卡，无法安全确定目标');
      }
      return approved[0] || null;
    };
    const waitFor = async (predicate, limitMs, message) => {
      const untilAt = Math.min(deadline, Date.now() + limitMs);
      while (Date.now() < untilAt) {
        try { if (await predicate()) return; } catch { /* page may be navigating */ }
        await this.sleep(200);
      }
      throw new ZiniaoError(message);
    };
    const safeLoginDiagnostics = async () => {
      try {
        const value = await driver.executeScript(
          '/* amzguard-login-diagnostics-v1 */'
          + 'var roots=[document],seen=[],controls=0,clickableControls=0,links=0,signinLinks=0,sellerReturnLinks=0,'
          + 'accountStructureHints=0,maskedLinkLabels=0,switchHints=0,removeHints=0,differentAccountHints=0,'
          + 'passkeyHints=0,continueHints=0,otpHints=0,signInHints=0,emailFields=0,passwordFields=0,otpFields=0,'
          + 'frames=0,unreadableFrames=0;'
          + 'for(var r=0;r<roots.length&&r<256;r++){var root=roots[r];if(seen.indexOf(root)>=0)continue;seen.push(root);'
          + 'var all=[];try{all=root.querySelectorAll("*");}catch(ignore){}'
          + 'for(var i=0;i<all.length&&i<10000;i++){var el=all[i];try{if(el.shadowRoot)roots.push(el.shadowRoot);'
          + 'var tag=String(el.tagName||"").toLowerCase();if(tag==="iframe"||tag==="frame"){frames++;'
          + 'try{var fd=el.contentDocument||(el.contentWindow&&el.contentWindow.document);if(fd&&fd.documentElement)roots.push(fd);else unreadableFrames++;}catch(ignore2){unreadableFrames++;}}}catch(ignore3){}}'
          + 'var nodes=[];try{nodes=root.querySelectorAll("button,a,[role=button],input[type=submit],kat-button,label,h1,h2");}catch(ignore4){}'
          + 'for(var n=0;n<nodes.length&&n<2000;n++){var node=nodes[n],t="";try{t=String((node.getAttribute&&(node.getAttribute("aria-label")||node.getAttribute("label")))||node.innerText||node.textContent||"").replace(/\\s+/g," ").trim();}catch(ignore5){}'
          + 'if(!t)continue;controls++;var tag2=String(node.tagName||"").toLowerCase();'
          + 'if(tag2==="button"||tag2==="a"||tag2==="kat-button"||String(node.getAttribute&&node.getAttribute("role")||"").toLowerCase()==="button")clickableControls++;'
          + 'if(tag2==="a"){links++;var href="",u=null;try{href=String(node.getAttribute("href")||"");u=new URL(href,location.href);}catch(ignore7){}'
          + 'if(u&&/\\/ap\\/signin(?:\\/|$)/i.test(u.pathname)){signinLinks++;var rt="";try{rt=String(u.searchParams.get("openid.return_to")||u.searchParams.get("return_to")||"");}catch(ignore8){}'
          + 'if(/^https:\\/\\/sellercentral\\.amazon\\./i.test(rt))sellerReturnLinks++;}'
          + 'var meta="";try{meta=String((node.getAttribute("class")||"")+" "+(node.getAttribute("id")||"")+" "+(node.getAttribute("data-testid")||"")+" "+(node.getAttribute("data-test")||""));}catch(ignore9){}'
          + 'if(/account|profile|identity/i.test(meta))accountStructureHints++;if(/@|\\*{2,}|x{2,}\\d{2,4}/i.test(t))maskedLinkLabels++;}'
          + 'if(/switch account|change account|\\u5207\\u6362\\u8d26\\u6237|\\u66f4\\u6362\\u8d26\\u6237/i.test(t))switchHints++;'
          + 'if(/remove account|delete account|\\u79fb\\u9664\\u8d26\\u6237|\\u5220\\u9664\\u8d26\\u6237/i.test(t))removeHints++;'
          + 'if(/use (?:a )?different account|add account|\\u4f7f\\u7528\\u5176\\u4ed6\\u8d26\\u6237|\\u6dfb\\u52a0\\u8d26\\u6237/i.test(t))differentAccountHints++;'
          + 'if(/passkey|\\u5bc6\\u94a5/i.test(t))passkeyHints++;'
          + 'if(/^(?:continue|next|\\u7ee7\\u7eed|\\u4e0b\\u4e00\\u6b65)$/i.test(t))continueHints++;'
          + 'if(/verification code|one.time code|otp|\\u9a8c\\u8bc1\\u7801/i.test(t))otpHints++;'
          + 'if(/^(?:sign in|log in|\\u767b\\u5f55|\\u767b\\u5165)$/i.test(t))signInHints++;}'
          + 'try{emailFields+=root.querySelectorAll("#ap_email").length;passwordFields+=root.querySelectorAll("#ap_password,input[type=password]").length;'
          + 'otpFields+=root.querySelectorAll("#auth-mfa-otpcode,input[autocomplete=one-time-code]").length;}catch(ignore6){}}'
          + 'return {probeVersion:1,roots:seen.length,controls:controls,clickableControls:clickableControls,links:links,'
          + 'signinLinks:signinLinks,sellerReturnLinks:sellerReturnLinks,accountStructureHints:accountStructureHints,'
          + 'maskedLinkLabels:maskedLinkLabels,switchHints:switchHints,removeHints:removeHints,differentAccountHints:differentAccountHints,'
          + 'passkeyHints:passkeyHints,continueHints:continueHints,'
          + 'otpHints:otpHints,signInHints:signInHints,emailFields:emailFields,passwordFields:passwordFields,otpFields:otpFields,'
          + 'frames:frames,unreadableFrames:unreadableFrames};',
        );
        if (!value || value.probeVersion !== 1) return null;
        const fields = [
          'roots', 'controls', 'clickableControls', 'links', 'signinLinks', 'sellerReturnLinks',
          'accountStructureHints', 'maskedLinkLabels', 'switchHints', 'removeHints', 'differentAccountHints',
          'passkeyHints', 'continueHints', 'otpHints', 'signInHints',
          'emailFields', 'passwordFields', 'otpFields', 'frames', 'unreadableFrames',
        ];
        const safe = {};
        for (const field of fields) {
          const count = Number(value[field]);
          if (Number.isSafeInteger(count) && count >= 0 && count <= 100000) safe[field] = count;
        }
        return safe;
      } catch {
        return null;
      }
    };

    let state = await authState();
    if (state === 'authenticated' || state === 'other') return false;
    this.logger.info?.(`[${session.name || '店铺'}] 检测到 Amazon 登录页，启动紫鸟 Passkey 自动恢复`);

    if (state === 'signin') {
      // Some Seller Central sessions first show Amazon's saved-account chooser.
      // Only the single, already-signed-in card shape approved by the shared
      // allowlist may be advanced; multiple/unknown cards remain fail-closed.
      // The Amazon shell and Ziniao extension are injected asynchronously.
      // A /ap/signin URL can therefore be visible several seconds before its
      // approved account, email or Passkey action exists. Wait for one safe,
      // actionable stage instead of turning that transient shell into a
      // permanent LOGIN_REQUIRED result.
      const stageDeadline = Math.min(deadline, Date.now() + 25000);
      let accountAdvanced = false;
      let email = null;
      let primedPasskey = null;
      while (Date.now() < stageDeadline && (await authState()) === 'signin') {
        if (!accountAdvanced) {
          const account = await findExistingAccount();
          if (account) {
            await clickControl(account);
            accountAdvanced = true;
            await this.sleep(800);
            continue;
          }
        }
        email = await find('#ap_email');
        if (email && await email.isDisplayed()) break;
        primedPasskey = await findApprovedControl('passkey', { allowDisabled: true });
        if (primedPasskey) break;
        await this.sleep(300);
      }

      if (email && await email.isDisplayed()) {
        const next = await find('#continue') || await findApprovedControl('continue');
        if (!next) throw new ZiniaoError('Amazon 登录页缺少“继续”按钮');
        const nextLabel = await controlLabel(next);
        if (
          !(await next.isDisplayed())
          || !(await next.isEnabled())
          || !isApprovedAmazonLoginAction('continue', nextLabel)
        ) {
          throw new ZiniaoError(`Amazon 登录页拒绝点击未批准的继续控件: ${nextLabel || '(空)'}`);
        }
        await clickControl(next);
        await waitFor(async () => {
          if ((await authState()) !== 'signin') return true;
          const candidate = await findApprovedControl('passkey', { allowDisabled: true });
          return !!candidate;
        }, 15000, '等待 Amazon Passkey 页面就绪超时');
      }

      state = await authState();
      if (state === 'signin') {
        // Amazon and Ziniao have used button, input, role=button and KAT hosts
        // for the same approved Passkey action. Bind to the exact visible label
        // instead of a brittle element type/id; never click an unknown control.
        const passkey = primedPasskey || await findApprovedControl('passkey', { allowDisabled: true });
        if (!passkey) {
          const diagnostics = await safeLoginDiagnostics();
          throw new ZiniaoError(`Amazon 登录页缺少“使用密钥登录”按钮${diagnostics ? `（安全计数 ${JSON.stringify(diagnostics)}）` : ''}`);
        }
        const label = await controlLabel(passkey);
        if (!isApprovedAmazonLoginAction('passkey', label)) {
          throw new ZiniaoError(`未识别的 Amazon Passkey 登录按钮: ${label || '(空)'}`);
        }
        await this.sleep(800);
        if (await passkey.isEnabled()) {
          try {
            await clickControl(passkey);
          } catch (e) {
            throw e;
          }
          await this.sleep(1200);
        } else {
          // Chrome may open the stored-Passkey chooser automatically after the
          // account step. While that native dialog is open it deliberately
          // disables the underlying web button, so proceed straight to the
          // native confirmation instead of waiting for it to re-enable.
          this.logger.info?.(`[${session.name || '店铺'}] 原生 Passkey 选择框已自动弹出`);
        }
        await this.clickNativePasskey(session);
        await waitFor(async () => (await authState()) === 'mfa', 20000, '点击 Passkey 后未进入 Amazon 两步验证页');
      }
    }

    state = await authState();
    if (state !== 'mfa') return state === 'authenticated';

    // Some Amazon MFA screens first present three delivery methods. The store
    // owner has explicitly approved the first option. Bind that instruction
    // to exactly three visible, enabled radio controls on /ap/mfa; never read
    // or log their values/labels because they can contain phone/email details.
    const selectFirstMfaMethod = async () => {
      const radios = await driver.findElements(By.css('input[type="radio"]'));
      const visible = [];
      for (const radio of radios.slice(0, 20)) {
        try {
          if (await radio.isDisplayed() && await radio.isEnabled()) visible.push(radio);
        } catch { /* MFA choice shell can repaint */ }
      }
      if (!visible.length) return false;
      if (visible.length !== 3) {
        throw new ZiniaoError(`Amazon 二步验证方式数量不是已批准的 3 项（实际 ${visible.length} 项），拒绝选择`);
      }
      await clickControl(visible[0]);
      this.logger.info?.(`[${session.name || '店铺'}] 已选择 Amazon 二步验证的第一个方式（选项内容未读取）`);
      await this.sleep(500);
      const next = await findApprovedControl('continue');
      if (next) {
        await clickControl(next);
        this.logger.info?.(`[${session.name || '店铺'}] 已确认第一个二步验证方式`);
        await this.sleep(500);
      }
      return true;
    };
    const selectedMfaMethod = await selectFirstMfaMethod();
    if (selectedMfaMethod) {
      let sendOtp = null;
      let otpPageReady = false;
      await waitFor(async () => {
        if ((await authState()) === 'authenticated') return true;
        sendOtp = await findApprovedControl('sendOtp');
        if (sendOtp) return true;
        otpPageReady = !!(await findOtpInput());
        return otpPageReady;
      }, 10000, '选择第一个二步验证方式后未出现“发送一次性密码”按钮');
      if ((await authState()) === 'authenticated') return true;
      if (sendOtp) {
        // Amazon's MFA method chooser uses a visually overlaid submit input.
        // A WebDriver element click can report success without producing the
        // trusted native activation that advances this page. The control has
        // already passed the exact sendOtp allowlist, so use the same bounded
        // native element click used by other approved Ziniao UI transitions.
        await this.clickNativeElement(session, sendOtp);
        this.logger.info?.(`[${session.name || '店铺'}] 已点击 Amazon“发送一次性密码”`);
        await this.sleep(800);

        // On the current Amazon method chooser the first trusted native click
        // can be swallowed while its selection handler is still settling. A
        // later operator click advances immediately. Retry exactly once, and
        // only while the same three-choice MFA surface remains visible and no
        // OTP field has appeared. Never switch to another method.
        const retryChoiceDeadline = Math.min(deadline, Date.now() + 20000);
        while (Date.now() < retryChoiceDeadline) {
          const retryState = await authState();
          if (retryState === 'authenticated' || await findOtpInput()) break;
          if (retryState === 'mfa') {
            const retryRadios = await driver.findElements(By.css('input[type="radio"]'));
            const visibleRetryRadios = [];
            for (const radio of retryRadios.slice(0, 10)) {
              try {
                if (await radio.isDisplayed() && await radio.isEnabled()) visibleRetryRadios.push(radio);
              } catch { /* MFA shell repaint */ }
            }
            if (visibleRetryRadios.length === 3) {
              await visibleRetryRadios[0].click();
              await this.sleep(1500);
              const retrySendOtp = await findApprovedControl('sendOtp');
              if (!retrySendOtp) {
                throw new ZiniaoError('Amazon 二步验证方式仍可见，但安全重试按钮已变化');
              }
              await this.clickNativeElement(session, retrySendOtp);
              this.logger.info?.(`[${session.name || '店铺'}] Amazon 首次未转场，已按同一第一方式安全重试一次`);
              await this.sleep(800);
              break;
            }
          }
          await this.sleep(250);
        }
      }
    }

    // Ziniao injects the approved OTP action asynchronously. Looking only once
    // immediately after /ap/mfa becomes visible can miss that control and wait
    // forever for a code that was never requested. Poll the exact allowlisted
    // action, click it at most once, and never read the resulting OTP value.
    let acceptOtpRequested = false;
    const requestOtpIfAvailable = async () => {
      if (acceptOtpRequested) return false;
      const acceptOtp = await findApprovedControl('acceptOtp');
      if (!acceptOtp) return false;
      await clickControl(acceptOtp);
      acceptOtpRequested = true;
      this.logger.info?.(`[${session.name || '店铺'}] 已请求紫鸟接收 Amazon 验证码`);
      await this.sleep(500);
      return true;
    };

    const otpInjectionDeadline = Math.min(deadline, Date.now() + 15000);
    while (Date.now() < otpInjectionDeadline) {
      const currentState = await authState();
      if (currentState === 'authenticated') {
        this.logger.info?.(`[${session.name || '店铺'}] 紫鸟已自动完成 Amazon 两步验证`);
        return true;
      }
      if (currentState !== 'mfa') break;
      const otpCandidate = await findOtpInput();
      if (otpCandidate && await otpInputIsReady(driver, otpCandidate)) break;
      if (await requestOtpIfAvailable()) break;
      await this.sleep(250);
    }

    let requireOtpReset = false;
    for (let attempt = 1; attempt <= 3 && Date.now() < deadline; attempt++) {
      let otp = null;
      if (requireOtpReset) {
        await waitFor(async () => {
          if ((await authState()) === 'authenticated') return true;
          otp = await findOtpInput();
          return !!otp && !(await otpInputIsReady(driver, otp));
        }, 10000, 'Amazon 验证码输入框未重置，已停止重复提交');
        if ((await authState()) === 'authenticated') {
          this.logger.info?.(`[${session.name || '店铺'}] 紫鸟已自动完成 Amazon 两步验证`);
          return true;
        }
      }
      let autoAuthenticated = false;
      try {
        await waitFor(async () => {
          const currentState = await authState();
          if (currentState === 'authenticated') {
            autoAuthenticated = true;
            return true;
          }
          if (currentState !== 'mfa') return false;
          await requestOtpIfAvailable();
          otp = await findOtpInput();
          return otpInputIsReady(driver, otp);
        }, 60000, '等待紫鸟自动填入 Amazon 验证码超时');
      } catch (error) {
        const diagnostics = await safeLoginDiagnostics();
        throw new ZiniaoError(`${error.message}${diagnostics ? `（安全计数 ${JSON.stringify(diagnostics)}）` : ''}`);
      }
      if (autoAuthenticated) {
        this.logger.info?.(`[${session.name || '店铺'}] 紫鸟已自动完成 Amazon 两步验证`);
        return true;
      }

      // Submit immediately. A failed retry must observe an empty/reset field
      // before another ready boolean, so the same code is never resubmitted.
      const submit = await find('#auth-signin-button') || await findApprovedControl('signIn');
      if (!submit) throw new ZiniaoError('Amazon 两步验证页缺少登录按钮');
      let submitLabel = await controlLabel(submit);
      if (!isApprovedAmazonLoginAction('signIn', submitLabel)) {
        submitLabel = await amazonButtonWrapperLabel(submit);
      }
      if (
        !(await submit.isDisplayed())
        || !(await submit.isEnabled())
        || !isApprovedAmazonLoginAction('signIn', submitLabel)
      ) {
        throw new ZiniaoError(`Amazon 两步验证页拒绝点击未批准的登录控件: ${submitLabel || '(空)'}`);
      }
      await submit.click();
      try {
        await waitFor(async () => (await authState()) === 'authenticated', 12000, '验证码提交后仍停留在认证页');
        this.logger.info?.(`[${session.name || '店铺'}] Amazon Passkey 自动登录成功`);
        return true;
      } catch {
        // Ziniao can rotate the OTP between fill and submit. Only an observed
        // reset followed by a new boolean-ready state permits another attempt.
        requireOtpReset = true;
      }
    }
    throw new ZiniaoError('Amazon Passkey 自动登录未在重试次数内完成');
  }

  async selectAmazonAccount(storeId, market = 'US') {
    const session = this.session(storeId);
    const { driver } = session;
    const { By } = await import('selenium-webdriver');
    const parsed = approvedAmazonUrl(await driver.getCurrentUrl());
    if (
      !parsed
      || parsed.port
      || !/^sellercentral\.amazon\./i.test(parsed.hostname)
      || !/\/account-switcher\//i.test(parsed.pathname)
    ) return false;

    const labels = {
      US: ['United States', '美国'], CA: ['Canada', '加拿大'], MX: ['Mexico', '墨西哥'],
      BR: ['Brazil', '巴西'], JP: ['Japan', '日本'], AU: ['Australia', '澳大利亚'],
      SG: ['Singapore', '新加坡'], AE: ['United Arab Emirates', '阿拉伯联合酋长国'],
      SA: ['Saudi Arabia', '沙特阿拉伯'], UK: ['United Kingdom', '英国'],
    }[String(market || 'US').toUpperCase()] || [String(market || 'US')];
    const exactMarket = (text) => labels.some((label) => String(text || '').trim() === label);
    const controlLabel = async (element) => String(
      (await element.getText()) || (await element.getAttribute('value')) || (await element.getAttribute('aria-label')) || '',
    ).trim();
    const buttons = async () => driver.findElements(By.css('button,kat-button,[role="button"]'));
    let marketButton = null;
    for (const button of await buttons()) {
      try {
        if (await button.isDisplayed() && await button.isEnabled() && exactMarket(await controlLabel(button))) {
          marketButton = button;
          break;
        }
      } catch { /* stale controls are not safe click candidates */ }
    }
    if (!marketButton) {
      // Only an explicitly identified, collapsed market/account selector may
      // be expanded. Unknown buttons fail closed; never guess from position.
      const candidates = await driver.findElements(By.css(
        'button[aria-expanded],kat-button[aria-expanded],[role="button"][aria-expanded]',
      ));
      const approvedExpanders = [];
      for (const candidate of candidates) {
        try {
          if (!(await candidate.isDisplayed()) || !(await candidate.isEnabled())) continue;
          const attrs = {
            label: await controlLabel(candidate),
            ariaExpanded: await candidate.getAttribute('aria-expanded'),
            ariaControls: await candidate.getAttribute('aria-controls'),
            id: await candidate.getAttribute('id'),
            dataTest: (await candidate.getAttribute('data-testid')) || (await candidate.getAttribute('data-test')),
          };
          if (String(attrs.ariaExpanded).toLowerCase() === 'false' && isApprovedAccountSwitcherExpander(attrs)) {
            approvedExpanders.push(candidate);
          }
        } catch { /* stale controls are not safe click candidates */ }
      }
      if (approvedExpanders.length === 1) {
        await approvedExpanders[0].click();
        const expandDeadline = Date.now() + 6000;
        while (!marketButton && Date.now() < expandDeadline) {
          for (const button of await buttons()) {
            try {
              if (await button.isDisplayed() && await button.isEnabled() && exactMarket(await controlLabel(button))) {
                marketButton = button;
                break;
              }
            } catch { /* stale controls are not safe click candidates */ }
          }
          if (!marketButton) await this.sleep(200);
        }
      } else if (approvedExpanders.length > 1) {
        throw new ZiniaoError('Amazon 账户选择页存在多个市场展开控件，无法安全确定目标');
      }
    }
    if (!marketButton) throw new ZiniaoError(`Amazon 账户选择页未找到市场: ${market}`);
    // Amazon's Vue/KAT account switcher does not consistently accept a
    // WebDriver synthetic click (it can leave the row merely hovered). Use a
    // real desktop pointer event at the element's live bounding rectangle.
    await this.clickNativeElement(session, marketButton);

    let submit = null;
    const submitDeadline = Date.now() + 10000;
    while (!submit && Date.now() < submitDeadline) {
      const controls = await driver.findElements(By.css('kat-button[data-test="confirm-selection"],button,input[type="submit"],input[type="button"]'));
      for (const control of controls) {
        const text = await controlLabel(control);
        const label = text || String(await control.getAttribute('label') || '').trim();
        const disabled = await control.getAttribute('disabled');
        if (
          isApprovedAmazonLoginAction('selectAccount', label)
          && disabled === null
          && await control.isDisplayed()
          && await control.isEnabled()
        ) {
          submit = control;
          break;
        }
      }
      if (!submit) await this.sleep(200);
    }
    if (!submit) throw new ZiniaoError('Amazon 账户选择页的“选择账户”按钮未就绪');
    await this.clickNativeElement(session, submit);

    const leaveDeadline = Date.now() + 20000;
    while (Date.now() < leaveDeadline) {
      try {
        const current = approvedAmazonUrl(await driver.getCurrentUrl());
        if (!current || current.port || !/^sellercentral\.amazon\./i.test(current.hostname)) {
          throw new ZiniaoError('Amazon 账户市场选择后跳转到未批准的非 Seller Central 页面');
        }
        if (!/\/account-switcher\//i.test(current.pathname)) {
          this.logger.info?.(`[${session.name || '店铺'}] 已自动选择 Amazon 市场 ${String(market || 'US').toUpperCase()}`);
          return true;
        }
      } catch (e) {
        if (e instanceof ZiniaoError) throw e;
        // The approved Seller Central page can briefly detach while loading.
      }
      await this.sleep(250);
    }
    throw new ZiniaoError('Amazon 账户市场选择后未完成跳转');
  }

  async storeClose(storeId) {
    const s = this.session(storeId);
    let payload = null;
    let stopped = false;
    try {
      // Match the official demo's lifecycle: release Selenium first, then ask
      // Ziniao to close the profile so stopBrowser can persist/submit cookies.
      try { await s.driver.quit(); } catch { /* best-effort; stopBrowser is authoritative */ }
      payload = await this.request('stopBrowser', {
        ...(s.browserId ? { browserId: s.browserId } : { browserOauth: s.browserOauth }),
        duplicate: s.duplicate || 0,
      });
      const code = statusCodeOf(payload);
      if (code !== SUCCESS) throw new ZiniaoError(`stopBrowser 失败 (${code}): ${cleanError(payload)}`, { payload });
      stopped = true;
    } finally {
      // Keep the opaque cleanup metadata when the official stopBrowser call
      // fails.  The Selenium handle may already be closed, but retaining this
      // record lets the runner retry the authoritative native-profile cleanup
      // instead of silently orphaning a ZiNiao store process.
      if (stopped) this.sessions.delete(String(storeId));
    }
    return payload;
  }

  async closeAllSessions() {
    const errors = [];
    for (const storeId of [...this.sessions.keys()]) {
      try {
        await this.storeClose(storeId);
      } catch (error) {
        errors.push(redactText(String(error?.message || error)));
      }
    }
    return { closed: this.sessions.size === 0, remaining: this.sessions.size, errors };
  }

  async visit(storeId, targetUrl, { timeoutMs } = {}) {
    const { driver } = this.session(storeId);
    targetUrl = assertApprovedAmazonUrl(targetUrl);
    if (timeoutMs) await driver.manage().setTimeouts({ pageLoad: timeoutMs, script: Math.max(30000, timeoutMs) });
    await driver.get(targetUrl);
    return { url: await driver.getCurrentUrl() };
  }

  async currentUrl(storeId) {
    const { driver } = this.session(storeId);
    return String(await driver.getCurrentUrl() || '');
  }

  /**
   * Widen the store browser window when a check needs a desktop layout.
   *
   * Some Seller Central apps (messaging v3) use a two-pane layout and push the
   * list pane outside a narrow viewport, where it never renders. This only
   * changes browser window geometry — it navigates nothing, clicks nothing and
   * sends no input to Amazon.
   */
  async ensureWindowSize(storeId, { width = 1600, height = 1000 } = {}) {
    const { driver } = this.session(storeId);
    const target = {
      width: Math.max(800, Math.min(3840, Math.round(Number(width) || 1600))),
      height: Math.max(600, Math.min(2160, Math.round(Number(height) || 1000))),
    };
    const window = driver.manage().window();
    const before = await window.getRect();
    if (Number(before?.width) >= target.width && Number(before?.height) >= target.height) {
      return { changed: false, width: Number(before.width), height: Number(before.height) };
    }
    await window.setRect({
      x: Number.isFinite(before?.x) ? before.x : 0,
      y: Number.isFinite(before?.y) ? before.y : 0,
      width: Math.max(target.width, Number(before?.width) || 0),
      height: Math.max(target.height, Number(before?.height) || 0),
    });
    const after = await window.getRect();
    return { changed: true, width: Number(after?.width), height: Number(after?.height) };
  }

  async content(storeId, { format = 'text' } = {}) {
    const { driver } = this.session(storeId);
    if (format === 'html') return { text: await driver.getPageSource(), raw: null };
    const text = await driver.executeScript(
      `var bodyText = document.body ? (document.body.innerText || document.body.textContent || "") : "";
       var semantic = [];
       var roots = [document];
       var visited = 0;
       for (var r = 0; r < roots.length && visited < 6000 && semantic.length < 200; r += 1) {
         var nodes = roots[r].querySelectorAll ? roots[r].querySelectorAll("*") : [];
         for (var i = 0; i < nodes.length && visited < 6000 && semantic.length < 200; i += 1) {
           var el = nodes[i];
           visited += 1;
           if (el.shadowRoot) roots.push(el.shadowRoot);
           if (String(el.tagName || "").toLowerCase() !== "kat-star-rating") continue;
           var className = String(el.getAttribute("class") || "");
           if (!/(^|\\s)reviewRating(\\s|$)/i.test(className)) continue;
           var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
           var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
           var visible = (!rect || (rect.width > 0 && rect.height > 0))
             && (!style || (style.display !== "none" && style.visibility !== "hidden"));
           if (!visible) continue;
           var raw = el.getAttribute("value") || el.getAttribute("rating") || "";
           var value = Number(raw);
           if (isFinite(value) && value >= 1 && value <= 5) semantic.push(value + " out of 5 stars");
         }
       }
       return semantic.length ? bodyText + "\\n" + semantic.join("\\n") : bodyText;`,
    );
    return { text: String(text || ''), raw: null };
  }

  async waitElement(storeId, selector, { timeoutMs = 20000 } = {}) {
    const { driver } = this.session(storeId);
    const { By, until } = await import('selenium-webdriver');
    return driver.wait(until.elementLocated(By.css(selector)), timeoutMs);
  }

  /** Read an already accepted batch. No file controls or upload actions occur
   * here. The embedded status route and KAT row data were verified on the
   * corresponding store browser; row data alone is not enough evidence. */
  async readProductUploadProcessing(storeId, { batchId, expectedFileName, timeoutMs = 120000 } = {}) {
    if (typeof batchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(batchId)
      || typeof expectedFileName !== 'string' || !/^payload\.(?:xlsx|txt|tsv|csv)$/.test(expectedFileName)) {
      throw new ZiniaoError('处理结果批次绑定无效', { code: 'PROCESSING_BINDING_INVALID' });
    }
    const { driver } = this.session(storeId);
    const target = 'https://sellercentral.amazon.com/product-search/bulk/status';
    const deadline = Date.now() + Math.max(10000, Math.min(180000, Number(timeoutMs) || 120000));
    const assertLocation = async () => {
      if (await driver.getCurrentUrl() !== target) {
        throw new ZiniaoError('处理结果页地址发生变化', { code: 'PROCESSING_PAGE_CHANGED' });
      }
    };
    const initial = await driver.getCurrentUrl();
    if (!isApprovedProductBulkUploadUrl(initial) && initial !== target) {
      throw new ZiniaoError('处理结果采集未从对应店铺上传页进入', { code: 'PROCESSING_PAGE_CHANGED' });
    }
    if (!(await classifyLivePageSafety({ zn: this, storeId })).safe) {
      throw new ZiniaoError('处理结果读取前页面安全检查未通过', { code: 'PROCESSING_PAGE_UNSAFE' });
    }
    if (initial !== target) await driver.get(target);
    let evidence;
    while (Date.now() < deadline) {
      await assertLocation();
      const ready = await driver.executeScript('var t=document.querySelector("kat-data-table#submission-status-table");return !!t&&Array.isArray(t.rowData)&&t.rowData.length>0;');
      if (!ready) { await this.sleep(1000); continue; }
      if (!(await classifyLivePageSafety({ zn: this, storeId })).safe) {
        throw new ZiniaoError('处理结果表格页面安全检查未通过', { code: 'PROCESSING_PAGE_UNSAFE' });
      }
      await assertLocation();
      evidence = await driver.executeScript(function (batch, fileName) {
        function text(el) { return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
        function visible(el) {
          if (!el || !el.getClientRects().length) return false;
          var cur = el, depth = 0;
          while (cur && depth++ < 256) {
            var style = getComputedStyle(cur);
            if (cur.hidden || style.display === 'none' || style.visibility === 'hidden'
              || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
            cur = cur.parentElement || cur.getRootNode().host || null;
          }
          return !cur;
        }
        var tables = document.querySelectorAll('kat-data-table#submission-status-table');
        if (tables.length !== 1 || !visible(tables[0])) return null;
        var table = tables[0], data = table.rowData;
        if (!Array.isArray(data) || data.length > 500) return null;
        var rows = data.filter(function (row) {
          var a = row.batchId, b = row.feedIdentifier && row.feedIdentifier.batchId;
          return (a === batch || b === batch) && (!a || !b || a === b);
        });
        if (rows.length !== 1 || rows[0].originalFileName !== fileName) return null;
        var roots = [table], seen = [], cells = [], nodes = 0;
        if (table.shadowRoot) roots.push(table.shadowRoot);
        for (var r = 0; r < roots.length && r < 256 && nodes < 20000; r++) {
          var root = roots[r];
          if (seen.indexOf(root) >= 0) continue;
          seen.push(root);
          var all = root.querySelectorAll('*');
          for (var n = 0; n < all.length; n++) {
            if (++nodes >= 20000) return null;
            var el = all[n];
            if (el.shadowRoot && roots.indexOf(el.shadowRoot) < 0) roots.push(el.shadowRoot);
            if (el.hasAttribute('data-cy-id')) cells.push(el);
          }
        }
        if (roots.length > 256) return null;
        var batchCells = cells.filter(function (el) {
          return /^feed-batch-(?:id|link):row-[0-9]+$/.test(el.getAttribute('data-cy-id'))
            && visible(el) && text(el) === batch;
        });
        if (batchCells.length !== 1) return null;
        var rowKey = batchCells[0].getAttribute('data-cy-id').match(/row-[0-9]+$/)[0];
        var fileCells = cells.filter(function (el) { return el.getAttribute('data-cy-id') === 'file-name-and-date:' + rowKey && visible(el); });
        if (fileCells.length !== 1) return null;
        var names = fileCells[0].querySelectorAll('.file-name-content > b');
        if (names.length !== 1 || !visible(names[0]) || text(names[0]) !== fileName) return null;
        var countCells = cells.filter(function (el) { return el.getAttribute('data-cy-id') === 'feed-records-submitted-count:' + rowKey && visible(el); });
        if (countCells.length !== 1) return null;
        var statusCells = cells.filter(function (el) { return el.getAttribute('data-cy-id') === 'status-indicator:' + rowKey && visible(el); });
        if (statusCells.length !== 1) return null;
        var badges = Array.prototype.slice.call(statusCells[0].querySelectorAll('kat-badge'));
        if (!badges.length || badges.some(function (el) { return !visible(el); })) return null;
        function status(part) {
          var stats = part && part.processingStatistics;
          var name = part && part.processingState && part.processingState.name;
          return {
            processingState: { name: typeof name === 'string' ? name.slice(0, 80) : null },
            processingStatistics: stats ? {
              numRecordsSuccessful: stats.numRecordsSuccessful,
              numRecordsSubmitted: stats.numRecordsSubmitted,
            } : null,
          };
        }
        var row = rows[0], sanitized = status(row);
        sanitized.feedIdentifier = { batchId: batch };
        sanitized.submissionDate = row.submissionDate;
        if (!Array.isArray(row.splitStatuses) || row.splitStatuses.length > 20) return null;
        sanitized.splitStatuses = row.splitStatuses.map(status);
        return { row: sanitized, batchId: batch, fileNameMatched: true, domCounts: text(countCells[0]),
          badges: badges.map(function (el) { return { type: el.getAttribute('type'), label: el.getAttribute('label') }; }) };
      }, batchId, expectedFileName);
      if (evidence) break;
      await this.sleep(1000);
    }
    await assertLocation();
    if (!(await classifyLivePageSafety({ zn: this, storeId })).safe) {
      throw new ZiniaoError('处理结果读取后页面安全检查未通过', { code: 'PROCESSING_PAGE_UNSAFE' });
    }
    await assertLocation();
    if (!evidence || evidence.batchId !== batchId || evidence.fileNameMatched !== true) {
      throw new ZiniaoError('未取得当前批次与文件一致的处理记录', { code: 'PROCESSING_BATCH_NOT_FOUND' });
    }
    const snapshot = normalizeProductUploadStatusRow(evidence.row);
    if (snapshot.batchId !== batchId) throw new ZiniaoError('处理结果批次不一致', { code: 'PROCESSING_BINDING_INVALID' });
    // The live DONE row renders one visible success badge (label "完成").
    // Do not accept a completed result while the visible UI says otherwise.
    if (['COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(snapshot.status)
      && (evidence.badges?.length !== 1 || evidence.badges[0].type !== 'success'
        || !String(evidence.badges[0].label || '').trim())) {
      throw new ZiniaoError('处理状态与可见页面不一致', { code: 'PROCESSING_EVIDENCE_CONFLICT' });
    }
    if (snapshot.counts.success !== null && snapshot.counts.submitted !== null) {
      const visibleCounts = String(evidence.domCounts || '').replace(/[,\s]/g, '');
      if (visibleCounts !== `${snapshot.counts.success}/${snapshot.counts.submitted}`) {
        throw new ZiniaoError('处理结果统计与可见页面不一致', { code: 'PROCESSING_EVIDENCE_CONFLICT' });
      }
    }
    this.session(storeId).productUploadReadBinding = { batchId, expectedFileName, at: Date.now() };
    return snapshot;
  }

  /** Download only the current batch's verified read-only summary action.
   * The signed/account-bearing link remains inside the Ziniao browser. */
  async readProductUploadProcessingReport(storeId, { batchId, expectedFileName, timeoutMs = 120000 } = {}) {
    const session = this.session(storeId), { driver } = session, binding = session.productUploadReadBinding;
    session.productUploadReadBinding = null;
    if (!binding || binding.batchId !== batchId || binding.expectedFileName !== expectedFileName
      || Date.now() - binding.at > 30000) throw new ZiniaoError('处理报告缺少本次页面核对', { code: 'PROCESSING_REPORT_BINDING_INVALID' });
    const target = 'https://sellercentral.amazon.com/product-search/bulk/status';
    const safe = async () => {
      if (await driver.getCurrentUrl() !== target || !(await classifyLivePageSafety({ zn: this, storeId })).safe
        || await driver.getCurrentUrl() !== target) {
        throw new ZiniaoError('处理报告页面安全检查未通过', { code: 'PROCESSING_REPORT_PAGE_UNSAFE' });
      }
    };
    await safe();
    const timeout = Math.max(10000, Math.min(180000, Number(timeoutMs) || 120000));
    const previousTimeouts = await driver.manage().getTimeouts();
    let response;
    try {
      await driver.manage().setTimeouts({ script: timeout + 5000 });
      response = await driver.executeAsyncScript(function (batch, fileName, timeout, done) {
        (async function () {
          function visible(el) {
            if (!el || !el.getClientRects().length) return false;
            var cur = el, depth = 0;
            while (cur && depth++ < 256) {
              var s = getComputedStyle(cur);
              if (cur.hidden || s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
              cur = cur.parentElement || cur.getRootNode().host || null;
            }
            return !cur;
          }
          function text(el) { return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
          var tables = document.querySelectorAll('kat-data-table#submission-status-table');
          if (tables.length !== 1 || !visible(tables[0])) return { code: 'BINDING_INVALID' };
          var table = tables[0], rows = Array.isArray(table.rowData) ? table.rowData.filter(function (row) {
            var a = row.batchId, b = row.feedIdentifier && row.feedIdentifier.batchId;
            return (a === batch || b === batch) && (!a || !b || a === b);
          }) : [];
          if (rows.length !== 1 || rows[0].originalFileName !== fileName) return { code: 'BINDING_INVALID' };
          var row = rows[0], splits = row.splitStatuses;
          if (!Array.isArray(splits) || splits.length !== 1 || !Array.isArray(splits[0].actions)
            || splits[0].actions.length !== 1) return { code: 'NOT_AVAILABLE' };
          var action = splits[0].actions[0], config = action.actionConfig || {};
          if (action.translationStringId !== 'status:download_processing_summary'
            || config.requestType !== undefined || config.delay) return { code: 'NOT_AVAILABLE' };
          var link = new URL(action.link, location.origin);
          if (link.origin !== 'https://sellercentral.amazon.com' || link.pathname !== '/listing/api/status/feeds/download'
            || link.username || link.password || link.hash || link.searchParams.getAll('batchId').length !== 1
            || link.searchParams.get('batchId') !== batch || link.searchParams.getAll('merchantId').length !== 1
            || !link.searchParams.get('merchantId') || link.searchParams.getAll('frpRegion').length > 1
            || Array.from(link.searchParams.keys()).some(function (key) { return ['batchId', 'merchantId', 'frpRegion'].indexOf(key) < 0; })) return { code: 'BINDING_INVALID' };
          var directMerchant = row.merchantId, nestedMerchant = row.feedIdentifier && row.feedIdentifier.merchantId;
          var merchant = directMerchant || nestedMerchant;
          if (typeof merchant !== 'string' || !merchant || directMerchant && nestedMerchant && directMerchant !== nestedMerchant
            || link.searchParams.get('merchantId') !== merchant) return { code: 'BINDING_INVALID' };
          var roots = [table], cells = [], nodes = 0;
          if (table.shadowRoot) roots.push(table.shadowRoot);
          for (var r = 0; r < roots.length && r < 256; r++) {
            var all = roots[r].querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
              if (++nodes >= 20000) return { code: 'BINDING_INVALID' };
              var el = all[i];
              if (el.shadowRoot && roots.indexOf(el.shadowRoot) < 0) roots.push(el.shadowRoot);
              if (el.hasAttribute('data-cy-id')) cells.push(el);
            }
          }
          if (roots.length > 256) return { code: 'BINDING_INVALID' };
          var batchCells = cells.filter(function (el) { return /^feed-batch-(?:id|link):row-[0-9]+$/.test(el.getAttribute('data-cy-id')) && visible(el) && text(el) === batch; });
          if (batchCells.length !== 1) return { code: 'BINDING_INVALID' };
          var key = batchCells[0].getAttribute('data-cy-id').match(/row-[0-9]+$/)[0];
          var files = cells.filter(function (el) { return el.getAttribute('data-cy-id') === 'file-name-and-date:' + key && visible(el); });
          var names = files.length === 1 ? files[0].querySelectorAll('.file-name-content > b') : [];
          if (names.length !== 1 || !visible(names[0]) || text(names[0]) !== fileName) return { code: 'BINDING_INVALID' };
          var actions = cells.filter(function (el) { return el.getAttribute('data-cy-id') === 'actions-container:' + key && visible(el); });
          var buttons = actions.length === 1 ? actions[0].querySelectorAll('kat-button.actions-button') : [];
          if (buttons.length !== 1 || !visible(buttons[0]) || buttons[0].disabled === true
            || buttons[0].hasAttribute('disabled') || buttons[0].getAttribute('aria-disabled') === 'true') return { code: 'NOT_AVAILABLE' };
          var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, timeout);
          try {
            var response = await fetch(link.href, { method: 'GET', credentials: 'same-origin', redirect: 'error', signal: controller.signal });
            var type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            var disposition = response.headers.get('content-disposition') || '';
            var filenameExtension = /\.(xlsx|xlsm|csv|tsv|txt)(?:["';\s]|$)/i.exec(disposition);
            var extension = type === 'application/vnd.ms-excel.sheet.macroenabled.12' ? '.xlsm'
              : type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? '.xlsx'
              : filenameExtension ? '.' + filenameExtension[1].toLowerCase() : null;
            var lengthHeader = response.headers.get('content-length'), declared = lengthHeader === null ? null : Number(lengthHeader), limit = 20 * 1024 * 1024;
            var types = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel.sheet.macroenabled.12',
              'application/octet-stream', 'text/csv', 'text/tab-separated-values', 'text/plain'];
            if (response.status !== 200 || response.redirected || new URL(response.url).origin !== location.origin
              || !/^attachment(?:;|$)/i.test(disposition) || !extension || types.indexOf(type) < 0
              || lengthHeader !== null && (!/^[0-9]+$/.test(lengthHeader) || !Number.isSafeInteger(declared) || declared < 0 || declared > limit)) {
              if (response.body) await response.body.cancel();
              return { code: 'RESPONSE_INVALID' };
            }
            var reader = response.body.getReader(), chunks = [], size = 0;
            while (true) {
              var next = await reader.read(); if (next.done) break;
              size += next.value.length;
              if (size > limit) { await reader.cancel(); return { code: 'TOO_LARGE' }; }
              chunks.push(next.value);
            }
            if (!size || declared !== null && size !== declared) return { code: 'RESPONSE_INVALID' };
            var bytes = new Uint8Array(size), offset = 0, binary = '';
            chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.length; });
            for (var n = 0; n < size; n += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(n, n + 32768));
            return { code: 'FILE', base64: btoa(binary), extension: extension, size: size };
          } finally { clearTimeout(timer); }
        })().then(done).catch(function () { done({ code: 'READ_FAILED' }); });
      }, batchId, expectedFileName, timeout);
    } finally { await driver.manage().setTimeouts({ script: previousTimeouts.script }); }
    await safe();
    if (response?.code === 'NOT_AVAILABLE') return null;
    if (response?.code !== 'FILE' || typeof response.base64 !== 'string' || response.base64.length > 28 * 1024 * 1024) {
      throw new ZiniaoError('处理报告未能安全读取', { code: 'PROCESSING_REPORT_READ_FAILED' });
    }
    const buffer = Buffer.from(response.base64, 'base64');
    if (buffer.length !== response.size || buffer.length > 20 * 1024 * 1024) throw new ZiniaoError('处理报告大小无效', { code: 'PROCESSING_REPORT_READ_FAILED' });
    return { buffer, extension: response.extension };
  }

  /**
   * Dedicated, narrowly-scoped write path for a user-confirmed Seller Central
   * bulk product upload. Ordinary collectors never call these methods.
   */
  async inspectProductBulkUploadPage(storeId, { timeoutMs = 60000 } = {}) {
    const { driver } = this.session(storeId);
    if (!isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) {
      throw new ZiniaoError('\u5546\u54c1\u4e0a\u4f20\u63a2\u9488\u672a\u8fdb\u5165\u5df2\u6279\u51c6\u7684 Seller Central \u6279\u91cf\u4e0a\u4f20\u9875');
    }
    const live = await classifyLivePageSafety({ zn: this, storeId });
    if (!live.safe) throw new ZiniaoError('\u5546\u54c1\u4e0a\u4f20\u9875\u51fa\u73b0\u8ba4\u8bc1\u3001\u62e6\u622a\u6216\u4e0d\u53ef\u9a8c\u8bc1\u5185\u5bb9');
    const { By } = await import('selenium-webdriver');
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 60000));
    let inputCount = 0;
    let eligibleCount = 0;
    do {
      if (!isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) {
        throw new ZiniaoError('\u5546\u54c1\u4e0a\u4f20\u63a2\u9488\u7b49\u5f85\u671f\u95f4\u79bb\u5f00\u4e86\u5df2\u6279\u51c6\u9875\u9762');
      }
      const inputs = await findProductUploadFileInputs(driver, By);
      const eligible = [];
      for (const input of inputs) {
        try {
          if (!await input.isEnabled()) continue;
          const meta = [
            await input.getAttribute('id'), await input.getAttribute('name'),
            await input.getAttribute('aria-label'), await input.getAttribute('data-testid'),
          ].filter(Boolean).join(' ');
          if (inputs.length === 1 || /(?:upload|file|browse|\u4e0a\u4f20|\u6587\u4ef6)/i.test(meta)) eligible.push(input);
        } catch { /* detached or unreadable input is not eligible */ }
      }
      inputCount = inputs.length;
      eligibleCount = eligible.length;
      if (eligibleCount > 1) {
        throw new ZiniaoError(`\u6279\u91cf\u4e0a\u4f20\u6587\u4ef6\u63a7\u4ef6\u6570\u91cf\u4e0d\u53ef\u552f\u4e00\u786e\u5b9a\uff08${eligibleCount}\uff09`);
      }
      if (eligibleCount === 1) break;
      await this.sleep(500);
    } while (Date.now() < deadline);
    if (eligibleCount !== 1) {
      throw new ZiniaoError(`\u6279\u91cf\u4e0a\u4f20\u6587\u4ef6\u63a7\u4ef6\u672a\u5728\u7b49\u5f85\u671f\u5185\u5c31\u7eea\uff08${eligibleCount}\uff09`);
    }
    return {
      ready: true,
      exactUrl: true,
      livePageSafe: true,
      fileInputCount: inputCount,
      eligibleFileInputCount: eligibleCount,
    };
  }

  /**
   * Read the current upload failure scene without selecting or submitting a
   * file. screenshotBase64 is private transport output: callers must keep it
   * out of task results, logs and public APIs. No page text or file name is
   * returned. A failed safety check discards both the summary and screenshot.
   */
  async captureProductBulkUploadDiagnostic(storeId, { expectedSize } = {}) {
    const validityFields = ['valid', 'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong',
      'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'];
    const safetyReasons = new Set(['CURRENT_URL_UNAVAILABLE', 'UNAPPROVED_AMAZON_HOST', 'ACCESS_BLOCKED',
      'AUTH_SENSITIVE', 'URL_ALLOWED', 'LIVE_SAFETY_PROBE_UNAVAILABLE',
      'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE', 'LIVE_SAFETY_PROBE_INCOMPLETE', 'LIVE_PAGE_NON_SENSITIVE']);
    const probeCounts = ['discoveredRootCount', 'scannedRootCount', 'discoveredElementCount',
      'scannedElementCount', 'candidateNodeCount', 'visibleFrameCount', 'unreadableVisibleFrameCount',
      'traversalErrorCount', 'nonFrameTraversalErrorCount', 'unreadableFrameErrorCount',
      'opaqueOverlayFrameCount', 'opaqueAuthHintCount', 'opaqueBlockedHintCount',
      'rootBudget', 'elementBudget', 'nodeBudget', 'unreadableFrameBudget'];
    const probeFlags = ['accessibleTraversalComplete', 'mainDocumentTraversalComplete',
      'rootBudgetExceeded', 'elementBudgetExceeded', 'nodeBudgetExceeded', 'unreadableFrameBudgetExceeded'];
    const unavailableSafety = stage => ({ stage, reason: 'CURRENT_URL_UNAVAILABLE', exactUrl: null,
      authSensitive: false, blocked: false, liveProbeDiagnostics: null });
    let safety = unavailableSafety('START');
    const retainSafety = (live, stage, exactUrl) => {
      const diagnostics = {};
      for (const field of probeCounts) {
        const value = live?.liveProbeDiagnostics?.[field];
        if (Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000) diagnostics[field] = value;
      }
      for (const field of probeFlags) {
        const value = live?.liveProbeDiagnostics?.[field];
        if (typeof value === 'boolean') diagnostics[field] = value;
      }
      return { stage, reason: safetyReasons.has(live?.code) ? live.code : null, exactUrl,
        authSensitive: live?.authSensitive === true, blocked: live?.blocked === true,
        liveProbeDiagnostics: Object.keys(diagnostics).length ? diagnostics : null };
    };
    const emptySummary = (status = 'UNAVAILABLE') => ({ version: 1, status, inputCount: null,
      selectedFileCount: null, singleSelectedFileSizeMatches: null, inputs: [] });
    const blocked = (status = 'UNSAFE_PAGE') => ({ safety, summary: emptySummary(status),
      screenshotStatus: 'BLOCKED', screenshotBase64: null });
    let summary = emptySummary();
    let driver;
    try { ({ driver } = this.session(storeId)); }
    catch { return { safety, summary, screenshotStatus: 'NOT_CAPTURED', screenshotBase64: null }; }
    const safePage = async stage => {
      safety = unavailableSafety(stage);
      const currentUrl = await driver.getCurrentUrl();
      const exactUrl = isApprovedProductBulkUploadUrl(currentUrl);
      if (!exactUrl) {
        safety = retainSafety(classifyUrlSafety(currentUrl), stage, false);
        return false;
      }
      safety = { ...safety, exactUrl: true, reason: 'LIVE_SAFETY_PROBE_UNAVAILABLE' };
      const live = await classifyLivePageSafety({ zn: this, storeId });
      safety = retainSafety(live, stage, true);
      return live?.safe === true;
    };
    try { if (!await safePage('START')) return blocked(); }
    catch { return blocked('UNAVAILABLE'); }

    try {
      const { By } = await import('selenium-webdriver');
      const inputs = await findProductUploadFileInputs(driver, By);
      if (inputs.length > 32) {
        summary = { ...emptySummary('LIMIT_EXCEEDED'), inputCount: inputs.length };
      } else {
        const raw = await driver.executeScript(
          'var inputs=arguments[0],expected=arguments[1],fields=arguments[2],rows=[],total=0,onlySize=null;'
          + 'for(var i=0;i<inputs.length;i++){try{var el=inputs[i];'
          + 'if(!el||!el.isConnected||String(el.tagName).toLowerCase()!=="input"||el.type!=="file")return {complete:false};'
          + 'var files=el.files,n=files&&files.length;'
          + 'if(typeof n!=="number"||!isFinite(n)||n<0||Math.floor(n)!==n)return {complete:false};'
          + 'if(n>1000)return {complete:false,limited:true};total+=n;'
          + 'if(n===1){var size=files[0].size;onlySize=typeof size==="number"&&isFinite(size)&&size>=0&&Math.floor(size)===size?size:null;}'
          + 'var validity={},nativeValidity=el.validity;'
          + 'for(var j=0;j<fields.length;j++){var v=nativeValidity&&nativeValidity[fields[j]];validity[fields[j]]=typeof v==="boolean"?v:null;}'
          + 'var aria=el.getAttribute("aria-invalid");aria=typeof aria==="string"?aria.trim().toLowerCase():null;'
          + 'rows.push({validity:validity,ariaInvalid:aria==="true"?true:aria==="false"?false:null});'
          + '}catch(ignore){return {complete:false};}}'
          + 'return {complete:true,selectedFileCount:total,singleSelectedFileSizeMatches:total===1&&onlySize!==null&&expected!==null?onlySize===expected:null,inputs:rows};',
          inputs, Number.isSafeInteger(expectedSize) && expectedSize > 0 ? expectedSize : null, validityFields,
        );
        const nullableBoolean = value => value === null || typeof value === 'boolean';
        const valid = raw?.complete === true && Number.isSafeInteger(raw.selectedFileCount)
          && raw.selectedFileCount >= 0 && raw.selectedFileCount <= inputs.length * 1000
          && nullableBoolean(raw.singleSelectedFileSizeMatches)
          && Array.isArray(raw.inputs) && raw.inputs.length === inputs.length
          && raw.inputs.every(row => row && nullableBoolean(row.ariaInvalid)
            && row.validity && validityFields.every(field => nullableBoolean(row.validity[field])));
        if (valid) {
          summary = { version: 1, status: 'AVAILABLE', inputCount: inputs.length,
            selectedFileCount: raw.selectedFileCount,
            singleSelectedFileSizeMatches: raw.selectedFileCount === 1 ? raw.singleSelectedFileSizeMatches : null,
            inputs: raw.inputs.map(row => ({ validity: Object.fromEntries(validityFields.map(field => [field, row.validity[field]])),
              ariaInvalid: row.ariaInvalid })) };
        } else {
          summary = { ...emptySummary(raw?.limited === true ? 'LIMIT_EXCEEDED' : 'UNAVAILABLE'), inputCount: inputs.length };
        }
      }
    } catch { /* Never retain a page exception or an unvalidated result. */ }

    // Recheck immediately before and after the one screenshot. The transport
    // never writes the image, so unsafe or late results can simply be discarded.
    try { if (!await safePage('BEFORE_SCREENSHOT')) return blocked(); }
    catch { return blocked('UNAVAILABLE'); }
    let screenshotBase64 = null;
    let screenshotStatus = 'FAILED';
    try {
      const image = await driver.takeScreenshot();
      const maxBytes = 8 * 1024 * 1024;
      if (typeof image !== 'string') screenshotStatus = 'INVALID';
      else if (image.length > Math.ceil(maxBytes / 3) * 4) screenshotStatus = 'TOO_LARGE';
      else if (!image.length || image.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image)) screenshotStatus = 'INVALID';
      else {
        const decoded = Buffer.from(image, 'base64');
        if (decoded.length > maxBytes) screenshotStatus = 'TOO_LARGE';
        else if (decoded.toString('base64') !== image
          || !decoded.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) screenshotStatus = 'INVALID';
        else { screenshotStatus = 'AVAILABLE'; screenshotBase64 = image; }
      }
    } catch { /* The safe summary remains useful when the screenshot fails. */ }
    try { if (!await safePage('AFTER_SCREENSHOT')) return blocked(); }
    catch { return blocked('UNAVAILABLE'); }
    return { safety, summary, screenshotStatus, screenshotBase64 };
  }

  async prepareProductBulkUpload(storeId, payloadFile, { authorization, timeoutMs = 30000 } = {}) {
    const { driver } = this.session(storeId);
    const absoluteFile = path.resolve(String(payloadFile || ''));
    const stat = fs.lstatSync(absoluteFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ZiniaoError('\u6279\u91cf\u4e0a\u4f20\u6587\u4ef6\u4e0d\u662f\u53d7\u63a7\u666e\u901a\u6587\u4ef6');
    const actualDigest = createHash('sha256').update(fs.readFileSync(absoluteFile)).digest('hex');
    if (
      authorization?.approved !== true
      || authorization?.action !== 'product-bulk-upload'
      || !/^upl_[a-f0-9]{32}$/.test(String(authorization.jobId || ''))
      || !/^[a-f0-9]{64}$/.test(String(authorization.sha256 || ''))
      || actualDigest !== authorization.sha256
    ) throw new ZiniaoError('\u6279\u91cf\u4e0a\u4f20\u6587\u4ef6\u4e0e\u6301\u4e45\u6388\u6743\u6458\u8981\u4e0d\u5339\u914d');
    if (!isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) {
      throw new ZiniaoError('\u5546\u54c1\u4e0a\u4f20\u51c6\u5907\u524d\u9875\u9762\u4e0d\u662f\u5df2\u6279\u51c6\u7684 Seller Central \u6279\u91cf\u4e0a\u4f20\u9875');
    }
    const live = await classifyLivePageSafety({ zn: this, storeId });
    if (!live.safe) throw new ZiniaoError('\u5546\u54c1\u4e0a\u4f20\u9875\u51fa\u73b0\u8ba4\u8bc1\u3001\u62e6\u622a\u6216\u4e0d\u53ef\u9a8c\u8bc1\u5185\u5bb9');
    const { By, Key } = await import('selenium-webdriver');
    const inputs = await findProductUploadFileInputs(driver, By);
    const eligible = [];
    for (const input of inputs) {
      try {
        if (!await input.isEnabled()) continue;
        const meta = [
          await input.getAttribute('id'), await input.getAttribute('name'),
          await input.getAttribute('aria-label'), await input.getAttribute('data-testid'),
        ].filter(Boolean).join(' ');
        if (inputs.length === 1 || /(?:upload|file|browse|\u4e0a\u4f20|\u6587\u4ef6)/i.test(meta)) eligible.push(input);
      } catch { /* detached or unreadable input is not eligible */ }
    }
    if (eligible.length !== 1) throw new ZiniaoError(`\u6279\u91cf\u4e0a\u4f20\u6587\u4ef6\u63a7\u4ef6\u6570\u91cf\u4e0d\u53ef\u552f\u4e00\u786e\u5b9a\uff08${eligible.length}\uff09`);
    await eligible[0].sendKeys(absoluteFile);

    const deadline = Date.now() + Math.max(5000, Number(timeoutMs || 30000));
    let submit = null;
    let submitLabel = '';
    let previewOpened = false;
    const previewTourState = { escapeSent: false };
    let lastReadiness = null;
    while (!submit && Date.now() < deadline) {
      if (!isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) {
        throw new ZiniaoError('\u9009\u62e9\u6587\u4ef6\u540e\u9875\u9762\u79bb\u5f00\u5df2\u6279\u51c6\u7684\u6279\u91cf\u4e0a\u4f20\u5730\u5740');
      }
      if (previewOpened) await dismissProductUploadPreviewTour(this, storeId, driver, By, Key, previewTourState);
      const previewAction = previewOpened ? 'submit' : 'open';
      const previewControl = await productUploadPreviewControl(driver, By, previewAction);
      if (previewControl) {
        const previewSafety = await classifyLivePageSafety({ zn: this, storeId });
        if (!previewSafety.safe || !isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) {
          throw new ZiniaoError('上传预览前完整页面安全检查未通过', { code: 'UPLOAD_PREVIEW_SAFETY_FAILED' });
        }
        const current = await productUploadPreviewControl(driver, By, previewAction);
        if (!current || current.label !== previewControl.label) throw new ZiniaoError('上传预览控件在操作前发生变化');
        if (!previewOpened) {
          // This only opens the original-file preview. A lost click response
          // propagates to UNKNOWN; the opener is never clicked a second time.
          previewOpened = true;
          if (!isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) throw new ZiniaoError('上传预览点击前页面地址发生变化');
          await current.control.click();
          await this.sleep(250);
          continue;
        }
        submit = current.control;
        submitLabel = current.label;
        break;
      }
      if (previewOpened) {
        await this.sleep(250);
        continue;
      }
      const controls = await driver.findElements(By.css('button,kat-button,[role="button"],input[type="submit"],input[type="button"]'));
      // Only the last poll is retained. Never include page labels, attribute
      // values or exception messages in the diagnostic.
      lastReadiness = { total: controls.length, approvedLabels: 0, notDisplayed: 0,
        nativeDisabled: 0, disabledAttribute: 0, ariaDisabled: 0, readErrors: 0 };
      const matches = [];
      for (const control of controls) {
        try {
          const label = await productUploadSubmitControlLabel(control, lastReadiness);
          if (label) matches.push({ control, label });
        } catch { lastReadiness.readErrors++; }
      }
      if (matches.length > 1) throw new ZiniaoError('\u6279\u91cf\u4e0a\u4f20\u63d0\u4ea4\u63a7\u4ef6\u4e0d\u552f\u4e00\uff0c\u5df2\u62d2\u7edd\u70b9\u51fb');
      if (matches.length === 1) {
        submit = matches[0].control;
        submitLabel = matches[0].label;
        break;
      }
      await this.sleep(250);
    }
    if (!submit) {
      if (previewOpened) throw new ZiniaoError('Amazon 文件预览的提交控件未在等待期内就绪', { code: 'UPLOAD_PREVIEW_SUBMIT_NOT_READY' });
      const detail = lastReadiness
        ? `最后一轮：控件总数=${lastReadiness.total}，白名单标签=${lastReadiness.approvedLabels}，不可见=${lastReadiness.notDisplayed}，原生禁用=${lastReadiness.nativeDisabled}，disabled禁用=${lastReadiness.disabledAttribute}，aria禁用=${lastReadiness.ariaDisabled}，读取异常=${lastReadiness.readErrors}`
        : '未取得控件轮询结果';
      throw new ZiniaoError(`批量上传提交控件未在等待期内就绪（${detail}）`, { code: 'UPLOAD_SUBMIT_CONTROL_NOT_READY' });
    }
    const session = this.session(storeId);
    session.productUploadPrepared = {
      submit, submitLabel, preparedUrl: await driver.getCurrentUrl(),
      jobId: authorization.jobId, sha256: authorization.sha256,
      flow: previewOpened ? 'AMAZON_TEMPLATE_PREVIEW' : 'DIRECT',
      previewTourState,
      fileName: path.basename(absoluteFile),
    };
    return { prepared: true, submitLabel, currentUrl: session.productUploadPrepared.preparedUrl };
  }

  async submitProductBulkUpload(storeId, { authorization, timeoutMs = 120000 } = {}) {
    const session = this.session(storeId);
    const { driver } = session;
    if (
      authorization?.approved !== true
      || authorization?.action !== 'product-bulk-upload'
      || !/^upl_[a-f0-9]{32}$/.test(String(authorization.jobId || ''))
      || !/^[a-f0-9]{64}$/.test(String(authorization.sha256 || ''))
    ) throw new ZiniaoError('\u7f3a\u5c11\u4e0e\u5df2\u9884\u68c0\u6587\u4ef6\u7ed1\u5b9a\u7684\u4e0a\u4f20\u5199\u6388\u6743');
    const prepared = session.productUploadPrepared;
    if (
      !prepared?.submit
      || prepared.jobId !== authorization.jobId
      || prepared.sha256 !== authorization.sha256
    ) {
      throw new ZiniaoError('\u6279\u91cf\u4e0a\u4f20\u672a\u5b8c\u6210\u53ef\u9a8c\u8bc1\u7684\u63d0\u4ea4\u524d\u51c6\u5907');
    }
    // Consume synchronously before any await: a lost click response or a
    // concurrent caller must never reuse the same prepared write action.
    session.productUploadPrepared = null;
    const currentUrl = await driver.getCurrentUrl();
    if (!isApprovedProductBulkUploadUrl(currentUrl) || String(currentUrl) !== String(prepared.preparedUrl)) {
      throw new ZiniaoError('\u6279\u91cf\u4e0a\u4f20\u9875\u5728\u63d0\u4ea4\u524d\u53d1\u751f\u53d8\u5316\uff0c\u5df2\u62d2\u7edd\u70b9\u51fb');
    }
    const live = await classifyLivePageSafety({ zn: this, storeId });
    if (!live.safe) throw new ZiniaoError('\u6279\u91cf\u4e0a\u4f20\u70b9\u51fb\u524d\u5b89\u5168\u63a2\u9488\u672a\u901a\u8fc7');
    const { By, Key } = await import('selenium-webdriver');
    const previewFlow = prepared.flow === 'AMAZON_TEMPLATE_PREVIEW';
    if (previewFlow) await dismissProductUploadPreviewTour(this, storeId, driver, By, Key, prepared.previewTourState || { escapeSent: false });
    const beforeText = String((await this.content(storeId, { format: 'text' }))?.text || '').slice(0, 100000);
    const beforeLines = new Set(beforeText.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean));
    const deltaFromBefore = (text) => String(text || '').split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line && !beforeLines.has(line)).join('\n').slice(0, 50000);
    if (previewFlow) {
      const existingModals = await driver.findElements(By.css(`${PRODUCT_UPLOAD_PREVIEW_MODAL} .online-spreadsheet-root kat-modal#submit-products-confirmation-modal[visible]:not([visible="false"])`));
      for (const modal of existingModals) {
        if (await modal.isDisplayed()) throw new ZiniaoError('提交前已存在上传确认弹窗，无法关联本次点击');
      }
    }
    const previewSubmit = previewFlow ? await productUploadPreviewControl(driver, By, 'submit') : null;
    const submitLabel = previewFlow ? previewSubmit?.label : await productUploadSubmitControlLabel(prepared.submit);
    if (!submitLabel || submitLabel !== prepared.submitLabel) {
      throw new ZiniaoError('批量上传提交控件在点击前不可用或已变化，已拒绝点击');
    }
    const finalSafety = await classifyLivePageSafety({ zn: this, storeId });
    if (!finalSafety.safe || !isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) {
      throw new ZiniaoError('批量上传实际点击前完整页面安全检查未通过');
    }
    const finalSubmit = previewFlow ? await productUploadPreviewControl(driver, By, 'submit') : null;
    const finalLabel = previewFlow ? finalSubmit?.label : await productUploadSubmitControlLabel(prepared.submit);
    if (!finalLabel || finalLabel !== prepared.submitLabel || !isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) {
      throw new ZiniaoError('批量上传提交控件在安全检查后发生变化，已拒绝点击');
    }
    if (previewFlow && (await visibleProductUploadElements(driver, By, PRODUCT_UPLOAD_TOUR_OVERLAY)).length) {
      throw new ZiniaoError('上传提交前再次出现导览遮罩，已停止提交', { code: 'UPLOAD_PREVIEW_TOUR_BLOCKED' });
    }
    if (!isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) throw new ZiniaoError('上传实际点击前页面地址发生变化');
    await (previewFlow ? finalSubmit.control : prepared.submit).click();
    const deadline = Date.now() + Math.max(30000, Number(timeoutMs || 120000));
    let lastText = '';
    let pageTextDelta = '';
    let previewConfirmed = false;
    while (Date.now() < deadline) {
      const current = approvedAmazonUrl(await driver.getCurrentUrl());
      if (!current || current.hostname.toLowerCase() !== 'sellercentral.amazon.com') {
        throw new ZiniaoError('\u6279\u91cf\u4e0a\u4f20\u540e\u8df3\u8f6c\u5230\u672a\u6279\u51c6\u9875\u9762');
      }
      const postSafety = await classifyLivePageSafety({ zn: this, storeId });
      if (!postSafety.safe) throw new ZiniaoError('\u6279\u91cf\u4e0a\u4f20\u540e\u9875\u9762\u51fa\u73b0\u8ba4\u8bc1\u3001\u62e6\u622a\u6216\u4e0d\u53ef\u9a8c\u8bc1\u5185\u5bb9');
      const reference = productUploadReceiptReference(current.toString());
      if (reference && prepared.fileName) {
        const receipt = await readProductUploadReceipt(driver, reference, prepared.fileName);
        const receiptSafety = await classifyLivePageSafety({ zn: this, storeId });
        if (!receiptSafety.safe || String(await driver.getCurrentUrl()) !== current.toString()) {
          throw new ZiniaoError('Amazon 上传回执读取期间页面发生变化');
        }
        if (receipt) return { receipt, pageTextDelta: '',
          currentUrl: `https://sellercentral.amazon.com/listing/status?reference_id=${encodeURIComponent(reference)}` };
        // A history title, old row or redirect alone never proves receipt.
        await this.sleep(1000);
        continue;
      }
      if (current.pathname === '/listing/status') {
        pageTextDelta = '';
        await this.sleep(1000);
        continue;
      }
      if (previewFlow && !previewConfirmed && isApprovedProductBulkUploadUrl(current.toString())) {
        const confirm = await productUploadPreviewControl(driver, By, 'confirm');
        if (confirm) {
          // Amazon can ask whether to submit the unchanged file despite its
          // validation errors. This is part of the already-confirmed upload,
          // not permission to edit cells or submit a selected subset of rows.
          if (!isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) throw new ZiniaoError('上传确认前页面地址发生变化');
          const currentConfirm = await productUploadPreviewControl(driver, By, 'confirm');
          if (!currentConfirm || currentConfirm.label !== confirm.label) throw new ZiniaoError('上传确认控件在点击前发生变化');
          const confirmSafety = await classifyLivePageSafety({ zn: this, storeId });
          if (!confirmSafety.safe || !isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) {
            throw new ZiniaoError('上传确认点击前完整页面安全检查未通过');
          }
          const finalConfirm = await productUploadPreviewControl(driver, By, 'confirm');
          if (!finalConfirm || finalConfirm.label !== confirm.label || !isApprovedProductBulkUploadUrl(await driver.getCurrentUrl())) {
            throw new ZiniaoError('上传确认控件在安全检查后发生变化，已拒绝点击');
          }
          previewConfirmed = true;
          await finalConfirm.control.click();
          await this.sleep(250);
          continue;
        }
      }
      lastText = String((await this.content(storeId, { format: 'text' }))?.text || '').slice(0, 100000);
      pageTextDelta = deltaFromBefore(lastText);
      if (/(?:your file (?:has been |was )?uploaded|your file is being processed|upload (?:is )?(?:complete|successful)|file (?:was )?received for processing|upload failed|file (?:was )?rejected|invalid file|\u6587\u4ef6(?:\u5df2)?\u4e0a\u4f20(?:\u6210\u529f|\u5b8c\u6210)|\u6587\u4ef6\u5df2\u63a5\u6536|\u4e0a\u4f20\u5931\u8d25|\u6587\u4ef6\u88ab\u62d2\u7edd|\u6587\u4ef6\u65e0\u6548)/i.test(pageTextDelta)) break;
      await this.sleep(1000);
    }
    return { currentUrl: await driver.getCurrentUrl(), pageTextDelta };
  }

  async screenshot(storeId, filePath, { fullPage = true } = {}) {
    const { driver } = this.session(storeId);
    const controlledTarget = path.resolve(filePath);
    const controlledParent = path.dirname(controlledTarget);
    fs.mkdirSync(controlledParent, { recursive: true, mode: 0o700 });
    const parentStat = fs.lstatSync(controlledParent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new ZiniaoError('截图输出目录不是受控普通目录', { code: SECURITY_CLEANUP_FAILED });
    }
    let base64 = null;
    if (fullPage && typeof driver.sendAndGetDevToolsCommand === 'function') {
      try {
        const metrics = await driver.sendAndGetDevToolsCommand('Page.getLayoutMetrics');
        const size = metrics?.cssContentSize || metrics?.contentSize;
        const shot = await driver.sendAndGetDevToolsCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          fromSurface: true,
          ...(size ? { clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {}),
        });
        base64 = shot?.data || null;
      } catch { /* fall back to viewport screenshot */ }
    }
    if (!base64) base64 = await driver.takeScreenshot();
    const constants = fs.constants;
    if (typeof constants.O_NOFOLLOW !== 'number') {
      throw new ZiniaoError('当前平台不支持安全截图落盘', {
        code: SECURITY_CLEANUP_FAILED,
        causeCode: 'O_NOFOLLOW_UNAVAILABLE',
      });
    }
    const noFollow = constants.O_NOFOLLOW;
    let fd = null;
    let created = false;
    let createdIdentity = null;
    try {
      fd = fs.openSync(
        controlledTarget,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      created = true;
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('screenshot target is not a regular file');
      createdIdentity = { dev: stat.dev, ino: stat.ino };
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, Buffer.from(base64, 'base64'));
      fs.fsyncSync(fd);
      const targetStat = fs.lstatSync(controlledTarget);
      if (
        !targetStat.isFile() || targetStat.isSymbolicLink()
        || targetStat.dev !== createdIdentity.dev || targetStat.ino !== createdIdentity.ino
      ) throw new Error('screenshot target changed while writing');
      fs.closeSync(fd);
      fd = null;
      return { path: controlledTarget, raw: null };
    } catch (error) {
      if (fd !== null) {
        try { fs.fchmodSync(fd, 0o000); } catch { /* keep failing closed */ }
        try { fs.closeSync(fd); } catch { /* keep failing closed */ }
        fd = null;
      }
      if (created) {
        try {
          const stat = fs.lstatSync(controlledTarget);
          if (
            stat.isFile() && !stat.isSymbolicLink() && createdIdentity
            && stat.dev === createdIdentity.dev && stat.ino === createdIdentity.ino
          ) fs.unlinkSync(controlledTarget);
        } catch { /* caller will surface the failed controlled write */ }
      }
      throw new ZiniaoError('截图无法安全写入受控目标', {
        code: SECURITY_CLEANUP_FAILED,
        causeCode: error?.code || null,
      });
    }
  }

  async execScript(storeId, script) {
    const { driver } = this.session(storeId);
    return driver.executeScript(script);
  }

  async execExtract(storeId, body, { varName = '__ZN_R__' } = {}) {
    // Selenium executes a script body, not an expression evaluator. The CLI
    // fallback accepts the bare IIFE, but WebDriver needs an explicit top-level
    // return to propagate the marker string back to Node.
    const payload = await this.execScript(storeId, `return ${buildExtractorScript(body, varName)};`);
    const raw = String(payload || '');
    if (!raw.startsWith(RESULT_MARKER)) {
      throw new ZiniaoError('WebDriver executeScript 未返回 extractor marker');
    }
    const result = parseJsonLoose(raw.slice(RESULT_MARKER.length));
    if (!result) throw new ZiniaoError('WebDriver extractor marker 内容不是合法 JSON');
    if (result.error) throw new ZiniaoError(`页面提取脚本失败: ${result.error}`, { payload: result });
    return { result, via: 'webdriver-return' };
  }
}
