import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adsRulesPath, readAdsRules, writeAdsRules } from '../src/lib/ads-rules.js';

test('advertising runtime rules are private, atomic and round-trip all stores', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-ads-rules-'));
  writeAdsRules(outDir, [
    { storeKey: 'FENG', nameContains: '2.26' },
    { storeKey: 'WANG', nameContains: '26' },
  ]);
  assert.deepEqual([...readAdsRules(outDir).entries()], [['FENG', '2.26'], ['WANG', '26']]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(adsRulesPath(outDir)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(adsRulesPath(outDir))).mode & 0o777, 0o700);
  }
  assert.equal(fs.readdirSync(path.dirname(adsRulesPath(outDir))).some((name) => name.endsWith('.tmp')), false);
});

test('advertising rules reject missing, control-character and corrupt scope data', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-ads-rules-invalid-'));
  assert.throws(() => writeAdsRules(outDir, [{ storeKey: 'FENG', nameContains: '' }]), /1-40/);
  assert.throws(() => writeAdsRules(outDir, [{ storeKey: 'FENG', nameContains: '2\n26' }]), /1-40/);
  fs.mkdirSync(path.dirname(adsRulesPath(outDir)), { recursive: true });
  fs.writeFileSync(adsRulesPath(outDir), '{broken', { mode: 0o600 });
  assert.throws(() => readAdsRules(outDir), /拒绝回退到全账户范围/);
});
