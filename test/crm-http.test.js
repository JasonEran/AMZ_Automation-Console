import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { CHECKS as CHECK_REGISTRY } from '../src/checks/registry.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://monitor.example.test';
const API = '/api/crm/v1';
const TOKEN = 'fixture-crm-token-distinct-from-dashboard-and-ingest';
const SESSION = '__Host-amzguard_crm';
const BINDING = '__Host-amzguard_crm_binding';
const PASSWORD = 'fixture-dashboard-password-123';
const CHECK_IDS = ['store-health', 'performance', 'feedback', 'reviews', 'asin-health', 'outlet', 'voc', 'ads-status', 'inbox'];
const PUBLIC_ROUTES = [
  ['GET', API], ['GET', `${API}/openapi.json`], ['GET', `${API}/stores`],
  ['GET', `${API}/stores/{storeKey}/results`],
  ['GET', `${API}/stores/{storeKey}/checks/{checkId}/runs`],
  ['GET', `${API}/stores/{storeKey}/checks/{checkId}/data`],
  ['GET', '/crm/sso/start'], ['GET', '/crm/sso/bridge'], ['POST', `${API}/sso/tickets`], ['GET', '/crm/sso'],
  ['POST', '/crm/sso/exchange'], ['POST', '/crm/logout'], ['GET', '/crm'], ['GET', '/crm/'], ['GET', '/crm/session'],
];
const STORE_ROWS = [
  { key: 'US-A', name: 'Fixture A', id: 'private-browser-a', market: 'US' },
  { key: 'US-B', name: 'Fixture B', id: 'private-browser-b', market: 'US' },
  { key: 'US-X', name: 'PRIVATE_UNAUTHORIZED_STORE', id: 'private-browser-x', market: 'US' },
];

async function availablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function pair(response, name) {
  const header = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  assert.ok(header, `${name} cookie expected`);
  return { header, cookie: header.split(';')[0] };
}

function secureCookie(header, name, maxAge) {
  assert.match(header, new RegExp(`^${name}=`));
  for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${maxAge}`]) {
    assert.ok(header.split('; ').includes(attribute), `missing cookie attribute ${attribute}`);
  }
  assert.doesNotMatch(header, /(?:^|;)\s*Domain=/i);
}

async function problem(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') || '', /^application\/problem\+json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const body = await response.json();
  assert.equal(body.status, status);
  if (code) assert.equal(body.code, code);
  assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert.equal(typeof body.title, 'string');
  assert.equal(typeof body.detail, 'string');
  return body;
}

async function fixture(t, { crm = true, controlled = false, crmOverrides = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-crm-http-'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(temp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}\n');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(temp, 'config'));
  fs.mkdirSync(path.join(temp, 'docs'));
  const schema = path.join(ROOT, 'docs', 'crm-openapi.json');
  if (fs.existsSync(schema)) fs.copyFileSync(schema, path.join(temp, 'docs', 'crm-openapi.json'));
  const storesFile = path.join(temp, 'config', 'stores.json');
  fs.writeFileSync(storesFile, JSON.stringify(STORE_ROWS));
  fs.writeFileSync(path.join(temp, 'config', 'config.json'), JSON.stringify({ paths: { outDir: 'out' } }));
  const out = path.join(temp, 'out');
  const at = new Date(Date.now() - 60_000).toISOString();
  const result = (storeKey, suffix) => ({ storeKey, market: 'US', status: 'LOW_REVIEW', severity: 'CRITICAL',
    ok: false, checkedAt: at, confidence: 'high', verdictSource: 'dom+text',
    metrics: { lowCount: 2, businessStatus: 'ANOMALY', collectionStatus: 'COMPLETE' },
    screenshot: '/private/PRIVATE_SCREENSHOT.png',
    evidence: { dom: { landed: true, raw: 'PRIVATE_DOM' }, text: { landed: true, raw: 'PRIVATE_TEXT' } },
    items: [{ identifier: `REVIEW-${suffix}-1`, date: '2026-08-01', stars: 1, title: `Store ${suffix} review one`, author: 'PRIVATE_BUYER' },
      { identifier: `REVIEW-${suffix}-2`, date: '2026-08-02', stars: 2, title: `Store ${suffix} review two` }] });
  fs.mkdirSync(path.join(out, 'reviews', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(out, 'reviews', 'fixture', 'saved-run.json'), JSON.stringify({
    check: 'reviews', runId: 'fixture-review-run', startedAt: at, finishedAt: at,
    results: [result('US-A', 'A'), result('US-B', 'B'), result('US-X', 'X')],
  }));

  // No inherited environment or real Keychain access. The stub is a second
  // guard in addition to complete synthetic channel and browser credentials.
  const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nprintf "attempt\\n" >> "$AMZGUARD_TEST_SECURITY_LOG"\nexit 1\n', { mode: 0o755 });
  const guard = path.join(temp, 'no-outbound.mjs');
  fs.writeFileSync(guard, `import fs from 'node:fs';
import http from 'node:http'; import https from 'node:https';
import net from 'node:net'; import tls from 'node:tls';
import {syncBuiltinESMExports} from 'node:module';
function blocked(){fs.appendFileSync(process.env.AMZGUARD_TEST_NETWORK_LOG,'attempt\\n');throw new Error('Offline fixture forbids outbound network');}
http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;
net.connect=blocked;net.createConnection=blocked;net.Socket.prototype.connect=blocked;tls.connect=blocked;globalThis.fetch=blocked;
syncBuiltinESMExports();\n`);
  const port = await availablePort();
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temp, TZ: 'UTC',
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: '1',
    DASHBOARD_USERNAME: 'test-admin', DASHBOARD_PASSWORD: PASSWORD,
    DASHBOARD_SESSION_SECRET: 'fixture-dashboard-secret-distinct-from-crm-123',
    INGEST_TOKEN: 'fixture-ingest-token-distinct-from-crm-123456',
    AMZGUARD_PRODUCT_UPLOAD_ENABLED: '0', AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED: '0',
    ZINIAO_COMPANY: 'fixture-company', ZINIAO_USERNAME: 'fixture-user', ZINIAO_PASSWORD: 'fixture-password',
    DINGTALK_WEBHOOK: 'https://notification.example.invalid/fixture', DINGTALK_SECRET: 'fixture-secret',
    DINGTALK_OPS_WEBHOOK: 'https://notification.example.invalid/fixture-ops', DINGTALK_OPS_SECRET: 'fixture-ops-secret',
    CRM_ENDPOINT: 'https://export.example.invalid/fixture', CRM_TOKEN: 'fixture-outbound-crm-token',
    ALERT_WEBHOOK_URL: 'https://notification.example.invalid/fixture-alert', ALERT_WEBHOOK_AUTHORIZATION: 'fixture-alert-token',
    AMZGUARD_TEST_SECURITY_LOG: path.join(temp, 'security-attempts'),
    AMZGUARD_TEST_NETWORK_LOG: path.join(temp, 'network-attempts'),
  };
  if (crm) Object.assign(env, {
    AMZGUARD_CRM_CLIENT_ID: 'fixture-crm', AMZGUARD_CRM_API_TOKEN: TOKEN,
    AMZGUARD_CRM_STORE_KEYS: 'US-A,US-B', AMZGUARD_CRM_PUBLIC_ORIGIN: ORIGIN,
    AMZGUARD_CRM_CALLBACK_URL: 'https://crm.example.test/monitor-entry',
  });
  Object.assign(env, crmOverrides);
  const clockFile = path.join(temp, 'clock.json'), crmEnvFile = path.join(temp, 'crm-env.json');
  const crmEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('AMZGUARD_CRM_')));
  fs.writeFileSync(clockFile, JSON.stringify(Date.now()));
  fs.writeFileSync(crmEnvFile, JSON.stringify(crmEnv));
  if (controlled) {
    // Real HTTP and the production handler run in the guarded child. Only the
    // handler's documented clock/env inputs are controlled; no production test
    // endpoints, clock hooks, credentials or configuration files are changed.
    fs.writeFileSync(path.join(temp, 'controlled-http.mjs'), `
import fs from 'node:fs'; import http from 'node:http';
import { createCrmHttp } from './src/crm/http.js';
const env = JSON.parse(fs.readFileSync('crm-env.json', 'utf8'));
const now = () => JSON.parse(fs.readFileSync('clock.json', 'utf8'));
const handler = createCrmHttp({ outDir: 'out', stores: () => JSON.parse(fs.readFileSync('config/stores.json', 'utf8')),
  staleAfterMs: 129600000, env, now, isSecureRequest: req => req.headers['x-forwarded-proto'] === 'https',
  clientIp: req => req.headers['x-forwarded-for'] || req.socket.remoteAddress });
http.createServer(async (req, res) => {
  if (req.url === '/api/health') { res.writeHead(200); res.end('{}'); return; }
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, JSON.parse(fs.readFileSync('crm-env.json', 'utf8')));
  if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
  }
  const child = spawn(process.execPath, ['--import', guard, controlled ? 'controlled-http.mjs' : 'src/server.js'], {
    cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-20000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-20000); });
  const exited = once(child, 'exit');
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref();
        try { await exited; } finally { clearTimeout(killTimer); }
      }
      assert.equal(fs.existsSync(env.AMZGUARD_TEST_SECURITY_LOG), false, 'fixture attempted Keychain access');
      assert.equal(fs.existsSync(env.AMZGUARD_TEST_NETWORK_LOG), false, 'fixture attempted outbound network');
      assert.equal(fs.existsSync(path.join(out, 'channels')), false, 'fixture emitted a notification/export');
      assert.equal(fs.existsSync(path.join(out, 'product-uploads')), false, 'fixture created an upload task');
      assert.equal(output.includes(TOKEN), false, 'fixture logged CRM credentials');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let index = 0; index < 100; index++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* startup only */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(ready, `isolated server did not start: ${output}`);
  const defaults = { Host: new URL(ORIGIN).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '192.0.2.10' };
  // Use node:http here: recent fetch implementations normalize Host back to
  // the loopback URL. This models Nginx's forwarded canonical Host exactly.
  const request = (url, options = {}) => new Promise((resolve, reject) => {
    const headers = { ...defaults, ...options.headers };
    let body = options.body;
    if (body instanceof URLSearchParams) {
      body = body.toString();
      headers['Content-Type'] ||= 'application/x-www-form-urlencoded';
    }
    if (body !== undefined && !headers['Transfer-Encoding']) headers['Content-Length'] = Buffer.byteLength(body);
    const outgoing = http.request(base + url, { method: options.method || 'GET', headers }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
      });
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Isolated HTTP request timed out')));
    outgoing.end(body);
  });
  const bearer = { Authorization: `Bearer ${TOKEN}` };
  const sameOrigin = { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  async function issue({ storeKey = 'US-A', view = 'data', checkId = 'reviews' } = {}) {
    const start = await request(`/crm/sso/start?${new URLSearchParams({ storeKey, view, checkId })}`);
    assert.equal(start.status, 303);
    const binding = pair(start, BINDING);
    const callback = new URL(start.headers.get('location'));
    const issued = await request(`${API}/sso/tickets`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: callback.searchParams.get('challengeId'), subject: 'fixture-subject', storeKey, view, checkId }) });
    assert.equal(issued.status, 201, await issued.clone().text());
    const body = await issued.json();
    const loginUrl = new URL(body.data.loginUrl);
    return { binding, callback, loginUrl, ticket: new URLSearchParams(loginUrl.hash.slice(1)).get('ticket') };
  }
  async function login(input) {
    const issued = await issue(input);
    const exchange = await request('/crm/sso/exchange', { method: 'POST', headers: { ...sameOrigin, Cookie: issued.binding.cookie },
      body: JSON.stringify({ ticket: issued.ticket }) });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    return { ...issued, session: pair(exchange, SESSION), exchange };
  }
  return { temp, storesFile, out, base, request, bearer, sameOrigin, issue, login, defaults,
    now: () => JSON.parse(fs.readFileSync(clockFile, 'utf8')),
    advance(ms) { assert.ok(controlled); fs.writeFileSync(clockFile, JSON.stringify(this.now() + ms)); },
    configureCrm(values) { assert.ok(controlled); fs.writeFileSync(crmEnvFile, JSON.stringify(values)); },
    crmEnv };
}

