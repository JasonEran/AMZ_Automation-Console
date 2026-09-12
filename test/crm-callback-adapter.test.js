import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import test, { after } from 'node:test';
import { createCrmCallbackHandler } from '../src/crm/callback-adapter.js';

// Every upstream call in this file is an injected mock. Even an accidental
// fallback to native fetch or a network client must fail before opening a socket.
let outboundAttempts = 0;
const blocked = () => { outboundAttempts++; throw new Error('Adapter tests forbid external network'); };
const saved = [globalThis.fetch, http.request, http.get, https.request, https.get,
  net.connect, net.createConnection, net.Socket.prototype.connect, tls.connect];
globalThis.fetch = http.request = http.get = https.request = https.get = blocked;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = blocked;
syncBuiltinESMExports();
after(() => {
  [globalThis.fetch, http.request, http.get, https.request, https.get,
    net.connect, net.createConnection, net.Socket.prototype.connect, tls.connect] = saved;
  syncBuiltinESMExports();
  assert.equal(outboundAttempts, 0, 'no real outgoing connection may be attempted');
});

const CALLBACK = 'https://crm.example.test/monitor-entry';
const ORIGIN = 'https://monitor.example.test';
const TOKEN = 'fixture-only-monitor-bearer-with-more-than-32-characters';
const SUBJECT = 'fixture-private-user-identity';
const TIME = Date.parse('2026-09-12T04:00:00.000Z');
const CHALLENGE = 'c'.repeat(43);
const TICKET = 't'.repeat(43);
const QUERY = `challengeId=${CHALLENGE}&storeKey=US-A&view=data&checkId=reviews`;
const request = (query = QUERY, options) => new Request(`${CALLBACK}?${query}`, options);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function responseData(data = {}) {
  return { apiVersion: '1.0', requestId: '11111111-1111-4111-8111-111111111111',
    generatedAt: new Date(TIME).toISOString(), data: {
      loginUrl: `${ORIGIN}/crm/sso#ticket=${TICKET}`,
      expiresAt: new Date(TIME + 60_000).toISOString(), singleUse: true, ...data,
    } };
}
const signed = data => Response.json(responseData(data), { status: 201 });

function fixture(overrides = {}) {
  const calls = { identify: [], authorize: [], fetch: [] };
  const options = {
    callbackUrl: CALLBACK, monitorOrigin: ORIGIN, apiToken: TOKEN, now: () => TIME,
    identifyUser: (incoming, context) => { calls.identify.push([incoming, context]); return { subject: SUBJECT }; },
    authorizeStore: (identity, storeKey, context) => { calls.authorize.push([identity, storeKey, context]); return true; },
    fetchImpl: async (url, init) => { calls.fetch.push([url, init]); return signed(); },
    ...overrides,
  };
  return { options, calls, handler: createCrmCallbackHandler(options) };
}

async function problem(response, status, kind) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('location'), null);
  const text = await response.text();
  for (const secret of [TOKEN, SUBJECT, CHALLENGE, TICKET, 'private-cookie', 'PRIVATE_UPSTREAM_BODY']) {
    assert.equal(text.includes(secret), false, `error leaked ${secret}`);
  }
  const body = JSON.parse(text);
  assert.equal(body.status, status);
  assert.equal(body.code, `CRM_CALLBACK_${kind}`);
  assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  return body;
}

test('adapter requires explicit real identity/authorization hooks and fixed HTTPS configuration', () => {
  const base = fixture().options;
  for (const override of [
    { identifyUser: undefined }, { identifyUser: true }, { authorizeStore: undefined }, { authorizeStore: {} },
    { callbackUrl: 'http://crm.example.test/monitor-entry' }, { callbackUrl: `${CALLBACK}?returnUrl=x` },
    { callbackUrl: `${CALLBACK}#` }, { callbackUrl: `${CALLBACK}?` }, { callbackUrl: ` ${CALLBACK}` },
    { callbackUrl: 'https://user:secret@crm.example.test/entry' },
    { monitorOrigin: 'http://monitor.example.test' }, { monitorOrigin: `${ORIGIN}/path` },
    { monitorOrigin: `${ORIGIN}?x=y` }, { monitorOrigin: `https://user:secret@monitor.example.test` },
    { apiToken: '' }, { apiToken: 'short' }, { apiToken: 'a'.repeat(513) }, { apiToken: `${TOKEN}\r\nInjected: true` },
    { timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: 1.5 }, { now: 0 }, { fetchImpl: null },
  ]) assert.throws(() => createCrmCallbackHandler({ ...base, ...override }), TypeError);
  assert.throws(() => createCrmCallbackHandler(), TypeError);
});

