import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createUiConfig, UI_DEFAULTS } from '../src/lib/ui-config.js';
import { assertStoreUploadBindingIdle } from '../src/lib/store-change-guard.js';
import { PRODUCT_UPLOAD_STATES } from '../src/lib/product-upload.js';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-config-models-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const outDir = path.join(temp, 'out'), model = createUiConfig({ outDir });
  const file = path.join(outDir, 'runtime', 'ui-config.json');
  const save = (settings = { ...UI_DEFAULTS, reportRefreshSeconds: 60 }, expectedRevision = model.read().revision) => model.save({ settings, expectedRevision, actor: 'admin-fixture' });
  let counter = 0;
  function job(state, storeKey = 'US-A', override = {}) {
    const id = `upl_${String(++counter).padStart(32, '0')}`;
    const dir = path.join(outDir, 'product-uploads', 'jobs', id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record = path.join(dir, 'record.json');
    fs.writeFileSync(record, JSON.stringify({ version: 1, id, state, store: { key: storeKey }, expiresAt: '2000-01-01T00:00:00Z', ...override }), { mode: 0o600 });
    return { id, dir, record };
  }
  const guard = (storeKey = 'US-A') => assertStoreUploadBindingIdle({ outDir, storeKey });
  return { temp, outDir, model, file, save, job, guard };
}
function rejects(fn, status, code) { assert.throws(fn, error => error.status === status && (!code || error.code === code)); }

test('display settings have stable bootstrap defaults and persist only approved UI fields privately', t => {
  const f = fixture(t), initial = f.model.read();
  assert.deepEqual(initial.settings, UI_DEFAULTS);
  assert.equal(initial.source, 'bootstrap');
  assert.equal(fs.existsSync(f.outDir), false);
  const saved = f.save();
  assert.equal(saved.source, 'managed');
  assert.equal(saved.settings.reportRefreshSeconds, 60);
  assert.deepEqual(Object.keys(saved.settings).sort(), Object.keys(UI_DEFAULTS).sort());
  assert.deepEqual(createUiConfig({ outDir: f.outDir, defaults: { reportRefreshSeconds: 100 } }).read(), saved);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f.file)).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['ui-config.json']);
});

test('display settings reject collection, permissions, credential and prototype fields and enforce bounds', t => {
  const f = fixture(t);
  for (const patch of [
    { reportRefreshSeconds: 4 }, { reportRefreshSeconds: 301 }, { progressRefreshSeconds: 0 },
    { progressRefreshSeconds: 31 }, { uploadRefreshSeconds: 4 }, { uploadRefreshSeconds: 121 },
    { matrixPageSize: 0 }, { listPageSize: 101 }, { listPageSize: '10' }, { matrixPageSize: 1.1 },
    { defaultView: 'arbitrary' }, { defaultView: 'https://elsewhere.example/' },
    { autoCollect: true }, { retries: 10 }, { sessionSecret: 'never-persist' }, { roles: ['admin'] },
  ]) rejects(() => f.save({ ...UI_DEFAULTS, ...patch }), 400);
  rejects(() => f.save(JSON.parse('{"__proto__":{"administrator":true}}')), 400);
  rejects(() => f.save({}), 400);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal({}.administrator, undefined);
});

test('UI stale saves, corrupt storage and unsafe permissions fail without resetting settings', t => {
  const f = fixture(t), initial = f.model.read();
  f.save();
  const before = fs.readFileSync(f.file);
  rejects(() => f.save(UI_DEFAULTS, initial.revision), 409, 'UI_CONFIG_CONFLICT');
  assert.deepEqual(fs.readFileSync(f.file), before);
  fs.writeFileSync(f.file, '{broken');
  rejects(() => f.model.read(), 503, 'UI_CONFIG_CORRUPT');
  rejects(() => f.save(UI_DEFAULTS, initial.revision), 503);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
  if (process.platform !== 'win32') {
    fs.writeFileSync(f.file, before); fs.chmodSync(f.file, 0o644);
    rejects(() => f.model.read(), 503, 'UI_CONFIG_STORAGE');
  }
});

test('UI files refuse symlinks, hardlinks, unsafe directories and existing locks', t => {
  const f = fixture(t); f.save();
  const outside = path.join(f.temp, 'outside'); fs.writeFileSync(outside, 'untouched', { mode: 0o600 });
  const revision = f.model.read().revision;
  fs.symlinkSync(outside, `${f.file}.lock`);
  rejects(() => f.save(UI_DEFAULTS, revision), 409, 'UI_CONFIG_LOCKED');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched'); fs.unlinkSync(`${f.file}.lock`);
  fs.unlinkSync(f.file); fs.symlinkSync(outside, f.file);
  rejects(() => f.model.read(), 503); fs.unlinkSync(f.file); fs.linkSync(outside, f.file);
  rejects(() => f.model.read(), 503); fs.unlinkSync(f.file); fs.rmdirSync(path.dirname(f.file));
  const otherDir = path.join(f.temp, 'other'); fs.mkdirSync(otherDir); fs.symlinkSync(otherDir, path.dirname(f.file));
  rejects(() => f.save(UI_DEFAULTS, revision), 503);
  assert.deepEqual(fs.readdirSync(otherDir), []);
});

