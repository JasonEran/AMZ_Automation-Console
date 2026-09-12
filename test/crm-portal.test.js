import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  CRM_PORTAL_HTML, CRM_PORTAL_SCRIPT, CRM_PORTAL_STYLE, CRM_SSO_HTML, CRM_SSO_SCRIPT,
} from '../src/web/crm-portal.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.listeners = {}; this.hidden = false; this.disabled = false; this._text = ''; this._value = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(event, handler) { this.listeners[event] = handler; }
  get value() { return this._value || (this.tagName === 'SELECT' ? this.children[0]?.value : '') || ''; }
  set value(value) { this._value = String(value); }
  get selectedOptions() { return this.children.filter(child => child.value === this.value); }
}

function documentFor(html) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1]);
    if (match[0].includes('data-read-control')) node.dataset.readControl = '';
    nodes.set(match[2], node);
  }
  return {
    nodes,
    getElementById: id => nodes.get(id),
    createElement: tag => new Element(tag),
    querySelectorAll: () => [...nodes.values()].filter(node => 'readControl' in node.dataset),
  };
}

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const response = (body, status = 200, type = 'application/json') => ({
  status, ok: status >= 200 && status < 300, headers: { get: () => type }, async json() { return body; },
});
const envelope = data => ({ data, metadata: { generatedAt: '2026-09-12T03:00:00Z' } });

test('CRM documents expose only fixed inline blocks suitable for CSP hashes', () => {
  for (const [html, script] of [[CRM_PORTAL_HTML, CRM_PORTAL_SCRIPT], [CRM_SSO_HTML, CRM_SSO_SCRIPT]]) {
    assert.deepEqual([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]), [script]);
    assert.deepEqual([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]), [CRM_PORTAL_STYLE]);
    assert.doesNotMatch(html, /\son[a-z]+\s*=|<iframe|<script\s+src=/i);
    new vm.Script(script);
  }
  assert.doesNotMatch(CRM_PORTAL_SCRIPT, /innerHTML|document\.write|localStorage|sessionStorage/);
  assert.doesNotMatch(CRM_PORTAL_HTML, /href="\/(?:#|intelligence|api\/product-uploads|api\/users)/);
});

test('SSO removes the ticket fragment before DOM access or exchange and redirects only after success', async () => {
  const sequence = [], doc = documentFor(CRM_SSO_HTML), originalGet = doc.getElementById;
  doc.getElementById = id => { sequence.push('dom'); return originalGet(id); };
  vm.runInNewContext(CRM_SSO_SCRIPT, {
    URLSearchParams, document: doc,
    window: { location: { hash: '#ticket=private-test-ticket', replace: url => sequence.push(['redirect', url]) },
      history: { replaceState: (_a, _b, url) => sequence.push(['erase', url]) } },
    fetch: async (url, options) => {
      sequence.push(['exchange', url]);
      assert.equal(options.credentials, 'same-origin'); assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { ticket: 'private-test-ticket' });
      return response(envelope({ location: '/crm/' }));
    },
  });
  await flush();
  assert.deepEqual(sequence[0], ['erase', '/crm/sso']);
  assert.deepEqual(sequence.at(-1), ['redirect', '/crm/']);
  assert.doesNotMatch(doc.nodes.get('ssoMessage').textContent, /private-test-ticket/);
});

test('SSO failures do not echo tickets or server details into the page', async () => {
  const doc = documentFor(CRM_SSO_HTML); let redirected = false;
  vm.runInNewContext(CRM_SSO_SCRIPT, {
    URLSearchParams, document: doc,
    window: { location: { hash: '#ticket=secret-fixture', replace() { redirected = true; } }, history: { replaceState() {} } },
    fetch: async () => response({ error: { message: 'secret-fixture' } }, 401),
  });
  await flush();
  assert.equal(redirected, false);
  assert.match(doc.nodes.get('ssoMessage').textContent, /重新进入/);
  assert.doesNotMatch(doc.nodes.get('ssoMessage').textContent, /secret-fixture/);
});

async function portal({ view = 'results', checks = [], dataHandler, resultsStatus = 200, resultsType = 'application/json' } = {}) {
  const document = documentFor(CRM_PORTAL_HTML), calls = [], snapshotId = 'a'.repeat(64);
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/crm/session') return response(envelope({ storeKey: 'S1', checkId: 'voc', view, expiresAt: 9999999999999 }));
    if (url === '/api/crm/v1/stores') return response(envelope([{ storeKey: 'S1', storeName: '已授权店铺' }, { storeKey: 'S2', storeName: '其他店铺' }]));
    if (url.endsWith('/results')) return response(envelope({ store: { storeKey: 'S1' }, checks }), resultsStatus, resultsType);
    if (url.includes('/runs?')) return response({ ...envelope([{ runId: 'run-1', snapshotId, finishedAt: '2026-09-12T01:00:00Z' }]), pagination: { page: 1, pageSize: 50, total: 1, pages: 1, hasMore: false } });
    if (url.includes('/data?')) return dataHandler(url, snapshotId);
    if (url === '/crm/logout') return response(envelope({ ok: true }));
    throw new Error('Unexpected route: ' + url);
  };
  vm.runInNewContext(CRM_PORTAL_SCRIPT, { document, fetch, URLSearchParams, Intl, Date });
  await flush();
  return { document, calls, snapshotId };
}