test('callback validates canonical request URL and method before any authentication or signing', async () => {
  const f = fixture();
  for (const url of [
    `http://crm.example.test/monitor-entry?${QUERY}`, `https://other.example.test/monitor-entry?${QUERY}`,
    `https://crm.example.test/another?${QUERY}`, `${CALLBACK}?${QUERY}#fragment`,
    `${CALLBACK}?${QUERY}&padding=${'x'.repeat(4100)}`,
  ]) await problem(await f.handler(new Request(url)), 400, 'INPUT');
  const wrongMethod = await f.handler(request(QUERY, { method: 'POST', body: '{}' }));
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  await problem(wrongMethod, 405, 'METHOD');
  await problem(await f.handler({ url: CALLBACK, method: 'GET' }), 400, 'INPUT');
  assert.deepEqual(f.calls, { identify: [], authorize: [], fetch: [] });
});

test('strict query parsing rejects missing, duplicate, unknown and malformed fields with zero signing calls', async () => {
  const f = fixture();
  for (const query of [
    '', `storeKey=US-A&view=data`, `challengeId=${CHALLENGE}&view=data`, `challengeId=${CHALLENGE}&storeKey=US-A`,
    QUERY.replace(CHALLENGE, 'bad'), QUERY.replace('US-A', '*'), QUERY.replace('view=data', 'view=admin'),
    QUERY.replace('checkId=reviews', 'checkId=intelligence'), QUERY.replace('checkId=reviews', 'checkId='),
    QUERY.replace('US-A', '%ZZ'), QUERY.replace('US-A', '%00'), `${QUERY}&storeKey=US-B`,
    `${QUERY}&challengeId=${CHALLENGE}`, `${QUERY}&subject=${SUBJECT}`, `${QUERY}&callbackUrl=https://other.example.test`,
    `${QUERY}&returnUrl=https://other.example.test`, `${QUERY}&token=${TOKEN}`,
  ]) await problem(await f.handler(request(query)), 400, 'INPUT');
  assert.deepEqual(f.calls, { identify: [], authorize: [], fetch: [] });
});

test('missing login and invalid identity/subject shapes cannot reach store authorization or signing', async () => {
  for (const identity of [null, undefined, false, 'user', [], {}, { subject: 1 }, { subject: '' },
    { subject: ` ${SUBJECT}` }, { subject: `${SUBJECT}\n` }, { subject: 'x'.repeat(129) },
    Object.create({ subject: SUBJECT }), Object.defineProperty({}, 'subject', { get() { throw new Error(TOKEN); } }),
  ]) {
    const f = fixture({ identifyUser: () => identity });
    await problem(await f.handler(request()), identity === null ? 401 : 503, identity === null ? 'LOGIN_REQUIRED' : 'AUTH_UNAVAILABLE');
    assert.equal(f.calls.authorize.length, 0);
    assert.equal(f.calls.fetch.length, 0);
  }
});

test('store permission must be exactly true and authorization errors never expose identity or credentials', async () => {
  for (const value of [false, undefined, null, 1, 'true', {}, [], Promise.resolve('yes')]) {
    const f = fixture({ authorizeStore: () => value });
    await problem(await f.handler(request()), 403, 'STORE_FORBIDDEN');
    assert.equal(f.calls.fetch.length, 0);
  }
  for (const hook of ['identifyUser', 'authorizeStore']) {
    const f = fixture({ [hook]: () => { throw new Error(`${TOKEN} ${SUBJECT} private-cookie`); } });
    await problem(await f.handler(request()), 503, 'AUTH_UNAVAILABLE');
    assert.equal(f.calls.fetch.length, 0);
  }
  const changed = fixture({ authorizeStore(identity) { identity.subject = 'different-user'; return true; } });
  await problem(await changed.handler(request()), 503, 'AUTH_UNAVAILABLE');
  assert.equal(changed.calls.fetch.length, 0);
});