async function success(response, { read = false } = {}) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const body = await response.json();
  assert.equal(body.apiVersion, '1.0');
  assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
  assert.equal(Object.hasOwn(body, 'error'), false);
  if (read) {
    assert.equal(body.metadata.dataSource, 'saved-reports');
    assert.equal(body.metadata.readOnly, true);
    assert.equal(body.metadata.collectionTriggered, false);
    assert.equal(body.metadata.timezone, 'Asia/Shanghai');
  }
  return body;
}

function savedFiles(dir) {
  const files = {};
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files[path.relative(dir, file)] = {
        hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: fs.statSync(file).mtimeMs,
      };
    }
  };
  visit(dir); return files;
}

test('CRM HTTP machine reads enforce per-store results/data scope and safe projections', async t => {
  const f = await fixture(t);
  await problem(await f.request(`${API}/stores`), 401, 'CRM_SESSION_INVALID');
  const denied = await f.request(`${API}/stores`, { headers: { Authorization: 'Bearer incorrect' } });
  assert.match(denied.headers.get('www-authenticate'), /Bearer realm="amzguard-crm".*invalid_token/);
  await problem(denied, 401, 'CRM_AUTH_REQUIRED');
  const stores = await (await f.request(`${API}/stores`, { headers: f.bearer })).json();
  assert.deepEqual(stores.data.map(store => store.storeKey), ['US-A', 'US-B']);
  assert.doesNotMatch(JSON.stringify(stores), /PRIVATE_|private-browser|US-X/);
  const results = await (await f.request(`${API}/stores/US-A/results`, { headers: f.bearer })).json();
  assert.equal(results.data.checks.length, 9);
  assert.equal(results.metadata.collectionTriggered, false);
  assert.equal(results.data.checks.find(check => check.checkId === 'reviews').results.length, 1);
  assert.doesNotMatch(JSON.stringify(results), /PRIVATE_|REVIEW-B|REVIEW-X|US-B|US-X/);
  const runs = await (await f.request(`${API}/stores/US-A/checks/reviews/runs`, { headers: f.bearer })).json();
  assert.equal(runs.data[0].runId, 'fixture-review-run');
  assert.equal(runs.data[0].resultCount, 1);
  const data = await (await f.request(`${API}/stores/US-A/checks/reviews/data?runId=fixture-review-run&pageSize=1`, { headers: f.bearer })).json();
  assert.equal(data.pagination.total, 2);
  assert.equal(data.data[0].item.identifier, 'REVIEW-A-1');
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_|REVIEW-B|REVIEW-X|US-B|US-X/);
  const second = await (await f.request(`${API}/stores/US-A/checks/reviews/data?runId=fixture-review-run&pageSize=1&page=2&snapshotId=${data.metadata.snapshotId}`, { headers: f.bearer })).json();
  assert.equal(second.data[0].item.identifier, 'REVIEW-A-2');
  assert.equal(second.pagination.hasMore, false);
  await problem(await f.request(`${API}/stores/US-X/results`, { headers: f.bearer }), 404, 'NOT_FOUND');
  await problem(await f.request(`${API}/stores/us-a/results`, { headers: f.bearer }), 404, 'NOT_FOUND');
  await problem(await f.request(`${API}/stores/US-A/checks/reviews/data?runId=fixture-review-run&snapshotId=${'0'.repeat(64)}`, { headers: f.bearer }), 409, 'SNAPSHOT_CHANGED');
});

test('SSO HTTP flow binds the browser, clears fragments before fetch and uses exact CSP hashes', async t => {
  const f = await fixture(t);
  const issued = await f.issue();
  secureCookie(issued.binding.header, BINDING, 120);
  assert.equal(issued.callback.origin + issued.callback.pathname, 'https://crm.example.test/monitor-entry');
  assert.equal(issued.callback.searchParams.get('storeKey'), 'US-A');
  assert.equal(issued.callback.searchParams.get('view'), 'data');
  assert.equal(issued.callback.searchParams.get('checkId'), 'reviews');
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin,
    Cookie: `${BINDING}=${'x'.repeat(43)}` }, body: JSON.stringify({ ticket: issued.ticket }) }), 401, 'CRM_TICKET_INVALID');
  const response = await f.request('/crm/sso');
  const markup = await response.text();
  const scripts = [...markup.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp.includes(`script-src 'sha256-${crypto.createHash('sha256').update(scripts[0]).digest('base64')}'`));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  for (const style of markup.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    assert.ok(csp.includes(`style-src 'sha256-${crypto.createHash('sha256').update(style[1]).digest('base64')}'`));
  }
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const actions = []; let exchange; let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const message = {};
  Object.defineProperty(message, 'textContent', { set: value => finish({ error: value }) });
  vm.runInNewContext(scripts[0], {
    URLSearchParams, JSON,
    window: { location: { hash: issued.loginUrl.hash, replace: url => { actions.push(['navigate', url]); finish({ ok: true }); } },
      history: { replaceState: (_state, _title, url) => { actions.push(['clear', url]); } } },
    document: { getElementById: () => message },
    fetch: async (url, options) => {
      actions.push(['fetch', url]);
      exchange = await f.request(url, { ...options, headers: { ...options.headers, ...f.sameOrigin, Cookie: issued.binding.cookie } });
      return exchange;
    },
  });
  let timer;
  const completed = await Promise.race([complete, new Promise(resolve => { timer = setTimeout(() => resolve({ error: 'SSO script timed out' }), 3000); })]);
  clearTimeout(timer);
  assert.deepEqual(completed, { ok: true });
  assert.deepEqual(actions, [['clear', '/crm/sso'], ['fetch', '/crm/sso/exchange'], ['navigate', '/crm/']]);
  const session = pair(exchange, SESSION);
  secureCookie(session.header, SESSION, 1800);
  secureCookie(pair(exchange, BINDING).header, BINDING, 0);
  const context = await (await f.request('/crm/session', { headers: { Cookie: session.cookie } })).json();
  assert.deepEqual({ storeKey: context.data.storeKey, checkId: context.data.checkId, view: context.data.view, readOnly: context.data.readOnly },
    { storeKey: 'US-A', checkId: 'reviews', view: 'data', readOnly: true });
  assert.doesNotMatch(JSON.stringify(context), new RegExp(`${issued.ticket}|${session.cookie.split('=')[1]}|fixture-subject|roles|username`));
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, Cookie: issued.binding.cookie },
    body: JSON.stringify({ ticket: issued.ticket }) }), 401, 'CRM_TICKET_INVALID');
  const portal = await f.request('/crm/', { headers: { Cookie: session.cookie } });
  assert.equal(portal.status, 200);
  const portalMarkup = await portal.text();
  for (const script of portalMarkup.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.ok(portal.headers.get('content-security-policy').includes(`script-src 'sha256-${crypto.createHash('sha256').update(script[1]).digest('base64')}'`));
  }
});

