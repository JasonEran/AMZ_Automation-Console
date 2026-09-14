import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  loadDingTalkCredentials,
  saveDingTalkCredentials,
} from '../src/lib/credentials.js';
import { assertNoInlineSecrets, inlineSecretPaths, loadConfig } from '../src/lib/config.js';
import { inboxCheck } from '../src/checks/definitions.js';
import { approvedAmazonUrl, assertApprovedAmazonUrl } from '../src/lib/amazon-url.js';
import {
  classifyAsinProductReadSafety, classifyLivePageSafety, classifyPageSafety, classifyUrlSafety,
  isRecoverableBrowserInternalSafety, isTransientEmptyDocumentSafety, POST_SCREENSHOT_SAFETY_EXTRACTOR,
} from '../src/lib/page-safety.js';
import { redactText, sanitizeForStorage, sanitizeUrl } from '../src/lib/redact.js';
import { sanitizeZiniaoWebDriverLogs } from '../src/lib/ziniao-log-sanitizer.js';
import { createAlerter, isOfficialDingTalkWebhook } from '../src/lib/alert.js';
import {
  SECURITY_CLEANUP_FAILED, secureCleanupEvidence, secureCleanupReportedEvidence,
  validateEvidenceArtifact,
} from '../src/lib/evidence-cleanup.js';
import { runProbe } from '../src/tools/probe.js';
import { runWebDriverProbe } from '../src/tools/probe-webdriver.js';
import { Ziniao } from '../src/lib/ziniao.js';
import {
  hasOrdinaryZiniaoProcess,
  isApprovedVocDetailAction,
  isApprovedAccountSwitcherExpander,
  isApprovedAmazonLoginAction,
  isApprovedExistingAccountLink,
  otpInputIsReady,
  parseLoopbackDebuggingEndpoint,
  ZiniaoWebDriver,
} from '../src/lib/ziniao-webdriver.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..');

test('sanitizeUrl strips userinfo, query and fragment', () => {
  assert.equal(
    sanitizeUrl('https://person:password@example.com/report?a=secret#openid'),
    'https://example.com/report',
  );
  assert.equal(sanitizeUrl('/performance/dashboard?ref=token#part'), '/performance/dashboard');
  assert.equal(sanitizeUrl('ordinary text? still text'), 'ordinary text? still text');
  assert.equal(sanitizeUrl('file:///Users/person/secret.txt'), '[REDACTED]');
  assert.equal(sanitizeUrl('https://[invalid?openid=DO_NOT_KEEP#otp'), '[REDACTED]');
});

test('Ziniao client WebDriver logs are atomically redacted without losing audit lines', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-ziniao-log-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const logDir = path.join(homeDir, '.config', 'ziniaobrowser', 'instances', 'userdata1', 'logs', 'client');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const file = path.join(logDir, 'webdriver.20260901.log');
  const credentials = { company: 'COMPANY_SECRET', username: 'USER_SECRET', password: 'PASSWORD_SECRET' };
  const original = '[2026-09-01 11:50:10] Received parameters: '
    + JSON.stringify({ ...credentials, action: 'updateCore', requestId: 'safe-audit-id' });
  fs.writeFileSync(file, `${original}\n`, { mode: 0o600 });
  const timestamp = new Date('2026-09-01T03:50:10.000Z');
  fs.utimesSync(file, timestamp, timestamp);

  const result = sanitizeZiniaoWebDriverLogs({ credentials, homeDir, platform: 'linux' });
  assert.deepEqual(result, { supported: true, files: 1, changed: 1 });
  const sanitized = fs.readFileSync(file, 'utf8');
  assert.match(sanitized, /\[2026-09-01 11:50:10\]/);
  assert.match(sanitized, /"action":"updateCore"/);
  assert.match(sanitized, /"requestId":"safe-audit-id"/);
  assert.equal(Object.values(credentials).some((secret) => sanitized.includes(secret)), false);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.equal(fs.statSync(file).mtime.toISOString(), timestamp.toISOString());
  assert.equal(sanitizeZiniaoWebDriverLogs({ credentials, homeDir, platform: 'linux' }).changed, 0);
});

test('Ziniao client log sanitizer refuses symlink log files', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-ziniao-log-link-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const logDir = path.join(homeDir, '.config', 'ziniaobrowser', 'instances', 'userdata1', 'logs', 'client');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const outside = path.join(homeDir, 'outside.log');
  fs.writeFileSync(outside, 'must remain unchanged', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(logDir, 'webdriver.20260901.log'));
  assert.throws(
    () => sanitizeZiniaoWebDriverLogs({
      credentials: { company: 'a', username: 'b', password: 'c' }, homeDir, platform: 'linux',
    }),
    /日志文件类型不安全/,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'must remain unchanged');
});

test('store configuration rejects path-like and duplicate canonical keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-store-keys-'));
  const configFile = path.join(root, 'config.json');
  const storesFile = path.join(root, 'stores.json');
  fs.writeFileSync(configFile, JSON.stringify({ paths: { outDir: path.join(root, 'out') } }));
  fs.writeFileSync(storesFile, JSON.stringify([{ key: '../shop', name: 'A', id: '1' }]));
  assert.throws(() => loadConfig({ configFile, storesFile }), /店铺 key/);
  fs.writeFileSync(storesFile, JSON.stringify([
    { key: 'SHOP-A', name: 'A', id: '1' }, { key: 'SHOP-A', name: 'B', id: '2' },
  ]));
  assert.throws(() => loadConfig({ configFile, storesFile }), /店铺 key 重复/);
});

test('evidence cleanup removes only ordinary files inside the configured output root', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-evidence-cleanup-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const outDir = path.join(temp, 'out');
  const shots = path.join(outDir, 'check', 'shots');
  fs.mkdirSync(shots, { recursive: true, mode: 0o700 });
  const artifact = path.join(shots, 'evidence.png');
  fs.writeFileSync(artifact, 'sensitive evidence', { mode: 0o600 });

  assert.equal(validateEvidenceArtifact({ file: artifact, outDir }).ok, true);
  const cleaned = secureCleanupEvidence({ file: artifact, outDir });
  assert.deepEqual(cleaned, {
    ok: true, code: 'CLEANED', removed: true, quarantined: false,
  });
  assert.equal(fs.existsSync(artifact), false);
});

