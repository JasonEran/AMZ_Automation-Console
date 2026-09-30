import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { latestEffectiveCheck, latestStoreSnapshots, readCheckHistory, storeHistory } from '../lib/dashboard-history.js';
import { artifactPart } from '../lib/artifact-name.js';
import { actionStateFor, rawStateLabel, worstAction } from '../lib/dashboard-status.js';
import { DASHBOARD_HTML, businessItemPlace } from '../web/dashboard.js';
import { buildSessionHealth } from '../lib/session-health.js';

function writeReport(root, name, value, checkId = 'performance') {
  const dir = path.join(root, checkId, '2026-08-27');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value)}\n`);
}

test('dashboard history ignores corrupt and implausibly future reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-dashboard-history-'));
  const dir = path.join(root, 'performance', '2026-08-27');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  writeReport(root, 'valid.json', {
    check: 'performance', runId: 'valid', finishedAt: '2026-08-27T08:00:00+08:00',
    results: [{ storeKey: 'A', status: 'CLEAR', severity: 'OK' }],
  });
  writeReport(root, 'future.json', {
    check: 'performance', runId: 'future', finishedAt: '2030-01-01T00:00:00+08:00',
    results: [{ storeKey: 'A', status: 'ERROR', severity: 'ERROR' }],
  });
  const rows = readCheckHistory({ outDir: root, checkId: 'performance', now: new Date('2026-08-27T09:00:00+08:00') });
  assert.deepEqual(rows.map((row) => row.report.runId), ['valid']);
});

test('dashboard history marks stale data without turning it into a pass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-dashboard-stale-'));
  writeReport(root, 'old.json', {
    check: 'performance', runId: 'old', finishedAt: '2026-08-20T08:00:00+08:00',
    results: [{ storeKey: 'A', status: 'CLEAR', severity: 'OK' }],
  });
  const snapshots = latestStoreSnapshots({
    outDir: root, checkId: 'performance', now: new Date('2026-08-27T09:00:00+08:00'), staleAfterMs: 36 * 60 * 60 * 1000,
  });
  assert.equal(snapshots.get('A').stale, true);
  assert.equal(snapshots.get('A').results[0].severity, 'OK');
});

test('single-store rerun preserves each other store latest snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-dashboard-merge-'));
  writeReport(root, 'all.json', {
    check: 'performance', runId: 'all', finishedAt: '2026-08-27T08:00:00+08:00',
    results: [
      { storeKey: 'A', status: 'CLEAR', severity: 'OK' },
      { storeKey: 'B', status: 'CLEAR', severity: 'OK' },
    ],
  });
  writeReport(root, 'single.json', {
    check: 'performance', runId: 'single', finishedAt: '2026-08-27T09:00:00+08:00',
    results: [{ storeKey: 'A', status: 'VIOLATION', severity: 'CRITICAL' }],
  });
  const snapshots = latestStoreSnapshots({ outDir: root, checkId: 'performance', now: new Date('2026-08-27T10:00:00+08:00') });
  assert.equal(snapshots.get('A').report.runId, 'single');
  assert.equal(snapshots.get('B').report.runId, 'all');
  assert.deepEqual(storeHistory({ outDir: root, checkId: 'performance', storeKey: 'A', now: new Date('2026-08-27T10:00:00+08:00') }).map((row) => row.report.runId), ['all', 'single']);
  const effective = latestEffectiveCheck({ outDir: root, checkId: 'performance', now: new Date('2026-08-27T10:00:00+08:00') });
  assert.deepEqual(effective.results.map((row) => `${row.storeKey}:${row.status}`).sort(), ['A:VIOLATION', 'B:CLEAR']);
  assert.deepEqual(effective.sources.map((row) => `${row.storeKey}:${row.runId}`).sort(), ['A:single', 'B:all']);
});

test('targeted ASIN rerun updates one product without hiding its store siblings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-dashboard-asin-merge-'));
  writeReport(root, 'full.json', {
    check: 'asin-health', runId: 'full', finishedAt: '2026-08-27T08:00:00+08:00',
    selection: { targeted: false, requestedAsins: [] },
    results: [
      { storeKey: 'WANG', market: 'US', asin: 'B012345678', status: 'OK', severity: 'OK' },
      { storeKey: 'WANG', market: 'US', asin: 'B076543210', status: 'ERROR', severity: 'ERROR' },
    ],
  }, 'asin-health');
  writeReport(root, 'targeted.json', {
    check: 'asin-health', runId: 'targeted', finishedAt: '2026-08-27T09:00:00+08:00',
    selection: { targeted: true, requestedAsins: ['B076543210'] },
    results: [
      { storeKey: 'WANG', market: 'US', asin: 'B076543210', status: 'NO_CART', severity: 'CRITICAL' },
    ],
  }, 'asin-health');
  const snapshots = latestStoreSnapshots({
    outDir: root, checkId: 'asin-health', now: new Date('2026-08-27T10:00:00+08:00'),
  });
  const rows = snapshots.get('WANG').results;
  assert.equal(snapshots.get('WANG').report.runId, 'targeted');
  assert.deepEqual(rows.map((row) => `${row.asin}:${row.status}`).sort(), [
    'B012345678:OK', 'B076543210:NO_CART',
  ]);
});

test('evidence artifact names stay distinct after sanitisation and truncation', () => {
  assert.notEqual(artifactPart('shop/a'), artifactPart('shop?a'));
  assert.notEqual(artifactPart(`same-${'x'.repeat(120)}-a`), artifactPart(`same-${'x'.repeat(120)}-b`));
  assert.match(artifactPart('../store'), /^[A-Za-z0-9_][A-Za-z0-9._-]*-[a-f0-9]{12}$/);
});

test('dashboard has distinct business/collection states and production controls', () => {
  assert.match(DASHBOARD_HTML, /MAJORITY_ON:'多数已开启 · 少数例外留档'/);
  assert.match(DASHBOARD_HTML, /MAJORITY_OFF:'多数已关闭 · 少数例外留档'/);
  assert.match(DASHBOARD_HTML, /recordedExceptionCount:'少数例外留档'/);
  assert.match(DASHBOARD_HTML, /RECORDED_EXCEPTION:'少数例外 · 仅留档'/);
  assert.match(DASHBOARD_HTML, /业务异常/);
  assert.match(DASHBOARD_HTML, /采集异常/);
  assert.match(DASHBOARD_HTML, /运营待办/);
  assert.match(DASHBOARD_HTML, /技术待办/);
  assert.match(DASHBOARD_HTML, /ASIN 监测清单/);
  assert.match(DASHBOARD_HTML, /店铺风险/);
  assert.match(DASHBOARD_HTML, /客户声音/);
  assert.match(DASHBOARD_HTML, /商品状态/);
  assert.match(DASHBOARD_HTML, /广告值守/);
  assert.match(DASHBOARD_HTML, /上传中心|商品上传/);
  assert.match(DASHBOARD_HTML, /系统保障/);
  assert.match(DASHBOARD_HTML, /用户管理/);
  assert.match(DASHBOARD_HTML, /id="adsRulesForm"/);
  assert.match(DASHBOARD_HTML, /id="createUserForm"/);
  assert.match(DASHBOARD_HTML, /id="ownPasswordForm"/);
  for (const group of ['risk', 'voice', 'product', 'ads']) {
    assert.match(DASHBOARD_HTML, new RegExp(`id="${group}Search"`));
    assert.match(DASHBOARD_HTML, new RegExp(`id="${group}StateFilter"`));
    assert.match(DASHBOARD_HTML, new RegExp(`id="${group}SortBy"`));
  }
  assert.match(DASHBOARD_HTML, /data-matrix-filter="risk"/);
  assert.match(DASHBOARD_HTML, /data-matrix-filter="voice"/);
  assert.match(DASHBOARD_HTML, /data-matrix-filter="product"/);
  assert.match(DASHBOARD_HTML, /data-matrix-filter="ads"/);
  assert.match(DASHBOARD_HTML, /id="runProgress"/);
  assert.match(DASHBOARD_HTML, /id="channelList"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="overview"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="store-risk"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="customer-voice"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="product-status"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="ads-watch"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="system"/);
  const sidebarNavigation = /<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/.exec(DASHBOARD_HTML)[1];
  const navViews = [...sidebarNavigation.matchAll(/<a href="#[^"]+" data-view="([^"]+)"/g)].map((match) => match[1]);
  const panels = [...DASHBOARD_HTML.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').matchAll(/data-view-panel="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(navViews, ['overview', 'store-risk', 'customer-voice', 'product-status', 'intelligence', 'ads-watch', 'upload', 'system', 'stores', 'users']);
  assert.deepEqual(panels, navViews);
  assert.match(DASHBOARD_HTML, /CHECK_GROUPS=\{risk:\['store-health','performance'\],voice:\['feedback','inbox','reviews','voc'\],product:\['asin-health','outlet'\],ads:\['ads-status'\]\}/);
  assert.match(DASHBOARD_HTML, /renderGroupMatrix\('risk','riskMatrix','riskMatrix'\)/);
  assert.match(DASHBOARD_HTML, /renderGroupMatrix\('voice','voiceMatrix','voiceMatrix'\)/);
  assert.match(DASHBOARD_HTML, /renderGroupMatrix\('product','productMatrix','productMatrix'\)/);
  assert.match(DASHBOARD_HTML, /renderGroupMatrix\('ads','adsMatrix','adsMatrix'\)/);
  assert.match(DASHBOARD_HTML, /id="riskMatrixPager"/);
  assert.match(DASHBOARD_HTML, /id="voiceMatrixPager"/);
  assert.match(DASHBOARD_HTML, /id="productMatrixPager"/);
  assert.match(DASHBOARD_HTML, /id="adsMatrixPager"/);
  assert.match(DASHBOARD_HTML, /id="sessionList"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="upload"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="store-risk"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="customer-voice"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="product-status"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="ads-watch"/);
  assert.match(DASHBOARD_HTML, /data-view-panel="system"/);
  assert.match(DASHBOARD_HTML, /id="monitoringRecommendationList"/);
  assert.match(DASHBOARD_HTML, /系统绝不自动停检/);
  assert.match(DASHBOARD_HTML, /id="evidenceSummary"/);
  assert.match(DASHBOARD_HTML, /正常必须同时具备可靠 DOM 与页面文本/);
  assert.match(DASHBOARD_HTML, /id="uploadResultSummary"/);
  assert.match(DASHBOARD_HTML, /Amazon 已接收文件.*SKU 已处理完成/);
  assert.match(DASHBOARD_HTML, /job\.resultCenter/);
  assert.match(DASHBOARD_HTML, /id="uploadStoreFilter"/);
  assert.match(DASHBOARD_HTML, /id="uploadStateFilter"/);
  assert.doesNotMatch(DASHBOARD_HTML, /confirmPassword/);
  assert.match(DASHBOARD_HTML, /id="confirmPhrase"/);
  assert.match(DASHBOARD_HTML, /唯一允许改变 Amazon 状态的功能/);
  assert.match(DASHBOARD_HTML, /结果未知时系统不会自动重试/);
  assert.match(DASHBOARD_HTML, /Amazon 原页和原始截图是品牌级评论源/);
  assert.match(DASHBOARD_HTML, /评论行无 ASIN 或归属清单不可用时显示为采集待核验/);
  assert.match(DASHBOARD_HTML, /页面文本（仅计数，不绑定记录）/);
  assert.match(DASHBOARD_HTML, /screenshotMeta/);
  assert.match(DASHBOARD_HTML, /activeDetail/);
  assert.doesNotMatch(DASHBOARD_HTML, /AMAZON_ACCEPTED_UPLOAD<\/b>/);
  assert.match(DASHBOARD_HTML, /aria-hidden="true"/);
  const script = /<script>([\s\S]*?)<\/script>/.exec(DASHBOARD_HTML)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script), 'dashboard inline JavaScript must compile');
});

test('overview business items name the store and area and link only to an existing page', () => {
  const checks = [
    ['store-health', '店铺健康', 'store-risk'],
    ['performance', '绩效', 'store-risk'],
    ['feedback', 'Feedback', 'customer-voice'],
    ['inbox', 'Inbox', 'customer-voice'],
    ['reviews', 'Reviews', 'customer-voice'],
    ['voc', 'VOC', 'customer-voice'],
    ['asin-health', 'ASIN', 'product-status'],
    ['outlet', '奥特莱斯', 'product-status'],
    ['ads-status', '广告', 'ads-watch'],
  ];
  for (const [checkId, short, view] of checks) {
    assert.deepEqual(businessItemPlace({
      storeName: 'US-01', storeKey: 'US-01', checkId, actionState: 'BUSINESS',
    }, [{ id: checkId, short }]), { label: `US-01 · ${short}`, view });
  }
  assert.deepEqual(businessItemPlace({
    storeKey: 'JP-01', checkId: 'reviews', checkTitle: 'Customer Reviews 检查',
  }, []), { label: 'JP-01 · Customer Reviews 检查', view: 'customer-voice' });
  const unmapped = businessItemPlace({
    storeName: 'US-02', checkId: 'not-a-page', checkTitle: '未知检查',
  }, []);
  assert.equal(unmapped.view, null);
  assert.equal(unmapped.label, 'US-02 · 未知检查');
  assert.equal(businessItemPlace(null, null).label, '店铺 · 检查项');
  assert.match(DASHBOARD_HTML, /function businessPlacesHtml\(\)/);
  assert.match(DASHBOARD_HTML, /class="kpi-places"/);
  assert.match(DASHBOARD_HTML, /if\(!rows\.length\)return ''/);
  assert.match(DASHBOARD_HTML, /if\(!place\.view\|\|!VIEW_META\[place\.view\]\)return '<li><span class="kpi-place"/);
  assert.match(DASHBOARD_HTML, /data-view="'\+esc\(place\.view\)\+'"/);
  assert.match(DASHBOARD_HTML, /function businessItemPlace\(issue, checks\)/);
  assert.match(DASHBOARD_HTML, /outlet: 'product-status'/);
  assert.match(DASHBOARD_HTML, /label: storeName \+ ' · ' \+ area/);
});

test('evidence viewer preserves raw screenshots while making store identity explicit', () => {
  const source = fs.readFileSync(path.resolve('src/server.js'), 'utf8');
  assert.match(source, /原始只读截图，未添加水印或修改像素/);
  assert.match(source, /控制台的业务状态和结构化明细会再按当前店铺的有效 ASIN 清单过滤/);
  assert.match(source, /p === '\/evidence'/);
  assert.match(source, /img-src 'self'/);
});

test('Ziniao session health separates login blockers from other collection failures', () => {
  const rows = buildSessionHealth([
    {
      key: 'JUNJUN', name: 'JUNJUN', market: 'US', cells: {
        health: { state: 'ERROR', actionState: 'COLLECTION', status: 'LOGIN_REQUIRED', reasons: ['等待紫鸟自动填入 Amazon 验证码超时'], lastRunAt: '2026-08-28T09:00:00+08:00' },
        reviews: { state: 'OK', actionState: 'NORMAL', status: 'CLEAR', lastRunAt: '2026-08-27T09:00:00+08:00' },
      },
    },
    {
      key: 'A', name: 'A', market: 'US', cells: {
        health: { state: 'OK', actionState: 'NORMAL', status: 'HEALTHY', lastRunAt: '2026-08-28T08:00:00+08:00' },
      },
    },
  ]);
  assert.equal(rows[0].state, 'BLOCKED');
  assert.equal(rows[0].loginFailures, 1);
  assert.equal(rows[0].lastSuccessfulAt, '2026-08-27T09:00:00+08:00');
  assert.equal(rows[1].state, 'READY');
});

test('dashboard action states route business, collection and stale results to the right owner', () => {
  assert.equal(actionStateFor({ state: 'OK' }), 'NORMAL');
  assert.equal(actionStateFor({ state: 'WARN' }), 'BUSINESS');
  assert.equal(actionStateFor({ state: 'CRITICAL' }), 'BUSINESS');
  assert.equal(actionStateFor({ state: 'ERROR' }), 'COLLECTION');
  assert.equal(actionStateFor({ state: 'NOT_CONFIGURED' }), 'COLLECTION');
  assert.equal(actionStateFor({ state: 'OK', stale: true }), 'COLLECTION');
  assert.equal(actionStateFor({ state: 'NEVER_RUN' }), 'PENDING');
  assert.equal(worstAction(['NORMAL', 'COLLECTION', 'BUSINESS']), 'BUSINESS');
  assert.equal(rawStateLabel('OK', { stale: true }), '数据过期');
});