test('HTTP CRM page navigation starts HTTPS SSO while preserving browser binding and single-store access', async t => {
  const f = await fixture(t);
  const startPath = '/crm/sso/start?storeKey=US-A&view=data&checkId=reviews';
  const navigation = { Referer: 'http://crm.example.test/analysis/dashboard',
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  // The fixture models the monitor's HTTPS reverse proxy. Only the referring
  // CRM page is HTTP; its callback is never fetched by this isolated test.
  await problem(await f.request(startPath, { headers: { ...navigation, 'X-Forwarded-Proto': 'http' } }),
    400, 'CRM_HTTPS_REQUIRED');
  await problem(await f.request(`${startPath}&callbackUrl=https://other.example.test/callback`, { headers: navigation }),
    400, 'CRM_INVALID_INPUT');

  const started = await f.request(startPath, { headers: navigation });
  assert.equal(started.status, 303);
  const binding = pair(started, BINDING);
  secureCookie(binding.header, BINDING, 120);
  const callback = new URL(started.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, 'https://crm.example.test/monitor-entry');
  assert.deepEqual([...callback.searchParams.keys()], ['challengeId', 'storeKey', 'view', 'checkId']);
  assert.equal(callback.href.includes(binding.cookie.split('=')[1]), false);
  assert.equal(callback.href.includes(TOKEN), false);

  // Model the CRM backend after it has authorized the signed-in user's store.
  // Its dedicated bearer stays on this server-to-server request.
  const issued = await f.request(`${API}/sso/tickets`, { method: 'POST',
    headers: { ...f.bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...Object.fromEntries(callback.searchParams), subject: 'fixture-http-crm-user' }) });
  assert.equal(issued.status, 201);
  const loginUrl = new URL((await issued.json()).data.loginUrl);
  assert.equal(loginUrl.origin + loginUrl.pathname, `${ORIGIN}/crm/sso`);
  assert.equal(loginUrl.search, '');
  assert.equal(loginUrl.href.includes(binding.cookie.split('=')[1]), false);
  assert.equal(loginUrl.href.includes(TOKEN), false);
  const body = JSON.stringify({ ticket: new URLSearchParams(loginUrl.hash.slice(1)).get('ticket') });
  const exchange = headers => f.request('/crm/sso/exchange', { method: 'POST', headers, body });
  await problem(await exchange({ ...f.sameOrigin, Cookie: `${BINDING}=${'x'.repeat(43)}` }), 401, 'CRM_TICKET_INVALID');
  await problem(await exchange({ ...f.sameOrigin, ...navigation, Origin: 'http://crm.example.test', Cookie: binding.cookie }),
    403, 'CRM_SAME_ORIGIN_REQUIRED');
  const exchanged = await exchange({ ...f.sameOrigin, Cookie: binding.cookie });
  assert.equal(exchanged.status, 200);
  const session = pair(exchanged, SESSION);
  secureCookie(session.header, SESSION, 1800);
  await problem(await exchange({ ...f.sameOrigin, Cookie: binding.cookie }), 401, 'CRM_TICKET_INVALID');

  const headers = { Cookie: session.cookie };
  const stores = await success(await f.request(`${API}/stores`, { headers }), { read: true });
  assert.deepEqual(stores.data.map(store => store.storeKey), ['US-A']);
  const data = await success(await f.request(`${API}/stores/US-A/checks/reviews/data?runId=fixture-review-run`, { headers }), { read: true });
  assert.deepEqual(data.data.map(record => record.item.identifier), ['REVIEW-A-1', 'REVIEW-A-2']);
  assert.ok(data.data.every(record => record.result.storeKey === 'US-A'));
  await problem(await f.request(`${API}/stores/US-B/checks/reviews/data?runId=fixture-review-run`, { headers }), 404, 'NOT_FOUND');
});

test('CRM browser identity cannot use old APIs or borrow a coexisting local admin scope', async t => {
  const f = await fixture(t);
  const login = await f.login();
  const crmHeaders = { Cookie: login.session.cookie };
  for (const endpoint of ['/api/status', '/api/users', '/api/ads-rules', '/api/product-uploads', '/api/intelligence', '/shot?f=fixture.png']) {
    assert.equal((await f.request(endpoint, { headers: crmHeaders })).status, 401, endpoint);
  }
  const evidence = await f.request('/evidence?f=fixture.png', { headers: crmHeaders });
  assert.equal(evidence.status, 303);
  assert.equal(evidence.headers.get('location'), '/login');
  for (const [endpoint, method] of [['/api/users', 'POST'], ['/api/ads-rules', 'PUT'],
    ['/api/product-uploads/stage', 'POST'], ['/api/product-uploads/confirm', 'POST'],
    ['/api/intelligence/run', 'POST'], ['/api/intelligence/events/00000000-0000-0000-0000-000000000000/review', 'PUT'],
    ['/api/ingest', 'POST']]) {
    assert.equal((await f.request(endpoint, { method, headers: { ...crmHeaders, ...f.sameOrigin }, body: '{}' })).status, 401, endpoint);
  }
  assert.equal((await f.request('/api/status', { headers: f.bearer })).status, 401);
  const adminLogin = await f.request('/login', { method: 'POST', body: new URLSearchParams({ username: 'test-admin', password: PASSWORD }) });
  assert.equal(adminLogin.status, 303);
  const adminCookie = pair(adminLogin, 'amzguard_session').cookie;
  const both = { Cookie: `${adminCookie}; ${login.session.cookie}` };
  const visible = await (await f.request(`${API}/stores`, { headers: both })).json();
  assert.deepEqual(visible.data.map(store => store.storeKey), ['US-A']);
  await problem(await f.request(`${API}/stores/US-B/results`, { headers: both }), 404, 'NOT_FOUND');
  await problem(await f.request(`${API}/stores/US-B/checks/reviews/data?runId=fixture-review-run`, { headers: both }), 404, 'NOT_FOUND');
  await problem(await f.request(`${API}/stores`, { headers: { Cookie: adminCookie } }), 401, 'CRM_SESSION_INVALID');
  await problem(await f.request(`${API}/stores`, { headers: { ...both, Authorization: 'Bearer incorrect' } }), 401, 'CRM_AUTH_REQUIRED');
  assert.equal((await f.request('/api/users', { headers: { Cookie: adminCookie } })).status, 200);
  await problem(await f.request(`${API}/sso/tickets`, { method: 'POST', headers: { ...both, ...f.sameOrigin }, body: '{}' }), 401, 'CRM_AUTH_REQUIRED');
});