test('successful callback signs once at the fixed monitor and forwards no CRM credentials or caller headers', async () => {
  const f = fixture();
  const incoming = request(QUERY, { headers: { Cookie: 'crm_session=private-cookie', Authorization: 'Bearer private-cookie',
    Referer: 'http://crm.example.test/analysis/dashboard', 'X-Forwarded-Host': 'other.example.test' } });
  const response = await f.handler(incoming);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `${ORIGIN}/crm/sso#ticket=${TICKET}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await response.text(), '');
  assert.equal(f.calls.identify[0][0], incoming);
  const context = f.calls.identify[0][1];
  assert.equal(context.requestId, response.headers.get('x-request-id'));
  assert.deepEqual(f.calls.authorize[0], [{ subject: SUBJECT }, 'US-A', context]);
  assert.equal(f.calls.fetch.length, 1);
  const [url, init] = f.calls.fetch[0];
  assert.equal(url, `${ORIGIN}/api/crm/v1/sso/tickets`);
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.cache, 'no-store');
  assert.equal(init.signal, context.signal);
  assert.deepEqual(init.headers, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(init.body), { challengeId: CHALLENGE, storeKey: 'US-A', view: 'data', checkId: 'reviews', subject: SUBJECT });
  assert.equal(JSON.stringify(init).includes('private-cookie'), false);
});

test('an omitted checkId remains omitted and an identity with additional CRM claims is usable only through authorization', async () => {
  const f = fixture({ identifyUser: () => ({ subject: SUBJECT, crmInternalId: 7, permissions: ['fixture-only'] }) });
  const response = await f.handler(request(`challengeId=${CHALLENGE}&storeKey=US-A&view=results`));
  assert.equal(response.status, 303);
  assert.equal(f.calls.authorize[0][0].crmInternalId, 7);
  assert.deepEqual(JSON.parse(f.calls.fetch[0][1].body), { challengeId: CHALLENGE, storeKey: 'US-A', view: 'results', subject: SUBJECT });
});

test('concurrent callbacks keep their CRM identity, authorization and request ID separate', async () => {
  const gates = { A: deferred(), B: deferred() }, entered = { A: deferred(), B: deferred() }, payloads = [];
  const f = fixture({ identifyUser: async incoming => {
    const user = incoming.headers.get('cookie'); entered[user].resolve(); await gates[user].promise;
    return { subject: `fixture-user-${user}`, storeKey: `US-${user}` };
  }, authorizeStore: (identity, storeKey) => identity.storeKey === storeKey,
  fetchImpl: async (_url, init) => { payloads.push(JSON.parse(init.body)); return signed(); } });
  const first = f.handler(request(QUERY, { headers: { Cookie: 'A' } }));
  const second = f.handler(request(QUERY.replace('US-A', 'US-B').replace(CHALLENGE, 'b'.repeat(43)), { headers: { Cookie: 'B' } }));
  await Promise.all([entered.A.promise, entered.B.promise]);
  gates.B.resolve(); const secondResponse = await second;
  gates.A.resolve(); const firstResponse = await first;
  assert.equal(firstResponse.status, 303); assert.equal(secondResponse.status, 303);
  assert.notEqual(firstResponse.headers.get('x-request-id'), secondResponse.headers.get('x-request-id'));
  assert.deepEqual(payloads.map(({ subject, storeKey, challengeId }) => ({ subject, storeKey, challengeId })), [
    { subject: 'fixture-user-B', storeKey: 'US-B', challengeId: 'b'.repeat(43) },
    { subject: 'fixture-user-A', storeKey: 'US-A', challengeId: CHALLENGE },
  ]);
});

test('timed-out identity or permission checks cannot issue a ticket when they finish late', async () => {
  for (const hook of ['identifyUser', 'authorizeStore']) {
    const pending = deferred();
    const f = fixture({ timeoutMs: 20, [hook]: () => pending.promise });
    await problem(await f.handler(request()), 504, 'TIMEOUT');
    pending.resolve(hook === 'identifyUser' ? { subject: SUBJECT } : true);
    await tick();
    assert.equal(f.calls.fetch.length, 0);
    if (hook === 'identifyUser') assert.equal(f.calls.authorize.length, 0);
  }
});

test('a synchronous authentication hook cannot bypass the total deadline by blocking the timer', async () => {
  const f = fixture({ timeoutMs: 5, identifyUser() {
    const deadline = performance.now() + 10;
    while (performance.now() < deadline) { /* model a blocking session verifier */ }
    return { subject: SUBJECT };
  } });
  await problem(await f.handler(request()), 504, 'TIMEOUT');
  assert.equal(f.calls.authorize.length, 0); assert.equal(f.calls.fetch.length, 0);
});

test('external cancellation before or during authentication prevents late signing without exposing abort reasons', async () => {
  const before = new AbortController(); before.abort(new Error(TOKEN));
  const initial = fixture();
  await problem(await initial.handler(request(QUERY, { signal: before.signal })), 408, 'CANCELLED');
  assert.deepEqual(initial.calls, { identify: [], authorize: [], fetch: [] });
  for (const hook of ['identifyUser', 'authorizeStore']) {
    const pending = deferred(), entered = deferred(), controller = new AbortController();
    let hookSignal;
    const f = fixture({ [hook]: (...args) => { hookSignal = args.at(-1).signal; entered.resolve(); return pending.promise; } });
    const response = f.handler(request(QUERY, { signal: controller.signal }));
    await entered.promise;
    controller.abort(new Error(`${TOKEN} ${SUBJECT}`));
    await problem(await response, 408, 'CANCELLED');
    assert.equal(hookSignal.aborted, true);
    pending.resolve(hook === 'identifyUser' ? { subject: SUBJECT } : true);
    await tick();
    assert.equal(f.calls.fetch.length, 0);
  }
});

test('signing timeout or cancellation never retries or returns a late ticket', async () => {
  for (const cancel of [false, true]) {
    const pending = deferred(), entered = deferred(), controller = new AbortController();
    let calls = 0, upstreamSignal;
    const f = fixture({ timeoutMs: cancel ? 5000 : 20, fetchImpl: (_url, init) => {
      calls++; upstreamSignal = init.signal; entered.resolve(); return pending.promise;
    } });
    const response = f.handler(request(QUERY, { signal: controller.signal }));
    await entered.promise;
    if (cancel) controller.abort(new Error(TICKET));
    await problem(await response, cancel ? 408 : 504, cancel ? 'CANCELLED' : 'TIMEOUT');
    assert.equal(upstreamSignal.aborted, true);
    pending.resolve(signed()); await tick();
    assert.equal(calls, 1);
  }
});

test('response consumption shares the deadline and cancels an unfinished stream', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  const f = fixture({ timeoutMs: 20, fetchImpl: async () => new Response(body, { status: 201, headers: { 'Content-Type': 'application/json' } }) });
  await problem(await f.handler(request()), 504, 'TIMEOUT');
  assert.equal(cancelled, true);
});

test('upstream failures and redirects never become browser redirects or leak response/error content', async () => {
  for (const status of [200, 301, 302, 303, 307, 308, 401, 403, 409, 429, 500, 503]) {
    const f = fixture({ fetchImpl: async () => new Response(`PRIVATE_UPSTREAM_BODY ${TOKEN}`, {
      status, headers: { Location: `https://other.example.test/?token=${TOKEN}` },
    }) });
    await problem(await f.handler(request()), 502, 'UPSTREAM_REJECTED');
  }
  const failed = fixture({ fetchImpl: async () => { throw new Error(`${TOKEN} ${SUBJECT} ${TICKET}`); } });
  await problem(await failed.handler(request()), 502, 'UPSTREAM_UNAVAILABLE');
  for (const property of [{ redirected: true }, { url: 'https://other.example.test/tickets' }]) {
    const f = fixture({ fetchImpl: async () => {
      const response = signed(); for (const [key, value] of Object.entries(property)) Object.defineProperty(response, key, { value }); return response;
    } });
    await problem(await f.handler(request()), 502, 'UPSTREAM_INVALID');
  }
});

