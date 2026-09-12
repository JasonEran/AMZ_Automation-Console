// Tests the monitor's public bridge in an isolated browser. The tiny CRM below is
// a synthetic protocol peer, not CRM integration code or a production identity source.
// Run with Playwright available through NODE_PATH. No real service is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createCrmHttp } from '../../src/crm/http.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'amz-monitor-bridge-'));
const keyPath = path.join(work, 'fixture.key'), certPath = path.join(work, 'fixture.crt');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
const cert = fs.readFileSync(certPath), key = fs.readFileSync(keyPath);
const pubkey = execFileSync('openssl', ['x509', '-in', certPath, '-pubkey', '-noout']);
const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: pubkey });
const pin = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
const outDir = path.join(work, 'out'); fs.mkdirSync(path.join(outDir, 'reviews'), { recursive: true });
const reportFile = path.join(outDir, 'reviews', 'fixture.json');
fs.writeFileSync(reportFile, JSON.stringify({ check: 'reviews', runId: 'bridge-fixture',
  startedAt: new Date().toISOString(), results: ['US-A', 'US-B'].map(storeKey => ({ storeKey,
    status: 'LOW_REVIEW', severity: 'CRITICAL', checkedAt: new Date().toISOString(),
    items: [{ identifier: `${storeKey}-REVIEW`, stars: 1, title: 'Synthetic review' }] })) }));
