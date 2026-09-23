import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAlerter, hasConfiguredDingTalk, partitionAlertProblems } from '../src/lib/alert.js';
import { buildCrmRecords, pushToCrm, writeCrmCompatibilityExport } from '../src/lib/crm.js';
import { configuredHint } from '../src/lib/configured-hints.js';
import { pushToDashboard } from '../src/lib/ingest.js';
import { createLogger } from '../src/lib/log.js';
import { writeGenericReports } from '../src/lib/report.js';
import { createStateStore } from '../src/lib/state.js';
import { selectAdvertisingCampaignStateResilient } from '../src/lib/check-runner.js';
import { bjStamp } from '../src/lib/time.js';
import { assertSafeRetentionRoot, runRetention, retentionPlan, retentionClass } from '../src/tools/retention.js';
import { runTestNotify } from '../src/tools/test-notify.js';
import { isTransientZiniaoStartupFailure, runDoctorWithStartupGrace } from '../src/lib/collector-health.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function filesUnder(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function allText(root) {
  return filesUnder(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

function loggerStub() {
  const entries = [];
  const add = (level) => (...args) => entries.push({ level, text: args.map(String).join(' ') });
  return {
    entries,
    debug: add('debug'), info: add('info'), warn: add('warn'), error: add('error'), plain: add('plain'),
  };
}

test('Amazon Ads state selection retries one transient repaint and fails fast on permanent errors', async () => {
  const log = loggerStub();
  let transientCalls = 0;
  const recovered = await selectAdvertisingCampaignStateResilient({
    zn: {
      async selectAdvertisingCampaignState() {
        transientCalls++;
        if (transientCalls === 1) throw new Error('stale element reference');
        return { state: 'ENABLED', changed: false };
      },
    },
    storeId: 'opaque', state: 'ENABLED', logger: log, storeKey: 'SAFE',
    timeoutMs: 10, retryDelayMs: 0,
  });
  assert.deepEqual(recovered, { state: 'ENABLED', changed: false });
  assert.equal(transientCalls, 2);
  assert.equal(log.entries.filter((entry) => entry.level === 'warn').length, 1);

  let permanentCalls = 0;
  await assert.rejects(selectAdvertisingCampaignStateResilient({
    zn: {
      async selectAdvertisingCampaignState() {
        permanentCalls++;
        throw new Error('unapproved page');
      },
    },
    storeId: 'opaque', state: 'PAUSED', logger: log, storeKey: 'SAFE',
    timeoutMs: 10, retryDelayMs: 0,
  }), /unapproved page/);
  assert.equal(permanentCalls, 1);
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function reviewPayload() {
  return {
    check: 'reviews', runId: 'reviews-20260827-120000-007', slot: 'am',
    startedAt: '2026-08-27T12:00:00+08:00', finishedAt: '2026-08-27T12:00:01+08:00',
    records: [{
      check: 'reviews', runId: 'reviews-20260827-120000-007', slot: 'am',
      checkedAt: '2026-08-27T12:00:01+08:00', storeKey: 'STORE-A', storeName: 'Store A', market: 'US',
      status: 'LOW_REVIEW', severity: 'CRITICAL', ok: false, metrics: { lowRatings: 2 },
      anomalyReasons: ['发现低于 4 星评论'],
      items: [
        { asin: 'B000000001', reviewId: 'SHARED-ID', rating: 2, title: 'Low review', date: '2026-08-26' },
        { asin: 'B000000002', reviewId: 'SHARED-ID', rating: 2, title: 'Low review', date: '2026-08-26' },
      ],
    }],
  };
}

test('DingTalk configured state supports both a legacy single channel and named channels', () => {
  assert.equal(hasConfiguredDingTalk({ alert: { dingtalk: {
    enabled: true, webhook: 'https://example.test/robot', channels: [],
  } } }), true);
  assert.equal(hasConfiguredDingTalk({ alert: { dingtalk: {
    enabled: true, webhook: '', channels: [{ name: 'regular', enabled: true, webhook: 'https://example.test/robot' }],
  } } }), true);
  assert.equal(hasConfiguredDingTalk({ alert: { dingtalk: {
    enabled: true, webhook: '', channels: [],
  } } }), false);
});

test('least-privilege dashboard readiness hints are explicit and fail closed', () => {
  assert.equal(configuredHint('AMZGUARD_DINGTALK_CONFIGURED', true, {}), true);
  assert.equal(configuredHint('AMZGUARD_DINGTALK_CONFIGURED', false, {
    AMZGUARD_DINGTALK_CONFIGURED: '1',
  }), true);
  assert.equal(configuredHint('AMZGUARD_DINGTALK_CONFIGURED', true, {
    AMZGUARD_DINGTALK_CONFIGURED: '0',
  }), false);
  assert.equal(configuredHint('AMZGUARD_DINGTALK_CONFIGURED', true, {
    AMZGUARD_DINGTALK_CONFIGURED: 'unexpected',
  }), false);
});

test('deployment manifest excludes macOS AppleDouble sidecars from config artifacts', () => {
  const script = fs.readFileSync(path.resolve('deploy/manifest.sh'), 'utf8');
  assert.match(script, /find config[^\n]+-name '\*\.example\.json'[^\n]+! -name '\._\*'/);
});

test('deployment pack rejects secret file types, symlinks and high-confidence credential content', (t) => {
  const packScript = fs.readFileSync(path.resolve('scripts/pack.sh'), 'utf8');
  const roots = [];
  t.after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });
  const fixture = () => {
    const root = tempDir('amzguard-pack-test-');
    roots.push(root);
    for (const dir of ['src', 'config', 'scripts', 'deploy', 'docs', 'test']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'scripts', 'pack.sh'), packScript, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const ready = true;\n');
    for (const file of ['config.example.json', 'stores.example.json', 'asins.example.json']) {
      fs.writeFileSync(path.join(root, 'config', file), '{}\n');
    }
    for (const file of ['config.json', 'stores.json', 'asins.json']) {
      fs.writeFileSync(path.join(root, 'config', file), '{"localOnly":true}\n');
    }
    fs.mkdirSync(path.join(root, 'src', 'out', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'out', 'runtime', 'report.json'), '{}\n');
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out', 'latest.json'), '{}\n');
    for (const file of ['package.json', 'package-lock.json', 'README.md', 'DEPLOY.md', 'AGENTS.md', '.gitignore']) {
      fs.writeFileSync(path.join(root, file), file.endsWith('.json') ? '{}\n' : 'fixture\n');
    }
    return root;
  };
  const run = (root, env = {}) => spawnSync('bash', ['scripts/pack.sh'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', ...env },
  });

  const cleanRoot = fixture();
  const clean = run(cleanRoot);
  assert.equal(clean.status, 0, clean.stderr);
  const archive = path.join(cleanRoot, 'dist', 'amzguard.zip');
  assert.equal(mode(archive), 0o600);
  const entries = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
  assert.equal(entries.status, 0, entries.stderr);
  assert.doesNotMatch(entries.stdout, /^config\/(config|stores|asins)\.json$/m);
  assert.doesNotMatch(entries.stdout, /(^|\/)out\//m);

  const configBackupRoot = fixture();
  fs.writeFileSync(
    path.join(configBackupRoot, 'config', 'config.backup.json'),
    '{"url":"https://sellercentral.amazon.com/home?openid=SHOULD_NOT_SHIP"}\n',
  );
  const backupPacked = run(configBackupRoot);
  assert.equal(backupPacked.status, 0, backupPacked.stderr);
  const backupEntries = spawnSync(
    'unzip', ['-Z1', path.join(configBackupRoot, 'dist', 'amzguard.zip')], { encoding: 'utf8' },
  );
  assert.equal(backupEntries.status, 0, backupEntries.stderr);
  assert.doesNotMatch(backupEntries.stdout, /^config\/config\.backup\.json$/m);

  const hardlinkRoot = fixture();
  const externalHardlinkSource = path.join(hardlinkRoot, 'outside-release.txt');
  fs.writeFileSync(externalHardlinkSource, 'outside release bytes\n');
  fs.linkSync(externalHardlinkSource, path.join(hardlinkRoot, 'docs', 'ordinary-note.txt'));
  const hardlinkBlocked = run(hardlinkRoot);
  assert.equal(hardlinkBlocked.status, 2, hardlinkBlocked.stderr);
  assert.match(hardlinkBlocked.stderr, /硬链接/);
  assert.doesNotMatch(hardlinkBlocked.stderr, /ordinary-note|outside-release/);

  for (const name of ['secret.ENV', 'secret.PeM', 'secret.KEY', 'secret.P12', 'secret.pFx', '.EnV.Production']) {
    const root = fixture();
    fs.mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'nested', name), 'not a credential\n');
    const blocked = run(root);
    assert.equal(blocked.status, 2, `${name}: ${blocked.stderr}`);
    assert.doesNotMatch(blocked.stderr, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  const symlinkRoot = fixture();
  fs.writeFileSync(path.join(symlinkRoot, 'outside.txt'), 'outside release roots\n');
  fs.symlinkSync('../outside.txt', path.join(symlinkRoot, 'docs', 'linked.txt'));
  const symlinkBlocked = run(symlinkRoot);
  assert.equal(symlinkBlocked.status, 2, symlinkBlocked.stderr);

  const racedSymlinkRoot = fixture();
  fs.writeFileSync(path.join(racedSymlinkRoot, 'outside.txt'), 'outside release roots\n');
  fs.symlinkSync('../outside.txt', path.join(racedSymlinkRoot, 'docs', 'raced-link.txt'));
  const fakeBin = path.join(racedSymlinkRoot, 'fake-bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'find'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const racedSymlinkBlocked = run(racedSymlinkRoot, { PATH: `${fakeBin}:${process.env.PATH}` });
  assert.equal(racedSymlinkBlocked.status, 2, racedSymlinkBlocked.stderr);
  assert.match(racedSymlinkBlocked.stderr, /归档包含符号链接/);
  assert.doesNotMatch(racedSymlinkBlocked.stderr, /raced-link/);

  for (const marker of [
    `SEC${'a'.repeat(40)}`,
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    `ZINIAO_PASSWORD=${'x'.repeat(16)}`,
  ]) {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'docs', 'ordinary.txt'), `${marker}\n`);
    const blocked = run(root);
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /高置信凭据模式/);
    assert.doesNotMatch(blocked.stderr, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('generic reports write four dated artifacts plus latest, with row-level CSV, private atomic files and redaction', () => {
  const outDir = tempDir('amzguard-report-');
  const runId = 'reviews-20260827-120000-007';
  const summary = {
    check: 'reviews', checkNo: 4, checkTitle: 'Customer Reviews', runId, slot: 'am',
    startedAt: '2026-08-27T12:00:00+08:00', finishedAt: '2026-08-27T12:00:01+08:00',
    requirement: '低于 4 星必须报警', totals: { total: 1, ok: 0, abnormal: 1, errors: 0, warnings: 0 },
    results: [{
      check: 'reviews', runId, slot: 'am', checkedAt: '2026-08-27T12:00:01+08:00',
      storeKey: 'STORE-A', storeName: 'Store A', market: 'US', status: 'LOW_REVIEW', severity: 'CRITICAL',
      ok: false, confidence: 'high', verdictSource: 'dom+text', attempts: 1, durationMs: 432,
      url: 'https://sellercentral.amazon.com/reviews?openid=REPORT_URL_SECRET#sso',
      screenshot: path.join(outDir, 'reviews', 'evidence', 'shot.png'),
      rawTextFile: '/Users/operator/private/raw.txt',
      error: 'renderer trace at /Users/operator/private/trace.log',
      metrics: { lowRatings: 2 }, anomalyReasons: ['发现低于 4 星评论'],
      items: [
        { asin: 'B000000001', rating: 2, title: '=HYPERLINK("bad")', url: 'https://amazon.com/dp/B000000001?token=ITEM_URL_SECRET' },
        { asin: 'B000000002', rating: 3, title: 'Another review', evidencePath: '/etc/secret-evidence' },
      ],
    }],
  };

  const first = writeGenericReports({ outDir, check: 'reviews', summary });
  const datedFiles = fs.readdirSync(first.dir).sort();
  assert.deepEqual(datedFiles, [
    `${runId}.csv`, `${runId}.html`, `${runId}.json`, `${runId}_items.csv`,
  ]);
  assert.ok(fs.existsSync(first.files.latest));
  for (const file of Object.values(first.files)) assert.equal(mode(file), 0o600, `${file} must be private`);
  assert.equal(mode(first.dir), 0o700);
  assert.equal(filesUnder(outDir).some((file) => file.endsWith('.tmp')), false);

  const details = fs.readFileSync(first.files.detailsCsv, 'utf8');
  assert.equal(details.trimEnd().split('\n').length, 3, 'header plus one row per review');
  assert.match(details, /B000000001/);
  assert.match(details, /B000000002/);
  assert.match(details, /'=HYPERLINK/);

  const persisted = allText(outDir);
  assert.doesNotMatch(persisted, /REPORT_URL_SECRET|ITEM_URL_SECRET|\/Users\/operator|\/etc\/secret-evidence/);
  assert.match(persisted, /https:\/\/sellercentral\.amazon\.com\/reviews/);
  assert.match(persisted, /reviews\/evidence\/shot\.png/);
  assert.match(persisted, /\[REDACTED_PATH\]/);

  summary.results[0].metrics.lowRatings = 3;
  const second = writeGenericReports({ outDir, check: 'reviews', summary });
  assert.deepEqual(fs.readdirSync(second.dir).sort(), datedFiles, 'same run id rewrites instead of duplicating');
  assert.equal(JSON.parse(fs.readFileSync(second.files.latest, 'utf8')).results[0].metrics.lowRatings, 3);
});

test('CRM record keys are stable and never collide across ASINs', () => {
  const payload = reviewPayload();
  const first = buildCrmRecords(payload);
  const second = buildCrmRecords(structuredClone(payload));
  assert.deepEqual(second, first);
  assert.equal(first.length, 2);
  assert.notEqual(first[0].idempotencyKey, first[1].idempotencyKey,
    'the ASIN must remain part of identity even when upstream IDs are reused');
});

test('CRM VOC intrinsic identifiers override mutable fields and legacy item keys', () => {
  const recordKey = ({ asin = 'B000000001', identifier = 'RETURN-IMMUTABLE-1', legacyKey,
    recordId, returnId, date, returnReason, customerIssue, source }) => {
    const records = buildCrmRecords({
      check: 'voc', runId: 'voc-id-test', slot: 'adhoc',
      records: [{
        check: 'voc', storeKey: 'STORE-A', market: 'US', status: 'CLEAR', severity: 'OK', ok: true,
        items: [{
          asin, itemKey: `voc-asin:${asin}`,
          records: [{
            asin, identifier, recordId, returnId, itemKey: legacyKey, date, returnReason, customerIssue, source,
          }],
        }],
      }],
    });
    return records.find((record) => record.entity?.entityType === 'voc-record').idempotencyKey;
  };

  const before = recordKey({
    legacyKey: 'legacy-key-old', date: '2026-08-26', returnReason: 'Item defective',
    customerIssue: 'Packaging damaged', source: 'dom-en',
  });
  const translated = recordKey({
    legacyKey: 'legacy-key-new', date: '2026-08-27', returnReason: '商品存在瑕疵',
    customerIssue: '包装破损', source: 'text-zh',
  });
  assert.equal(translated, before, 'mutable display fields and old itemKey must not change the CRM key');
  assert.notEqual(recordKey({
    identifier: 'RETURN-IMMUTABLE-2', legacyKey: 'legacy-key-new', date: '2026-08-27',
    returnReason: '商品存在瑕疵', customerIssue: '包装破损', source: 'text-zh',
  }), before, 'a genuinely different intrinsic identifier must change the key');
  assert.notEqual(recordKey({
    asin: 'B000000002', legacyKey: 'legacy-key-new', date: '2026-08-27',
    returnReason: '商品存在瑕疵', customerIssue: '包装破损', source: 'text-zh',
  }), before, 'ASIN remains part of the natural key');

  const returnIdBefore = recordKey({
    identifier: null, returnId: 'RETURN-NATIVE-3', legacyKey: 'legacy-return-old',
    date: '2026-08-26', returnReason: 'Item defective', customerIssue: 'Packaging damaged', source: 'dom-en',
  });
  const returnIdAfter = recordKey({
    identifier: null, returnId: 'RETURN-NATIVE-3', legacyKey: 'legacy-return-new',
    date: '2026-08-27', returnReason: '性能或品质不理想', customerIssue: '包装破损', source: 'text-zh',
  });
  assert.equal(returnIdAfter, returnIdBefore, 'native returnId must also outrank a legacy itemKey');
});

test('CRM retries with one Idempotency-Key, writes a private ledger, suppresses duplicates and never stores response bodies', async (t) => {
  const requests = [];
  const responseSecret = 'CRM_RESPONSE_BODY_SECRET';
  const endpointSecret = 'CRM_ENDPOINT_QUERY_SECRET';
  const service = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (requests.length === 1) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end(responseSecret);
    } else {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, detail: responseSecret }));
    }
  });
  t.after(service.close);

  const outDir = tempDir('amzguard-crm-');
  const logger = loggerStub();
  const config = {
    outDir,
    crm: {
      enabled: true, endpoint: `${service.origin}/upsert?access_token=${endpointSecret}`,
      retries: 1, timeoutMs: 3000, headers: { Authorization: 'Bearer CRM_HEADER_SECRET' },
    },
  };
  const payload = reviewPayload();
  const result = await pushToCrm({ config, logger, payload });
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.attempts.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key']);
  assert.equal(requests[0].headers.authorization, 'Bearer CRM_HEADER_SECRET');
  assert.deepEqual(JSON.parse(requests[0].body), JSON.parse(requests[1].body));

  const ledger = path.join(outDir, 'channels', 'crm', 'ledger.json');
  assert.equal(mode(ledger), 0o600);
  assert.equal(mode(path.dirname(ledger)), 0o700);
  const persisted = allText(outDir);
  assert.doesNotMatch(persisted, new RegExp(`${responseSecret}|${endpointSecret}|CRM_HEADER_SECRET`));

  const before = requests.length;
  const duplicate = await pushToCrm({ config, logger, payload: structuredClone(payload) });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.records, 0);
  assert.equal(duplicate.duplicateSuppressed, 2);
  assert.equal(requests.length, before, 'an identical completed batch must not make another request');
});