test('rejected upstream responses cancel their body without reading arbitrary error content', async () => {
  for (const status of [302, 503, 201]) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const f = fixture({ fetchImpl: async () => new Response(body, { status, headers: { 'Content-Type': 'text/html' } }) });
    await problem(await f.handler(request()), 502, status === 201 ? 'UPSTREAM_INVALID' : 'UPSTREAM_REJECTED');
    assert.equal(cancelled, true);
  }
});

test('signed response must contain one exact fixed HTTPS login target and a single opaque fragment ticket', async () => {
  for (const loginUrl of [
    `http://monitor.example.test/crm/sso#ticket=${TICKET}`, `https://other.example.test/crm/sso#ticket=${TICKET}`,
    `${ORIGIN}:444/crm/sso#ticket=${TICKET}`, `${ORIGIN}/login#ticket=${TICKET}`,
    `https://user:password@monitor.example.test/crm/sso#ticket=${TICKET}`, `${ORIGIN}/crm/sso?x=y#ticket=${TICKET}`,
    `${ORIGIN}/crm/sso?#ticket=${TICKET}`, `${ORIGIN}/crm/sso#ticket=${TICKET}&next=other`,
    `${ORIGIN}/crm/sso#ticket=${TICKET}&ticket=${TICKET}`, `${ORIGIN}/crm/sso#ticket=short`,
    `${ORIGIN}/crm/sso#ticket=${TICKET}%0A`, '/crm/sso', 'not a URL', null,
  ]) {
    const f = fixture({ fetchImpl: async () => signed({ loginUrl }) });
    await problem(await f.handler(request()), 502, 'UPSTREAM_INVALID');
  }
});