const originalReport = fs.readFileSync(reportFile, 'utf8');
const apiToken = 'synthetic-monitor-bridge-test-only-000000000000';
let crmOrigin, monitorOrigin, monitor, browser, crm;
let signCalls = 0, lastTicket;
const errors = [], external = [], requests = [];
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
}
async function sign(fields) {
  signCalls++;
  return new Promise((resolve, reject) => {
    const req = https.request(`${monitorOrigin}/api/crm/v1/sso/tickets`, { method: 'POST', ca: cert,
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks));
        if (res.statusCode === 201) lastTicket = body.data.loginUrl.split('#ticket=')[1];
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject); req.end(JSON.stringify({ ...fields, subject: 'synthetic-fixture-user' }));
  });
}
const crmServer = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, crmOrigin).pathname;
    requests.push({ peer: 'crm', path: pathname, method: req.method });
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(`<!doctype html><html><body><button id="open">Open</button><p id="status">idle</p><script>
      window.fixtureReady=true; window.storeKey='US-A';
      const origin=${JSON.stringify(monitorOrigin)}; let popup,requestId,challengeId,accepted=false;
      document.getElementById('open').onclick=()=>{
        accepted=false; challengeId=null;
        requestId=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
        popup=window.open(origin+'/crm/sso/bridge?storeKey='+window.storeKey+'&view=data&checkId=reviews&requestId='+requestId,'_blank');
        document.getElementById('status').textContent='waiting';
      };
      window.addEventListener('message',async event=>{
        const data=event.data;
        if(event.source!==popup||event.origin!==origin||!data||data.version!==1||data.requestId!==requestId)return;
        if(data.type==='amzguard:crm:complete'&&data.challengeId===challengeId){document.getElementById('status').textContent='complete';return;}
        if(accepted||data.type!=='amzguard:crm:challenge'||data.storeKey!==window.storeKey||data.view!=='data'||data.checkId!=='reviews')return;
        accepted=true; challengeId=data.challengeId;
        const response=await fetch('/fixture-sign',{method:'POST',headers:{'Content-Type':'application/json',
          Authorization:'Bearer '+localStorage.getItem('token')},body:JSON.stringify({challengeId,storeKey:data.storeKey,view:data.view,checkId:data.checkId})});
        const body=await response.json();
        if(!response.ok){document.getElementById('status').textContent=String(response.status);popup.close();return;}
        popup.postMessage({type:'amzguard:crm:ticket',version:1,requestId,challengeId,loginUrl:body.data.loginUrl},origin);
      });</script></body></html>`); return;
    }
    if (req.method === 'POST' && pathname === '/fixture-sign') {
      if (req.headers.authorization !== 'Bearer fixture-user') { json(res, 401, {}); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; assert.ok(size <= 8192); chunks.push(chunk); }
      const fields = JSON.parse(Buffer.concat(chunks));
      if (fields.storeKey !== 'US-A') { json(res, 403, {}); return; }
      const result = await sign(fields); json(res, result.status, result.body); return;
    }
    json(res, 404, {});
  } catch (error) { errors.push(error.message); if (!res.headersSent) json(res, 500, {}); }
});
const monitorServer = https.createServer({ key, cert }, async (req, res) => {
  requests.push({ peer: 'monitor', path: new URL(req.url, monitorOrigin).pathname, method: req.method });
  try { if (!await monitor(req, res, new URL(req.url, monitorOrigin))) json(res, 404, {}); }
  catch (error) { errors.push(error.message); if (!res.headersSent) json(res, 500, {}); }
});
try {
  crmServer.listen(0, '127.0.0.1'); await once(crmServer, 'listening');
  crmOrigin = `http://crm.example.test:${crmServer.address().port}`;
  monitorServer.listen(0, '127.0.0.1'); await once(monitorServer, 'listening');
  monitorOrigin = `https://127.0.0.1:${monitorServer.address().port}`;
  monitor = createCrmHttp({ outDir, stores: [{ key: 'US-A' }, { key: 'US-B' }], staleAfterMs: 36 * 3600000,
    isSecureRequest: req => !!req.socket.encrypted, env: { AMZGUARD_CRM_CLIENT_ID: 'fixture',
      AMZGUARD_CRM_API_TOKEN: apiToken, AMZGUARD_CRM_STORE_KEYS: 'US-A,US-B',
      AMZGUARD_CRM_PUBLIC_ORIGIN: monitorOrigin, AMZGUARD_CRM_BRIDGE_ORIGIN: crmOrigin } });
  browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${pin}`,
    '--disable-background-networking', '--no-proxy-server'] });
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (![crmOrigin, monitorOrigin].includes(target.origin)) { external.push(route.request().url()); return route.abort(); }
    // Keep a non-localhost HTTP origin in the browser while routing only this
    // synthetic peer to loopback. This avoids OS DNS/proxy differences in CI.
    if (target.origin === crmOrigin) {
      const result = await new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: crmServer.address().port,
          path: target.pathname + target.search, method: route.request().method(),
          headers: route.request().headers() }, response => {
          const chunks = []; response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode,
            headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.on('error', reject); request.end(route.request().postDataBuffer());
      });
      return route.fulfill(result);
    }
    return route.continue();
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  crm = await context.newPage(); await crm.goto(crmOrigin);
  await crm.waitForFunction(() => window.fixtureReady, null, { timeout: 10000 });
  assert.equal(await crm.evaluate(() => window.isSecureContext), false);
  await crm.evaluate(() => localStorage.setItem('token', 'fixture-user'));
  const popupEvent = crm.waitForEvent('popup'); await crm.locator('#open').click(); const popup = await popupEvent;
  await popup.waitForURL(`${monitorOrigin}/crm/`, { timeout: 15000 });
  await crm.waitForFunction(() => document.getElementById('status').textContent === 'complete');
  assert.equal(await popup.evaluate(() => window.opener), null);
  const cookie = (await context.cookies(monitorOrigin)).find(row => row.name === '__Host-amzguard_crm');
  assert.ok(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Lax');
  const rows = await popup.evaluate(async () => (await fetch('/api/crm/v1/stores/US-A/checks/reviews/data?runId=bridge-fixture')).json());
  assert.deepEqual(rows.data.map(row => row.item.identifier), ['US-A-REVIEW']);
  assert.equal(await popup.evaluate(async () => (await fetch('/api/crm/v1/stores/US-B/results')).status), 404);
  assert.equal(await popup.evaluate(async ticket => (await fetch('/crm/sso/exchange', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) })).status, lastTicket), 401);
  await crm.evaluate(() => { window.storeKey = 'US-B'; }); await crm.locator('#open').click();
  await crm.waitForFunction(() => document.getElementById('status').textContent === '403');
  await crm.evaluate(() => { window.storeKey = 'US-A'; localStorage.setItem('token', 'synthetic-invalid-user'); });
  await crm.locator('#open').click(); await crm.waitForFunction(() => document.getElementById('status').textContent === '401');
  assert.equal(signCalls, 1); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.equal(fs.readFileSync(reportFile, 'utf8'), originalReport);
  console.log(JSON.stringify({ passed: true, chromium: browser.version(), openerSecureContext: false,
    flows: ['HTTP opener -> HTTPS bridge -> scoped session', 'store denied', 'user denied'],
    checks: ['Secure HttpOnly cookie', 'opener detached', 'saved data read', 'cross-store denied', 'replay denied'],
    externalBrowserRequests: 0, fixtureReportUnchanged: true }));
} catch (error) {
  console.error(JSON.stringify({ errors, external, requests, pageUrl: crm?.url(), pageText: await crm?.locator('body').innerText().catch(() => '') }));
  throw error;
} finally {
  await browser?.close();
  await Promise.all([new Promise(resolve => crmServer.close(resolve)), new Promise(resolve => monitorServer.close(resolve))]);
  fs.rmSync(work, { recursive: true, force: true });
}
