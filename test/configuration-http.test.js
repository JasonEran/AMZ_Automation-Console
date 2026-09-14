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
import { beginProductUploadProcessing, finishProductUploadProcessing } from '../src/lib/product-upload-processing.js';
import { saveProductUploadReport } from '../src/lib/product-upload-report.js';

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

async function fixture(t, { dashboard = {}, stores = STORES, upload = false, clock = null } = {}) {
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
  const clockFile = path.join(temp, 'fixture-clock');
  if (clock !== null) fs.writeFileSync(clockFile, String(clock));
  const guard = path.join(temp, 'guard.mjs');
  fs.writeFileSync(guard, `import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https';
import net from 'node:net'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module';
if(process.env.AMZGUARD_TEST_CLOCK_FILE){const NativeDate=Date;const time=()=>Number(fs.readFileSync(process.env.AMZGUARD_TEST_CLOCK_FILE,'utf8'));
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[time()]));}static now(){return time();}};}
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
    AMZGUARD_TEST_PAYLOAD_LOG: path.join(temp, 'payload-attempts'), AMZGUARD_TEST_BODY_DIR: rendezvous,
    ...(clock !== null ? { AMZGUARD_TEST_CLOCK_FILE: clockFile } : {}) };
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
    setTime: value => { assert.notEqual(clock, null); assert.ok(Number.isSafeInteger(value)); fs.writeFileSync(clockFile, String(value)); },
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

test('shot access keeps upload diagnostics private for administrators and operators, including filesystem aliases', async t => {
  const f = await fixture(t, { upload: true });
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  await body(await f.mutation('/api/users', 'POST', { username: 'shot-operator', password: PASSWORD, role: 'operator' }, users.csrf), 201);
  const operator = await f.login('shot-operator');
  const privateRelative = `product-uploads/jobs/upl_${'a'.repeat(32)}/diagnostics/current.png`;
  const privateFile = path.join(f.out, privateRelative);
  const normalRelative = 'reviews/shots/normal.png', normalFile = path.join(f.out, normalRelative);
  const publicBytes = Buffer.from('fixture collector screenshot'), privateBytes = Buffer.from('PRIVATE_DIAGNOSTIC_BYTES');
  for (const file of [privateFile, normalFile]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(privateFile, privateBytes, { mode: 0o600 });
  fs.writeFileSync(normalFile, publicBytes, { mode: 0o600 });
  fs.symlinkSync(privateFile, path.join(f.out, 'reviews/shots/private-alias.png'));
  fs.symlinkSync(path.dirname(privateFile), path.join(f.out, 'reviews/private-dir'));
  const hardlinkSource = path.join(path.dirname(privateFile), 'hardlink-source.png');
  fs.writeFileSync(hardlinkSource, privateBytes, { mode: 0o600 });
  fs.linkSync(hardlinkSource, path.join(f.out, 'reviews/shots/private-hardlink.png'));
  // A request explicitly under the private namespace remains private even if
  // that path points at a normal screenshot outside the upload directory.
  fs.symlinkSync(normalFile, path.join(path.dirname(privateFile), 'public-alias.png'));
  const blocked = [privateRelative, `reviews/../${privateRelative}`, 'reviews/shots/private-alias.png',
    'reviews/private-dir/current.png', 'reviews/shots/private-hardlink.png',
    privateRelative.replace('current.png', 'public-alias.png')];
  for (const session of [f.admin, operator]) {
    for (const relative of blocked) {
      const response = await f.request(`/shot?f=${encodeURIComponent(relative)}`, { headers: { Cookie: session } });
      const denied = await error(response, 403);
      assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_DIAGNOSTIC_BYTES/);
    }
    const normal = await f.request(`/shot?f=${encodeURIComponent(normalRelative)}`, { headers: { Cookie: session } });
    assert.equal(normal.status, 200);
    assert.equal(normal.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await normal.arrayBuffer()), publicBytes);
  }
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
    // The other process can receive res.end() before the server's synchronous
    // finally runs. Wait briefly for cleanup, while still failing on a leak.
    const lockFile = path.join(f.out, 'runtime/run.lock');
    const cleanupDeadline = Date.now() + 1000;
    while (fs.existsSync(lockFile) && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(lockFile), false, 'rejected staging must release its run lock');
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

test('upload confirmation without a password requires the upload session, CSRF, exact phrase and staged file binding', async t => {
  const f = await fixture(t, { upload: true });
  const context = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  assert.deepEqual(context.modes, ['SIMPLE', 'STANDARD']);
  const bytes = Buffer.from([0x73, 0x6b, 0x75, 0x09, 0xe9, 0x0a]);
  const headers = { Cookie: f.admin, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/octet-stream', 'X-Amzguard-CSRF': context.csrf,
    'X-Amzguard-Store-Key': 'US-A', 'X-Amzguard-File-Name': 'feed.txt' };
  assert.equal((await f.request('/api/product-uploads/stage', { method: 'POST', headers: { ...headers, 'X-Amzguard-Upload-Mode': 'BYPASS' }, body: bytes })).status, 400);
  assert.equal((await f.request('/api/product-uploads/stage', { method: 'POST', headers, body: bytes })).status, 400);
  const { job } = await body(await f.request('/api/product-uploads/stage', { method: 'POST', headers: { ...headers, 'X-Amzguard-Upload-Mode': 'SIMPLE' }, body: bytes }), 201);
  assert.equal(job.mode, 'SIMPLE');
  assert.deepEqual(fs.readFileSync(path.join(f.out, 'product-uploads', 'jobs', job.id, 'payload.txt')), bytes);
  const recordFile = path.join(f.out, 'product-uploads', 'jobs', job.id, 'record.json');
  const record = JSON.parse(fs.readFileSync(recordFile));
  const confirm = { jobId: job.id, storeKey: job.store.key, size: job.file.size, sha256Short: job.file.sha256Short,
    confirmationChallenge: job.confirmationChallenge, phrase: job.confirmationPhrase };
  assert.equal(Object.hasOwn(confirm, 'password'), false);
  const uploads = path.join(f.out, 'product-uploads'), before = snapshot(uploads);
  await error(await f.mutation('/api/product-uploads/confirm', 'POST', confirm, context.csrf, ''), 401);
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  for (const role of ['operator', 'admin']) {
    const username = `confirmation-${role}`;
    await body(await f.mutation('/api/users', 'POST', { username, password: PASSWORD, role }, users.csrf), 201);
    const session = await f.login(username);
    const list = await body(await f.request('/api/product-uploads', { headers: { Cookie: session } }));
    assert.equal(list.authorized, false);
    await error(await f.mutation('/api/product-uploads/confirm', 'POST', confirm, list.csrf, session), 403);
  }
  await error(await f.mutation('/api/product-uploads/confirm', 'POST', confirm, '', f.admin), 403);
  await error(await f.mutation('/api/product-uploads/confirm', 'POST', confirm, context.csrf, f.admin,
    { Origin: 'https://other.example.test', 'Sec-Fetch-Site': 'cross-site' }), 403);
  for (const changes of [{ phrase: 'wrong' }, { phrase: undefined }, { storeKey: 'US-B' },
    { sha256Short: '0'.repeat(12) }, { size: confirm.size + 1 },
    { confirmationChallenge: `${confirm.confirmationChallenge}invalid` }]) {
    await error(await f.mutation('/api/product-uploads/confirm', 'POST', { ...confirm, ...changes }, context.csrf), 409);
    assert.deepEqual(snapshot(uploads), before);
  }
  const alteredSha = `${record.file.sha256.slice(0, -1)}${record.file.sha256.endsWith('0') ? '1' : '0'}`;
  for (const changes of [{ mode: 'STANDARD' }, { file: { ...record.file, sha256: alteredSha } }]) {
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, ...changes }));
    const altered = snapshot(uploads);
    await error(await f.mutation('/api/product-uploads/confirm', 'POST', confirm, context.csrf), 409);
    assert.deepEqual(snapshot(uploads), altered);
  }
  fs.writeFileSync(recordFile, JSON.stringify(record));
  const accepted = await body(await f.mutation('/api/product-uploads/confirm', 'POST', confirm, context.csrf), 202);
  assert.equal(accepted.job.state, 'QUEUED'); assert.equal(accepted.job.mode, 'SIMPLE');
  assert.equal(accepted.job.submittedAt, null);
  const queued = snapshot(uploads);
  await error(await f.mutation('/api/product-uploads/confirm', 'POST', confirm, context.csrf), 409);
  assert.deepEqual(snapshot(uploads), queued);
});

test('upload confirmation rechecks its session after a slow body and refuses a revoked upload role', async t => {
  const f = await fixture(t, { upload: true });
  const task = await resetUploadFixture(f, 'STAGED');
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  await body(await f.mutation('/api/users', 'POST', { username: 'confirmation-second-admin', password: PASSWORD, role: 'admin' }, users.csrf), 201);
  const second = await f.login('confirmation-second-admin');
  const secondUsers = await body(await f.request('/api/users', { headers: { Cookie: second } }));
  const confirmation = { jobId: task.job.id, storeKey: task.job.store.key, size: task.job.file.size,
    sha256Short: task.job.file.sha256Short, confirmationChallenge: task.job.confirmationChallenge,
    phrase: task.job.confirmationPhrase };
  const held = await f.slowRequest('/api/product-uploads/confirm', { bytes: Buffer.from(JSON.stringify(confirmation)), headers: {
    Cookie: f.admin, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Amzguard-CSRF': task.csrf,
  } });
  const before = snapshot(path.join(f.out, 'product-uploads'));
  await body(await f.mutation('/api/users/fixture-admin', 'PATCH', { role: 'operator' }, secondUsers.csrf, second));
  await error(await held.finish(), 403);
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before);
  await body(await f.request('/api/health'));
});

test('upload confirmation rejects non-object and malformed fields without terminating the Dashboard or changing jobs', async t => {
  const f = await fixture(t, { upload: true });
  const context = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  const before = snapshot(path.join(f.out, 'product-uploads'));
  for (const payload of [null, [], false, true, 1, '', 'text',
    { jobId: [] }, { phrase: {} },
    { storeKey: {} }, { sha256Short: [] }, { confirmationChallenge: {} }, { size: '1' }, { size: 0 }]) {
    await error(await f.mutation('/api/product-uploads/confirm', 'POST', payload, context.csrf), 400);
    await body(await f.request('/api/health'));
  }
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before);
});

test('upload confirmation at the exact 30-minute deadline expires the task without queueing or reporting acceptance', async t => {
  const f = await fixture(t, { upload: true, clock: Date.now() });
  const context = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  const bytes = Buffer.from('sku,product-id\nEXPIRY-FIXTURE,B012345678\n');
  const { job } = await body(await f.request('/api/product-uploads/stage', { method: 'POST', headers: {
    Cookie: f.admin, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/octet-stream',
    'X-Amzguard-CSRF': context.csrf, 'X-Amzguard-Store-Key': 'US-A', 'X-Amzguard-File-Name': 'expiry.csv',
  }, body: bytes }), 201);
  const recordFile = path.join(f.out, 'product-uploads', 'jobs', job.id, 'record.json');
  const staged = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(Date.parse(staged.expiresAt) - Date.parse(staged.createdAt), 30 * 60_000);
  f.setTime(Date.parse(staged.expiresAt));
  const rejected = await error(await f.mutation('/api/product-uploads/confirm', 'POST', {
    jobId: job.id, storeKey: job.store.key, size: job.file.size, sha256Short: job.file.sha256Short,
    confirmationChallenge: job.confirmationChallenge, phrase: job.confirmationPhrase,
  }, context.csrf), 409);
  assert.match(rejected.error, /过期/);
  assert.equal(rejected.job.state, 'EXPIRED');
  const expired = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(expired.state, 'EXPIRED');
  assert.equal(expired.confirmedAt, undefined);
  assert.equal(expired.submittedAt, undefined);
  assert.deepEqual(fs.readdirSync(path.join(f.out, 'product-uploads', 'queue')), []);
  await body(await f.request('/api/health'));
});

async function resetUploadFixture(f, state = 'UNKNOWN') {
  const context = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  const bytes = Buffer.from('sku,product-id\nRESET-FIXTURE,B012345678\n');
  const stage = () => f.request('/api/product-uploads/stage', { method: 'POST', headers: {
    Cookie: f.admin, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/octet-stream',
    'X-Amzguard-CSRF': context.csrf, 'X-Amzguard-Store-Key': 'US-A', 'X-Amzguard-File-Name': 'reset.csv',
    'X-Amzguard-Upload-Mode': 'SIMPLE',
  }, body: bytes });
  const { job } = await body(await stage(), 201);
  const recordFile = path.join(f.out, 'product-uploads', 'jobs', job.id, 'record.json');
  const staged = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  // Synthetic terminal metadata only: execution is disabled and no worker or
  // Amazon operation is started to manufacture a result for these tests.
  fs.writeFileSync(recordFile, JSON.stringify({ ...staged, state, updatedAt: new Date().toISOString() }));
  const list = await body(await f.request('/api/product-uploads?includeReset=1', { headers: { Cookie: f.admin } }));
  const current = list.jobs.find(value => value.id === job.id);
  assert.ok(current);
  return { bytes, stage, job: current, recordFile, csrf: list.csrf };
}

function resetPayload(job) {
  return { jobId: job.id, storeKey: job.store.key, sha256Short: job.file.sha256Short, size: job.file.size,
    resetChallenge: job.reset?.confirmationChallenge || 'fixture-no-terminal-challenge' };
}

test('upload reset requires upload authorization and same-origin CSRF while exposing only a reset challenge', async t => {
  const f = await fixture(t, { upload: true });
  const task = await resetUploadFixture(f);
  assert.equal(task.job.reset.eligible, true);
  assert.ok(task.job.reset.confirmationChallenge);
  assert.equal(task.job.reset.confirmationPhrase, undefined);
  const payload = resetPayload(task.job), before = snapshot(path.join(f.out, 'product-uploads'));
  await error(await f.mutation('/api/product-uploads/reset', 'POST', payload, task.csrf, ''), 401);
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  await body(await f.mutation('/api/users', 'POST', { username: 'reset-operator', password: PASSWORD, role: 'operator' }, users.csrf), 201);
  const operator = await f.login('reset-operator');
  const operatorList = await body(await f.request('/api/product-uploads?includeReset=1', { headers: { Cookie: operator } }));
  const operatorJob = operatorList.jobs.find(job => job.id === task.job.id);
  assert.ok(operatorJob);
  assert.equal(operatorJob.reset?.confirmationChallenge, undefined);
  await error(await f.mutation('/api/product-uploads/reset', 'POST', payload, operatorList.csrf, operator), 403);
  await error(await f.mutation('/api/product-uploads/reset', 'POST', payload, '', f.admin), 403);
  await error(await f.mutation('/api/product-uploads/reset', 'POST', payload, task.csrf, f.admin,
    { Origin: 'https://other.example.test', 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before);
  await body(await f.request('/api/health'));
});

test('upload reset rejects malformed input and stale or mismatched bindings without changing evidence', async t => {
  const f = await fixture(t, { upload: true });
  const task = await resetUploadFixture(f), payload = resetPayload(task.job);
  const uploads = path.join(f.out, 'product-uploads'), before = snapshot(uploads);
  for (const value of [null, [], { ...payload, jobId: {} }, { ...payload, storeKey: [] },
    { ...payload, sha256Short: null }, { ...payload, size: '1' }, { ...payload, size: 0 },
    { ...payload, resetChallenge: undefined }]) {
    await error(await f.mutation('/api/product-uploads/reset', 'POST', value, task.csrf), 400);
    assert.deepEqual(snapshot(uploads), before);
  }
  for (const changes of [{ storeKey: 'US-B' }, { sha256Short: '0'.repeat(12) },
    { size: payload.size + 1 }, { resetChallenge: `${payload.resetChallenge}invalid` }]) {
    await error(await f.mutation('/api/product-uploads/reset', 'POST', { ...payload, ...changes }, task.csrf), 409);
    assert.deepEqual(snapshot(uploads), before);
  }
  const original = fs.readFileSync(task.recordFile);
  const record = JSON.parse(original);
  const alteredSha = `${record.file.sha256.slice(0, -1)}${record.file.sha256.endsWith('0') ? '1' : '0'}`;
  for (const changes of [{ state: 'COMPLETED' }, { mode: 'STANDARD' }, { file: { ...record.file, sha256: alteredSha } }]) {
    fs.writeFileSync(task.recordFile, JSON.stringify({ ...JSON.parse(original), ...changes }));
    const altered = snapshot(uploads);
    await error(await f.mutation('/api/product-uploads/reset', 'POST', payload, task.csrf), 409);
    assert.deepEqual(snapshot(uploads), altered);
  }
  await body(await f.request('/api/health'));
});

test('upload reset rejects every active state and an occupied collector lease without deleting or queueing a task', async t => {
  const f = await fixture(t, { upload: true });
  const task = await resetUploadFixture(f), payload = resetPayload(task.job);
  const uploads = path.join(f.out, 'product-uploads'), original = fs.readFileSync(task.recordFile);
  for (const state of ['STAGED', 'QUEUED', 'PROCESSING', 'PREPARED', 'SUBMITTING']) {
    fs.writeFileSync(task.recordFile, JSON.stringify({ ...JSON.parse(original), state }));
    const list = await body(await f.request('/api/product-uploads?includeReset=1', { headers: { Cookie: f.admin } }));
    const active = list.jobs.find(job => job.id === task.job.id);
    assert.equal(active.reset.eligible, false);
    assert.equal(active.reset.confirmationChallenge, undefined);
    const before = snapshot(uploads);
    await error(await f.mutation('/api/product-uploads/reset', 'POST', payload, task.csrf), 409);
    assert.deepEqual(snapshot(uploads), before);
  }
  // A response can reach this process before the server finishes releasing
  // its lease. A subsequent request is a barrier before installing our lock.
  await body(await f.request('/api/health'));
  fs.writeFileSync(task.recordFile, original);
  const lockFile = path.join(f.out, 'runtime/run.lock');
  const lock = JSON.stringify({ version: 1, token: crypto.randomUUID(), pid: process.pid, label: 'fixture-existing-collector', startedAt: new Date().toISOString() });
  fs.writeFileSync(lockFile, lock, { flag: 'wx', mode: 0o600 });
  const before = snapshot(uploads);
  await error(await f.mutation('/api/product-uploads/reset', 'POST', payload, task.csrf), 409);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), lock);
  assert.deepEqual(snapshot(uploads), before);
  fs.unlinkSync(lockFile);
  const queueFile = path.join(uploads, 'queue', task.job.id);
  fs.writeFileSync(queueFile, `${task.job.id}\n`, { flag: 'wx', mode: 0o600 });
  const queued = snapshot(uploads);
  await error(await f.mutation('/api/product-uploads/reset', 'POST', payload, task.csrf), 409);
  assert.deepEqual(snapshot(uploads), queued);
});

test('upload reset without a password preserves UNKNOWN evidence and requires a separately confirmed new upload', async t => {
  const f = await fixture(t, { upload: true });
  const task = await resetUploadFixture(f), payload = resetPayload(task.job);
  assert.deepEqual(Object.keys(payload).sort(), ['jobId', 'resetChallenge', 'sha256Short', 'size', 'storeKey']);
  const original = fs.readFileSync(task.recordFile), originalMtime = fs.statSync(task.recordFile).mtimeMs;
  await error(await task.stage(), 400);
  const reset = await body(await f.mutation('/api/product-uploads/reset', 'POST', payload, task.csrf));
  assert.equal(reset.job.id, task.job.id);
  assert.equal(reset.job.state, 'UNKNOWN');
  assert.ok(reset.job.reset.resetAt);
  assert.equal(reset.job.reset.reason, '上传中心按钮手动重置重复上传');
  assert.equal(reset.job.reset.eligible, false);
  assert.equal(reset.job.reset.confirmationChallenge, undefined);
  assert.equal(reset.job.reset.confirmationPhrase, undefined);
  assert.deepEqual(fs.readFileSync(task.recordFile), original);
  assert.equal(fs.statSync(task.recordFile).mtimeMs, originalMtime);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(task.recordFile), 'payload.csv')), task.bytes);
  assert.deepEqual(fs.readdirSync(path.join(f.out, 'product-uploads', 'queue')), []);
  const resetSnapshot = snapshot(path.join(f.out, 'product-uploads'));
  await error(await f.mutation('/api/product-uploads/reset', 'POST', payload, task.csrf), 409);
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), resetSnapshot);
  const normal = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  assert.equal(normal.jobs.some(job => job.id === task.job.id), false);
  assert.equal(normal.resetCount, 1);
  const archived = await body(await f.request('/api/product-uploads?includeReset=1', { headers: { Cookie: f.admin } }));
  assert.equal(archived.jobs.find(job => job.id === task.job.id).state, 'UNKNOWN');
  assert.equal(archived.resetCount, 1);
  await error(await f.patch('US-A', { id: '909' }), 409, 'STORE_UPLOAD_PENDING');
  const fresh = await body(await task.stage(), 201);
  assert.notEqual(fresh.job.id, task.job.id);
  assert.equal(fresh.job.state, 'STAGED');
  assert.equal(fresh.job.file.sha256Short, task.job.file.sha256Short);
  assert.equal(fresh.job.confirmedAt, null);
  assert.equal(fresh.job.submittedAt, null);
  assert.ok(fresh.job.confirmationChallenge);
  assert.deepEqual(fs.readdirSync(path.join(f.out, 'product-uploads', 'queue')), []);
  const stagedSnapshot = snapshot(path.join(f.out, 'product-uploads'));
  const confirmation = { jobId: fresh.job.id, storeKey: fresh.job.store.key, size: fresh.job.file.size,
    sha256Short: fresh.job.file.sha256Short, confirmationChallenge: fresh.job.confirmationChallenge,
    phrase: fresh.job.confirmationPhrase };
  await error(await f.mutation('/api/product-uploads/confirm', 'POST', { ...confirmation, phrase: 'wrong' }, task.csrf), 409);
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), stagedSnapshot);
  await error(await task.stage(), 400);
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), stagedSnapshot);
  const accepted = await body(await f.mutation('/api/product-uploads/confirm', 'POST', confirmation, task.csrf), 202);
  assert.equal(accepted.job.state, 'QUEUED');
  assert.deepEqual(fs.readFileSync(task.recordFile), original);
});

test('upload reset rechecks authorization after a slow body and cannot publish a reset with a revoked session', async t => {
  const f = await fixture(t, { upload: true });
  const task = await resetUploadFixture(f);
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  await body(await f.mutation('/api/users', 'POST', { username: 'reset-second-admin', password: PASSWORD, role: 'admin' }, users.csrf), 201);
  const second = await f.login('reset-second-admin');
  const secondUsers = await body(await f.request('/api/users', { headers: { Cookie: second } }));
  const held = await f.slowRequest('/api/product-uploads/reset', { bytes: Buffer.from(JSON.stringify(resetPayload(task.job))), headers: {
    Cookie: f.admin, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Amzguard-CSRF': task.csrf,
  } });
  const before = snapshot(path.join(f.out, 'product-uploads'));
  await body(await f.mutation('/api/users/fixture-admin', 'PATCH', { role: 'operator' }, secondUsers.csrf, second));
  await error(await held.finish(), 403);
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before);
  await body(await f.request('/api/health'));
});

async function processingUploadFixture(f) {
  const task = await resetUploadFixture(f, 'COMPLETED');
  const record = JSON.parse(fs.readFileSync(task.recordFile));
  record.finishedAt = new Date().toISOString();
  record.result = { code: 'AMAZON_ACCEPTED_UPLOAD', center: { version: 1,
    receipt: { status: 'ACCEPTED', evidence: 'UPLOAD_STATUS_ROW' },
    identifiers: { availability: 'PARTIAL', batchId: 'fixture-processing-batch', submissionId: null },
    processing: { availability: 'NOT_AVAILABLE', status: 'UNKNOWN' } } };
  // Synthetic accepted receipt only. No upload worker or Amazon browser runs.
  fs.writeFileSync(task.recordFile, JSON.stringify(record));
  const list = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  return { ...task, record, job: list.jobs.find(job => job.id === task.job.id),
    processingFile: path.join(path.dirname(task.recordFile), 'processing', 'current.json') };
}

test('upload processing refresh requires upload authorization, same-origin CSRF and a single typed job ID', async t => {
  const f = await fixture(t, { upload: true }), task = await processingUploadFixture(f);
  const payload = { jobId: task.job.id }, before = snapshot(path.join(f.out, 'product-uploads'));
  assert.equal(task.job.processingRefresh.eligible, true);
  await error(await f.mutation('/api/product-uploads/refresh', 'POST', payload, task.csrf, ''), 401);
  await error(await f.request('/api/product-uploads/refresh', { method: 'POST',
    headers: { Authorization: `Bearer ${CRM_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), 401);
  const crm = await f.crmLogin();
  await error(await f.mutation('/api/product-uploads/refresh', 'POST', payload, task.csrf, crm), 401);
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  for (const role of ['operator', 'admin']) {
    const username = `processing-${role}`;
    await body(await f.mutation('/api/users', 'POST', { username, password: PASSWORD, role }, users.csrf), 201);
    const session = await f.login(username);
    const list = await body(await f.request('/api/product-uploads', { headers: { Cookie: session } }));
    assert.equal(list.jobs.find(job => job.id === task.job.id).processingRefresh.eligible, false);
    await error(await f.mutation('/api/product-uploads/refresh', 'POST', payload, list.csrf, session), 403);
  }
  await error(await f.mutation('/api/product-uploads/refresh', 'POST', payload, ''), 403);
  await error(await f.mutation('/api/product-uploads/refresh', 'POST', payload, task.csrf, f.admin,
    { Origin: 'https://other.example.test', 'Sec-Fetch-Site': 'cross-site' }), 403);
  await error(await f.request('/api/product-uploads/refresh', { headers: { Cookie: f.admin } }), 405);
  for (const value of [null, [], {}, { jobId: [task.job.id] }, { jobId: {} },
    { jobId: '../record.json' }, { ...payload, batchId: 'other-batch' }, { ...payload, storeKey: 'US-B' }]) {
    await error(await f.mutation('/api/product-uploads/refresh', 'POST', value, task.csrf), 400);
  }
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before);
});

