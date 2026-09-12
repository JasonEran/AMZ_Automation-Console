import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createStoreRegistry, readStoreRegistry, storeRegistryPath, storeBindingChanged, STORE_HOSTS, STORE_MARKETS } from '../src/lib/store-registry.js';

const execute = promisify(execFile);
const moduleUrl = new URL('../src/lib/store-registry.js', import.meta.url).href;
const configUrl = new URL('../src/lib/config.js', import.meta.url).href;
const input = { key: 'US-NEW', name: 'ZiNiao fixture', displayName: '测试店铺', id: '42', market: 'US', host: 'sellercentral.amazon.com' };
function fixture(t, rows = [{ key: 'US-A', name: 'Profile A', id: '1', market: 'US', enabled: true },
  { key: 'JP-B', name: 'Profile B', id: '2', market: 'JP', host: 'sellercentral.amazon.co.jp', enabled: false, adsNameContains: 'legacy', paths: ['/fixture'] }]) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-registry-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const storesPath = path.join(temp, 'stores.json'), outDir = path.join(temp, 'out');
  if (rows !== null) fs.writeFileSync(storesPath, JSON.stringify({ stores: rows }), { mode: 0o600 });
  const options = { storesPath, outDir };
  const registry = createStoreRegistry({ ...options, now: () => 1_800_000_000_000 });
  const create = (store = input, expectedRevision = registry.read().revision) => registry.create({ store, expectedRevision, actor: 'admin-fixture' });
  const update = (key, patch, expectedRevision = registry.read().revision) => registry.update(key, { patch, expectedRevision, actor: 'admin-fixture' });
  return { temp, options, storesPath, outDir, file: storeRegistryPath(outDir), registry, create, update };
}
function rejects(fn, status = 400, code) {
  assert.throws(fn, error => error.status === status && error.statusCode === status && (!code || error.code === code));
}

test('bootstrap reads every enabled and disabled store without writing and preserves legacy fallback', t => {
  const f = fixture(t, [{ name: 'PROFILE-A', enabled: false }, { id: 12 }, { key: 'US-X', name: 'X', id: 'legacy-opaque-id', paths: ['/legacy'], adsNameContains: '  group  ' }, null]);
  const read = f.registry.read();
  assert.equal(read.source, 'bootstrap');
  assert.match(read.revision, /^bootstrap:[a-f0-9]{64}$/);
  assert.equal(read.contentSHA, read.revision.split(':')[1]);
  assert.deepEqual(read.stores.map(store => store.key), ['PROFILE-A', '12', 'US-X']);
  assert.equal(read.stores[0].enabled, false);
  assert.equal(read.stores[1].id, '12');
  assert.equal(read.stores[2].id, 'legacy-opaque-id');
  assert.equal(read.stores[2].adsNameContains, 'group');
  assert.equal(fs.existsSync(f.outDir), false);
});

test('missing and all-disabled registries remain distinct and support initial management', t => {
  const f = fixture(t, null);
  assert.equal(f.registry.read().source, 'missing');
  assert.deepEqual(f.registry.read().stores, []);
  const saved = f.create();
  assert.equal(saved.source, 'managed');
  assert.equal(saved.store.enabled, false);
  assert.equal(saved.store.key, input.key);
  assert.equal(saved.stores.length, 1);
});

test('disabled key-only tombstones survive first management save and cannot be enabled without binding', t => {
  const f = fixture(t, [{ key: 'RETIRED', enabled: false }]);
  assert.equal(f.registry.read().stores[0].key, 'RETIRED');
  const saved = f.create();
  assert.equal(saved.stores.find(store => store.key === 'RETIRED').enabled, false);
  assert.equal(f.update('RETIRED', { displayName: '历史停用店铺' }).store.name, '');
  rejects(() => f.update('RETIRED', { enabled: true }));
  assert.equal(f.update('RETIRED', { name: 'Profile restored', enabled: true }).store.enabled, true);
});

test('disabled stores with an existing binding cannot clear both name and id', t => {
  const f = fixture(t);
  const initial = f.registry.read();
  rejects(() => f.update('JP-B', { name: '', id: '' }));
  rejects(() => f.update('US-A', { enabled: false, name: '', id: '' }));
  assert.deepEqual(f.registry.read(), initial);
  f.update('JP-B', { name: '' });
  rejects(() => f.update('JP-B', { id: '' }));
  assert.equal(f.registry.read().stores.find(store => store.key === 'JP-B').id, '2');
});

