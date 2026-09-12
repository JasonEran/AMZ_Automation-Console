import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://configuration.example.test';
const PASSWORD = 'fixture-dashboard-password-123';
const CRM_TOKEN = 'fixture-config-crm-token-distinct-from-dashboard';
const STORES = [
  { key: 'US-A', name: 'ZiNiao A', displayName: 'Bootstrap A', id: '101', market: 'US', host: 'sellercentral.amazon.com', enabled: true },
  { key: 'US-B', name: 'ZiNiao B', id: '102', market: 'US', host: 'sellercentral.amazon.com', enabled: true },
  { key: 'LEGACY', name: 'ZiNiao legacy', id: 'PRIVATE_LEGACY_OAUTH', market: 'US', enabled: false, paths: ['/legacy-fixture'], adsNameContains: 'legacy-group' },
];
const DEFAULTS = { reportRefreshSeconds: 30, progressRefreshSeconds: 2, uploadRefreshSeconds: 15,
  matrixPageSize: 8, listPageSize: 10, defaultView: 'overview' };
const NEW_STORE = { key: 'US-NEW', name: 'ZiNiao new', displayName: 'New display', id: '103', market: 'US', host: 'sellercentral.amazon.com' };

async function availablePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function cookie(response, name = 'amzguard_session') {
  const value = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  assert.ok(value, `expected ${name} cookie`); return value.split(';')[0];
}
async function body(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  assert.match(response.headers.get('content-type') || '', /^application\/(?:problem\+)?json/);
  return response.json();
}
async function error(response, status, code) {
  const value = await body(response, status);
  assert.equal(value.ok, false);
  assert.equal(typeof value.error, 'string');
  if (code) assert.equal(value.code, code);
  return value;
}
function snapshot(dir) {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) result[path.relative(dir, file)] = {
        hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: fs.statSync(file).mtimeMs,
      };
    }
  };
  walk(dir); return result;
}