test('failed evidence unlink quarantines mode-000 bytes but remains a cleanup failure', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-evidence-quarantine-'));
  t.after(() => {
    const quarantine = path.join(temp, 'out', '.evidence-quarantine');
    for (const entry of fs.existsSync(quarantine) ? fs.readdirSync(quarantine, { withFileTypes: true }) : []) {
      if (entry.isFile()) fs.chmodSync(path.join(quarantine, entry.name), 0o600);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const outDir = path.join(temp, 'out');
  const shots = path.join(outDir, 'check', 'shots');
  fs.mkdirSync(shots, { recursive: true, mode: 0o700 });
  const artifact = path.join(shots, 'must-not-leak.png');
  fs.writeFileSync(artifact, 'sensitive evidence', { mode: 0o600 });
  const fsImpl = Object.create(fs);
  fsImpl.unlinkSync = () => {
    const error = new Error('injected unlink failure');
    error.code = 'EACCES';
    throw error;
  };

  const cleaned = secureCleanupEvidence({
    file: artifact,
    outDir,
    fsImpl,
    randomBytes: () => Buffer.alloc(16, 7),
  });
  assert.equal(cleaned.ok, false);
  assert.equal(cleaned.code, SECURITY_CLEANUP_FAILED);
  assert.equal(cleaned.quarantined, true);
  assert.equal(fs.existsSync(artifact), false);
  assert.equal(JSON.stringify(cleaned).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(cleaned).includes(temp), false);
  const quarantine = path.join(outDir, '.evidence-quarantine');
  assert.equal(fs.statSync(quarantine).mode & 0o777, 0o700);
  const entries = fs.readdirSync(quarantine);
  assert.equal(entries.length, 1);
  assert.equal(fs.statSync(path.join(quarantine, entries[0])).mode & 0o777, 0o000);
});

test('evidence cleanup rejects out-of-root files and symlinks without touching their targets', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-evidence-boundary-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const external = path.join(temp, 'external.png');
  fs.writeFileSync(external, 'external bytes', { mode: 0o600 });
  const link = path.join(outDir, 'linked.png');
  fs.symlinkSync(external, link);

  const outside = secureCleanupEvidence({ file: external, outDir });
  assert.equal(outside.ok, false);
  assert.equal(outside.code, SECURITY_CLEANUP_FAILED);
  assert.equal(outside.reason, 'OUTSIDE_ROOT');
  const linked = secureCleanupEvidence({ file: link, outDir });
  assert.equal(linked.ok, false);
  assert.equal(linked.code, SECURITY_CLEANUP_FAILED);
  assert.equal(linked.reason, 'UNSAFE_TARGET_TYPE');
  assert.equal(validateEvidenceArtifact({ file: link, outDir }).ok, false);
  assert.equal(fs.readFileSync(external, 'utf8'), 'external bytes');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('untrusted screenshot output cannot nominate another in-root file for deletion', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-evidence-reported-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const expected = path.join(outDir, 'expected.png');
  const unrelated = path.join(outDir, 'latest.json');
  fs.writeFileSync(expected, 'new screenshot', { mode: 0o600 });
  fs.writeFileSync(unrelated, 'existing report', { mode: 0o600 });

  const cleaned = secureCleanupReportedEvidence({
    expectedFile: expected,
    reportedFile: unrelated,
    outDir,
  });
  assert.equal(cleaned.ok, false);
  assert.equal(cleaned.code, SECURITY_CLEANUP_FAILED);
  assert.equal(cleaned.reason, 'UNTRUSTED_REPORTED_TARGET');
  assert.equal(fs.existsSync(expected), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'existing report');
  assert.equal(JSON.stringify(cleaned).includes(temp), false);
});

test('quarantine lockdown never follows a path swapped to an external symlink', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-evidence-lockdown-race-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const artifact = path.join(outDir, 'evidence.png');
  const external = path.join(temp, 'external.txt');
  fs.writeFileSync(artifact, 'sensitive', { mode: 0o600 });
  fs.writeFileSync(external, 'external', { mode: 0o640 });
  const externalMode = fs.statSync(external).mode & 0o777;
  const fsImpl = Object.create(fs);
  fsImpl.unlinkSync = (target) => {
    if (path.resolve(target) === path.resolve(artifact)) {
      const error = new Error('injected unlink failure');
      error.code = 'EACCES';
      throw error;
    }
    return fs.unlinkSync(target);
  };
  fsImpl.renameSync = (source, destination) => {
    fs.renameSync(source, destination);
    fs.unlinkSync(destination);
    fs.symlinkSync(external, destination);
  };

  const result = secureCleanupEvidence({
    file: artifact, outDir, fsImpl, randomBytes: () => Buffer.alloc(16, 8),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, SECURITY_CLEANUP_FAILED);
  assert.equal(result.reason, 'QUARANTINE_LOCKDOWN_FAILED');
  assert.equal(fs.statSync(external).mode & 0o777, externalMode);
  assert.equal(fs.readFileSync(external, 'utf8'), 'external');
});

test('Amazon navigation allowlist accepts marketplaces and rejects external, HTTP and credentialed URLs', () => {
  assert.equal(approvedAmazonUrl('https://sellercentral.amazon.com/performance/dashboard')?.hostname,
    'sellercentral.amazon.com');
  assert.equal(approvedAmazonUrl('https://www.amazon.co.jp/dp/B012345678')?.hostname, 'www.amazon.co.jp');
  assert.equal(approvedAmazonUrl('/cm/campaigns', { base: 'https://advertising.amazon.com/home' })?.hostname,
    'advertising.amazon.com');
  assert.equal(approvedAmazonUrl('https://amazon.com.evil.example/dp/B012345678'), null);
  assert.equal(approvedAmazonUrl('http://www.amazon.com/dp/B012345678'), null);
  assert.equal(approvedAmazonUrl('https://www.amazon.com:8443/dp/B012345678'), null);
  assert.equal(approvedAmazonUrl('https://user:secret@www.amazon.com/dp/B012345678'), null);
  assert.throws(() => assertApprovedAmazonUrl('https://example.invalid/amazon'), /拒绝访问/);
  assert.equal(classifyUrlSafety('https://example.invalid/fake-sellercentral').code,
    'UNAPPROVED_AMAZON_HOST');
});

test('WebDriver transport rejects an unapproved target before browser navigation', async () => {
  const visited = [];
  const driver = {
    async get(url) { visited.push(url); },
    async getCurrentUrl() { return visited.at(-1) || 'about:blank'; },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  await assert.rejects(transport.visit('opaque', 'https://example.invalid/phish'), /拒绝访问/);
  assert.deepEqual(visited, []);
  await transport.visit('opaque', 'https://sellercentral.amazon.com/performance/dashboard');
  assert.deepEqual(visited, ['https://sellercentral.amazon.com/performance/dashboard']);
});

test('WebDriver page text adds only visible public star component values', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/lib/ziniao-webdriver.js'), 'utf8');
  const method = source.slice(source.indexOf('async content('), source.indexOf('async waitElement('));
  assert.match(method, /tagName.*kat-star-rating/s);
  assert.match(method, /visited < 6000/);
  assert.match(method, /reviewRating/);
  assert.match(method, /semantic\.length < 200/);
  assert.match(method, /getAttribute\("value"\).*getAttribute\("rating"\)/s);
  assert.doesNotMatch(method, /querySelectorAll\([^\n]*(?:input|textarea|password)/i);
  assert.doesNotMatch(method, /\.value\b/);
  const literalStart = method.indexOf('`var bodyText');
  const literalEnd = method.indexOf('`,', literalStart);
  assert.ok(literalStart >= 0 && literalEnd > literalStart);
  const literal = method.slice(literalStart, literalEnd + 1);
  assert.ok(literal);
  const executable = Function(`return ${literal}`)();
  assert.doesNotThrow(() => Function(executable));
});

test('WebDriver screenshot uses an exclusive no-follow private target', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-webdriver-shot-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const driver = {
    async takeScreenshot() { return Buffer.from('png bytes').toString('base64'); },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  const shot = path.join(temp, 'shots', 'evidence.png');
  const written = await transport.screenshot('opaque', shot, { fullPage: false });
  assert.equal(written.path, path.resolve(shot));
  assert.equal(fs.readFileSync(shot, 'utf8'), 'png bytes');
  assert.equal(fs.statSync(shot).mode & 0o777, 0o600);

  const external = path.join(temp, 'external.txt');
  const linkedShot = path.join(temp, 'shots', 'linked.png');
  fs.writeFileSync(external, 'do not overwrite', { mode: 0o640 });
  fs.symlinkSync(external, linkedShot);
  await assert.rejects(
    transport.screenshot('opaque', linkedShot, { fullPage: false }),
    (error) => error?.code === SECURITY_CLEANUP_FAILED,
  );
  assert.equal(fs.readFileSync(external, 'utf8'), 'do not overwrite');
  assert.equal(fs.lstatSync(linkedShot).isSymbolicLink(), true);

  const racedShot = path.join(temp, 'shots', 'raced.png');
  transport.sessions = new Map([['opaque', {
    name: 'Safe Store',
    driver: {
      async takeScreenshot() {
        fs.symlinkSync(external, racedShot);
        return Buffer.from('sensitive bytes').toString('base64');
      },
    },
  }]]);
  await assert.rejects(
    transport.screenshot('opaque', racedShot, { fullPage: false }),
    (error) => error?.code === SECURITY_CLEANUP_FAILED,
  );
  assert.equal(fs.readFileSync(external, 'utf8'), 'do not overwrite');
  assert.equal(fs.lstatSync(racedShot).isSymbolicLink(), true);
});

test('VOC read-only action allowlist requires exact ASIN row, exact label and same Seller Central VOC URL', () => {
  const base = 'https://sellercentral.amazon.com/voice-of-the-customer';
  assert.equal(isApprovedVocDetailAction({
    asin: 'B012345678', rowText: 'Widget B012345678', label: '查看详情', href: '', beforeUrl: base,
  }), true);
  assert.equal(isApprovedVocDetailAction({
    asin: 'B012345678', rowText: 'Widget B012345678', label: 'Create deal', href: '', beforeUrl: base,
  }), false);
  assert.equal(isApprovedVocDetailAction({
    asin: 'B012345678', rowText: 'B012345678 B087654321', label: 'View details', href: '', beforeUrl: base,
  }), false);
  assert.equal(isApprovedVocDetailAction({
    asin: 'B012345678', rowText: 'Widget B012345678', label: 'View details',
    href: 'https://sellercentral.amazon.com/inventory', beforeUrl: base,
  }), false);
  assert.equal(isApprovedVocDetailAction({
    asin: 'B012345678', rowText: 'Widget B012345678', label: 'View details',
    href: 'https://example.invalid/voice-of-the-customer', beforeUrl: base,
  }), false);
});

test('VOC WebDriver activation waits for async row, clicks shadow leaf, switches safe new tab and restores list', async () => {
  const asin = 'B012345678';
  const listUrl = 'https://sellercentral.amazon.com/voice-of-the-customer';
  const detailUrl = `${listUrl}?asin=${asin}`;
  let currentHandle = 'origin-handle';
  let handles = ['origin-handle'];
  let lookupCalls = 0;
  let shadowClicks = 0;
  let closes = 0;
  let appliedTimeouts = null;
  const inner = {
    async getText() { return '查看详情'; },
    async getAttribute() { return null; },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() {
      shadowClicks++;
      if (!handles.includes('detail-handle')) handles.push('detail-handle');
    },
  };
  const shadow = {
    async findElements(locator) {
      return String(locator?.value || '').startsWith('button,a') ? [inner] : [];
    },
  };
  const host = {
    async getText() { return ''; },
    async getAttribute(name) { return name === 'label' ? '查看详情' : null; },
    async getTagName() { return 'kat-button'; },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async getShadowRoot() { return shadow; },
  };
  const row = {
    async getText() { return `Widget ${asin} Good`; },
    async isDisplayed() { return true; },
    async findElements(locator) {
      const selector = String(locator?.value || '');
      if (selector.startsWith('kat-table,')) return [];
      if (selector.startsWith('a,button')) return [host];
      return [];
    },
  };
  const driver = {
    manage() {
      return { setTimeouts: async (value) => { appliedTimeouts = value; } };
    },
    async getCurrentUrl() { return currentHandle === 'detail-handle' ? detailUrl : listUrl; },
    async getWindowHandle() { return currentHandle; },
    async getAllWindowHandles() { return [...handles]; },
    async findElements(locator) {
      const selector = String(locator?.value || '');
      if (selector.startsWith('kat-table,')) return [];
      if (selector.startsWith('tr,')) {
        lookupCalls++;
        return lookupCalls >= 3 ? [row] : [];
      }
      return [];
    },
    async executeScript(script) {
      if (String(script).includes('amzguard-voc-detail-surface/v1')) {
        return {
          probeVersion: 1, visibleDialogCount: 0, visibleDrawerCount: 0,
          inlineExpected: false, expectedInSurface: false,
        };
      }
      throw new Error('unexpected script');
    },
    switchTo() { return { window: async (handle) => { currentHandle = handle; } }; },
    async close() {
      closes++;
      handles = handles.filter((handle) => handle !== currentHandle);
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.execExtract = async () => ({ result: {
    probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true,
  } });
  const opened = await transport.activateVocReadOnlyDetail('opaque', asin, { timeoutMs: 1000 });
  assert.equal(opened.activated, true);
  assert.equal(opened.transition, 'new-tab');
  assert.equal(opened.usedShadowButton, true);
  assert.deepEqual(appliedTimeouts, { pageLoad: 5000, script: 30000 });
  assert.equal(shadowClicks, 1);
  assert.ok(lookupCalls >= 3);
  assert.equal(opened.originHandle, undefined);
  assert.equal(opened.detailHandle, undefined);
  const released = await transport.releaseVocReadOnlyDetail('opaque');
  assert.equal(released.closedNewTab, true);
  assert.equal(closes, 1);
  assert.equal(currentHandle, 'origin-handle');
  assert.deepEqual(handles, ['origin-handle']);
});

test('VOC same-URL activation accepts exact target modal and rejects wrong-ASIN modal', async () => {
  const run = async (expectedInSurface) => {
    const asin = 'B012345678';
    const listUrl = 'https://sellercentral.amazon.com/voice-of-the-customer';
    let opened = false;
    const control = {
      async getText() { return 'View details'; },
      async getAttribute() { return null; },
      async getTagName() { return 'button'; },
      async isDisplayed() { return true; },
      async isEnabled() { return true; },
      async click() { opened = true; },
    };
    const row = {
      async getText() { return `Widget ${asin}`; },
      async isDisplayed() { return true; },
      async findElements(locator) {
        const selector = String(locator?.value || '');
        if (selector.startsWith('a,button')) return [control];
        return [];
      },
    };
    const driver = {
      async getCurrentUrl() { return listUrl; },
      async getWindowHandle() { return 'origin'; },
      async getAllWindowHandles() { return ['origin']; },
      async findElements(locator) {
        const selector = String(locator?.value || '');
        return selector.startsWith('tr,') ? [row] : [];
      },
      async executeScript(script) {
        if (!String(script).includes('amzguard-voc-detail-surface/v1')) throw new Error('unexpected script');
        return {
          probeVersion: 1, visibleDialogCount: opened ? 1 : 0, visibleDrawerCount: 0,
          inlineExpected: false, expectedInSurface: opened && expectedInSurface,
        };
      },
    };
    const transport = Object.create(ZiniaoWebDriver.prototype);
    transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
    transport.sleep = async () => new Promise((resolve) => setTimeout(resolve, 5));
    transport.execExtract = async () => ({ result: {
      probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true,
    } });
    return transport.activateVocReadOnlyDetail('opaque', asin, { timeoutMs: 10 });
  };
  const correct = await run(true);
  assert.equal(correct.activated, true);
  assert.equal(correct.transition, 'dialog');
  const wrong = await run(false);
  assert.equal(wrong.activated, false);
  assert.equal(wrong.transition, 'none');
});

test('VOC native click fails closed when WebDriver reports an intercepted control', async () => {
  let actionClicks = 0;
  const transport = Object.create(ZiniaoWebDriver.prototype);
  const candidate = {
    tag: 'button',
    control: { async click() { throw new Error('element click intercepted'); } },
  };
  await assert.rejects(
    transport.clickVocReadOnlyControl({ driver: {
      actions() { actionClicks++; return { move() { return this; }, click() { return this; }, async perform() {} }; },
    } }, candidate),
    /intercepted/,
  );
  assert.equal(actionClicks, 0);
});

test('live safety boolean probe detects Chinese Passkey controls inside open KAT shadow DOM', () => {
  const passkey = {
    innerText: '', textContent: '',
    getAttribute(name) { return name === 'label' ? '使用通行密钥登录' : null; },
  };
  const shadow = {
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '*') return [passkey];
      return selector.includes('kat-button') ? [passkey] : [];
    },
  };
  const host = { shadowRoot: shadow };
  const document = {
    documentElement: {},
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '*' ? [host] : []; },
  };
  const result = new Function('document', POST_SCREENSHOT_SAFETY_EXTRACTOR)(document);
  assert.doesNotMatch(POST_SCREENSHOT_SAFETY_EXTRACTOR, /[^\x00-\x7f]/);
  assert.equal(result.probeVersion, 2);
  assert.equal(result.looksLikeLogin, true);
  assert.equal(result.looksBlocked, false);
  assert.equal(result.traversalComplete, true);
  assert.equal(result.discoveredRootCount, 2);
  assert.equal(result.scannedRootCount, 2);
  assert.equal(result.rootBudgetExceeded, false);
  assert.equal(result.elementBudgetExceeded, false);
  assert.equal(result.nodeBudgetExceeded, false);
});

test('live safety probe reaches the 3001st shadow host and fails closed only beyond its high traversal budget', async () => {
  const passkey = {
    innerText: 'Use a passkey to sign in', textContent: 'Use a passkey to sign in',
    getAttribute() { return null; },
  };
  const shadow = {
    querySelector(selector) { return selector.includes('passkey') ? passkey : null; },
    querySelectorAll(selector) { return selector === '*' ? [passkey] : []; },
  };
  const elements = Array.from({ length: 3000 }, () => ({ shadowRoot: null }));
  elements.push({ shadowRoot: shadow });
  const document = {
    documentElement: {},
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '*' ? elements : []; },
  };
  const result = new Function('document', POST_SCREENSHOT_SAFETY_EXTRACTOR)(document);
  assert.equal(result.looksLikeLogin, true);
  assert.equal(result.traversalComplete, true);

  const url = 'https://sellercentral.amazon.com/voice-of-the-customer';
  const authSafety = await classifyLivePageSafety({
    storeId: 'opaque',
    zn: {
      async currentUrl() { return url; },
      async execExtract() { return { result }; },
    },
  });
  assert.equal(authSafety.safe, false);
  assert.equal(authSafety.code, 'AUTH_SENSITIVE');

  const overflowDocument = {
    documentElement: {},
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === '*' ? Array.from({ length: 50001 }, () => ({ shadowRoot: null })) : [];
    },
  };
  const overflow = new Function('document', POST_SCREENSHOT_SAFETY_EXTRACTOR)(overflowDocument);
  assert.equal(overflow.looksLikeLogin, false);
  assert.equal(overflow.traversalComplete, false);
  assert.equal(overflow.discoveredRootCount, 1);
  assert.equal(overflow.scannedRootCount, 1);
  assert.equal(overflow.discoveredElementCount, 50001);
  assert.equal(overflow.scannedElementCount, 50000);
  assert.equal(overflow.elementBudgetExceeded, true);
  assert.equal(overflow.rootBudgetExceeded, false);
  assert.equal(overflow.nodeBudgetExceeded, false);

  const rootOverflowDocument = {
    documentElement: {},
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector !== '*') return [];
      return Array.from({ length: 512 }, () => ({
        shadowRoot: { querySelector() { return null; }, querySelectorAll() { return []; } },
      }));
    },
  };
  const rootOverflow = new Function('document', POST_SCREENSHOT_SAFETY_EXTRACTOR)(rootOverflowDocument);
  assert.equal(rootOverflow.looksLikeLogin, false);
  assert.equal(rootOverflow.traversalComplete, false);
  assert.equal(rootOverflow.discoveredRootCount, 513);
  assert.equal(rootOverflow.scannedRootCount, 512);
  assert.equal(rootOverflow.discoveredElementCount, 512);
  assert.equal(rootOverflow.scannedElementCount, 512);
  assert.equal(rootOverflow.rootBudgetExceeded, true);
  assert.equal(rootOverflow.elementBudgetExceeded, false);

  const candidateNodes = Array.from({ length: 5001 }, () => ({
    shadowRoot: null, getAttribute() { return null; }, innerText: '', textContent: '',
  }));
  const nodeOverflowDocument = {
    documentElement: {},
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '*' ? candidateNodes : candidateNodes; },
  };
  const nodeOverflow = new Function('document', POST_SCREENSHOT_SAFETY_EXTRACTOR)(nodeOverflowDocument);
  assert.equal(nodeOverflow.traversalComplete, false);
  assert.equal(nodeOverflow.candidateNodeCount, 5000);
  assert.equal(nodeOverflow.nodeBudgetExceeded, true);
  assert.equal(nodeOverflow.elementBudgetExceeded, false);

  const traversalErrorDocument = {
    documentElement: {},
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '*') throw new Error('opaque root');
      return [];
    },
  };
  const traversalError = new Function('document', POST_SCREENSHOT_SAFETY_EXTRACTOR)(traversalErrorDocument);
  assert.equal(traversalError.traversalComplete, false);
  assert.equal(traversalError.traversalErrorCount, 1);
  assert.equal(traversalError.rootBudgetExceeded, false);
  assert.equal(traversalError.elementBudgetExceeded, false);
  assert.equal(traversalError.nodeBudgetExceeded, false);

  overflow.unsafePageText = 'OTP 123456 SHOULD NEVER PERSIST';
  const incompleteSafety = await classifyLivePageSafety({
    storeId: 'opaque',
    zn: {
      async currentUrl() { return url; },
      async execExtract() { return { result: overflow }; },
    },
  });
  assert.equal(incompleteSafety.safe, false);
  assert.equal(incompleteSafety.code, 'LIVE_SAFETY_PROBE_INCOMPLETE');
  assert.equal(incompleteSafety.liveProbeUnavailable, true);
  assert.deepEqual(incompleteSafety.liveProbeDiagnostics, {
    discoveredRootCount: 1,
    scannedRootCount: 1,
    discoveredElementCount: 50001,
    scannedElementCount: 50000,
    candidateNodeCount: 0,
    visibleFrameCount: 0,
    unreadableVisibleFrameCount: 0,
    traversalErrorCount: 0,
    nonFrameTraversalErrorCount: 0,
    unreadableFrameErrorCount: 0,
    opaqueOverlayFrameCount: 0,
    opaqueAuthHintCount: 0,
    opaqueBlockedHintCount: 0,
    rootBudget: 512,
    elementBudget: 50000,
    nodeBudget: 5000,
    unreadableFrameBudget: 8,
    accessibleTraversalComplete: false,
    mainDocumentTraversalComplete: false,
    rootBudgetExceeded: false,
    elementBudgetExceeded: true,
    nodeBudgetExceeded: false,
    unreadableFrameBudgetExceeded: false,
  });
  assert.doesNotMatch(JSON.stringify(incompleteSafety), /123456|unsafePageText/);

  const authStillWins = await classifyLivePageSafety({
    storeId: 'opaque',
    zn: {
      async currentUrl() { return url; },
      async execExtract() { return { result: { ...rootOverflow, looksLikeLogin: true } }; },
    },
  });
  assert.equal(authStillWins.safe, false);
  assert.equal(authStillWins.code, 'AUTH_SENSITIVE');
  assert.equal(authStillWins.liveProbeDiagnostics.rootBudgetExceeded, true);
});

function shadowRootSafetyDocument(rootCount, tailRisk = null) {
  let root = {
    querySelector(selector) {
      if (tailRisk === 'auth' && selector.includes('input[type=password]')) return { hidden: true };
      if (tailRisk === 'blocked' && selector.includes('#captchacharacters')) return { hidden: true };
      return null;
    },
    querySelectorAll() { return []; },
  };
  for (let index = 1; index < rootCount; index++) {
    const host = { shadowRoot: root };
    root = {
      querySelector() { return null; },
      querySelectorAll(selector) { return selector === '*' ? [host] : []; },
    };
  }
  root.documentElement = {};
  return root;
}