test('first save copies disabled history and legacy paths while managed data becomes authoritative', t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.storesPath);
  const saved = f.create();
  assert.deepEqual(saved.stores.map(store => store.key), ['US-A', 'JP-B', 'US-NEW']);
  assert.equal(saved.stores[1].enabled, false);
  assert.deepEqual(saved.stores[1].paths, ['/fixture']);
  assert.equal(saved.stores[1].adsNameContains, 'legacy');
  assert.deepEqual(fs.readFileSync(f.storesPath), original);
  fs.writeFileSync(f.storesPath, '{broken bootstrap');
  assert.deepEqual(f.registry.read(), { revision: saved.revision, contentSHA: saved.contentSHA, source: saved.source, stores: saved.stores });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f.file)).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['store-registry.json']);
});

test('display names are independent from profile binding and disabling preserves key and data', t => {
  const f = fixture(t);
  const before = f.registry.read().stores[0];
  const renamed = f.update('US-A', { displayName: '新的展示名称' });
  assert.equal(renamed.store.name, before.name);
  assert.equal(storeBindingChanged(before, renamed.store), false);
  const disabled = f.update('US-A', { enabled: false });
  assert.equal(disabled.store.key, 'US-A');
  assert.equal(disabled.store.enabled, false);
  assert.equal(disabled.stores.length, 2);
  const rebound = f.update('US-A', { name: 'Different profile' });
  assert.equal(storeBindingChanged(before, rebound.store), true);
  for (const field of ['id', 'market', 'host']) assert.equal(storeBindingChanged(before, { ...before, [field]: 'different' }), true);
});

test('keys are explicit, immutable and cannot be reused even when disabled', t => {
  const f = fixture(t);
  const noKey = { ...input }; delete noKey.key;
  rejects(() => f.create(noKey));
  for (const key of ['../x', 'a/b', '__proto__', 'constructor', 'prototype', 'toString', '', 'x'.repeat(65), 'bad key']) rejects(() => f.create({ ...input, key }));
  rejects(() => f.update('US-A', { key: 'RENAMED' }));
  rejects(() => f.create({ ...input, key: 'JP-B' }), 409, 'STORE_REGISTRY_EXISTS');
  rejects(() => f.update('MISSING', { displayName: 'label' }), 404);
});

test('input objects reject unknown fields and prototype-shaped payloads without storing secrets', t => {
  const f = fixture(t);
  for (const field of ['password', 'browserOauth', 'roles', 'outDir', 'paths', 'adsNameContains', 'constructor', 'prototype']) {
    rejects(() => f.create({ ...input, [field]: 'do-not-store-this' }));
    rejects(() => f.update('US-A', { [field]: 'do-not-store-this' }));
  }
  rejects(() => f.create(JSON.parse('{"__proto__":{"admin":true}}')));
  for (const store of [null, [], 1, 'a', Object.create({ key: 'a' })]) rejects(() => f.create(store));
  rejects(() => f.update('US-A', {}));
  assert.equal(fs.existsSync(f.file), false);
  assert.equal({}.admin, undefined);
});

test('managed fields validate exact types, visible text, numeric browserId and approved hosts', t => {
  const f = fixture(t);
  for (const patch of [
    { name: ' a' }, { name: 'a\n' }, { displayName: 'x'.repeat(161) }, { displayName: 1 },
    { id: 12 }, { id: '0' }, { id: '12.1' }, { id: 'opaque-oauth' }, { id: 'x'.repeat(31) },
    { market: 'us' }, { market: 'ZZ' }, { market: '' }, { enabled: 'false' }, { enabled: null },
    { host: 'https://sellercentral.amazon.com' }, { host: 'sellercentral.amazon.com:443' },
    { host: 'sellercentral.amazon.com/' }, { host: 'sellercentral.amazon.com.evil.test' },
    { host: 'sellercentral.amazon.com.' }, { host: 'www.amazon.com' },
    { host: 'Sellercentral.amazon.com' }, { host: 'sellercentral.amazon.com?token=secret' },
  ]) rejects(() => f.create({ ...input, ...patch }));
  rejects(() => f.create({ ...input, name: '', id: '' }));
  rejects(() => f.update('US-A', { name: '', id: '' }));
  assert.ok(STORE_MARKETS.includes('US'));
  assert.ok(STORE_HOSTS.includes('sellercentral.amazon.co.jp'));
  f.create({ ...input, market: 'JP', host: 'sellercentral.amazon.co.jp' });
});