test('CRM fails closed on a damaged ledger and dry-run never sends a request', async (t) => {
  let requests = 0;
  const service = await listen((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  t.after(service.close);
  const logger = loggerStub();

  const damagedOut = tempDir('amzguard-crm-damaged-');
  const damagedDir = path.join(damagedOut, 'channels', 'crm');
  fs.mkdirSync(damagedDir, { recursive: true });
  fs.writeFileSync(path.join(damagedDir, 'ledger.json'), '{not-json');
  await assert.rejects(
    pushToCrm({
      config: { outDir: damagedOut, crm: { enabled: true, endpoint: `${service.origin}/crm`, retries: 0 } },
      logger, payload: reviewPayload(),
    }),
    /账本损坏.*拒绝继续发送/,
  );
  assert.equal(requests, 0);

  const dryOut = tempDir('amzguard-crm-dry-');
  const dry = await pushToCrm({
    config: { outDir: dryOut, crm: { enabled: true, endpoint: `${service.origin}/crm`, retries: 0 } },
    logger, payload: reviewPayload(), dryRun: true,
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.attempted, false);
  assert.equal(requests, 0);
  assert.match(allText(dryOut), /"event":"dry-run"/);
});

test('CRM flattens VOC return records into independent upserts, retains ASIN summaries and deduplicates the batch', async (t) => {
  const requests = [];
  const service = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  t.after(service.close);
  const payload = {
    check: 'voc', runId: 'voc-20260827-120000-007', slot: 'am',
    startedAt: '2026-08-27T12:00:00+08:00', finishedAt: '2026-08-27T12:00:01+08:00',
    records: [{
      check: 'voc', checkedAt: '2026-08-27T12:00:01+08:00', storeKey: 'STORE-A', market: 'US',
      status: 'POOR_CX', severity: 'CRITICAL', ok: false,
      items: [
        {
          asin: 'B000000001', itemKey: 'voc-asin-one', cxHealth: 'Poor', ncxRatePct: 4.2,
          records: [
            { asin: 'B000000001', itemKey: 'shared-return-id', identifier: 'RETURN-1', returnReason: 'Damaged item' },
            { asin: 'B000000001', itemKey: 'return-two', identifier: 'RETURN-2', returnReason: 'Wrong item' },
          ],
        },
        {
          asin: 'B000000002', itemKey: 'voc-asin-two', cxHealth: 'Good', ncxRatePct: 0.4,
          records: [
            { asin: 'B000000002', itemKey: 'shared-return-id', identifier: 'RETURN-1', returnReason: 'Damaged item' },
          ],
        },
      ],
    }],
  };

  const built = buildCrmRecords(payload);
  assert.equal(built.length, 5, 'two ASIN summaries plus three independent return records');
  assert.equal(new Set(built.map((record) => record.idempotencyKey)).size, built.length);
  assert.equal(built.filter((record) => record.entity?.entityType === 'voc-asin').length, 2,
    'ASIN overview rows are retained');
  assert.equal(built.filter((record) => record.entity?.entityType === 'voc-record').length, 3,
    'nested VOC rows are flattened');
  assert.deepEqual(
    new Set(built.filter((record) => record.entity?.entityType === 'voc-record').map((record) => record.entity.asin)),
    new Set(['B000000001', 'B000000002']),
  );

  const outDir = tempDir('amzguard-crm-voc-');
  const config = { outDir, crm: { enabled: true, endpoint: `${service.origin}/crm`, retries: 0 } };
  const first = await pushToCrm({ config, logger: loggerStub(), payload });
  assert.equal(first.ok, true);
  assert.equal(first.records, 5);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].records.length, 5);
  const second = await pushToCrm({ config, logger: loggerStub(), payload: structuredClone(payload) });
  assert.equal(second.ok, true);
  assert.equal(second.records, 0);
  assert.equal(second.duplicateSuppressed, 5);
  assert.equal(requests.length, 1);
});

test('CRM compatibility export is local-only, stable and SellerMaking field aligned', () => {
  const outDir = tempDir('amzguard-crm-export-');
  const payload = reviewPayload();
  payload.records[0].items[0].title = '=spreadsheet formula';
  const result = writeCrmCompatibilityExport({ outDir, payload });
  assert.equal(result.ok, true);
  assert.equal(result.profile, 'sellermaking-readonly-v1');
  assert.equal(result.records, 2);
  assert.equal(path.isAbsolute(result.files.csv), false, 'dashboard/report must not expose server paths');
  const csvFile = path.join(outDir, result.files.csv);
  const manifestFile = path.join(outDir, result.files.manifest);
  const csv = fs.readFileSync(csvFile, 'utf8');
  assert.ok(csv.startsWith('\uFEFFsource_id,entity_type,check,shop_name'));
  assert.match(csv, /marketplace_name/);
  assert.match(csv, /star,rating,comments,response,order_id/);
  assert.match(csv, /'=spreadsheet formula/);
  assert.equal(mode(csvFile), 0o600);
  assert.equal(mode(manifestFile), 0o600);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.equal(manifest.mode, 'local-export-only');
  assert.equal(manifest.records, 2);
  assert.match(allText(path.join(outDir, 'channels', 'crm-export')), /compatibility-export/);
});

test('mixed business and collection results become separate recipient-specific alerts', () => {
  const collection = { storeKey: 'A', severity: 'ERROR' };
  const business = { storeKey: 'B', severity: 'CRITICAL' };
  const attention = { storeKey: 'C', severity: 'WARN' };
  const unknown = { storeKey: 'D', severity: 'NEW_UNRECOGNIZED_STATE' };
  const groups = partitionAlertProblems([collection, business, attention, unknown, { severity: 'OK' }]);
  assert.deepEqual(groups.map((group) => group.severity), ['ERROR', 'CRITICAL', 'WARN']);
  assert.deepEqual(groups[0].problems, [collection, unknown]);
  assert.deepEqual(groups[1].problems, [business]);
  assert.deepEqual(groups[2].problems, [attention]);
});

test('alert routing is severity-specific and audits the sanitized dashboard URL without response bodies', async (t) => {
  const requests = [];
  const responseSecret = 'DINGTALK_RESPONSE_BODY_SECRET';
  const dashboardSecret = 'DASHBOARD_QUERY_SECRET';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: String(options?.body || '') });
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ errcode: 0, errmsg: responseSecret }); },
    };
  });

  const outDir = tempDir('amzguard-alert-');
  const alerter = createAlerter({
    outDir, logger: loggerStub(),
    config: {
      outDir, dashboard: { publicUrl: `https://dashboard.example.test/console?token=${dashboardSecret}#session` },
      alert: {
        console: false, file: true,
        dingtalk: { channels: [
          { name: 'operations', enabled: true, webhook: 'https://oapi.dingtalk.com/robot/send?access_token=OPS_TOKEN', severities: ['ERROR', 'WARN'] },
          { name: 'regular', enabled: true, webhook: 'https://oapi.dingtalk.com/robot/send?access_token=REGULAR_TOKEN', severities: ['OK', 'CRITICAL'] },
        ] },
      },
    },
  });
  const business = await alerter.send({
    check: 'reviews', severity: 'CRITICAL', title: '低星评价', lines: ['店铺：STORE-A'],
  });
  const infrastructure = await alerter.send({
    check: 'reviews', severity: 'ERROR', title: '采集失败', lines: ['店铺：STORE-A'],
  });

  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /access_token=REGULAR_TOKEN/);
  assert.match(requests[1].url, /access_token=OPS_TOKEN/);
  assert.deepEqual(Object.keys(business.delivery).sort(), ['dingtalk:regular', 'file']);
  assert.deepEqual(Object.keys(infrastructure.delivery).sort(), ['dingtalk:operations', 'file']);
  const sentText = requests.map((entry) => entry.body).join('\n');
  assert.match(sentText, /https:\/\/dashboard\.example\.test\/console/);
  assert.match(sentText, /亚马逊店铺巡检通知/);
  assert.match(sentText, /结论.*业务异常/);
  assert.match(sentText, /处置建议/);
  assert.match(sentText, /结论.*采集故障/);
  assert.doesNotMatch(sentText, /[✅⚠️🔴❗]/u);
  assert.doesNotMatch(sentText, new RegExp(dashboardSecret));

  const auditText = fs.readFileSync(alerter.fileSink, 'utf8');
  assert.equal(auditText.trimEnd().split('\n').length, 2);
  assert.match(auditText, /https:\/\/dashboard\.example\.test\/console/);
  assert.doesNotMatch(auditText, new RegExp(`${responseSecret}|${dashboardSecret}|OPS_TOKEN|REGULAR_TOKEN`));
  assert.equal(mode(alerter.fileSink), 0o600);
  assert.equal(mode(path.dirname(alerter.fileSink)), 0o700);
});