async function classifyShadowRootSafety(url, rootCount, { tailRisk = null, afterUrl = url } = {}) {
  const document = shadowRootSafetyDocument(rootCount, tailRisk);
  let source = null;
  let urlReads = 0;
  const safety = await classifyLivePageSafety({
    storeId: 'opaque',
    zn: {
      async currentUrl() { return urlReads++ === 0 ? url : afterUrl; },
      async execExtract(_storeId, script) {
        source = script;
        return { result: new Function('document', script)(document) };
      },
    },
  });
  return { safety, source };
}

test('exact bulk-upload live gate completely scans up to 2048 roots and still rejects overflow or URL changes', async () => {
  const bulk = 'https://sellercentral.amazon.com/product-search/bulk';
  for (const rootCount of [513, 2048, 2049]) {
    const { safety, source } = await classifyShadowRootSafety(bulk, rootCount);
    assert.equal(safety.safe, rootCount <= 2048);
    assert.equal(safety.code, rootCount <= 2048 ? 'LIVE_PAGE_NON_SENSITIVE' : 'LIVE_SAFETY_PROBE_INCOMPLETE');
    const diagnostics = safety.liveProbeDiagnostics;
    assert.equal(diagnostics.discoveredRootCount, rootCount);
    assert.equal(diagnostics.scannedRootCount, Math.min(rootCount, 2048));
    assert.equal(diagnostics.rootBudgetExceeded, rootCount > 2048);
    assert.equal(diagnostics.accessibleTraversalComplete, rootCount <= 2048);
    assert.equal(diagnostics.rootBudget, 2048);
    assert.equal(diagnostics.elementBudget, 50000);
    assert.equal(diagnostics.nodeBudget, 5000);
    assert.equal(diagnostics.unreadableFrameBudget, 8);
    assert.equal(source.replace('rootBudget=2048,', 'rootBudget=512,'), POST_SCREENSHOT_SAFETY_EXTRACTOR);
    assert.doesNotMatch(source, /[^\x00-\x7f]/);
  }
  const changed = await classifyShadowRootSafety(bulk, 2048, { afterUrl: `${bulk}?preview=changed` });
  assert.equal(changed.safety.safe, false);
  assert.equal(changed.safety.code, 'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE');
});

test('bulk-upload root budget never extends to query, fragment, port, similar paths or other pages', async () => {
  for (const url of [
    'https://sellercentral.amazon.com/product-search/bulk?preview=1',
    'https://sellercentral.amazon.com/product-search/bulk#preview',
    'https://sellercentral.amazon.com/product-search/bulk/',
    'https://sellercentral.amazon.com/product-search/bulk-other',
    'https://sellercentral.amazon.com/product-search/bulk/preview',
    'https://sellercentral.amazon.com:443/product-search/bulk',
    'https://sellercentral.amazon.com./product-search/bulk',
    'https://sellercentral.amazon.com/voice-of-the-customer',
    'https://www.amazon.com/product-search/bulk',
  ]) {
    const { safety, source } = await classifyShadowRootSafety(url, 513);
    assert.equal(source, POST_SCREENSHOT_SAFETY_EXTRACTOR, url);
    assert.equal(safety.safe, false, url);
    assert.equal(safety.code, 'LIVE_SAFETY_PROBE_INCOMPLETE', url);
    assert.equal(safety.liveProbeDiagnostics.rootBudget, 512, url);
    assert.equal(safety.liveProbeDiagnostics.rootBudgetExceeded, true, url);
  }
  for (const url of [
    'http://sellercentral.amazon.com/product-search/bulk',
    'https://sellercentral.amazon.com:8443/product-search/bulk',
    'https://user:secret@sellercentral.amazon.com/product-search/bulk',
    'https://sellercentral.amazon.com.evil.example/product-search/bulk',
  ]) {
    const { safety, source } = await classifyShadowRootSafety(url, 513);
    assert.equal(source, null, 'unapproved URL must not run a DOM probe');
    assert.equal(safety.safe, false);
    assert.equal(safety.code, 'UNAPPROVED_AMAZON_HOST');
  }
});

test('bulk-upload larger traversal still detects hidden authentication and blocking controls in its deepest root', async () => {
  const bulk = 'https://sellercentral.amazon.com/product-search/bulk';
  for (const tailRisk of ['auth', 'blocked']) {
    const { safety } = await classifyShadowRootSafety(bulk, 2048, { tailRisk });
    assert.equal(safety.safe, false);
    assert.equal(safety.code, tailRisk === 'auth' ? 'AUTH_SENSITIVE' : 'ACCESS_BLOCKED');
    assert.equal(safety.authSensitive, true);
    assert.equal(safety.blocked, tailRisk === 'blocked');
    assert.equal(safety.liveProbeDiagnostics.scannedRootCount, 2048);
    assert.equal(safety.liveProbeDiagnostics.rootBudgetExceeded, false);
  }
});

function iframeLiveSafetyProbe({
  authSelector = null, unreadable = false, hidden = false, zeroSize = false, frameMeta = '',
} = {}) {
  const sensitive = { shadowRoot: null, getAttribute() { return null; }, innerText: '', textContent: '' };
  const childDocument = {
    documentElement: {},
    querySelector(selector) { return authSelector && selector.includes(authSelector) ? sensitive : null; },
    querySelectorAll(selector) { return selector === '*' ? [sensitive] : []; },
  };
  const frame = {
    tagName: 'IFRAME',
    hidden,
    style: {},
    getAttribute(name) { return name === 'title' ? frameMeta : null; },
    getClientRects() { return zeroSize ? [] : [{}]; },
    getBoundingClientRect() { return zeroSize ? { width: 0, height: 0 } : { width: 640, height: 480 }; },
  };
  Object.defineProperty(frame, 'contentDocument', {
    get() {
      if (unreadable) throw new Error('cross-origin frame');
      return childDocument;
    },
  });
  const document = {
    documentElement: {},
    defaultView: { innerWidth: 1280, innerHeight: 720 },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '*' ? [frame] : []; },
  };
  frame.ownerDocument = document;
  return new Function('document', POST_SCREENSHOT_SAFETY_EXTRACTOR)(document);
}

test('live safety traverses same-origin iframes and fails closed for visible unreadable frames', async () => {
  for (const authSelector of ['input[type=password]', '#auth-mfa-otpcode']) {
    const auth = iframeLiveSafetyProbe({ authSelector });
    assert.equal(auth.looksLikeLogin, true, authSelector);
    assert.equal(auth.traversalComplete, true, authSelector);
    assert.equal(auth.visibleFrameCount, 1, authSelector);
    assert.equal(auth.unreadableVisibleFrameCount, 0, authSelector);
  }

  const unreadable = iframeLiveSafetyProbe({ unreadable: true });
  assert.equal(unreadable.looksLikeLogin, false);
  assert.equal(unreadable.traversalComplete, false);
  assert.equal(unreadable.visibleFrameCount, 1);
  assert.equal(unreadable.unreadableVisibleFrameCount, 1);
  assert.equal(unreadable.traversalErrorCount, 1);
  assert.equal(iframeLiveSafetyProbe({ unreadable: true, frameMeta: 'author recommendations' }).opaqueAuthHintCount, 0);
  assert.equal(iframeLiveSafetyProbe({ unreadable: true, frameMeta: 'Amazon login' }).opaqueAuthHintCount, 1);
  const url = 'https://sellercentral.amazon.com/performance/dashboard';
  const incompleteSafety = await classifyLivePageSafety({
    storeId: 'opaque',
    zn: {
      async currentUrl() { return url; },
      async execExtract() { return { result: unreadable }; },
    },
  });
  assert.equal(incompleteSafety.safe, false);
  assert.equal(incompleteSafety.code, 'LIVE_SAFETY_PROBE_INCOMPLETE');
  assert.equal(incompleteSafety.liveProbeDiagnostics.visibleFrameCount, 1);
  assert.equal(incompleteSafety.liveProbeDiagnostics.unreadableVisibleFrameCount, 1);
  assert.equal(incompleteSafety.liveProbeDiagnostics.traversalErrorCount, 1);

  const productUrl = 'https://www.amazon.com/dp/B012345678?variant=PRIVATE#details';
  const isolatedProductRead = await classifyAsinProductReadSafety({
    storeId: 'opaque',
    expectedAsin: 'B012345678',
    zn: {
      securityCapabilities: { officialZiniaoWebDriverHttp: true, mainDocumentTextOnly: true },
      async currentUrl() { return productUrl; },
      async execExtract() { return { result: unreadable }; },
    },
  });
  assert.equal(isolatedProductRead.safe, true);
  assert.equal(isolatedProductRead.code, 'ASIN_MAIN_DOCUMENT_READABLE_WITH_OPAQUE_FRAMES');
  assert.equal(isolatedProductRead.isolatedUnreadableFrames, true);
  assert.equal(isolatedProductRead.currentUrl, 'https://www.amazon.com/dp/B012345678');

  const sellerCentralRead = await classifyAsinProductReadSafety({
    storeId: 'opaque',
    expectedAsin: 'B012345678',
    zn: {
      securityCapabilities: { officialZiniaoWebDriverHttp: true, mainDocumentTextOnly: true },
      async currentUrl() { return url; },
      async execExtract() { return { result: unreadable }; },
    },
  });
  assert.equal(sellerCentralRead.safe, false);
  assert.equal(sellerCentralRead.code, 'ASIN_URL_IDENTITY_MISMATCH');

  const strictProductCapture = await classifyLivePageSafety({
    storeId: 'opaque',
    zn: {
      async currentUrl() { return productUrl; },
      async execExtract() { return { result: unreadable }; },
    },
  });
  assert.equal(strictProductCapture.safe, false);
  assert.equal(strictProductCapture.code, 'LIVE_SAFETY_PROBE_INCOMPLETE');

  const legacyProductRead = await classifyAsinProductReadSafety({
    storeId: 'opaque', expectedAsin: 'B012345678',
    zn: {
      async currentUrl() { return productUrl; },
      async execExtract() { return { result: unreadable }; },
    },
  });
  assert.equal(legacyProductRead.safe, false);
  assert.equal(legacyProductRead.code, 'LIVE_SAFETY_PROBE_INCOMPLETE');

  for (const mismatchUrl of [
    'https://www.amazon.com/dp/B099999999',
    'https://sellercentral.amazon.com/dp/B012345678',
    'https://widgets.amazon.com/dp/B012345678',
  ]) {
    let probeCalls = 0;
    const mismatch = await classifyAsinProductReadSafety({
      storeId: 'opaque', expectedAsin: 'B012345678',
      zn: {
        securityCapabilities: { officialZiniaoWebDriverHttp: true, mainDocumentTextOnly: true },
        async currentUrl() { return mismatchUrl; },
        async execExtract() { probeCalls++; return { result: unreadable }; },
      },
    });
    assert.equal(mismatch.safe, false, mismatchUrl);
    assert.equal(mismatch.code, 'ASIN_URL_IDENTITY_MISMATCH', mismatchUrl);
    assert.equal(probeCalls, 0, mismatchUrl);
  }

  for (const stillIncomplete of [
    { ...unreadable, traversalErrorCount: 2 },
    { ...unreadable, elementBudgetExceeded: true },
    { ...unreadable, opaqueOverlayFrameCount: 1 },
    { ...unreadable, opaqueAuthHintCount: 1 },
    { ...unreadable, opaqueBlockedHintCount: 1 },
    { ...unreadable, unreadableVisibleFrameCount: 9, unreadableFrameErrorCount: 9, traversalErrorCount: 9 },
    { ...unreadable, discoveredRootCount: undefined, scannedRootCount: undefined },
  ]) {
    const safety = await classifyAsinProductReadSafety({
      storeId: 'opaque',
      expectedAsin: 'B012345678',
      zn: {
        securityCapabilities: { officialZiniaoWebDriverHttp: true, mainDocumentTextOnly: true },
        async currentUrl() { return productUrl; },
        async execExtract() { return { result: stillIncomplete }; },
      },
    });
    assert.equal(safety.safe, false);
    assert.equal(safety.code, 'LIVE_SAFETY_PROBE_INCOMPLETE');
  }

  const productAuth = await classifyAsinProductReadSafety({
    storeId: 'opaque',
    expectedAsin: 'B012345678',
    zn: {
      securityCapabilities: { officialZiniaoWebDriverHttp: true, mainDocumentTextOnly: true },
      async currentUrl() { return productUrl; },
      async execExtract() { return { result: { ...unreadable, looksLikeLogin: true } }; },
    },
  });
  assert.equal(productAuth.safe, false);
  assert.equal(productAuth.code, 'AUTH_SENSITIVE');

  for (const hiddenFrame of [
    iframeLiveSafetyProbe({ unreadable: true, hidden: true }),
    iframeLiveSafetyProbe({ unreadable: true, zeroSize: true }),
  ]) {
    assert.equal(hiddenFrame.looksLikeLogin, false);
    assert.equal(hiddenFrame.traversalComplete, true);
    assert.equal(hiddenFrame.visibleFrameCount, 0);
    assert.equal(hiddenFrame.unreadableVisibleFrameCount, 0);
  }
});

