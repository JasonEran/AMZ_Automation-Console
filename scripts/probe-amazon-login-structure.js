#!/usr/bin/env node

import { loadConfig } from '../src/lib/config.js';
import { createZiniao } from '../src/lib/ziniao-factory.js';
import { approvedAmazonUrl } from '../src/lib/amazon-url.js';
import { isApprovedAmazonLoginAction } from '../src/lib/ziniao-webdriver.js';

const storeName = String(process.argv[2] || '').trim();
if (!storeName || !/^[A-Za-z0-9._-]+$/.test(storeName)) {
  process.stderr.write('Usage: probe-amazon-login-structure.js <store-name>\n');
  process.exit(2);
}

const { config } = loadConfig({});
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const debuggingPort = Number(process.argv[3] || 0);
let driver;
if (Number.isInteger(debuggingPort) && debuggingPort >= 1024 && debuggingPort <= 65535) {
  const [{ Builder }, chrome] = await Promise.all([
    import('selenium-webdriver'),
    import('selenium-webdriver/chrome.js'),
  ]);
  const options = new chrome.Options().debuggerAddress(`127.0.0.1:${debuggingPort}`);
  const builder = new Builder().forBrowser('chrome').setChromeOptions(options);
  if (config.ziniao.webdriver.driverPath) {
    builder.setChromeService(new chrome.ServiceBuilder(config.ziniao.webdriver.driverPath));
  }
  driver = await builder.build();
} else {
  const zn = createZiniao({ config, logger });
  const opened = await zn.storeOpen({ name: storeName, timeoutMs: config.ziniao.openTimeoutMs });
  driver = zn.session(opened.storeId).driver;
}

