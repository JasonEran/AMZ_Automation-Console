import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adsMonitoringPath, readAdsMonitoring, writeAdsMonitoring } from '../src/lib/ads-monitoring.js';
import { runCheckById } from '../src/checks/run.js';
import { retentionPlan } from '../src/tools/retention.js';

test('a durable advertising pause blocks collection without replacing previous evidence', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-pause-'));
  assert.equal(readAdsMonitoring(outDir).source, 'portfolios');
  writeAdsMonitoring(outDir, { paused: true, reason: '双页面验证中' });
  const latest = path.join(outDir, 'ads-status', 'latest.json');
  fs.mkdirSync(path.dirname(latest), { recursive: true });
  fs.writeFileSync(latest, '{"prior":true}');
  const result = await runCheckById({ id: 'ads-status', config: { outDir }, stores: [{ key: 'WANG' }],
    zn: new Proxy({}, { get() { throw new Error('paused collector accessed transport'); } }),
    logger: { info() {} } });
  assert.equal(result.skipped, true);
  assert.equal(fs.readFileSync(latest, 'utf8'), '{"prior":true}');
  assert.equal(readAdsMonitoring(outDir).paused, true);
  assert.equal(fs.existsSync(path.join(outDir, 'runtime', 'run.lock')), false);
  const old = new Date(Date.now() - 2 * 365 * 86400000);
  fs.utimesSync(adsMonitoringPath(outDir), old, old);
  assert.equal(retentionPlan({ outDir }).remove.some((entry) => entry.file === adsMonitoringPath(outDir)), false,
    'automatic report cleanup must preserve a durable monitoring pause');
  fs.writeFileSync(adsMonitoringPath(outDir), '{broken');
  assert.equal(readAdsMonitoring(outDir).paused, true);
  writeAdsMonitoring(outDir, { paused: false });
  assert.equal(readAdsMonitoring(outDir).paused, false);
});