test('VOC new-tab probe failure retains lifecycle context so release closes the tab', async () => {
  const asin = 'B012345678';
  const listUrl = 'https://sellercentral.amazon.com/voice-of-the-customer';
  let currentHandle = 'origin';
  let handles = ['origin'];
  let surfaceCalls = 0;
  const control = {
    async getText() { return 'View details'; }, async getAttribute() { return null; },
    async getTagName() { return 'button'; }, async isDisplayed() { return true; },
    async isEnabled() { return true; }, async click() { handles.push('detail'); },
  };
  const row = {
    async getText() { return `Widget ${asin}`; }, async isDisplayed() { return true; },
    async findElements(locator) { return String(locator?.value || '').startsWith('a,button') ? [control] : []; },
  };
  const driver = {
    async getCurrentUrl() { return currentHandle === 'detail' ? `${listUrl}?asin=${asin}` : listUrl; },
    async getWindowHandle() { return currentHandle; }, async getAllWindowHandles() { return [...handles]; },
    async findElements(locator) { return String(locator?.value || '').startsWith('tr,') ? [row] : []; },
    async executeScript(script) {
      if (!String(script).includes('amzguard-voc-detail-surface/v1')) throw new Error('unexpected script');
      surfaceCalls++;
      if (currentHandle === 'detail') throw new Error('detail probe exploded');
      return { probeVersion: 1, visibleDialogCount: 0, visibleDrawerCount: 0, inlineExpected: false, expectedInSurface: false };
    },
    switchTo() { return { window: async (handle) => { currentHandle = handle; } }; },
    async close() { handles = handles.filter((handle) => handle !== currentHandle); },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.execExtract = async () => ({ result: {
    probeVersion: 1, looksLikeLogin: false, looksBlocked: false, liveDocument: true, traversalComplete: true,
  } });
  await assert.rejects(transport.activateVocReadOnlyDetail('opaque', asin, { timeoutMs: 10 }), /probe exploded/);
  assert.ok(surfaceCalls >= 2);
  await transport.releaseVocReadOnlyDetail('opaque');
  assert.deepEqual(handles, ['origin']);
  assert.equal(currentHandle, 'origin');
});

test('DingTalk delivery is bound to the official robot endpoint while generic HTTPS stays available', async () => {
  assert.equal(isOfficialDingTalkWebhook('https://oapi.dingtalk.com/robot/send?access_token=DUMMY'), true);
  for (const endpoint of [
    'http://oapi.dingtalk.com/robot/send?access_token=DUMMY',
    'https://oapi.dingtalk.com.evil.example/robot/send?access_token=DUMMY',
    'https://oapi.dingtalk.com/robot/send/other?access_token=DUMMY',
    'https://user:password@oapi.dingtalk.com/robot/send?access_token=DUMMY',
    'https://oapi.dingtalk.com:8443/robot/send?access_token=DUMMY',
    'https://oapi.dingtalk.com/robot/send?access_token=DUMMY#fragment',
  ]) assert.equal(isOfficialDingTalkWebhook(endpoint), false);

  const originalFetch = globalThis.fetch;
  const requests = [];
  const logs = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, status: 200, async text() { return '{}'; } };
  };
  try {
    const marker = 'DUMMY_DESTINATION_TOKEN';
    const alerter = createAlerter({
      config: {
        outDir: os.tmpdir(), dashboard: { publicUrl: '' },
        alert: {
          console: false, file: false,
          dingtalk: { enabled: true, webhook: `https://example.test/robot/send?access_token=${marker}` },
          webhook: { enabled: true, url: 'https://generic.example.test/hook' },
        },
      },
      outDir: os.tmpdir(),
      logger: { info() {}, warn() {}, error(value) { logs.push(String(value)); } },
    });
    const record = await alerter.send({ severity: 'ERROR', title: 'test', lines: [] });
    assert.deepEqual(requests, ['https://generic.example.test/hook']);
    assert.equal(record.delivery['dingtalk:default'].errorClass, 'ConfigurationError');
    assert.equal(record.delivery.webhook, 'ok');
    assert.doesNotMatch(JSON.stringify({ record, logs }), new RegExp(marker));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebDriver debugging endpoint is loopback-only and rejected before Selenium connects', async () => {
  assert.deepEqual(parseLoopbackDebuggingEndpoint(9222), {
    host: '127.0.0.1', port: 9222, address: '127.0.0.1:9222',
  });
  assert.equal(parseLoopbackDebuggingEndpoint('localhost:9223')?.address, '127.0.0.1:9223');
  assert.equal(parseLoopbackDebuggingEndpoint('[::1]:9224')?.address, '[::1]:9224');
  assert.equal(parseLoopbackDebuggingEndpoint('127.0.0.2:9225')?.address, '127.0.0.2:9225');
  for (const endpoint of [
    '0.0.0.0:9222', '192.0.2.10:9222', 'debug.example.test:9222',
    'https://127.0.0.1:9222/path', '127.0.0.1:0', '127.0.0.1:70000',
    'user:password@127.0.0.1:9222',
  ]) assert.equal(parseLoopbackDebuggingEndpoint(endpoint), null);

  let driverCalls = 0;
  const actions = [];
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.config = {};
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.sessions = new Map();
  transport.ensureCore = async () => {};
  transport.storeList = async () => [{ id: 'browser-1', browserOauth: 'opaque', name: 'Safe Store', raw: {} }];
  transport.request = async (action) => {
    actions.push(action);
    if (action === 'startBrowser') return { statusCode: 0, debuggingPort: '192.0.2.10:9222' };
    return { statusCode: 0 };
  };
  transport.driverFactory = async () => { driverCalls++; return {}; };
  await assert.rejects(
    transport.storeOpen({ id: 'browser-1' }),
    /不是本机 loopback/,
  );
  assert.equal(driverCalls, 0);
  assert.deepEqual(actions, ['startBrowser', 'stopBrowser']);
});

test('WebDriver closes the native ZiNiao profile when Selenium attachment fails', async () => {
  const actions = [];
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.config = {};
  transport.timeoutMs = 120000;
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.sessions = new Map();
  transport.ensureCore = async () => {};
  transport.storeList = async () => [{
    id: 'browser-1', browserOauth: 'opaque', name: 'Safe Store', raw: {},
  }];
  transport.request = async (action) => {
    actions.push(action);
    if (action === 'startBrowser') return { statusCode: 0, debuggingPort: '127.0.0.1:9222', duplicate: 3 };
    return { statusCode: 0 };
  };
  transport.driverFactory = async () => { throw new Error('renderer attach failed'); };

  await assert.rejects(
    transport.storeOpen({ id: 'browser-1' }),
    /renderer attach failed/,
  );
  assert.deepEqual(actions, ['startBrowser', 'stopBrowser']);
  assert.equal(transport.sessions.size, 0);
});

test('WebDriver transactionally closes Selenium and ZiNiao when the first target visit fails', async () => {
  const actions = [];
  let quitCalls = 0;
  const driver = { async quit() { quitCalls++; } };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.config = { openLauncherPageBeforeTarget: false, autoLoginAmazon: false };
  transport.timeoutMs = 120000;
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.sessions = new Map();
  transport.ensureCore = async () => {};
  transport.storeList = async () => [{
    id: 'browser-1', browserOauth: 'opaque', name: 'Safe Store', raw: {},
  }];
  transport.request = async (action) => {
    actions.push(action);
    if (action === 'startBrowser') return { statusCode: 0, debuggingPort: '127.0.0.1:9222', duplicate: 2 };
    return { statusCode: 0 };
  };
  transport.driverFactory = async () => driver;
  transport.visit = async () => { throw new Error('initial navigation failed'); };

  await assert.rejects(
    transport.storeOpen({ id: 'browser-1', url: 'https://sellercentral.amazon.com/home' }),
    /initial navigation failed/,
  );
  assert.equal(quitCalls, 1);
  assert.deepEqual(actions, ['startBrowser', 'stopBrowser']);
  assert.equal(transport.sessions.size, 0);
});

test('WebDriver retains native cleanup metadata when stopBrowser fails and can retry it', async () => {
  let stopCalls = 0;
  let quitCalls = 0;
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque-store', {
    storeId: 'opaque-store', browserId: null, browserOauth: 'opaque-oauth', duplicate: 1,
    driver: { async quit() { quitCalls++; } },
  }]]);
  transport.request = async (action) => {
    assert.equal(action, 'stopBrowser');
    stopCalls++;
    if (stopCalls === 1) throw new Error('temporary stop failure');
    return { statusCode: 0 };
  };

  await assert.rejects(transport.storeClose('opaque-store'), /temporary stop failure/);
  assert.equal(transport.sessions.has('opaque-store'), true);
  const cleanup = await transport.closeAllSessions();
  assert.equal(cleanup.closed, true);
  assert.equal(transport.sessions.size, 0);
  assert.equal(stopCalls, 2);
  assert.equal(quitCalls, 2);
});

test('sanitizeForStorage redacts keys and normalizes artifact paths', () => {
  const rootDir = path.join(os.tmpdir(), 'amzguard-security-root');
  const safe = sanitizeForStorage({
    storeKey: 'S1',
    storeId: 'opaque-store-id',
    browserOauth: 'opaque-oauth',
    url: 'https://sellercentral.amazon.com/a?openid=SECRET#fragment',
    screenshot: path.join(rootDir, 'screenshots', 'evidence.png'),
    external: '/etc/passwd',
    nested: { password: 'do-not-retain', otp: '123456' },
  }, { rootDir });
  assert.equal(safe.storeKey, 'S1');
  assert.equal(safe.storeId, '[REDACTED]');
  assert.equal(safe.browserOauth, '[REDACTED]');
  assert.equal(safe.url, 'https://sellercentral.amazon.com/a');
  assert.equal(safe.screenshot, 'screenshots/evidence.png');
  assert.equal(safe.external, '[REDACTED_PATH]');
  assert.equal(safe.nested.password, '[REDACTED]');
  assert.equal(safe.nested.otp, '[REDACTED]');
});

test('redactText removes embedded auth values without damaging ordinary evidence', () => {
  const raw = 'Healthy 200; OTP: 123456; token=topsecret; '
    + 'url=https://example.com/a?access_token=SECRET#sso path=/Users/person/report.json';
  const safe = redactText(raw);
  assert.match(safe, /Healthy 200/);
  assert.doesNotMatch(safe, /123456|topsecret|SECRET|\/Users\/person/);
  assert.match(safe, /https:\/\/example\.com\/a/);
  assert.match(safe, /\[REDACTED_PATH\]/);
  const relative = redactText('redirect=/ap/mfa?openid=RELATIVE_SECRET&x=1 GET /x?code=CODE_SECRET&state=STATE_SECRET query auth=AUTH_SECRET');
  assert.doesNotMatch(relative, /RELATIVE_SECRET|CODE_SECRET|STATE_SECRET|AUTH_SECRET/);
  assert.match(relative, /redirect=(?:\/ap\/mfa|\[REDACTED_PATH\])/);
  assert.match(relative, /GET \/x\b/);
});

test('camelCase and nested Ziniao identifiers are redacted from storage and logs', () => {
  const secretA = 'OAUTH-VERY-SECRET';
  const secretB = 'STORE-VERY-SECRET';
  const safe = sanitizeForStorage({
    nested: {
      browserOauth: secretA,
      response: { openedStoreId: secretB, resolvedBrowserId: 'BROWSER-SECRET' },
    },
    storeKey: 'SAFE-ALIAS',
  });
  assert.equal(safe.nested.browserOauth, '[REDACTED]');
  assert.equal(safe.nested.response.openedStoreId, '[REDACTED]');
  assert.equal(safe.nested.response.resolvedBrowserId, '[REDACTED]');
  assert.equal(safe.storeKey, 'SAFE-ALIAS');
  const logged = redactText(`{"meta":{"browserOauth":"${secretA}","openedStoreId":"${secretB}"}} --store-id ${secretB}`);
  assert.doesNotMatch(logged, new RegExp(`${secretA}|${secretB}`));
});

test('page evidence fails closed for MFA, Chinese OTP and empty shells', () => {
  const fakeHealthy = { landed: true, hasPolicyComplianceText: true, status: 'HEALTHY' };
  const mfa = classifyPageSafety({
    currentUrl: 'https://www.amazon.com/ap/mfa?openid=SECRET',
    dom: fakeHealthy,
    txt: fakeHealthy,
    pageText: 'Policy Compliance Healthy',
  });
  assert.equal(mfa.safe, false);
  assert.equal(mfa.authSensitive, true);
  const chineseOtp = classifyPageSafety({
    currentUrl: 'https://sellercentral.amazon.com/performance/dashboard',
    dom: fakeHealthy,
    txt: fakeHealthy,
    pageText: '请输入验证码 123456，然后使用通行密钥登录',
  });
  assert.equal(chineseOtp.safe, false);
  assert.equal(chineseOtp.authSensitive, true);
  const shell = classifyPageSafety({
    currentUrl: 'https://sellercentral.amazon.com/performance/dashboard',
    dom: { landed: false },
    txt: null,
    pageText: '',
  });
  assert.equal(shell.safe, false);
  assert.equal(shell.emptyShell, true);
  const missingProduct = classifyPageSafety({
    currentUrl: 'https://www.amazon.com/dp/B012345678',
    dom: { dogPage: true }, txt: null, pageText: '',
  });
  assert.equal(missingProduct.safe, true);
  assert.equal(missingProduct.code, 'BUSINESS_PAGE');
  const missingUrl = classifyUrlSafety('');
  assert.equal(missingUrl.code, 'CURRENT_URL_UNAVAILABLE');
  assert.equal(isRecoverableBrowserInternalSafety(missingUrl), true);
  assert.equal(
    isRecoverableBrowserInternalSafety(classifyUrlSafety('chrome-extension://abcdefghijklmnop/error.html')),
    true,
  );
  assert.equal(
    isRecoverableBrowserInternalSafety(classifyUrlSafety('https://example.invalid/not-amazon')),
    false,
  );
});

function probeSafetyConfig(outDir, screenshot) {
  return {
    outDir,
    ziniao: {
      openTimeoutMs: 1, visitTimeoutMs: 1, execTimeoutMs: 1,
      contentTimeoutMs: 1, settleMs: 0, waitUntil: 'load',
    },
    storeHealth: {
      defaultHost: 'sellercentral.amazon.com',
      paths: ['/performance/dashboard'],
      screenshot,
    },
  };
}

const SAFE_LIVE_PROBE = Object.freeze({
  probeVersion: 1,
  looksLikeLogin: false,
  looksBlocked: false,
  liveDocument: true,
  traversalComplete: true,
});

function shadowPasskeyProbe() {
  const passkey = {
    innerText: 'Use a passkey to sign in',
    textContent: 'Use a passkey to sign in',
    getAttribute() { return null; },
  };
  const shadow = {
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '*') return [passkey];
      return selector.includes('kat-button') ? [passkey] : [];
    },
  };
  const document = {
    documentElement: {},
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '*' ? [{ shadowRoot: shadow }] : []; },
  };
  return new Function('document', POST_SCREENSHOT_SAFETY_EXTRACTOR)(document);
}

function probeDomResult() {
  return {
    landed: true,
    hasPolicyComplianceText: true,
    status: 'HEALTHY',
    score: 250,
    cardFound: true,
    statusSource: 'test',
  };
}

function webdriverProbeMock({ currentUrl, safetyAt = () => SAFE_LIVE_PROBE, onScreenshot } = {}) {
  const counts = { safety: 0, extractor: 0, content: 0, screenshot: 0 };
  const readUrl = () => (typeof currentUrl === 'function' ? currentUrl() : currentUrl);
  return {
    counts,
    zn: {
      baseUrl: 'http://127.0.0.1:18888',
      async ping() { return true; },
      async storeOpen() { return { storeId: 'WEBDRIVER-PROBE-OPAQUE' }; },
      async visit() { return { url: readUrl() }; },
      async currentUrl() { return readUrl(); },
      async execScript() { return 2; },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          counts.safety++;
          return { result: safetyAt(counts.safety) };
        }
        counts.extractor++;
        return { via: 'mock', result: probeDomResult() };
      },
      async content() {
        counts.content++;
        return { text: 'Policy Compliance Healthy' };
      },
      async screenshot(_storeId, file) {
        counts.screenshot++;
        fs.writeFileSync(file, 'mock screenshot');
        onScreenshot?.();
        return { path: file };
      },
      async storeClose() { return true; },
    },
  };
}

function legacyProbeMock({ currentUrl, safetyAt = () => SAFE_LIVE_PROBE, onScreenshot } = {}) {
  const counts = { safety: 0, extractor: 0, rawContent: 0, content: 0, screenshot: 0 };
  const readUrl = () => (typeof currentUrl === 'function' ? currentUrl() : currentUrl);
  return {
    counts,
    zn: {
      async cli(args) {
        const operation = args.slice(0, 2).join(' ');
        if (operation === 'store open' || operation === 'store resolve') {
          const stdout = JSON.stringify({ ok: true, data: { storeId: 'LEGACY-PROBE-OPAQUE' } });
          return { stdout, stderr: '', json: JSON.parse(stdout), data: { storeId: 'LEGACY-PROBE-OPAQUE' } };
        }
        if (operation === 'page content') {
          counts.rawContent++;
          return { stdout: 'Policy Compliance Healthy', stderr: '', json: null, data: null };
        }
        if (operation === 'page exec') return { stdout: '2', stderr: '', json: null, data: null };
        return { stdout: '{}', stderr: '', json: {}, data: {} };
      },
      async currentUrl() { return readUrl(); },
      async execExtract(_storeId, script) {
        if (script === POST_SCREENSHOT_SAFETY_EXTRACTOR) {
          counts.safety++;
          return { result: safetyAt(counts.safety) };
        }
        counts.extractor++;
        return { via: 'mock', result: probeDomResult() };
      },
      async content() {
        counts.content++;
        return { text: 'Policy Compliance Healthy' };
      },
      async screenshot(_storeId, file) {
        counts.screenshot++;
        fs.writeFileSync(file, 'mock screenshot');
        onScreenshot?.();
        return { path: file };
      },
    },
  };
}