test('UI atomic-write failures preserve previous data and always release the lock even if temporary cleanup fails', t => {
  const f = fixture(t); f.save();
  const before = fs.readFileSync(f.file), rename = fs.renameSync, unlink = fs.unlinkSync;
  fs.renameSync = (from, to) => { if (to === f.file) throw new Error('injected rename failure'); return rename(from, to); };
  fs.unlinkSync = file => { if (path.basename(file).startsWith('.ui-config.') && file.endsWith('.tmp')) throw new Error('injected cleanup failure'); return unlink(file); };
  try { assert.throws(() => f.save(UI_DEFAULTS), /injected cleanup failure/); }
  finally { fs.renameSync = rename; fs.unlinkSync = unlink; }
  assert.equal(fs.existsSync(`${f.file}.lock`), false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  for (const name of fs.readdirSync(path.dirname(f.file)).filter(name => name.endsWith('.tmp'))) fs.unlinkSync(path.join(path.dirname(f.file), name));
  assert.equal(f.save(UI_DEFAULTS).settings.reportRefreshSeconds, UI_DEFAULTS.reportRefreshSeconds);
});

test('binding guard checks all pending/unknown states, scopes by store and never expires or rewrites jobs', t => {
  const safe = new Set(['COMPLETED', 'REJECTED', 'FAILED_BEFORE_SUBMIT', 'EXPIRED']);
  for (const state of PRODUCT_UPLOAD_STATES) {
    const f = fixture(t), { record } = f.job(state), bytes = fs.readFileSync(record);
    const timestamp = new Date('2000-01-01T00:00:00Z'); fs.utimesSync(record, timestamp, timestamp);
    if (safe.has(state)) assert.doesNotThrow(f.guard);
    else rejects(f.guard, 409, 'STORE_UPLOAD_PENDING');
    assert.doesNotThrow(() => f.guard('OTHER-STORE'));
    assert.deepEqual(fs.readFileSync(record), bytes);
    assert.equal(fs.statSync(record).mtimeMs, timestamp.getTime());
  }
});

test('binding guard allows a missing ledger but blocks malformed records anywhere in an existing ledger', t => {
  const f = fixture(t);
  assert.doesNotThrow(f.guard);
  assert.equal(fs.existsSync(f.outDir), false);
  const valid = f.job('COMPLETED'), broken = f.job('COMPLETED', 'OTHER-STORE');
  for (const body of ['{broken', JSON.stringify({ version: 1, id: 'wrong', state: 'COMPLETED', store: { key: 'OTHER-STORE' } }),
    JSON.stringify({ version: 1, id: broken.id, state: 'UNRECOGNIZED', store: { key: 'OTHER-STORE' } })]) {
    fs.writeFileSync(broken.record, body);
    rejects(f.guard, 409, 'STORE_UPLOAD_EVIDENCE_INVALID');
    assert.equal(fs.readFileSync(broken.record, 'utf8'), body);
  }
  fs.unlinkSync(broken.record);
  rejects(f.guard, 409, 'STORE_UPLOAD_EVIDENCE_INVALID');
  assert.equal(fs.existsSync(valid.record), true);
});

test('binding guard rejects symlink/hardlink records, symlink job directories and oversized metadata', t => {
  const f = fixture(t), current = f.job('COMPLETED');
  const outside = path.join(f.temp, 'outside'); fs.writeFileSync(outside, 'untouched', { mode: 0o600 });
  fs.unlinkSync(current.record); fs.symlinkSync(outside, current.record);
  rejects(f.guard, 409, 'STORE_UPLOAD_EVIDENCE_INVALID');
  fs.unlinkSync(current.record); fs.linkSync(outside, current.record);
  rejects(f.guard, 409, 'STORE_UPLOAD_EVIDENCE_INVALID');
  fs.unlinkSync(current.record); fs.writeFileSync(current.record, ' '.repeat(1024 * 1024 + 1));
  rejects(f.guard, 409, 'STORE_UPLOAD_EVIDENCE_INVALID');
  fs.unlinkSync(current.record); fs.rmdirSync(current.dir); fs.symlinkSync(f.temp, current.dir);
  rejects(f.guard, 409, 'STORE_UPLOAD_EVIDENCE_INVALID');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('FIFO-corrupted configuration and upload records fail promptly instead of blocking the server', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.save();
  fs.unlinkSync(f.file); execFileSync('/usr/bin/mkfifo', [f.file]);
  const current = f.job('COMPLETED'); fs.unlinkSync(current.record); execFileSync('/usr/bin/mkfifo', [current.record]);
  // A child timeout turns a future synchronous-open regression into a bounded
  // failure rather than hanging the entire offline test runner.
  const uiUrl = new URL('../src/lib/ui-config.js', import.meta.url).href;
  const guardUrl = new URL('../src/lib/store-change-guard.js', import.meta.url).href;
  const code = `import {createUiConfig} from ${JSON.stringify(uiUrl)};
    import {assertStoreUploadBindingIdle} from ${JSON.stringify(guardUrl)};
    const outDir=process.argv[1];let failures=0;
    try{createUiConfig({outDir}).read();}catch(e){if(e.status===503)failures++;}
    try{assertStoreUploadBindingIdle({outDir,storeKey:'US-A'});}catch(e){if(e.code==='STORE_UPLOAD_EVIDENCE_INVALID')failures++;}
    if(failures!==2)process.exit(1);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code, f.outDir], { env: {}, timeout: 3000 });
});