test('CRM HTTP rejects CSRF, malformed bodies, unsupported methods and credentials in queries', async t => {
  const f = await fixture(t);
  const issued = await f.issue();
  const body = JSON.stringify({ ticket: issued.ticket });
  const cookie = { Cookie: issued.binding.cookie };
  for (const headers of [
    { 'Content-Type': 'application/json' },
    { 'Content-Type': 'application/json', Origin: 'https://other.example.test' },
    { ...f.sameOrigin, 'Sec-Fetch-Site': 'cross-site' },
    { ...f.sameOrigin, Origin: 'http://monitor.example.test' },
  ]) await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...headers, ...cookie }, body }), 403, 'CRM_SAME_ORIGIN_REQUIRED');
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { Origin: ORIGIN, ...cookie, 'Content-Type': 'text/plain' }, body }), 415, 'CRM_JSON_REQUIRED');
  for (const malformed of ['{', '[]', 'null']) {
    await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, ...cookie }, body: malformed }), 400, 'CRM_JSON_INVALID');
  }
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, ...cookie }, body: JSON.stringify({ ticket: issued.ticket, role: 'admin' }) }), 400, 'CRM_UNKNOWN_FIELD');
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, ...cookie }, body: JSON.stringify({ ticket: 'x'.repeat(8200) }) }), 413, 'CRM_BODY_TOO_LARGE');
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, ...cookie, 'Transfer-Encoding': 'chunked' }, body: JSON.stringify({ ticket: 'x'.repeat(8200) }) }), 413, 'CRM_BODY_TOO_LARGE');
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, ...cookie, 'Content-Encoding': 'gzip' }, body }), 415, 'CRM_ENCODING_UNSUPPORTED');
  for (const endpoint of [`${API}/stores?token=${TOKEN}`, `/crm/sso?ticket=${issued.ticket}`, `${API}/stores?access_token=${TOKEN}`]) {
    const denied = await problem(await f.request(endpoint, { headers: f.bearer }), 400, 'CRM_QUERY_CREDENTIAL_REJECTED');
    assert.equal(JSON.stringify(denied).includes(TOKEN), false);
    assert.equal(JSON.stringify(denied).includes(issued.ticket), false);
  }
  await problem(await f.request('/crm/sso/start?storeKey=US-A&storeKey=US-B&view=results'), 400, 'CRM_DUPLICATE_PARAMETER');
  await problem(await f.request('/crm/sso/start?storeKey=US-A&view=results&callbackUrl=https://other.example.test'), 400, 'CRM_INVALID_INPUT');
  await problem(await f.request('/crm/sso/start?storeKey=US-A&view=results&checkId=missing'), 400, 'CRM_INVALID_CHECK');
  const wrongMethod = await f.request(`${API}/sso/tickets`);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  await problem(wrongMethod, 405, 'CRM_METHOD_NOT_ALLOWED');
  await problem(await f.request(`${API}/stores`, { method: 'POST', headers: { ...f.bearer, ...f.sameOrigin }, body: '{}' }), 405, 'CRM_METHOD_NOT_ALLOWED');
  await problem(await f.request(`${API}/stores`, { headers: { ...f.bearer, Host: 'other.example.test' } }), 421, 'CRM_ORIGIN_MISMATCH');
  await problem(await f.request(`${API}/stores`, { headers: { ...f.bearer, 'X-Forwarded-Proto': 'http' } }), 400, 'CRM_HTTPS_REQUIRED');
  const valid = await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, ...cookie }, body });
  assert.equal(valid.status, 200, 'invalid attempts must not consume the legitimate ticket');
});

test('CRM HTTP logout and store disablement revoke only the independent read session', async t => {
  const f = await fixture(t);
  const first = await f.login();
  const second = await f.login();
  await problem(await f.request('/crm/logout', { method: 'POST', headers: { ...f.sameOrigin, Origin: 'https://other.example.test', Cookie: first.session.cookie }, body: '{}' }), 403, 'CRM_SAME_ORIGIN_REQUIRED');
  const loggedOut = await f.request('/crm/logout', { method: 'POST', headers: { ...f.sameOrigin, Cookie: first.session.cookie }, body: '{}' });
  assert.equal(loggedOut.status, 200);
  secureCookie(pair(loggedOut, SESSION).header, SESSION, 0);
  await problem(await f.request('/crm/session', { headers: { Cookie: first.session.cookie } }), 401, 'CRM_SESSION_INVALID');
  assert.equal((await f.request('/crm/session', { headers: { Cookie: second.session.cookie } })).status, 200);
  fs.writeFileSync(f.storesFile, JSON.stringify(STORE_ROWS.map(store => ({ ...store, enabled: store.key !== 'US-A' }))));
  await problem(await f.request('/crm/session', { headers: { Cookie: second.session.cookie } }), 403, 'CRM_STORE_FORBIDDEN');
  await problem(await f.request(`${API}/stores/US-A/results`, { headers: f.bearer }), 404, 'NOT_FOUND');
  const stores = await (await f.request(`${API}/stores`, { headers: f.bearer })).json();
  assert.deepEqual(stores.data.map(store => store.storeKey), ['US-B']);
  await problem(await f.request('/crm/sso/start?storeKey=US-A&view=results'), 403, 'CRM_STORE_FORBIDDEN');
});

test('CRM HTTP is disabled by default even when local Dashboard authentication works', async t => {
  const f = await fixture(t, { crm: false });
  for (const endpoint of [API, `${API}/stores`, '/crm/', '/crm/sso', '/crm/sso/start?storeKey=US-A&view=results']) {
    await problem(await f.request(endpoint, { headers: f.bearer }), 503, 'CRM_DISABLED');
  }
  assert.equal((await f.request('/api/health')).status, 200);
  const login = await f.request('/login', { method: 'POST', body: new URLSearchParams({ username: 'test-admin', password: PASSWORD }) });
  assert.equal(login.status, 303);
  assert.equal((await f.request('/api/users', { headers: { Cookie: pair(login, 'amzguard_session').cookie } })).status, 200);
});

test('CRM HTTP start limiter fails with retry metadata without disabling machine reads', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 10; index++) {
    assert.equal((await f.request('/crm/sso/start?storeKey=US-A&view=results')).status, 303);
  }
  const limited = await f.request('/crm/sso/start?storeKey=US-A&view=results');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(limited.headers.get('x-ratelimit-remaining'), '0');
  await problem(limited, 429, 'CRM_RATE_LIMITED');
  assert.equal((await f.request(`${API}/stores`, { headers: f.bearer })).status, 200);
});

test('all public OpenAPI routes enforce their method and every read route accepts its documented identity', async t => {
  const f = await fixture(t);
  const login = await f.login();
  const cookie = { Cookie: login.session.cookie };
  const specResponse = await f.request(`${API}/openapi.json`, { headers: f.bearer });
  assert.equal(specResponse.status, 200);
  assert.match(specResponse.headers.get('content-type'), /^application\/json/);
  const spec = await specResponse.json();
  assert.equal(spec.openapi, '3.1.1');
  assert.deepEqual(spec, JSON.parse(fs.readFileSync(path.join(f.temp, 'docs/crm-openapi.json'), 'utf8')));
  assert.equal(Object.hasOwn(spec, 'apiVersion'), false, 'OpenAPI is the raw document, not a success envelope');
  const declared = Object.entries(spec.paths).flatMap(([route, methods]) => Object.keys(methods)
    .filter(method => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method))
    .map(method => `${method.toUpperCase()} ${route}`));
  assert.deepEqual(declared.sort(), PUBLIC_ROUTES.map(([method, route]) => `${method} ${route}`).sort());
  for (const [expected, route] of PUBLIC_ROUTES) {
    const endpoint = route.replace('{storeKey}', 'US-A').replace('{checkId}', 'reviews');
    const response = await f.request(endpoint, { method: expected === 'GET' ? 'POST' : 'GET',
      headers: { ...f.bearer, ...f.sameOrigin, ...cookie } });
    assert.equal(response.headers.get('allow'), expected, route);
    await problem(response, 405, 'CRM_METHOD_NOT_ALLOWED');
  }
  const readRoutes = [API, `${API}/stores`, `${API}/stores/US-A/results`,
    `${API}/stores/US-A/checks/reviews/runs`, `${API}/stores/US-A/checks/reviews/data?runId=fixture-review-run`];
  for (const headers of [f.bearer, cookie]) {
    for (const route of readRoutes) {
      const body = await success(await f.request(route, { headers }), { read: route !== API });
      if (route === API) {
        assert.deepEqual(body.data.storeKeys, headers === f.bearer ? ['US-A', 'US-B'] : ['US-A']);
        assert.deepEqual(body.data.resourceClasses, ['results', 'data']);
        assert.deepEqual(body.data.checks, CHECK_REGISTRY.map(({ id, no, title, scope }) => ({ id, no, title, scope })));
        assert.deepEqual(body.data.checks.map(check => check.id), CHECK_IDS);
        assert.equal(body.data.intelligenceIncluded, false);
        assert.equal(body.data.readOnly, true);
      }
    }
    assert.equal((await f.request(`${API}/openapi.json`, { headers })).status, 200);
  }
  for (const route of ['/crm', '/crm/', '/crm/session']) {
    assert.equal((await f.request(route, { headers: cookie })).status, 200);
    await problem(await f.request(route, { headers: f.bearer }), 401, 'CRM_SESSION_INVALID');
  }
  for (const route of [API, `${API}/openapi.json`]) {
    await problem(await f.request(route), 401, 'CRM_SESSION_INVALID');
    await problem(await f.request(route, { headers: { ...cookie, Authorization: 'Bearer invalid' } }), 401, 'CRM_AUTH_REQUIRED');
  }
  // A valid machine bearer is authoritative even when an invalid browser cookie
  // coexists; malformed or duplicate cookies cannot become a fallback identity.
  assert.equal((await f.request(API, { headers: { ...f.bearer, Cookie: `${SESSION}=%ZZ` } })).status, 200);
  assert.equal((await f.request(API, { headers: { Authorization: `bEaReR ${TOKEN}` } })).status, 200);
  await problem(await f.request(API, { headers: { ...cookie, Authorization: '' } }), 401, 'CRM_AUTH_REQUIRED');
  await problem(await f.request(API, { headers: { Cookie: `${SESSION}=%ZZ` } }), 400, 'CRM_INVALID_COOKIE');
  await problem(await f.request(API, { headers: { Cookie: `${login.session.cookie}; ${login.session.cookie}` } }), 400, 'CRM_DUPLICATE_COOKIE');
  for (const headers of [{ Authorization: `Basic ${TOKEN}` }, { Authorization: `Bearer  ${TOKEN}` }, { 'X-Ingest-Token': TOKEN }]) {
    await problem(await f.request(API, { headers }), 401, headers.Authorization ? 'CRM_AUTH_REQUIRED' : 'CRM_SESSION_INVALID');
  }
  const logoutWithoutSession = await success(await f.request('/crm/logout', { method: 'POST', headers: f.sameOrigin, body: '{}' }));
  assert.equal(logoutWithoutSession.data.loggedOut, true);
  assert.equal((await f.request('/crm/session', { headers: cookie })).status, 200, 'anonymous logout cannot revoke another browser session');
});