async function fixture(t, { dashboard = {}, stores = STORES, upload = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-configuration-http-'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(temp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}\n');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(temp, 'config')); fs.mkdirSync(path.join(temp, 'docs'));
  fs.copyFileSync(path.join(ROOT, 'docs/crm-openapi.json'), path.join(temp, 'docs/crm-openapi.json'));
  const storesFile = path.join(temp, 'config/stores.json'), configFile = path.join(temp, 'config/config.json');
  fs.writeFileSync(storesFile, JSON.stringify(stores));
  fs.writeFileSync(configFile, JSON.stringify({ paths: { outDir: 'out' }, dashboard }));
  const bootstrap = { stores: fs.readFileSync(storesFile), config: fs.readFileSync(configFile) };
  const out = path.join(temp, 'out'), registryFile = path.join(out, 'runtime/store-registry.json'), uiFile = path.join(out, 'runtime/ui-config.json');
  const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nprintf "attempt\\n" >> "$AMZGUARD_TEST_SECURITY_LOG"\nexit 1\n', { mode: 0o755 });
  const rendezvous = path.join(temp, 'body-rendezvous'); fs.mkdirSync(rendezvous);
  const guard = path.join(temp, 'guard.mjs');
  fs.writeFileSync(guard, `import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https';
import net from 'node:net'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module';
function blocked(){fs.appendFileSync(process.env.AMZGUARD_TEST_NETWORK_LOG,'attempt\\n');throw new Error('Fixture forbids outbound network');}
http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;
net.connect=blocked;net.createConnection=blocked;net.Socket.prototype.connect=blocked;tls.connect=blocked;globalThis.fetch=blocked;
const open=fs.openSync;
fs.openSync=function(file,...args){if(String(file).endsWith('guarded-payload.csv')){fs.appendFileSync(process.env.AMZGUARD_TEST_PAYLOAD_LOG,'attempt\\n');throw new Error('Binding guard must not open upload payload');}return open.call(this,file,...args)};
const on=http.IncomingMessage.prototype.on;
http.IncomingMessage.prototype.on=function(event,...args){const value=on.call(this,event,...args);const marker=this.headers?.['x-fixture-body-rendezvous'];
if(event==='data'&&typeof marker==='string'&&/^[a-f0-9-]{36}$/.test(marker))fs.writeFileSync(process.env.AMZGUARD_TEST_BODY_DIR+'/'+marker,'reading');return value;};
syncBuiltinESMExports();\n`);
  const port = await availablePort();
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temp, TZ: 'UTC', NODE_ENV: 'test',
    HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: '1', DASHBOARD_USERNAME: 'fixture-admin', DASHBOARD_PASSWORD: PASSWORD,
    DASHBOARD_SESSION_SECRET: 'fixture-dashboard-session-secret-with-at-least-32-characters', INGEST_TOKEN: 'fixture-ingest-token-with-at-least-32-characters',
    AMZGUARD_PRODUCT_UPLOAD_ENABLED: upload ? '1' : '0', AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED: '0',
    AMZGUARD_PRODUCT_UPLOAD_ADMIN_USERNAME: upload ? 'fixture-admin' : '',
    ZINIAO_COMPANY: 'fixture-company', ZINIAO_USERNAME: 'fixture-user', ZINIAO_PASSWORD: 'fixture-password',
    DINGTALK_WEBHOOK: 'https://notification.example.invalid/fixture', DINGTALK_SECRET: 'fixture-secret',
    DINGTALK_OPS_WEBHOOK: 'https://notification.example.invalid/fixture-ops', DINGTALK_OPS_SECRET: 'fixture-ops-secret',
    CRM_ENDPOINT: 'https://export.example.invalid/fixture', CRM_TOKEN: 'fixture-outbound-crm-token',
    ALERT_WEBHOOK_URL: 'https://notification.example.invalid/fixture-alert', ALERT_WEBHOOK_AUTHORIZATION: 'fixture-alert-token',
    AMZGUARD_CRM_CLIENT_ID: 'fixture-crm', AMZGUARD_CRM_API_TOKEN: CRM_TOKEN, AMZGUARD_CRM_STORE_KEYS: 'US-A',
    AMZGUARD_CRM_PUBLIC_ORIGIN: ORIGIN, AMZGUARD_CRM_CALLBACK_URL: 'https://crm.example.test/entry',
    AMZGUARD_TEST_NETWORK_LOG: path.join(temp, 'network-attempts'), AMZGUARD_TEST_SECURITY_LOG: path.join(temp, 'security-attempts'),
    AMZGUARD_TEST_PAYLOAD_LOG: path.join(temp, 'payload-attempts'), AMZGUARD_TEST_BODY_DIR: rendezvous };
  let child, exited, output = '';
  const request = (url, options = {}) => new Promise((resolve, reject) => {
    const headers = { Host: new URL(ORIGIN).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '192.0.2.10', ...options.headers };
    let data = options.body;
    if (data instanceof URLSearchParams) { data = data.toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (data !== undefined) headers['Content-Length'] = Buffer.byteLength(data);
    const outgoing = http.request(`http://127.0.0.1:${port}${url}`, { method: options.method || 'GET', headers }, incoming => {
      const chunks = [];
      incoming.on('data', value => chunks.push(value));
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
      });
      incoming.on('error', reject);
    });
    outgoing.on('error', reject); outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Isolated HTTP timed out'))); outgoing.end(data);
  });
  async function slowRequest(url, { method = 'POST', headers, bytes }) {
    const marker = crypto.randomUUID();
    let outgoing;
    const response = new Promise((resolve, reject) => {
      outgoing = http.request(`http://127.0.0.1:${port}${url}`, { method, headers: {
        Host: new URL(ORIGIN).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '192.0.2.10',
        ...headers, 'Content-Length': bytes.length, 'X-Fixture-Body-Rendezvous': marker,
      } }, incoming => {
        const chunks = []; incoming.on('data', value => chunks.push(value));
        incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers })));
        incoming.on('error', reject);
      });
      outgoing.on('error', reject); outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Slow fixture request timed out')));
      outgoing.write(bytes.subarray(0, 1));
    });
    response.catch(() => {});
    t.after(() => outgoing.destroy());
    // The child writes this marker when production code registers its body data
    // listener, after capturing the initial identity/store. No timing guess or
    // production test endpoint is needed to hold that exact asynchronous gap.
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (fs.existsSync(path.join(rendezvous, marker))) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(ready, 'server must enter its real body reader before the concurrent mutation');
    return { finish() { outgoing.end(bytes.subarray(1)); return response; } };
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref();
      try { await exited; } finally { clearTimeout(timer); }
    }
  }
  async function start() {
    child = spawn(process.execPath, ['--import', guard, 'src/server.js'], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit');
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break;
      try { if ((await request('/api/health')).status === 200) { ready = true; break; } } catch { /* loopback startup only */ }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(ready, `isolated server failed to start: ${output}`);
  }
  t.after(async () => {
    try {
      await stop();
      for (const key of ['AMZGUARD_TEST_NETWORK_LOG', 'AMZGUARD_TEST_SECURITY_LOG', 'AMZGUARD_TEST_PAYLOAD_LOG']) assert.equal(fs.existsSync(env[key]), false, key);
      assert.equal(fs.existsSync(path.join(out, 'channels')), false, 'configuration emitted a notification or CRM export');
      assert.equal(output.includes(CRM_TOKEN), false, 'server logged the CRM credential');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  await start();
  const login = async (username = 'fixture-admin') => {
    const response = await request('/login', { method: 'POST', body: new URLSearchParams({ username, password: PASSWORD }) });
    assert.equal(response.status, 303, await response.clone().text()); return cookie(response);
  };
  const admin = await login();
  const getStores = () => request('/api/admin/stores', { headers: { Cookie: admin } }).then(body);
  const getUi = (session = admin) => request('/api/ui-config', { headers: { Cookie: session } }).then(body);
  const mutation = (url, method, value, csrf, session = admin, extraHeaders = {}) => request(url, { method,
    headers: { Cookie: session, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Amzguard-CSRF': csrf, ...extraHeaders }, body: JSON.stringify(value) });
  const patch = async (key, changes, expectedRevision) => {
    const context = await getStores();
    return mutation(`/api/admin/stores/${encodeURIComponent(key)}`, 'PATCH', { expectedRevision: expectedRevision ?? context.revision, patch: changes }, context.csrfToken);
  };
  const create = async (store = NEW_STORE, expectedRevision) => {
    const context = await getStores();
    return mutation('/api/admin/stores', 'POST', { expectedRevision: expectedRevision ?? context.revision, store }, context.csrfToken);
  };
  const crmLogin = async () => {
    const start = await request('/crm/sso/start?storeKey=US-A&view=results');
    assert.equal(start.status, 303);
    const challengeId = new URL(start.headers.get('location')).searchParams.get('challengeId');
    const issued = await body(await request('/api/crm/v1/sso/tickets', { method: 'POST', headers: { Authorization: `Bearer ${CRM_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, subject: 'fixture-crm-user', storeKey: 'US-A', view: 'results' }) }), 201);
    const ticket = new URLSearchParams(new URL(issued.data.loginUrl).hash.slice(1)).get('ticket');
    const response = await request('/crm/sso/exchange', { method: 'POST', headers: { Cookie: cookie(start, '__Host-amzguard_crm_binding'), Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
    assert.equal(response.status, 200); return cookie(response, '__Host-amzguard_crm');
  };
  return { temp, out, storesFile, configFile, bootstrap, registryFile, uiFile, admin, request, slowRequest, login, getStores, getUi, mutation, patch, create, crmLogin,
    restart: async () => { await stop(); await start(); } };
}

test('administrator registry CRUD preserves bootstrap and legacy bindings, applies display names and survives restart', async t => {
  const f = await fixture(t);
  const initial = await f.getStores();
  assert.equal(initial.source, 'bootstrap'); assert.equal(initial.canManage, true); assert.ok(initial.csrfToken);
  assert.equal(initial.contentSHA, initial.revision.split(':')[1]);
  assert.ok(initial.options.markets.includes('US')); assert.ok(initial.options.hosts.includes('sellercentral.amazon.co.jp'));
  const legacy = initial.stores.find(store => store.key === 'LEGACY');
  assert.equal(legacy.id, ''); assert.equal(legacy.legacyBinding, true); assert.equal(legacy.adsNameContains, 'legacy-group');
  assert.doesNotMatch(JSON.stringify(initial), /PRIVATE_LEGACY_OAUTH|legacy-fixture|password|browserOauth/);
  assert.equal(fs.existsSync(f.registryFile), false);
  const created = await body(await f.create(), 201);
  assert.equal(created.source, 'managed');
  assert.equal(created.stores.find(store => store.key === 'US-NEW').enabled, false);
  assert.deepEqual(fs.readFileSync(f.storesFile), f.bootstrap.stores);
  assert.equal(fs.statSync(f.registryFile).mode & 0o777, 0o600);
  const display = 'Updated dashboard label';
  await body(await f.patch('US-A', { displayName: display }));
  const status = await body(await f.request('/api/status', { headers: { Cookie: f.admin } }));
  assert.equal(status.stores.find(store => store.key === 'US-A').name, display);
  assert.equal((await f.getStores()).stores.find(store => store.key === 'US-A').name, 'ZiNiao A');
  await body(await f.patch('LEGACY', { displayName: 'Historical profile' }));
  const document = JSON.parse(fs.readFileSync(f.registryFile, 'utf8'));
  const savedLegacy = document.stores.find(store => store.key === 'LEGACY');
  assert.equal(savedLegacy.id, 'PRIVATE_LEGACY_OAUTH'); assert.deepEqual(savedLegacy.paths, ['/legacy-fixture']);
  await body(await f.patch('US-NEW', { enabled: true, id: '104', market: 'JP', host: 'sellercentral.amazon.co.jp' }));
  const beforeRestart = await f.getStores();
  await f.restart();
  const afterRestart = await f.getStores();
  assert.equal(afterRestart.revision, beforeRestart.revision);
  assert.deepEqual(afterRestart.stores, beforeRestart.stores);
  assert.deepEqual(fs.readFileSync(f.storesFile), f.bootstrap.stores);
  assert.deepEqual(fs.readFileSync(f.configFile), f.bootstrap.config);
});

test('configuration permissions isolate operators and CRM identities and enforce CSRF, origin and method boundaries', async t => {
  const f = await fixture(t);
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  await body(await f.mutation('/api/users', 'POST', { username: 'fixture-operator', password: PASSWORD, role: 'operator' }, users.csrf), 201);
  const operator = await f.login('fixture-operator');
  const operatorUi = await f.getUi(operator);
  assert.equal(operatorUi.canManage, false); assert.ok(operatorUi.csrfToken);
  const adminStores = await f.getStores(), adminUi = await f.getUi();
  await error(await f.request('/api/admin/stores', { headers: { Cookie: operator } }), 403, 'CONFIG_ADMIN_REQUIRED');
  await error(await f.mutation('/api/admin/stores', 'POST', { expectedRevision: adminStores.revision, store: NEW_STORE }, operatorUi.csrfToken, operator), 403, 'CONFIG_ADMIN_REQUIRED');
  await error(await f.mutation('/api/admin/ui-config', 'PUT', { expectedRevision: adminUi.revision, settings: DEFAULTS }, operatorUi.csrfToken, operator), 403, 'CONFIG_ADMIN_REQUIRED');
  const crmCookie = await f.crmLogin();
  for (const endpoint of ['/api/admin/stores', '/api/ui-config']) {
    for (const headers of [{}, { Authorization: `Bearer ${CRM_TOKEN}` }, { Cookie: crmCookie }]) await error(await f.request(endpoint, { headers }), 401);
  }
  for (const extra of [{ 'X-Amzguard-CSRF': '' }, { 'X-Amzguard-CSRF': 'wrong' },
    { Origin: 'https://other.example.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    await error(await f.mutation('/api/admin/stores', 'POST', { expectedRevision: adminStores.revision, store: NEW_STORE }, adminStores.csrfToken, f.admin, extra), 403);
    await error(await f.mutation('/api/admin/ui-config', 'PUT', { expectedRevision: adminUi.revision, settings: DEFAULTS }, adminUi.csrfToken, f.admin, extra), 403);
  }
  for (const [endpoint, method, allow] of [['/api/admin/stores', 'DELETE', 'GET, POST'], ['/api/admin/stores/US-A', 'DELETE', 'PATCH'],
    ['/api/admin/ui-config', 'POST', 'PUT'], ['/api/ui-config', 'PUT', 'GET']]) {
    const response = await f.request(endpoint, { method, headers: { Cookie: f.admin } });
    assert.equal(response.headers.get('allow'), allow); await error(response, 405, 'CONFIG_METHOD_NOT_ALLOWED');
  }
  for (const endpoint of ['/api/admin/stores?unknown=1', '/api/ui-config?unknown=1']) await error(await f.request(endpoint, { headers: { Cookie: f.admin } }), 400, 'CONFIG_INVALID_QUERY');
  assert.equal(fs.existsSync(f.registryFile), false); assert.equal(fs.existsSync(f.uiFile), false);
});

test('store validation, unknown fields and optimistic revisions reject unsafe or stale writes without data loss', async t => {
  const f = await fixture(t);
  const initial = await f.getStores();
  for (const override of [{ key: '../escape' }, { name: '', id: '' }, { id: 'opaque-oauth' }, { id: 123 },
    { market: '' }, { host: '' }, { host: 'https://sellercentral.amazon.com' }, { host: 'sellercentral.amazon.com.evil.test' },
    { market: 'ZZ' }, { enabled: 'false' }, { password: 'PRIVATE_DO_NOT_STORE' }, { paths: ['/private'] }, { adsNameContains: 'new' }]) {
    await error(await f.create({ ...NEW_STORE, ...override }), 400, 'STORE_REGISTRY_INVALID');
  }
  for (const missing of ['market', 'host']) { const value = { ...NEW_STORE }; delete value[missing]; await error(await f.create(value), 400, 'STORE_REGISTRY_INVALID'); }
  await error(await f.patch('US-A', { key: 'CHANGED' }), 400, 'STORE_REGISTRY_INVALID');
  await error(await f.patch('MISSING', { displayName: 'missing' }), 404, 'STORE_REGISTRY_NOT_FOUND');
  await error(await f.mutation('/api/admin/stores/%ZZ', 'PATCH', { expectedRevision: initial.revision, patch: { displayName: 'bad' } }, initial.csrfToken), 400, 'CONFIG_INVALID_PATH');
  await error(await f.mutation('/api/admin/stores', 'POST', { expectedRevision: initial.revision, store: NEW_STORE, role: 'admin' }, initial.csrfToken), 400, 'CONFIG_INVALID_BODY');
  assert.equal(fs.existsSync(f.registryFile), false);
  await body(await f.create(), 201);
  await error(await f.patch('US-A', { displayName: 'stale' }, initial.revision), 409, 'STORE_REGISTRY_CONFLICT');
  await error(await f.create(), 409, 'STORE_REGISTRY_EXISTS');
  const revision = (await f.getStores()).revision;
  const outcomes = await Promise.all(['writer-one', 'writer-two'].map(displayName => f.patch('US-A', { displayName }, revision)));
  assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
  assert.ok(['writer-one', 'writer-two'].includes((await f.getStores()).stores.find(store => store.key === 'US-A').displayName));
  assert.equal(fs.existsSync(`${f.registryFile}.lock`), false);
  assert.deepEqual(fs.readFileSync(f.storesFile), f.bootstrap.stores);
});

test('store changes are hot-read without granting new CRM stores, and disabling an allowed store immediately revokes CRM access', async t => {
  const f = await fixture(t), crmCookie = await f.crmLogin();
  const crmHeaders = { Authorization: `Bearer ${CRM_TOKEN}` };
  await body(await f.create({ ...NEW_STORE, enabled: true }), 201);
  const dashboard = await body(await f.request('/api/status', { headers: { Cookie: f.admin } }));
  assert.ok(dashboard.stores.some(store => store.key === 'US-NEW'));
  const crm = await body(await f.request('/api/crm/v1/stores', { headers: crmHeaders }));
  assert.deepEqual(crm.data.map(store => store.storeKey), ['US-A']);
  const denied = await f.request('/api/crm/v1/stores/US-NEW/results', { headers: crmHeaders }); assert.equal(denied.status, 404);
  await body(await f.patch('US-A', { enabled: false }));
  assert.deepEqual((await body(await f.request('/api/crm/v1/stores', { headers: crmHeaders }))).data, []);
  assert.equal((await f.request('/crm/session', { headers: { Cookie: crmCookie } })).status, 403);
  assert.equal((await f.request('/api/crm/v1/stores/US-A/results', { headers: crmHeaders })).status, 404);
  const current = await body(await f.request('/api/status', { headers: { Cookie: f.admin } }));
  assert.equal(current.stores.some(store => store.key === 'US-A'), false);
});

test('an active run lease blocks binding and enable changes while display-only edits stay available', async t => {
  const f = await fixture(t);
  const lockFile = path.join(f.out, 'runtime/run.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ version: 1, pid: process.pid, token: 'fixture-active-lease', label: 'fixture-run', startedAt: new Date().toISOString() }), { mode: 0o600 });
  const lock = fs.readFileSync(lockFile);
  for (const patch of [{ name: 'Different profile' }, { id: '999' }, { market: 'JP' }, { host: 'sellercentral.amazon.co.jp' }, { enabled: false }]) {
    await error(await f.patch('US-A', patch), 409, 'CONFIG_RUN_ACTIVE');
  }
  await error(await f.create({ ...NEW_STORE, enabled: true }), 409, 'CONFIG_RUN_ACTIVE');
  await body(await f.patch('US-A', { displayName: 'Safe while collecting' }));
  await body(await f.create(), 201);
  await error(await f.patch('US-NEW', { enabled: true }), 409, 'CONFIG_RUN_ACTIVE');
  assert.deepEqual(fs.readFileSync(lockFile), lock);
  fs.unlinkSync(lockFile);
  await body(await f.patch('US-A', { id: '999' }));
  assert.equal(fs.existsSync(lockFile), false, 'configuration releases its own temporary lease');
});

test('pending and unknown upload metadata blocks binding or disablement without reading, expiring or changing payloads', async t => {
  const f = await fixture(t);
  const uploads = path.join(f.out, 'product-uploads'), jobs = path.join(uploads, 'jobs');
  const id = `upl_${'a'.repeat(32)}`, dir = path.join(jobs, id); fs.mkdirSync(dir, { recursive: true });
  const record = path.join(dir, 'record.json'), payload = path.join(dir, 'guarded-payload.csv');
  fs.writeFileSync(payload, 'synthetic-upload-bytes\n');
  for (const state of ['STAGED', 'QUEUED', 'PROCESSING', 'PREPARED', 'SUBMITTING', 'UNKNOWN']) {
    fs.writeFileSync(record, JSON.stringify({ version: 1, id, state, store: { key: 'US-A' }, expiresAt: '2001-01-01T00:00:00Z', payloadRelativePath: 'guarded-payload.csv' }));
    const before = snapshot(uploads);
    await error(await f.patch('US-A', { id: '998' }), 409, 'STORE_UPLOAD_PENDING');
    await error(await f.patch('US-A', { enabled: false }), 409, 'STORE_UPLOAD_PENDING');
    await body(await f.patch('US-A', { displayName: `Display during ${state}` }));
    assert.deepEqual(snapshot(uploads), before, `${state} must remain byte-for-byte unchanged even if expired by date`);
    assert.equal(fs.existsSync(path.join(f.out, 'runtime/run.lock')), false);
  }
  fs.writeFileSync(record, '{malformed metadata');
  const corrupt = snapshot(uploads);
  await error(await f.patch('US-A', { id: '998' }), 409, 'STORE_UPLOAD_EVIDENCE_INVALID');
  await error(await f.patch('US-A', { enabled: false }), 409, 'STORE_UPLOAD_EVIDENCE_INVALID');
  await body(await f.patch('US-A', { displayName: 'Display despite damaged upload metadata' }));
  assert.deepEqual(snapshot(uploads), corrupt);
  fs.writeFileSync(record, JSON.stringify({ version: 1, id, state: 'COMPLETED', store: { key: 'US-A' } }));
  const finished = snapshot(uploads);
  await body(await f.patch('US-A', { id: '998' }));
  assert.deepEqual(snapshot(uploads), finished);
});

test('UI configuration validates full settings and exact limits, persists privately, hot-loads and survives restart', async t => {
  const f = await fixture(t);
  const initial = await f.getUi();
  assert.equal(initial.source, 'bootstrap'); assert.deepEqual(initial.settings, DEFAULTS); assert.equal(initial.canManage, true); assert.ok(initial.csrfToken);
  assert.equal(fs.existsSync(f.uiFile), false);
  const save = async (settings, expectedRevision) => {
    const context = await f.getUi();
    return f.mutation('/api/admin/ui-config', 'PUT', { expectedRevision: expectedRevision ?? context.revision, settings }, context.csrfToken);
  };
  for (const settings of [{ reportRefreshSeconds: 30 }, { ...DEFAULTS, extra: 1 }, { ...DEFAULTS, defaultView: 'unknown' },
    ...Object.entries({ reportRefreshSeconds: [5, 300], progressRefreshSeconds: [1, 30], uploadRefreshSeconds: [5, 120], matrixPageSize: [1, 100], listPageSize: [1, 100] })
      .flatMap(([field, [min, max]]) => [min - 1, max + 1, min + 0.5, String(min)].map(value => ({ ...DEFAULTS, [field]: value })))]) {
    await error(await save(settings), 400, 'UI_CONFIG_INVALID');
  }
  const minimal = { reportRefreshSeconds: 5, progressRefreshSeconds: 1, uploadRefreshSeconds: 5, matrixPageSize: 1, listPageSize: 1, defaultView: 'overview' };
  await body(await save(minimal));
  const maximal = { reportRefreshSeconds: 300, progressRefreshSeconds: 30, uploadRefreshSeconds: 120, matrixPageSize: 100, listPageSize: 100, defaultView: 'stores' };
  const saved = await body(await save(maximal));
  assert.equal(saved.source, 'managed'); assert.deepEqual(saved.settings, maximal);
  assert.equal(fs.statSync(f.uiFile).mode & 0o777, 0o600);
  await error(await save(DEFAULTS, initial.revision), 409, 'UI_CONFIG_CONFLICT');
  assert.deepEqual((await f.getUi()).settings, maximal);
  await f.restart();
  const reread = await f.getUi(); assert.equal(reread.revision, saved.revision); assert.deepEqual(reread.settings, maximal);
  assert.deepEqual(fs.readFileSync(f.configFile), f.bootstrap.config);
  assert.equal(fs.existsSync(`${f.uiFile}.lock`), false);
});

test('bootstrap UI overrides and direct managed-file updates are read without restart; damaged managed files never fall back', async t => {
  const f = await fixture(t, { dashboard: { reportRefreshSeconds: 45, matrixPageSize: 12 } });
  assert.deepEqual((await f.getUi()).settings, { ...DEFAULTS, reportRefreshSeconds: 45, matrixPageSize: 12 });
  await body(await f.patch('US-A', { displayName: 'Managed first' }));
  const registry = JSON.parse(fs.readFileSync(f.registryFile, 'utf8'));
  registry.stores.find(store => store.key === 'US-A').displayName = 'External managed edit';
  fs.writeFileSync(f.registryFile, JSON.stringify(registry), { mode: 0o600 });
  assert.equal((await f.getStores()).stores.find(store => store.key === 'US-A').displayName, 'External managed edit');
  assert.equal((await body(await f.request('/api/status', { headers: { Cookie: f.admin } }))).stores.find(store => store.key === 'US-A').name, 'External managed edit');
  const ui = await f.getUi();
  await body(await f.mutation('/api/admin/ui-config', 'PUT', { expectedRevision: ui.revision, settings: DEFAULTS }, ui.csrfToken));
  fs.writeFileSync(f.uiFile, JSON.stringify({ version: 1, settings: { ...DEFAULTS, defaultView: 'system' } }), { mode: 0o600 });
  assert.equal((await f.getUi()).settings.defaultView, 'system');
  fs.writeFileSync(f.uiFile, '{corrupt managed ui');
  await error(await f.request('/api/ui-config', { headers: { Cookie: f.admin } }), 503, 'UI_CONFIG_CORRUPT');
  await error(await f.mutation('/api/admin/ui-config', 'PUT', { expectedRevision: ui.revision, settings: DEFAULTS }, ui.csrfToken), 503, 'UI_CONFIG_CORRUPT');
  assert.equal(fs.readFileSync(f.uiFile, 'utf8'), '{corrupt managed ui');
  const oldRegistry = await f.getStores();
  fs.writeFileSync(f.registryFile, '{corrupt managed stores');
  await error(await f.request('/api/admin/stores', { headers: { Cookie: f.admin } }), 503, 'STORE_REGISTRY_CORRUPT');
  await error(await f.mutation('/api/admin/stores/US-A', 'PATCH', { expectedRevision: oldRegistry.revision, patch: { displayName: 'must not restore' } }, oldRegistry.csrfToken), 503, 'STORE_REGISTRY_CORRUPT');
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), '{corrupt managed stores');
  assert.deepEqual(fs.readFileSync(f.storesFile), f.bootstrap.stores); assert.deepEqual(fs.readFileSync(f.configFile), f.bootstrap.config);
});

test('slow upload staging rechecks store binding, enablement and authorization while allowing display-only changes', async t => {
  const f = await fixture(t, { upload: true });
  const bytes = Buffer.from('sku,product-id\nFIXTURE-SKU,B012345678\n');
  const begin = async (uploadBytes = bytes) => {
    const context = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
    assert.equal(context.enabled, true); assert.equal(context.authorized, true);
    return f.slowRequest('/api/product-uploads/stage', { bytes: uploadBytes, headers: {
      Cookie: f.admin, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/octet-stream',
      'X-Amzguard-CSRF': context.csrf, 'X-Amzguard-Store-Key': 'US-A', 'X-Amzguard-File-Name': 'race-fixture.csv',
    } });
  };
  const jobsDir = path.join(f.out, 'product-uploads/jobs');
  for (const changes of [{ id: '202' }, { enabled: false }]) {
    const held = await begin();
    await body(await f.patch('US-A', changes));
    const denied = await error(await held.finish(), 409);
    assert.match(denied.error, /绑定|启用/);
    assert.deepEqual(snapshot(jobsDir), {}, 'changed binding/enablement must not leave a staged task');
    assert.equal(fs.existsSync(path.join(f.out, 'runtime/run.lock')), false);
  }
  await body(await f.patch('US-A', { enabled: true }));
  const cosmetic = await begin();
  await body(await f.patch('US-A', { displayName: 'Display updated while body arrives' }));
  const staged = await body(await cosmetic.finish(), 201);
  assert.equal(staged.job.state, 'STAGED');
  const jobDirs = fs.readdirSync(jobsDir); assert.equal(jobDirs.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(jobsDir, jobDirs[0], 'record.json'), 'utf8'));
  assert.equal(saved.state, 'STAGED'); assert.equal(saved.store.key, 'US-A'); assert.equal(saved.store.name, 'ZiNiao A');
  assert.equal((await f.getStores()).stores.find(store => store.key === 'US-A').id, '202');
  // No worker is started and the execution gate remains off. The one STAGED
  // fixture is intentionally local and unconfirmed; no Amazon write can occur.
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  await body(await f.mutation('/api/users', 'POST', { username: 'second-admin', password: PASSWORD, role: 'admin' }, users.csrf), 201);
  const second = await f.login('second-admin');
  const secondUsers = await body(await f.request('/api/users', { headers: { Cookie: second } }));
  const held = await begin(Buffer.from('sku,product-id\nFIXTURE-SECOND,B087654321\n'));
  const before = snapshot(path.join(f.out, 'product-uploads'));
  await body(await f.mutation('/api/users/fixture-admin', 'PATCH', { role: 'operator' }, secondUsers.csrf, second));
  await error(await held.finish(), 403);
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before, 'revoked upload role must not publish a new job');
});

test('a slow administrator configuration request cannot save after its role is revoked during body transfer', async t => {
  const f = await fixture(t);
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  await body(await f.mutation('/api/users', 'POST', { username: 'second-admin', password: PASSWORD, role: 'admin' }, users.csrf), 201);
  const second = await f.login('second-admin');
  const secondUsers = await body(await f.request('/api/users', { headers: { Cookie: second } }));
  const context = await f.getStores();
  const held = await f.slowRequest('/api/admin/stores/US-A', { method: 'PATCH',
    bytes: Buffer.from(JSON.stringify({ expectedRevision: context.revision, patch: { displayName: 'must never be saved' } })),
    headers: { Cookie: f.admin, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Amzguard-CSRF': context.csrfToken } });
  await body(await f.mutation('/api/users/fixture-admin', 'PATCH', { role: 'operator' }, secondUsers.csrf, second));
  await error(await held.finish(), 403, 'CONFIG_ADMIN_REQUIRED');
  assert.equal(fs.existsSync(f.registryFile), false);
  const current = await body(await f.request('/api/admin/stores', { headers: { Cookie: second } }));
  assert.equal(current.revision, context.revision);
  assert.equal(current.stores.find(store => store.key === 'US-A').displayName, 'Bootstrap A');
  assert.deepEqual(fs.readFileSync(f.storesFile), f.bootstrap.stores);
});
