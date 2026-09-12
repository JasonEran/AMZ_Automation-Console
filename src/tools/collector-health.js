#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, ROOT } from '../lib/config.js';
import { runDoctorWithStartupGrace } from '../lib/collector-health.js';
import { bjIso } from '../lib/time.js';

const { config } = loadConfig();
const dir = path.join(config.outDir, 'runtime');
const target = path.join(dir, 'collector-health.json');
const runLock = path.join(dir, 'run.lock');

// updateCore is a deep authorization/core operation, not a harmless liveness
// ping. Running it from this ten-minute monitor while a collector is actively
// starting/stopping profiles can destabilize the same ZiNiao core. Defer the
// deep check and retain the last authoritative result until the run lease is
// released.
if (fs.existsSync(runLock)) {
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { /* first deferred run */ }
  const report = {
    ...prior,
    ok: prior.ok === true,
    deferred: true,
    lastAttemptAt: bjIso(),
    summary: '主巡检运行中，已延后 WebDriver 授权深度检查',
  };
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  process.stdout.write(`• ${report.summary}\n`);
  process.exit(0);
}

const run = await runDoctorWithStartupGrace({
  graceMs: Number(process.env.AMZGUARD_COLLECTOR_HEALTH_STARTUP_GRACE_MS || 90000),
  runDoctor: () => spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'doctor'], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 12 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
  }),
});

const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
const ok = run.status === 0;
const authLine = output.split('\n').find((line) => /WebDriver (登录权限|登录\/权限验证失败)/.test(line));
const summary = authLine
  ? authLine.replace(/^\s*[✓✗]\s*/, '').trim()
  : ok ? 'WebDriver 授权与配置正常' : `环境自检退出码 ${run.status ?? 'unknown'}`;
const report = {
  ok,
  checkedAt: bjIso(),
  deferred: false,
  exitCode: run.status,
  summary,
  output: output.slice(-12000),
};

fs.mkdirSync(dir, { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, target);
process.stdout.write(`${ok ? '✓' : '✗'} ${summary}\n`);
process.exit(ok ? 0 : 1);