test('nine checks across both stores retain complete run/data pagination, uncertainty and saved-file immutability over HTTP', async t => {
  const f = await fixture(t);
  fs.rmSync(f.out, { recursive: true, force: true });
  const counts = {};
  const newest = Date.now() - 60_000;
  for (const [checkIndex, checkId] of CHECK_IDS.entries()) {
    const dir = path.join(f.out, checkId, 'matrix'); fs.mkdirSync(dir, { recursive: true });
    for (let run = 0; run < 3; run++) {
      const at = new Date(newest - (2 - run) * 3_600_000).toISOString();
      const results = STORE_ROWS.flatMap(store => {
        const uncertain = store.key === 'US-B';
        const status = uncertain ? (checkIndex % 2 ? 'PARTIAL_EVIDENCE' : 'UNKNOWN')
          : ({ 'store-health': 'HEALTHY', 'asin-health': 'OK', outlet: 'NO_CHANGE', voc: 'REGISTERED', 'ads-status': 'ALL_OFF' }[checkId] || 'CLEAR');
        const row = { storeKey: store.key, market: 'US', checkedAt: at, status, severity: 'OK', ok: true,
          confidence: uncertain ? 'conflict' : 'high', verdictSource: 'dom+text',
          metrics: { businessStatus: uncertain ? 'UNKNOWN' : 'CLEAR', collectionStatus: uncertain ? 'PARTIAL_EVIDENCE' : 'COMPLETE' },
          evidence: { dom: { landed: true }, text: { landed: true } } };
        if (checkId === 'inbox') {
          row.metrics = { unreadCount: 0, countsAgree: true, confirmedEmpty: true, businessStatus: 'CLEAR', collectionStatus: uncertain ? 'PARTIAL_EVIDENCE' : 'COMPLETE' };
          row.items = [{ identifier: `PRIVATE_${store.key}_MESSAGE`, subject: 'PRIVATE_SUBJECT', body: 'PRIVATE_BODY' }];
          row.anomalyReasons = ['PRIVATE_INBOX_REASON'];
          counts[checkId] = 1;
        } else if (checkId === 'asin-health') {
          counts[checkId] = 3;
          return [0, 1, 2].map(index => ({ ...row, asin: `B00000000${index}` }));
        } else if (checkId === 'store-health') {
          row.ahrScore = 200; counts[checkId] = 1;
        } else if (checkId === 'voc') {
          row.items = [{ asin: 'B012345678', cxHealth: 'Good', records: Array.from({ length: 204 }, (_, index) => ({
            identifier: `${store.key}-VOC-${index}`, date: '2020-01-02', returnReason: 'Fixture return reason', customerName: 'PRIVATE_BUYER',
          })) }];
          counts[checkId] = 205;
        } else {
          const total = checkId === 'reviews' ? 203 : 3;
          row.items = Array.from({ length: total }, (_, index) => ({ identifier: `${store.key}-${checkId}-${index}`,
            reviewId: checkId === 'reviews' ? `${store.key}-REVIEW-${index}` : undefined,
            date: '2020-01-02', title: `Fixture ${checkId} ${index}`, author: 'PRIVATE_BUYER', raw: 'PRIVATE_RAW' }));
          if (checkId === 'reviews') row.evidence.dom.pages = [{ page: 11, pages: 11,
            reviewIds: [`${store.key}-REVIEW-202`], capturedAt: at, screenshot: '/private/PRIVATE_SCREENSHOT.png' }];
          counts[checkId] = total;
        }
        return [row];
      });
      fs.writeFileSync(path.join(dir, `run-${run}.json`), JSON.stringify({ check: checkId, runId: `${checkId}-${run}`,
        selection: { targeted: false }, startedAt: at, finishedAt: at, results }));
    }
  }
  const before = savedFiles(f.out);
  for (const [storeIndex, storeKey] of ['US-A', 'US-B'].entries()) {
    const headers = { ...f.bearer, 'X-Forwarded-For': `192.0.2.${20 + storeIndex}` };
    const session = await f.login({ storeKey });
    const sessionHeaders = { Cookie: session.session.cookie, 'X-Forwarded-For': `192.0.2.${30 + storeIndex}` };
    const summary = await success(await f.request(`${API}/stores/${storeKey}/results`, { headers }), { read: true });
    assert.deepEqual(summary.data.checks.map(check => check.checkId), CHECK_IDS);
    for (const check of summary.data.checks) {
      assert.ok(check.results.length > 0, check.checkId);
      assert.ok(check.results.every(result => result.storeKey === storeKey && result.source.runId === `${check.checkId}-2`));
      assert.ok(check.results.every(result => result.source.checkedAt !== summary.generatedAt));
      if (storeKey === 'US-B') {
        assert.equal(check.severity, 'ERROR');
        assert.ok(check.results.every(result => result.actionState === 'COLLECTION' && result.presentationAdjusted));
      }
    }
    for (const checkId of CHECK_IDS) {
      const base = `${API}/stores/${storeKey}/checks/${checkId}`;
      const firstRuns = await success(await f.request(`${base}/runs?pageSize=2`, { headers }), { read: true });
      assert.deepEqual(firstRuns.data.map(run => run.runId), [`${checkId}-2`, `${checkId}-1`]);
      assert.deepEqual(firstRuns.pagination, { page: 1, pageSize: 2, total: 3, pages: 2, hasMore: true });
      const lastRuns = await success(await f.request(`${base}/runs?pageSize=2&page=2`, { headers }), { read: true });
      assert.equal(lastRuns.data[0].runId, `${checkId}-0`);
      assert.equal(lastRuns.pagination.hasMore, false);
      const beyondRuns = await success(await f.request(`${base}/runs?pageSize=2&page=3`, { headers }), { read: true });
      assert.deepEqual(beyondRuns.data, []);
      const first = await success(await f.request(`${base}/data?runId=${checkId}-2`, { headers }), { read: true });
      const cookieRuns = await success(await f.request(`${base}/runs?pageSize=2`, { headers: sessionHeaders }), { read: true });
      assert.deepEqual(cookieRuns.data, firstRuns.data);
      const cookieData = await success(await f.request(`${base}/data?runId=${checkId}-2`, { headers: sessionHeaders }), { read: true });
      assert.equal(cookieData.metadata.snapshotId, first.metadata.snapshotId);
      assert.equal(cookieData.pagination.total, first.pagination.total);
      assert.ok(cookieData.data.every(record => record.result.storeKey === storeKey));
      const otherStore = storeKey === 'US-A' ? 'US-B' : 'US-A';
      await problem(await f.request(`${API}/stores/${otherStore}/checks/${checkId}/data?runId=${checkId}-2`, { headers: sessionHeaders }), 404, 'NOT_FOUND');
      const total = counts[checkId], lastPage = Math.ceil(total / 100);
      assert.equal(first.pagination.total, total);
      assert.equal(first.pagination.pageSize, 100);
      const last = await success(await f.request(`${base}/data?runId=${checkId}-2&page=${lastPage}&snapshotId=${first.metadata.snapshotId}`, { headers }), { read: true });
      assert.equal(last.pagination.hasMore, false);
      assert.equal(last.data.length, total - (lastPage - 1) * 100);
      assert.equal(last.metadata.snapshotId, firstRuns.data[0].snapshotId);
      const beyond = await success(await f.request(`${base}/data?runId=${checkId}-2&page=${lastPage + 1}`, { headers }), { read: true });
      assert.deepEqual(beyond.data, []);
      assert.equal(beyond.pagination.hasMore, false);
      for (const response of [first, last]) {
        assert.ok(response.data.every(record => record.result.storeKey === storeKey));
        assert.doesNotMatch(JSON.stringify(response), /PRIVATE_|US-X/);
        assert.equal(JSON.stringify(response).includes(storeKey === 'US-A' ? 'US-B' : 'US-A'), false);
      }
      if (checkId === 'reviews') {
        assert.equal(last.data.at(-1).item.reviewId, `${storeKey}-REVIEW-202`);
        assert.equal(last.data.at(-1).item.date, '2020-01-02');
        assert.equal(last.data.at(-1).reviewPages[0].page, 11);
      } else if (checkId === 'voc') {
        assert.equal(first.data[0].recordType, 'voc-asin');
        assert.equal(last.data.at(-1).recordIndex, 203);
        assert.equal(last.data.at(-1).item.identifier, `${storeKey}-VOC-203`);
      } else if (checkId === 'inbox') {
        assert.equal(first.data[0].recordType, 'check-result');
        assert.equal(Object.hasOwn(first.data[0], 'item'), false);
        assert.equal(Object.hasOwn(first.data[0].result, 'reasons'), false);
      }
    }
  }
  assert.deepEqual(savedFiles(f.out), before, 'reading must not mutate or create saved business files');
});