test('upload processing refresh refuses unknown results, changed store bindings, disabled stores and a busy lease', async t => {
  const f = await fixture(t, { upload: true }), task = await processingUploadFixture(f);
  const original = fs.readFileSync(task.recordFile), payload = { jobId: task.job.id };
  fs.writeFileSync(task.recordFile, JSON.stringify({ ...task.record, state: 'UNKNOWN' }));
  await error(await f.mutation('/api/product-uploads/refresh', 'POST', payload, task.csrf), 409);
  fs.writeFileSync(task.recordFile, original);
  for (const patch of [{ id: '909' }, { enabled: false }]) {
    await body(await f.patch('US-A', patch));
    await error(await f.mutation('/api/product-uploads/refresh', 'POST', payload, task.csrf), 409);
    const current = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
    assert.equal(current.jobs.find(job => job.id === task.job.id).processingRefresh.eligible, false);
    await body(await f.patch('US-A', { id: '101', enabled: true }));
  }
  const lockFile = path.join(f.out, 'runtime/run.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const lock = JSON.stringify({ pid: process.pid, token: 'processing-fixture-lock', label: 'fixture-active-run' });
  fs.writeFileSync(lockFile, lock, { mode: 0o600, flag: 'wx' });
  await error(await f.mutation('/api/product-uploads/refresh', 'POST', payload, task.csrf), 409);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), lock);
  assert.equal(fs.existsSync(task.processingFile), false);
  assert.deepEqual(fs.readFileSync(task.recordFile), original);
  fs.unlinkSync(lockFile);
});

