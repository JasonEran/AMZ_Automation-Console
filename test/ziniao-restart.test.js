import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { COLLECTION_UNITS, ZINIAO_SERVICE, restartZiniaoService } from '../src/lib/ziniao-restart.js';

function showOutput(states) {
  return Object.entries(states).map(([id, activeState]) => `Id=${id}\nActiveState=${activeState}\n`).join('\n');
}

function scriptedExec(steps) {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args: [...args], env: options.env });
    const step = steps.shift();
    if (!step) {
      callback(Object.assign(new Error('unexpected systemctl'), { code: 'TEST' }), '', 'unexpected systemctl');
      return;
    }
    if (step.fail) {
      const error = Object.assign(new Error(step.message || 'failed'), { code: step.code ?? 1, killed: Boolean(step.killed) });
      callback(error, step.stdout || '', step.stderr || step.message || '');
      return;
    }
    callback(null, step.stdout || '', step.stderr || '');
  };
  return { execFileImpl, calls };
}

function idleShow() {
  return showOutput(Object.fromEntries(COLLECTION_UNITS.map(unit => [unit, 'inactive'])));
}

function tempOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-ziniao-restart-'));
}

describe('ziniao restart guard', { concurrency: 1 }, () => {
  test('a live collector lock refuses restart and does not call systemctl', async () => {
    const outDir = tempOut();
    fs.mkdirSync(path.join(outDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'runtime', 'run.lock'), `${JSON.stringify({
      version: 1, token: 'do-not-echo', pid: process.pid, label: 'check:reviews', startedAt: '2026-09-22T02:00:00.000Z',
    })}\n`);
    const exec = scriptedExec([]);
    await assert.rejects(() => restartZiniaoService({ outDir, execFileImpl: exec.execFileImpl }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'ZINIAO_RESTART_LOCKED');
      assert.match(error.message, /pid=\d+/);
      assert.match(error.message, /check:reviews/);
      assert.doesNotMatch(error.message, /do-not-echo/);
      return true;
    });
    assert.equal(exec.calls.length, 0);
  });

  test('a damaged lock refuses restart instead of treating it as idle', async () => {
    const outDir = tempOut();
    fs.mkdirSync(path.join(outDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'runtime', 'run.lock'), '{');
    const exec = scriptedExec([]);
    await assert.rejects(() => restartZiniaoService({ outDir, execFileImpl: exec.execFileImpl }), error => {
      assert.equal(error.code, 'ZINIAO_RESTART_LOCKED');
      assert.match(error.message, /运行锁已损坏/);
      return true;
    });
    assert.equal(exec.calls.length, 0);
  });

  test('an active collection unit refuses restart before systemctl restart', async () => {
    const outDir = tempOut();
    const states = Object.fromEntries(COLLECTION_UNITS.map(unit => [unit, 'inactive']));
    states['amzguard-store-health-am.service'] = 'activating';
    const exec = scriptedExec([
      { stdout: '' },
      { stdout: showOutput(states) },
    ]);
    await assert.rejects(() => restartZiniaoService({ outDir, execFileImpl: exec.execFileImpl }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'ZINIAO_RESTART_COLLECTION_ACTIVE');
      assert.match(error.message, /amzguard-store-health-am\.service/);
      return true;
    });
    assert.equal(exec.calls.some(call => call.args.includes('restart')), false);
  });

  test('an active manual collection unit refuses restart', async () => {
    const outDir = tempOut();
    const manual = 'amzguard-manual@reviews:US-01.service';
    const states = Object.fromEntries(COLLECTION_UNITS.map(unit => [unit, 'inactive']));
    states[manual] = 'active';
    const exec = scriptedExec([
      { stdout: `${manual} loaded active running AMZ Guard targeted manual run\n` },
      { stdout: showOutput(states) },
    ]);
    await assert.rejects(() => restartZiniaoService({ outDir, execFileImpl: exec.execFileImpl }), error => {
      assert.equal(error.code, 'ZINIAO_RESTART_COLLECTION_ACTIVE');
      assert.match(error.message, /amzguard-manual@reviews:US-01\.service/);
      return true;
    });
    assert.equal(exec.calls.some(call => call.args.includes('restart')), false);
  });

  test('a dead lock and idle units restart only amzguard-ziniao.service', async () => {
    const previous = process.env.ZINIAO_PASSWORD;
    process.env.ZINIAO_PASSWORD = 'super-secret-value';
    const outDir = tempOut();
    fs.mkdirSync(path.join(outDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'runtime', 'run.lock'), `${JSON.stringify({ version: 1, pid: 2147483646, label: 'check:reviews' })}\n`);
    const exec = scriptedExec([
      { stdout: '' },
      { stdout: idleShow() },
      { stdout: '' },
    ]);
    try {
      const result = await restartZiniaoService({ outDir, execFileImpl: exec.execFileImpl });
      assert.equal(result.ok, true);
      assert.equal(result.unit, ZINIAO_SERVICE);
      assert.equal(exec.calls.length, 3);
      assert.deepEqual(exec.calls[2].args, ['--no-ask-password', 'restart', ZINIAO_SERVICE]);
      assert.equal(exec.calls.every(call => call.file === 'systemctl'), true);
      assert.equal(exec.calls.some(call => call.args.includes('amzguard-dashboard.service')), false);
      assert.equal(exec.calls.some(call => call.args.includes('amzguard-xvfb.service')), false);
      assert.equal(JSON.stringify(exec.calls).includes('super-secret-value'), false);
      assert.deepEqual(Object.keys(exec.calls[0].env).sort(), ['LANG', 'LC_ALL', 'PATH']);
    } finally {
      if (previous === undefined) delete process.env.ZINIAO_PASSWORD;
      else process.env.ZINIAO_PASSWORD = previous;
    }
  });

  test('a missing ziniao unit is a failure and is not reported as success', async () => {
    const outDir = tempOut();
    const exec = scriptedExec([
      { stdout: '' },
      { stdout: idleShow() },
      { fail: true, code: 1, stderr: 'Failed to restart amzguard-ziniao.service: Unit amzguard-ziniao.service not found.\n' },
    ]);
    await assert.rejects(() => restartZiniaoService({ outDir, execFileImpl: exec.execFileImpl }), error => {
      assert.equal(error.code, 'ZINIAO_RESTART_UNIT_MISSING');
      assert.match(error.message, /本机没有 amzguard-ziniao\.service/);
      assert.match(error.message, /not found/);
      assert.equal(error.message.includes('已重启'), false);
      return true;
    });
    assert.deepEqual(exec.calls[2].args, ['--no-ask-password', 'restart', ZINIAO_SERVICE]);
  });

  test('systemd status failure refuses restart', async () => {
    const outDir = tempOut();
    const exec = scriptedExec([
      { fail: true, code: 1, stderr: 'Failed to connect to bus: Host is down\n' },
    ]);
    await assert.rejects(() => restartZiniaoService({ outDir, execFileImpl: exec.execFileImpl }), error => {
      assert.equal(error.code, 'ZINIAO_RESTART_STATUS_UNKNOWN');
      assert.match(error.message, /无法确认采集单元是否仍在运行/);
      assert.match(error.message, /Host is down/);
      return true;
    });
    assert.equal(exec.calls.some(call => call.args.includes('restart')), false);
  });
});

test('polkit allows restart of only the ziniao unit', () => {
  const rule = fs.readFileSync(path.join(process.cwd(), 'deploy/polkit/50-amzguard-ziniao-restart.rules'), 'utf8');
  const install = fs.readFileSync(path.join(process.cwd(), 'deploy/install-linux.sh'), 'utf8');
  const verify = fs.readFileSync(path.join(process.cwd(), 'deploy/verify-linux.sh'), 'utf8');
  assert.match(rule, /subject\.user !== "ubuntu"/);
  assert.match(rule, /action\.lookup\("unit"\) !== "amzguard-ziniao\.service"/);
  assert.match(rule, /action\.lookup\("verb"\) !== "restart"/);
  assert.match(rule, /return polkit\.Result\.YES/);
  assert.doesNotMatch(rule, /amzguard-dashboard|amzguard-xvfb|nginx/);
  assert.match(install, /install -m 0644 "\$app_dir\/deploy\/polkit\/50-amzguard-ziniao-restart\.rules"/);
  assert.match(verify, /cmp -s "\$app_dir\/deploy\/polkit\/50-amzguard-ziniao-restart\.rules"/);
});