test('signed response expiry and singleUse are checked conservatively against the local clock', async () => {
  for (const data of [
    { singleUse: false }, { singleUse: 'true' }, { singleUse: undefined }, { expiresAt: null },
    { expiresAt: TIME + 1000 }, { expiresAt: 'invalid' }, { expiresAt: new Date(TIME).toISOString() },
    { expiresAt: new Date(TIME - 1).toISOString() }, { expiresAt: new Date(TIME + 60_001).toISOString() },
    { expiresAt: '2026-09-12T12:00:30.000+08:00' },
  ]) {
    const f = fixture({ fetchImpl: async () => signed(data) });
    await problem(await f.handler(request()), 502, 'UPSTREAM_INVALID');
  }
  assert.equal((await fixture({ fetchImpl: async () => signed({ expiresAt: new Date(TIME + 1).toISOString() }) }).handler(request())).status, 303);
});

test('upstream JSON is bounded by actual bytes as well as declared length and rejects invalid encoding/shapes', async () => {
  const responses = [
    () => new Response('PRIVATE_UPSTREAM_BODY', { status: 201, headers: { 'Content-Type': 'text/html' } }),
    () => new Response(null, { status: 201, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{', { status: 201, headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff]), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('x'.repeat(8193), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('x'.repeat(8193), { status: 201, headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } }),
    ...['8193', '-1', 'invalid'].map(length => () => new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json', 'Content-Length': length } })),
    ...[null, [], { apiVersion: '1.0', data: [] }, { ...responseData(), apiVersion: '2.0' }].map(value => () => Response.json(value, { status: 201 })),
  ];
  for (const makeResponse of responses) {
    const f = fixture({ fetchImpl: async () => makeResponse() });
    await problem(await f.handler(request()), 502, 'UPSTREAM_INVALID');
  }
});

test('callback integrates with the actual monitor handler for binding, single-use exchange and scoped saved-data reads', async t => {
  const { createCrmHttp } = await import('../src/crm/http.js');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-crm-adapter-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outDir, 'reviews'));
  const report = { check: 'reviews', runId: 'adapter-fixture', startedAt: new Date(TIME).toISOString(),
    results: ['US-A', 'US-B'].map(storeKey => ({ storeKey, status: 'LOW_REVIEW', severity: 'CRITICAL', ok: false,
      checkedAt: new Date(TIME).toISOString(), evidence: { dom: { landed: true }, text: { landed: true } },
      items: [{ identifier: `${storeKey}-REVIEW`, stars: 1, title: 'Synthetic review' }] })) };
  const reportFile = path.join(outDir, 'reviews', 'fixture.json'); fs.writeFileSync(reportFile, JSON.stringify(report));
  const before = fs.readFileSync(reportFile, 'utf8');
  const monitor = createCrmHttp({ outDir, stores: [{ key: 'US-A' }, { key: 'US-B' }], staleAfterMs: 36 * 3_600_000,
    now: () => TIME, isSecureRequest: () => true, env: {
      AMZGUARD_CRM_CLIENT_ID: 'fixture', AMZGUARD_CRM_API_TOKEN: TOKEN, AMZGUARD_CRM_STORE_KEYS: 'US-A,US-B',
      AMZGUARD_CRM_PUBLIC_ORIGIN: ORIGIN, AMZGUARD_CRM_CALLBACK_URL: CALLBACK,
    } });
  const monitorRequest = async (url, init = {}) => {
    const incoming = Readable.from(init.body ? [Buffer.from(init.body)] : []);
    incoming.method = init.method || 'GET';
    incoming.headers = { host: new URL(ORIGIN).host, ...Object.fromEntries(new Headers(init.headers)) };
    incoming.socket = { remoteAddress: '192.0.2.1' };
    const headers = new Headers(); let status; let text;
    const outgoing = { setHeader(key, value) {
      headers.delete(key); for (const part of Array.isArray(value) ? value : [value]) headers.append(key, String(part));
    }, writeHead(code, values) { status = code; for (const [key, value] of Object.entries(values || {})) this.setHeader(key, value); },
    end(value) { text = value || ''; } };
    assert.equal(await monitor(incoming, outgoing, new URL(url, ORIGIN)), true);
    return new Response(text, { status, headers });
  };
  const start = await monitorRequest('/crm/sso/start?storeKey=US-A&view=data&checkId=reviews');
  assert.equal(start.status, 303);
  const binding = start.headers.getSetCookie()[0].split(';')[0];
  const currentUser = { subject: SUBJECT, authorizedStores: ['US-A'] };
  let signCalls = 0;
  const callback = createCrmCallbackHandler({ callbackUrl: CALLBACK, monitorOrigin: ORIGIN, apiToken: TOKEN, now: () => TIME,
    identifyUser: incoming => incoming.headers.get('cookie') === 'fixture-login=valid' ? currentUser : null,
    authorizeStore: (identity, storeKey) => identity.authorizedStores.includes(storeKey),
    fetchImpl: (url, init) => { signCalls++; return monitorRequest(url, init); },
  });
  // This cookie and store list are synthetic CRM hooks, not a real CRM integration.
  const result = await callback(new Request(start.headers.get('location'), { headers: { Cookie: 'fixture-login=valid' } }));
  assert.equal(result.status, 303); assert.equal(signCalls, 1);
  const ticket = new URLSearchParams(new URL(result.headers.get('location')).hash.slice(1)).get('ticket');
  const exchange = cookie => monitorRequest('/crm/sso/exchange', { method: 'POST', headers: {
    Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie,
  }, body: JSON.stringify({ ticket }) });
  assert.equal((await exchange('__Host-amzguard_crm_binding=wrong-browser')).status, 401);
  const exchanged = await exchange(binding); assert.equal(exchanged.status, 200);
  const session = exchanged.headers.getSetCookie().find(value => value.startsWith('__Host-amzguard_crm=')).split(';')[0];
  assert.equal((await exchange(binding)).status, 401);
  const scope = await (await monitorRequest('/api/crm/v1/stores', { headers: { Cookie: session } })).json();
  assert.deepEqual(scope.data.map(store => store.storeKey), ['US-A']);
  const rows = await (await monitorRequest('/api/crm/v1/stores/US-A/checks/reviews/data?runId=adapter-fixture', { headers: { Cookie: session } })).json();
  assert.deepEqual(rows.data.map(row => row.item.identifier), ['US-A-REVIEW']);
  assert.equal((await monitorRequest('/api/crm/v1/stores/US-B/results', { headers: { Cookie: session } })).status, 404);
  const forbidden = await monitorRequest('/crm/sso/start?storeKey=US-B&view=results');
  await problem(await callback(new Request(forbidden.headers.get('location'), { headers: { Cookie: 'fixture-login=valid' } })), 403, 'STORE_FORBIDDEN');
  assert.equal(signCalls, 1);
  assert.equal(fs.readFileSync(reportFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(outDir), ['reviews']);
});