test('business DingTalk robot receives page-evidence alerts and skips collection failures', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: String(options?.body || '') });
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ errcode: 0, errmsg: 'ok' }); },
    };
  });
  const outDir = tempDir('amzguard-alert-business-');
  const alerter = createAlerter({
    outDir, logger: loggerStub(),
    config: {
      outDir, dashboard: {},
      alert: {
        console: false, file: false,
        dingtalk: { channels: [
          { name: 'regular', enabled: true, webhook: 'https://oapi.dingtalk.com/robot/send?access_token=REGULAR_FIXTURE', severities: ['OK', 'CRITICAL'] },
          { name: 'operations', enabled: true, webhook: 'https://oapi.dingtalk.com/robot/send?access_token=OPS_FIXTURE', severities: ['ERROR', 'WARN'] },
          { name: 'business', enabled: true, webhook: 'https://oapi.dingtalk.com/robot/send?access_token=BUSINESS_FIXTURE', severities: ['CRITICAL', 'WARN'] },
        ] },
      },
    },
  });

  await alerter.send({
    check: 'voc', severity: 'CRITICAL', title: '页面证据业务异常',
    lines: ['**US-01** → POOR_CX', '**US-02** → SHOULD_BE_OFF', '**US-03** → LOW_REVIEW'],
    data: { stores: [
      { storeKey: 'US-01', status: 'POOR_CX' },
      { storeKey: 'US-02', status: 'SHOULD_BE_OFF' },
      { storeKey: 'US-03', status: 'LOW_REVIEW' },
    ] },
  });
  await alerter.send({
    check: 'asin-health', severity: 'WARN', title: '评分下降',
    lines: ['**B0TESTASIN** (US) → RATING_DROP'],
    data: { stores: [{ status: 'RATING_DROP' }] },
  });
  await alerter.send({
    check: 'store-health', severity: 'ERROR', title: '采集失败',
    lines: ['**US-04** → LOGIN_REQUIRED', '**US-05** → PARTIAL_EVIDENCE'],
    data: { stores: [
      { storeKey: 'US-04', status: 'LOGIN_REQUIRED' },
      { storeKey: 'US-05', status: 'PARTIAL_EVIDENCE' },
    ] },
  });
  await alerter.send({
    check: 'ads-status', severity: 'ERROR', title: '证据不足',
    lines: ['**US-06** → PARTIAL_EVIDENCE'],
    data: { stores: [{ status: 'PARTIAL_EVIDENCE' }] },
  });
  await alerter.send({
    check: 'reviews', severity: 'WARN', title: '配置缺失',
    lines: ['**US-07** → NOT_CONFIGURED'],
    data: { stores: [{ status: 'NOT_CONFIGURED' }] },
  });

  const business = requests.filter((entry) => /access_token=BUSINESS_FIXTURE/.test(entry.url));
  const regular = requests.filter((entry) => /access_token=REGULAR_FIXTURE/.test(entry.url));
  const operations = requests.filter((entry) => /access_token=OPS_FIXTURE/.test(entry.url));
  const businessText = business.map((entry) => entry.body).join('\n');
  assert.equal(business.length, 2);
  assert.match(businessText, /POOR_CX/);
  assert.match(businessText, /SHOULD_BE_OFF/);
  assert.match(businessText, /LOW_REVIEW/);
  assert.match(businessText, /RATING_DROP/);
  assert.match(businessText, /亚马逊店铺巡检通知/);
  assert.doesNotMatch(businessText, /LOGIN_REQUIRED|PARTIAL_EVIDENCE|NOT_CONFIGURED/);
  assert.equal(regular.length, 1);
  assert.match(regular[0].body, /POOR_CX/);
  assert.doesNotMatch(regular.map((entry) => entry.body).join('\n'), /LOGIN_REQUIRED|RATING_DROP/);
  assert.equal(operations.length, 4);
  assert.match(operations.map((entry) => entry.body).join('\n'), /LOGIN_REQUIRED/);
  assert.match(operations.map((entry) => entry.body).join('\n'), /PARTIAL_EVIDENCE/);
  assert.match(operations.map((entry) => entry.body).join('\n'), /RATING_DROP/);
  assert.equal(requests.some((entry) => /oapi\.dingtalk\.com/.test(entry.url) && !/FIXTURE/.test(entry.url)), false);
});