test('unknown, partial evidence and stale results never receive a normal green badge', async () => {
  const cases = [
    { checkId: 'store-health', status: ['UNKNOWN'], severity: 'OK', results: [{ ok: true }] },
    { checkId: 'performance', status: ['CLEAR'], severity: 'OK', results: [{ ok: true, collectionStatus: 'PARTIAL_EVIDENCE' }] },
    { checkId: 'reviews', status: ['CLEAR'], severity: 'OK', stale: true, results: [{ ok: true }] },
  ];
  const { document, calls } = await portal({ checks: cases });
  const cards = document.nodes.get('checks').children;
  for (const card of [cards[0], cards[1], cards[3]]) {
    assert.notEqual(card.children[1].className, 'badge ok');
  }
  assert.equal(cards[3].children[1].textContent, '数据已过期');
  assert.equal(cards.length, 9);
  assert.equal(calls.some(call => call.url.includes('/S2/')), false);
  assert.match(document.nodes.get('generatedAt').textContent, /接口生成/);
});

test('VOC data is text-only, tied to a run snapshot, and uses the next page without changing stores', async () => {
  const payload = '<img src=x onerror=alert(1)>', result = { status: 'POOR_CX', severity: 'CRITICAL', ok: false,
    source: { checkedAt: '2026-09-12T01:00:00Z', collectedAt: '2026-09-12T01:00:00Z' } };
  const { document, calls, snapshotId } = await portal({ view: 'data', dataHandler: (url, snapshot) => {
    const page = Number(new URL('http://localhost' + url).searchParams.get('page'));
    return response({ ...envelope([{ recordType: 'voc-asin', result, item: { asin: 'B012345678', customerIssues: [payload] } }]),
      pagination: { page, pageSize: 100, total: 101, pages: 2, hasMore: page === 1 }, metadata: { snapshotId: snapshot, runId: 'run-1' } });
  } });
  assert.match(document.nodes.get('records').textContent, /B012345678/);
  assert.ok(document.nodes.get('records').textContent.includes(payload));
  const allTags = node => [node.tagName, ...node.children.flatMap(allTags)];
  assert.equal(allTags(document.nodes.get('records')).includes('IMG'), false);
  assert.equal(document.nodes.get('records').children[0].open, true);
  await document.nodes.get('nextPage').listeners.click(); await flush();
  const last = calls.filter(call => call.url.includes('/data?')).at(-1).url;
  assert.match(last, /stores\/S1\/checks\/voc\/data/);
  assert.equal(new URL('http://localhost' + last).searchParams.get('page'), '2');
  assert.equal(new URL('http://localhost' + last).searchParams.get('snapshotId'), snapshotId);
});

test('non-JSON or expired responses close the view instead of displaying a login page as data', async () => {
  for (const settings of [{ resultsStatus: 401 }, { resultsType: 'text/html' }, { resultsStatus: 503 }]) {
    const { document } = await portal(settings);
    assert.match(document.nodes.get('error').textContent, /重新进入/);
    assert.equal(document.nodes.get('checks').children.length, 0);
    assert.equal(document.nodes.get('refresh').disabled, true);
  }
});

test('snapshot conflicts remove previously displayed rows and JSON instead of mixing pages', async () => {
  const { document } = await portal({ view: 'data', dataHandler: (url, snapshotId) => {
    const page = Number(new URL('http://localhost' + url).searchParams.get('page'));
    if (page === 2) return response({ type: 'about:blank', status: 409, code: 'SNAPSHOT_CHANGED' }, 409, 'application/problem+json');
    return response({ ...envelope([{ recordType: 'voc-asin', result: {}, item: { asin: 'B012345678' } }]),
      pagination: { page: 1, pageSize: 100, total: 101, pages: 2, hasMore: true }, metadata: { snapshotId, runId: 'run-1' } });
  } });
  assert.ok(document.nodes.get('records').children.length);
  await document.nodes.get('nextPage').listeners.click(); await flush();
  assert.equal(document.nodes.get('records').children.length, 0);
  assert.equal(document.nodes.get('rawJson').textContent, '');
  assert.equal(document.nodes.get('nextPage').disabled, true);
  assert.match(document.nodes.get('error').textContent, /快照已变化/);
  assert.equal(document.nodes.get('refresh').disabled, false);
});

test('standard report conflicts remain actionable and incomplete saved coverage is visible', async () => {
  const conflicted = await portal({ view: 'data', dataHandler: () => response({ code: 'REPORT_CONFLICT', status: 409 }, 409, 'application/problem+json') });
  assert.match(conflicted.document.nodes.get('error').textContent, /报告副本存在冲突/);
  assert.equal(conflicted.document.nodes.get('refresh').disabled, false);
  const incomplete = await portal({ view: 'data', dataHandler: () => response({ ...envelope([]), metadata: { ignoredReports: 2 } }) });
  assert.equal(incomplete.document.nodes.get('coverageWarning').hidden, false);
  assert.match(incomplete.document.nodes.get('coverageWarning').textContent, /2 份报告/);
});

test('rate limited reads show retry guidance without expiring the session', async () => {
  const limited = await portal({ view: 'data', dataHandler: () => ({
    ...response({ code: 'CRM_RATE_LIMITED', status: 429 }, 429, 'application/problem+json'),
    headers: { get: name => name === 'retry-after' ? '17' : 'application/problem+json' },
  }) });
  assert.match(limited.document.nodes.get('error').textContent, /17 秒后/);
  assert.equal(limited.document.nodes.get('refresh').disabled, false);
});

test('logout is a same-origin JSON POST and clears the displayed data', async () => {
  const { document, calls } = await portal();
  await document.nodes.get('logout').listeners.click(); await flush();
  const last = calls.at(-1);
  assert.equal(last.url, '/crm/logout'); assert.equal(last.options.method, 'POST');
  assert.equal(last.options.credentials, 'same-origin'); assert.equal(last.options.body, '{}');
  assert.equal(document.nodes.get('checks').children.length, 0);
  assert.match(document.nodes.get('error').textContent, /已退出/);
});