test('stale revisions reject both bootstrap replacement and later managed edits', t => {
  const f = fixture(t);
  const staleBootstrap = f.registry.read().revision;
  fs.writeFileSync(f.storesPath, JSON.stringify([{ key: 'US-OTHER', name: 'other' }]), { mode: 0o600 });
  rejects(() => f.create(input, staleBootstrap), 409, 'STORE_REGISTRY_CONFLICT');
  assert.equal(fs.existsSync(f.file), false);
  const saved = f.create();
  f.update('US-NEW', { displayName: 'first writer' });
  rejects(() => f.update('US-NEW', { displayName: 'stale writer' }, saved.revision), 409, 'STORE_REGISTRY_CONFLICT');
  assert.equal(f.registry.read().stores.find(store => store.key === 'US-NEW').displayName, 'first writer');
  for (const revision of [undefined, '', 0, saved.contentSHA]) rejects(() => f.registry.update('US-NEW', { patch: { enabled: true }, expectedRevision: revision, actor: 'fixture' }), 409);
});

test('corrupt managed storage never falls back to the valid bootstrap or overwrites it', t => {
  const f = fixture(t);
  const revision = f.create().revision;
  for (const body of ['{broken', JSON.stringify({ version: 2, stores: [] }), JSON.stringify({ version: 1, stores: [{ key: 'US-A' }] })]) {
    fs.writeFileSync(f.file, body, { mode: 0o600 });
    rejects(() => f.registry.read(), 503);
    rejects(() => f.update('US-A', { displayName: 'change' }, revision), 503);
    assert.equal(fs.readFileSync(f.file, 'utf8'), body);
  }
});

test('malformed managed booleans, missing keys and unrecognized fields cannot silently change store identity', t => {
  const f = fixture(t); f.create();
  const valid = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  for (const change of [row => { row.enabled = 'false'; }, row => { delete row.key; }, row => { row.name = null; }, row => { row.browserOauth = 'not-permitted'; }]) {
    const invalid = structuredClone(valid); change(invalid.stores[0]);
    fs.writeFileSync(f.file, JSON.stringify(invalid), { mode: 0o600 });
    rejects(() => f.registry.read(), 503, 'STORE_REGISTRY_CORRUPT');
  }
});

test('duplicates including disabled rows and malformed bootstrap structures fail closed', t => {
  const f = fixture(t);
  for (const rows of [
    [{ key: 'DUP', name: 'a' }, { key: 'DUP', name: 'b', enabled: false }],
    [{ key: 'BAD', name: {}, id: '1' }],
    [{ key: 'BAD', name: 'a', paths: ['/a', { bad: true }] }],
    { noStores: [] },
  ]) {
    fs.writeFileSync(f.storesPath, JSON.stringify(rows));
    rejects(() => f.registry.read(), 503);
  }
});

test('symlink and hardlink files and directories cannot redirect registry reads or writes', t => {
  const f = fixture(t);
  f.create();
  const outside = path.join(f.temp, 'outside.json');
  fs.writeFileSync(outside, 'outside unchanged', { mode: 0o600 });
  fs.unlinkSync(f.file); fs.symlinkSync(outside, f.file);
  rejects(() => f.registry.read(), 503);
  fs.unlinkSync(f.file); fs.linkSync(outside, f.file);
  rejects(() => f.registry.read(), 503);
  fs.unlinkSync(f.file); fs.rmdirSync(path.dirname(f.file));
  const otherDir = path.join(f.temp, 'other'); fs.mkdirSync(otherDir);
  fs.symlinkSync(otherDir, path.dirname(f.file));
  rejects(() => f.registry.read(), 503);
  rejects(() => f.create(input, `missing:${'a'.repeat(64)}`), 503);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside unchanged');
  assert.deepEqual(fs.readdirSync(otherDir), []);
});