test('upload processing refresh queues idempotently and exposes bound partial results without changing the upload ledger', async t => {
  const f = await fixture(t, { upload: true }), task = await processingUploadFixture(f);
  const original = fs.readFileSync(task.recordFile), payload = { jobId: task.job.id };
  const queued = await body(await f.mutation('/api/product-uploads/refresh', 'POST', payload, task.csrf), 202);
  assert.equal(queued.job.state, 'COMPLETED'); assert.equal(queued.job.processingRefresh.queued, true);
  const pending = fs.readFileSync(task.processingFile);
  await body(await f.mutation('/api/product-uploads/refresh', 'POST', payload, task.csrf), 202);
  assert.deepEqual(fs.readFileSync(task.processingFile), pending);
  // Let the server finish its synchronous lease cleanup before fixture-only
  // model writes. This never starts the browser or the upload worker.
  await body(await f.request('/api/health'));
  const options = { outDir: f.out, jobId: task.job.id }, attempt = beginProductUploadProcessing(options);
  finishProductUploadProcessing({ ...options, attemptId: attempt.attemptId,
    snapshot: { version: 1, source: 'AMAZON_UPLOAD_STATUS_ROW', batchId: 'fixture-processing-batch',
      status: 'PROCESSING', processingState: 'IN_PROGRESS', statusText: 'Processing',
      counts: { submitted: 3, success: 1, failed: null, warning: null } } });
  let list = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  let job = list.jobs.find(row => row.id === task.job.id);
  assert.equal(job.resultCenter.receipt.status, 'ACCEPTED');
  assert.equal(job.resultCenter.processing.status, 'PROCESSING');
  assert.deepEqual(job.resultCenter.counts, { submitted: 3, success: 1, failed: null, warning: null, availability: 'PARTIAL' });
  assert.equal(list.resultSummary.processing, 1);
  assert.equal(job.processingRefresh.lastAttempt.status, 'SUCCEEDED');
  const encoded = JSON.stringify(list);
  assert.equal(encoded.includes(task.record.file.sha256), false);
  assert.equal(encoded.includes(task.record.store.bindingFingerprint), false);
  assert.doesNotMatch(encoded, /recordSHA256|bindingFingerprint|current\.json|record\.json/);
  const failed = beginProductUploadProcessing(options);
  finishProductUploadProcessing({ ...options, attemptId: failed.attemptId, errorCode: 'PROCESSING_PAGE_UNAVAILABLE' });
  list = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  job = list.jobs.find(row => row.id === task.job.id);
  assert.equal(job.processingRefresh.lastAttempt.status, 'FAILED');
  assert.equal(job.processingRefresh.snapshot.counts.success, 1);
  assert.equal(job.processingRefresh.lastAttempt.errorCode, 'PROCESSING_PAGE_UNAVAILABLE');
  assert.deepEqual(fs.readFileSync(task.recordFile), original);
  assert.deepEqual(fs.readdirSync(path.join(f.out, 'product-uploads', 'queue')), []);
  fs.writeFileSync(task.processingFile, '{broken processing sidecar');
  list = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  job = list.jobs.find(row => row.id === task.job.id);
  assert.equal(job.processingRefresh.eligible, false);
  assert.ok(job.processingRefresh.problem);
  assert.equal(job.resultCenter.receipt.status, 'ACCEPTED');
  assert.equal(job.resultCenter.processing.status, 'UNKNOWN');
  assert.deepEqual(fs.readFileSync(task.recordFile), original);
});

