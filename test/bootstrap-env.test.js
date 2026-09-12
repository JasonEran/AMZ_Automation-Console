import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('bootstrap generates private credentials with upload gates closed and refuses an existing environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-bootstrap-'));
  try {
    const bin = path.join(root, 'bin');
    const envDir = path.join(root, 'env');
    fs.mkdirSync(bin);
    // Run a copy against a disposable directory, without root or /etc writes.
    const source = fs.readFileSync(new URL('../deploy/bootstrap-linux-env.sh', import.meta.url), 'utf8');
    const script = path.join(root, 'bootstrap.sh');
    fs.writeFileSync(script, source.replace('env_dir=/etc/amzguard', 'env_dir="$AMZGUARD_TEST_ENV_DIR"'));
    const mocks = {
      id: '#!/bin/sh\nprintf "0\\n"\n',
      chown: '#!/bin/sh\nexit 0\n',
      install: '#!/bin/sh\nfor arg do destination=$arg; done\nmkdir -p "$destination"\nchmod 0700 "$destination"\n',
    };
    for (const [name, body] of Object.entries(mocks)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AMZGUARD_TEST_ENV_DIR: envDir };
    const result = spawnSync('sh', [script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    const dashboardPath = path.join(envDir, 'dashboard.env');
    const dashboard = fs.readFileSync(dashboardPath, 'utf8');
    for (const [key, size] of [['DASHBOARD_PASSWORD', 40], ['DASHBOARD_SESSION_SECRET', 64], ['AMZGUARD_INGEST_TOKEN', 64]]) {
      const value = dashboard.split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
      assert.equal(typeof value, 'string');
      assert.equal(value.length, size);
      assert.match(value, /^[a-f0-9]+$/);
      assert.ok(!(result.stdout + result.stderr).includes(value), 'generated credentials must not be printed');
    }
    const upload = fs.readFileSync(path.join(envDir, 'product-upload.env'), 'utf8');
    assert.match(upload, /^AMZGUARD_PRODUCT_UPLOAD_ENABLED=0$/m);
    assert.match(upload, /^AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED=0$/m);
    assert.equal(fs.statSync(envDir).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(envDir)) assert.equal(fs.statSync(path.join(envDir, name)).mode & 0o777, 0o600);
    const repeated = spawnSync('sh', [script], { env, encoding: 'utf8' });
    assert.equal(repeated.status, 2);
    assert.equal(fs.readFileSync(dashboardPath, 'utf8'), dashboard, 'existing credentials must remain unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