const PROBE_STORE = Object.freeze({ key: 'SAFE-STORE', name: 'Safe Store', market: 'US' });
const QUIET_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

function assertNoProbeArtifacts(outDir) {
  const names = fs.readdirSync(path.join(outDir, 'probe'));
  assert.equal(names.some((name) => name.endsWith('.png') || name.startsWith('pagetext_')), false);
}

test('visible unreadable iframe appearing before capture blocks both probe screenshots', async () => {
  const incompleteFrameProbe = iframeLiveSafetyProbe({ unreadable: true });
  assert.equal(incompleteFrameProbe.traversalComplete, false);
  const rawUrl = 'https://sellercentral.amazon.com/performance/dashboard?stable=1#policy';

  const webdriverOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-iframe-wd-'));
  const webdriver = webdriverProbeMock({
    currentUrl: rawUrl,
    safetyAt: (call) => (call >= 5 ? incompleteFrameProbe : SAFE_LIVE_PROBE),
  });
  const wd = await runWebDriverProbe({
    zn: webdriver.zn,
    config: probeSafetyConfig(webdriverOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.equal(webdriver.counts.screenshot, 0);
  assert.equal(wd.report.findings.pageSafetyCode, 'LIVE_SAFETY_PROBE_INCOMPLETE');
  assert.equal(wd.report.findings.evidenceSuppressed, true);
  assertNoProbeArtifacts(webdriverOut);

  const legacyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-iframe-legacy-'));
  const legacy = legacyProbeMock({
    currentUrl: rawUrl,
    safetyAt: (call) => (call >= 7 ? incompleteFrameProbe : SAFE_LIVE_PROBE),
  });
  const old = await runProbe({
    zn: legacy.zn,
    config: probeSafetyConfig(legacyOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.equal(legacy.counts.screenshot, 0);
  assert.equal(old.report.findings.pageSafetyCode, 'LIVE_SAFETY_PROBE_INCOMPLETE');
  assert.equal(old.report.findings.evidenceSuppressed, true);
  assertNoProbeArtifacts(legacyOut);
});

test('both probes live-gate same-URL shadow Passkey before business reads when screenshots are disabled', async () => {
  const authProbe = shadowPasskeyProbe();
  const rawUrl = 'https://sellercentral.amazon.com/performance/dashboard?session=RAW_QUERY_SECRET#RAW_FRAGMENT_SECRET';

  const webdriverOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-live-wd-'));
  const webdriver = webdriverProbeMock({ currentUrl: rawUrl, safetyAt: () => authProbe });
  const wd = await runWebDriverProbe({
    zn: webdriver.zn,
    config: probeSafetyConfig(webdriverOut, false),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.deepEqual(
    { extractor: webdriver.counts.extractor, content: webdriver.counts.content, screenshot: webdriver.counts.screenshot },
    { extractor: 0, content: 0, screenshot: 0 },
  );
  assert.equal(wd.report.findings.evidenceSuppressed, true);
  assert.equal(wd.report.findings.pageSafetyCode, 'AUTH_SENSITIVE');
  assert.doesNotMatch(fs.readFileSync(wd.file, 'utf8'), /RAW_QUERY_SECRET|RAW_FRAGMENT_SECRET/);

  const legacyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-live-legacy-'));
  const legacy = legacyProbeMock({ currentUrl: rawUrl, safetyAt: () => authProbe });
  const old = await runProbe({
    zn: legacy.zn,
    config: probeSafetyConfig(legacyOut, false),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.deepEqual(
    {
      extractor: legacy.counts.extractor,
      rawContent: legacy.counts.rawContent,
      content: legacy.counts.content,
      screenshot: legacy.counts.screenshot,
    },
    { extractor: 0, rawContent: 0, content: 0, screenshot: 0 },
  );
  assert.equal(old.report.findings.evidenceSuppressed, true);
  assert.equal(old.report.findings.pageSafetyCode, 'AUTH_SENSITIVE');
  assert.doesNotMatch(fs.readFileSync(old.file, 'utf8'), /RAW_QUERY_SECRET|RAW_FRAGMENT_SECRET/);
});

test('both probes bind the initial URL gate to the first live gate using query and fragment identity', async () => {
  const beforeUrl = 'https://sellercentral.amazon.com/performance/dashboard?gate=INITIAL_SECRET#initial';
  const afterUrl = 'https://sellercentral.amazon.com/performance/dashboard?gate=LIVE_SECRET#live';

  let webdriverUrlReads = 0;
  const webdriverOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-identity-wd-'));
  const webdriver = webdriverProbeMock({
    currentUrl: () => (++webdriverUrlReads <= 2 ? beforeUrl : afterUrl),
  });
  const wd = await runWebDriverProbe({
    zn: webdriver.zn,
    config: probeSafetyConfig(webdriverOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.deepEqual(
    { extractor: webdriver.counts.extractor, content: webdriver.counts.content, screenshot: webdriver.counts.screenshot },
    { extractor: 0, content: 0, screenshot: 0 },
  );
  assert.equal(wd.report.findings.pageSafetyCode, 'PAGE_CHANGED_BEFORE_EVIDENCE_READ');
  assert.equal(wd.report.findings.evidenceSuppressed, true);
  assert.doesNotMatch(fs.readFileSync(wd.file, 'utf8'), /INITIAL_SECRET|LIVE_SECRET/);

  let legacyUrlReads = 0;
  const legacyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-identity-legacy-'));
  const legacy = legacyProbeMock({
    currentUrl: () => (++legacyUrlReads === 1 ? beforeUrl : afterUrl),
  });
  const old = await runProbe({
    zn: legacy.zn,
    config: probeSafetyConfig(legacyOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.deepEqual(
    {
      extractor: legacy.counts.extractor,
      rawContent: legacy.counts.rawContent,
      content: legacy.counts.content,
      screenshot: legacy.counts.screenshot,
    },
    { extractor: 0, rawContent: 0, content: 0, screenshot: 0 },
  );
  assert.equal(old.report.findings.pageSafetyCode, 'PAGE_CHANGED_BEFORE_EVIDENCE_READ');
  assert.equal(old.report.findings.evidenceSuppressed, true);
  assert.doesNotMatch(fs.readFileSync(old.file, 'utf8'), /INITIAL_SECRET|LIVE_SECRET/);
});

test('both probes repeat the live gate immediately before screenshot and suppress a same-URL auth overlay', async () => {
  const authProbe = shadowPasskeyProbe();
  const rawUrl = 'https://sellercentral.amazon.com/performance/dashboard?stable=1#evidence';

  const webdriverOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-preshot-wd-'));
  const webdriver = webdriverProbeMock({
    currentUrl: rawUrl,
    safetyAt: (call) => (call >= 5 ? authProbe : SAFE_LIVE_PROBE),
  });
  const wd = await runWebDriverProbe({
    zn: webdriver.zn,
    config: probeSafetyConfig(webdriverOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.equal(webdriver.counts.screenshot, 0);
  assert.equal(wd.report.findings.pageSafetyCode, 'AUTH_SENSITIVE');
  assert.equal(wd.report.findings.evidenceSuppressed, true);
  assertNoProbeArtifacts(webdriverOut);

  const legacyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-preshot-legacy-'));
  const legacy = legacyProbeMock({
    currentUrl: rawUrl,
    safetyAt: (call) => (call >= 7 ? authProbe : SAFE_LIVE_PROBE),
  });
  const old = await runProbe({
    zn: legacy.zn,
    config: probeSafetyConfig(legacyOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.equal(legacy.counts.screenshot, 0);
  assert.equal(old.report.findings.pageSafetyCode, 'AUTH_SENSITIVE');
  assert.equal(old.report.findings.evidenceSuppressed, true);
  assertNoProbeArtifacts(legacyOut);
});

test('both probes delete screenshot and prior evidence on query-or-fragment-only screenshot TOCTOU', async () => {
  const beforeUrl = 'https://sellercentral.amazon.com/performance/dashboard?view=BEFORE_SECRET#before';
  const afterUrl = 'https://sellercentral.amazon.com/performance/dashboard?view=AFTER_SECRET#after';

  let webdriverChanged = false;
  const webdriverOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-toctou-wd-'));
  const webdriver = webdriverProbeMock({
    currentUrl: () => (webdriverChanged ? afterUrl : beforeUrl),
    onScreenshot: () => { webdriverChanged = true; },
  });
  const wd = await runWebDriverProbe({
    zn: webdriver.zn,
    config: probeSafetyConfig(webdriverOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.equal(webdriver.counts.screenshot, 1);
  assert.equal(wd.report.findings.pageSafetyCode, 'PAGE_CHANGED_DURING_SCREENSHOT');
  assert.equal(wd.report.findings.evidenceSuppressed, true);
  assert.equal(wd.report.findings.extractorResult, undefined);
  assertNoProbeArtifacts(webdriverOut);
  assert.doesNotMatch(fs.readFileSync(wd.file, 'utf8'), /BEFORE_SECRET|AFTER_SECRET/);

  let legacyChanged = false;
  const legacyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-toctou-legacy-'));
  const legacy = legacyProbeMock({
    currentUrl: () => (legacyChanged ? afterUrl : beforeUrl),
    onScreenshot: () => { legacyChanged = true; },
  });
  const old = await runProbe({
    zn: legacy.zn,
    config: probeSafetyConfig(legacyOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.equal(legacy.counts.screenshot, 1);
  assert.equal(old.report.findings.pageSafetyCode, 'PAGE_CHANGED_DURING_SCREENSHOT');
  assert.equal(old.report.findings.evidenceSuppressed, true);
  assert.equal(old.report.findings.extractorResult, undefined);
  assertNoProbeArtifacts(legacyOut);
  assert.doesNotMatch(fs.readFileSync(old.file, 'utf8'), /BEFORE_SECRET|AFTER_SECRET/);
});

test('probe cleanup failures are explicit and never claim evidence suppression succeeded', async (t) => {
  t.mock.method(fs, 'unlinkSync', () => {
    const error = new Error('simulated unlink denial');
    error.code = 'EACCES';
    throw error;
  });
  const beforeUrl = 'https://sellercentral.amazon.com/performance/dashboard?cleanup=before#evidence';
  const afterUrl = 'https://sellercentral.amazon.com/performance/dashboard?cleanup=after#evidence';

  let webdriverChanged = false;
  const webdriverOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-cleanup-wd-'));
  const webdriver = webdriverProbeMock({
    currentUrl: () => (webdriverChanged ? afterUrl : beforeUrl),
    onScreenshot: () => { webdriverChanged = true; },
  });
  const wd = await runWebDriverProbe({
    zn: webdriver.zn,
    config: probeSafetyConfig(webdriverOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.equal(wd.report.findings.pageSafetyCode, 'SECURITY_CLEANUP_FAILED');
  assert.equal(wd.report.findings.securityCleanupFailed, true);
  assert.equal(wd.report.findings.evidenceSuppressed, false);
  assert.equal(wd.report.findings.screenshotWritten, false);

  let legacyChanged = false;
  const legacyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-cleanup-legacy-'));
  const legacy = legacyProbeMock({
    currentUrl: () => (legacyChanged ? afterUrl : beforeUrl),
    onScreenshot: () => { legacyChanged = true; },
  });
  const old = await runProbe({
    zn: legacy.zn,
    config: probeSafetyConfig(legacyOut, true),
    store: PROBE_STORE,
    logger: QUIET_LOGGER,
  });
  assert.equal(old.report.findings.pageSafetyCode, 'SECURITY_CLEANUP_FAILED');
  assert.equal(old.report.findings.securityCleanupFailed, true);
  assert.equal(old.report.findings.evidenceSuppressed, false);
  assert.equal(old.report.findings.screenshotWritten, false);
});

test('legacy screenshots accept only the exact controlled target and never copy untrusted temp paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-legacy-shot-'));
  const target = path.join(root, 'requested.png');
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-external-shot-'));
  const external = path.join(externalRoot, 'must-remain.txt');
  fs.writeFileSync(external, 'do not delete');
  const zn = new Ziniao({ logger: QUIET_LOGGER });
  zn.cli = async () => ({ data: { filePath: external }, stdout: '', stderr: '' });

  await assert.rejects(
    zn.screenshot('opaque', target),
    (error) => error?.code === 'SECURITY_CLEANUP_FAILED',
  );
  assert.equal(fs.readFileSync(external, 'utf8'), 'do not delete');
  assert.equal(fs.existsSync(target), false);

  const controlledTempTarget = path.join(root, 'controlled-temp-target.png');
  const controlledTemp = path.join(root, 'bridge-temp.png');
  zn.cli = async () => {
    fs.writeFileSync(controlledTemp, 'temporary screenshot');
    return { data: { filePath: controlledTemp }, stdout: '', stderr: '' };
  };
  const tempResult = await zn.screenshot('opaque', controlledTempTarget);
  assert.equal(tempResult.path, null);
  assert.equal(tempResult.temporaryArtifactRejected, true);
  assert.equal(tempResult.temporaryArtifactCleaned, true);
  assert.equal(fs.existsSync(controlledTemp), false);

  const base64Target = path.join(root, 'base64-must-not-be-written.png');
  zn.cli = async () => ({ data: { base64: Buffer.alloc(1024, 65).toString('base64') }, stdout: '', stderr: '' });
  const base64Result = await zn.screenshot('opaque', base64Target);
  assert.equal(base64Result.path, null);
  assert.equal(fs.existsSync(base64Target), false);

  const directTarget = path.join(root, 'direct.png');
  zn.cli = async (args) => {
    const requested = args[args.indexOf('--path') + 1];
    fs.writeFileSync(requested, 'direct screenshot');
    return { data: { filePath: requested }, stdout: '', stderr: '' };
  };
  const direct = await zn.screenshot('opaque', directTarget);
  assert.equal(direct.path, directTarget);
  assert.equal(fs.readFileSync(directTarget, 'utf8'), 'direct screenshot');
});

test('legacy screenshot rejects symlink targets without deleting the link or its external target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-legacy-link-'));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-legacy-link-external-'));
  const external = path.join(externalRoot, 'must-remain.txt');
  const target = path.join(root, 'requested.png');
  fs.writeFileSync(external, 'do not delete through symlink');
  fs.symlinkSync(external, target);
  let calls = 0;
  const zn = new Ziniao({ logger: QUIET_LOGGER });
  zn.cli = async () => { calls++; return { data: {}, stdout: '', stderr: '' }; };

  await assert.rejects(
    zn.screenshot('opaque', target),
    (error) => error?.code === 'SECURITY_CLEANUP_FAILED',
  );
  assert.equal(calls, 0);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(external, 'utf8'), 'do not delete through symlink');
});

test('both probe transports suppress all evidence on post-navigation MFA URL', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-probe-safety-'));
  const config = {
    outDir: temp,
    ziniao: { openTimeoutMs: 1, visitTimeoutMs: 1, execTimeoutMs: 1, contentTimeoutMs: 1, settleMs: 0, waitUntil: 'load' },
    storeHealth: { defaultHost: 'sellercentral.amazon.com', paths: ['/performance/dashboard'] },
  };
  const store = { key: 'SAFE-STORE', name: 'Safe Store', market: 'US' };
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  let webdriverReads = 0;
  const webdriver = {
    baseUrl: 'http://127.0.0.1:18888',
    async ping() { return true; },
    async storeOpen() { return { storeId: 'WEBDRIVER-STORE-SECRET' }; },
    async visit() { return { url: 'https://www.amazon.com/ap/mfa?openid=SECRET' }; },
    async currentUrl() { return 'https://www.amazon.com/ap/mfa?openid=SECRET'; },
    async execScript() { webdriverReads++; return 2; },
    async execExtract() { webdriverReads++; return { result: { landed: true } }; },
    async content() { webdriverReads++; return { text: '验证码 123456' }; },
    async screenshot() { webdriverReads++; return { path: null }; },
    async storeClose() { return true; },
  };
  const wd = await runWebDriverProbe({ zn: webdriver, config, store, logger: quiet });
  assert.equal(webdriverReads, 0);
  assert.equal(wd.report.findings.evidenceSuppressed, true);
  assert.doesNotMatch(fs.readFileSync(wd.file, 'utf8'), /WEBDRIVER-STORE-SECRET|123456|openid=SECRET/);

  let legacyReads = 0;
  const legacySecret = 'LEGACY-STORE-SECRET';
  const legacy = {
    async cli(args) {
      const operation = args.slice(0, 2).join(' ');
      if (operation === 'store open' || operation === 'store resolve') {
        const stdout = JSON.stringify({ ok: true, data: { storeId: legacySecret } });
        return { stdout, stderr: '', json: JSON.parse(stdout), data: { storeId: legacySecret } };
      }
      return { stdout: '{}', stderr: '', json: {}, data: {} };
    },
    async currentUrl() { return 'https://www.amazon.com/ap/mfa?openid=SECRET'; },
    async execExtract() { legacyReads++; return { result: { landed: true } }; },
    async content() { legacyReads++; return { text: '验证码 123456' }; },
    async screenshot() { legacyReads++; return { path: null }; },
  };
  const old = await runProbe({ zn: legacy, config, store, logger: quiet });
  assert.equal(legacyReads, 0);
  assert.equal(old.report.findings.evidenceSuppressed, true);
  assert.doesNotMatch(fs.readFileSync(old.file, 'utf8'), new RegExp(`${legacySecret}|123456|openid=SECRET`));
});

test('Inbox check stays list-only, keeps buyer content out of reports and out of CRM', () => {
  const definitions = fs.readFileSync(path.join(ROOT, 'src/checks/definitions.js'), 'utf8');
  const extractors = fs.readFileSync(path.join(ROOT, 'src/extractors/checks.js'), 'utf8');
  const crm = fs.readFileSync(path.join(ROOT, 'src/lib/crm.js'), 'utf8');

  // Opening a thread would mark the message read on Amazon: a write. The inbox
  // check is only allowed to read the listing.
  const inboxBlock = extractors.slice(extractors.indexOf("INBOX_EXTRACTOR = wrap('inbox/v1'"));
  assert.doesNotMatch(inboxBlock, /\.click\s*\(/);
  assert.doesNotMatch(inboxBlock, /\.submit\s*\(|dispatchEvent|requestSubmit/);
  assert.doesNotMatch(inboxBlock, /location\s*\.\s*(?:href|assign|replace)\s*=/);
  // List-only routes: the "needs reply" filter view and the inbox listings.
  // Nothing that opens a single conversation is allowed.
  assert.deepEqual(inboxCheck.paths, [
    '/messaging/inbox-v3?fi=responseNeeded',
    '/messaging/inbox-v3',
    '/messaging/inbox',
  ]);
  for (const route of inboxCheck.paths) {
    assert.doesNotMatch(route, /thread|conversation|messageid|reply/i);
  }

  // Buyer identity and message content must never reach reports or CRM, even
  // when the in-page extractor is later extended to expose more row fields.
  const verdict = inboxCheck.judge({
    dom: {
      landed: true, totalRows: 3, unreadCount: 1, markerVocabulary: true, paginationComplete: true,
      unreadRows: [{
        date: 'Sep 4, 2026', unread: true, needsResponse: false, identifier: '123-1234567-1234567',
        source: 'dom-unread-marker',
        buyer: 'Jane Buyer', subject: 'Where is my order?', body: 'Please refund me',
        email: 'jane@example.com',
      }],
    },
    txt: { landed: true, totalRows: 3, unreadCount: 1, declaredUnread: 1, markerVocabulary: true },
    store: { key: 'STORE-A', name: 'Store A' },
    config: { _now: new Date('2026-09-04T03:00:00Z') },
  });
  const persisted = JSON.stringify({ items: verdict.items, metrics: verdict.metrics, reasons: verdict.reasons });
  assert.doesNotMatch(persisted, /Jane Buyer|Where is my order|Please refund me|jane@example\.com/i);
  assert.deepEqual(
    Object.keys(verdict.items[0]).sort(),
    ['date', 'identifier', 'itemKey', 'needsResponse', 'source', 'storeKey', 'storeName', 'unread'],
  );
  assert.doesNotMatch(crm, /ENTITY_CHECKS = new Set\(\[[^\]]*inbox/);
});

test('all evidence runners use the shared post-navigation page safety gate', () => {
  for (const file of [
    'src/lib/check-runner.js',
    'src/checks/store-health.js',
    'src/checks/asin-health.js',
    'src/tools/probe.js',
    'src/tools/probe-webdriver.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /currentPageUrl/);
    assert.match(source, /classifyPageSafety|classifyUrlSafety/);
  }
  const cli = fs.readFileSync(path.join(ROOT, 'src/cli.js'), 'utf8');
  assert.doesNotMatch(cli, /\$\{f\.openedStoreId\}/);
  assert.doesNotMatch(cli, /String\(s\.id/);
});

test('config rejects channel webhooks, CRM auth and dashboard secrets', () => {
  const input = {
    alert: { dingtalk: { channels: [{ name: 'operations', webhook: 'secret-url', secret: 'secret' }] } },
    crm: { headers: { Authorization: 'Bearer private' } },
    dashboard: { sessionSecret: 'private' },
  };
  const hits = inlineSecretPaths(input);
  assert.deepEqual(hits, [
    'alert.dingtalk.channels.0.webhook',
    'alert.dingtalk.channels.0.secret',
    'crm.headers.Authorization',
    'dashboard.sessionSecret',
  ]);
  assert.throws(() => assertNoInlineSecrets(input), /禁止落盘/);
});

test('config rejects malformed CRM endpoints instead of retaining possible auth parameters', () => {
  const input = { crm: { endpoint: 'https://[invalid]/records?token=MALFORMED_URL_SECRET' } };
  assert.deepEqual(inlineSecretPaths(input), ['crm.endpoint']);
  assert.throws(() => assertNoInlineSecrets(input), /crm\.endpoint/);
});

test('DingTalk supports legacy regular env and OPS env', () => {
  const regular = loadDingTalkCredentials({
    env: { DINGTALK_WEBHOOK: 'regular-webhook', DINGTALK_SECRET: 'regular-secret' },
    platform: 'linux',
  });
  assert.deepEqual(regular.credentials, { webhook: 'regular-webhook', secret: 'regular-secret' });
  const operations = loadDingTalkCredentials({
    channel: 'operations',
    env: { DINGTALK_OPS_WEBHOOK: 'ops-webhook', DINGTALK_OPS_SECRET: 'ops-secret' },
    platform: 'linux',
  });
  assert.deepEqual(operations.credentials, { webhook: 'ops-webhook', secret: 'ops-secret' });
});

test('Keychain write receives encoded secret on stdin, never argv', () => {
  const calls = [];
  saveDingTalkCredentials({ webhook: 'https://example.invalid/?access_token=TOPSECRET', secret: 'SIGNSECRET' }, {
    channel: 'operations',
    platform: 'darwin',
    exec: (_file, args, options) => { calls.push({ args, options }); },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-i']);
  assert.doesNotMatch(calls[0].args.join(' '), /TOPSECRET|SIGNSECRET/);
  assert.doesNotMatch(calls[0].options.input, /TOPSECRET|SIGNSECRET/);
  assert.match(calls[0].options.input, /add-generic-password -U -s .* -a operations -X [0-9a-f]+/);
});

test('OTP readiness returns only a browser-computed boolean', async () => {
  let receivedScript = '';
  const otpElement = ({
    placeholder = false,
    placeholderShown = false,
    required = false,
    willValidate = true,
    validity = { valid: true, valueMissing: false },
    secretPresent = null,
    ariaInvalid = null,
    disabled = false,
  } = {}) => {
    let requiredState = required;
    let requiredAttribute = required;
    const element = {
      disabled,
      willValidate,
      hasAttribute(name) {
        if (name === 'placeholder') return placeholder;
        if (name === 'required') return requiredAttribute;
        return false;
      },
      removeAttribute(name) { if (name === 'required') requiredAttribute = false; },
      getAttribute(name) {
        if (name === 'value') throw new Error('OTP value attribute must never be read');
        return name === 'aria-invalid' ? ariaInvalid : null;
      },
      matches(selector) {
        if (selector === ':placeholder-shown') return placeholderShown;
        if (selector === ':required') return requiredState;
        if (selector === ':invalid') return this.validity?.valid === false;
        return false;
      },
    };
    Object.defineProperty(element, 'required', {
      get() { return requiredState; },
      set(next) { requiredState = next === true; },
    });
    Object.defineProperty(element, 'validity', {
      get() {
        if (secretPresent === null || !requiredState) return validity;
        return { valid: secretPresent, valueMissing: !secretPresent };
      },
    });
    Object.defineProperty(element, 'value', {
      get() { throw new Error('OTP value property must never be read'); },
    });
    return element;
  };
  const driver = {
    executeScript: async (script, element) => {
      receivedScript = script;
      return Function(script)(element);
    },
  };
  assert.equal(await otpInputIsReady(driver, otpElement({
    placeholder: true,
    placeholderShown: true,
    required: true,
    validity: { valid: false, valueMissing: true },
  })), false, 'empty OTP must remain not ready');
  assert.equal(await otpInputIsReady(driver, otpElement({
    placeholder: true,
    placeholderShown: false,
  })), true, 'a hidden placeholder is a browser-side non-empty signal');
  assert.equal(await otpInputIsReady(driver, otpElement({
    required: true,
    validity: { valid: true, valueMissing: false },
  })), true, 'required constraint state can prove non-empty without exposing the OTP');
  const filledUnconstrained = otpElement({ secretPresent: true });
  assert.equal(await otpInputIsReady(driver, filledUnconstrained), true,
    'a temporary native required constraint can prove an Amazon OTP is filled');
  assert.equal(filledUnconstrained.required, false, 'temporary required state must be restored');
  assert.equal(await otpInputIsReady(driver, otpElement({ secretPresent: false })), false,
    'a temporary native required constraint must reject an empty Amazon OTP');
  assert.equal(await otpInputIsReady(driver, otpElement({ willValidate: false })), false,
    'an input without usable native constraints or a placeholder signal must fail closed');
  assert.equal(await otpInputIsReady(driver, otpElement({
    placeholder: true,
    placeholderShown: false,
    ariaInvalid: 'true',
  })), false, 'aria-invalid must veto a nominally filled signal');
  assert.equal(await otpInputIsReady({ executeScript: async () => 1 }, otpElement()), false,
    'non-boolean WebDriver results must fail closed');

  assert.match(receivedScript, /:placeholder-shown/);
  assert.match(receivedScript, /valueMissing/);
  assert.match(receivedScript, /aria-invalid/);
  assert.doesNotMatch(receivedScript, /console|localStorage|sessionStorage/);
  const helperSource = otpInputIsReady.toString();
  for (const source of [receivedScript, helperSource]) {
    assert.doesNotMatch(source, /\.value\b/);
    assert.doesNotMatch(source, /getAttribute\s*\(\s*['"]value['"]/);
  }
});

test('ordinary Ziniao process preflight distinguishes WebDriver mode', () => {
  const bin = '/opt/ziniao/ziniaobrowser';
  assert.equal(hasOrdinaryZiniaoProcess(`${bin} --lang=zh`, bin), true);
  assert.equal(hasOrdinaryZiniaoProcess(`${bin} --run_type=web_driver --ipc_type=http`, bin), false);
});

test('Amazon account/login allowlists reject dangerous and unknown controls', () => {
  const forbidden = [
    'Save', 'Submit', 'Create', 'Delete', 'Enable', 'Pause', 'Unknown action',
    '保存', '提交', '创建', '删除', '启用', '暂停', '未知操作',
  ];
  for (const label of forbidden) {
    assert.equal(isApprovedAccountSwitcherExpander({
      label,
      ariaExpanded: 'false',
      ariaControls: 'marketplace-list',
      id: 'marketplace-switcher',
    }), false, `switcher must reject ${label}`);
    for (const kind of ['continue', 'passkey', 'sendOtp', 'acceptOtp', 'signIn', 'selectAccount']) {
      assert.equal(isApprovedAmazonLoginAction(kind, label), false, `${kind} must reject ${label}`);
    }
    assert.equal(isApprovedExistingAccountLink({
      label,
      href: 'https://www.amazon.com/ap/signin?openid.return_to=%2F',
    }), false, `account link must reject ${label}`);
  }

  assert.equal(isApprovedAccountSwitcherExpander({ label: 'Marketplace', ariaExpanded: 'false' }), true);
  assert.equal(isApprovedAccountSwitcherExpander({ label: 'Marketplace', ariaExpanded: 'true' }), false);
  assert.equal(isApprovedAmazonLoginAction('continue', 'Continue'), true);
  assert.equal(isApprovedAmazonLoginAction('passkey', 'Use a passkey to sign in'), true);
  assert.equal(isApprovedAmazonLoginAction('sendOtp', '发送一次性密码'), true);
  assert.equal(isApprovedAmazonLoginAction('acceptOtp', 'Accept verification code'), true);
  assert.equal(isApprovedAmazonLoginAction('acceptOtp', '获取验证码'), true);
  assert.equal(isApprovedAmazonLoginAction('signIn', 'Sign in'), true);
  assert.equal(isApprovedAmazonLoginAction('selectAccount', 'Select account'), true);
  assert.equal(isApprovedExistingAccountLink({
    label: 's***@example.com',
    href: 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fadvertising.amazon.com',
  }), true);
  assert.equal(isApprovedExistingAccountLink({
    label: 'Forgot password',
    href: 'https://www.amazon.com/ap/forgotpassword',
  }), false);
  assert.equal(isApprovedExistingAccountLink({
    label: 's***@example.com',
    href: 'http://www.amazon.com/ap/signin',
  }), false);
  assert.equal(isApprovedExistingAccountLink({
    label: 's***@example.com',
    href: 'https://user:secret@www.amazon.com/ap/signin',
  }), false);
  assert.equal(isApprovedExistingAccountLink({
    label: 's***@example.com',
    href: 'https://amazon.com.evil.example/ap/signin',
  }), false);
  assert.equal(isApprovedExistingAccountLink({
    label: 's***@example.com',
    href: 'https://www.amazon.com/ap/register',
  }), false);
});

test('Amazon account switcher never clicks dangerous or unknown buttons', async () => {
  let directClicks = 0;
  let nativeClicks = 0;
  const labels = ['Save', 'Submit', 'Create', 'Delete', 'Enable', 'Pause', 'Mystery'];
  const controls = labels.map((label) => ({
    async getText() { return label; },
    async getAttribute(name) {
      if (name === 'aria-expanded') return 'false';
      if (name === 'aria-controls') return 'marketplace-list';
      if (name === 'id') return 'marketplace-switcher';
      return null;
    },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() { directClicks++; },
  }));
  const driver = {
    async getCurrentUrl() { return 'https://sellercentral.amazon.com/account-switcher/select-account'; },
    async findElements(locator) {
      const selector = String(locator?.value || '');
      if (selector.includes('button') || selector.includes('[role="button"]')) return controls;
      return [];
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.clickNativeElement = async () => { nativeClicks++; };

  await assert.rejects(
    transport.selectAmazonAccount('opaque', 'US'),
    /未找到市场/,
  );
  assert.equal(directClicks, 0);
  assert.equal(nativeClicks, 0);
});

test('Amazon account switcher validates the final Seller Central URL before success', async () => {
  let nativeClicks = 0;
  const element = (label) => ({
    async getText() { return label; },
    async getAttribute() { return null; },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
  });
  const market = element('United States');
  const submit = element('Select account');
  const driver = {
    async getCurrentUrl() {
      return nativeClicks < 2
        ? 'https://sellercentral.amazon.com/account-switcher/select-account'
        : 'https://sellercentral.evil.example/home';
    },
    async findElements(locator) {
      const selector = String(locator?.value || '');
      if (selector.includes('confirm-selection')) return [submit];
      if (selector === 'button,kat-button,[role="button"]') return [market];
      return [];
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.clickNativeElement = async () => { nativeClicks++; };

  await assert.rejects(
    transport.selectAmazonAccount('opaque', 'US'),
    /未批准的非 Seller Central 页面/,
  );
  assert.equal(nativeClicks, 2);
});

test('Amazon Ads account selection never clicks help, recovery or unknown links', async () => {
  let clicks = 0;
  const links = [
    ['Forgot password', 'https://www.amazon.com/ap/forgotpassword'],
    ['Create account', 'https://www.amazon.com/ap/register'],
    ['Delete', 'https://www.amazon.com/ap/signin'],
    ['Unknown', 'https://www.amazon.com/ap/signin'],
  ].map(([label, href]) => ({
    async getText() { return label; },
    async getAttribute(name) { return name === 'href' ? href : null; },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() { clicks++; },
  }));
  const driver = {
    async getCurrentUrl() {
      return 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fadvertising.amazon.com';
    },
    async executeScript() { return 'Switch account'; },
    async findElements(locator) { return locator?.value === 'a' ? links : []; },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };

  await assert.rejects(
    transport.selectAdvertisingAccount('opaque', { timeoutMs: 3000 }),
    /没有可证明安全的已登录账户卡/,
  );
  assert.equal(clicks, 0);
});

test('Amazon Ads account selection waits for a delayed approved saved-account card', async () => {
  let linkScans = 0;
  let accountClicks = 0;
  let authenticated = false;
  const account = {
    async getText() { return 's***@example.com'; },
    async getAttribute(name) {
      return name === 'href'
        ? 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fadvertising.amazon.com%2Fcm%2Fcampaigns'
        : null;
    },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() {
      accountClicks++;
      authenticated = true;
    },
  };
  const driver = {
    async getCurrentUrl() {
      return authenticated
        ? 'https://advertising.amazon.com/cm/campaigns'
        : 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fadvertising.amazon.com';
    },
    async executeScript() { return 'Switch account'; },
    async findElements(locator) {
      if (locator?.value !== 'a') return [];
      linkScans++;
      return linkScans >= 3 ? [account] : [];
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };

  const result = await transport.selectAdvertisingAccount('opaque', { timeoutMs: 3000 });
  assert.equal(result, 'https://advertising.amazon.com/cm/campaigns');
  assert.equal(linkScans, 3);
  assert.equal(accountClicks, 1);
});

test('Seller login recovery uses one saved account, a Shadow DOM Passkey control and one OTP request', async () => {
  let phase = 'signin';
  let accountSelected = false;
  const clicks = { account: 0, passkey: 0, acceptOtp: 0, signIn: 0, nativePasskey: 0 };
  const element = (label, onClick, attrs = {}) => ({
    async getText() { return label; },
    async getAttribute(name) { return attrs[name] ?? null; },
    async isDisplayed() { return true; },
    async isEnabled() { return attrs.enabled !== false; },
    async click() { onClick?.(); },
  });
  const account = element('s***@example.com', () => {
    clicks.account++;
    accountSelected = true;
  }, {
    href: 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fsellercentral.amazon.com%2Fhome',
  });
  const passkey = element('Use a passkey to sign in', () => {
    clicks.passkey++;
    phase = 'mfa';
  });
  const acceptOtp = element('Accept verification code', () => { clicks.acceptOtp++; });
  const signIn = element('Sign in', () => {
    clicks.signIn++;
    phase = 'authenticated';
  });
  const otp = element('', null);
  const driver = {
    async getCurrentUrl() {
      if (phase === 'mfa') return 'https://sellercentral.amazon.com/ap/mfa';
      if (phase === 'authenticated') return 'https://sellercentral.amazon.com/home';
      return 'https://sellercentral.amazon.com/ap/signin';
    },
    async findElements(locator) {
      const selector = String(locator?.value || '');
      if (selector === 'a') return accountSelected ? [] : [account];
      if (selector === '#ap_email') return [];
      if (selector === 'button,a,[role="button"],input[type="submit"],kat-button') {
        if (phase === 'signin') return [];
        if (phase === 'mfa') return [acceptOtp];
        return [];
      }
      if (selector === '#auth-mfa-otpcode,input[autocomplete="one-time-code"]') return phase === 'mfa' ? [otp] : [];
      if (selector === '#auth-signin-button') return phase === 'mfa' ? [signIn] : [];
      return [];
    },
    async executeScript(script) {
      if (String(script).includes('amzguard-open-shadow-login-controls-v1')) {
        return phase === 'signin' ? [passkey] : [];
      }
      if (String(script).includes(':placeholder-shown')) return true;
      return null;
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.config = { amazonLoginTimeoutMs: 30000 };
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.clickNativePasskey = async () => { clicks.nativePasskey++; };

  assert.equal(await transport.restoreAmazonLogin('opaque'), true);
  assert.deepEqual(clicks, { account: 1, passkey: 1, acceptOtp: 1, signIn: 1, nativePasskey: 1 });
});

test('Seller login recovery waits for a delayed Ziniao OTP action and accepts extension auto-submit', async () => {
  let phase = 'signin';
  let controlPolls = 0;
  let acceptClicks = 0;
  let submitClicks = 0;
  const element = (label, onClick) => ({
    async getText() { return label; },
    async getAttribute() { return null; },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() { onClick?.(); },
  });
  const passkey = element('Use a passkey to sign in', () => { phase = 'mfa'; });
  const acceptOtp = element('Accept verification code', () => {
    acceptClicks++;
    phase = 'authenticated';
  });
  const driver = {
    async getCurrentUrl() {
      if (phase === 'mfa') return 'https://sellercentral.amazon.com/ap/mfa';
      if (phase === 'authenticated') return 'https://sellercentral.amazon.com/home';
      return 'https://sellercentral.amazon.com/ap/signin';
    },
    async findElements(locator) {
      const selector = String(locator?.value || '');
      if (selector === 'a' || selector === '#ap_email') return [];
      if (selector === 'button,a,[role="button"],input[type="submit"],kat-button') {
        if (phase !== 'mfa') return [];
        controlPolls++;
        return controlPolls >= 3 ? [acceptOtp] : [];
      }
      if (selector === '#auth-mfa-otpcode,input[autocomplete="one-time-code"]') return [];
      if (selector === '#auth-signin-button') {
        submitClicks++;
        return [];
      }
      return [];
    },
    async executeScript(script) {
      if (String(script).includes('amzguard-open-shadow-login-controls-v1')) {
        return phase === 'signin' ? [passkey] : [];
      }
      return null;
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.config = { amazonLoginTimeoutMs: 30000 };
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.clickNativePasskey = async () => {};
  transport.clickNativeElement = async (_session, target) => { await target.click(); };

  assert.equal(await transport.restoreAmazonLogin('opaque'), true);
  assert.equal(acceptClicks, 1);
  assert.equal(submitClicks, 0, 'extension auto-submit must not trigger a second sign-in click');
});

test('Seller login recovery retries one swallowed native send click on the same first MFA method', async () => {
  let phase = 'signin';
  let selected = -1;
  let continued = 0;
  let requested = 0;
  let signedIn = 0;
  const element = (label, onClick) => ({
    async getText() { return label; },
    async getAttribute() { return null; },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() { onClick?.(); },
  });
  const passkey = element('Use a passkey to sign in', () => { phase = 'mfa-choice'; });
  const radios = [0, 1, 2].map((index) => element('', () => { selected = index; }));
  const sendOtp = element('', () => {
    continued++;
    if (continued >= 2) phase = 'mfa-code';
  });
  const request = element('获取验证码', () => { requested++; });
  const otp = element('', null);
  const signIn = element('', () => { signedIn++; phase = 'authenticated'; });
  const driver = {
    async getCurrentUrl() {
      if (phase === 'authenticated') return 'https://sellercentral.amazon.com/home';
      if (phase.startsWith('mfa')) return 'https://sellercentral.amazon.com/ap/mfa';
      return 'https://sellercentral.amazon.com/ap/signin';
    },
    async findElements(locator) {
      const selector = String(locator?.value || '');
      if (selector === 'a' || selector === '#ap_email') return [];
      if (selector === 'input[type="radio"]') return phase === 'mfa-choice' ? radios : [];
      if (selector === 'button,a,[role="button"],input[type="submit"],kat-button') {
        if (phase === 'mfa-choice' && selected === 0) return [sendOtp];
        if (phase === 'mfa-code') return [request];
        return [];
      }
      if (selector === '#auth-mfa-otpcode,input[autocomplete="one-time-code"]') return phase === 'mfa-code' ? [otp] : [];
      if (selector === '#auth-signin-button') return phase === 'mfa-code' ? [signIn] : [];
      return [];
    },
    async executeScript(script, target) {
      if (String(script).includes('amzguard-open-shadow-login-controls-v1')) {
        return phase === 'signin' ? [passkey] : [];
      }
      if (String(script).includes('amzguard-amazon-button-wrapper-label-v1')) {
        if (target === sendOtp) return '发送一次性密码';
        if (target === signIn) return '登录';
        return '';
      }
      if (String(script).includes(':placeholder-shown')) return requested > 0;
      return null;
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.config = { amazonLoginTimeoutMs: 30000 };
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.clickNativePasskey = async () => {};
  transport.clickNativeElement = async (_session, target) => { await target.click(); };

  assert.equal(await transport.restoreAmazonLogin('opaque'), true);
  assert.equal(selected, 0);
  assert.equal(continued, 2);
  assert.equal(requested, 1);
  assert.equal(signedIn, 1);
});

test('Seller login recovery refuses an unexpected MFA method count without clicking', async () => {
  let clicks = 0;
  const radio = () => ({
    async isDisplayed() { return true; }, async isEnabled() { return true; },
    async click() { clicks++; },
  });
  const driver = {
    async getCurrentUrl() { return 'https://sellercentral.amazon.com/ap/mfa'; },
    async findElements(locator) {
      return String(locator?.value || '') === 'input[type="radio"]' ? [radio(), radio()] : [];
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.config = { amazonLoginTimeoutMs: 30000 };
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };

  await assert.rejects(transport.restoreAmazonLogin('opaque'), /实际 2 项/);
  assert.equal(clicks, 0);
});

test('Seller login recovery refuses ambiguous saved-account cards without clicking', async () => {
  let clicks = 0;
  const account = (label) => ({
    async getText() { return label; },
    async getAttribute(name) {
      return name === 'href'
        ? 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fsellercentral.amazon.com%2Fhome'
        : null;
    },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() { clicks++; },
  });
  const driver = {
    async getCurrentUrl() { return 'https://sellercentral.amazon.com/ap/signin'; },
    async findElements(locator) {
      return locator?.value === 'a' ? [account('a***@example.com'), account('b***@example.com')] : [];
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.config = {};
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.clickNativePasskey = async () => { clicks++; };

  await assert.rejects(
    transport.restoreAmazonLogin('opaque'),
    /多个已登录账户卡/,
  );
  assert.equal(clicks, 0);
});

test('Amazon Ads campaign-name scope writes and verifies one semantic search input only', async () => {
  let value = '';
  let sends = 0;
  let clicks = 0;
  let tableRevealCalls = 0;
  const input = {
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async getAttribute(name) {
      if (name === 'type') return 'search';
      if (name === 'value') return value;
      return null;
    },
    async sendKeys(...keys) {
      sends++;
      if (keys.includes('2.26')) value = '2.26';
    },
    async click() { clicks++; },
  };
  const driver = {
    async getCurrentUrl() { return 'https://advertising.amazon.com/campaign-manager/all-campaigns'; },
    async executeScript(script) {
      const source = String(script);
      if (source.includes('window.scrollTo')) { tableRevealCalls++; return true; }
      if (source.includes('if(tag==="input")out.push(e)')) return [input];
      if (source.includes('a.push(p.getAttribute("aria-label")')) return 'Search campaign name';
      if (source.includes('String(p.tagName||"").toLowerCase()==="tr"')) return true;
      return null;
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.currentUrl = async () => driver.getCurrentUrl();
  transport.execExtract = async () => ({ result: {
    probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
    traversalComplete: true, liveDocument: true,
  } });
  transport.dismissAdvertisingCoachmarks = async () => 0;
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };

  assert.deepEqual(
    await transport.selectAdvertisingCampaignNameFilter('opaque', '2.26', { timeoutMs: 3000 }),
    { keyword: '2.26', verified: true, changed: true },
  );
  assert.equal(sends, 2);
  assert.equal(clicks, 0);
  assert.equal(tableRevealCalls, 1);
  await assert.rejects(
    transport.selectAdvertisingCampaignNameFilter('opaque', 'in\nvalid', { timeoutMs: 3000 }),
    /1-40/,
  );
});

test('Amazon Ads status sweep clicks only the exact filter radio label, never a campaign switch', async () => {
  let selected = 'OTHER';
  let pending = null;
  let popoverOpen = false;
  let triggerClicks = 0;
  let filterClicks = 0;
  let applyClicks = 0;
  let campaignSwitchClicks = 0;
  const trigger = {
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() { triggerClicks++; popoverOpen = true; },
  };
  const radio = (state) => ({
    state,
    async getAttribute(name) {
      if (name === 'type') return 'radio';
      if (name === 'name') return 'globalBetaAllCampaigns:filter:state:option';
      if (name === 'value') return state;
      return null;
    },
    async isEnabled() { return true; },
  });
  const label = (state, text) => ({
    async getAttribute(name) {
      return name === 'for' ? `globalBetaAllCampaigns:filter:state:option-${state}` : null;
    },
    async getText() { return text; },
    async isDisplayed() { return popoverOpen; },
    async isEnabled() { return true; },
    async click() { filterClicks++; pending = state; },
  });
  const labels = [label('ENABLED', '已启用'), label('PAUSED', '已暂停')];
  const apply = {
    async getText() { return 'Apply filters'; },
    async getAttribute() { return null; },
    async isDisplayed() { return popoverOpen; },
    async isEnabled() { return true; },
    async click() { applyClicks++; selected = pending; popoverOpen = false; },
  };
  const campaignSwitch = { async click() { campaignSwitchClicks++; } };
  const driver = {
    async getCurrentUrl() { return 'https://advertising.amazon.com/campaign-manager/all-campaigns'; },
    async executeScript(script, arg) {
      const source = String(script);
      if (source.includes('return c&&c.querySelector')) return trigger;
      if (source.includes('var b=c&&c.querySelector')) {
        return selected === 'OTHER'
          ? '进行中 : 仅剩存档未完成'
          : `进行中 : ${selected === 'ENABLED' ? '已启用' : '已暂停'}`;
      }
      if (source.includes('String(i.type||"").toLowerCase()==="radio"')) {
        return popoverOpen && arg?.state === (pending || selected);
      }
      if (source.includes('p.contains(b)&&p.contains(c)')) return true;
      return null;
    },
    async findElements(locator) {
      if (locator?.value === 'label') return labels;
      if (String(locator?.value || '').includes('option-ENABLED')) return [radio('ENABLED')];
      if (String(locator?.value || '').includes('option-PAUSED')) return [radio('PAUSED')];
      if (locator?.value === 'button,[role="button"],kat-button,input[type="button"],input[type="submit"]') return [apply];
      if (String(locator?.value || '').includes('switch')) return [campaignSwitch];
      return [];
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.currentUrl = async () => driver.getCurrentUrl();
  transport.execExtract = async () => ({ result: {
    probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
    traversalComplete: true, liveDocument: true,
  } });
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.clickNativeElement = async (_session, target) => { await target.click(); };

  assert.deepEqual(
    await transport.selectAdvertisingCampaignState('opaque', 'PAUSED', { timeoutMs: 3000 }),
    { state: 'PAUSED', changed: true },
  );
  assert.equal(triggerClicks, 1);
  assert.equal(filterClicks, 1);
  assert.equal(applyClicks, 1);
  assert.equal(campaignSwitchClicks, 0);
  assert.doesNotMatch(ZiniaoWebDriver.prototype.selectAdvertisingCampaignState.toString(), /role=.switch|cell-state/);
});

test('Amazon Ads accepts one dynamic filterTag-state chip with Active status label', async () => {
  let dynamicChipReads = 0;
  const driver = {
    async getCurrentUrl() { return 'https://advertising.amazon.com/campaign-manager/all-campaigns'; },
    async findElements() { return []; },
    async executeScript(script) {
      const source = String(script);
      if (source.includes('scrollIntoView')) return 'header';
      if (source.includes('var b=c&&c.querySelector')) return '';
      if (source.includes(':filterTag-state$') && source.includes('return String(b.innerText')) {
        dynamicChipReads++;
        return 'Active status : Enabled';
      }
      return null;
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.currentUrl = async () => driver.getCurrentUrl();
  transport.execExtract = async () => ({ result: {
    probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
    traversalComplete: true, liveDocument: true,
  } });
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };

  assert.deepEqual(
    await transport.selectAdvertisingCampaignState('opaque', 'ENABLED', { timeoutMs: 3000 }),
    { state: 'ENABLED', changed: false },
  );
  assert.equal(dynamicChipReads, 1);
});

test('Amazon Ads new UI uses one semantic status-filter trigger and still never clicks a campaign switch', async () => {
  let selected = 'OTHER';
  let pending = null;
  let popoverOpen = false;
  let triggerClicks = 0;
  let filterClicks = 0;
  let applyClicks = 0;
  let campaignSwitchClicks = 0;
  let tableRevealCalls = 0;
  const semanticTrigger = {
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async getText() { return selected === 'OTHER' ? 'Status' : `Status: ${selected === 'ENABLED' ? 'Enabled' : 'Paused'}`; },
    async getAttribute(name) {
      return null;
    },
    async getTagName() { return 'a'; },
    async click() { triggerClicks++; popoverOpen = true; },
  };
  const campaignSwitch = {
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async getText() { return 'Status'; },
    async getAttribute(name) { return name === 'aria-checked' ? 'true' : null; },
    async click() { campaignSwitchClicks++; },
  };
  const radio = (state) => ({
    state,
    async getId() { return `radio-${state}`; },
    async getText() { return ''; },
    async getAttribute(name) {
      if (name === 'type') return 'radio';
      if (name === 'name') return 'dynamic-campaign-status-group';
      if (name === 'value') return state;
      return null;
    },
    async isDisplayed() { return popoverOpen; },
    async isEnabled() { return true; },
  });
  const label = (state, text, input) => ({
    state,
    input,
    async getAttribute(name) { return name === 'for' ? `dynamic-${state.toLowerCase()}-${state.length}` : null; },
    async getText() { return text; },
    async isDisplayed() { return popoverOpen; },
    async isEnabled() { return true; },
    async click() { filterClicks++; pending = state; },
  });
  const enabledRadio = radio('ENABLED');
  const pausedRadio = radio('PAUSED');
  const labels = [label('ENABLED', 'Enabled', enabledRadio), label('PAUSED', 'Paused', pausedRadio)];
  const apply = {
    async getText() { return 'Apply filters'; },
    async getAttribute() { return null; },
    async isDisplayed() { return popoverOpen; },
    async isEnabled() { return true; },
    async click() { applyClicks++; selected = pending; popoverOpen = false; },
  };
  const driver = {
    async getCurrentUrl() { return 'https://advertising.amazon.com/campaign-manager/all-campaigns'; },
    async executeScript(script, arg) {
      const source = String(script);
      if (source.includes('scrollIntoView')) { tableRevealCalls++; return 'header'; }
      if (source.includes('tag==="label"')) return popoverOpen
        ? [...labels, enabledRadio, pausedRadio] : [];
      if (source.includes('var roots=[document],seen=[],out=[]')) return [semanticTrigger, campaignSwitch];
      if (source.includes('return c&&c.querySelector')) return null;
      if (source.includes('var b=c&&c.querySelector')) return '';
      if (source.includes('getAttribute("href")')) return 'javascript:void(0);';
      if (source.includes('r==="row"')) return true;
      if (source.includes('var p=arguments[0],d=0')) return true;
      if (source.includes('var e=arguments[0],tag=')) return arg?.input || null;
      if (source.includes('function chain(e)')) return true;
      if (source.includes('String(i.type||"").toLowerCase()==="radio"')) {
        return popoverOpen && arg?.state === (pending || selected);
      }
      if (source.includes('p.contains(b)&&p.contains(c)')) return true;
      return null;
    },
    async findElements(locator) {
      if (locator?.value === 'button,[role="button"],kat-button,select,[role="combobox"],kat-select,kat-dropdown') return [semanticTrigger, campaignSwitch];
      if (locator?.value === 'label') return [];
      if (String(locator?.value || '').includes('option-ENABLED')) return [];
      if (String(locator?.value || '').includes('option-PAUSED')) return [];
      if (locator?.value === 'button,[role="button"],kat-button,input[type="button"],input[type="submit"]') return [apply];
      return [];
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.currentUrl = async () => driver.getCurrentUrl();
  transport.execExtract = async () => ({ result: {
    probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
    traversalComplete: true, liveDocument: true,
  } });
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };
  transport.clickNativeElement = async (_session, target) => { await target.click(); };

  assert.deepEqual(
    await transport.selectAdvertisingCampaignState('opaque', 'PAUSED', { timeoutMs: 3000 }),
    { state: 'PAUSED', changed: true },
  );
  assert.equal(triggerClicks, 1);
  assert.equal(filterClicks, 1);
  assert.equal(applyClicks, 1);
  assert.equal(campaignSwitchClicks, 0);
  assert.equal(tableRevealCalls, 1);
});

test('Amazon Ads coachmark cleanup clicks only a close control inside a known tutorial', async () => {
  let tutorialClicks = 0;
  let unrelatedClicks = 0;
  const control = (kind) => ({
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async getText() { return ''; },
    async getAttribute(name) { return name === 'aria-label' ? 'Close' : null; },
    async click() { if (kind === 'tutorial') tutorialClicks++; else unrelatedClicks++; },
    kind,
  });
  const tutorial = control('tutorial');
  const unrelated = control('unrelated');
  const driver = {
    async getCurrentUrl() { return 'https://advertising.amazon.com/campaign-manager/all-campaigns'; },
    async findElements(locator) {
      return locator?.value === 'button,[role="button"],kat-button' ? [tutorial, unrelated] : [];
    },
    async executeScript(script, element) {
      if (String(script).includes('p=e,d=0')) {
        return element?.kind === 'tutorial' ? 'Navigation is now collapsed' : '';
      }
      return null;
    },
  };
  const transport = Object.create(ZiniaoWebDriver.prototype);
  transport.sessions = new Map([['opaque', { driver, name: 'Safe Store' }]]);
  transport.currentUrl = async () => driver.getCurrentUrl();
  transport.execExtract = async () => ({ result: {
    probeVersion: 1, looksLikeLogin: false, looksBlocked: false,
    traversalComplete: true, liveDocument: true,
  } });
  transport.sleep = async () => {};
  transport.logger = { info() {}, warn() {}, error() {} };

  assert.equal(await transport.dismissAdvertisingCoachmarks('opaque'), 1);
  assert.equal(tutorialClicks, 1);
  assert.equal(unrelatedClicks, 0);
});

test('Amazon login helpers stop after a redirect to an unapproved hostname', async () => {
  let clicks = 0;
  const evilSellerDriver = {
    async getCurrentUrl() { return 'https://sellercentral.evil.example/account-switcher/select-account'; },
    async findElements() { throw new Error('unapproved page DOM must not be inspected'); },
  };
  const sellerTransport = Object.create(ZiniaoWebDriver.prototype);
  sellerTransport.config = {};
  sellerTransport.sessions = new Map([['opaque', { driver: evilSellerDriver, name: 'Safe Store' }]]);
  sellerTransport.sleep = async () => {};
  sellerTransport.logger = { info() {}, warn() {}, error() {} };
  sellerTransport.clickNativeElement = async () => { clicks++; };
  sellerTransport.clickNativePasskey = async () => { clicks++; };

  assert.equal(await sellerTransport.selectAmazonAccount('opaque', 'US'), false);
  assert.equal(await sellerTransport.restoreAmazonLogin('opaque'), false);
  assert.equal(clicks, 0);

  let urlReads = 0;
  let approvedAccountClicks = 0;
  let laterActionClicks = 0;
  const account = {
    async getText() { return 's***@example.com'; },
    async getAttribute(name) {
      return name === 'href'
        ? 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fadvertising.amazon.com'
        : null;
    },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() { approvedAccountClicks++; },
  };
  const unsafeAction = {
    async getText() { return 'Use a passkey to sign in'; },
    async getAttribute() { return null; },
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() { laterActionClicks++; },
  };
  const adsDriver = {
    async getCurrentUrl() {
      urlReads++;
      return urlReads <= 3
        ? 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fadvertising.amazon.com'
        : 'https://signin.evil.example/ap/signin';
    },
    async executeScript() { return 'Switch account'; },
    async findElements(locator) {
      if (locator?.value === 'a') return [account];
      return [unsafeAction];
    },
  };
  const adsTransport = Object.create(ZiniaoWebDriver.prototype);
  adsTransport.sessions = new Map([['opaque', { driver: adsDriver, name: 'Safe Store' }]]);
  adsTransport.sleep = async () => {};
  adsTransport.logger = { info() {}, warn() {}, error() {} };

  await assert.rejects(
    adsTransport.selectAdvertisingAccount('opaque', { timeoutMs: 3000 }),
    /未批准的非 Amazon 页面/,
  );
  assert.equal(approvedAccountClicks, 1);
  assert.equal(laterActionClicks, 0);
});

test('history sanitizer dry-run is non-mutating and apply preserves mtime', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-history-'));
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir);
  const report = path.join(outDir, 'report.json');
  const secret = 'UNIQUE_HISTORY_SECRET';
  fs.writeFileSync(report, JSON.stringify({
    url: `https://example.com/report?access_token=${secret}#sso`,
    storeId: secret,
    screenshot: path.join(outDir, 'shots', 'one.png'),
  }, null, 2));
  const old = new Date('2026-08-01T00:00:00.000Z');
  fs.utimesSync(report, old, old);
  const script = path.join(ROOT, 'scripts/sanitize-history.mjs');
  const dry = spawnSync(process.execPath, [script, '--dir', outDir], { encoding: 'utf8' });
  assert.equal(dry.status, 0);
  assert.doesNotMatch(`${dry.stdout}${dry.stderr}`, new RegExp(secret));
  assert.match(fs.readFileSync(report, 'utf8'), new RegExp(secret));
  const applied = spawnSync(process.execPath, [script, '--dir', outDir, '--apply'], { encoding: 'utf8' });
  assert.equal(applied.status, 0);
  assert.doesNotMatch(`${applied.stdout}${applied.stderr}`, new RegExp(secret));
  const safe = fs.readFileSync(report, 'utf8');
  assert.doesNotMatch(safe, new RegExp(secret));
  assert.match(safe, /https:\/\/example\.com\/report/);
  assert.match(safe, /shots\/one\.png/);
  assert.ok(Math.abs(fs.statSync(report).mtimeMs - old.getTime()) < 2);
});

test('history sanitizer refuses symlink and repository-wide targets before reading files', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-history-guard-'));
  const target = path.join(temp, 'out');
  const link = path.join(temp, 'out-link');
  fs.mkdirSync(target);
  const marker = path.join(target, 'marker.json');
  fs.writeFileSync(marker, '{"token":"must-survive"}\n');
  fs.symlinkSync(target, link);
  const script = path.join(ROOT, 'scripts/sanitize-history.mjs');

  const linked = spawnSync(process.execPath, [script, '--dir', link, '--apply'], { encoding: 'utf8' });
  assert.equal(linked.status, 2);
  assert.match(`${linked.stdout}${linked.stderr}`, /符号链接/);
  assert.equal(fs.readFileSync(marker, 'utf8'), '{"token":"must-survive"}\n');

  const broad = spawnSync(process.execPath, [script, '--dir', ROOT, '--apply'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(broad.status, 2);
  assert.match(`${broad.stdout}${broad.stderr}`, /过宽目录/);
});

test('demo seeder is disabled before config loading in production', () => {
  const script = path.join(ROOT, 'scripts/seed-demo.mjs');
  const result = spawnSync(process.execPath, [script, '--clear'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' },
  });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /生产环境禁止/);
});

test('only a positively observed empty live document is retryable; missing probes and authentication stay closed', async () => {
  const empty = { probeVersion: 2, looksLikeLogin: false, looksBlocked: false, liveDocument: false,
    traversalComplete: true, accessibleTraversalComplete: true, discoveredElementCount: 0,
    scannedElementCount: 0, candidateNodeCount: 0, traversalErrorCount: 0 };
  for (const [live, retry, auth] of [[empty, true, false], [null, false, false],
    [{ ...empty, looksLikeLogin: true }, false, true], [{ ...empty, looksBlocked: true }, false, true],
    [{ ...empty, traversalComplete: false }, false, false], [{ ...empty, scannedElementCount: 4 }, false, false],
    [{ ...empty, liveDocument: undefined }, false, false]]) {
    const safety = await classifyLivePageSafety({ zn: {
      async currentUrl() { return 'https://advertising.amazon.com/cm/portfolios/P1'; },
      async execExtract() { return { result: live }; },
    }, storeId: 'S1' });
    assert.equal(safety.safe, false);
    assert.equal(isTransientEmptyDocumentSafety(safety), retry);
    assert.equal(safety.authSensitive, auth);
  }
});
