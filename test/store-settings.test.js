import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { STORE_SETTINGS_MARKUP, installStoreSettings } from '../src/web/store-settings.js';
import { DASHBOARD_HTML } from '../src/web/dashboard.js';
import { UI_DEFAULTS } from '../src/lib/ui-config.js';

class Node {
  constructor(tag = 'div', owner = null) {
    this.tagName = tag.toUpperCase(); this.owner = owner; this.children = []; this.listeners = {};
    this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.readOnly = false;
    this._text = ''; this.attributes = {}; this.className = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set innerHTML(_) { throw new Error('Untrusted settings must never use innerHTML'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  async emit(type, target = this) { for (const handler of this.listeners[type] || []) await handler({ preventDefault() {}, target, currentTarget: this }); }
  focus() { if (this.owner) this.owner.activeElement = this; }
  scrollIntoView() {}
}

const defaults = UI_DEFAULTS;
const views = ['overview', 'store-risk', 'customer-voice', 'product-status', 'intelligence', 'ads-watch', 'upload', 'system', 'stores', 'users']
  .map(id => ({ id, title: id }));
const baseStore = { key: 'US-A', name: 'Exact browser name', displayName: '<img src=x onerror=alert(1)>',
  id: '123', market: 'US', host: 'sellercentral.amazon.com', enabled: true };
const response = (body, status = 200, type = 'application/json') => ({ status, ok: status >= 200 && status < 300,
  headers: { get: () => type }, json: async () => structuredClone(body) });

function fixture({ admin = true, stores = [baseStore], settings = defaults, handle } = {}) {
  const nodes = new Map();
  const document = { activeElement: null, querySelector(selector) { const node = nodes.get(selector.slice(1)); assert.ok(node, selector); return node; },
    createElement: tag => new Node(tag, document) };
  for (const match of STORE_SETTINGS_MARKUP.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Node('div', document));
  nodes.get('storeSettingsForm').hidden = true; nodes.get('storeSettingsFilter').value = 'all';
  const ui = { revision: 'ui:r1', source: 'defaults', settings: structuredClone(settings), csrfToken: 'ui-csrf', canManage: admin };
  const registry = { revision: 'stores:r1', contentSHA: 'a'.repeat(64), source: 'bootstrap', stores: structuredClone(stores),
    csrfToken: 'store-csrf', canManage: true, options: { markets: ['US', 'JP'], hosts: ['sellercentral.amazon.com', 'sellercentral.amazon.co.jp'] } };
  const calls = [], applied = []; let saves = 0, confirm = true;
  const window = { location: { href: '', hash: '' }, confirm: () => confirm, fetch: async (url, options) => {
    const call = { url, ...options, payload: options.body ? JSON.parse(options.body) : undefined }; calls.push(call);
    if (handle) { const result = await handle(call, { ui, registry }); if (result) return result; }
    if (url === '/api/ui-config') return response(ui);
    if (url === '/api/admin/stores' && options.method === 'GET') return admin ? response(registry) : response({ error: 'Forbidden' }, 403);
    if (url === '/api/admin/ui-config' && options.method === 'PUT') { ui.revision = 'ui:r2'; ui.settings = call.payload.settings; return response(ui); }
    if (url === '/api/admin/stores' && options.method === 'POST') { registry.revision = 'stores:r2'; registry.stores.push(call.payload.store); return response(registry); }
    if (url.startsWith('/api/admin/stores/') && options.method === 'PATCH') {
      registry.revision = 'stores:r2'; Object.assign(registry.stores.find(store => store.key === decodeURIComponent(url.split('/').at(-1))), call.payload.patch); return response(registry);
    }
    throw new Error('Unexpected request: ' + url);
  } };
  const controller = installStoreSettings({ window, document, views, settingsDefaults: UI_DEFAULTS, onUiSettings: settings => applied.push({ ...settings }), onStoresSaved: async () => { saves++; } });
  const change = async (id, value, form = 'storeSettingsForm') => { const node = nodes.get(id); if (typeof value === 'boolean') node.checked = value; else node.value = String(value); await nodes.get(form).emit('input', node); };
  return { nodes, calls, ui, registry, applied, window, controller, change, get saves() { return saves; },
    confirm(value) { confirm = value; }, boot: async () => { await controller.loadUIConfig(); await controller.activate(); },
    edit: async (index = 0) => nodes.get('storeSettingsList').children[index].children.at(-1).emit('click') };
}

test('settings are bundled in the existing shell and every rendered script compiles', () => {
  assert.match(DASHBOARD_HTML, /href="#stores" data-view="stores"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="stores"/);
  const scripts = [...DASHBOARD_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  for (const [, script] of scripts) assert.doesNotThrow(() => new vm.Script(script));
  const settingsSource = installStoreSettings.toString().replace('/api/admin/ziniao/restart', '');
  assert.doesNotMatch(settingsSource, /innerHTML|\/api\/crm|\/api\/product-uploads|\/api\/.*run/);
  assert.match(DASHBOARD_HTML, /id="ziniaoRestart"/);
  assert.match(DASHBOARD_HTML, /重启紫鸟/);
  assert.match(DASHBOARD_HTML, /initializeSettings\.then/);
  assert.match(DASHBOARD_HTML, /Math\.min\(displaySettings\.listPageSize,50\)/);
  for (const [, pattern] of STORE_SETTINGS_MARKUP.matchAll(/pattern="([^"]+)"/g)) assert.doesNotThrow(() => new RegExp(pattern, 'v'));
});

test('operators can read display settings but cannot load or submit store administration', async () => {
  const f = fixture({ admin: false, settings: { ...defaults, defaultView: 'stores' } }); await f.boot();
  assert.equal(f.controller.getDefaultView(), 'overview');
  assert.equal(f.nodes.get('uiSettingsFields').disabled, true);
  assert.equal(f.nodes.get('storeSettingsNew').disabled, true);
  assert.equal(f.nodes.get('ziniaoRestart').disabled, true);
  assert.match(f.nodes.get('storeSettingsStatus').textContent, /只有管理员/);
  await f.nodes.get('storeSettingsForm').emit('submit'); await f.nodes.get('uiSettingsForm').emit('submit');
  await f.nodes.get('ziniaoRestart').emit('click');
  assert.deepEqual(f.calls.map(call => call.url), ['/api/ui-config']);
});

test('new stores default to disabled and submit only explicit fields with revision and CSRF', async () => {
  const f = fixture(); await f.boot(); await f.nodes.get('storeSettingsNew').emit('click');
  assert.equal(f.nodes.get('storeSettingsEnabled').checked, false);
  assert.equal(f.nodes.get('storeSettingsKey').readOnly, false);
  await f.change('storeSettingsKey', 'NEW-01'); await f.change('storeSettingsName', 'Exact new browser');
  await f.nodes.get('storeSettingsForm').emit('submit');
  const call = f.calls.find(call => call.method === 'POST');
  assert.equal(call.headers['x-amzguard-csrf'], 'store-csrf'); assert.equal(call.credentials, 'same-origin');
  assert.deepEqual(call.payload, { expectedRevision: 'stores:r1', store: { key: 'NEW-01', name: 'Exact new browser',
    displayName: '', id: '', market: 'US', host: 'sellercentral.amazon.com', enabled: false } });
  assert.equal(f.saves, 1); assert.equal(f.nodes.get('storeSettingsKey').readOnly, true);
});

test('editing a display name preserves an opaque legacy binding and never renders it as HTML', async () => {
  const f = fixture({ stores: [{ ...baseStore, id: '', legacyBinding: true }] }); await f.boot();
  assert.equal(f.nodes.get('storeSettingsList').children[0].children[0].children[0].textContent, baseStore.displayName);
  await f.edit(); assert.equal(f.nodes.get('storeSettingsId').value, '');
  assert.match(f.nodes.get('storeSettingsBindingNote').textContent, /旧绑定已隐藏，留空保留/);
  await f.change('storeSettingsDisplayName', 'Store A'); await f.nodes.get('storeSettingsForm').emit('submit');
  assert.deepEqual(f.calls.find(call => call.method === 'PATCH').payload, { expectedRevision: 'stores:r1', patch: { displayName: 'Store A' } });
});

test('numeric binding can be explicitly cleared while unchanged fields and immutable key are omitted', async () => {
  const f = fixture(); await f.boot(); await f.edit(); await f.change('storeSettingsId', '');
  f.nodes.get('storeSettingsKey').value = 'tampered-key';
  await f.nodes.get('storeSettingsForm').emit('submit');
  const call = f.calls.find(call => call.method === 'PATCH');
  assert.equal(call.url, '/api/admin/stores/US-A'); assert.deepEqual(call.payload.patch, { id: '' });
});

test('store conflicts preserve draft and original revision across navigation and ordinary refresh', async () => {
  const f = fixture({ handle: call => call.method === 'PATCH' ? response({ error: 'Configuration changed', code: 'STORE_REGISTRY_CONFLICT' }, 409) : null });
  await f.boot(); await f.edit(); await f.change('storeSettingsDisplayName', 'Unsaved draft');
  await f.nodes.get('storeSettingsForm').emit('submit');
  assert.equal(f.nodes.get('storeSettingsDisplayName').value, 'Unsaved draft'); assert.match(f.nodes.get('storeSettingsMessage').textContent, /草稿已保留/);
  const count = f.calls.length; await f.controller.activate(); await f.controller.refresh(); assert.equal(f.calls.length, count);
  f.confirm(false); await f.controller.refresh(true); assert.equal(f.nodes.get('storeSettingsDisplayName').value, 'Unsaved draft');
  await f.nodes.get('storeSettingsForm').emit('submit');
  assert.ok(f.calls.filter(call => call.method === 'PATCH').every(call => call.payload.expectedRevision === 'stores:r1'));
  f.confirm(true); await f.controller.refresh(true); assert.equal(f.nodes.get('storeSettingsForm').hidden, true);
});

test('display settings validate limits, send all fields and apply saved server settings', async () => {
  const f = fixture(); await f.boot();
  await f.change('uiReportRefresh', 4, 'uiSettingsForm'); await f.nodes.get('uiSettingsForm').emit('submit');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  await f.change('uiReportRefresh', 60, 'uiSettingsForm'); await f.change('uiListPageSize', 70, 'uiSettingsForm');
  await f.change('uiDefaultView', 'stores', 'uiSettingsForm'); await f.nodes.get('uiSettingsForm').emit('submit');
  const call = f.calls.find(call => call.method === 'PUT');
  assert.equal(call.url, '/api/admin/ui-config'); assert.equal(call.headers['x-amzguard-csrf'], 'ui-csrf');
  assert.deepEqual(call.payload, { expectedRevision: 'ui:r1', settings: { ...defaults, reportRefreshSeconds: 60, listPageSize: 70, defaultView: 'stores' } });
  assert.deepEqual(f.applied.at(-1), call.payload.settings); assert.equal(f.controller.getDefaultView(), 'stores');
});

test('display conflicts retain draft and revision, while a slow read cannot overwrite new edits', async () => {
  let resolveRead, deferred = false;
  const f = fixture({ handle: call => {
    if (call.method === 'PUT') return response({ error: 'Changed elsewhere' }, 409);
    if (deferred && call.url === '/api/ui-config') return new Promise(resolve => { resolveRead = resolve; });
    return null;
  } });
  await f.boot(); deferred = true; const loading = f.controller.loadUIConfig();
  await f.change('uiReportRefresh', 90, 'uiSettingsForm');
  resolveRead(response({ ...f.ui, revision: 'ui:new', settings: { ...defaults, reportRefreshSeconds: 120 } })); await loading;
  assert.equal(f.nodes.get('uiReportRefresh').value, '90');
  await f.nodes.get('uiSettingsForm').emit('submit');
  assert.equal(f.calls.find(call => call.method === 'PUT').payload.expectedRevision, 'ui:r1');
  assert.equal(f.nodes.get('uiReportRefresh').value, '90'); assert.match(f.nodes.get('uiSettingsMessage').textContent, /草稿已保留/);
});

test('ziniao restart confirms once and posts only the fixed admin action', async () => {
  const f = fixture({ handle: call => call.url === '/api/admin/ziniao/restart'
    ? response({ ok: true, unit: 'amzguard-ziniao.service', message: '已重启紫鸟。已打开的店铺浏览器已关闭。' }) : null });
  await f.boot();
  assert.match(STORE_SETTINGS_MARKUP, /id="ziniaoRestart"[^>]*>重启紫鸟</);
  assert.equal(f.nodes.get('ziniaoRestart').disabled, false);
  f.confirm(false);
  const before = f.calls.length;
  await f.nodes.get('ziniaoRestart').emit('click');
  assert.equal(f.calls.length, before);
  assert.match(f.nodes.get('ziniaoRestartMessage').textContent, /已取消重启/);
  f.confirm(true);
  await f.nodes.get('ziniaoRestart').emit('click');
  const call = f.calls.at(-1);
  assert.equal(call.url, '/api/admin/ziniao/restart');
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.payload, {});
  assert.equal(call.headers['x-amzguard-csrf'], 'ui-csrf');
  assert.match(f.nodes.get('ziniaoRestartMessage').textContent, /已重启紫鸟/);
  assert.equal(f.nodes.get('ziniaoRestart').disabled, false);
});

test('ziniao restart shows a lock refusal without treating it as success', async () => {
  const f = fixture({ handle: call => call.url === '/api/admin/ziniao/restart'
    ? response({ ok: false, code: 'ZINIAO_RESTART_LOCKED', error: '采集进程仍持有运行锁（pid=9，任务=check:reviews），已拒绝重启紫鸟。' }, 409) : null });
  await f.boot();
  f.confirm(true);
  await f.nodes.get('ziniaoRestart').emit('click');
  assert.match(f.nodes.get('ziniaoRestartMessage').className, /bad/);
  assert.match(f.nodes.get('ziniaoRestartMessage').textContent, /运行锁/);
  assert.equal(f.nodes.get('ziniaoRestart').disabled, false);
});

test('expired or revoked administration clears protected binding controls and fails closed', async () => {
  const f = fixture({ handle: call => call.method === 'PATCH' ? response({ error: 'Forbidden' }, 403) : null });
  await f.boot(); await f.edit(); await f.change('storeSettingsDisplayName', 'Attempt'); await f.nodes.get('storeSettingsForm').emit('submit');
  assert.equal(f.nodes.get('storeSettingsId').value, ''); assert.equal(f.nodes.get('storeSettingsForm').hidden, true);
  assert.equal(f.nodes.get('storeSettingsNew').disabled, true); assert.equal(f.nodes.get('uiSettingsFields').disabled, true);
  const expired = fixture({ handle: () => response({}, 401) }); await expired.controller.loadUIConfig(); assert.equal(expired.window.location.href, '/login');
});

test('Dashboard applies configured page sizes and replaces timers without accumulating intervals', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(DASHBOARD_HTML)[1];
  const functionSource = script.slice(script.indexOf('function applyDisplaySettings('), script.indexOf('  var storeSettings='));
  let nextId = 0; const cleared = [], intervals = [], cadence = new Node();
  const context = { displaySettings: null, uiReady: false, pages: { riskMatrix: 1, riskIssues: 1, asins: 1 }, PAGE_SIZE: {},
    refreshTimers: [], q: () => cadence, clearInterval: id => cleared.push(id), setInterval: (fn, delay) => { intervals.push({ fn, delay }); return ++nextId; },
    load() {}, loadProgress() {}, loadUploads() {}, activeView: 'overview', uploadPage: 1, data: null };
  vm.createContext(context); vm.runInContext(functionSource, context);
  context.applyDisplaySettings({ ...defaults, matrixPageSize: 12, listPageSize: 25, reportRefreshSeconds: 60 });
  assert.deepEqual(intervals.map(row => row.delay), [60000, 2000, 15000]);
  assert.equal(context.PAGE_SIZE.riskMatrix, 12); assert.equal(context.PAGE_SIZE.asins, 25); assert.equal(context.PAGE_SIZE.riskIssues, 25);
  assert.match(cadence.textContent, /报告每 60 秒/);
  context.applyDisplaySettings(defaults); assert.deepEqual(cleared, [1, 2, 3]); assert.equal(context.refreshTimers.length, 3);
});