test('DINGTALK_BUSINESS_WEBHOOK adds a business route without moving the existing robots', () => {
  const root = tempDir('amzguard-business-env-');
  const configFile = path.join(root, 'config.json');
  const storesFile = path.join(root, 'stores.json');
  fs.writeFileSync(configFile, JSON.stringify({ paths: { outDir: root } }));
  fs.writeFileSync(storesFile, JSON.stringify({ stores: [] }));
  const script = `import { loadConfig } from ${JSON.stringify(path.join(process.cwd(), 'src/lib/config.js'))};
    const { config } = loadConfig({ configFile: process.argv[1], storesFile: process.argv[2] });
    const channels = (config.alert.dingtalk.channels || []).map((channel) => ({
      name: channel.name, enabled: channel.enabled, severities: channel.severities,
      webhook: channel.webhook,
    }));
    console.log(JSON.stringify({ enabled: config.alert.dingtalk.enabled, legacy: config.alert.dingtalk.webhook, channels }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, configFile, storesFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DINGTALK_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=REGULAR_FIXTURE',
      DINGTALK_SECRET: 'regular-fixture-secret',
      DINGTALK_OPS_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=OPS_FIXTURE',
      DINGTALK_OPS_SECRET: 'ops-fixture-secret',
      DINGTALK_BUSINESS_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=BUSINESS_FIXTURE',
      DINGTALK_BUSINESS_SECRET: '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const loaded = JSON.parse(result.stdout);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.legacy, '');
  assert.deepEqual(loaded.channels.map((channel) => channel.name), ['regular', 'operations', 'business']);
  assert.deepEqual(loaded.channels[0].severities, ['OK', 'CRITICAL']);
  assert.deepEqual(loaded.channels[1].severities, ['ERROR', 'WARN']);
  assert.deepEqual(loaded.channels[2].severities, ['CRITICAL', 'WARN']);
  assert.match(loaded.channels[2].webhook, /BUSINESS_FIXTURE/);
  assert.doesNotMatch(result.stderr, /BUSINESS_FIXTURE|REGULAR_FIXTURE|OPS_FIXTURE/);
});

test('generic alert webhook refuses cleartext non-loopback endpoints without a request', async () => {
  const outDir = tempDir('amzguard-alert-http-');
  const logger = loggerStub();
  const alerter = createAlerter({
    outDir, logger,
    config: {
      outDir, dashboard: {},
      alert: {
        console: false, file: true, dingtalk: { enabled: false },
        webhook: { enabled: true, url: 'http://example.invalid/hook?token=DO_NOT_STORE' },
      },
    },
  });
  const result = await alerter.send({
    check: 'reviews', severity: 'ERROR', title: '采集失败', lines: ['店铺：STORE-A'],
  });
  assert.equal(result.delivery.webhook.errorClass, 'ConfigurationError');
  assert.match(result.delivery.webhook.reason, /HTTPS/);
  const persisted = allText(outDir);
  assert.doesNotMatch(persisted, /DO_NOT_STORE/);
  assert.match(logger.entries.map((entry) => entry.text).join('\n'), /拒绝发送/);
});

test('state store rejects malformed and structurally damaged baselines, then writes atomically and privately', () => {
  const outDir = tempDir('amzguard-state-');
  const store = createStateStore({ outDir, name: 'reviews' });
  fs.mkdirSync(path.dirname(store.file), { recursive: true });
  fs.writeFileSync(store.file, '{broken-json');
  assert.throws(() => store.read(), /状态文件损坏.*停止覆盖有效基线/);
  fs.writeFileSync(store.file, 'null\n');
  assert.throws(() => store.read(), /状态文件损坏.*停止覆盖有效基线/);

  store.write({ version: 1, stores: { 'STORE-A': { status: 'CLEAR' } } });
  assert.deepEqual(store.read().stores['STORE-A'], { status: 'CLEAR' });
  assert.equal(mode(store.file), 0o600);
  assert.equal(mode(path.dirname(store.file)), 0o700);
  assert.equal(filesUnder(outDir).some((file) => file.endsWith('.tmp')), false);
});

test('bjStamp includes Beijing wall time and millisecond precision', () => {
  const first = bjStamp(new Date('2026-08-27T00:00:00.007+08:00'));
  const second = bjStamp(new Date('2026-08-27T00:00:00.008+08:00'));
  assert.equal(first, '20260827-000000-007');
  assert.equal(second, '20260827-000000-008');
  assert.match(first, /^\d{8}-\d{6}-\d{3}$/);
  assert.notEqual(first, second);
});

test('logger redacts URL credentials, secret values and absolute paths in its private file', async () => {
  const root = tempDir('amzguard-log-');
  const file = path.join(root, 'logs', 'collector.log');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.dirname(file), 0o755);
  fs.writeFileSync(file, 'legacy log\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const logger = createLogger({ level: 'info', file, useColor: false });
  logger.info('url=https://example.test/report?token=LOG_URL_SECRET#sso', {
    token: 'LOG_OBJECT_SECRET', path: '/Users/operator/private/report.json', healthy: true,
  });
  await logger.close();
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /LOG_URL_SECRET|LOG_OBJECT_SECRET|\/Users\/operator/);
  assert.match(text, /https:\/\/example\.test\/report/);
  assert.match(text, /\[REDACTED\]|\[REDACTED_PATH\]/);
  assert.equal(mode(file), 0o600);
  assert.equal(mode(path.dirname(file)), 0o700);
});

test('retention dry-run preserves data and apply deletes only eligible in-root files without following symlinks', () => {
  const outDir = tempDir('amzguard-retention-');
  const externalDir = tempDir('amzguard-retention-external-');
  const external = path.join(externalDir, 'must-survive.txt');
  fs.writeFileSync(external, 'external');

  const oldFiles = [
    path.join(outDir, 'reviews', '2020-01-01', 'run.json'),
    path.join(outDir, 'reviews', '2020-01-01', 'shots', 'one.png'),
    path.join(outDir, 'logs', 'collector.log'),
    path.join(outDir, 'alerts', '2020-01-01.jsonl'),
    path.join(outDir, 'channels', 'crm', '2020-01-01.jsonl'),
    path.join(outDir, 'channels', 'retention', '2020-01-01.jsonl'),
    path.join(outDir, 'product-uploads', 'jobs', 'invalid-job-id', 'record.json'),
    path.join(outDir, 'product-uploads', 'jobs', 'invalid-job-id', 'reset.json'),
    path.join(outDir, 'product-uploads', 'audit', '2020-01-01.jsonl'),
    path.join(outDir, 'product-uploads', 'jobs', `upl_${'a'.repeat(32)}`, 'payload.csv'),
  ];
  const keepFiles = [
    ...['users', 'ads-rules', 'ads-monitoring', 'store-registry', 'ui-config'].map(name => path.join(outDir, 'runtime', `${name}.json`)),
    path.join(outDir, 'state', 'reviews.json'),
    path.join(outDir, 'channels', 'crm', 'ledger.json'),
    path.join(outDir, 'reviews', 'latest.json'),
    path.join(outDir, 'product-uploads', 'jobs', `upl_${'a'.repeat(32)}`, 'record.json'),
    path.join(outDir, 'product-uploads', 'jobs', `upl_${'a'.repeat(32)}`, 'reset.json'),
  ];
  for (const file of [...oldFiles, ...keepFiles]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, file);
    fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  }
  fs.symlinkSync(externalDir, path.join(outDir, 'linked-external'));

  const permissionProbe = oldFiles[0];
  const permissionProbeDir = path.dirname(permissionProbe);
  fs.chmodSync(permissionProbe, 0o644);
  fs.chmodSync(permissionProbeDir, 0o755);

  const now = new Date('2026-08-27T00:00:00Z').getTime();
  const plan = retentionPlan({ outDir, now, days: { evidence: 1, report: 1, log: 1, audit: 1, uploadPayload: 7 } });
  assert.deepEqual(new Set(plan.remove.map((item) => item.file)), new Set(oldFiles));
  assert.equal(plan.remove.find((item) => item.file.endsWith('payload.csv')).category, 'uploadPayload');
  assert.equal(plan.limits.uploadPayload, 7);
  assert.equal(plan.remove.every((item) => path.relative(outDir, item.file).split(path.sep)[0] !== '..'), true);

  const dry = runRetention({ outDir, apply: false, now });
  assert.equal(dry.removed, 0);
  assert.equal(dry.auditFile, null);
  assert.equal(mode(permissionProbe), 0o644, 'dry-run must not correct permissions');
  assert.equal(mode(permissionProbeDir), 0o755, 'dry-run must not mutate directory permissions');
  for (const file of [...oldFiles, ...keepFiles, external]) assert.ok(fs.existsSync(file));

  const applied = runRetention({ outDir, apply: true, now });
  assert.equal(applied.removed, oldFiles.length);
  for (const file of oldFiles) assert.equal(fs.existsSync(file), false);
  for (const file of [...keepFiles, external]) assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(applied.auditFile));
});

test('retention rejects a symlink root and broad working-directory scope before traversal', () => {
  const target = tempDir('amzguard-retention-target-');
  const linkParent = tempDir('amzguard-retention-link-');
  const link = path.join(linkParent, 'out-link');
  fs.writeFileSync(path.join(target, 'old-report.json'), 'must-not-be-touched');
  fs.symlinkSync(target, link);

  assert.throws(() => assertSafeRetentionRoot(link), /符号链接/);
  assert.throws(() => runRetention({ outDir: link, apply: true }), /符号链接/);
  assert.equal(fs.readFileSync(path.join(target, 'old-report.json'), 'utf8'), 'must-not-be-touched');

  // This calls only the guard; it must reject before any walk/chmod/unlink.
  assert.throws(() => assertSafeRetentionRoot(process.cwd()), /范围过宽/);
});

test('private upload diagnostics follow the evidence lifetime while original ledgers remain durable', () => {
  const outDir = tempDir('amzguard-retention-upload-diagnostics-');
  const jobRoot = `product-uploads/jobs/upl_${'b'.repeat(32)}`;
  const now = Date.parse('2026-09-13T00:00:00Z'), day = 86_400_000;
  const fixtures = [
    [`${jobRoot}/diagnostics/current.png`, 46],
    [`${jobRoot}/diagnostics/current.json`, 46],
    [`${jobRoot}/diagnostics/latest.json`, 46],
    [`${jobRoot}/diagnostics/recent.png`, 44],
    [`${jobRoot}/diagnostics/exact-boundary.json`, 45],
    [`${jobRoot}/record.json`, 1000],
    [`${jobRoot}/reset.json`, 1000],
    ['product-uploads/jobs/invalid-id/diagnostics/current.json', 46],
    ['product-uploads/audit/recent.jsonl', 46],
  ];
  for (const [relative, age] of fixtures) {
    const file = path.join(outDir, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'synthetic evidence');
    fs.utimesSync(file, new Date(now - age * day), new Date(now - age * day));
  }
  const plan = retentionPlan({ outDir, now, days: { evidence: 45, audit: 365 } });
  assert.deepEqual(plan.remove.map(item => item.relative).sort(), fixtures.slice(0, 3).map(([relative]) => relative).sort());
  assert.ok(plan.remove.every(item => item.category === 'evidence'));
  assert.equal(retentionClass(`${jobRoot}/record.json`), 'keep');
  assert.equal(retentionClass(`${jobRoot}/reset.json`), 'keep');
  assert.equal(retentionClass('product-uploads/jobs/invalid-id/diagnostics/current.json'), 'audit');
});

test('dashboard ingest rejects non-loopback HTTP and permits a sanitized loopback test request', async (t) => {
  const requests = [];
  const service = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(204);
    res.end();
  });
  t.after(service.close);
  const logger = loggerStub();
  const previousUrl = process.env.AMZGUARD_INGEST;
  const previousToken = process.env.AMZGUARD_INGEST_TOKEN;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.AMZGUARD_INGEST;
    else process.env.AMZGUARD_INGEST = previousUrl;
    if (previousToken === undefined) delete process.env.AMZGUARD_INGEST_TOKEN;
    else process.env.AMZGUARD_INGEST_TOKEN = previousToken;
  });

  process.env.AMZGUARD_INGEST = 'http://0.0.0.0:9/api/ingest';
  let result = await pushToDashboard({ summary: { runId: 'blocked' }, logger });
  assert.equal(result.attempted, false);
  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTPS/);
  assert.equal(requests.length, 0);

  process.env.AMZGUARD_INGEST = `${service.origin}/api/ingest?token=INGEST_URL_SECRET`;
  process.env.AMZGUARD_INGEST_TOKEN = 'INGEST_HEADER_SECRET';
  result = await pushToDashboard({
    logger,
    summary: {
      check: 'reviews', runId: 'loopback',
      url: 'https://sellercentral.amazon.com/reviews?openid=AMAZON_URL_SECRET#sso',
      screenshot: '/Users/operator/private/shot.png',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 204);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['x-ingest-token'], 'INGEST_HEADER_SECRET');
  assert.doesNotMatch(requests[0].body, /AMAZON_URL_SECRET|\/Users\/operator/);
  assert.match(requests[0].body, /https:\/\/sellercentral\.amazon\.com\/reviews/);
});

test('test-notify labels its alert and performs CRM validation as a zero-request dry-run', async (t) => {
  let requests = 0;
  const service = await listen((_req, res) => {
    requests++;
    res.writeHead(200);
    res.end('{}');
  });
  t.after(service.close);
  const outDir = tempDir('amzguard-test-notify-');
  const logger = loggerStub();
  const code = await runTestNotify({
    logger,
    config: {
      outDir, dashboard: {},
      alert: { console: false, file: true, dingtalk: { enabled: false }, webhook: { enabled: false } },
      crm: { enabled: true, endpoint: `${service.origin}/crm`, retries: 0 },
    },
  });
  assert.equal(code, 0);
  assert.equal(requests, 0);
  const audit = allText(path.join(outDir, 'alerts'));
  assert.match(audit, /测试消息，请忽略/);
  assert.match(allText(path.join(outDir, 'channels', 'crm')), /"event":"dry-run"/);
  assert.match(logger.entries.map((entry) => entry.text).join('\n'), /未向 CRM 发出网络请求/);
});

test('test-notify exercises both regular and operations DingTalk routes', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: String(options?.body || '') });
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ errcode: 0, errmsg: 'ok' }); },
    };
  });
  const outDir = tempDir('amzguard-test-notify-routes-');
  const code = await runTestNotify({
    logger: loggerStub(),
    config: {
      outDir, dashboard: { publicUrl: 'https://dashboard.example.test' },
      alert: {
        console: false, file: true, webhook: { enabled: false },
        dingtalk: { enabled: true, channels: [
          { name: 'regular', enabled: true, webhook: 'https://oapi.dingtalk.com/robot/send?access_token=REGULAR_TEST', severities: ['OK', 'CRITICAL'] },
          { name: 'operations', enabled: true, webhook: 'https://oapi.dingtalk.com/robot/send?access_token=OPS_TEST', severities: ['ERROR', 'WARN'] },
        ] },
      },
      crm: { enabled: false },
    },
  });
  assert.equal(code, 0);
  assert.equal(requests.length, 2);
  assert.ok(requests.some((request) => /REGULAR_TEST/.test(request.url)));
  assert.ok(requests.some((request) => /OPS_TEST/.test(request.url)));
  const bodies = requests.map((request) => request.body).join('\n');
  assert.match(bodies, /常规通知通道连通性验证/);
  assert.match(bodies, /运维通知通道连通性验证/);
  assert.match(bodies, /仅验证消息投递，不代表真实业务状态/);
  assert.doesNotMatch(bodies, /[✅⚠️🔴❗]/u);
});

test('Linux gates read newline-less procfs scalars without dash read/set-e aborts', () => {
  for (const relative of ['deploy/install-linux.sh', 'deploy/verify-linux.sh']) {
    const source = fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
    assert.match(source, /ptrace_scope=\$\(awk .*\/proc\/sys\/kernel\/yama\/ptrace_scope\)/);
    assert.doesNotMatch(source, /read[^\n]*ptrace_scope[^\n]*<\s*\/proc\/sys\/kernel\/yama\/ptrace_scope/);
  }
});

test('Linux collector units tolerate absent blocked home directories', () => {
  const unitNames = [
    'amzguard-ziniao.service',
    'amzguard-collector-health.service',
    'amzguard-store-health-am.service',
    'amzguard-store-health-pm.service',
    'amzguard-store-health-ads-off.service',
    'amzguard-store-health-ads-on.service',
    'amzguard-product-upload.service',
    'amzguard-manual@.service',
  ];
  for (const unitName of unitNames) {
    const source = fs.readFileSync(path.join(process.cwd(), 'deploy/systemd', unitName), 'utf8');
    assert.match(source,
      /^InaccessiblePaths=-\/home\/ubuntu\/\.ssh -\/home\/ubuntu\/\.npm -\/home\/ubuntu\/\.pip$/m,
      `${unitName} must ignore optional missing paths while blocking them when present`);
  }
});

test('Linux WebDriver workers can atomically redact the exact ZiNiao client log directory', () => {
  const unitNames = [
    'amzguard-collector-health.service',
    'amzguard-store-health-am.service',
    'amzguard-store-health-pm.service',
    'amzguard-store-health-ads-off.service',
    'amzguard-store-health-ads-on.service',
    'amzguard-product-upload.service',
    'amzguard-manual@.service',
  ];
  for (const unitName of unitNames) {
    const source = fs.readFileSync(path.join(process.cwd(), 'deploy/systemd', unitName), 'utf8');
    assert.match(source,
      /^ReadWritePaths=.*\/home\/ubuntu\/\.config\/ziniaobrowser\/instances\/userdata1\/logs\/client$/m,
      `${unitName} must permit redaction without granting broader home-directory writes`);
  }
});

test('collector health waits only for a transient ZiNiao listener startup race', async () => {
  let attempts = 0;
  let clock = 0;
  const result = await runDoctorWithStartupGrace({
    runDoctor: () => {
      attempts += 1;
      return attempts < 3
        ? { status: 2, stdout: '✗ WebDriver HTTP 服务未启动: http://127.0.0.1:18888/' }
        : { status: 0, stdout: '✓ WebDriver 登录权限与内核接口可用' };
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    graceMs: 5000,
    intervalMs: 1000,
  });
  assert.equal(result.status, 0);
  assert.equal(attempts, 3);

  attempts = 0;
  const authorizationFailure = { status: 2, stdout: '✗ WebDriver 登录/权限验证失败 (-10003)' };
  const immediate = await runDoctorWithStartupGrace({
    runDoctor: () => { attempts += 1; return authorizationFailure; },
    sleep: async () => assert.fail('authorization failures must never be retried as startup races'),
    graceMs: 5000,
  });
  assert.equal(immediate, authorizationFailure);
  assert.equal(attempts, 1);
  assert.equal(isTransientZiniaoStartupFailure(authorizationFailure), false);
});

test('collector health defers updateCore while a collector owns the run lease', () => {
  const source = fs.readFileSync(path.resolve('src/tools/collector-health.js'), 'utf8');
  const lockGate = source.indexOf('if (fs.existsSync(runLock))');
  const doctorRun = source.indexOf('const run = await runDoctorWithStartupGrace');
  assert.ok(lockGate >= 0 && doctorRun > lockGate, 'run-lock gate must precede doctor/updateCore');
  const deferred = source.slice(lockGate, doctorRun);
  assert.match(deferred, /deferred:\s*true/);
  assert.match(deferred, /process\.exit\(0\)/);
  assert.doesNotMatch(deferred, /spawnSync|\bdoctor\b/);
});

test('Linux installer blocks active, activating and queued collector work without rejecting core daemons', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'deploy/install-linux.sh'), 'utf8');
  const start = source.indexOf("guarded_timer_units='");
  const end = source.indexOf('if test -e "$app_dir/out/runtime/run.lock"');
  assert.ok(start >= 0 && end > start, 'deployment activity gate must remain identifiable');
  const gate = source.slice(start, end);

  assert.match(gate, /systemctl show "\$running_unit" -p ActiveState --value/);
  assert.match(gate, /active\|activating/);
  assert.match(gate, /list-units --type=service --all --no-legend --plain/);
  assert.match(gate, /amzguard-manual@\*\.service/);
  assert.doesNotMatch(gate, /--state=active/,
    'oneshot services are activating while ExecStart runs, so active-only discovery is unsafe');

  assert.match(gate, /systemctl list-jobs --no-legend --no-pager/);
  assert.match(gate, /is_guarded_deploy_job_unit "\$job_unit"/);
  for (const unit of [
    'amzguard-store-health-am.service',
    'amzguard-store-health-pm.service',
    'amzguard-store-health-ads-off.service',
    'amzguard-store-health-ads-on.service',
    'amzguard-collector-health.service',
    'amzguard-retention.service',
    'amzguard-cert-renew.service',
    'amzguard-channel-test.service',
    'amzguard-product-upload.service',
  ]) assert.match(gate, new RegExp(unit.replaceAll('.', '\\.')));
  assert.match(gate, /amzguard-product-upload\.timer/);
  assert.match(gate, /amzguard-product-upload\.path/);

  for (const core of [
    'amzguard-dashboard.service', 'amzguard-ziniao.service',
    'amzguard-xvfb.service', 'nginx.service',
  ]) assert.doesNotMatch(gate, new RegExp(core.replaceAll('.', '\\.')));
});

test('Linux release trust uses an atomic root manifest and verifies installed configuration drift', () => {
  const install = fs.readFileSync(path.resolve('deploy/install-linux.sh'), 'utf8');
  const verify = fs.readFileSync(path.resolve('deploy/verify-linux.sh'), 'utf8');
  const manifest = fs.readFileSync(path.resolve('deploy/manifest.sh'), 'utf8');

  assert.match(install, /mktemp -d \/run\/amzguard-manifest\.XXXXXX/);
  assert.match(install, /mv -T "\$manifest_tmp" "\$manifest"/);
  assert.doesNotMatch(install, /manifest\.sh" "\$app_dir" > "\$manifest"/);
  assert.match(install, /chown root:root "\$manifest"/);
  assert.match(install, /find "\$app_dir" -xdev[\s\S]+-exec chown -h root:root/);
  assert.match(manifest, /find src scripts deploy docs test/);

  assert.match(verify, /cmp -s "\$unit_source" "\$unit_installed"/);
  assert.match(verify, /cmp -s "\$app_dir\/deploy\/nginx\/amzguard\.conf"/);
  assert.match(verify, /cmp -s "\$app_dir\/deploy\/logrotate\/amzguard"/);
  for (const time of ['08:00:00', '11:20:00', '15:30:00', '18:30:00']) {
    assert.match(verify, new RegExp(`OnCalendar=\\*\\-\\*\\-\\* ${time} Asia/Shanghai`));
  }
  assert.match(verify, /\[ "\$root_code" = '200' \]/);
  assert.match(verify, /npm --prefix "\$app_dir" ls --omit=dev --depth=0/);
  assert.match(install, /bootstrap_enabled=\/etc\/nginx\/sites-enabled\/amzguard-acme-bootstrap\.conf/);
  assert.match(install, /readlink "\$bootstrap_enabled"/);
});

test('manual systemd instance preserves hyphenated check names', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'deploy/systemd/amzguard-manual@.service'), 'utf8');
  const runner = fs.readFileSync(path.join(process.cwd(), 'deploy/manual-run.sh'), 'utf8');
  assert.match(source, /^ExecStart=.*\s%i$/m);
  assert.doesNotMatch(source, /^ExecStart=.*\s%I$/m);
  assert.match(runner, /asin-health-B0\?\?\?\?\?\?\?\?/);
  assert.match(runner, /run-check asin-health --store "\$store_key" --asin "\$target_asin"/);
});

test('login edge limit applies only to credential submissions', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'deploy/nginx/amzguard-limit.conf'), 'utf8');
  assert.match(source, /map \$request_method \$amzguard_login_limit_key/);
  assert.match(source, /POST \$binary_remote_addr/);
  assert.match(source, /limit_req_zone \$amzguard_login_limit_key zone=amzguard_login/);
  assert.doesNotMatch(source, /limit_req_zone \$binary_remote_addr zone=amzguard_login/);
});