test('upload processing refresh rechecks authorization after a slow request body', async t => {
  const f = await fixture(t, { upload: true }), task = await processingUploadFixture(f);
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  await body(await f.mutation('/api/users', 'POST', { username: 'processing-second-admin', password: PASSWORD, role: 'admin' }, users.csrf), 201);
  const second = await f.login('processing-second-admin');
  const secondUsers = await body(await f.request('/api/users', { headers: { Cookie: second } }));
  const held = await f.slowRequest('/api/product-uploads/refresh', { bytes: Buffer.from(JSON.stringify({ jobId: task.job.id })),
    headers: { Cookie: f.admin, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Amzguard-CSRF': task.csrf } });
  const before = snapshot(path.join(f.out, 'product-uploads'));
  await body(await f.mutation('/api/users/fixture-admin', 'PATCH', { role: 'operator' }, secondUsers.csrf, second));
  await error(await held.finish(), 403);
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before);
});

async function processingReportFixture(f) {
  const task = await processingUploadFixture(f), options = { outDir: f.out, jobId: task.job.id };
  const attempt = beginProductUploadProcessing(options), bytes = Buffer.from('sku,processing-result\nSYNTHETIC,ACCEPTED\n');
  const report = saveProductUploadReport({ ...options, attemptId: attempt.attemptId, buffer: bytes, extension: '.csv' });
  finishProductUploadProcessing({ ...options, attemptId: attempt.attemptId,
    snapshot: { source: 'AMAZON_UPLOAD_STATUS_ROW', batchId: 'fixture-processing-batch', status: 'COMPLETED',
      counts: { submitted: 1, success: 1, failed: null, warning: null } } });
  return { ...task, bytes, report, url: `/api/product-uploads/report?jobId=${task.job.id}`,
    reportFile: path.join(path.dirname(task.processingFile), 'reports', `${report.sha256}.csv`) };
}

test('a demoted upload administrator cannot regain upload or report access by signing in again', async t => {
  const f = await fixture(t, { upload: true }), task = await processingReportFixture(f);
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  await body(await f.mutation('/api/users', 'POST', { username: 'role-reviewer', password: PASSWORD, role: 'admin' }, users.csrf), 201);
  const second = await f.login('role-reviewer');
  const secondUsers = await body(await f.request('/api/users', { headers: { Cookie: second } }));
  const before = snapshot(path.join(f.out, 'product-uploads'));
  await body(await f.mutation('/api/users/fixture-admin', 'PATCH', { role: 'operator' }, secondUsers.csrf, second));
  await error(await f.request(task.url, { headers: { Cookie: f.admin } }), 401);
  const downgraded = await f.login('fixture-admin');
  const list = await body(await f.request('/api/product-uploads', { headers: { Cookie: downgraded } }));
  assert.equal(list.authorized, false);
  assert.equal(list.jobs.find(job => job.id === task.job.id).processingRefresh.eligible, false);
  assert.notEqual(list.jobs.find(job => job.id === task.job.id).resultCenter.processingReport?.availability, 'AVAILABLE');
  await error(await f.request(task.url, { headers: { Cookie: downgraded } }), 403);
  for (const action of ['stage', 'confirm', 'reset', 'refresh']) {
    await error(await f.mutation(`/api/product-uploads/${action}`, 'POST', { jobId: task.job.id }, list.csrf, downgraded), 403);
  }
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before, 'permission checks do not change upload records, requests or reports');
  await body(await f.mutation('/api/users/fixture-admin', 'PATCH', { role: 'admin' }, secondUsers.csrf, second));
  const restored = await f.login('fixture-admin');
  assert.equal((await body(await f.request('/api/product-uploads', { headers: { Cookie: restored } }))).authorized, true);
  const downloaded = await f.request(task.url, { headers: { Cookie: restored } });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), task.bytes);
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before);
});

