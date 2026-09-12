import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { CRM_BRIDGE_SCRIPT, CRM_BRIDGE_STYLE, renderCrmBridge } from '../src/web/crm-bridge.js';

const START = 1_800_000_000_000;
const BASE = { requestId: 'R'.repeat(43), challengeId: 'C'.repeat(43), storeKey: 'US-A',
  view: 'data', checkId: 'reviews', bridgeOrigin: 'http://crm.example.test',
  publicOrigin: 'https://monitor.example.test', expiresAt: START + 120000 };
const TICKET = 'T'.repeat(43);
const plain = value => JSON.parse(JSON.stringify(value));
function harness(options = {}) {
  let clock = START;
  const context = { ...BASE, ...options.context };
  const status = { textContent: '' }, posts = [], requests = [], navigations = [], listeners = new Map(), timers = new Map();
  let nextTimer = 1;
  const opener = { closed: false, postMessage: (data, origin) => {
    if (options.postFailure) throw new Error('fixture closed opener');
    posts.push({ data: plain(data), origin });
  } };
  const window = { opener: options.noOpener ? null : opener,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
    location: { replace: url => navigations.push({ url, detached: window.opener === null }) } };
  window.self = window;
  window.top = options.framed ? {} : window;
  vm.runInNewContext(CRM_BRIDGE_SCRIPT, { window, document: { getElementById: id => id === 'crmBridgeStatus' ? status : { textContent: JSON.stringify(context) } },
    Date: { now: () => clock }, AbortController,
    setTimeout: (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, opts) => {
      requests.push({ url, opts });
      return options.fetch ? options.fetch(url, opts) : new Response(JSON.stringify({ data: { location: '/crm/' } }),
        { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    },
  });
  const ticket = (patch = {}) => ({ type: 'amzguard:crm:ticket', version: 1,
    requestId: context.requestId, challengeId: context.challengeId,
    loginUrl: `${context.publicOrigin}/crm/sso#ticket=${TICKET}`, ...patch });
  return { context, status, posts, requests, navigations, listeners, timers, opener, window, ticket,
    send(data = ticket(), event = {}) { return listeners.get('message')?.({ source: opener, origin: context.bridgeOrigin, data, ...event }); },
    advance(ms, fire = true) {
      clock += ms;
      if (fire) for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    } };
}

test('bridge markup escapes public context and never includes a binding credential', () => {
  const html = renderCrmBridge({ ...BASE, requestId: '</script><img src=x onerror=alert(1)>', browserToken: 'PRIVATE_BROWSER_BINDING' });
  assert.equal([...html.matchAll(/<script>/g)].length, 1);
  assert.ok(html.includes(`<script>${CRM_BRIDGE_SCRIPT}</script>`));
  assert.ok(html.includes(`<style>${CRM_BRIDGE_STYLE}</style>`));
  assert.equal(html.includes('PRIVATE_BROWSER_BINDING'), false);
  assert.equal(html.includes('<img'), false);
  assert.ok(html.includes('\\u003c/script\\u003e'));
  new vm.Script(CRM_BRIDGE_SCRIPT);
  assert.doesNotMatch(CRM_BRIDGE_SCRIPT, /innerHTML|document\.write|eval\(|window\.open\(/);
});

test('bridge sends one exact challenge and exchanges once on its own origin before detaching and navigating', async () => {
  const h = harness();
  assert.deepEqual(h.posts, [{ origin: BASE.bridgeOrigin, data: { type: 'amzguard:crm:challenge', version: 1,
    requestId: BASE.requestId, challengeId: BASE.challengeId, storeKey: 'US-A', view: 'data', checkId: 'reviews' } }]);
  await h.send();
  assert.equal(h.requests.length, 1);
  const { url, opts } = h.requests[0];
  assert.equal(url, '/crm/sso/exchange');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.credentials, 'same-origin');
  assert.equal(opts.cache, 'no-store');
  assert.deepEqual(JSON.parse(opts.body), { ticket: TICKET });
  assert.equal(Object.hasOwn(opts.headers, 'Authorization'), false);
  assert.deepEqual(h.posts[1], { origin: BASE.bridgeOrigin, data: { type: 'amzguard:crm:complete', version: 1,
    requestId: BASE.requestId, challengeId: BASE.challengeId } });
  assert.deepEqual(h.navigations, [{ url: '/crm/', detached: true }]);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.timers.size, 0);
  await h.send();
  assert.equal(h.requests.length, 1);
});

test('wrong origin, source, ids, version, shape and extra fields cannot consume the legitimate listener', async () => {
  const h = harness();
  for (const event of [{ origin: 'https://crm.example.test' }, { origin: 'http://crm.example.test.evil' },
    { origin: 'null' }, { source: {} }]) await h.send(h.ticket(), event);
  for (const patch of [{ requestId: 'X'.repeat(43) }, { challengeId: 'X'.repeat(43) },
    { version: '1' }, { version: 2 }, { role: 'admin' }, { type: 'unrelated' }]) await h.send(h.ticket(patch));
  for (const data of [null, [], {}, 'value', { type: 'amzguard:crm:error', version: 1, requestId: BASE.requestId }]) await h.send(data);
  assert.equal(h.requests.length, 0);
  assert.equal(h.listeners.size, 1);
  await h.send();
  assert.equal(h.requests.length, 1);
  assert.equal(h.navigations.length, 1);
});

test('received ticket with noncanonical URL fails once without any navigation or request', async () => {
  for (const loginUrl of ['http://monitor.example.test/crm/sso#ticket=' + TICKET,
    'https://other.example.test/crm/sso#ticket=' + TICKET,
    `${BASE.publicOrigin}/crm/sso?next=anything#ticket=${TICKET}`,
    `${BASE.publicOrigin}/crm/sso#ticket=${TICKET}&extra=1`,
    `${BASE.publicOrigin}/crm/sso#ticket=${TICKET.slice(1)}`, `${BASE.publicOrigin}/crm/sso#ticket=${TICKET}%20`,
    ` ${BASE.publicOrigin}/crm/sso#ticket=${TICKET}`, `${BASE.publicOrigin}/crm/sso#ticket=${TICKET}\n`,
    `${BASE.publicOrigin}/crm/other#ticket=${TICKET}`, `https://monitor.example.test:443/crm/sso#ticket=${TICKET}`,
    `https://monitor.example.test\\crm/sso#ticket=${TICKET}`, 'javascript:alert(1)', null]) {
    const h = harness();
    await h.send(h.ticket({ loginUrl }));
    assert.equal(h.requests.length, 0, String(loginUrl));
    assert.equal(h.navigations.length, 0);
    assert.equal(h.listeners.size, 0);
    assert.match(h.status.textContent, /校验失败/);
    await h.send();
    assert.equal(h.requests.length, 0);
  }
});

test('CRM error, missing/closed opener, embedding, expiry and transport failure are terminal', async () => {
  const explicit = harness();
  await explicit.send({ type: 'amzguard:crm:error', version: 1, requestId: BASE.requestId, challengeId: BASE.challengeId });
  assert.equal(explicit.requests.length, 0);
  assert.equal(explicit.listeners.size, 0);
  assert.match(explicit.status.textContent, /未完成授权/);
  for (const options of [{ noOpener: true }, { framed: true }, { postFailure: true }, { context: { expiresAt: START } }]) {
    const h = harness(options);
    assert.equal(h.requests.length, 0);
    assert.equal(h.listeners.size, 0);
    assert.ok(h.status.textContent);
  }
  const closed = harness(); closed.opener.closed = true;
  await closed.send();
  assert.equal(closed.requests.length, 0);
  assert.equal(closed.listeners.size, 0);
  const expired = harness(); expired.advance(120000);
  await expired.send();
  assert.equal(expired.requests.length, 0);
  assert.match(expired.status.textContent, /过期/);
  const lateEvent = harness(); lateEvent.advance(120000, false);
  await lateEvent.send();
  assert.equal(lateEvent.requests.length, 0, 'expired event cannot beat a delayed timeout callback');
});

test('failed exchange, non-JSON response and untrusted completion location never retry or navigate', async () => {
  for (const fetch of [async () => { throw new Error('offline'); },
    async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }),
    async () => new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    async () => new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async () => new Response(JSON.stringify({ data: { location: 'https://evil.example.test' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })]) {
    const h = harness({ fetch });
    await h.send(); await h.send();
    assert.equal(h.requests.length, 1);
    assert.equal(h.navigations.length, 0);
    assert.equal(h.posts.length, 1);
    assert.match(h.status.textContent, /不会自动重试/);
  }
});

test('duplicate tickets and delayed exchange cannot bypass handshake timeout', async () => {
  let finish;
  const h = harness({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  const pending = h.send();
  await h.send();
  assert.equal(h.requests.length, 1);
  assert.equal(h.listeners.size, 0);
  h.advance(120000);
  assert.equal(h.requests[0].opts.signal.aborted, true);
  finish(new Response(JSON.stringify({ data: { location: '/crm/' } }), { headers: { 'Content-Type': 'application/json' } }));
  await pending;
  assert.equal(h.navigations.length, 0);
  assert.equal(h.posts.length, 1);
  assert.match(h.status.textContent, /过期/);
});