test('bootstrap symlinks and oversized or overpopulated registries are rejected', t => {
  const f = fixture(t);
  const copy = path.join(f.temp, 'copy'); fs.renameSync(f.storesPath, copy); fs.symlinkSync(copy, f.storesPath);
  rejects(() => f.registry.read(), 503);
  fs.unlinkSync(f.storesPath);
  fs.writeFileSync(f.storesPath, ' '.repeat(1024 * 1024 + 1));
  rejects(() => f.registry.read(), 503);
  fs.writeFileSync(f.storesPath, JSON.stringify(Array.from({ length: 1001 }, (_, index) => ({ key: `S${index}`, name: 'x' }))));
  rejects(() => f.registry.read(), 503);
});

test('failed rename preserves the previous bytes and releases both temporary file and lock', t => {
  const f = fixture(t); f.create();
  const before = fs.readFileSync(f.file), revision = f.registry.read().revision;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.file) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); return rename(from, to); };
  try { assert.throws(() => f.update('US-A', { displayName: 'never stored' }), /injected rename failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(f.registry.read().revision, revision);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['store-registry.json']);
  assert.equal(f.update('US-A', { displayName: 'retry' }).store.displayName, 'retry');
});

test('failed file sync never publishes incomplete configuration', t => {
  const f = fixture(t); f.create();
  const before = fs.readFileSync(f.file), sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('injected sync failure'); };
  try { assert.throws(() => f.update('US-A', { enabled: false }), /injected sync failure/); }
  finally { fs.fsyncSync = sync; }
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['store-registry.json']);
});

test('existing lock, including a symlink lock, is never followed or silently stolen', t => {
  const f = fixture(t); f.create();
  const before = fs.readFileSync(f.file), lock = `${f.file}.lock`;
  const outside = path.join(f.temp, 'do-not-change'); fs.writeFileSync(outside, 'untouched');
  fs.symlinkSync(outside, lock);
  rejects(() => f.update('US-A', { enabled: false }), 409, 'STORE_REGISTRY_LOCKED');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  fs.unlinkSync(lock); fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
  rejects(() => f.update('US-A', { enabled: false }), 409, 'STORE_REGISTRY_LOCKED');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('two independent writer processes cannot lose each other’s configuration updates', async t => {
  const f = fixture(t), revision = f.registry.read().revision;
  const script = `import {createStoreRegistry} from ${JSON.stringify(moduleUrl)};
    const [options,revision,name]=process.argv.slice(1); const model=createStoreRegistry(JSON.parse(options));
    try{model.update('US-A',{patch:{displayName:name},expectedRevision:revision,actor:'process-fixture'});console.log('saved');}
    catch(error){if(error.status===409)console.log('conflict');else throw error;}`;
  const outcomes = await Promise.all(['writer-a', 'writer-b'].map(name => execute(process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify(f.options), revision, name], { env: {}, timeout: 10000 })));
  assert.deepEqual(outcomes.map(value => value.stdout.trim()).sort(), ['conflict', 'saved']);
  assert.ok(['writer-a', 'writer-b'].includes(f.registry.read().stores[0].displayName));
  assert.equal(fs.existsSync(`${f.file}.lock`), false);
});

test('loadConfig honors managed enabled stores and the existing separate advertising override', t => {
  const f = fixture(t); f.create({ ...input, enabled: true }); f.update('US-A', { enabled: false });
  fs.writeFileSync(path.join(f.outDir, 'runtime', 'ads-rules.json'), JSON.stringify({ version: 1, rules: [{ storeKey: 'US-NEW', nameContains: 'runtime-only' }] }), { mode: 0o600 });
  const configFile = path.join(f.temp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ paths: { outDir: f.outDir } }));
  const bin = path.join(f.temp, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o700 });
  const script = `import {loadConfig} from ${JSON.stringify(configUrl)};
    const value=loadConfig(JSON.parse(process.argv[1]));console.log(JSON.stringify({stores:value.stores,missing:value.storesMissing}));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ configFile, storesFile: f.storesPath })],
    { env: { PATH: bin, HOME: f.temp }, encoding: 'utf8', timeout: 10000 });
  const value = JSON.parse(output);
  assert.equal(value.missing, false);
  assert.deepEqual(value.stores.map(store => store.key), ['US-NEW']);
  assert.equal(value.stores[0].adsNameContains, 'runtime-only');
  assert.equal(readStoreRegistry(f.options).stores.find(store => store.key === 'US-NEW').adsNameContains, '');
});