test('upload processing report download requires the local upload role and rejects CRM identities and extra queries', async t => {
  const f = await fixture(t, { upload: true }), task = await processingReportFixture(f);
  const before = snapshot(path.join(f.out, 'product-uploads'));
  await error(await f.request(task.url), 401);
  await error(await f.request(task.url, { headers: { Authorization: `Bearer ${CRM_TOKEN}` } }), 401);
  await error(await f.request(task.url, { headers: { Cookie: await f.crmLogin() } }), 401);
  const users = await body(await f.request('/api/users', { headers: { Cookie: f.admin } }));
  for (const role of ['operator', 'admin']) {
    const username = `report-${role}`;
    await body(await f.mutation('/api/users', 'POST', { username, password: PASSWORD, role }, users.csrf), 201);
    const session = await f.login(username);
    await error(await f.request(task.url, { headers: { Cookie: session } }), 403);
    const list = await body(await f.request('/api/product-uploads', { headers: { Cookie: session } }));
    assert.equal(list.jobs.find(job => job.id === task.job.id).resultCenter.processingReport.url, null);
  }
  for (const query of ['', `?jobId=${task.job.id}&jobId=${task.job.id}`, '?jobId=../record.json',
    `?jobId=${task.job.id}&batchId=other`, `?jobId=${task.job.id}&path=record.json`]) {
    await error(await f.request(`/api/product-uploads/report${query}`, { headers: { Cookie: f.admin } }), 400);
  }
  const wrongMethod = await f.request(task.url, { method: 'POST', headers: { Cookie: f.admin } });
  await error(wrongMethod, 405); assert.equal(wrongMethod.headers.get('allow'), 'GET');
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before);
});