test('HTTP query validation rejects ambiguous pagination and credential transport on every route', async t => {
  const f = await fixture(t, { crmOverrides: { AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://crm.example.test' } });
  const login = await f.login();
  const headers = { ...f.bearer, ...f.sameOrigin, Cookie: login.session.cookie };
  for (const [method, route] of PUBLIC_ROUTES) {
    const endpoint = route.replace('{storeKey}', 'US-A').replace('{checkId}', 'reviews');
    await problem(await f.request(`${endpoint}?api_token=PRIVATE_QUERY`, { method, headers, body: method === 'POST' ? '{}' : undefined }), 400, 'CRM_QUERY_CREDENTIAL_REJECTED');
    const expected = ['/crm/sso/start', '/crm/sso/bridge'].includes(endpoint) ? 'CRM_INVALID_INPUT'
      : endpoint.startsWith(`${API}/stores`) ? 'INVALID_QUERY' : 'CRM_INVALID_QUERY';
    await problem(await f.request(`${endpoint}?unexpected=1`, { method, headers, body: method === 'POST' ? '{}' : undefined }), 400, expected);
  }
  const base = `${API}/stores/US-A/checks/reviews`;
  for (const query of ['page=1&page=1', 'page=0', 'page=01', 'page=+1', 'page=1e2', 'page=1000001',
    'pageSize=201', 'pageSize=0', 'pageSize=', 'from=2026-02-29', 'to=', 'from=2026-09-13&to=2026-09-12']) {
    await problem(await f.request(`${base}/runs?${query}`, { headers }), 400, 'INVALID_QUERY');
  }
  for (const query of ['', 'runId=', 'runId=x&runId=x', 'runId=x&snapshotId=BAD', 'runId=%00', `runId=${'x'.repeat(301)}`]) {
    await problem(await f.request(`${base}/data?${query}`, { headers }), 400, 'INVALID_QUERY');
  }
  for (const endpoint of [`${base}/data?runId=LATEST_EFFECTIVE_BY_STORE`, `${API}/stores/US-X/results`,
    `${API}/stores/US-A/checks/intelligence/runs`, `${API}/stores/US-A/checks/unknown/data?runId=x`]) {
    await problem(await f.request(endpoint, { headers }), 404, 'NOT_FOUND');
  }
  await problem(await f.request(`${API}/stores/%ZZ/results`, { headers }), 400, 'INVALID_URL');
  const accepted = await success(await f.request(`${base}/data?runId=fixture-review-run&pageSize=200`, { headers }), { read: true });
  assert.equal(accepted.pagination.pageSize, 200);
  assert.equal(accepted.pagination.total, 2);
});

test('HTTP SSO challenge, ticket and session expiry enforce exact non-sliding boundaries', async t => {
  const f = await fixture(t, { controlled: true });
  const begin = async () => {
    const response = await f.request('/crm/sso/start?storeKey=US-A&view=data&checkId=reviews');
    assert.equal(response.status, 303);
    return { binding: pair(response, BINDING), challengeId: new URL(response.headers.get('location')).searchParams.get('challengeId') };
  };
  const issue = started => f.request(`${API}/sso/tickets`, { method: 'POST', headers: { ...f.bearer, ...f.sameOrigin },
    body: JSON.stringify({ challengeId: started.challengeId, subject: 'fixture-subject', storeKey: 'US-A', checkId: 'reviews', view: 'data' }) });
  const exchange = (ticket, binding) => f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, Cookie: binding.cookie }, body: JSON.stringify({ ticket }) });
  const expiredChallenge = await begin();
  f.advance(120_000);
  await problem(await issue(expiredChallenge), 401, 'CRM_CHALLENGE_INVALID');
  const expiredTicket = await f.issue();
  f.advance(60_000);
  await problem(await exchange(expiredTicket.ticket, expiredTicket.binding), 401, 'CRM_TICKET_INVALID');
  const late = await begin();
  f.advance(119_000);
  const lateIssue = await issue(late);
  assert.equal(lateIssue.status, 201);
  const issued = await lateIssue.json();
  assert.equal(Date.parse(issued.data.expiresAt), f.now() + 1000, 'late issuance cannot extend the challenge');
  f.advance(1000);
  await problem(await exchange(new URLSearchParams(new URL(issued.data.loginUrl).hash.slice(1)).get('ticket'), late.binding), 401, 'CRM_TICKET_INVALID');
  const login = await f.login();
  const expiresAt = (await success(await f.request('/crm/session', { headers: { Cookie: login.session.cookie } }))).data.expiresAt;
  f.advance(1_799_999);
  const beforeBoundary = await success(await f.request('/crm/session', { headers: { Cookie: login.session.cookie } }));
  assert.equal(beforeBoundary.data.expiresAt, expiresAt, 'reads must not renew a session');
  f.advance(1);
  await problem(await f.request('/crm/session', { headers: { Cookie: login.session.cookie } }), 401, 'CRM_SESSION_INVALID');
  await problem(await f.request(`${API}/stores`, { headers: { Cookie: login.session.cookie } }), 401, 'CRM_SESSION_INVALID');
  assert.equal((await f.request(`${API}/stores`, { headers: f.bearer })).status, 200);
});

test('HTTP callback removal, complete CRM disablement and key rotation revoke browser state while preserving scope', async t => {
  const f = await fixture(t, { controlled: true });
  const old = await f.login();
  const outstanding = await f.issue();
  f.configureCrm({ ...f.crmEnv, AMZGUARD_CRM_CALLBACK_URL: '' });
  const machine = await success(await f.request(API, { headers: f.bearer }));
  assert.equal(machine.data.ssoAvailable, false);
  assert.deepEqual(machine.data.storeKeys, ['US-A', 'US-B']);
  await problem(await f.request('/crm/sso/start?storeKey=US-A&view=results'), 503, 'CRM_SSO_UNAVAILABLE');
  await problem(await f.request('/crm/session', { headers: { Cookie: old.session.cookie } }), 401, 'CRM_SESSION_INVALID');
  f.configureCrm({});
  for (const [method, route] of PUBLIC_ROUTES) {
    const endpoint = route.replace('{storeKey}', 'US-A').replace('{checkId}', 'reviews');
    await problem(await f.request(endpoint, { method, headers: { ...f.bearer, ...f.sameOrigin, Cookie: old.session.cookie },
      body: method === 'POST' ? '{}' : undefined }), 503, 'CRM_DISABLED');
  }
  f.configureCrm(f.crmEnv);
  await problem(await f.request('/crm/session', { headers: { Cookie: old.session.cookie } }), 401, 'CRM_SESSION_INVALID');
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, Cookie: outstanding.binding.cookie },
    body: JSON.stringify({ ticket: outstanding.ticket }) }), 401, 'CRM_TICKET_INVALID');
  const restored = await f.login({ storeKey: 'US-B' });
  const rotated = 'fixture-rotated-crm-token-with-at-least-32-characters';
  f.configureCrm({ ...f.crmEnv, AMZGUARD_CRM_API_TOKEN: rotated, AMZGUARD_CRM_STORE_KEYS: 'US-B' });
  await problem(await f.request(API, { headers: f.bearer }), 401, 'CRM_AUTH_REQUIRED');
  await problem(await f.request('/crm/session', { headers: { Cookie: restored.session.cookie } }), 401, 'CRM_SESSION_INVALID');
  const current = await success(await f.request(`${API}/stores`, { headers: { Authorization: `Bearer ${rotated}` } }), { read: true });
  assert.deepEqual(current.data.map(store => store.storeKey), ['US-B']);
  await problem(await f.request(`${API}/stores/US-A/results`, { headers: { Authorization: `Bearer ${rotated}` } }), 404, 'NOT_FOUND');
});

test('HTTP report conflicts fail closed and date filters describe collection rather than publication time', async t => {
  const f = await fixture(t);
  const reportFile = path.join(f.out, 'reviews/fixture/saved-run.json');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const collectedAt = new Date(Date.now() - 120_000);
  const collectionDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(collectedAt);
  for (const result of report.results) result.checkedAt = collectedAt.toISOString();
  fs.writeFileSync(reportFile, JSON.stringify(report));
  const base = `${API}/stores/US-A/checks/reviews`;
  const matching = await success(await f.request(`${base}/runs?from=${collectionDate}&to=${collectionDate}`, { headers: f.bearer }), { read: true });
  assert.equal(matching.data.length, 1);
  assert.deepEqual(matching.data[0].collectionDates, [collectionDate]);
  const publication = await success(await f.request(`${base}/runs?from=2026-08-01&to=2026-08-02`, { headers: f.bearer }), { read: true });
  assert.equal(publication.data.length, 0);
  const snapshot = matching.data[0].snapshotId;
  const duplicate = path.join(path.dirname(reportFile), 'duplicate.json');
  fs.writeFileSync(duplicate, JSON.stringify({ ...report, results: [{ ...report.results[0], status: 'UNKNOWN', severity: 'ERROR', ok: false }] }));
  for (const endpoint of [`${API}/stores/US-A/results`, `${base}/runs`, `${base}/data?runId=fixture-review-run&snapshotId=${snapshot}`]) {
    const error = await problem(await f.request(endpoint, { headers: f.bearer }), 409, 'REPORT_CONFLICT');
    assert.equal(Object.hasOwn(error, 'data'), false);
    assert.equal(Object.hasOwn(error, 'pagination'), false);
    assert.equal(Object.hasOwn(error, 'metadata'), false);
    assert.doesNotMatch(JSON.stringify(error), /saved-run|duplicate\.json|PRIVATE_/);
  }
  fs.writeFileSync(duplicate, JSON.stringify(report));
  const recovered = await success(await f.request(`${base}/runs`, { headers: f.bearer }), { read: true });
  assert.equal(recovered.pagination.total, 1, 'identical saved copies are deduplicated');
});