let actionPerformed = false;
if (process.argv.includes('--submit-filled-password')) {
  const { By } = await import('selenium-webdriver');
  const parsed = approvedAmazonUrl(await driver.getCurrentUrl());
  if (!parsed || parsed.port || !/^sellercentral\.amazon\./i.test(parsed.hostname)
      || !/^\/ap\/signin(?:\/|$)/i.test(parsed.pathname)) {
    throw new Error('Refused password submit outside the approved Amazon sign-in route');
  }
  const passwordCandidates = await driver.findElements(By.css('input[type="password"]'));
  const visiblePasswords = [];
  for (const input of passwordCandidates.slice(0, 10)) {
    if (await input.isDisplayed() && await input.isEnabled()) visiblePasswords.push(input);
  }
  if (visiblePasswords.length !== 1) throw new Error('Expected exactly one visible Amazon password field');
  const passwordReady = await driver.executeScript(
    'return !!arguments[0] && typeof arguments[0].value==="string" && arguments[0].value.length>0;',
    visiblePasswords[0],
  );
  if (passwordReady !== true) throw new Error('Ziniao has not filled the Amazon password field');
  const submitCandidates = await driver.findElements(By.css('#signInSubmit'));
  const approved = [];
  for (const control of submitCandidates.slice(0, 50)) {
    if (!(await control.isDisplayed()) || !(await control.isEnabled())) continue;
    let label = String(
      (await control.getText())
      || (await control.getAttribute('value'))
      || (await control.getAttribute('aria-label'))
      || '',
    ).trim();
    if (!isApprovedAmazonLoginAction('signIn', label)) {
      label = String(await driver.executeScript(
        'var e=arguments[0],p=e&&e.closest?e.closest(".a-button"):null,'
        + 't=p&&p.querySelector?p.querySelector(".a-button-text"):null;'
        + 'return t?String(t.textContent||"").replace(/\\s+/g," ").trim():"";',
        control,
      ) || '').trim();
    }
    if (isApprovedAmazonLoginAction('signIn', label)) approved.push(control);
  }
  if (approved.length !== 1) throw new Error('Expected exactly one approved Amazon sign-in control');
  await approved[0].click();
  actionPerformed = true;
  await new Promise((resolve) => setTimeout(resolve, 1200));
}
if (process.argv.includes('--submit-filled-otp')) {
  const { By } = await import('selenium-webdriver');
  const parsed = approvedAmazonUrl(await driver.getCurrentUrl());
  if (!parsed || parsed.port || !/^sellercentral\.amazon\./i.test(parsed.hostname)
      || !/^\/ap\/mfa(?:\/|$)/i.test(parsed.pathname)) {
    throw new Error('Refused OTP submit outside the approved Amazon MFA route');
  }
  const otpCandidates = await driver.findElements(By.css(
    '#auth-mfa-otpcode,input[autocomplete="one-time-code"]',
  ));
  const visibleOtpInputs = [];
  for (const input of otpCandidates.slice(0, 10)) {
    if (await input.isDisplayed() && await input.isEnabled()) visibleOtpInputs.push(input);
  }
  if (visibleOtpInputs.length !== 1) throw new Error('Expected exactly one visible Amazon OTP field');
  const otpReady = await driver.executeScript(
    'return !!arguments[0] && typeof arguments[0].value==="string" && arguments[0].value.length>0;',
    visibleOtpInputs[0],
  );
  if (otpReady !== true) throw new Error('Ziniao has not filled the Amazon OTP field');
  const submitCandidates = await driver.findElements(By.css('#auth-signin-button'));
  const approved = [];
  for (const control of submitCandidates.slice(0, 10)) {
    if (!(await control.isDisplayed()) || !(await control.isEnabled())) continue;
    let label = String(
      (await control.getText())
      || (await control.getAttribute('value'))
      || (await control.getAttribute('aria-label'))
      || '',
    ).trim();
    if (!isApprovedAmazonLoginAction('signIn', label)) {
      label = String(await driver.executeScript(
        'var e=arguments[0],p=e&&e.closest?e.closest(".a-button"):null,'
        + 't=p&&p.querySelector?p.querySelector(".a-button-text"):null;'
        + 'return t?String(t.textContent||"").replace(/\\s+/g," ").trim():"";',
        control,
      ) || '').trim();
    }
    if (isApprovedAmazonLoginAction('signIn', label)) approved.push(control);
  }
  if (approved.length !== 1) throw new Error('Expected exactly one approved Amazon MFA sign-in control');
  await approved[0].click();
  actionPerformed = true;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

// This diagnostic deliberately returns only booleans and counts. It never
// returns control text, input values, URLs, account identifiers or OTP data.
const probeScript = (
  '/* amzguard-login-structure-probe-v1 */'
  + 'var roots=[document],seen=[],visibleRadios=[],visibleOtp=0,readyOtp=0,visibleInputs=0,emailFields=0,passwordFields=0,readyPasswordFields=0,otpCandidates=0,readyOtpCandidates=0,sendOtp=0,acceptOtp=0,continueAction=0,signIn=0,passkey=0,otpTextHint=0;'
  + 'function shown(e){if(!e)return false;var s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity)!==0&&r.width>0&&r.height>0;}'
  + 'function norm(v){return String(v||"").replace(/\\s+/g," ").trim();}'
  + 'function label(e){var t=norm((e.getAttribute&&(e.getAttribute("aria-label")||e.getAttribute("label")||e.getAttribute("value")))||e.innerText||e.textContent||"");'
  + 'if(t)return t;var p=e.closest&&e.closest(".a-button"),x=p&&p.querySelector&&p.querySelector(".a-button-text");return norm(x&&x.textContent);}'
  + 'for(var r=0;r<roots.length&&r<256;r++){var root=roots[r];if(seen.indexOf(root)>=0)continue;seen.push(root);var all=[];try{all=root.querySelectorAll("*");}catch(ignore){}'
  + 'for(var i=0;i<all.length&&i<10000;i++){var e=all[i];try{if(e.shadowRoot)roots.push(e.shadowRoot);}catch(ignore2){}}'
  + 'var radios=[];try{radios=root.querySelectorAll("input[type=radio]");}catch(ignore3){}for(var j=0;j<radios.length;j++){if(shown(radios[j])&&!radios[j].disabled)visibleRadios.push(radios[j]);}'
  + 'var otps=[];try{otps=root.querySelectorAll("#auth-mfa-otpcode,input[autocomplete=one-time-code]");}catch(ignore4){}for(var k=0;k<otps.length;k++){if(shown(otps[k])){visibleOtp++;if(norm(otps[k].value).length>0)readyOtp++;}}'
  + 'var inputs=[];try{inputs=root.querySelectorAll("input");}catch(ignore6){}for(var q=0;q<inputs.length;q++){var z=inputs[q];if(!shown(z)||z.disabled)continue;visibleInputs++;var type=String(z.type||"").toLowerCase(),meta=String((z.id||"")+" "+(z.name||"")+" "+(z.autocomplete||"")).toLowerCase();if(type==="email"||/email|username/.test(meta))emailFields++;if(type==="password"){passwordFields++;if(norm(z.value).length>0)readyPasswordFields++;}var max=Number(z.maxLength||0),candidate=type!=="password"&&type!=="email"&&type!=="search"&&(/otp|one-time|verification|code/.test(meta)||(max>=4&&max<=8));if(candidate){otpCandidates++;if(norm(z.value).length>0)readyOtpCandidates++;}}'
  + 'var bodyText="";try{bodyText=norm(root.body&&root.body.innerText||root.textContent||"");}catch(ignore7){}if(/one.time password|verification code|authenticator|\\u4e00\\u6b21\\u6027\\u5bc6\\u7801|\\u9a8c\\u8bc1\\u7801|\\u8ba4\\u8bc1\\u5668/i.test(bodyText))otpTextHint++;'
  + 'var controls=[];try{controls=root.querySelectorAll("button,a,[role=button],input[type=submit],kat-button");}catch(ignore5){}for(var n=0;n<controls.length;n++){var c=controls[n];if(!shown(c)||c.disabled)continue;var t=label(c);'
  + 'if(/^(?:\u53d1\u9001\u4e00\u6b21\u6027\u5bc6\u7801|\u53d1\u9001\u9a8c\u8bc1\u7801|send (?:the )?(?:one-time password|verification code|code))$/i.test(t))sendOtp++;'
  + 'if(/^(?:\u63a5\u53d7\u9a8c\u8bc1\u7801|\u63a5\u6536\u9a8c\u8bc1\u7801|\u83b7\u53d6\u9a8c\u8bc1\u7801|accept (?:the )?verification code|get (?:the )?verification code|receive (?:the )?(?:verification )?code)$/i.test(t))acceptOtp++;'
  + 'if(/^(?:continue|next|\u7ee7\u7eed|\u4e0b\u4e00\u6b65)$/i.test(t))continueAction++;if(/^(?:sign in|log in|\u767b\u5f55|\u767b\u5165)$/i.test(t))signIn++;if(/passkey|\\u5bc6\\u94a5/i.test(t))passkey++;}}'
  + 'var h=String(location.hostname||""),p=String(location.pathname||""),pageClass=!/^sellercentral\\.amazon\\./i.test(h)?"other":/^\\/ap\\/mfa(?:\\/|$)/i.test(p)?"mfa":/^\\/ap\\/signin(?:\\/|$)/i.test(p)?"signin":"seller";'
  + 'return {probeVersion:1,pageClass:pageClass,documentComplete:document.readyState==="complete",rootCount:seen.length,visibleRadioCount:visibleRadios.length,firstRadioSelected:visibleRadios.length===3&&visibleRadios[0].checked===true,selectedRadioCount:visibleRadios.filter(function(x){return x.checked===true;}).length,visibleInputCount:visibleInputs,emailFieldCount:emailFields,passwordFieldCount:passwordFields,readyPasswordFieldCount:readyPasswordFields,otpCandidateCount:otpCandidates,readyOtpCandidateCount:readyOtpCandidates,otpTextHintCount:otpTextHint,visibleOtpCount:visibleOtp,readyOtpCount:readyOtp,sendOtpActionCount:sendOtp,acceptOtpActionCount:acceptOtp,continueActionCount:continueAction,signInActionCount:signIn,passkeyActionCount:passkey};'
);

const results = [];
const handles = await driver.getAllWindowHandles();
for (const handle of handles.slice(0, 10)) {
  await driver.switchTo().window(handle);
  const result = await driver.executeScript(probeScript);
  if (!result || result.probeVersion !== 1) throw new Error('Login structure probe did not return its version marker');
  results.push(result);
}
process.stdout.write(`${JSON.stringify({
  probeVersion: 1,
  actionPerformed,
  windowCount: handles.length,
  windows: results,
})}\n`);