test('upload processing report is an authenticated no-store attachment with exact bytes and safe public metadata', async t => {
  const f = await fixture(t, { upload: true }), task = await processingReportFixture(f);
  const original = fs.readFileSync(task.recordFile);
  const response = await f.request(task.url, { headers: { Cookie: f.admin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="processing-fixture-processing-batch.csv"');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-length'), String(task.bytes.length));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(downloaded, task.bytes);
  assert.equal(crypto.createHash('sha256').update(downloaded).digest('hex'), task.report.sha256);
  const list = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  const job = list.jobs.find(row => row.id === task.job.id), report = job.resultCenter.processingReport;
  assert.equal(report.url, task.url); assert.equal(report.availability, 'AVAILABLE');
  assert.equal(report.sha256, task.report.sha256); assert.equal(report.size, task.bytes.length);
  assert.doesNotMatch(JSON.stringify(report), /binding|recordSHA|Fingerprint|current\.json|product-uploads\/jobs|buffer/);
  assert.equal(JSON.stringify(list).includes(task.record.file.sha256), false);
  assert.equal(JSON.stringify(list).includes(task.record.store.bindingFingerprint), false);
  assert.deepEqual(fs.readFileSync(task.recordFile), original);
  assert.deepEqual(fs.readdirSync(path.join(f.out, 'product-uploads', 'queue')), []);
});

test('upload processing report rejects changed evidence and cannot bypass download authorization through shot aliases', async t => {
  const f = await fixture(t, { upload: true }), task = await processingReportFixture(f);
  const relative = path.relative(f.out, task.reportFile), alias = path.join(f.out, 'report-alias.png');
  await error(await f.request(`/shot?f=${encodeURIComponent(relative)}`, { headers: { Cookie: f.admin } }), 403);
  fs.symlinkSync(task.reportFile, alias);
  await error(await f.request('/shot?f=report-alias.png', { headers: { Cookie: f.admin } }), 403);
  fs.unlinkSync(alias); fs.linkSync(task.reportFile, alias);
  await error(await f.request('/shot?f=report-alias.png', { headers: { Cookie: f.admin } }), 403);
  await error(await f.request(task.url, { headers: { Cookie: f.admin } }), 409);
  fs.unlinkSync(alias);
  const changed = Buffer.from(task.bytes); changed[0] ^= 1; fs.writeFileSync(task.reportFile, changed);
  await error(await f.request(task.url, { headers: { Cookie: f.admin } }), 409);
  let list = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  assert.ok(list.jobs.find(job => job.id === task.job.id).reportProblem);
  assert.equal(list.jobs.find(job => job.id === task.job.id).resultCenter.receipt.status, 'ACCEPTED');
  fs.writeFileSync(task.reportFile, task.bytes); fs.appendFileSync(task.recordFile, '\n');
  await error(await f.request(task.url, { headers: { Cookie: f.admin } }), 409);
  fs.writeFileSync(task.recordFile, JSON.stringify(task.record)); fs.unlinkSync(task.reportFile);
  await error(await f.request(task.url, { headers: { Cookie: f.admin } }), 404);
  list = await body(await f.request('/api/product-uploads', { headers: { Cookie: f.admin } }));
  assert.equal(list.jobs.find(job => job.id === task.job.id).resultCenter.processingReport.url, null);
});

test('upload processing report downloads XLSM as the original attachment while XLSM upload input remains forbidden', async t => {
  const f = await fixture(t, { upload: true }), task = await processingUploadFixture(f);
  // Minimal synthetic ZIP structure only; no real report, workbook rows or VBA.
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50);
  const entries = ['[Content_Types].xml', 'xl/workbook.xml'].map(name => {
    const text = Buffer.from(name), entry = Buffer.alloc(46 + text.length);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(text.length, 28); text.copy(entry, 46); return entry;
  });
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  const bytes = Buffer.concat([local, ...entries, end]), options = { outDir: f.out, jobId: task.job.id };
  const attempt = beginProductUploadProcessing(options);
  const saved = saveProductUploadReport({ ...options, attemptId: attempt.attemptId, buffer: bytes, extension: '.xlsm' });
  finishProductUploadProcessing({ ...options, attemptId: attempt.attemptId, errorCode: 'FIXTURE_READ_FINISHED' });
  const response = await f.request(`/api/product-uploads/report?jobId=${task.job.id}`, { headers: { Cookie: f.admin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.ms-excel.sheet.macroEnabled.12');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="processing-fixture-processing-batch.xlsm"');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(downloaded, bytes);
  assert.equal(crypto.createHash('sha256').update(downloaded).digest('hex'), saved.sha256);
  const before = snapshot(path.join(f.out, 'product-uploads'));
  const rejected = await error(await f.request('/api/product-uploads/stage', { method: 'POST', headers: {
    Cookie: f.admin, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/octet-stream',
    'X-Amzguard-CSRF': task.csrf, 'X-Amzguard-Store-Key': 'US-A', 'X-Amzguard-File-Name': 'fixture-input.xlsm',
    'X-Amzguard-Upload-Mode': 'STANDARD',
  }, body: bytes }), 400);
  assert.match(rejected.error, /不支持的文件格式/);
  await body(await f.request('/api/health'));
  assert.deepEqual(snapshot(path.join(f.out, 'product-uploads')), before);
});