test('HTTP fixed-window API/browser and ticket/exchange limiters expose exact limits and recover at reset', async t => {
  const f = await fixture(t, { controlled: true });
  const apiHeaders = { ...f.bearer, 'X-Forwarded-For': '192.0.2.60' };
  for (let index = 0; index < 120; index++) {
    const response = await f.request(`${API}/stores`, { headers: apiHeaders });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ratelimit-limit'), '120');
    assert.equal(response.headers.get('x-ratelimit-remaining'), String(119 - index));
  }
  const apiLimited = await f.request(`${API}/stores`, { headers: apiHeaders });
  assert.equal(apiLimited.headers.get('retry-after'), '60');
  await problem(apiLimited, 429, 'CRM_RATE_LIMITED');
  f.advance(60_000);
  assert.equal((await f.request(`${API}/stores`, { headers: apiHeaders })).headers.get('x-ratelimit-remaining'), '119');
  const browserHeaders = { 'X-Forwarded-For': '192.0.2.61' };
  for (let index = 0; index < 60; index++) assert.equal((await f.request('/crm/sso', { headers: browserHeaders })).status, 200);
  const browserLimited = await f.request('/crm/sso', { headers: browserHeaders });
  assert.equal(browserLimited.headers.get('x-ratelimit-limit'), '60');
  assert.equal(browserLimited.headers.get('x-ratelimit-remaining'), '0');
  await problem(browserLimited, 429, 'CRM_RATE_LIMITED');
  assert.equal((await f.request(API, { headers: { ...f.bearer, ...browserHeaders } })).status, 200);
  for (const [route, extra, body] of [
    [`${API}/sso/tickets`, { ...f.bearer, 'X-Forwarded-For': '192.0.2.62' },
      { challengeId: 'A'.repeat(43), subject: 'fixture-subject', storeKey: 'US-A', view: 'results' }],
    ['/crm/sso/exchange', { 'X-Forwarded-For': '192.0.2.63' }, { ticket: 'A'.repeat(43) }],
  ]) {
    for (let index = 0; index < 20; index++) {
      const response = await f.request(route, { method: 'POST', headers: { ...f.sameOrigin, ...extra }, body: JSON.stringify(body) });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('x-ratelimit-limit'), '20');
      assert.equal(response.headers.get('x-ratelimit-remaining'), String(19 - index));
    }
    const limited = await f.request(route, { method: 'POST', headers: { ...f.sameOrigin, ...extra }, body: JSON.stringify(body) });
    assert.equal(limited.headers.get('retry-after'), '60');
    await problem(limited, 429, 'CRM_RATE_LIMITED');
  }
  f.advance(60_000);
  assert.equal((await f.request('/crm/sso', { headers: browserHeaders })).status, 200);
});

test('HTTP ticket issuance validates subject and exact destination before a single successful issuance', async t => {
  const f = await fixture(t);
  const started = await f.request('/crm/sso/start?storeKey=US-A&view=results');
  assert.equal(started.status, 303);
  const callback = new URL(started.headers.get('location'));
  assert.equal(callback.searchParams.has('checkId'), false);
  const body = { challengeId: callback.searchParams.get('challengeId'), subject: 'fixture-subject', storeKey: 'US-A', view: 'results' };
  const issue = override => f.request(`${API}/sso/tickets`, { method: 'POST', headers: { ...f.bearer, ...f.sameOrigin }, body: JSON.stringify({ ...body, ...override }) });
  for (const [override, status, code] of [
    [{ role: 'admin' }, 400, 'CRM_INVALID_INPUT'], [{ subject: '' }, 400, 'CRM_INVALID_SUBJECT'],
    [{ subject: ' leading' }, 400, 'CRM_INVALID_SUBJECT'], [{ subject: 'a'.repeat(129) }, 400, 'CRM_INVALID_SUBJECT'],
    [{ storeKey: 'US-X' }, 403, 'CRM_STORE_FORBIDDEN'], [{ storeKey: 'US-B' }, 403, 'CRM_DESTINATION_MISMATCH'],
    [{ view: 'data' }, 403, 'CRM_DESTINATION_MISMATCH'], [{ checkId: 'reviews' }, 403, 'CRM_DESTINATION_MISMATCH'],
    [{ checkId: 'intelligence' }, 400, 'CRM_INVALID_CHECK'],
  ]) await problem(await issue(override), status, code);
  const issued = await issue({ checkId: null });
  assert.equal(issued.status, 201);
  const ticket = await issued.json();
  assert.equal(ticket.apiVersion, '1.0');
  assert.equal(ticket.data.singleUse, true);
  assert.equal(new URL(ticket.data.loginUrl).search, '');
  await problem(await issue({}), 409, 'CRM_CHALLENGE_USED');
  const exchange = await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, Cookie: pair(started, BINDING).cookie },
    body: JSON.stringify({ ticket: new URLSearchParams(new URL(ticket.data.loginUrl).hash.slice(1)).get('ticket') }) });
  const context = await success(await f.request('/crm/session', { headers: { Cookie: pair(exchange, SESSION).cookie } }));
  assert.equal(context.data.checkId, null);
  assert.equal(context.data.view, 'results');
});

function bridgeContext(markup) {
  const match = /<script type="application\/json" id="crmBridgeContext">([\s\S]*?)<\/script>/.exec(markup);
  assert.ok(match, 'public bridge context expected');
  return JSON.parse(match[1]);
}

async function issueBridge(f, input = {}) {
  const requestId = crypto.randomBytes(32).toString('base64url');
  const fields = { storeKey: 'US-A', view: 'data', checkId: 'reviews', requestId, ...input };
  const started = await f.request(`/crm/sso/bridge?${new URLSearchParams(fields)}`);
  assert.equal(started.status, 200, await started.clone().text());
  const markup = await started.text(), context = bridgeContext(markup), binding = pair(started, BINDING);
  const scope = { storeKey: fields.storeKey, view: fields.view, checkId: fields.checkId ?? null };
  const body = { ...scope, challengeId: context.challengeId, subject: 'fixture-popup-subject' };
  const issued = await f.request(`${API}/sso/tickets`, { method: 'POST', headers: { ...f.bearer, ...f.sameOrigin }, body: JSON.stringify(body) });
  assert.equal(issued.status, 201, await issued.clone().text());
  const issuedData = (await issued.json()).data;
  return { started, markup, context, binding, body, loginUrl: issuedData.loginUrl, ticket: issuedData.loginUrl.split('#ticket=')[1] };
}

test('HTTP popup bridge supports callback-free HTTP CRM with cookie binding, exact CSP and one-store exchange', async t => {
  const f = await fixture(t, { crmOverrides: { AMZGUARD_CRM_CALLBACK_URL: '', AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://crm.example.test' } });
  const capability = await success(await f.request(API, { headers: f.bearer }));
  assert.deepEqual(capability.data.ssoModes, ['popup']);
  assert.equal(capability.data.ssoAvailable, true);
  await problem(await f.request('/crm/sso/start?storeKey=US-A&view=results'), 503, 'CRM_SSO_UNAVAILABLE');
  const issued = await issueBridge(f);
  secureCookie(issued.binding.header, BINDING, 120);
  assert.equal(issued.started.headers.get('cross-origin-opener-policy'), 'unsafe-none');
  assert.equal(issued.started.headers.get('x-frame-options'), 'DENY');
  assert.equal(issued.started.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(issued.started.headers.get('cache-control'), 'no-store');
  for (const response of [await f.request('/crm/sso'), await f.request(API, { headers: f.bearer }), await f.request('/login')]) {
    assert.notEqual(response.headers.get('cross-origin-opener-policy'), 'unsafe-none', 'bridge exception stays local to bridge');
  }
  assert.equal(issued.markup.includes(issued.binding.cookie.split('=')[1]), false);
  assert.equal(issued.markup.includes(TOKEN), false);
  const csp = issued.started.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|http:/);
  const scripts = [...issued.markup.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1);
  for (const script of scripts) assert.ok(csp.includes(`script-src 'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`));
  for (const match of issued.markup.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    assert.ok(csp.includes(`style-src 'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`));
  }
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: f.sameOrigin, body: JSON.stringify({ ticket: issued.ticket }) }), 401, 'CRM_TICKET_INVALID');
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, Cookie: `${BINDING}=${'x'.repeat(43)}` }, body: JSON.stringify({ ticket: issued.ticket }) }), 401, 'CRM_TICKET_INVALID');
  await problem(await f.request(`${API}/sso/tickets`, { method: 'POST', headers: { ...f.bearer, ...f.sameOrigin }, body: JSON.stringify(issued.body) }), 409, 'CRM_CHALLENGE_USED');

  const posts = [], navigations = [], calls = [];
  let listener, exchange;
  const opener = { closed: false, postMessage: (data, origin) => posts.push({ data: JSON.parse(JSON.stringify(data)), origin }) };
  const window = { opener, addEventListener: (_name, fn) => { listener = fn; }, removeEventListener: () => { listener = null; },
    location: { replace: url => navigations.push({ url, detached: window.opener === null }) } };
  window.self = window; window.top = window;
  const status = { textContent: '' };
  vm.runInNewContext(scripts[0], { window, document: { getElementById: id => id === 'crmBridgeStatus' ? status : { textContent: JSON.stringify(issued.context) } },
    AbortController, setTimeout: () => 1, clearTimeout: () => {},
    fetch: async (url, options) => {
      calls.push(url);
      exchange = await f.request(url, { ...options, headers: { ...options.headers, ...f.sameOrigin, Cookie: issued.binding.cookie } });
      return exchange;
    } });
  assert.deepEqual(posts[0], { origin: 'http://crm.example.test', data: { type: 'amzguard:crm:challenge', version: 1,
    requestId: issued.context.requestId, challengeId: issued.context.challengeId, storeKey: 'US-A', view: 'data', checkId: 'reviews' } });
  const ticketMessage = { type: 'amzguard:crm:ticket', version: 1, requestId: issued.context.requestId,
    challengeId: issued.context.challengeId, loginUrl: issued.loginUrl };
  await listener({ source: {}, origin: 'http://crm.example.test', data: ticketMessage });
  await listener({ source: opener, origin: 'https://crm.example.test', data: ticketMessage });
  assert.deepEqual(calls, []);
  const receive = listener;
  await receive({ source: opener, origin: 'http://crm.example.test', data: ticketMessage });
  await receive({ source: opener, origin: 'http://crm.example.test', data: ticketMessage });
  assert.deepEqual(calls, ['/crm/sso/exchange']);
  assert.deepEqual(navigations, [{ url: '/crm/', detached: true }]);
  assert.equal(posts[1].data.type, 'amzguard:crm:complete');
  const session = pair(exchange, SESSION);
  secureCookie(session.header, SESSION, 1800);
  secureCookie(pair(exchange, BINDING).header, BINDING, 0);
  const authenticated = { Cookie: session.cookie };
  const context = await success(await f.request('/crm/session', { headers: authenticated }));
  assert.equal(context.data.storeKey, 'US-A');
  const stores = await success(await f.request(`${API}/stores`, { headers: authenticated }), { read: true });
  assert.deepEqual(stores.data.map(store => store.storeKey), ['US-A']);
  await problem(await f.request(`${API}/stores/US-B/results`, { headers: authenticated }), 404, 'NOT_FOUND');
  assert.equal((await f.request('/api/status', { headers: authenticated })).status, 401);
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, Cookie: issued.binding.cookie }, body: JSON.stringify({ ticket: issued.ticket }) }), 401, 'CRM_TICKET_INVALID');
});

test('HTTP bridge rejects invalid parameters, off-origin requests and altered signing scope', async t => {
  const f = await fixture(t, { crmOverrides: { AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://crm.example.test' } });
  const base = '/crm/sso/bridge';
  const query = 'storeKey=US-A&view=results&requestId=' + 'R'.repeat(43);
  let ip = 100;
  for (const [suffix, status, code] of [
    [`?${query}&requestId=${'S'.repeat(43)}`, 400, 'CRM_DUPLICATE_PARAMETER'],
    [`?${query}&unknown=1`, 400, 'CRM_INVALID_INPUT'], ['?storeKey=US-A&view=results', 400, 'CRM_INVALID_REQUEST_ID'],
    ['?storeKey=US-A&view=results&requestId=short', 400, 'CRM_INVALID_REQUEST_ID'],
    [`?${query}&checkId=intelligence`, 400, 'CRM_INVALID_CHECK'],
    [`?${query.replace('US-A', 'US-X')}`, 403, 'CRM_STORE_FORBIDDEN'],
    [`?${query.replace('results', 'admin')}`, 400, 'CRM_INVALID_VIEW'],
    [`?${query}&openerOrigin=http://evil.example.test`, 400, 'CRM_INVALID_INPUT'],
    [`?${query}&ticket=PRIVATE_QUERY_TICKET`, 400, 'CRM_QUERY_CREDENTIAL_REJECTED'],
  ]) await problem(await f.request(base + suffix, { headers: { 'X-Forwarded-For': `192.0.2.${ip++}` } }), status, code);
  await problem(await f.request(`${base}?${query}`, { headers: { 'X-Forwarded-Proto': 'http' } }), 400, 'CRM_HTTPS_REQUIRED');
  await problem(await f.request(`${base}?${query}`, { headers: { Host: 'other.example.test' } }), 421, 'CRM_ORIGIN_MISMATCH');
  const method = await f.request(`${base}?${query}`, { method: 'POST', headers: f.sameOrigin, body: '{}' });
  assert.equal(method.headers.get('allow'), 'GET');
  await problem(method, 405, 'CRM_METHOD_NOT_ALLOWED');
  const started = await f.request(`${base}?${query}`);
  const context = bridgeContext(await started.text());
  for (const patch of [{ storeKey: 'US-B' }, { view: 'data' }, { checkId: 'reviews' }]) {
    await problem(await f.request(`${API}/sso/tickets`, { method: 'POST', headers: { ...f.bearer, ...f.sameOrigin },
      body: JSON.stringify({ storeKey: 'US-A', view: 'results', subject: 'fixture-user', challengeId: context.challengeId, ...patch }) }), 403, 'CRM_DESTINATION_MISMATCH');
  }
  const issued = await f.request(`${API}/sso/tickets`, { method: 'POST', headers: { ...f.bearer, ...f.sameOrigin },
    body: JSON.stringify({ storeKey: 'US-A', view: 'results', subject: 'fixture-user', challengeId: context.challengeId, checkId: null }) });
  assert.equal(issued.status, 201, 'rejected scopes must not consume the legitimate challenge');
});

test('HTTP bridge shares start and browser rate buckets with the existing redirect flow', async t => {
  const f = await fixture(t, { controlled: true, crmOverrides: { AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://crm.example.test' } });
  const bridge = '/crm/sso/bridge?storeKey=US-A&view=results&requestId=' + 'R'.repeat(43);
  for (let index = 0; index < 10; index++) {
    const response = await f.request(index % 2 ? bridge : '/crm/sso/start?storeKey=US-A&view=results');
    assert.equal(response.status, index % 2 ? 200 : 303);
    assert.equal(response.headers.get('x-ratelimit-remaining'), String(9 - index));
  }
  const startLimited = await f.request(bridge);
  assert.equal(startLimited.headers.get('x-ratelimit-limit'), '10');
  await problem(startLimited, 429, 'CRM_RATE_LIMITED');
  f.advance(60_000);
  for (let index = 0; index < 50; index++) assert.equal((await f.request('/crm/sso')).status, 200);
  for (let index = 0; index < 10; index++) assert.equal((await f.request(bridge)).status, 200);
  const browserLimited = await f.request('/crm/sso');
  assert.equal(browserLimited.headers.get('x-ratelimit-limit'), '60');
  await problem(browserLimited, 429, 'CRM_RATE_LIMITED');
});

test('HTTP bridge origin changes revoke sessions and outstanding tickets; disabled popup preserves redirect mode', async t => {
  const f = await fixture(t, { controlled: true, crmOverrides: { AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://crm.example.test' } });
  const first = await issueBridge(f), pending = await issueBridge(f);
  const exchanged = await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, Cookie: first.binding.cookie }, body: JSON.stringify({ ticket: first.ticket }) });
  const session = pair(exchanged, SESSION);
  f.configureCrm({ ...f.crmEnv, AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://other-crm.example.test' });
  await problem(await f.request('/crm/session', { headers: { Cookie: session.cookie } }), 401, 'CRM_SESSION_INVALID');
  await problem(await f.request('/crm/sso/exchange', { method: 'POST', headers: { ...f.sameOrigin, Cookie: pending.binding.cookie }, body: JSON.stringify({ ticket: pending.ticket }) }), 401, 'CRM_TICKET_INVALID');
  f.configureCrm({ ...f.crmEnv, AMZGUARD_CRM_BRIDGE_ORIGIN: '' });
  const capability = await success(await f.request(API, { headers: f.bearer }));
  assert.deepEqual(capability.data.ssoModes, ['redirect']);
  assert.equal(capability.data.ssoAvailable, true);
  await problem(await f.request('/crm/sso/bridge?storeKey=US-A&view=results&requestId=' + 'R'.repeat(43)), 503, 'CRM_BRIDGE_UNAVAILABLE');
  assert.equal((await f.request('/crm/sso/start?storeKey=US-A&view=results')).status, 303);
});
